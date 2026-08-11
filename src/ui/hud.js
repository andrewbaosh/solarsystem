import './hud.css'
import './controls.css'
import * as time from '../core/time.js'
import { SMALL_BODY_BOOST } from '../bodies/smallBodies.js'
import {
  getScaleMode,
  getModeBlend,
  setModeBlend,
  getRadiusExaggeration,
  getSatelliteOrbitScale,
  getDistanceCompressionAt,
  toRealDistance,
} from '../core/scale.js'

const MODE_LABEL = {
  visual: '可视比例 (visual)',
  real: '1:1 真实比例 (real)',
}

const TRANSITION_DURATION = 1.5
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

function panel(className, html = '') {
  const el = document.createElement('div')
  el.className = `hud ${className}`
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

function sci(n, digits = 2) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0'
  if (Math.abs(n) >= 1e5 || Math.abs(n) < 1e-3) return n.toExponential(digits)
  return n.toFixed(digits)
}

function row(label, value, valueClass = 'hud-value') {
  return `<span class="hud-key">${label}</span> <span class="${valueClass}">${value}</span>`
}

export function createHUD({ camera, cameraRig }) {
  const topLeft = panel('hud-top-left')
  const bottomLeft = panel('hud-bottom-left')
  panel(
    'hud-bottom-right',
    [
      '点击天体 聚焦并展开资料    ESC 取消',
      '空格 暂停/继续    [ ] 时间倍率    R 倒放',
      'M 切换尺度模式    L 名称标签    0~8 聚焦',
      '缩放 滚轮 / 触摸板双指上下滑 / + -',
      '旋转 拖动    平移 右键拖动 / 方向键',
    ].join('<br>'),
  )

  // 尺度切换按钮：不直接改模式，而是启动一段混合过渡
  const actions = document.createElement('div')
  actions.className = 'scale-actions'
  actions.innerHTML = `
    <button class="ctl-btn" data-mode="visual">可视比例</button>
    <button class="ctl-btn" data-mode="real">真实比例</button>
  `
  bottomLeft.appendChild(actions)

  let transition = null

  function startScaleTransition(mode) {
    const from = getModeBlend()
    const to = mode === 'real' ? 1 : 0
    if (Math.abs(from - to) < 1e-6) return
    transition = { from, to, elapsed: 0 }
  }

  function toggleScale() {
    startScaleTransition(getModeBlend() >= 0.5 ? 'visual' : 'real')
  }

  actions.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => startScaleTransition(btn.dataset.mode))
  })

  function update(dt = 0) {
    if (transition) {
      transition.elapsed += dt
      const t = Math.min(1, transition.elapsed / TRANSITION_DURATION)
      const e = easeInOutCubic(t)
      setModeBlend(transition.from + (transition.to - transition.from) * e)
      if (t >= 1) transition = null
    }

    const paused = time.isPaused()
    topLeft.innerHTML = [
      row('模拟日期', time.formatDate()),
      row('儒略日  ', time.getJD().toFixed(5)),
      paused ? row('状态    ', '已暂停', 'hud-warn') : row('状态    ', '运行中'),
    ].join('<br>')

    const camDistKm = toRealDistance(camera.position.length())
    const compression = getDistanceCompressionAt(camDistKm)
    const mode = getScaleMode()
    const blend = getModeBlend()

    const readout = [
      row('尺度模式', MODE_LABEL[mode], blend >= 0.5 ? 'hud-warn' : 'hud-value'),
      row('距离压缩比', `×${sci(compression)}   @ 当前视距 ${sci(camDistKm)} km`),
      row('半径放大倍数', `×${sci(getRadiusExaggeration())}`),
      row('卫星轨道系数', `×${sci(getSatelliteOrbitScale())}`),
      row('小天体放大  ', `×${sci(SMALL_BODY_BOOST)}`),
      row('聚焦目标', cameraRig.getFocus()?.data?.name ?? '自由视角'),
    ].join('<br>')

    // 过渡进度条：让「正在变尺度」这件事是看得见的
    const bar = `<div class="hud-bar"><i style="width:${(blend * 100).toFixed(1)}%"></i></div>`

    bottomLeft.replaceChildren()
    bottomLeft.insertAdjacentHTML('afterbegin', readout + bar)
    bottomLeft.appendChild(actions)

    actions.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle(
        'is-active',
        btn.dataset.mode === 'real' ? blend > 0.5 : blend <= 0.5,
      )
    })
  }

  return { update, toggleScale, setScaleMode: startScaleTransition }
}
