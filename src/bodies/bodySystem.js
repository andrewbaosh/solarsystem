import * as THREE from 'three'
import {
  toSceneDistance,
  toSceneRadius,
  toSceneSatelliteDistance,
  getScaleRevision,
} from '../core/scale.js'
import {
  heliocentricKm,
  satellitePositionKm,
  samplePlanetOrbitKm,
  sampleSatelliteOrbitKm,
  eclipticToScene,
  daysSinceJ2000,
} from './orbital.js'
import { poleVectorEcliptic, spinAngleAt, tidalLockAngle } from './rotation.js'
import {
  createStarMaterial,
  createBodyMaterial,
  createCloudMaterial,
  createRingMaterial,
} from './materials.js'
import { createRingGeometry } from './rings.js'
import { createAtmosphere } from './atmosphere.js'

const SCENE_UP = new THREE.Vector3(0, 1, 0)
const PLANET_ORBIT_SEGMENTS = 512
const SATELLITE_ORBIT_SEGMENTS = 256
const SPHERE = new THREE.SphereGeometry(1, 96, 48)

/**
 * 天体构建与每帧更新。
 *
 * 层级：
 *   group（公转位置）
 *     ├ tilt（自转轴取向，来自 IAU 极点）
 *     │   ├ mesh（本体，带自转角）
 *     │   ├ clouds（云层，自转略快于地表）
 *     │   └ ring（环，与自转轴垂直，不随本体自转）
 *     ├ atmosphere（Fresnel 辉光外壳）
 *     └ anchor（卫星系统）
 */
export function createBodySystem(scene, { planets, elements, satellites }) {
  const bodies = []
  const byId = new Map()
  const atmospheres = []
  const ringed = []

  function poleQuaternion(data) {
    if (data.poleRA === undefined || data.poleDec === undefined) return new THREE.Quaternion()
    const poleScene = new THREE.Vector3()
    eclipticToScene(poleVectorEcliptic(data), poleScene).normalize()
    return new THREE.Quaternion().setFromUnitVectors(SCENE_UP, poleScene)
  }

  function makeOrbitLine(color) {
    return new THREE.LineLoop(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: new THREE.Color(color),
        transparent: true,
        opacity: 0.22,
      }),
    )
  }

  /** 云层 / 环 / 大气这些附属层，行星和卫星共用 */
  function decorate(body, data, tilt, group) {
    if (data.cloudLayer) {
      body.clouds = new THREE.Mesh(SPHERE, createCloudMaterial(data.cloudLayer))
      body.clouds.renderOrder = 1
      tilt.add(body.clouds)
    }

    if (data.ring) {
      // 用「环半径 / 本体半径」的比值建几何体，再整体乘场景半径，
      // 这样切换尺度模式时不需要重建几何体
      const inner = data.ring.innerRadiusKm / data.radiusKm
      const outer = data.ring.outerRadiusKm / data.radiusKm
      body.ring = new THREE.Mesh(createRingGeometry(inner, outer), createRingMaterial(data.ring))
      body.ring.renderOrder = 2
      tilt.add(body.ring) // 挂在 tilt 下 → 自动垂直于自转轴并随倾角倾斜
      ringed.push(body)
    }

    if (data.atmosphere) {
      body.atmosphere = createAtmosphere(data.atmosphere)
      group.add(body.atmosphere)
      atmospheres.push(body)
    }
  }

  function makeBody(data, { isStar }) {
    const group = new THREE.Group()
    group.name = data.id

    const tilt = new THREE.Group()
    tilt.quaternion.copy(poleQuaternion(data))
    group.add(tilt)

    const material = isStar ? createStarMaterial(data) : createBodyMaterial(data)
    const mesh = new THREE.Mesh(SPHERE, material)
    mesh.name = `${data.id}-mesh`
    if (!isStar) {
      mesh.castShadow = true
      mesh.receiveShadow = true
    }
    tilt.add(mesh)

    return { group, tilt, mesh }
  }

  // ---- 行星 ----------------------------------------------------------------

  for (const data of planets) {
    const isStar = data.type === 'star'
    const { group, tilt, mesh } = makeBody(data, { isStar })

    const anchor = new THREE.Group()
    group.add(anchor)
    scene.add(group)

    const elementSet = elements[data.id] ?? null
    const orbitLine = elementSet ? makeOrbitLine(data.color) : null
    if (orbitLine) scene.add(orbitLine)

    const body = {
      data,
      kind: 'planet',
      isStar,
      elementSet,
      group,
      tilt,
      mesh,
      anchor,
      orbitLine,
      sceneRadius: 0,
      positionKm: new THREE.Vector3(),
    }
    decorate(body, data, tilt, group)
    bodies.push(body)
    byId.set(data.id, body)
  }

  // ---- 卫星 ----------------------------------------------------------------

  for (const data of satellites) {
    const parent = byId.get(data.parent)
    if (!parent) continue

    const frame = new THREE.Group()
    if (data.frame === 'parentEquator') frame.quaternion.copy(poleQuaternion(parent.data))
    parent.anchor.add(frame)

    const { group, tilt, mesh } = makeBody(data, { isStar: false })
    frame.add(group)

    const orbitLine = makeOrbitLine(data.color)
    frame.add(orbitLine)

    const body = {
      data,
      kind: 'satellite',
      isStar: false,
      parent,
      frame,
      group,
      tilt,
      mesh,
      orbitLine,
      sceneRadius: 0,
      localKm: new THREE.Vector3(),
    }
    decorate(body, data, tilt, group)
    bodies.push(body)
    byId.set(data.id, body)
  }

  // ---- 轨道线 ---------------------------------------------------------------

  const scratch = new THREE.Vector3()

  function radialToScene(km, convert, out) {
    const r = Math.hypot(km.x, km.y, km.z)
    if (r === 0) return out.set(0, 0, 0)
    const s = convert(r) / r
    return eclipticToScene(km, out).multiplyScalar(s)
  }

  function rebuildOrbitLines(jd) {
    for (const body of bodies) {
      if (!body.orbitLine) continue
      const isSatellite = body.kind === 'satellite'
      const samples = isSatellite
        ? sampleSatelliteOrbitKm(body.data, jd, SATELLITE_ORBIT_SEGMENTS)
        : samplePlanetOrbitKm(body.elementSet, jd, PLANET_ORBIT_SEGMENTS)
      const convert = isSatellite ? toSceneSatelliteDistance : toSceneDistance

      const positions = new Float32Array(samples.length * 3)
      for (let i = 0; i < samples.length; i++) {
        radialToScene(samples[i], convert, scratch)
        positions[i * 3] = scratch.x
        positions[i * 3 + 1] = scratch.y
        positions[i * 3 + 2] = scratch.z
      }
      body.orbitLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      body.orbitLine.geometry.computeBoundingSphere()
    }
  }

  // ---- 每帧更新 ------------------------------------------------------------

  let lastRevision = -1
  let lastOrbitJD = null
  const dirToParent = new THREE.Vector3()
  const inverseTilt = new THREE.Quaternion()
  const sunWorld = new THREE.Vector3()
  const star = bodies.find((b) => b.isStar) ?? null

  function update(jd) {
    const days = daysSinceJ2000(jd)

    for (const body of bodies) {
      const { data, group, mesh } = body

      if (body.kind === 'planet') {
        if (body.elementSet) {
          heliocentricKm(body.elementSet, jd, body.positionKm)
          radialToScene(body.positionKm, toSceneDistance, group.position)
        }
      } else {
        satellitePositionKm(data, jd, body.localKm)
        radialToScene(body.localKm, toSceneSatelliteDistance, group.position)
      }

      const radius = toSceneRadius(data.radiusKm)
      body.sceneRadius = radius
      mesh.scale.setScalar(radius)

      if (data.tidallyLocked) {
        dirToParent.copy(group.position).negate().normalize()
        inverseTilt.copy(body.tilt.quaternion).invert()
        dirToParent.applyQuaternion(inverseTilt)
        mesh.rotation.y = tidalLockAngle(dirToParent)
      } else {
        mesh.rotation.y = spinAngleAt(data, days)
      }

      if (body.clouds) {
        body.clouds.scale.setScalar(radius * (data.cloudLayer.radiusScale ?? 1.003))
        body.clouds.rotation.y = mesh.rotation.y * (data.cloudLayer.rotationFactor ?? 1.1)
      }
      if (body.ring) body.ring.scale.setScalar(radius)
      if (body.atmosphere) {
        body.atmosphere.scale.setScalar(radius * (data.atmosphere.radiusScale ?? 1.03))
      }
    }

    // 大气辉光与环的投影都需要知道太阳在哪
    if (star) {
      star.group.getWorldPosition(sunWorld)
      for (const body of atmospheres) {
        body.atmosphere.material.uniforms.uSunPosition.value.copy(sunWorld)
      }
      for (const body of ringed) {
        const uniforms = body.ring.material.uniforms
        uniforms.uSunPosition.value.copy(sunWorld)
        body.group.getWorldPosition(uniforms.uPlanetCenter.value)
        uniforms.uPlanetRadius.value = body.sceneRadius
      }
    }

    const revision = getScaleRevision()
    if (revision !== lastRevision || lastOrbitJD === null || Math.abs(jd - lastOrbitJD) > 365) {
      rebuildOrbitLines(jd)
      lastRevision = revision
      lastOrbitJD = jd
    }
  }

  function get(id) {
    return byId.get(id) ?? null
  }

  /** 按类别控制可见性；只改显示，不影响任何计算 */
  function setVisibility({ planets = true, satellites = true, orbits = true } = {}) {
    for (const body of bodies) {
      const on = body.kind === 'satellite' ? satellites : planets
      body.group.visible = on
      if (body.orbitLine) body.orbitLine.visible = on && orbits
    }
  }

  return { bodies, update, get, rebuildOrbitLines, star, setVisibility }
}
