#!/usr/bin/env node
/**
 * 生成高精度星历表：npm run ephemeris
 *
 * ── 为什么要有这个脚本 ────────────────────────────────────────────────
 * VSOP87 与 ELP2000 的系数表有上千个数字。这些数字**不能靠记忆写**，
 * 错一位就是静默的错误结果 —— 星球照样在转，只是位置悄悄偏了。
 * 所以这里从权威源下载原始表，机器解析、截断、生成，全程没有人工誊抄。
 *
 * 连 ELP 的辐角多项式常数都是从官方 Fortran 源码里**解析**出来的，
 * 不是抄的。要核对，去看 .cache/ephemeris/elp82b.f。
 * ──────────────────────────────────────────────────────────────────
 *
 * 数据源（均为公开的学术数据）：
 *   VSOP87A  行星日心直角坐标，J2000 黄道系
 *            Bretagnon & Francou (1988)，CDS VI/81
 *   ELP2000-82B  月球地心坐标
 *            Chapront-Touzé & Chapront (1983, 1988)，CDS VI/79
 *
 * 截断策略：按振幅阈值丢弃小项。阈值写在下面，并且会把「丢掉多少项、
 * 残余误差上界是多少」打出来 —— 精度是可以核对的，不是拍脑袋。
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Node 的 fetch 不认 HTTP_PROXY，带上环境变量把自己重新拉起（同 fetch-music.js）
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY
if (proxy && !process.env.NODE_USE_ENV_PROXY) {
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1', NODE_NO_WARNINGS: '1' },
  })
  process.exit(r.status ?? 1)
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CACHE = path.join(ROOT, '.cache/ephemeris')
// 运行时是 fetch 取的，所以要落在 public/ 下按原样发布，而不是 data/（那是构建期 import 的）
const OUT = path.join(ROOT, 'public/ephemeris')

const VSOP_BASE = 'https://cdsarc.cds.unistra.fr/ftp/VI/81/'
const ELP_BASE = 'https://cdsarc.cds.unistra.fr/ftp/VI/79/'

/** VSOP87A 的文件后缀 → 我们的天体 id */
const PLANETS = {
  mer: 'mercury',
  ven: 'venus',
  ear: 'earth',
  mar: 'mars',
  jup: 'jupiter',
  sat: 'saturn',
  ura: 'uranus',
  nep: 'neptune',
}

/**
 * 截断阈值。
 * VSOP87A 的量纲是 AU：1e-8 AU = 1.5 km，远小于任何肉眼或天象判据的需求。
 * ELP 的经纬量纲是角秒、距离是公里：0.002″ 在月球距离上约 3.7 米。
 */
/** 地球要支撑日食判据，单独给紧阈值；其余天体 5e-8 AU ≈ 7.5 km，已经比
 *  Standish 表好几个数量级（木星 400″ 在 5 AU 上是 145 万 km） */
const VSOP_MIN_AU = { earth: 1e-9, _default: 5e-8 }
const ELP_MIN_ARCSEC = 0.002
const ELP_MIN_KM = 0.02

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
}

function fail(msg) {
  console.error(`\n${c.red('✗ ' + msg)}\n`)
  process.exit(1)
}

/** 下载并缓存；.gz 自动解压。重跑时命中缓存，不重复打扰对方服务器 */
async function fetchCached(url, name, { gunzip = false } = {}) {
  const file = path.join(CACHE, name)
  if (existsSync(file) && (await stat(file)).size > 0) {
    console.log(c.dim(`      缓存命中 ${name}`))
    return readFile(file, 'utf8')
  }
  const res = await fetch(url, { headers: { 'user-agent': 'solarsystem-build-ephemeris/1.0' } })
  if (!res.ok) fail(`下载 ${url} 失败：HTTP ${res.status}`)
  const out = createWriteStream(file)
  if (gunzip) await pipeline(Readable.fromWeb(res.body), createGunzip(), out)
  else await pipeline(Readable.fromWeb(res.body), out)
  console.log(c.dim(`      下载 ${name}`))
  return readFile(file, 'utf8')
}

// ---- VSOP87A ---------------------------------------------------------------

/**
 * VSOP87A 是日心**直角**坐标（X/Y/Z，AU），参考系就是 J2000 黄道 ——
 * 与本项目场景所用的坐标系一致，不需要任何岁差换算。
 *
 * 每个项是 A·cos(B + C·t)，t 以儒略千年为单位；变量与 t 的幂次写在段落头里。
 * 头行样例：
 *   VSOP87 VERSION A1    EARTH     VARIABLE 1 (XYZ)       *T**0    843 TERMS ...
 */
function parseVsop(text, id) {
  const series = [[], [], []] // X / Y / Z，每个是按幂次分组的数组
  let variable = -1
  let power = -1
  let total = 0
  let kept = 0
  let dropped = 0

  for (const line of text.split('\n')) {
    if (line.includes('VSOP87')) {
      const v = /VARIABLE\s+(\d)/.exec(line)
      const p = /\*T\*\*(\d)/.exec(line)
      if (!v || !p) fail(`${id}: 无法解析段落头 → ${line.trim()}`)
      variable = Number(v[1]) - 1
      power = Number(p[1])
      series[variable][power] ??= []
      continue
    }
    if (!line.trim()) continue
    // 末尾三个数就是 A、B、C（A·cos(B+C·t)）
    const tokens = line.trim().split(/\s+/)
    if (tokens.length < 5) continue
    const A = Number(tokens[tokens.length - 3])
    const B = Number(tokens[tokens.length - 2])
    const C = Number(tokens[tokens.length - 1])
    if (!Number.isFinite(A) || !Number.isFinite(B) || !Number.isFinite(C)) {
      fail(`${id}: 数据行解析失败 → ${line.trim().slice(0, 80)}`)
    }
    total++
    if (Math.abs(A) < (VSOP_MIN_AU[id] ?? VSOP_MIN_AU._default)) {
      dropped += Math.abs(A)
      continue
    }
    kept++
    // 取整到有意义的位数：1e-11 AU = 1.5 米，B/C 是弧度与频率
    series[variable][power].push([+A.toPrecision(11), +B.toFixed(8), +C.toFixed(6)])
  }

  // 被丢掉的项振幅之和，就是截断残余的**上界**（各项同相位时的最坏情况）
  return { series, total, kept, residualAU: dropped }
}

// ---- ELP 2000-82B ----------------------------------------------------------

/**
 * 从官方 Fortran 里解析常数，而不是抄。
 * 这些是月球辐角 W1/W2/W3、地球平黄经 EART、近地点 PERI 的五次多项式，
 * 以及拟合 DE200/LE200 时的常数修正。
 */
function parseElpConstants(fortran) {
  const RAD = 648000 / Math.PI
  const grab = (re, what) => {
    const m = re.exec(fortran)
    if (!m) fail(`elp82b.f 里找不到 ${what}`)
    return m
  }
  /** 形如 w(1,1)=(218+18/c1+59.95571d0/c2)*deg —— 度分秒 */
  const dms = (expr) => {
    const m = grab(new RegExp(`${expr}\\s*=\\s*\\((\\d+)\\+(\\d+)/c1\\+([\\d.]+)d0/c2\\)\\*deg`), expr)
    return (Number(m[1]) + Number(m[2]) / 60 + Number(m[3]) / 3600) * (Math.PI / 180)
  }
  /** 形如 w(1,2)=1732559343.73604d0/rad —— 角秒转弧度 */
  const arcsec = (expr) => {
    // peri(5)=0.d0 这类没有 /rad 后缀，本身就是弧度
    const m = grab(new RegExp(`${expr}\\s*=\\s*([+-]?[\\d.]+)d([+-]?\\d+)?(/rad)?`), expr)
    const v = Number(m[1]) * 10 ** Number(m[2] || 0)
    return m[3] ? v / RAD : v
  }
  const plain = (expr) => {
    const m = grab(new RegExp(`${expr}\\s*=\\s*([+-]?[\\d.]+)d([+-]?\\d+)?(?!/)`), expr)
    return Number(m[1]) * 10 ** Number(m[2] || 0)
  }
  /** 五次多项式：常数项是度分秒，t^1..t^4 的系数是角秒 */
  const poly = (name, row) => {
    const head = row === null ? `${name}\\(1\\)` : `w\\(${row},1\\)`
    const term = (k) => (row === null ? `${name}\\(${k}\\)` : `w\\(${row},${k}\\)`)
    return [dms(head), ...[2, 3, 4, 5].map((k) => arcsec(term(k)))]
  }

  const W = [poly('w', 1), poly('w', 2), poly('w', 3)]
  const EART = poly('eart', null)
  const PERI = poly('peri', null)

  const am = plain('am')
  const alfa = plain('alfa')
  const delnu = Number(grab(/delnu\s*=\s*([+-]?[\d.]+)d0\/rad\/w\(1,2\)/, 'delnu')[1]) / RAD / W[0][1]
  const delnp = Number(grab(/delnp\s*=\s*([+-]?[\d.]+)d0\/rad\/w\(1,2\)/, 'delnp')[1]) / RAD / W[0][1]

  return {
    W,
    EART,
    PERI,
    am,
    alfa,
    dtasm: (2 * alfa) / (3 * am),
    delnu,
    delnp,
    dele: arcsec('dele'),
    delg: arcsec('delg'),
    delep: arcsec('delep'),
    a0: plain('a0'),
    ath: plain('ath'),
    // J2000 惯性系 → 黄道系的岁差旋转系数
    p: [1, 2, 3, 4, 5].map((i) => plain(`p${i}`)),
    q: [1, 2, 3, 4, 5].map((i) => plain(`q${i}`)),
  }
}

/**
 * 主问题级数。Fortran 的读法是 format (4i3,2x,f13.5,6(2x,f10.2))，
 * 定宽切分比按空白切更稳（相邻负数会粘在一起）。
 *
 * 振幅还要做常数修正：
 *   x = A + tgv·(delnp − am·delnu) + c3·delg + c4·dele + c5·delep
 * 距离项（第 3 个文件）先要 A −= 2·A·delnu/3。这段逻辑完全照抄 elp82b.f 的 200 段。
 */
function parseElpSeries(text, which, K) {
  const terms = []
  let total = 0
  let residual = 0
  const lines = text.split('\n')
  const min = which === 2 ? ELP_MIN_KM : ELP_MIN_ARCSEC

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().length < 20) continue
    const ilu = [0, 1, 2, 3].map((k) => Number(line.slice(k * 3, k * 3 + 3)))
    const coef = []
    coef.push(Number(line.slice(14, 27)))
    for (let k = 0; k < 6; k++) coef.push(Number(line.slice(29 + k * 12, 29 + k * 12 + 10)))
    if (ilu.some((v) => !Number.isFinite(v)) || !Number.isFinite(coef[0])) {
      fail(`ELP${which + 1} 第 ${i + 1} 行解析失败：${line.slice(0, 60)}`)
    }
    total++

    let a = coef[0]
    if (which === 2) a = a - (2 * a * K.delnu) / 3
    const tgv = coef[1] + K.dtasm * coef[5]
    const x = a + tgv * (K.delnp - K.am * K.delnu) + coef[2] * K.delg + coef[3] * K.dele + coef[4] * K.delep

    if (Math.abs(x) < min) {
      residual += Math.abs(x)
      continue
    }
    terms.push([x, ...ilu])
  }
  return { terms, total, residual }
}

// ---- 主流程 ---------------------------------------------------------------

async function main() {
  console.log(c.bold('\n高精度星历表'))
  console.log(c.dim('系数全部从权威源下载后机器解析，不存在人工誊抄\n'))
  await mkdir(CACHE, { recursive: true })
  await mkdir(OUT, { recursive: true })

  // ---- VSOP87A ----
  console.log(c.bold('  VSOP87A  行星日心直角坐标（J2000 黄道系）'))
  const planets = {}
  let vsopTerms = 0
  for (const [suffix, id] of Object.entries(PLANETS)) {
    const text = await fetchCached(`${VSOP_BASE}VSOP87A.${suffix}`, `VSOP87A.${suffix}`)
    const { series, total, kept, residualAU } = parseVsop(text, id)
    planets[id] = series
    vsopTerms += kept
    console.log(
      c.dim(
        `      ${id.padEnd(8)} ${String(kept).padStart(4)}/${String(total).padEnd(5)} 项` +
          `　截断残余 < ${(residualAU * 1.496e8).toFixed(1)} km`,
      ),
    )
  }

  // ---- ELP 2000-82B ----
  console.log(c.bold('\n  ELP 2000-82B  月球地心坐标'))
  const fortran = await fetchCached(`${ELP_BASE}elp82b.f.gz`, 'elp82b.f', { gunzip: true })
  const K = parseElpConstants(fortran)
  console.log(c.dim(`      从 elp82b.f 解析出辐角多项式与 ${Object.keys(K).length} 组常数`))

  const moon = { constants: K, series: [] }
  const labels = ['经度(sin)', '纬度(sin)', '距离(cos)']
  let elpTerms = 0
  for (let i = 0; i < 3; i++) {
    const text = await fetchCached(`${ELP_BASE}ELP${i + 1}`, `ELP${i + 1}`)
    const { terms, total, residual } = parseElpSeries(text, i, K)
    moon.series.push(terms)
    elpTerms += terms.length
    const unit = i === 2 ? 'km' : '″'
    console.log(
      c.dim(`      ${labels[i]}  ${String(terms.length).padStart(4)}/${String(total).padEnd(4)} 项　截断残余 < ${residual.toFixed(3)} ${unit}`),
    )
  }

  const meta = {
    _generated: '由 scripts/build-ephemeris.mjs 生成，勿手改',
    vsop87: {
      source: 'Bretagnon P., Francou G. (1988) A&A 202, 309 — VSOP87 version A',
      url: `${VSOP_BASE}`,
      frame: '日心直角坐标，J2000 动力学黄道与春分点，单位 AU',
      truncatedBelowAU: VSOP_MIN_AU,
      note: '截断残余是最坏情况上界（所有被丢项同相位），实际误差远小于此',
    },
    elp2000: {
      source: 'Chapront-Touzé M., Chapront J. (1983, 1988) — ELP 2000-82B',
      url: `${ELP_BASE}`,
      frame: '月球地心直角坐标，J2000 平黄道与惯性春分点，单位 km',
      includes: '仅主问题级数（ELP1–3）。地球形状、潮汐、相对论、行星摄动项未纳入',
      truncatedBelowArcsec: ELP_MIN_ARCSEC,
      truncatedBelowKm: ELP_MIN_KM,
    },
  }

  // 每颗行星单独成文件：运行时按需取，不必为了看土星把水星也下下来
  for (const [id, series] of Object.entries(planets)) {
    await writeFile(path.join(OUT, `vsop87a-${id}.json`), JSON.stringify(series))
  }
  await writeFile(
    path.join(OUT, 'vsop87a.json'),
    JSON.stringify({ _meta: meta.vsop87, planets: Object.keys(planets) }),
  )
  await writeFile(path.join(OUT, 'elp2000.json'), JSON.stringify({ _meta: meta.elp2000, ...moon }))
  await writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')

  const size = async (f) => (await stat(path.join(OUT, f))).size / 1024
  let vsopKB = 0
  for (const id of Object.keys(planets)) vsopKB += await size(`vsop87a-${id}.json`)
  console.log(
    c.green(
      `\n完成：VSOP87A ${vsopTerms} 项（${vsopKB.toFixed(0)} KB，按行星分文件）、` +
        `ELP 主问题 ${elpTerms} 项（${(await size('elp2000.json')).toFixed(0)} KB）\n`,
    ),
  )
  console.log(c.dim(`  地球 ${(await size('vsop87a-earth.json')).toFixed(0)} KB + 月球，是日月食判据真正依赖的两份\n`))
}

main().catch((e) => fail(e.stack ?? e.message))
