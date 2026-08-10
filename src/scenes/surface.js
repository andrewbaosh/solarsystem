import * as THREE from 'three'
import { createTerrain } from './terrain.js'
import { createSky } from './sky.js'
import { createLander } from './landers.js'
import { createFirstPerson } from '../core/firstPerson.js'
import { AU_KM } from '../bodies/orbital.js'

/**
 * 地表场景：与轨道场景完全独立的一套 scene / camera。
 *
 * 这是刻意的取舍 —— 不做从太空到地表的无缝过渡。两套场景的单位制差了九个
 * 数量级（轨道场景 1 单位 = 100 万 km，这里 1 单位 = 1 米），
 * 硬凑无缝要么牺牲轨道精度，要么牺牲地表精度。转场换场景是诚实的做法。
 *
 * 两个阶段：
 *   descent      第三人称，看着着陆器下降、触地
 *   firstPerson  镜头交接到人的视角，可以走动
 */

const SUN_RADIUS_KM = 696000
const EARTH_IRRADIANCE = 1361 // W/m²，1 AU 处的太阳常数
const REFERENCE_MASS_KG = 70
const EYE_HEIGHT = 1.7
const HANDOFF_DURATION = 2.4 // 第三人称 → 第一人称的镜头过渡时长

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function distanceToSunKm(body, elements) {
  const target = body.kind === 'satellite' ? body.parent : body
  const set = elements[target.data.id]
  if (!set) return AU_KM
  return set.a[0] * AU_KM
}

export function createSurfaceScene({ body, elements, missions, renderer, edlProfile }) {
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
  const irradianceRatio = 1 / (distanceAU * distanceAU)
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

  // ---- 地形与天空 ----------------------------------------------------------

  const terrain = createTerrain(config.terrain ?? {}, config.seed ?? 1)
  scene.add(terrain.mesh)
  if (terrain.rocks) scene.add(terrain.rocks)

  const sky = createSky(config.sky ?? {}, { sunDirection, sunAngularRadiusRad })
  scene.add(sky.mesh)

  if (config.sky?.fogDensity) {
    scene.fog = new THREE.FogExp2(
      new THREE.Color(config.sky.horizon ?? '#d9a07a'),
      config.sky.fogDensity,
    )
  }

  // ---- 光照 ----------------------------------------------------------------

  const SUNLIGHT_AT_1AU = 7.5
  const sunLight = new THREE.DirectionalLight(
    new THREE.Color(config.sunlightColor ?? '#fff4e6'),
    SUNLIGHT_AT_1AU * irradianceRatio,
  )
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

  const skyFill = new THREE.HemisphereLight(
    new THREE.Color(config.sky?.horizon ?? '#ffffff'),
    new THREE.Color(config.terrain?.groundColor ?? '#555555'),
    (config.sky?.scattering ?? 0) * 1.6 * irradianceRatio + 0.02,
  )
  scene.add(skyFill)

  // ---- 着陆器 --------------------------------------------------------------

  const landingX = 0
  const landingZ = 0
  const groundY = terrain.heightAt(landingX, landingZ)

  const lander = createLander(edlProfile?.lander ?? 'generic')
  lander.root.position.set(landingX, groundY, landingZ)
  scene.add(lander.root)

  // 空中吊车放下车之后，下降级会飞离
  let craneReleasing = false
  let craneFlyaway = 0

  // ---- 着陆点标记 ----------------------------------------------------------

  const site = config.site ?? { lat: 0, lon: 0, name: '' }
  const radiusKm = body.data.radiusKm
  const markers = []

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
  markerGroup.visible = false // 下降阶段不显示，交接到第一人称后再露出
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
    const dirX = Math.sin(bearingRad)
    const dirZ = -Math.cos(bearingRad)
    const withinScene = distanceM < HORIZON_RADIUS
    const placeDistance = withinScene ? Math.max(distanceM, 14) : HORIZON_RADIUS
    const x = dirX * placeDistance
    const z = dirZ * placeDistance
    const y = terrain.heightAt(x, z)

    const marker = new THREE.Group()
    marker.position.set(x, y, z)
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
    markers.push({ mission, object: marker, distanceKm, withinScene })
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
  scene.add(firstPerson.player)

  // 交接后站在着陆器旁边，一转身就能看见自己刚坐下来的那台机器
  const standX = landingX + 9
  const standZ = landingZ + 7

  // ---- 相机：第三人称追机位 --------------------------------------------------

  const chase = edlProfile?.chaseCam ?? { dist: 22, height: 7 }
  const chaseAngle = THREE.MathUtils.degToRad(config.sunAzimuthDeg ?? 135) + 2.2
  /**
   * 用来算「看向某点」的四元数的中转对象。
   * 必须是 Camera 而不是普通 Object3D —— three 的 lookAt 对相机/灯光按 -Z 朝向计算，
   * 对普通对象则按 +Z（内部把 target 和 position 调了个个儿），
   * 拿普通 Object3D 当中转会得到正好差 180° 的朝向。
   */
  const scratch = new THREE.Camera()
  const desiredQuat = new THREE.Quaternion()
  const focusPoint = new THREE.Vector3()

  let mode = 'descent'
  let handoff = null
  const handoffFrom = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }
  const handoffTo = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() }

  /**
   * 朝向不用每帧硬 lookAt（项目铁律 5）：先算出目标四元数，再按时间常数 slerp 过去，
   * 位置与朝向各自独立插值。
   */
  function aimAt(target, dt, responsiveness = 3.2) {
    scratch.position.copy(camera.position)
    scratch.up.set(0, 1, 0)
    scratch.lookAt(target)
    desiredQuat.copy(scratch.quaternion)
    camera.quaternion.slerp(desiredQuat, 1 - Math.exp(-dt * responsiveness))
  }

  /**
   * 追机位：相机站在固定方位，高度跟着着陆器抬升。
   * 瞄点取在着陆器与地面之间偏下的位置，于是着陆器高悬时位于画面上方
   * （下方留给 EDL 说明面板），触地时自然回到画面中心。
   */
  function placeChaseCamera(landerY) {
    const above = Math.max(0, landerY - groundY)
    const x = landingX + Math.sin(chaseAngle) * chase.dist
    const z = landingZ + Math.cos(chaseAngle) * chase.dist
    const terrainY = terrain.heightAt(x, z)
    // 相机跟着抬升但慢于着陆器，于是始终能同时看到机器和下方的地面
    camera.position.set(x, Math.max(terrainY + 2.5, groundY + above * 0.55 + chase.height), z)
  }

  /** 瞄点略低于着陆器本身，让它稳定地落在画面中偏上的位置 */
  function chaseAimY(landerY) {
    const above = Math.max(0, landerY - groundY)
    return landerY - above * 0.1 - 0.5
  }

  /** 由 EDL 时序驱动：设置着陆器当前的下降状态 */
  function setDescentState(state) {
    if (mode !== 'descent') return
    const y = state.y ?? 0
    const tether = state.tether ?? 0

    // 空中吊车的 y 指的是**车**的高度，下降级还挂在缆绳上方，
    // 所以要把整体抬高一个缆绳长度，否则车会沉到地下去
    lander.root.position.y = groundY + y + (lander.tetherDropAt?.(tether) ?? 0)

    lander.setParachute((state.chute ?? 0) > 0.5)
    lander.setPlume((state.plume ?? 0) > 0.5, 0.7 + (state.plume ?? 0) * 0.5)
    lander.setTether(tether)

    // 车轮着地即触发缆绳切断与下降级飞离
    if (lander.parts && tether >= 0.99 && y <= 0.02) craneReleasing = true
  }

  /** 镜头交接：第三人称 → 第一人称 */
  function beginFirstPerson() {
    if (mode !== 'descent' || handoff) return
    handoffFrom.position.copy(camera.position)
    handoffFrom.quaternion.copy(camera.quaternion)

    handoffTo.position.set(standX, terrain.heightAt(standX, standZ) + EYE_HEIGHT, standZ)
    scratch.position.copy(handoffTo.position)
    scratch.up.set(0, 1, 0)
    scratch.lookAt(new THREE.Vector3(landingX, groundY + 2, landingZ))
    handoffTo.quaternion.copy(scratch.quaternion)

    handoff = { t: 0 }
  }

  const dirToLander = new THREE.Vector3()

  function update(dt) {
    if (craneReleasing && craneFlyaway < 1) {
      craneFlyaway = Math.min(1, craneFlyaway + dt / 3.0)
      lander.setCraneRelease(craneFlyaway)
    }

    if (mode === 'descent') {
      if (handoff) {
        handoff.t += dt
        const t = Math.min(1, handoff.t / HANDOFF_DURATION)
        const e = easeInOutCubic(t)
        camera.position.lerpVectors(handoffFrom.position, handoffTo.position, e)
        camera.quaternion.slerpQuaternions(handoffFrom.quaternion, handoffTo.quaternion, e)
        if (t >= 1) {
          handoff = null
          mode = 'firstPerson'
          markerGroup.visible = true
        }
      } else {
        placeChaseCamera(lander.root.position.y)
        focusPoint.set(landingX, chaseAimY(lander.root.position.y), landingZ)
        aimAt(focusPoint, dt)
      }
      focusPoint.set(landingX, groundY, landingZ)
    } else {
      firstPerson.update(dt)
      focusPoint.copy(firstPerson.player.position)
    }

    // 阴影相机跟着当前关注点走
    sunLight.position.set(focusPoint.x, 0, focusPoint.z).addScaledVector(sunDirection, 2000)
    sunLight.target.position.copy(focusPoint)
    sunLight.target.updateMatrixWorld()
    sky.mesh.position.set(focusPoint.x, 0, focusPoint.z)
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
        const list = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of list) m.dispose()
      }
    })
  }

  const info = {
    bodyName: body.data.name,
    siteName: site.name,
    gravity,
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
    landerType: lander.type,
  }

  // 下降阶段先把相机摆好，免得第一帧出现在原点
  placeChaseCamera(groundY + 120)
  scratch.position.copy(camera.position)
  scratch.lookAt(new THREE.Vector3(landingX, groundY + 120, landingZ))
  camera.quaternion.copy(scratch.quaternion)

  return {
    scene,
    camera,
    firstPerson,
    lander,
    info,
    update,
    resize,
    dispose,
    setDescentState,
    beginFirstPerson,
    getMode: () => mode,
    isFirstPerson: () => mode === 'firstPerson',
    sunDirection,
  }
}
