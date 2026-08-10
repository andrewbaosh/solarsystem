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
  return {
    a: set.a[0] + set.a[1] * T,
    e: set.e[0] + set.e[1] * T,
    I: set.I[0] + set.I[1] * T,
    L: set.L[0] + set.L[1] * T,
    peri: set.peri[0] + set.peri[1] * T,
    node: set.node[0] + set.node[1] * T,
  }
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
