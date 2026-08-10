import { createSurfaceScene } from './surface.js'
import { createEdlSequence } from '../ui/edlSequence.js'
import { createAssetToast } from '../ui/loading.js'

/**
 * 登陆流程的调度器。
 *
 * 明确的设计前提：**不做太空到地表的无缝过渡**。
 * 两套场景的单位制差了九个数量级（轨道 1 单位 = 100 万 km，地表 1 单位 = 1 米），
 * 硬凑无缝要么牺牲轨道精度，要么牺牲地表精度。所以用转场切换独立场景。
 *
 * 转场不是一段装饰性的白光，而是按 data/edl.json 播放该天体的
 * 进入-下降-着陆时序：每个阶段给出真实的高度、速度与当时在发生什么。
 * 场景切换安排在遮罩最不透明的那一步，因此切换本身是看不见的。
 */

const EXIT_VEIL_IN = 0.9
const EXIT_HOLD = 0.2
const EXIT_VEIL_OUT = 1.0
/** 触地到镜头交接之间的停留，单位秒 */
const TOUCHDOWN_HOLD = 2.0
/** 换景遮罩：相机扎向天体、遮罩升满的时长 */
const WARP_IN = 0.85

export function createLanding({
  renderer,
  cameraRig,
  bodySystem,
  elements,
  missions,
  edlProfiles,
  surfaceHud,
  onModeChange,
}) {
  const sequence = createEdlSequence({ onSkip: () => sequence.skip() })
  const assetToast = createAssetToast()

  let mode = 'orbit' // 'orbit' | 'surface'
  let surface = null
  let exitPhase = null // 返回轨道用的简单遮罩时序
  let warp = null // 换景遮罩，时序开始前的那一小段
  let touchdownHold = 0

  function isLandable(body) {
    return Boolean(body?.data?.surface?.landable) && Boolean(edlProfiles[body.data.id])
  }

  function buildSurface(body) {
    surface = createSurfaceScene({
      body,
      elements,
      missions,
      renderer,
      edlProfile: edlProfiles[body.data.id],
      onModelLoadStart: () => assetToast.show('正在加载着陆器模型…'),
      onModelSettled: () => assetToast.hide(),
    })
    surface.body = body
    surfaceHud.attach(surface)
    surfaceHud.show()
    mode = 'surface'
    onModeChange('surface')
  }

  /**
   * 把时序进度换算成着陆器的下降状态。
   * y 与 tether 在相邻阶段之间插值（连续的下降动作），
   * chute / plume 是开关量，直接取当前阶段的值。
   */
  function syncDescent() {
    if (!surface || surface.getMode() !== 'descent') return
    const p = sequence.getProgress()
    if (!p?.step?.viz) return
    const a = p.step.viz
    const b = p.next?.viz ?? a
    const lerp = (key) => {
      const from = a[key] ?? 0
      const to = b[key] ?? 0
      return from + (to - from) * p.t
    }
    surface.setDescentState({
      y: lerp('y'),
      tether: lerp('tether'),
      heat: lerp('heat'),
      // 开关量不插值，取当前阶段的值
      shell: a.shell ?? 0,
      chute: a.chute ?? 0,
      plume: a.plume ?? 0,
    })
  }

  function teardownSurface() {
    surfaceHud.hide()
    surface?.dispose()
    surface = null
  }

  /**
   * 进入着陆。
   *
   * 场景切换放在时序**开始之前**：先用一段短促的遮罩盖住换景，
   * 然后从第一个阶段起就已经是第三人称跟拍着陆器了 ——
   * 整个下降过程都看得见机器，而不是前半段还在轨道上看行星。
   */
  function enter(body) {
    if (exitPhase || warp || sequence.isRunning() || mode === 'surface' || !isLandable(body)) return

    touchdownHold = 0
    sequence.setTint(body.data.surface.sky?.horizon ?? '#ffffff')
    sequence.prepare(body.data.id, edlProfiles)
    warp = { t: 0, body }
    cameraRig.flyTo(body, { distanceFactor: 1.12, duration: WARP_IN })
  }

  function exit() {
    if (exitPhase) return
    // 地表 HUD 在时序后半段就已经露出来了，此时点「返回轨道」必须有反应：
    // 先把剩余时序收掉，再走退出流程，否则按钮看着像坏的
    if (sequence.isRunning()) sequence.skip()
    if (mode !== 'surface' || !surface) return
    const body = surface.body
    surface.firstPerson.unlock()
    sequence.fadeOut(body.data.surface.edlVeilStyle ?? 'plasma', body.data.surface.sky?.horizon)
    exitPhase = { t: 0, body }
  }

  function update(dt) {
    // 换景：遮罩升满 → 建好地表场景 → 交给时序，此后全程第三人称
    if (warp) {
      warp.t += dt
      sequence.setVeilOpacity(Math.min(1, warp.t / WARP_IN))
      if (warp.t >= WARP_IN) {
        buildSurface(warp.body)
        sequence.begin()
        syncDescent() // 立刻摆好第一帧的着陆器姿态，避免闪一下默认状态
        warp = null
      }
      return
    }

    sequence.update(dt)
    syncDescent()

    // 触地后在第三人称多停一会儿，让人看清着陆器停稳的样子，再交接镜头
    if (surface && surface.getMode() === 'descent' && !sequence.isRunning()) {
      touchdownHold += dt
      if (touchdownHold >= TOUCHDOWN_HOLD) surface.beginFirstPerson()
    }

    if (surface && mode === 'surface') surface.update(dt)

    if (!exitPhase) return
    exitPhase.t += dt
    const t = exitPhase.t

    if (t <= EXIT_VEIL_IN) {
      sequence.setVeilOpacity(t / EXIT_VEIL_IN)
    } else if (mode === 'surface') {
      sequence.setVeilOpacity(1)
      teardownSurface()
      mode = 'orbit'
      onModeChange('orbit')
      cameraRig.flyTo(exitPhase.body, { distanceFactor: 4.2, duration: EXIT_VEIL_OUT })
    }

    if (t > EXIT_VEIL_IN + EXIT_HOLD) {
      const out = (t - EXIT_VEIL_IN - EXIT_HOLD) / EXIT_VEIL_OUT
      sequence.setVeilOpacity(Math.max(0, 1 - out))
      if (out >= 1) {
        sequence.setVeilOpacity(0)
        exitPhase = null
      }
    }
  }

  return {
    enter,
    exit,
    update,
    isLandable,
    getMode: () => mode,
    getSurface: () => surface,
    isTransitioning: () => sequence.isRunning() || Boolean(exitPhase),
    skipSequence: () => sequence.skip(),
  }
}
