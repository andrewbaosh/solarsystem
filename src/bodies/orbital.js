/**
 * 开普勒轨道计算。
 *
 * 用 JPL/Standish 的近似轨道要素（六要素 + 每世纪变化率）求日心黄道坐标。
 * 本文件是纯数学，不依赖 three.js，也不读取任何具体天体的数值 ——
 * 要素一律由调用方从 data/*.json 传入。
 */

const DEG = Math.PI / 180
export const AU_KM = 149597870.7
export const J2000_JD = 2451545.0

/** 牛顿迭代的默认收敛阈值（弧度） */
export const KEPLER_TOLERANCE = 1e-8

export function centuriesSinceJ2000(jd) {
  return (jd - J2000_JD) / 36525
}

export function daysSinceJ2000(jd) {
  return jd - J2000_JD
}

/** 把角度归一化到 [-180, 180)，平近点角必须先归一化再进牛顿迭代 */
export function normalizeDeg(deg) {
  let d = deg % 360
  if (d >= 180) d -= 360
  if (d < -180) d += 360
  return d
}

/** 线性外推：element = [历元值, 每世纪变化率] */
export function elementsAt(set, T) {
  const v = set.elements
  const r = set.rates
  return {
    a: v.a + r.a * T,
    e: v.e + r.e * T,
    I: v.I + r.I * T,
    L: v.L + r.L * T,
    peri: v.longPeri + r.longPeri * T,
    node: v.longNode + r.longNode * T,
  }
}

/**
 * data/orbital-elements.json 里 planets 是数组（保持 JPL 表的原样，一行一颗），
 * 而场景各处按 id 取用，这里做一次索引。
 */
export function indexById(list) {
  return Object.fromEntries(list.map((item) => [item.id, item]))
}

/**
 * 解开普勒方程 M = E - e·sin(E)（M、E 单位为弧度）。
 * 牛顿迭代：E_{n+1} = E_n + (M - E_n + e·sin E_n) / (1 - e·cos E_n)
 */
export function solveKepler(M, e, tolerance = KEPLER_TOLERANCE, maxIterations = 64) {
  let E = M + e * Math.sin(M) // 一阶近似做初值，小偏心率下几乎已经是解
  let iterations = 0

  for (; iterations < maxIterations; iterations++) {
    const dM = M - (E - e * Math.sin(E))
    const dE = dM / (1 - e * Math.cos(E))
    E += dE
    if (Math.abs(dE) <= tolerance) {
      iterations++
      break
    }
  }

  const residual = Math.abs(M - (E - e * Math.sin(E)))
  return { E, iterations, residual, converged: residual <= tolerance }
}

/**
 * 轨道平面内坐标 → J2000 黄道坐标。
 * ω = ϖ - Ω 是近日点幅角；旋转顺序为 Rz(Ω)·Rx(I)·Rz(ω)。
 */
export function orbitalPlaneToEcliptic(xp, yp, { peri, node, I }, out = {}) {
  const w = (peri - node) * DEG
  const O = node * DEG
  const i = I * DEG
  const cw = Math.cos(w)
  const sw = Math.sin(w)
  const cO = Math.cos(O)
  const sO = Math.sin(O)
  const ci = Math.cos(i)
  const si = Math.sin(i)

  out.x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp
  out.y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp
  out.z = sw * si * xp + cw * si * yp
  return out
}

/** 由偏近点角求轨道平面内坐标（长度单位跟随 a） */
export function planeCoordsFromE(a, e, E) {
  return {
    xp: a * (Math.cos(E) - e),
    yp: a * Math.sqrt(1 - e * e) * Math.sin(E),
  }
}

/**
 * 行星：给定 Standish 要素集与儒略日，返回日心黄道坐标（AU）。
 * 同时把中间量（要素、E、迭代次数）带出来，方便自检脚本核对。
 */
export function heliocentricAU(set, jd, out = {}) {
  const el = elementsAt(set, centuriesSinceJ2000(jd))
  const M = normalizeDeg(el.L - el.peri) * DEG
  const solution = solveKepler(M, el.e)
  const { xp, yp } = planeCoordsFromE(el.a, el.e, solution.E)
  orbitalPlaneToEcliptic(xp, yp, el, out)
  out.elements = el
  out.meanAnomaly = M
  out.eccentricAnomaly = solution.E
  out.solution = solution
  return out
}

export function heliocentricKm(set, jd, out = {}) {
  heliocentricAU(set, jd, out)
  out.x *= AU_KM
  out.y *= AU_KM
  out.z *= AU_KM
  return out
}

/**
 * 卫星：要素以 [历元值, 日变率] 给出，半长轴单位是 km。
 * 返回相对母天体的坐标（km），坐标系由 satellite.frame 决定。
 */
export function satelliteElementsAt(sat, d) {
  return {
    a: sat.aKm,
    e: sat.e,
    I: sat.iDeg,
    L: sat.L[0] + sat.L[1] * d,
    peri: sat.peri[0] + sat.peri[1] * d,
    node: sat.node[0] + sat.node[1] * d,
  }
}

export function satellitePositionKm(sat, jd, out = {}) {
  const el = satelliteElementsAt(sat, daysSinceJ2000(jd))
  const M = normalizeDeg(el.L - el.peri) * DEG
  const solution = solveKepler(M, el.e)
  const { xp, yp } = planeCoordsFromE(el.a, el.e, solution.E)
  orbitalPlaneToEcliptic(xp, yp, el, out)
  out.elements = el
  out.solution = solution
  return out
}

/**
 * 采样一整圈轨道用于画线：均匀取偏近点角 E ∈ [0, 2π)。
 * 因为用的是 x = a(cosE - e)，椭圆的焦点自然落在原点（也就是中心天体所在处），
 * 不需要额外平移。
 */
export function sampleOrbit(elements, segments = 512) {
  const points = []
  for (let i = 0; i < segments; i++) {
    const E = (i / segments) * Math.PI * 2
    const { xp, yp } = planeCoordsFromE(elements.a, elements.e, E)
    points.push(orbitalPlaneToEcliptic(xp, yp, elements))
  }
  return points
}

export function samplePlanetOrbitKm(set, jd, segments = 512) {
  const el = elementsAt(set, centuriesSinceJ2000(jd))
  return sampleOrbit(el, segments).map((p) => ({
    x: p.x * AU_KM,
    y: p.y * AU_KM,
    z: p.z * AU_KM,
  }))
}

export function sampleSatelliteOrbitKm(sat, jd, segments = 256) {
  return sampleOrbit(satelliteElementsAt(sat, daysSinceJ2000(jd)), segments)
}

/** 高斯引力常数，rad·AU^1.5/day —— 由半长轴直接算平均运动 */
export const GAUSS_K = 0.01720209895

/**
 * 双曲线开普勒方程 M = e·sinh(H) − H，牛顿迭代。
 *
 * 星际天体（1I/2I/3I）的偏心率都大于 1，轨道是双曲线：它们从星际空间来，
 * 绕太阳拐一个弯就永远离开，不存在周期。椭圆那套解法在这里完全不适用。
 */
export function solveKeplerHyperbolic(M, e, tolerance = KEPLER_TOLERANCE, maxIterations = 100) {
  // 初值：大 M 时用对数近似，否则从 M/(e−1) 起步，避免 sinh 溢出
  let H = Math.abs(M) > 6 ? Math.sign(M) * Math.log((2 * Math.abs(M)) / e + 1.8) : M / (e - 1)
  let iterations = 0

  for (; iterations < maxIterations; iterations++) {
    const f = e * Math.sinh(H) - H - M
    const df = e * Math.cosh(H) - 1
    const dH = -f / df
    H += dH
    if (Math.abs(dH) <= tolerance) {
      iterations++
      break
    }
  }

  const residual = Math.abs(e * Math.sinh(H) - H - M)
  return { H, iterations, residual, converged: residual <= tolerance }
}

/**
 * 彗星式轨道要素 → 日心黄道坐标（AU）。
 *
 * 与行星用的 Standish 表不同，小天体的标准要素是
 * {e, a 或 q, i, Ω(om), ω(w), 近日点时刻 tp}，相位由「距近日点多久」给出。
 * 椭圆（e<1）与双曲线（e>1）在这里统一处理。
 */
export function cometaryPosition(el, jd, out = {}) {
  const e = el.e
  // 双曲线的 a 为负；只给了 q 时由 q = a(1−e) 反解
  const a = el.a ?? el.q / (1 - e)
  const absA = Math.abs(a)
  const n = GAUSS_K / Math.sqrt(absA * absA * absA) // rad/day
  const dt = jd - el.tp

  let xp
  let yp
  let solution
  if (e < 1) {
    const M = normalizeDeg(((n * dt) / DEG) % 360) * DEG
    solution = solveKepler(M, e)
    xp = a * (Math.cos(solution.E) - e)
    yp = a * Math.sqrt(1 - e * e) * Math.sin(solution.E)
  } else {
    const M = n * dt
    solution = solveKeplerHyperbolic(M, e)
    xp = a * (Math.cosh(solution.H) - e)
    yp = -a * Math.sqrt(e * e - 1) * Math.sinh(solution.H)
  }

  // 复用行星那套旋转：这里的 peri 传 ϖ = Ω + ω，与 node 相减正好还原 ω
  orbitalPlaneToEcliptic(xp, yp, { peri: el.om + el.w, node: el.om, I: el.i }, out)
  out.solution = solution
  out.radiusAU = Math.hypot(out.x, out.y, out.z)
  return out
}

/** 采样彗星/星际天体的轨迹用于画线 */
export function sampleCometaryOrbit(el, jd, segments = 512, spanDays = null) {
  const e = el.e
  const a = el.a ?? el.q / (1 - e)
  const points = []

  if (e < 1) {
    // 椭圆：画完整一圈
    const period = (2 * Math.PI * Math.sqrt(a * a * a)) / GAUSS_K
    for (let i = 0; i < segments; i++) {
      points.push(cometaryPosition(el, el.tp + (i / segments) * period, {}))
    }
    return { points, closed: true }
  }

  // 双曲线：没有周期，只截近日点前后一段可见的弧
  const span = spanDays ?? Math.max(900, Math.sqrt(Math.abs(a) ** 3) * 260)
  for (let i = 0; i <= segments; i++) {
    const t = el.tp + (-0.5 + i / segments) * 2 * span
    points.push(cometaryPosition(el, t, {}))
  }
  return { points, closed: false }
}

/**
 * J2000 黄道坐标 → three.js 场景坐标。
 * 黄道面在场景里是 XZ 平面、Y 轴指向黄北极，且要保持右手系，
 * 于是 (x, y, z)_黄道 → (x, z, -y)_场景。全项目只在这里做这一次轴向约定。
 */
export function eclipticToScene(v, out) {
  return out.set(v.x, v.z, -v.y)
}

/** 轨道面法线（黄道坐标系单位向量），用于核对自转轴相对轨道面的倾角 */
export function orbitNormal({ I, node }) {
  const i = I * DEG
  const O = node * DEG
  return {
    x: Math.sin(i) * Math.sin(O),
    y: -Math.sin(i) * Math.cos(O),
    z: Math.cos(i),
  }
}
