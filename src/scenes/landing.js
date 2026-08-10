import './../ui/surface.css'
import { createSurfaceScene } from './surface.js'

/**
 * 登陆流程的调度器。
 *
 * 明确的设计前提：**不做从太空到地表的无缝过渡**。
 * 两套场景的单位制差了九个数量级（轨道场景 1 单位 = 100 万 km，地表 1 单位 = 1 米），
 * 硬凑无缝要么牺牲轨道精度，要么牺牲地表精度。所以用转场遮罩切换独立场景，
 * 这是刻意的取舍，不是妥协。
 *
 * 时序（进入）：
 *   0.0s  相机向天体推进
 *   0.5s  遮罩升白 / 大气进入色
 *   1.4s  遮罩全不透明 → 构建地表场景、切换渲染目标
 *   1.6s  遮罩淡出，露出地表
 */

const PUSH_IN = 0.5
const VEIL_IN = 0.9
const HOLD = 0.2
const VEIL_OUT = 1.0

export function createLanding({
  renderer,
  cameraRig,
  bodySystem,
  elements,
  missions,
  surfaceHud,
  onModeChange,
}) {
  const veil = document.createElement('div')
  veil.className = 'transition-veil'
  document.body.appendChild(veil)

  const caption = document.createElement('div')
  caption.className = 'transition-caption'
  document.body.appendChild(caption)

  let mode = 'orbit' // 'orbit' | 'surface'
  let surface = null
  let phase = null // {kind:'enter'|'exit', t, body}

  function isLandable(body) {
    return Boolean(body?.data?.surface?.landable)
  }

  function enter(body) {
    if (phase || mode === 'surface' || !isLandable(body)) return
    const tint = body.data.surface.sky?.horizon ?? '#ffffff'
    veil.style.setProperty('--entry-tint', tint)
    caption.textContent = `正在进入 ${body.data.name} 大气`
    phase = { kind: 'enter', t: 0, body }

    // 相机向天体表面推进，制造「扎进去」的感觉
    cameraRig.flyTo(body, { distanceFactor: 1.12, duration: PUSH_IN + VEIL_IN })
  }

  function exit() {
    if (phase || mode !== 'surface') return
    const body = surface.body
    caption.textContent = `正在离开 ${body.data.name}`
    veil.style.setProperty('--entry-tint', body.data.surface.sky?.horizon ?? '#ffffff')
    phase = { kind: 'exit', t: 0, body }
    surface.scene.firstPerson?.unlock?.()
    surface.firstPerson.unlock()
  }

  function buildSurface(body) {
    surface = createSurfaceScene({ body, elements, missions, renderer })
    surface.body = body
    surfaceHud.attach(surface)
    surfaceHud.show()
  }

  function teardownSurface() {
    surfaceHud.hide()
    surface?.dispose()
    surface = null
  }

  function update(dt) {
    if (surface && mode === 'surface') surface.update(dt)

    if (!phase) return
    phase.t += dt
    const t = phase.t

    if (phase.kind === 'enter') {
      if (t > PUSH_IN) veil.classList.add('is-hot')
      if (t > PUSH_IN + VEIL_IN * 0.5) caption.classList.add('is-visible')

      if (mode === 'orbit' && t >= PUSH_IN + VEIL_IN) {
        // 遮罩此刻完全不透明，切换是看不见的
        buildSurface(phase.body)
        mode = 'surface'
        onModeChange('surface')
      }
      if (t >= PUSH_IN + VEIL_IN + HOLD) {
        caption.classList.remove('is-visible')
        veil.classList.remove('is-hot')
        veil.classList.add('is-cooling')
      }
      if (t >= PUSH_IN + VEIL_IN + HOLD + VEIL_OUT) {
        veil.classList.remove('is-cooling')
        phase = null
      }
      return
    }

    // 退出：遮罩升起 → 拆掉地表场景 → 回到轨道视角
    if (t > 0) veil.classList.add('is-hot')
    if (t > VEIL_IN * 0.5) caption.classList.add('is-visible')

    if (mode === 'surface' && t >= VEIL_IN) {
      teardownSurface()
      mode = 'orbit'
      onModeChange('orbit')
      cameraRig.flyTo(phase.body, { distanceFactor: 4.2, duration: VEIL_OUT })
    }
    if (t >= VEIL_IN + HOLD) {
      caption.classList.remove('is-visible')
      veil.classList.remove('is-hot')
      veil.classList.add('is-cooling')
    }
    if (t >= VEIL_IN + HOLD + VEIL_OUT) {
      veil.classList.remove('is-cooling')
      phase = null
    }
  }

  return {
    enter,
    exit,
    update,
    isLandable,
    getMode: () => mode,
    getSurface: () => surface,
    isTransitioning: () => Boolean(phase),
  }
}
