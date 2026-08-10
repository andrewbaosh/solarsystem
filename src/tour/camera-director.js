import * as THREE from 'three'
import { toSceneDistance, toSceneRadius } from '../core/scale.js'
import { eclipticToScene } from '../bodies/orbital.js'
import { resolveEasing } from './easing.js'

/**
 * 导览的相机运镜引擎。
 *
 * 铁律 5：位置与朝向**分开**插值。
 *   位置 —— 沿 CatmullRomCurve3 走，参数由缓动函数驱动（不匀速）。
 *   朝向 —— 独立地朝「目标点」slerp 过去，不做每帧硬 lookAt。
 * 两者唯一的耦合是：算期望朝向时用的是脚本位置，而不是相机当前位置。
 *
 * 铁律 1 / 4：控制点写在 data/tour.json 里的是**真实公里数**，
 * 换算一律走 scale.js。两种参考系：
 *   frame 指定天体   → 点是相对该天体中心的 km，用 toSceneRadius 换算，
 *                      于是「离地球 3 个地球半径」在任何尺度下都还是 3 个半径。
 *   frame 省略（日心）→ 点是黄道坐标系里的 km，用 toSceneDistance 换算，
 *                      吃的是和行星轨道同一条压缩曲线。
 * 两种情况都先过 eclipticToScene —— 场景坐标轴约定只有那一处。
 *
 * 本文件不含任何具体镜头数值。
 */

/** 朝向插值的响应速度（1/秒）：越大越"跟手"，越小越像摇臂 */
const ORIENT_RESPONSE = 5.0
/** 用户接管后点「继续」，回到脚本轨迹所需的时间 */
const RETURN_DURATION = 1.4
const easeInOutCubic = resolveEasing('easeInOutCubic')

export function createCameraDirector({ camera, resolveBody }) {
  // lookAt 的朝向约定：相机类把 -Z 指向目标，普通 Object3D 是 +Z。
  // 这里必须用相机类，否则镜头会正好背对目标。
  const scratchCamera = new THREE.Camera()

  const frameOrigin = new THREE.Vector3()
  const scriptedPosition = new THREE.Vector3()
  const scriptedQuaternion = new THREE.Quaternion()
  const lookPoint = new THREE.Vector3()
  const tmp = new THREE.Vector3()

  let shot = null
  let curve = null
  let ease = easeInOutCubic
  let snapNext = true

  let state = 'idle' // idle | scripted | free | returning
  const returnFrom = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
  let returnElapsed = 0

  /**
   * 真实公里 → 场景单位。
   * 两种参考系走的是不同的换算函数，但都按「径向长度」缩放，
   * 方向交给 eclipticToScene，所以不会引入第二套坐标轴约定。
   */
  function kmToScene(km, bodyFrame, out) {
    const r = Math.hypot(km.x ?? 0, km.y ?? 0, km.z ?? 0)
    if (r === 0) return out.set(0, 0, 0)
    const scene = bodyFrame ? toSceneRadius(r) : toSceneDistance(r)
    return eclipticToScene(km, out).multiplyScalar(scene / r)
  }

  /** 参考系原点：天体的实时世界坐标，或日心（原点） */
  function updateFrameOrigin() {
    const body = shot?.camera?.frame ? resolveBody(shot.camera.frame) : null
    if (body?.group) body.group.getWorldPosition(frameOrigin)
    else frameOrigin.set(0, 0, 0)
    return Boolean(body)
  }

  /**
   * 每帧重算控制点。
   * 参考系天体在动、尺度也可能正在过渡，所以曲线不能只建一次；
   * 但点数只有个位数，就地改写 curve.points 比重建对象便宜。
   */
  function refreshCurve() {
    const bodyFrame = updateFrameOrigin()
    const points = shot.camera?.path ?? []
    for (let i = 0; i < points.length; i++) {
      kmToScene(points[i], bodyFrame, curve.points[i]).add(frameOrigin)
    }
  }

  /** 镜头看向哪：目标天体中心 + 一个同样以 km 表达的偏移 */
  function refreshLookPoint() {
    const spec = shot.camera?.lookAt
    const target = spec?.target ? resolveBody(spec.target) : null
    if (target?.group) target.group.getWorldPosition(lookPoint)
    else lookPoint.set(0, 0, 0)
    if (spec?.offset) lookPoint.add(kmToScene(spec.offset, Boolean(target), tmp))
  }

  /**
   * 换一个镜头。
   * snap = true 时朝向直接吸附（用在过场遮罩最不透明的那一刻，切换看不见）；
   * 否则朝向会从当前姿态平滑摆过去。
   */
  function setShot(next, { snap = false } = {}) {
    shot = next
    ease = resolveEasing(next?.camera?.easing)
    const points = next?.camera?.path ?? []
    // CatmullRomCurve3 至少要两个点；只给一个点就当固定机位，复制成两份
    const seed = points.length >= 2 ? points : [...points, ...points]
    curve = new THREE.CatmullRomCurve3(
      seed.map(() => new THREE.Vector3()),
      false,
      // centripetal 不会在控制点密集处过冲，这正是「不穿模」的关键
      'centripetal',
      0.5,
    )
    snapNext = snap
    state = 'scripted'
    returnElapsed = 0
  }

  /** 计算此刻脚本要求的位置与朝向，写进 scriptedPosition / scriptedQuaternion */
  function evaluate(t) {
    refreshCurve()
    refreshLookPoint()
    curve.getPoint(THREE.MathUtils.clamp(ease(t), 0, 1), scriptedPosition)
    scratchCamera.position.copy(scriptedPosition)
    scratchCamera.up.set(0, 1, 0)
    scratchCamera.lookAt(lookPoint)
    scriptedQuaternion.copy(scratchCamera.quaternion)
  }

  /**
   * @param dt 真实秒
   * @param t  本章进度 0..1（缓动之前的线性进度）
   */
  function update(dt, t) {
    if (!shot || state === 'idle') return
    evaluate(t)

    if (state === 'free') return // 用户在自己看，脚本只是继续算，不写相机

    if (state === 'returning') {
      returnElapsed += dt
      const k = easeInOutCubic(Math.min(1, returnElapsed / RETURN_DURATION))
      camera.position.lerpVectors(returnFrom.position, scriptedPosition, k)
      camera.quaternion.copy(returnFrom.quaternion).slerp(scriptedQuaternion, k)
      if (returnElapsed >= RETURN_DURATION) state = 'scripted'
      return
    }

    camera.position.copy(scriptedPosition)
    if (snapNext) {
      camera.quaternion.copy(scriptedQuaternion)
      snapNext = false
    } else {
      // 与帧率无关的指数逼近；朝向自己有惯性，不会被目标的瞬移拽着抖
      camera.quaternion.slerp(scriptedQuaternion, 1 - Math.exp(-dt * ORIENT_RESPONSE))
    }
  }

  /** 用户开始自由观察：脚本继续走，但不再写相机 */
  function takeOver() {
    if (state === 'scripted' || state === 'returning') state = 'free'
  }

  /** 点「继续」：从当前姿态平滑回到脚本轨迹上**此刻**的位置 */
  function resume() {
    if (state !== 'free') return
    returnFrom.position.copy(camera.position)
    returnFrom.quaternion.copy(camera.quaternion)
    returnElapsed = 0
    state = 'returning'
  }

  function stop() {
    state = 'idle'
    shot = null
    curve = null
  }

  return {
    setShot,
    update,
    takeOver,
    resume,
    stop,
    getState: () => state,
    /** 相机是否由脚本驱动（自由观察时为 false，主循环据此决定要不要跑 OrbitControls） */
    isDriving: () => state === 'scripted' || state === 'returning',
    /** 当前镜头的注视点，供 OrbitControls 对齐，接管时才不会跳 */
    getLookPoint: (out) => out.copy(lookPoint),
  }
}
