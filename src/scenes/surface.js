import * as THREE from 'three'
import { createTerrain } from './terrain.js'
import { createSky } from './sky.js'
import { createFirstPerson } from '../core/firstPerson.js'
import { AU_KM } from '../bodies/orbital.js'

/**
 * 地表场景：与轨道场景完全独立的一套 scene / camera。
 *
 * 这是刻意的取舍 —— 不做从太空到地表的无缝过渡。两套场景的单位制差了九个
 * 数量级（轨道场景 1 单位 = 100 万 km，这里 1 单位 = 1 米），
 * 硬凑无缝要么牺牲轨道精度，要么牺牲地表精度。转场换场景是诚实的做法。
 */

const SUN_RADIUS_KM = 696000
const EARTH_IRRADIANCE = 1361 // W/m²，1 AU 处的太阳常数
const REFERENCE_MASS_KG = 70

/**
 * 该天体到太阳的真实距离（km）。卫星取其母天体的日距。
 */
function distanceToSunKm(body, elements) {
  const target = body.kind === 'satellite' ? body.parent : body
  const set = elements[target.data.id]
  if (!set) return AU_KM
  return set.a[0] * AU_KM
}

export function createSurfaceScene({ body, elements, missions, renderer }) {
  const config = body.data.surface
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(
    70,
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.1,
    20000,
  )

  // ---- 由真实日距推出的光照与日面大小 ------------------------------------

  const sunDistanceKm = distanceToSunKm(body, elements)
  const distanceAU = sunDistanceKm / AU_KM
  /** 辐照度按平方反比衰减：木卫二在 5.2 AU 处只有地球的 1/27 */
  const irradianceRatio = 1 / (distanceAU * distanceAU)
  /** 日面视半径（弧度） */
  const sunAngularRadiusRad = Math.atan(SUN_RADIUS_KM / sunDistanceKm)
  const sunAngularDiameterDeg = (sunAngularRadiusRad * 2 * 180) / Math.PI
  const earthSunAngularDiameterDeg = (Math.atan(SUN_RADIUS_KM / AU_KM) * 2 * 180) / Math.PI

  const sunElevation = THREE.MathUtils.degToRad(config.sunElevationDeg ?? 32)
  const sunAzimuth = THREE.MathUtils.degToRad(config.sunAzimuthDeg ?? 135)
  const sunDirection = new THREE.Vector3(
    Math.cos(sunElevation) * Math.sin(sunAzimuth),
    Math.sin(sunElevation),
    Math.cos(sunElevation) * Math.cos(sunAzimuth),
  ).normalize()

  // ---- 地形 ----------------------------------------------------------------

  const terrain = createTerrain(config.terrain ?? {}, config.seed ?? 1)
  scene.add(terrain.mesh)
  if (terrain.rocks) scene.add(terrain.rocks)

  // ---- 天空 ----------------------------------------------------------------

  const sky = createSky(config.sky ?? {}, { sunDirection, sunAngularRadiusRad })
  scene.add(sky.mesh)

  if (config.sky?.fogDensity) {
    scene.fog = new THREE.FogExp2(
      new THREE.Color(config.sky.horizon ?? '#d9a07a'),
      config.sky.fogDensity,
    )
  }

  // ---- 光照 ----------------------------------------------------------------

  /**
   * 基准值以「地球正午晴天」标定，再乘真实辐照度比。
   * 于是各天体之间的亮度差是物理算出来的：火星 43%、木卫二 3.7%、水星 668%。
   */
  const SUNLIGHT_AT_1AU = 7.5
  const sunLight = new THREE.DirectionalLight(
    new THREE.Color(config.sunlightColor ?? '#fff4e6'),
    SUNLIGHT_AT_1AU * irradianceRatio,
  )
  sunLight.position.copy(sunDirection).multiplyScalar(2000)
  sunLight.castShadow = true
  sunLight.shadow.mapSize.set(2048, 2048)
  sunLight.shadow.camera.near = 1
  sunLight.shadow.camera.far = 4000
  sunLight.shadow.camera.left = -400
  sunLight.shadow.camera.right = 400
  sunLight.shadow.camera.top = 400
  sunLight.shadow.camera.bottom = -400
  sunLight.shadow.bias = -0.0006
  scene.add(sunLight)
  scene.add(sunLight.target)

  /**
   * 环境光代表天空的散射回照。无大气天体几乎没有这一项，
   * 所以月面的阴影是纯黑的、对比度极高；有大气的地方阴影则被填亮。
   */
  const skyFill = new THREE.HemisphereLight(
    new THREE.Color(config.sky?.horizon ?? '#ffffff'),
    new THREE.Color(config.terrain?.groundColor ?? '#555555'),
    (config.sky?.scattering ?? 0) * 1.6 * irradianceRatio + 0.02,
  )
  scene.add(skyFill)

  // ---- 着陆点标记 ----------------------------------------------------------

  const site = config.site ?? { lat: 0, lon: 0, name: '' }
  const radiusKm = body.data.radiusKm
  const markers = []

  /** 两点间的大圆距离与方位角（真实经纬度 → 本地平面上的方向和距离） */
  function greatCircle(fromLat, fromLon, toLat, toLon) {
    const φ1 = THREE.MathUtils.degToRad(fromLat)
    const φ2 = THREE.MathUtils.degToRad(toLat)
    const Δλ = THREE.MathUtils.degToRad(toLon - fromLon)
    const centralAngle = Math.acos(
      Math.min(1, Math.max(-1, Math.sin(φ1) * Math.sin(φ2) + Math.cos(φ1) * Math.cos(φ2) * Math.cos(Δλ))),
    )
    const bearing = Math.atan2(
      Math.sin(Δλ) * Math.cos(φ2),
      Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ),
    )
    return { distanceKm: centralAngle * radiusKm, bearingRad: bearing }
  }

  const missionList = missions.missions[body.data.id] ?? []
  const landed = missionList.filter((m) => m.landingSite)
  const markerGroup = new THREE.Group()
  scene.add(markerGroup)

  const HORIZON_RADIUS = terrain.size * 0.42

  for (const mission of landed) {
    const { distanceKm, bearingRad } = greatCircle(
      site.lat,
      site.lon,
      mission.landingSite.lat,
      mission.landingSite.lon,
    )
    const distanceM = distanceKm * 1000
    // 方位角 0 = 正北 = -Z，顺时针为东
    const dirX = Math.sin(bearingRad)
    const dirZ = -Math.cos(bearingRad)

    // 超出地形范围的着陆点钉在地平方向上，并标注真实距离
    const withinScene = distanceM < HORIZON_RADIUS
    const placeDistance = withinScene ? distanceM : HORIZON_RADIUS
    const x = dirX * placeDistance
    const z = dirZ * placeDistance
    const y = terrain.heightAt(x, z)

    const marker = new THREE.Group()
    marker.position.set(x, y, z)

    // 一根发光的标杆，远处也看得见
    const poleHeight = withinScene ? 6 : 40
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(withinScene ? 0.12 : 1.2, withinScene ? 0.12 : 1.2, poleHeight, 6),
      new THREE.MeshBasicMaterial({ color: 0x6fd8b0, transparent: true, opacity: 0.85 }),
    )
    pole.position.y = poleHeight / 2
    marker.add(pole)

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(withinScene ? 0.45 : 4, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0x9cffdc }),
    )
    cap.position.y = poleHeight
    marker.add(cap)

    markerGroup.add(marker)
    markers.push({ mission, object: marker, distanceKm, withinScene, hitTarget: cap })
  }

  // ---- 第一人称 ------------------------------------------------------------

  const gravity = body.data.surfaceGravityMs2 ?? 9.807
  const firstPerson = createFirstPerson({
    camera,
    domElement: renderer.domElement,
    heightAt: terrain.heightAt,
    gravity,
    bounds: terrain.size,
  })
  firstPerson.spawn(0, 0)
  scene.add(firstPerson.player)

  sunLight.target.position.set(0, 0, 0)

  // ---- 标记点击 ------------------------------------------------------------

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  /** 屏幕中心（准星）指向的标记，或指定屏幕坐标处的标记 */
  function pickMarker(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect()
    if (clientX === undefined) {
      pointer.set(0, 0) // 锁定指针时用准星
    } else {
      pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    }
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects(markers.map((m) => m.object), true)
    if (!hits.length) return null
    return markers.find((m) => m.object === hits[0].object.parent || m.object === hits[0].object) ?? null
  }

  // ---- 对外信息 ------------------------------------------------------------

  const info = {
    bodyName: body.data.name,
    siteName: site.name,
    gravity,
    /** 70 kg 的人在这里的视重 */
    weightKg: REFERENCE_MASS_KG * (gravity / 9.807),
    referenceMassKg: REFERENCE_MASS_KG,
    temperatureC: body.data.surfaceTempC ?? null,
    temperatureNote: body.data.surfaceTempNote ?? null,
    sunAngularDiameterDeg,
    sunAngularDiameterRatio: sunAngularDiameterDeg / earthSunAngularDiameterDeg,
    irradianceRatio,
    irradianceWm2: EARTH_IRRADIANCE * irradianceRatio,
    distanceAU,
    markers,
  }

  function update(dt) {
    firstPerson.update(dt)
    // 阴影相机跟着玩家走，否则走远了就没有阴影
    const p = firstPerson.player.position
    sunLight.position.set(p.x, 0, p.z).addScaledVector(sunDirection, 2000)
    sunLight.target.position.set(p.x, p.y, p.z)
    sunLight.target.updateMatrixWorld()
    sky.mesh.position.set(p.x, 0, p.z)
  }

  function resize() {
    camera.aspect = Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight)
    camera.updateProjectionMatrix()
  }

  function dispose() {
    firstPerson.dispose()
    scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose()
      if (obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of materials) m.dispose()
      }
    })
  }

  return { scene, camera, firstPerson, info, update, resize, dispose, pickMarker, sunDirection }
}
