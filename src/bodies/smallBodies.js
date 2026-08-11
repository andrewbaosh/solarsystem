import * as THREE from 'three'
import { toSceneDistance, toSceneRadius } from '../core/scale.js'
import { AU_KM, cometaryPosition, sampleCometaryOrbit, eclipticToScene } from './orbital.js'
import { createRockGeometry, createRegolithTextures } from './rockSurface.js'
import { createCometVisuals } from './cometTail.js'

/**
 * 命名小行星、彗星与星际天体。
 *
 * 这些天体用的是**彗星式轨道要素**（q/a、e、i、Ω、ω、近日点时刻），
 * 与行星的 Standish 表不同；星际天体的离心率大于 1，走双曲线解。
 *
 * 外形一律是不规则岩块，不是光滑球 —— 这几颗的轴比与起伏幅度写在
 * data/small-bodies.json 的 shape 字段里，都是有实测依据的：
 * 灶神星被南极那个大坑砸扁了，奥陌陌的轴比至少 5:1。
 * 只有谷神星够大，靠自身引力压成了接近球形。
 *
 * 彗星的彗发与两条尾在 cometTail.js，那里有结构说明。
 */

/** 小天体太小，不额外放大就是亚像素。这个系数会显示在 HUD 上（铁律 4） */
export const SMALL_BODY_BOOST = 3.4
/** 再小也要能看见能点中 */
const MIN_SCENE_RADIUS = 0.035
/** 彗星活跃的起点：水冰在这个日距上开始明显升华 */
const ACTIVITY_ONSET_AU = 4.0
/** 算轨道速度方向用的有限差分步长，天 */
const VELOCITY_DT = 0.5

export function createSmallBodies(scene, data) {
  const bodies = []
  const { albedo, normal } = createRegolithTextures()

  const all = [
    ...(data.asteroids ?? []).map((d) => ({ ...d, kind: d.kind ?? 'asteroid' })),
    ...(data.comets ?? []),
  ]

  for (const d of all) {
    const group = new THREE.Group()
    group.name = d.id

    // 本体：不规则岩块。彗核尤其黑（反照率 0.04 级别），真正亮的是彗发
    const shape = d.shape ?? {}
    const isComet = Boolean(d.coma || d.ionTail || d.dustTail)
    const core = new THREE.Mesh(
      createRockGeometry({
        seed: shape.seed ?? 1,
        roughness: shape.roughness ?? 0.6,
        axisRatio: shape.axisRatio ?? 1,
        detail: 3,
      }),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(d.color),
        map: albedo,
        normalMap: normal,
        normalScale: new THREE.Vector2(1.2, 1.2),
        roughness: 0.96,
        metalness: 0,
        // 彗核比煤还黑，但全黑就没法在星空里找到它，给一点自发光兜底
        emissive: new THREE.Color(d.color),
        emissiveIntensity: isComet ? 0.16 : 0.06,
      }),
    )
    // 每颗给一个固定的随机朝向，免得所有石头都以同一面对着我们
    core.quaternion.setFromEuler(
      new THREE.Euler((shape.seed ?? 1) * 1.3, (shape.seed ?? 1) * 2.1, (shape.seed ?? 1) * 0.7),
    )
    group.add(core)
    scene.add(group)

    const comet = isComet ? createCometVisuals(d) : null
    if (comet) group.add(comet.group)

    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(d.color),
      transparent: true,
      opacity: d.kind === 'interstellar' ? 0.5 : 0.32,
    })
    const line = new THREE.Line(new THREE.BufferGeometry(), material)
    scene.add(line)

    bodies.push({
      data: d,
      kind: d.kind,
      group,
      core,
      comet,
      mesh: core, // 供拾取与标签复用行星那套接口
      orbitLine: line,
      sceneRadius: 0,
      activity: 0,
      positionAU: { x: 0, y: 0, z: 0 },
    })
  }

  // ---- 轨迹线（尺度变化时重建） ---------------------------------------------

  const scratch = new THREE.Vector3()

  function rebuildOrbitLines(jd) {
    for (const body of bodies) {
      const { points, closed } = sampleCometaryOrbit(body.data, jd, 512)
      const positions = new Float32Array((points.length + (closed ? 1 : 0)) * 3)
      for (let i = 0; i < points.length; i++) {
        const p = points[i]
        const rAU = Math.hypot(p.x, p.y, p.z)
        const s = toSceneDistance(rAU * AU_KM) / rAU
        eclipticToScene(p, scratch).multiplyScalar(s)
        positions[i * 3] = scratch.x
        positions[i * 3 + 1] = scratch.y
        positions[i * 3 + 2] = scratch.z
      }
      if (closed) {
        positions[points.length * 3] = positions[0]
        positions[points.length * 3 + 1] = positions[1]
        positions[points.length * 3 + 2] = positions[2]
      }
      body.orbitLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      body.orbitLine.geometry.computeBoundingSphere()
    }
  }

  // ---- 每帧更新 -------------------------------------------------------------

  const antiSun = new THREE.Vector3()
  const antiVel = new THREE.Vector3()
  const ahead = { x: 0, y: 0, z: 0 }
  const behind = { x: 0, y: 0, z: 0 }
  const velEcliptic = { x: 0, y: 0, z: 0 }

  /**
   * 活跃度 0..1。
   * 挥发物的产率大致随 1/r² 变化，所以这里在 1/r² 上做线性归一：
   * 4 AU（水冰开始明显升华的距离）之外为 0，到各自的近日点为 1。
   * 用每颗彗星自己的近日距做上限，是因为掠日彗星和主带彗星的活跃程度差着数量级。
   */
  function activityAt(rAU, perihelionAU) {
    const q = Math.max(0.05, perihelionAU)
    if (rAU >= ACTIVITY_ONSET_AU) return 0
    const inv = 1 / (rAU * rAU)
    const invOnset = 1 / (ACTIVITY_ONSET_AU * ACTIVITY_ONSET_AU)
    const invMax = 1 / (q * q)
    if (invMax <= invOnset) return 0
    return Math.min(1, Math.max(0, (inv - invOnset) / (invMax - invOnset)))
  }

  function update(jd) {
    for (const body of bodies) {
      const p = cometaryPosition(body.data, jd, body.positionAU)
      const rAU = p.radiusAU
      const s = toSceneDistance(rAU * AU_KM) / rAU
      eclipticToScene(p, body.group.position).multiplyScalar(s)

      // 半径同样过 scale.js，再乘一个显式的小天体放大系数（HUD 上看得见）
      const radius = toSceneRadius(body.data.radiusKm) * SMALL_BODY_BOOST
      body.sceneRadius = Math.max(radius, MIN_SCENE_RADIUS)
      body.core.scale.setScalar(body.sceneRadius)

      if (!body.comet) {
        body.activity = 0
        continue
      }

      // 近日距：椭圆用 a(1−e)，双曲线的要素里直接给的就是 q
      const el = body.data
      const perihelionAU = el.q ?? (el.a !== undefined ? el.a * (1 - el.e) : rAU)
      const activity = activityAt(rAU, perihelionAU)
      body.activity = activity

      // 背日方向：太阳在原点，所以「太阳指向彗星」这个方向本身就是背日方向
      antiSun.copy(body.group.position).normalize()

      // 轨迹后方：用有限差分求速度方向，再取反。
      // 尘埃尾之所以是弯的，就是因为尘埃保留了原来的轨道角动量、落在后面。
      cometaryPosition(body.data, jd + VELOCITY_DT, ahead)
      cometaryPosition(body.data, jd - VELOCITY_DT, behind)
      velEcliptic.x = ahead.x - behind.x
      velEcliptic.y = ahead.y - behind.y
      velEcliptic.z = ahead.z - behind.z
      eclipticToScene(velEcliptic, antiVel)
      if (antiVel.lengthSq() > 0) antiVel.normalize().negate()
      else antiVel.copy(antiSun)

      // 尾巴挂在 group 上，group 自身没有旋转，所以世界方向即本地方向
      body.comet.update({
        activity,
        antiSun,
        antiVel,
        toSceneLength: (km) => toSceneDistance(km),
        toSceneSize: (km) => toSceneRadius(km),
      })
    }
  }

  function get(id) {
    return bodies.find((b) => b.data.id === id) ?? null
  }

  function setVisible(visible, showOrbits = true) {
    for (const b of bodies) {
      b.group.visible = visible
      b.orbitLine.visible = visible && showOrbits
    }
  }

  function setOrbitVisibility(isVisible) {
    for (const b of bodies) {
      b.orbitLine.visible = b.group.visible && isVisible(b.data.id)
    }
  }

  return { bodies, update, rebuildOrbitLines, get, setVisible, setOrbitVisibility }
}
