import './controls.css'
import * as time from '../core/time.js'

/**
 * 底部时间控制条。
 *
 * 只读全局时间源、只调全局时间源，自己不存任何时间状态 ——
 * 键盘快捷键改了倍率，这里下一帧就会跟着变。
 */

const SLIDER_STEPS = 1000

/** 倍率跨 1 ~ 3.15e7，线性滑块没法用，映射到对数刻度 */
function sliderToSpeed(value) {
  const t = value / SLIDER_STEPS
  return Math.exp(Math.log(time.MIN_SPEED) + t * (Math.log(time.MAX_SPEED) - Math.log(time.MIN_SPEED)))
}

function speedToSlider(speed) {
  const abs = Math.min(time.MAX_SPEED, Math.max(time.MIN_SPEED, Math.abs(speed)))
  const t = (Math.log(abs) - Math.log(time.MIN_SPEED)) / (Math.log(time.MAX_SPEED) - Math.log(time.MIN_SPEED))
  return Math.round(t * SLIDER_STEPS)
}

/** Date → datetime-local 需要的本地时间字符串 */
function toInputValue(date) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${String(date.getUTCFullYear()).padStart(4, '0')}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}:${p(date.getUTCMinutes())}`
  )
}

export function createTimeControls() {
  const bar = document.createElement('div')
  bar.className = 'time-bar'
  bar.innerHTML = `
    <button class="ctl-btn" data-action="playPause" title="暂停 / 播放（空格）">❚❚</button>
    <button class="ctl-btn" data-action="reverse" title="倒放（R）">⇄</button>
    <div class="time-divider"></div>
    <div class="time-speed">
      <input type="range" min="0" max="${SLIDER_STEPS}" step="1" title="时间倍率">
      <span class="time-speed-label"></span>
    </div>
    <div class="time-divider"></div>
    <div class="time-date" title="点击输入任意日期"></div>
    <button class="ctl-btn" data-action="today" title="回到此刻（N）">回到今天</button>
  `
  document.body.appendChild(bar)

  const playPauseBtn = bar.querySelector('[data-action="playPause"]')
  const reverseBtn = bar.querySelector('[data-action="reverse"]')
  const slider = bar.querySelector('input[type="range"]')
  const speedLabel = bar.querySelector('.time-speed-label')
  const dateEl = bar.querySelector('.time-date')

  let editing = false

  playPauseBtn.addEventListener('click', () => time.togglePause())
  reverseBtn.addEventListener('click', () => time.reverse())
  bar.querySelector('[data-action="today"]').addEventListener('click', () => time.setDate(new Date()))

  slider.addEventListener('input', () => {
    const sign = time.getSpeed() < 0 ? -1 : 1
    time.setSpeed(sign * sliderToSpeed(Number(slider.value)))
  })

  // 点击日期 → 就地变成输入框
  dateEl.addEventListener('click', () => {
    if (editing) return
    editing = true
    const input = document.createElement('input')
    input.type = 'datetime-local'
    input.className = 'time-date-input'
    input.step = '1'
    input.value = toInputValue(time.getDate())

    const commit = (apply) => {
      if (apply && input.value) {
        // datetime-local 没有时区，按 UTC 解析，与 HUD 的显示口径一致
        const parsed = new Date(`${input.value}Z`)
        if (!Number.isNaN(parsed.getTime())) time.setDate(parsed)
      }
      input.replaceWith(dateEl)
      editing = false
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit(true)
      if (e.key === 'Escape') commit(false)
      e.stopPropagation() // 别让空格、R 这些快捷键在输入时触发
    })
    input.addEventListener('blur', () => commit(true))

    dateEl.replaceWith(input)
    input.focus()
  })

  function update() {
    const paused = time.isPaused()
    playPauseBtn.textContent = paused ? '▶' : '❚❚'
    playPauseBtn.classList.toggle('is-active', paused)
    reverseBtn.classList.toggle('is-active', time.getSpeed() < 0)

    if (document.activeElement !== slider) slider.value = String(speedToSlider(time.getSpeed()))
    speedLabel.textContent = time.formatSpeed()
    if (!editing) dateEl.textContent = time.formatDate()
  }

  return { update, element: bar, isEditing: () => editing }
}
