import './transitions.css'

/**
 * 章节之间的过场。
 *
 * 存在的理由很实际：相邻两章可能隔着好几个天文单位，
 * 硬把镜头插值过去要么慢得没法看，要么快得像瞬移。
 * 过场把「换机位」这件事藏在遮罩后面 —— 和登陆场景切换是同一个思路。
 *
 * 全部是 HTML overlay，不在 canvas 里画。
 * 时间由主循环的 dt 推进，不用 setTimeout，所以掉帧时不会错位。
 */

const PROFILES = {
  flash: { duration: 0.9, peak: 0.45 },
  starfield: { duration: 1.7, peak: 0.55 },
}

const STREAK_COUNT = 220

export function createTransitions() {
  const root = document.createElement('div')
  root.className = 'tour-transition'
  const veil = document.createElement('div')
  veil.className = 'tour-transition-veil'
  const canvas = document.createElement('canvas')
  canvas.className = 'tour-transition-canvas'
  root.append(veil, canvas)
  document.body.appendChild(root)

  const ctx = canvas.getContext('2d')

  // 星流的方向与初始半径固定下来，每次过场复用同一批，避免每帧分配
  const streaks = Array.from({ length: STREAK_COUNT }, (_, i) => {
    const angle = (i / STREAK_COUNT) * Math.PI * 2 + (i % 7) * 0.37
    return { angle, radius: 0.04 + ((i * 97) % 100) / 130, width: 0.6 + ((i * 31) % 30) / 20 }
  })

  let active = null // { kind, elapsed, duration, peak, onPeak, fired }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr))
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr))
  }
  resize()
  window.addEventListener('resize', resize)

  function drawStarfield(p) {
    const w = canvas.width
    const h = canvas.height
    const cx = w / 2
    const cy = h / 2
    const reach = Math.hypot(cx, cy)
    ctx.clearRect(0, 0, w, h)
    // 前段加速冲出，后段留白，条纹长度跟着走
    const speed = p < 0.5 ? p * 2 : 1 - (p - 0.5) * 1.6
    const alpha = Math.sin(Math.PI * Math.min(1, p)) ** 0.7
    ctx.lineCap = 'round'
    for (const s of streaks) {
      const start = s.radius * reach * (1 + p * 2.6)
      const length = reach * (0.05 + speed * 0.42)
      const cos = Math.cos(s.angle)
      const sin = Math.sin(s.angle)
      ctx.beginPath()
      ctx.moveTo(cx + cos * start, cy + sin * start)
      ctx.lineTo(cx + cos * (start + length), cy + sin * (start + length))
      ctx.strokeStyle = `rgba(200, 224, 255, ${(alpha * 0.55).toFixed(3)})`
      ctx.lineWidth = s.width * (window.devicePixelRatio || 1)
      ctx.stroke()
    }
  }

  /**
   * @param kind   none | flash | starfield（未知值当 none）
   * @param onPeak 遮罩最不透明的那一刻回调 —— 换机位就安排在这里
   * @returns 是否真的播了过场
   */
  function play(kind, onPeak) {
    const profile = PROFILES[kind]
    if (!profile) {
      onPeak?.()
      return false
    }
    active = { kind, elapsed: 0, ...profile, onPeak, fired: false }
    root.classList.add('is-active')
    canvas.style.display = kind === 'starfield' ? '' : 'none'
    return true
  }

  function update(dt) {
    if (!active) return
    active.elapsed += dt
    const p = Math.min(1, active.elapsed / active.duration)

    // 遮罩在 peak 处最不透明，两侧收敛
    const opacity =
      p < active.peak ? p / active.peak : 1 - (p - active.peak) / (1 - active.peak)
    veil.style.opacity = String(Math.max(0, opacity) ** 0.8)

    if (active.kind === 'starfield') drawStarfield(p)

    if (!active.fired && p >= active.peak) {
      active.fired = true
      active.onPeak?.()
    }

    if (p >= 1) {
      root.classList.remove('is-active')
      veil.style.opacity = '0'
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
      active = null
    }
  }

  function cancel() {
    if (!active) return
    if (!active.fired) active.onPeak?.()
    active = null
    root.classList.remove('is-active')
    veil.style.opacity = '0'
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  }

  function setTint(color) {
    veil.style.background = color
  }

  return { play, update, cancel, setTint, isPlaying: () => Boolean(active) }
}
