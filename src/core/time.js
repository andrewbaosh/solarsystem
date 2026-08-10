/**
 * 全局唯一时间源 —— J2000 儒略日。
 *
 * 铁律：自转、公转、UI 日期显示必须全部从这里取时间，
 * 任何模块都不得自己维护一份 simulationTime。
 */

export const J2000_JD = 2451545.0
const UNIX_EPOCH_JD = 2440587.5
const SECONDS_PER_DAY = 86400
const SECONDS_PER_YEAR = 31557600 // 儒略年

/** 时间倍率上下限：1 秒/秒 ~ 1 年/秒 */
export const MIN_SPEED = 1
export const MAX_SPEED = SECONDS_PER_YEAR

/** 倍率预设（单位：模拟秒 / 真实秒） */
export const SPEED_PRESETS = [
  1, // 1 秒/秒
  60, // 1 分/秒
  3600, // 1 时/秒
  SECONDS_PER_DAY, // 1 天/秒
  SECONDS_PER_DAY * 7, // 1 周/秒
  SECONDS_PER_DAY * 30, // 1 月/秒
  SECONDS_PER_YEAR, // 1 年/秒
]

let jd = J2000_JD
let speed = SECONDS_PER_DAY // 模拟秒 / 真实秒
let paused = false

// ---- 时间推进 ------------------------------------------------------------

/** 由主循环每帧调用，dt 是真实经过的秒数 */
export function update(dtSeconds) {
  if (paused || dtSeconds <= 0) return jd
  jd += (dtSeconds * speed) / SECONDS_PER_DAY
  return jd
}

// ---- 读取 ----------------------------------------------------------------

export function getJD() {
  return jd
}

/** 自 J2000 起算的天数，天体运动计算都用这个 */
export function getDaysSinceJ2000() {
  return jd - J2000_JD
}

export function getDate() {
  return new Date((jd - UNIX_EPOCH_JD) * SECONDS_PER_DAY * 1000)
}

export function getSpeed() {
  return speed
}

export function isPaused() {
  return paused
}

// ---- 写入 ----------------------------------------------------------------

export function setJD(nextJD) {
  jd = nextJD
  return jd
}

export function setDate(date) {
  jd = date.getTime() / (SECONDS_PER_DAY * 1000) + UNIX_EPOCH_JD
  return jd
}

/** 倍率支持正负（倒放），绝对值被夹在 [MIN_SPEED, MAX_SPEED] */
export function setSpeed(next) {
  const sign = next < 0 ? -1 : 1
  const abs = Math.min(MAX_SPEED, Math.max(MIN_SPEED, Math.abs(next)))
  speed = sign * abs
  return speed
}

/** 在预设档位之间步进，保持当前的正负方向 */
export function stepSpeed(direction) {
  const sign = speed < 0 ? -1 : 1
  const abs = Math.abs(speed)
  let index = SPEED_PRESETS.findIndex((p) => p >= abs - 1e-9)
  if (index < 0) index = SPEED_PRESETS.length - 1
  const next = Math.min(SPEED_PRESETS.length - 1, Math.max(0, index + direction))
  return setSpeed(sign * SPEED_PRESETS[next])
}

/** 反向播放 */
export function reverse() {
  return setSpeed(-speed)
}

export function setPaused(next) {
  paused = next
  return paused
}

export function togglePause() {
  paused = !paused
  return paused
}

// ---- 显示辅助 ------------------------------------------------------------

export function formatSpeed(value = speed) {
  const sign = value < 0 ? '-' : ''
  const abs = Math.abs(value)
  const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2))

  if (abs < 60) return `${sign}${fmt(abs)} 秒/秒`
  if (abs < 3600) return `${sign}${fmt(abs / 60)} 分/秒`
  if (abs < SECONDS_PER_DAY) return `${sign}${fmt(abs / 3600)} 时/秒`
  if (abs < SECONDS_PER_DAY * 30) return `${sign}${fmt(abs / SECONDS_PER_DAY)} 天/秒`
  if (abs < SECONDS_PER_YEAR) return `${sign}${fmt(abs / (SECONDS_PER_DAY * 30))} 月/秒`
  return `${sign}${fmt(abs / SECONDS_PER_YEAR)} 年/秒`
}

export function formatDate(date = getDate()) {
  if (Number.isNaN(date.getTime())) return '—— 超出可表示范围 ——'
  const p = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')
  const y = date.getUTCFullYear()
  const yearStr = y < 0 ? `前${p(y, 4)}` : p(y, 4)
  return (
    `${yearStr}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ` +
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())} UTC`
  )
}
