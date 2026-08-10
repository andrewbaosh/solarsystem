/**
 * 缓动函数表。
 *
 * 这里刻意**不提供 linear**。匀速直线运动是「机械插值」观感的唯一来源，
 * 章节脚本里写了不认识的名字也会落回 easeInOutCubic，而不是退化成匀速 ——
 * 引擎宁可不听话，也不该让镜头变成匀速推轨。
 *
 * 函数本身是纯的（t ∈ [0,1] → [0,1]），不含任何具体章节的数值。
 */

const EASINGS = {
  // 起步与收尾都软，最通用的一档
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // 比 cubic 更克制，适合本来就短的镜头
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  // 两端几乎停住、中段猛冲，适合「起手一顿，扑过去，再稳住」
  easeInOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - Math.pow(-2 * t + 2, 5) / 2),
  // 最柔的一档，近似正弦摇臂
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  // 起手快、末段长时间缓慢逼近：揭示类镜头
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeOutQuint: (t) => 1 - Math.pow(1 - t, 5),
  // 起手极慢再加速：适合从静止开始的离场
  easeInCubic: (t) => t * t * t,
  easeInQuint: (t) => t ** 5,
  // 冲出去后长时间几乎不动，跨尺度镜头用
  easeOutExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  easeInOutExpo: (t) =>
    t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2,
}

export const DEFAULT_EASING = 'easeInOutCubic'

export const EASING_NAMES = Object.keys(EASINGS)

const warned = new Set()

/** 名字 → 函数；未知名字回落到默认缓动并且只警告一次 */
export function resolveEasing(name) {
  if (name && EASINGS[name]) return EASINGS[name]
  if (name && !warned.has(name)) {
    warned.add(name)
    console.warn(`[tour] 未知的缓动 "${name}"，改用 ${DEFAULT_EASING}`)
  }
  return EASINGS[DEFAULT_EASING]
}
