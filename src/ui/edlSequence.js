import './edl.css'

/**
 * 进入-下降-着陆（EDL）时序播放器。
 *
 * 每颗天体的时序来自 data/edl.json，尽量依据一次真实成功的着陆任务；
 * 没有着陆先例的天体用虚拟方案，界面上以橙色徽章明确区分，绝不混为一谈。
 *
 * 遮罩的样式也由数据决定：
 *  - plasma：有大气，进入时高温等离子体致白
 *  - dark：无大气，根本不存在气动加热，用暗场过渡
 * 月球着陆时屏幕不该发白 —— 那是真空。
 */

const escapeHtml = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])

/** 正文里允许一处 **强调** */
const renderText = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')

export function createEdlSequence({ onSkip }) {
  const veil = document.createElement('div')
  veil.className = 'edl-veil'
  document.body.appendChild(veil)

  const panel = document.createElement('div')
  panel.className = 'edl-panel'
  panel.innerHTML = `
    <button class="edl-skip" type="button">跳过</button>
    <div class="edl-source"></div>
    <div class="edl-head">
      <div class="edl-phase"></div>
      <div class="edl-elapsed"></div>
    </div>
    <div class="edl-readout"></div>
    <div class="edl-text"></div>
    <div class="edl-steps"></div>
  `
  document.body.appendChild(panel)

  const sourceEl = panel.querySelector('.edl-source')
  const phaseEl = panel.querySelector('.edl-phase')
  const elapsedEl = panel.querySelector('.edl-elapsed')
  const readoutEl = panel.querySelector('.edl-readout')
  const textEl = panel.querySelector('.edl-text')
  const stepsEl = panel.querySelector('.edl-steps')
  panel.querySelector('.edl-skip').addEventListener('click', () => onSkip())

  let profile = null
  let index = -1
  let elapsed = 0
  let running = false
  let onSwap = null
  let swapped = false

  function renderSource() {
    const { basedOn, real } = profile
    const badge = real
      ? '<span class="edl-badge is-real">真实任务</span>'
      : '<span class="edl-badge is-hypothetical">虚拟方案</span>'
    const detail = real
      ? `依据 ${escapeHtml(basedOn.mission)}（${escapeHtml(basedOn.missionEn)}）　${escapeHtml(basedOn.date)}　${escapeHtml(basedOn.site)}　方式：${escapeHtml(basedOn.method)}`
      : `${escapeHtml(basedOn.why ?? '尚无真实着陆记录')}　构造方式：${escapeHtml(basedOn.method)}`
    sourceEl.innerHTML = `${badge}<span>${detail}</span>`
  }

  function renderStep() {
    const step = profile.steps[index]
    phaseEl.textContent = step.phase
    elapsedEl.textContent = step.elapsed ?? ''

    const readouts = []
    if (step.altitude && step.altitude !== '—') readouts.push(['高度', step.altitude])
    if (step.speed && step.speed !== '—') readouts.push(['速度', step.speed])
    readoutEl.innerHTML = readouts
      .map(([k, v]) => `<div><span>${k}</span><span>${escapeHtml(v)}</span></div>`)
      .join('')

    textEl.innerHTML = renderText(step.text)

    stepsEl.innerHTML = profile.steps
      .map((_, i) => `<i class="${i < index ? 'is-done' : i === index ? 'is-current' : ''}"></i>`)
      .join('')
  }

  function start(bodyId, profiles, swapCallback) {
    profile = profiles[bodyId]
    if (!profile) return false

    onSwap = swapCallback
    swapped = false
    index = 0
    elapsed = 0
    running = true

    veil.className = `edl-veil style-${profile.veilStyle ?? 'plasma'}`
    veil.style.opacity = '0'
    renderSource()
    renderStep()
    panel.classList.add('is-visible')
    return true
  }

  /**
   * 每帧推进。遮罩不透明度在相邻阶段的 veil 值之间线性插值，
   * 于是「进入 → 峰值加热 → 落地」是一条连续的曲线，不是几次闪烁。
   */
  function update(dt) {
    if (!running || !profile) return

    const step = profile.steps[index]
    const next = profile.steps[index + 1]
    elapsed += dt

    const t = Math.min(1, elapsed / step.hold)
    const from = step.veil ?? 0
    const to = next ? next.veil ?? 0 : 0
    veil.style.opacity = String(from + (to - from) * t)

    // 遮罩接近全不透明的这一步切换场景，切换本身看不见
    if (!swapped && step.swap && t > 0.55) {
      swapped = true
      onSwap?.()
    }

    if (t >= 1) {
      if (index >= profile.steps.length - 1) return finish()
      index++
      elapsed = 0
      renderStep()
    }
  }

  function finish() {
    running = false
    veil.style.opacity = '0'
    panel.classList.remove('is-visible')
    // 万一时序里没标 swap，兜底切换，避免卡在轨道场景
    if (!swapped) {
      swapped = true
      onSwap?.()
    }
  }

  /** 跳过：立即完成剩余阶段 */
  function skip() {
    if (!running) return
    finish()
  }

  function isRunning() {
    return running
  }

  /** 返回轨道用的简单遮罩，不走时序 */
  function fadeOut(style, tint) {
    veil.className = `edl-veil style-${style ?? 'plasma'}`
    if (tint) veil.style.setProperty('--entry-tint', tint)
    panel.classList.remove('is-visible')
  }

  function setVeilOpacity(value) {
    veil.style.opacity = String(value)
  }

  function setTint(tint) {
    veil.style.setProperty('--entry-tint', tint)
  }

  return { start, update, skip, finish, isRunning, setVeilOpacity, setTint, fadeOut }
}
