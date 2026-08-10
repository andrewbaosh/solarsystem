import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
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
  return set.elements.a * AU_KM
}

export function createSurfaceScene({
  body,
  elements,
  missions,
  renderer,
  edlProfile,
  preloadedModel,
}) {
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
  const scattering = config.sky?.scattering ?? 0

  /**
   * 渲染亮度用的是**感知压缩后**的辐照度，不是线性值。
   *
   * 线性照做的话土卫六只有地球的 1.1%、木卫二 3.7%，屏幕上直接全黑 —— 而真实的
   * 惠更斯号照片里地面是看得见的，因为人眼与相机都会适应亮度。另外厚霾天空本身是亮的，
   * 亮天空配全黑地面在物理上也自相矛盾。这里取 0.35 次幂，把 600:1 的动态范围压到
   * 约 9:1：各天体的明暗次序与差距感都还在，但都能看见。
   * HUD 上显示的仍是**真实的**辐照度与百分比，不受这里影响。
   */
  const lightBudget = Math.pow(irradianceRatio, 0.35)

  const sunLight = new THREE.DirectionalLight(
    new THREE.Color(config.sunlightColor ?? '#fff4e6'),
    // 大气越厚，直射越少、漫射越多：土卫六的地面几乎全靠天空散射照亮
    SUNLIGHT_AT_1AU * lightBudget * (1 - scattering * 0.6),
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

  // 无大气天体几乎没有天空散射，所以月面的阴影是纯黑的、对比度极高
  const skyFill = new THREE.HemisphereLight(
    new THREE.Color(config.sky?.horizon ?? '#ffffff'),
    new THREE.Color(config.terrain?.groundColor ?? '#555555'),
    SUNLIGHT_AT_1AU * lightBudget * (0.06 + scattering * 0.9),
  )
  scene.add(skyFill)

  // ---- 着陆器 --------------------------------------------------------------

  const landingX = 0
  const landingZ = 0
  const groundY = terrain.heightAt(landingX, landingZ)

  const lander = createLander(edlProfile?.lander ?? 'generic', { preloadedModel })
  lander.root.position.set(landingX, groundY, landingZ)
  scene.add(lander.root)

  /**
   * 由天空生成一张环境贴图。
   * NASA 的 glTF 模型用的是 PBR 材质，金属度很高；没有环境可反射时金属件会发黑。
   * 拿天空球烘一张 PMREM 出来，模型才有正常的金属质感。
   */
  const pmrem = new THREE.PMREMGenerator(renderer)
  const skyScene = new THREE.Scene()
  const skyClone = sky.mesh.clone()
  skyScene.add(skyClone)
  const environment = pmrem.fromScene(skyScene).texture
  scene.environment = environment
  pmrem.dispose()

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

  /**
   * 三种镜头：
   *   descent      下降跟拍
   *   firstPerson  站在地面上走动
   *   orbit        绕着着陆器看 —— 和看太阳系时一样可以拖动旋转、滚轮缩放
   */
  let mode = 'descent'
  let handoff = null

  const orbitControls = new OrbitControls(camera, renderer.domElement)
  orbitControls.enableDamping = true
  orbitControls.dampingFactor = 0.08
  orbitControls.rotateSpeed = 0.5
  orbitControls.zoomSpeed = 0.9
  orbitControls.minDistance = 2
  orbitControls.maxDistance = 400
  // 不让镜头钻到地面以下
  orbitControls.maxPolarAngle = Math.PI * 0.495
  orbitControls.listenToKeyEvents(window)
  orbitControls.enabled = false
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
  /**
   * 追机位：相机**跟着飞行器一起下降**，始终保持大致固定的斜距。
   *
   * 之前相机钉在地面附近，飞行器在 300 m 高时只剩一两个像素 —— 那不叫跟拍。
   * 现在相机悬在飞行器侧上方随它落下，全程都能看清机器；因为相机略高于飞行器
   * 且朝下看，下方的地面也一直在画面里。
   */
  // 伞打开时伞冠在飞行器上方约 20 m，机位要相应拉远抬高才装得下
  let chuteOut = false
  const chaseDist = () => chase.dist * (chuteOut ? 1.85 : 1)

  function placeChaseCamera(landerY) {
    const d = chaseDist()
    const x = landingX + Math.sin(chaseAngle) * d
    const z = landingZ + Math.cos(chaseAngle) * d
    const terrainY = terrain.heightAt(x, z)
    camera.position.set(x, Math.max(terrainY + 2.5, landerY + chase.height + (chuteOut ? 13 : 0)), z)
  }

  /** 瞄点略低于飞行器，让它稳定落在画面中偏上的位置，下方留给说明面板 */
  function chaseAimY(landerY) {
    // 开伞时把瞄点抬到飞行器与伞冠之间，两者一起入画
    return landerY + (chuteOut ? 9 : -chaseDist() * 0.16)
  }

  /** 由 EDL 时序驱动：设置着陆器当前的下降状态 */
  function setDescentState(state) {
    if (mode !== 'descent') return
    const y = state.y ?? 0
    const tether = state.tether ?? 0

    // 空中吊车的 y 指的是**车**的高度，下降级还挂在缆绳上方，
    // 所以要把整体抬高一个缆绳长度，否则车会沉到地下去
    lander.root.position.y = groundY + y + (lander.tetherDropAt?.(tether) ?? 0)

    lander.setShell((state.shell ?? 0) > 0.5, state.heat ?? 0)
    chuteOut = (state.chute ?? 0) > 0.5
    lander.setParachute(chuteOut)
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
  const landerFocus = new THREE.Vector3()

  /** 在「站在地面走动」与「绕着着陆器看」之间切换 */
  function setViewMode(next) {
    if (mode === 'descent' || handoff) return mode
    if (next === mode) return mode
    if (next === 'orbit') {
      landerFocus.set(landingX, groundY + lander.height * 0.5, landingZ)
      orbitControls.target.copy(landerFocus)
      // 从当前站位起步，不要瞬移
      const offset = camera.position.clone().sub(landerFocus)
      if (offset.lengthSq() < 4) offset.set(9, 5, 7)
      camera.position.copy(landerFocus).add(offset)
      orbitControls.enabled = true
      firstPerson.unlock()
      mode = 'orbit'
    } else {
      orbitControls.enabled = false
      firstPerson.spawn(camera.position.x, camera.position.z)
      mode = 'firstPerson'
    }
    return mode
  }

  /** 键盘缩放，只在环绕观察下有意义 */
  function zoomBy(factor) {
    if (mode !== 'orbit') return
    const offset = camera.position.clone().sub(orbitControls.target)
    const distance = THREE.MathUtils.clamp(
      offset.length() * factor,
      orbitControls.minDistance,
      orbitControls.maxDistance,
    )
    camera.position.copy(orbitControls.target).addScaledVector(offset.normalize(), distance)
    orbitControls.update()
  }

  function toggleViewMode() {
    return setViewMode(mode === 'orbit' ? 'firstPerson' : 'orbit')
  }

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
          firstPerson.activate() // 交接完成才允许走动，避免下降途中误触
        }
      } else {
        placeChaseCamera(lander.root.position.y)
        focusPoint.set(landingX, chaseAimY(lander.root.position.y), landingZ)
        aimAt(focusPoint, dt)
      }
      focusPoint.set(landingX, groundY, landingZ)
    } else if (mode === 'orbit') {
      orbitControls.update()
      focusPoint.copy(orbitControls.target)
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
    orbitControls.dispose()
    firstPerson.dispose()
    scene.traverse((obj) => {
      // 缓存模型的 geometry / material 是跨场景共享的，释放了下次登陆就没东西可用
      if (obj.geometry && !obj.geometry.userData?.shared) obj.geometry.dispose()
      if (obj.material) {
        const list = Array.isArray(obj.material) ? obj.material : [obj.material]
        for (const m of list) if (m && !m.userData?.shared) m.dispose()
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
    setViewMode,
    toggleViewMode,
    zoomBy,
    getMode: () => mode,
    isFirstPerson: () => mode === 'firstPerson',
    isWalkable: () => mode === 'firstPerson' || mode === 'orbit',
    sunDirection,
  }
}
