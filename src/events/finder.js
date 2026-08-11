/**
 * 天象搜索器。
 *
 * 做法是「扫描 + 细化」：先用粗步长扫出目标量的极值或过零点所在的区间，
 * 再用黄金分割/二分把时刻收敛到秒级。所有判据都是**几何**的 ——
 * 与坐标系无关，所以不需要岁差章动也能算准食相时刻。
 *
 * 精度的来源是 ephemeris.js 的 VSOP87 + ELP2000；用原来的 Standish 表
 * 也能跑，但月球误差超过 1°，日月食会全错。引擎因此会先问一句
 * provider.precise，不够精确就不给出食相类的结果。
 *
 * 本文件不含任何具体天体的名字或数值 —— 事件定义全部来自 data/events.json。
 */

const DEG = 180 / Math.PI
/** 太阳在 1 AU 处的视半径，角秒 */
const SUN_RADIUS_ARCSEC = 959.63
const AU_KM = 149597870.7
const MOON_RADIUS_KM = 1737.4
const EARTH_RADIUS_KM = 6378.14

const norm = (v) => Math.hypot(v.x, v.y, v.z)
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b))))) * DEG

/** 黄金分割求极小：区间内单峰即可收敛，比三分法省一次求值 */
function minimize(f, a, b, tolDays = 1e-6) {
  const phi = (Math.sqrt(5) - 1) / 2
  let c = b - phi * (b - a)
  let d = a + phi * (b - a)
  let fc = f(c)
  let fd = f(d)
  while (b - a > tolDays) {
    if (fc < fd) {
      b = d
      d = c
      fd = fc
      c = b - phi * (b - a)
      fc = f(c)
    } else {
      a = c
      c = d
      fc = fd
      d = a + phi * (b - a)
      fd = f(d)
    }
  }
  const t = (a + b) / 2
  return { t, value: f(t) }
}

/**
 * 几何量。每个都接受儒略日，返回一个标量 —— 搜索器只认标量的极值。
 * provider 需要提供：sun(jd)、body(id, jd)（都是地心向量，km）
 */
export function createMeasures(provider) {
  const geo = (id, jd) => provider.geocentric(id, jd)

  return {
    /** 地心视角下某天体与太阳的角距（距角） */
    elongation: (jd, { target }) => angle(geo(target, jd), provider.sun(jd)),

    /** 离「冲」还有多远：0 表示正冲 */
    oppositionGap: (jd, { target }) => 180 - angle(geo(target, jd), provider.sun(jd)),

    /** 两个天体的地心角距 */
    separation: (jd, { target, other }) => angle(geo(target, jd), geo(other, jd)),

    /** 地心距离，km */
    distance: (jd, { target }) => norm(geo(target, jd)),

    /** 日心距离，km —— 用来找近日点/远日点 */
    heliocentric: (jd, { target }) => {
      const b = geo(target, jd)
      const s = provider.sun(jd)
      return norm({ x: b.x - s.x, y: b.y - s.y, z: b.z - s.z })
    },

    /**
     * 月球中心到地影轴的距离，以「本影半径」为单位。
     * < 1 表示月面进入本影 —— 月食判据。
     */
    umbraGap: (jd) => {
      const m = geo('moon', jd)
      const s = provider.sun(jd)
      // 影轴方向是背日方向
      const axis = { x: -s.x, y: -s.y, z: -s.z }
      const an = norm(axis)
      const u = { x: axis.x / an, y: axis.y / an, z: axis.z / an }
      const along = dot(m, u)
      const perp = Math.hypot(m.x - u.x * along, m.y - u.y * along, m.z - u.z * along)
      if (along <= 0) return 99 // 月球在朝日一侧，不可能有月食
      const sunDist = an
      // 本影是个圆锥：半径随距离线性收缩。放大 1.02 是大气对地影的经典修正
      const umbra = (EARTH_RADIUS_KM - ((695700 - EARTH_RADIUS_KM) * along) / sunDist) * 1.02
      return perp / (umbra + MOON_RADIUS_KM)
    },
  }
}

/**
 * 日食分类。
 *
 * **不能用地心判据**：月球的地平视差有 0.95°，比食相几何本身还大，
 * 从地心看是偏食的，站在影轴下的人看可能是全食。2024-04-08 那次就是
 * 典型 —— 地心角距 0.349°，日月视半径各约 0.266°，地心判据给出「偏食」，
 * 而它其实是一次著名的全食。
 *
 * 所以这里先求**影轴与地球最接近的那一点**，再从那里算：
 *   影轴 = 过月心、沿背日方向的直线
 *   gamma = 地心到影轴的距离；gamma < R⊕ 时影轴命中地球，是中心食
 * 观测点取影轴在地表的落点（或最接近影轴的地表点），日月视半径与角距
 * 都在那里重新算一遍。
 *
 * 仍然要说清楚：这给出的是**食的类型**（全 / 环 / 偏），不是食带。
 * 算「哪里能看到、持续多久」需要贝塞尔要素，本项目没做。
 */
export function classifySolarEclipse(provider, jd) {
  const M = provider.geocentric('moon', jd)
  const S = provider.sun(jd)

  // 影轴方向：从太阳指向月球，再延伸到地球
  const d = { x: M.x - S.x, y: M.y - S.y, z: M.z - S.z }
  const dn = norm(d)
  const a = { x: d.x / dn, y: d.y / dn, z: d.z / dn }

  // 地心到影轴的垂足
  const k = dot(M, a)
  const foot = { x: M.x - a.x * k, y: M.y - a.y * k, z: M.z - a.z * k }
  const gamma = norm(foot)

  let obs
  if (gamma < EARTH_RADIUS_KM) {
    // 影轴命中地球：观测点取影轴与地表的交点（朝向月球那一侧）
    const back = Math.sqrt(EARTH_RADIUS_KM * EARTH_RADIUS_KM - gamma * gamma)
    obs = { x: foot.x - a.x * back, y: foot.y - a.y * back, z: foot.z - a.z * back }
  } else {
    // 没命中：取地表上最接近影轴的点
    const f = EARTH_RADIUS_KM / gamma
    obs = { x: foot.x * f, y: foot.y * f, z: foot.z * f }
  }

  const m = { x: M.x - obs.x, y: M.y - obs.y, z: M.z - obs.z }
  const s = { x: S.x - obs.x, y: S.y - obs.y, z: S.z - obs.z }
  const rMoon = Math.asin(MOON_RADIUS_KM / norm(m)) * DEG
  const rSun = SUN_RADIUS_ARCSEC / 3600 / (norm(s) / AU_KM)
  const sep = angle(m, s)

  if (sep > rSun + rMoon) return null
  if (sep < Math.abs(rMoon - rSun)) return rMoon >= rSun ? 'total' : 'annular'
  return 'partial'
}

/** 月食分类：本影内多深 */
export function classifyLunarEclipse(provider, jd) {
  const m = provider.geocentric('moon', jd)
  const s = provider.sun(jd)
  const axis = { x: -s.x, y: -s.y, z: -s.z }
  const an = norm(axis)
  const u = { x: axis.x / an, y: axis.y / an, z: axis.z / an }
  const along = dot(m, u)
  if (along <= 0) return null
  const perp = Math.hypot(m.x - u.x * along, m.y - u.y * along, m.z - u.z * along)
  const umbra = (EARTH_RADIUS_KM - ((695700 - EARTH_RADIUS_KM) * along) / an) * 1.02
  const penumbra = (EARTH_RADIUS_KM + ((695700 + EARTH_RADIUS_KM) * along) / an) * 1.02
  if (perp < umbra - MOON_RADIUS_KM) return 'total'
  if (perp < umbra + MOON_RADIUS_KM) return 'partial'
  if (perp < penumbra + MOON_RADIUS_KM) return 'penumbral'
  return null
}

/**
 * 在 [from, to] 区间里搜索某一类事件。
 *
 * @param spec   来自 data/events.json 的事件定义
 * @param limit  最多返回几条，防止扫一千年时把内存塞满
 */
export function findEvents({ provider, measures, spec, from, to, limit = 40 }) {
  const measure = measures[spec.measure]
  if (!measure) throw new Error(`未知的几何量 ${spec.measure}`)
  const f = (jd) => measure(jd, spec)
  const sign = spec.extremum === 'max' ? -1 : 1
  const g = (jd) => sign * f(jd)

  const step = spec.scanStepDays ?? 1
  const results = []
  let prev2 = g(from)
  let prev1 = g(from + step)

  for (let t = from + 2 * step; t <= to && results.length < limit; t += step) {
    const cur = g(t)
    // 中间那个采样是三点里最小的 → 区间内有极小
    if (prev1 < prev2 && prev1 < cur) {
      const { t: tMin, value } = minimize(g, t - 2 * step, t, 1 / 86400)
      const actual = sign * value
      const pass =
        spec.maxValue === undefined ? true : spec.extremum === 'max' ? actual >= spec.maxValue : actual <= spec.maxValue
      if (pass) results.push({ jd: tMin, value: actual, spec })
    }
    prev2 = prev1
    prev1 = cur
  }
  return results
}
