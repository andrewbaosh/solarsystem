/**
 * 尺度系统 —— 全项目唯一的「真实物理单位 → 场景单位」换算入口。
 *
 * 铁律：
 *  - 天体数据一律以真实单位（km）存储，只有这里可以做缩放。
 *  - 所有缩放系数都是运行时可变的变量，HUD 必须能读到当前值。
 *
 * 基准（两种模式共用）：
 *   1 场景单位 = KM_PER_SCENE_UNIT 公里
 * 'real' 模式下距离与半径都直接用这个基准，因此比例是严格 1:1 的。
 * 'visual' 模式下：
 *   - 距离走分段压缩曲线（见 DISTANCE_KNOTS）
 *   - 半径统一乘 radiusExaggeration
 */

export const KM_PER_SCENE_UNIT = 1e6 // 1 场景单位 = 100 万公里
export const AU_KM = 149597870.7 // 天文单位，仅用于描述压缩曲线的节点

/**
 * 距离压缩曲线的节点：{ au, unit }。
 * 节点之间在 log(au) - unit 空间做线性插值，于是：
 *  - 内太阳系（<2 AU）保留较大的相对间距，水星不会挤在太阳身上
 *  - 外太阳系被强力压缩，海王星轨道落在 ~390 单位，一屏可见
 * 这些是纯粹的曲线控制点，不是任何具体天体的数据。
 */
const DISTANCE_KNOTS = [
  { au: 0.1, unit: 20 },
  { au: 0.5, unit: 58 },
  { au: 1, unit: 95 },
  { au: 2, unit: 140 },
  { au: 5, unit: 205 },
  { au: 10, unit: 265 },
  { au: 20, unit: 335 },
  { au: 30, unit: 390 },
  { au: 50, unit: 460 },
  { au: 100, unit: 540 },
]

// ---- 运行时可变的系数 ----------------------------------------------------

let targetMode = 'visual' // 'visual' | 'real'
/**
 * 两种模式之间的连续混合系数：0 = 可视比例，1 = 1:1 真实比例。
 * 之所以做成连续量而不是布尔开关：切换尺度时如果所有天体的位置和大小瞬间跳变，
 * 相机要么瞬移要么失焦。让系数在 1 秒多里平滑过内插，星球就是「缩下去」而不是「闪一下」，
 * 相机完全不用动，尺度冲击感反而更直观。
 */
let blend = 0
let radiusExaggeration = 60 // visual 模式下的半径放大倍数
let distanceScale = 1 // visual 模式下压缩曲线的整体倍率

/**
 * 卫星轨道半径的额外系数。
 * 卫星轨道（月球 38 万 km）用行星际那条压缩曲线会缩成一个点，用半径放大倍数
 * 又会大到跨越行星轨道，所以单独给一个系数：先按半径放大倍数放大，再乘这个数。
 * 0.35 是让伽利略卫星刚好落在木星球面之外、又不至于淹掉火星轨道的折中值。
 */
let satelliteOrbitScale = 0.35

// 任何系数变化都会 +1，渲染层据此重建轨道线等派生几何
let revision = 0

// ---- 内部：分段压缩曲线 --------------------------------------------------

function compressAU(au) {
  const first = DISTANCE_KNOTS[0]
  // 最内侧一段用线性，保证 au=0 时结果为 0，且函数连续
  if (au <= first.au) return (au / first.au) * first.unit

  for (let i = 0; i < DISTANCE_KNOTS.length - 1; i++) {
    const a = DISTANCE_KNOTS[i]
    const b = DISTANCE_KNOTS[i + 1]
    if (au <= b.au) {
      const t = (Math.log(au) - Math.log(a.au)) / (Math.log(b.au) - Math.log(a.au))
      return a.unit + t * (b.unit - a.unit)
    }
  }

  // 超出最后一个节点：沿用最后一段的对数斜率继续外推
  const a = DISTANCE_KNOTS[DISTANCE_KNOTS.length - 2]
  const b = DISTANCE_KNOTS[DISTANCE_KNOTS.length - 1]
  const slope = (b.unit - a.unit) / (Math.log(b.au) - Math.log(a.au))
  return b.unit + slope * (Math.log(au) - Math.log(b.au))
}

// ---- 对外的两个转换函数 --------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t

/** 当前生效的半径放大倍数（混合后） */
export function getEffectiveRadiusFactor() {
  return lerp(radiusExaggeration, 1, blend)
}

/** 当前生效的卫星轨道系数（混合后） */
export function getEffectiveSatelliteScale() {
  return lerp(satelliteOrbitScale, 1, blend)
}

/** 真实距离(km) → 场景单位 */
export function toSceneDistance(km) {
  const sign = Math.sign(km)
  const abs = Math.abs(km)
  const real = abs / KM_PER_SCENE_UNIT
  if (blend >= 1) return sign * real
  const visual = compressAU(abs / AU_KM) * distanceScale
  return sign * (blend <= 0 ? visual : lerp(visual, real, blend))
}

/** 真实半径(km) → 场景单位 */
export function toSceneRadius(km) {
  return (km / KM_PER_SCENE_UNIT) * getEffectiveRadiusFactor()
}

/** 卫星轨道半径(km) → 场景单位；real 模式下与其它距离一样是 1:1 */
export function toSceneSatelliteDistance(km) {
  const base = km / KM_PER_SCENE_UNIT
  if (blend >= 1) return base
  const visual = base * radiusExaggeration * satelliteOrbitScale
  return blend <= 0 ? visual : lerp(visual, base, blend)
}

/** 场景单位 → 真实距离(km)，供 HUD / 相机换算用（数值反解，单调函数所以可靠） */
export function toRealDistance(units) {
  if (units <= 0) return 0
  // 直接对 toSceneDistance 二分，混合状态下也成立（它对 km 始终单调递增）
  let lo = 0
  let hi = 1e11 // km，约 670 AU
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2
    if (toSceneDistance(mid) < units) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

// ---- 模式与系数的读写 ----------------------------------------------------

export function getScaleRevision() {
  return revision
}

/** 立即切换（无过渡）。verify 脚本与程序化调用走这条 */
export function setScaleMode(next) {
  if (next !== 'visual' && next !== 'real') {
    throw new Error(`未知的尺度模式: ${next}`)
  }
  targetMode = next
  blend = next === 'real' ? 1 : 0
  revision++
  return targetMode
}

/** 过渡动画每帧调用：0 = 可视比例，1 = 真实比例 */
export function setModeBlend(t) {
  blend = Math.min(1, Math.max(0, t))
  targetMode = blend >= 0.5 ? 'real' : 'visual'
  revision++
  return blend
}

export function getModeBlend() {
  return blend
}

export function getScaleMode() {
  return targetMode
}

export function toggleScaleMode() {
  return setScaleMode(targetMode === 'real' ? 'visual' : 'real')
}

export function setRadiusExaggeration(x) {
  radiusExaggeration = Math.max(1e-6, x)
  revision++
}

export function getRadiusExaggeration() {
  return getEffectiveRadiusFactor()
}

export function setSatelliteOrbitScale(x) {
  satelliteOrbitScale = Math.max(1e-6, x)
  revision++
}

export function getSatelliteOrbitScale() {
  return getEffectiveSatelliteScale()
}

export function setDistanceScale(x) {
  distanceScale = Math.max(1e-6, x)
  revision++
}

export function getDistanceScale() {
  return distanceScale
}

/**
 * 当前距离压缩比：在给定的真实距离处，「1:1 应有的场景尺寸」是「实际场景尺寸」的多少倍。
 * real 模式恒为 1；visual 模式下越往外越大。
 */
export function getDistanceCompressionAt(km) {
  const abs = Math.abs(km)
  if (abs < 1) return 1
  const scene = Math.abs(toSceneDistance(abs))
  if (scene < 1e-12) return 1
  return abs / KM_PER_SCENE_UNIT / scene
}
