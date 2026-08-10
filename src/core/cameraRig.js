import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'

/**
 * 相机运镜。
 *
 * 铁律：位置与朝向分开插值，禁止每帧硬 lookAt 目标。
 * 这里的做法是维护一个平滑跟随的 controls.target，
 * 每帧把 target 的位移量原样加到相机位置上 —— 相机朝向由 OrbitControls
 * 的球坐标状态自己保持，不会被目标的瞬移拽着抖。
 */
export function createCameraRig(camera, domElement) {
  const controls = new OrbitControls(camera, domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.rotateSpeed = 0.55
  controls.zoomSpeed = 0.9
  controls.zoomToCursor = true
  // 滚轮缩放是按比例 dolly 的，所以从 1e3 拉到 1e-3 是均匀的对数体验
  controls.minDistance = 1e-4
  controls.maxDistance = 1e9

  const smoothedTarget = new THREE.Vector3()
  const desiredTarget = new THREE.Vector3()
  const delta = new THREE.Vector3()

  // 焦点就是 bodySystem 里的天体对象（含 group / sceneRadius / data），
  // 直接持有引用，于是半径随尺度模式变化时这里读到的永远是最新值。
  let focus = null
  let snapNext = true // 切换焦点时是否直接吸附（false 则平滑飞过去）
  let distanceAnimation = null
  const offset = new THREE.Vector3()

  /** 焦点切换：位置平滑过渡，朝向完全交给 OrbitControls 的球坐标，不做 lookAt */
  function setFocus(next, { smooth = true } = {}) {
    focus = next
    snapNext = !smooth
  }

  function getFocus() {
    return focus
  }

  /**
   * 飞向某个天体并锁定跟随。
   *
   * 只沿「相机 → 目标」这一条径向轴插值距离，视线方向完全不动 ——
   * 位置与朝向依旧是分开的，没有任何 lookAt。
   * 距离在对数空间插值：从 600 单位飞到 0.5 单位跨了三个数量级，
   * 线性插值会前 90% 的时间几乎没动、最后一瞬间糊上去。
   */
  function flyTo(body, { distanceFactor = 3.6, duration = 1.6 } = {}) {
    setFocus(body, { smooth: true })
    if (!body) return
    const to = Math.max(body.sceneRadius * distanceFactor, 1e-4)
    const from = Math.max(camera.position.distanceTo(controls.target), 1e-4)
    distanceAnimation = { from, to, elapsed: 0, duration }
  }

  const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

  function update(dt) {
    if (focus?.group) {
      focus.group.getWorldPosition(desiredTarget)

      if (snapNext) {
        smoothedTarget.copy(desiredTarget)
        snapNext = false
      } else {
        // 指数平滑，与帧率无关
        const k = 1 - Math.exp(-dt * 6)
        smoothedTarget.lerp(desiredTarget, k)
      }

      delta.subVectors(smoothedTarget, controls.target)
      controls.target.add(delta)
      camera.position.add(delta) // 位置跟着走，朝向不动

      // 贴到表面而不穿模：最近距离略大于当前焦点的场景半径
      const r = focus.sceneRadius ?? 0
      controls.minDistance = Math.max(1e-4, r * 1.02)
    } else {
      controls.minDistance = 1e-4
    }

    if (distanceAnimation) {
      distanceAnimation.elapsed += dt
      const t = Math.min(1, distanceAnimation.elapsed / distanceAnimation.duration)
      const e = easeInOutCubic(t)
      const { from, to } = distanceAnimation
      const distance = Math.exp(Math.log(from) + (Math.log(to) - Math.log(from)) * e)
      offset.subVectors(camera.position, controls.target)
      if (offset.lengthSq() > 0) {
        offset.setLength(distance)
        camera.position.copy(controls.target).add(offset)
      }
      if (t >= 1) distanceAnimation = null
    }

    controls.update()
  }

  function cancelFlight() {
    distanceAnimation = null
  }

  return { controls, update, setFocus, getFocus, flyTo, cancelFlight }
}
