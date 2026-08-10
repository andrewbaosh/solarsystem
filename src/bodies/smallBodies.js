import * as THREE from 'three'
import { toSceneDistance, toSceneRadius } from '../core/scale.js'
import {
  AU_KM,
  cometaryPosition,
  sampleCometaryOrbit,
  eclipticToScene,
  daysSinceJ2000,
} from './orbital.js'

/**
 * 命名小行星、彗星与星际天体。
 *
 * 这些天体用的是**彗星式轨道要素**（q/a、e、i、Ω、ω、近日点时刻），
 * 与行星的 Standish 表不同；星际天体的离心率大于 1，走双曲线解。
 *
 * 彗尾按物理方向画：**背向太阳**，而不是沿轨迹拖在后面。
 * 尾巴是太阳辐射压与太阳风把尘埃气体吹开形成的，所以离开太阳时尾巴在前面。
 * 长度随日距缩短而增长（近似 1/r²），奥陌陌则完全不画尾 —— 它当年就是因为
 * 没有彗发彗尾才引发了那么多争论。
 */

const TAIL_LENGTH_AU = 0.55

function createTail(color) {
  const geometry = new THREE.ConeGeometry(1, 1, 14, 1, true)
  geometry.translate(0, -0.5, 0) // 顶点落在原点，便于朝背日方向拉伸
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = 2
  return mesh
}

export function createSmallBodies(scene, data) {
  const bodies = []

  const all = [
    ...(data.asteroids ?? []).map((d) => ({ ...d, kind: d.kind ?? 'asteroid' })),
    ...(data.comets ?? []),
  ]

  for (const d of all) {
    const group = new THREE.Group()
    group.name = d.id

    // 本体：小天体在这个尺度下本就是个点，用自发光小球保证可见
    const isTiny = d.kind !== 'asteroid'
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, isTiny ? 12 : 20, isTiny ? 8 : 12),
      isTiny
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(d.color) })
        : new THREE.MeshStandardMaterial({
            color: new THREE.Color(d.color),
            roughness: 1,
            metalness: 0,
            flatShading: true,
          }),
    )
    group.add(core)
    scene.add(group)

    const tail = d.hasTail ? createTail(d.color) : null
    if (tail) group.add(tail)

    // 轨迹线：椭圆闭合，双曲线只截近日点前后一段
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
      tail,
      mesh: core, // 供拾取与标签复用行星那套接口
      orbitLine: line,
      sceneRadius: 0,
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

  const sunward = new THREE.Vector3()

  function update(jd) {
    for (const body of bodies) {
      const p = cometaryPosition(body.data, jd, body.positionAU)
      const rAU = p.radiusAU
      const s = toSceneDistance(rAU * AU_KM) / rAU
      eclipticToScene(p, body.group.position).multiplyScalar(s)

      // 半径同样过 scale.js；彗核只有几公里，给个下限否则完全看不见
      const radius = toSceneRadius(body.data.radiusKm)
      body.sceneRadius = Math.max(radius, body.kind === 'asteroid' ? 0.05 : 0.16)
      body.core.scale.setScalar(body.sceneRadius)

      if (body.tail) {
        // 尾巴背向太阳；越靠近太阳越长越亮，粗略按 1/r² 给
        const activity = Math.min(1.6, 1 / Math.max(0.16, rAU * rAU))
        const lengthScene = toSceneDistance(TAIL_LENGTH_AU * AU_KM * activity)
        sunward.copy(body.group.position).normalize()
        body.tail.scale.set(body.sceneRadius * 5, Math.max(0.01, lengthScene), body.sceneRadius * 5)
        // 锥体默认沿 +Y，转到背日方向
        body.tail.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), sunward)
        body.tail.material.opacity = 0.12 + 0.3 * Math.min(1, activity)
        body.tail.visible = rAU < 12
      }
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
