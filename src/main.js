import * as THREE from 'three'
import planetsData from '../data/planets.json'
import orbitalElements from '../data/orbital-elements.json'
import satellitesData from '../data/satellites.json'

import { createRenderer, createCamera, handleResize } from './core/renderer.js'
import { createCameraRig } from './core/cameraRig.js'
import * as time from './core/time.js'
import * as scale from './core/scale.js'
import { createBodySystem } from './bodies/bodySystem.js'
import { indexById, heliocentricKm, satellitePositionKm } from './bodies/orbital.js'
import { initTextures, loadColorTexture } from './core/textures.js'
import { createComposer } from './core/postprocessing.js'
import { createHUD } from './ui/hud.js'
import { createLabels } from './ui/labels.js'
import { createSelection } from './ui/selection.js'
import { createInfoPanel } from './ui/infoPanel.js'
import { createTimeControls } from './ui/timeControls.js'
import { createSurfaceHud } from './ui/surfaceHud.js'
import { createLoadingScreen } from './ui/loading.js'
import { createFilters } from './ui/filters.js'
import { preloadLanderModel } from './scenes/landers.js'
import { createLanding } from './scenes/landing.js'
import missionsData from '../data/missions.json'
import edlData from '../data/edl.json'
import epigraphsData from '../data/epigraphs.json'
import smallBodiesData from '../data/small-bodies.json'
import { createAsteroidBelt } from './bodies/asteroidBelt.js'
import { createSmallBodies } from './bodies/smallBodies.js'
import { createAmbientMusic, VIEW } from './audio/ambientMusic.js'
import { createAudioToggle } from './ui/audioToggle.js'
import { createEphemerisLoader } from './bodies/ephemeris.js'
import { createMeasures, findEvents, classifySolarEclipse, classifyLunarEclipse } from './events/finder.js'
import { createEventsPanel } from './ui/eventsPanel.js'
import eventsData from '../data/events.json'
import { createTour } from './tour/tourPlayer.js'
import { createTourUI } from './ui/tourUI.js'
import tourData from '../data/tour.json'

// 首屏加载界面要在任何资源开始加载之前挂上，否则进度会从中途开始
const loadingScreen = createLoadingScreen({
  manager: THREE.DefaultLoadingManager,
  onStart: () => {
    // 音床是几 MB，放在这里取而不是页面一打开就取：首屏带宽全留给贴图，
    // 而且这次点击同时也是 AudioContext 需要的那个用户手势
    music.unlock()
    music.load()
    // 星历表 500 KB 上下，同样放在这次点击之后取，不跟贴图抢首屏
    ephemeris.load(planetsData.bodies.filter((b) => b.type !== 'star').map((b) => b.id))
  },
})

// JPL 表按行给出，场景各处按 id 取
const planetElements = indexById(orbitalElements.planets)

const canvas = document.getElementById('scene')
const renderer = createRenderer(canvas)
const camera = createCamera()
const scene = new THREE.Scene()

initTextures(renderer)

// 星空：真实星图做天球背景，亮度压到 0.12 免得抢戏
const starfield = loadColorTexture(planetsData.background.map)
starfield.mapping = THREE.EquirectangularReflectionMapping
scene.background = starfield
scene.backgroundIntensity = planetsData.background.intensity

const cameraRig = createCameraRig(camera, renderer.domElement)

/**
 * 高精度星历（VSOP87 + ELP2000）。首屏不取，点「开始探索」后台加载；
 * 表到位前场景用 Standish 表跑，到位后自动切换 —— 两者差角分级，看不出跳变。
 * 取不到就一直用 Standish，只是天象里的日月食会被禁掉。
 */
const ephemeris = createEphemerisLoader({ baseUrl: import.meta.env.BASE_URL ?? '/' })

const bodySystem = createBodySystem(scene, {
  planets: planetsData.bodies,
  elements: planetElements,
  satellites: satellitesData.satellites,
  ephemeris,
})

/**
 * 场景唯一光源：太阳中心的点光源。
 * decay 设为 0（不做距离衰减）是一处刻意的作弊 —— 物理衰减下海王星会比水星暗
 * 56 倍，直接黑掉。这跟距离压缩、半径放大属于同一类「显式的假」。
 */
const sunLight = new THREE.PointLight(0xfff4e0, 3.2, 0, 0)
sunLight.castShadow = true
sunLight.shadow.mapSize.set(2048, 2048)
sunLight.shadow.camera.near = 0.02
sunLight.shadow.camera.far = 600
sunLight.shadow.bias = -0.0005
bodySystem.get('sun').group.add(sunLight)

// 小行星带 + 命名小行星 + 彗星与星际天体
const asteroidBelt = createAsteroidBelt(scene, smallBodiesData.belt)
const smallBodies = createSmallBodies(scene, smallBodiesData)
let smallBodiesOn = true

const { composer, setSize: setComposerSize } = createComposer(renderer, scene, camera)
const hud = createHUD({ camera, cameraRig })
// 小天体一并纳入标签与拾取，否则看得见却点不开
const pickable = [...bodySystem.bodies, ...smallBodies.bodies]
const labels = createLabels(pickable, camera)
let labelsOn = true

// 显示筛选器：按类别开关，只改可见性，不影响任何计算
const filters = createFilters({
  onChange: (f) => {
    bodySystem.setVisibility({ planets: f.planets, satellites: f.satellites, orbits: f.orbits })
    asteroidBelt.setVisible(f.asteroidBelt)
    smallBodies.setVisible(f.smallBodies, f.orbits)
    smallBodiesOn = f.asteroidBelt || f.smallBodies
    labelsOn = f.labels
    labels.setVisible(labelsOn)
  },
})

handleResize(renderer, camera)
window.addEventListener('resize', () => {
  setComposerSize(window.innerWidth, window.innerHeight)
  landing.getSurface()?.resize()
})

// 起始时间：当前真实时刻（时间源仍然是 J2000 儒略日）
time.setDate(new Date())
// 默认 1 天/秒。注意全景视角下外行星在这个倍率里每秒只走零点几个像素，
// 看上去接近静止，要看出公转得按 [ ] 调快或先聚焦到内行星。
time.setSpeed(86400) // 1 天/秒

// 先把天体摆到位，这样第一帧的聚焦目标就是正确的
bodySystem.update(time.getJD())
asteroidBelt.updateAll(time.getJD() - time.J2000_JD, 1)
smallBodies.update(time.getJD())
smallBodies.rebuildOrbitLines(time.getJD())
let lastSmallBodyRevision = scale.getScaleRevision()
cameraRig.setFocus(bodySystem.get('sun'), { smooth: false })

// ---- 选取与信息面板 --------------------------------------------------------

const timeControls = createTimeControls()
const infoPanel = createInfoPanel({
  elements: planetElements,
  // JPL 自己给出的误差表：哪颗星球算得准、哪颗不准，直接摆在资料面板里
  accuracy: {
    ...orbitalElements._meta.accuracy_arcsec_longitude,
    _validRange: orbitalElements._meta.validRange,
  },
  epigraphs: epigraphsData.bodies,
  missions: missionsData,
  edlProfiles: edlData.profiles,
  onClose: () => deselect(),
  onLand: (body) => {
    infoPanel.hide() // 时序一开始就收起资料面板，否则前半段会和 EDL 面板叠在一起
    landing.enter(body)
  },
})

// ---- 背景音乐 --------------------------------------------------------------

/**
 * 音乐由视图状态驱动，不给手动播放/暂停。
 * 状态的唯一真相是这里：地表 > 聚焦 > 全景，逐级判断。
 */
function currentViewState() {
  if (landing.getMode() === 'surface') return VIEW.SURFACE
  return cameraRig.getFocus() ? VIEW.FOCUSED : VIEW.OVERVIEW
}

const music = createAmbientMusic({
  baseUrl: import.meta.env.BASE_URL ?? '/',
  onChange: (s) => audioToggle.render(s),
})

const audioToggle = createAudioToggle({
  container: timeControls.element,
  onToggle: () => music.toggle(),
  onUnlock: () => music.unlock(),
})
audioToggle.render(music.status())
// 素材在「开始探索」点击时才加载（见上面的 onStart）；没有素材就静默降级

// ---- 登陆 / 返回轨道 --------------------------------------------------------

const surfaceHud = createSurfaceHud({ onExit: () => landing.exit() })
const landing = createLanding({
  renderer,
  cameraRig,
  bodySystem,
  elements: planetElements,
  missions: missionsData,
  edlProfiles: edlData.profiles,
  surfaceHud,
  onModeChange: (mode) => {
    // 地表模式下把轨道场景的 UI 全部收起来
    document.body.classList.toggle('surface-mode', mode === 'surface')
    music.setViewState(currentViewState())
    if (mode === 'surface') infoPanel.hide()
  },
})

// ---- 天象 ------------------------------------------------------------------

/**
 * 天象搜索器要的是**地心向量**，而场景里存的是日心/母星相对坐标，
 * 所以这里做一层换算。位置源优先高精度表，退化时仍能算冲与相合，
 * 只是日月食会被挡掉（月球误差超过 1°，算出来的食是假的）。
 */
const AU_KM = 149597870.7
const eventProvider = {
  get precise() {
    return ephemeris.hasMoon() && ephemeris.hasPlanet('earth')
  },
  sun(jd) {
    const e = this.helio('earth', jd)
    return { x: -e.x, y: -e.y, z: -e.z }
  },
  helio(id, jd) {
    if (ephemeris.hasPlanet(id)) {
      const au = ephemeris.planet(id, jd, {})
      return { x: au.x * AU_KM, y: au.y * AU_KM, z: au.z * AU_KM }
    }
    const set = planetElements[id]
    if (!set) return { x: 0, y: 0, z: 0 }
    const v = new THREE.Vector3()
    heliocentricKm(set, jd, v)
    return { x: v.x, y: v.y, z: v.z }
  },
  geocentric(id, jd) {
    if (id === 'moon') {
      if (ephemeris.hasMoon()) return ephemeris.moon(jd, {})
      const v = new THREE.Vector3()
      satellitePositionKm(satellitesData.satellites.find((s) => s.id === 'moon'), jd, v)
      return { x: v.x, y: v.y, z: v.z }
    }
    const e = this.helio('earth', jd)
    const b = this.helio(id, jd)
    return { x: b.x - e.x, y: b.y - e.y, z: b.z - e.z }
  },
}
const eventMeasures = createMeasures(eventProvider)

const CLASSIFY = { solar: classifySolarEclipse, lunar: classifyLunarEclipse }
const KIND_CN = { total: '全食', annular: '环食', partial: '偏食', penumbral: '半影食' }

const eventsPanel = createEventsPanel({
  groups: eventsData.events.map((e) => ({ id: e.id, name: e.name })),
  onSearch: ({ years, ids }) => {
    const t0 = performance.now()
    const from = time.getJD()
    const to = from + years * 365.25
    const out = []
    let blocked = false
    for (const spec of eventsData.events) {
      if (!ids.includes(spec.id)) continue
      if (spec.needsPreciseMoon && !eventProvider.precise) {
        blocked = true
        continue
      }
      for (const hit of findEvents({ provider: eventProvider, measures: eventMeasures, spec, from, to, limit: 60 })) {
        const kind = spec.classify ? CLASSIFY[spec.classify](eventProvider, hit.jd) : null
        if (spec.classify && !kind) continue // 扫到了极小但够不上食
        out.push({
          jd: hit.jd,
          date: time.formatDate(new Date((hit.jd - 2440587.5) * 86400000)),
          name: spec.name,
          kind,
          target: spec.target,
          detail: describeEvent(spec, hit, kind),
        })
      }
    }
    out.sort((a, b) => a.jd - b.jd)
    return {
      events: out,
      ms: performance.now() - t0,
      warning: blocked
        ? '高精度星历还没就位，日月食暂不可算 —— 平均要素模型的月球误差超过 1°，算出来的食是假的。'
        : eventsData._meta.caveat,
    }
  },
  onJump: (e) => {
    time.setJD(e.jd)
    time.setPaused(true)
    bodySystem.update(time.getJD())
    smallBodies.update(time.getJD())
    const body = bodySystem.get(e.kind ? 'earth' : (e.target ?? 'earth'))
    if (body) select(body)
  },
})

function describeEvent(spec, hit, kind) {
  const acc = spec.accuracy ? `　${spec.accuracy}` : ''
  if (kind) return `${KIND_CN[kind]}${acc}`
  if (spec.measure === 'distance') return `${(hit.value / AU_KM).toFixed(4)} AU${acc}`
  if (spec.measure === 'separation') return `角距 ${hit.value.toFixed(2)}°${acc}`
  if (spec.measure === 'elongation') return `距角 ${hit.value.toFixed(1)}°${acc}`
  if (spec.measure === 'oppositionGap') return `偏离正冲 ${hit.value.toFixed(2)}°${acc}`
  return acc.trim()
}

// ---- 自动导览 --------------------------------------------------------------

/**
 * 导览引擎与场景之间的适配层。
 *
 * 引擎（src/tour/）只认识这个接口，不认识 bodySystem / filters / time /
 * scale 这些具体模块，也就无从硬编码任何天体。反过来，脚本里想加一种
 * 新的场景状态，改动也只落在这一个对象上。
 */
const tourScene = {
  resolveBody: (id) => bodySystem.get(id) ?? smallBodies.get(id),

  setTimeSpeed: (v) => time.setSpeed(v),
  setPaused: (v) => time.setPaused(v),
  setDate: (iso) => time.setDate(new Date(iso)),
  setJD: (jd) => time.setJD(jd),
  setScaleMode: (mode) => hud.setScaleMode(mode),
  setFilters: (partial) => {
    for (const [id, value] of Object.entries(partial)) filters.set(id, value)
  },
  setVisibleOrbits: (spec) => {
    // "all" / "none" / id 数组 —— 判定写在这里，引擎只负责把字段传过来
    const pred =
      spec === 'all'
        ? () => true
        : spec === 'none' || !spec
          ? () => false
          : (id) => spec.includes(id)
    bodySystem.setOrbitVisibility(pred)
    smallBodies.setOrbitVisibility(pred)
  },
  setHighlight: (id) => labels.setHighlight(id),

  /** 导览开始前存一份现场，退出时原样还回去 */
  snapshot: () => ({
    speed: time.getSpeed(),
    paused: time.isPaused(),
    filters: filters.state(),
    scaleMode: scale.getScaleMode(),
  }),

  onEnter: () => {
    deselect() // 导览自己管镜头，跟随焦点会和脚本抢
    cameraRig.cancelFlight()
    music.setControlMode('tour') // 导览期间音乐交给章节脚本（尚未实现，先让位）
  },

  onExit: (snapshot) => {
    music.setControlMode('ambient')
    music.setViewState(currentViewState())
    labels.setHighlight(null)
    if (!snapshot) return
    time.setSpeed(snapshot.speed)
    time.setPaused(snapshot.paused)
    hud.setScaleMode(snapshot.scaleMode)
    // 重新套一遍筛选器：被章节改过的轨道线可见性也随之复原
    for (const [id, value] of Object.entries(snapshot.filters)) filters.set(id, value)
    filters.reapply()
  },

  /** 用户接管：把 OrbitControls 的目标对到当前注视点，转起来才不会跳 */
  onTakeOver: (lookPoint) => {
    cameraRig.setFocus(null)
    cameraRig.controls.target.copy(lookPoint)
  },
}

const tourUI = createTourUI({
  chapters: tourData.chapters,
  handlers: {
    onStart: () => tour.start(),
    onExit: () => tour.stop(),
    onTogglePlay: () => tour.togglePlay(),
    onPrev: () => tour.prev(),
    onNext: () => tour.next(),
    onGoto: (i) => tour.goto(i),
    onResume: () => tour.resume(),
  },
})

const tour = createTour({
  chapters: tourData.chapters,
  camera,
  scene: tourScene,
  ui: tourUI,
})

// 播放中任何一次拖动或滚轮都立刻交出相机控制权，旁白与字幕照常走
for (const type of ['pointerdown', 'wheel']) {
  renderer.domElement.addEventListener(type, () => tour.takeOver(), { passive: true })
}

function select(body) {
  if (tour.isActive()) return // 导览进行中不响应拾取，点击的含义是「接管镜头」
  if (landing.getMode() === 'surface' || landing.isTransitioning()) return // 地表模式不响应轨道场景的拾取
  if (!body) return deselect()
  cameraRig.flyTo(body)
  music.setViewState(currentViewState())
  infoPanel.show(body, time.getJD())
  timeControls.applyFocusRate(body) // 贴近看时把倍率压慢，免得自转频闪
  // 面板一打开就把该天体的着陆器模型预热到缓存，用户真点「登陆」时就不用等网络了
  const profile = edlData.profiles[body.data.id]
  preloadLanderModel(profile?.model, profile?.modelHeight)
}

/** 解除跟随，回到自由视角 */
function deselect() {
  cameraRig.setFocus(null)
  cameraRig.cancelFlight()
  music.setViewState(currentViewState())
  infoPanel.hide()
  timeControls.applyFocusRate(null) // 恢复你自己设的倍率
}

createSelection({
  domElement: renderer.domElement,
  camera,
  bodySystem: { bodies: pickable },
  onSelect: select, // 点空会传 null，走 deselect
})

// ---- 键盘 ----------------------------------------------------------------

const FOCUS_ORDER = bodySystem.bodies.map((b) => b.data.id)

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  // 正在日期输入框里打字时，别把空格、R 当成快捷键
  if (timeControls.isEditing()) return
  // 地表模式下 WASD / 空格属于第一人称控制，不能被轨道场景的快捷键抢走
  if (landing.getMode() === 'surface' && e.code !== 'Escape') return

  // 导览进行中，几个键的含义要改到导览上，否则会去操作被隐藏起来的时间条
  if (tour.isActive()) {
    switch (e.code) {
      case 'Escape':
        tour.stop()
        return
      case 'Space':
        e.preventDefault()
        tour.togglePlay()
        return
      case 'BracketLeft':
        tour.prev()
        return
      case 'BracketRight':
        tour.next()
        return
      case 'Enter':
        tour.resume()
        return
    }
    return // 其余快捷键在导览里一律不响应
  }

  switch (e.code) {
    case 'Escape':
      // 正在播 EDL 时序时 ESC 表示跳过；地表模式下 ESC 由浏览器交还指针，
      // 都不该顺带取消轨道场景的选中
      if (landing.isTransitioning()) landing.skipSequence()
      else if (landing.getMode() !== 'surface') deselect()
      return
    case 'Space':
      e.preventDefault()
      time.togglePause()
      return
    case 'BracketLeft':
      time.stepSpeed(-1)
      return
    case 'BracketRight':
      time.stepSpeed(1)
      return
    case 'KeyR':
      time.reverse()
      return
    case 'KeyN':
      time.setDate(new Date())
      return
    case 'KeyJ':
      time.setJD(time.J2000_JD)
      return
    case 'KeyM':
      hud.toggleScale() // 走过渡动画，不是瞬切
      return
    case 'KeyK': {
      const on = !smallBodiesOn
      filters.set('asteroidBelt', on)
      filters.set('smallBodies', on)
      return
    }
    case 'KeyL':
      filters.set('labels', !labelsOn)
      return
    // 触摸板没有滚轮时的备用缩放；地表环绕视角下同样有效
    case 'Equal':
    case 'NumpadAdd':
      zoomBy(1 / 1.18)
      return
    case 'Minus':
    case 'NumpadSubtract':
      zoomBy(1.18)
      return
  }

  // 0~8 聚焦太阳与八大行星
  const digit = /^Digit([0-8])$/.exec(e.code)
  if (digit) {
    const id = FOCUS_ORDER[Number(digit[1])]
    const body = id && bodySystem.get(id)
    if (body) select(body)
  }
})

// 开发期调试句柄：控制台里可以直接改尺度系数、跳时间、换焦点
if (import.meta.env.DEV) {
  window.__solar = {
    scene, camera, renderer, cameraRig, bodySystem, time, scale, composer, sunLight,
    hud, infoPanel, timeControls, select, deselect, landing, surfaceHud, asteroidBelt, smallBodies,
    tour, tourScene, labels, filters, music, loadingScreen, ephemeris, eventsPanel, eventProvider,
  }
}

// ---- 主循环 --------------------------------------------------------------

const clock = new THREE.Clock()
const tourLookPoint = new THREE.Vector3()

renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.1) // 掉帧/切标签页时不要让时间跳变

  time.update(dt)
  landing.update(dt)

  const onSurface = landing.getMode() === 'surface'

  // 转场期间两套场景都要继续推进：遮罩后面正在换景，停下来会露馅
  if (!onSurface || landing.isTransitioning()) {
    bodySystem.update(time.getJD())
    if (smallBodiesOn) {
      const revision = scale.getScaleRevision()
      const days = time.getJD() - time.J2000_JD
      if (revision !== lastSmallBodyRevision) {
        // 尺度在变：小行星带必须整批刷新，否则分批更新会把它撕成四段
        smallBodies.rebuildOrbitLines(time.getJD())
        asteroidBelt.updateAll(days, scale.getRadiusExaggeration() / 60)
        lastSmallBodyRevision = revision
      } else {
        asteroidBelt.update(days, scale.getRadiusExaggeration() / 60)
      }
      smallBodies.update(time.getJD())
    }
    tour.update(dt)
    if (tour.isDrivingCamera()) {
      // 脚本在开镜头。仍然把 OrbitControls 的目标钉在注视点上 ——
      // 这样用户任何时刻伸手接管，转动都是绕着当前看的东西转，不会跳。
      cameraRig.controls.target.copy(tour.getLookPoint(tourLookPoint))
    } else {
      cameraRig.update(dt)
    }
    hud.update(dt) // 尺度过渡动画在 HUD 里推进
    timeControls.update()
    if (labelsOn && !onSurface) labels.update()
  }

  if (onSurface) {
    const surface = landing.getSurface()
    surfaceHud.update()
    renderer.render(surface.scene, surface.camera)
  } else {
    composer.render()
  }
})
