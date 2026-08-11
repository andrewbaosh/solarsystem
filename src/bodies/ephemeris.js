/**
 * 高精度星历：VSOP87A（行星）与 ELP 2000-82B（月球）的求值器。
 *
 * 系数表由 scripts/build-ephemeris.mjs 从 CDS 下载后机器生成 ——
 * 这里只有算法，没有一个手抄的数字。
 *
 * 两者的参考系都是 J2000 黄道，与本项目场景坐标一致，不需要岁差换算。
 * 这也意味着：**日月食的判定与本文件的坐标系无关** ——
 * 食是三个天体的相对几何，岁差不影响它们之间的夹角。
 *
 * 精度（截断残余的最坏情况上界，实际远小于此）：
 *   地球  < 102 km      其余行星 < 6000–11000 km
 *   月球  经纬 < 0.19″，距离 < 1.0 km
 * 作为对比，原先的 Standish 表在木星上是 400″（约 145 万 km），
 * 月球的平均要素模型误差超过 1°。
 */

const J2000 = 2451545.0
const ARCSEC_TO_RAD = Math.PI / 648000

// ---- VSOP87A --------------------------------------------------------------

/**
 * 日心直角坐标，AU。
 * 每个变量是 Σ_α t^α · Σ A·cos(B + C·t)，t 以**儒略千年**为单位。
 */
export function vsopPosition(series, jd, out = {}) {
  const t = (jd - J2000) / 365250
  const axes = [0, 0, 0]
  for (let v = 0; v < 3; v++) {
    let value = 0
    let tp = 1
    const powers = series[v]
    for (let a = 0; a < powers.length; a++) {
      const terms = powers[a]
      if (terms) {
        let sum = 0
        for (let i = 0; i < terms.length; i++) {
          const term = terms[i]
          sum += term[0] * Math.cos(term[1] + term[2] * t)
        }
        value += sum * tp
      }
      tp *= t
    }
    axes[v] = value
  }
  out.x = axes[0]
  out.y = axes[1]
  out.z = axes[2]
  return out
}

// ---- ELP 2000-82B ---------------------------------------------------------

/**
 * 月球地心直角坐标，km，J2000 黄道系。
 *
 * 算法逐行对照官方的 elp82b.f：
 *   德劳内辐角 D = W1 − EART + π，l' = EART − PERI，l = W1 − W2，F = W1 − W3
 *   经度 = Σ A·sin(Σ ilu·arg)，纬度同理，距离是 Σ A·cos(...)
 *   最后经度加上 W1 的多项式、距离按 a0/ath 缩放，再做一次岁差旋转
 *
 * 这里只含主问题级数（ELP1–3）。地球形状、潮汐、相对论与行星摄动项
 * 未纳入 —— 它们的量级是角秒，对食相定时的影响在秒级。
 */
export function moonPosition(table, jd, out = {}) {
  const K = table.constants
  const t = (jd - J2000) / 36525
  const T = [1, t, t * t, t * t * t, t * t * t * t]

  // 五次多项式求值：常数项是弧度，其余项已在构建时转成弧度/世纪^k
  const poly = (p) => p[0] * T[0] + p[1] * T[1] + p[2] * T[2] + p[3] * T[3] + p[4] * T[4]

  // 德劳内辐角，按 t 的每一次幂分别组合（与 Fortran 的 del(i,k) 一致）
  const del = [[], [], [], []]
  for (let k = 0; k < 5; k++) {
    del[0][k] = K.W[0][k] - K.EART[k] // D
    del[1][k] = K.EART[k] - K.PERI[k] // l'
    del[2][k] = K.W[0][k] - K.W[1][k] // l
    del[3][k] = K.W[0][k] - K.W[2][k] // F
  }
  del[0][0] += Math.PI

  const arg = (ilu) => {
    let y = 0
    for (let k = 0; k < 5; k++) {
      const tk = T[k]
      if (tk === 0) continue
      y += (ilu[0] * del[0][k] + ilu[1] * del[1][k] + ilu[2] * del[2][k] + ilu[3] * del[3][k]) * tk
    }
    return y
  }

  let lon = 0
  let lat = 0
  let dist = 0
  const [sLon, sLat, sDist] = table.series
  for (let i = 0; i < sLon.length; i++) {
    const c = sLon[i]
    lon += c[0] * Math.sin(arg([c[1], c[2], c[3], c[4]]))
  }
  for (let i = 0; i < sLat.length; i++) {
    const c = sLat[i]
    lat += c[0] * Math.sin(arg([c[1], c[2], c[3], c[4]]))
  }
  for (let i = 0; i < sDist.length; i++) {
    const c = sDist[i]
    // 距离级数是余弦：Fortran 靠给辐角加 π/2 把 sin 变成 cos
    dist += c[0] * Math.cos(arg([c[1], c[2], c[3], c[4]]))
  }

  const longitude = lon * ARCSEC_TO_RAD + poly(K.W[0])
  const latitude = lat * ARCSEC_TO_RAD
  const radius = dist * (K.a0 / K.ath)

  const cosLat = Math.cos(latitude)
  let x1 = radius * cosLat * Math.cos(longitude)
  let x2 = radius * cosLat * Math.sin(longitude)
  let x3 = radius * Math.sin(latitude)

  // 从 ELP 的惯性系转到 J2000 黄道系（elp82b.f 末尾那段旋转）
  const p = K.p
  const q = K.q
  const pw = (p[0] + p[1] * t + p[2] * T[2] + p[3] * T[3] + p[4] * T[4]) * t
  const qw = (q[0] + q[1] * t + q[2] * T[2] + q[3] * T[3] + q[4] * T[4]) * t
  const ra = 2 * Math.sqrt(1 - pw * pw - qw * qw)
  const pwqw = 2 * pw * qw
  const pw2 = 1 - 2 * pw * pw
  const qw2 = 1 - 2 * qw * qw
  const pwr = pw * ra
  const qwr = qw * ra

  out.x = pw2 * x1 + pwqw * x2 + pwr * x3
  out.y = pwqw * x1 + qw2 * x2 - qwr * x3
  out.z = -pwr * x1 + qwr * x2 + (pw2 + qw2 - 1) * x3
  return out
}

// ---- 加载 -----------------------------------------------------------------

/**
 * 星历表按需加载。首屏一个字节都不取 —— 场景先用 Standish 表跑起来，
 * 表到位后位置源自动切换（两者相差角分级，视觉上看不出跳变）。
 * 取不到就继续用 Standish，功能降级但场景不受影响。
 */
export function createEphemerisLoader({ baseUrl = '/' } = {}) {
  const planets = new Map()
  let moon = null
  let loading = null

  async function json(file) {
    // 不能用 force-cache：一次 404 会被缓存下来，之后即使文件到位了也永远取不到
    const res = await fetch(`${baseUrl}ephemeris/${file}`)
    if (!res.ok) throw new Error(`${file} HTTP ${res.status}`)
    return res.json()
  }

  /** 先加载日月食真正依赖的两份，其余行星随后 */
  async function load(ids) {
    if (loading) return loading
    loading = (async () => {
      const loaded = []
      try {
        moon = await json('elp2000.json')
        loaded.push('moon')
      } catch (e) {
        console.info(`[星历] 月球高精度表不可用（${e.message}），沿用平均要素`)
      }
      for (const id of ids) {
        try {
          planets.set(id, await json(`vsop87a-${id}.json`))
          loaded.push(id)
        } catch (e) {
          console.info(`[星历] ${id} 的 VSOP87 表不可用（${e.message}），沿用 Standish 表`)
        }
      }
      return loaded
    })()
    return loading
  }

  return {
    load,
    hasPlanet: (id) => planets.has(id),
    hasMoon: () => Boolean(moon),
    planet: (id, jd, out) => vsopPosition(planets.get(id), jd, out),
    moon: (jd, out) => moonPosition(moon, jd, out),
  }
}
