import * as THREE from 'three'
import planetsData from '../data/planets.json'
import orbitalElements from '../data/orbital-elements.json'
import satellitesData from '../data/satellites.json'

import { createRenderer, createCamera, handleResize } from './core/renderer.js'
import { createCameraRig } from './core/cameraRig.js'
import * as time from './core/time.js'
import * as scale from './core/scale.js'
import { createBodySystem } from './bodies/bodySystem.js'
import { initTextures, loadColorTexture } from './core/textures.js'
import { createComposer } from './core/postprocessing.js'
import { createHUD } from './ui/hud.js'
import { createLabels } from './ui/labels.js'
import { createSelection } from './ui/selection.js'
import { createInfoPanel } from './ui/infoPanel.js'
import { createTimeControls } from './ui/timeControls.js'
import { createSurfaceHud } from './ui/surfaceHud.js'
import { createLoadingScreen } from './ui/loading.js'
import { preloadLanderModel } from './scenes/landers.js'
import { createLanding } from './scenes/landing.js'
import missionsData from '../data/missions.json'
import edlData from '../data/edl.json'
import smallBodiesData from '../data/small-bodies.json'
import { createAsteroidBelt } from './bodies/asteroidBelt.js'
import { createSmallBodies } from './bodies/smallBodies.js'

// 首屏加载界面要在任何资源开始加载之前挂上，否则进度会从中途开始
createLoadingScreen({ manager: THREE.DefaultLoadingManager })

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
const bodySystem = createBodySystem(scene, {
  planets: planetsData.bodies,
  elements: orbitalElements.planets,
  satellites: satellitesData.satellites,
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
asteroidBelt.update(time.getJD() - time.J2000_JD, 1)
smallBodies.update(time.getJD())
smallBodies.rebuildOrbitLines(time.getJD())
let lastSmallBodyRevision = scale.getScaleRevision()
cameraRig.setFocus(bodySystem.get('sun'), { smooth: false })

// ---- 选取与信息面板 --------------------------------------------------------

const timeControls = createTimeControls()
const infoPanel = createInfoPanel({
  elements: orbitalElements.planets,
  missions: missionsData,
  edlProfiles: edlData.profiles,
  onClose: () => deselect(),
  onLand: (body) => {
    infoPanel.hide() // 时序一开始就收起资料面板，否则前半段会和 EDL 面板叠在一起
    landing.enter(body)
  },
})

// ---- 登陆 / 返回轨道 --------------------------------------------------------

const surfaceHud = createSurfaceHud({ onExit: () => landing.exit() })
const landing = createLanding({
  renderer,
  cameraRig,
  bodySystem,
  elements: orbitalElements.planets,
  missions: missionsData,
  edlProfiles: edlData.profiles,
  surfaceHud,
  onModeChange: (mode) => {
    // 地表模式下把轨道场景的 UI 全部收起来
    document.body.classList.toggle('surface-mode', mode === 'surface')
    if (mode === 'surface') infoPanel.hide()
  },
})

function select(body) {
  if (landing.getMode() === 'surface' || landing.isTransitioning()) return // 地表模式不响应轨道场景的拾取
  if (!body) return deselect()
  cameraRig.flyTo(body)
  infoPanel.show(body, time.getJD())
  // 面板一打开就把该天体的着陆器模型预热到缓存，用户真点「登陆」时就不用等网络了
  const profile = edlData.profiles[body.data.id]
  preloadLanderModel(profile?.model, profile?.modelHeight)
}

/** 解除跟随，回到自由视角 */
function deselect() {
  cameraRig.setFocus(null)
  cameraRig.cancelFlight()
  infoPanel.hide()
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
    case 'KeyK':
      smallBodiesOn = !smallBodiesOn
      asteroidBelt.setVisible(smallBodiesOn)
      smallBodies.setVisible(smallBodiesOn)
      return
    case 'KeyL':
      labelsOn = !labelsOn
      labels.setVisible(labelsOn)
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
  }
}

// ---- 主循环 --------------------------------------------------------------

const clock = new THREE.Clock()

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
      if (revision !== lastSmallBodyRevision) {
        smallBodies.rebuildOrbitLines(time.getJD())
        lastSmallBodyRevision = revision
      }
      const days = time.getJD() - time.J2000_JD
      asteroidBelt.update(days, scale.getRadiusExaggeration() / 60)
      smallBodies.update(time.getJD())
    }
    cameraRig.update(dt)
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
