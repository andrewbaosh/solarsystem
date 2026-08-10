/**
 * 自转：轴向取向 + 自转角。
 *
 * 关键点是「自转轴不能简单绕 Y 轴转」——每个天体的自转北极由 IAU 给出的
 * (α0, δ0) 定义在 ICRF 赤道坐标系里，必须先转到黄道坐标系再施加。
 *
 * 方向约定（与 data/planets.json 的 conventions 字段一致）：
 *  - 轴向只来自 (poleRA, poleDec)
 *  - 自转方向只来自 rotationPeriodHours 的符号
 * 两者互不重复。IAU 极点按不变平面定义，所以金星/天王星的极点几乎朝上，
 * 它们的逆行完全体现在周期为负；若再拿 obliquity>90° 去翻一次轴就会翻反。
 */

const DEG = Math.PI / 180

/** J2000 黄赤交角 */
export const ECLIPTIC_OBLIQUITY_DEG = 23.43928

/** ICRF 赤道坐标 → J2000 黄道坐标（绕 x 轴转 -ε） */
export function equatorialToEcliptic(v, epsDeg = ECLIPTIC_OBLIQUITY_DEG) {
  const eps = epsDeg * DEG
  const c = Math.cos(eps)
  const s = Math.sin(eps)
  return {
    x: v.x,
    y: v.y * c + v.z * s,
    z: -v.y * s + v.z * c,
  }
}

/** IAU 自转北极 (α0, δ0) → 黄道坐标系下的单位向量 */
export function poleVectorEcliptic(body) {
  const ra = body.poleRA * DEG
  const dec = body.poleDec * DEG
  const equatorial = {
    x: Math.cos(dec) * Math.cos(ra),
    y: Math.cos(dec) * Math.sin(ra),
    z: Math.sin(dec),
  }
  return equatorialToEcliptic(equatorial)
}

export function rotationPeriodDays(body) {
  return body.rotationPeriodHours / 24
}

export function isRetrograde(body) {
  return body.rotationPeriodHours < 0
}

/**
 * 角速度矢量方向（右手定则）。逆行天体是极点的反方向 ——
 * 教科书上的 obliquity（金星 177.4°、天王星 97.77°）量的就是这个方向。
 */
export function spinAxisEcliptic(body) {
  const p = poleVectorEcliptic(body)
  const sign = isRetrograde(body) ? -1 : 1
  return { x: p.x * sign, y: p.y * sign, z: p.z * sign }
}

function angleBetweenDeg(a, b) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  const la = Math.hypot(a.x, a.y, a.z)
  const lb = Math.hypot(b.x, b.y, b.z)
  return Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) / DEG
}

/** 自转轴相对黄道面的倾角 */
export function obliquityToEclipticDeg(body) {
  return angleBetweenDeg(spinAxisEcliptic(body), { x: 0, y: 0, z: 1 })
}

/** 自转轴相对【自身轨道面】的倾角，即 NASA fact sheet 的 obliquity to orbit */
export function obliquityToOrbitDeg(body, orbitNormal) {
  return angleBetweenDeg(spinAxisEcliptic(body), orbitNormal)
}

/**
 * 自转角 W(t)，弧度。周期为负则角度递减，自转方向自然反向。
 * 没有贴图，所以不引入 IAU 的 W0 本初子午线初值，起始相位取 0。
 */
export function spinAngleAt(body, days) {
  const periodDays = rotationPeriodDays(body)
  if (!periodDays) return 0
  return (days / periodDays) * Math.PI * 2
}

/**
 * 潮汐锁定天体的自转角：让本体的 +X 轴始终指向母天体。
 * dir 是「卫星 → 母天体」的方向，且必须已经变换到本体的自转坐标系里。
 * three.js 中绕 +Y 转 θ 会把 +X 映到 (cosθ, 0, -sinθ)，反解即得下式。
 */
export function tidalLockAngle(dir) {
  return Math.atan2(-dir.z, dir.x)
}
