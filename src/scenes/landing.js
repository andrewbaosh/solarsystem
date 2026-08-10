import { createSurfaceScene } from './surface.js'
import { createEdlSequence } from '../ui/edlSequence.js'

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

  let mode = 'orbit' // 'orbit' | 'surface'
  let surface = null
  let exitPhase = null // 返回轨道用的简单遮罩时序

  function isLandable(body) {
    return Boolean(body?.data?.surface?.landable) && Boolean(edlProfiles[body.data.id])
  }

  function buildSurface(body) {
    surface = createSurfaceScene({ body, elements, missions, renderer })
    surface.body = body
    surfaceHud.attach(surface)
    surfaceHud.show()
    mode = 'surface'
    onModeChange('surface')
  }

  function teardownSurface() {
    surfaceHud.hide()
    surface?.dispose()
    surface = null
  }

  function enter(body) {
    if (exitPhase || sequence.isRunning() || mode === 'surface' || !isLandable(body)) return

    sequence.setTint(body.data.surface.sky?.horizon ?? '#ffffff')
    const started = sequence.start(body.data.id, edlProfiles, () => buildSurface(body))
    if (!started) return

    // 相机同步向天体推进，时序前半段仍然是轨道视角
    const profile = edlProfiles[body.data.id]
    const untilSwap = profile.steps
      .slice(0, Math.max(1, profile.steps.findIndex((s) => s.swap) + 1))
      .reduce((sum, s) => sum + s.hold, 0)
    cameraRig.flyTo(body, { distanceFactor: 1.12, duration: untilSwap })
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
    if (surface && mode === 'surface') surface.update(dt)

    sequence.update(dt)

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
