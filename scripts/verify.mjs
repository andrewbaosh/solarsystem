/**
 * 阶段 1 验收脚本：npm run verify
 *
 * 全部走真实代码路径（bodySystem / orbital / rotation），不复制一份平行实现，
 * 这样脚本通过就意味着场景里跑的也是同一套结果。
 */
import * as THREE from 'three'
import { readFileSync } from 'node:fs'

import planetsData from '../data/planets.json' with { type: 'json' }
import orbitalElements from '../data/orbital-elements.json' with { type: 'json' }
import satellitesData from '../data/satellites.json' with { type: 'json' }
import smallBodiesData from '../data/small-bodies.json' with { type: 'json' }
import tourData from '../data/tour.json' with { type: 'json' }
import epigraphs from '../data/epigraphs.json' with { type: 'json' }

import {
  heliocentricAU,
  solveKepler,
  orbitNormal,
  elementsAt,
  centuriesSinceJ2000,
  AU_KM,
  J2000_JD,
  KEPLER_TOLERANCE,
  indexById,
} from '../src/bodies/orbital.js'
import {
  poleVectorEcliptic,
  obliquityToOrbitDeg,
  obliquityToEclipticDeg,
  spinAngleAt,
  isRetrograde,
} from '../src/bodies/rotation.js'
import { createBodySystem } from '../src/bodies/bodySystem.js'
import { toSceneDistance } from '../src/core/scale.js'
import { EASING_NAMES } from '../src/tour/easing.js'

const DEG = 180 / Math.PI
let failures = 0

function jdFromUTC(iso) {
  return new Date(iso).getTime() / 86400000 + 2440587.5
}
function utcFromJD(jd) {
  return new Date((jd - 2440587.5) * 86400000).toISOString().replace('.000Z', 'Z')
}
function check(label, ok, detail) {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` —— ${detail}` : ''}`)
  if (!ok) failures++
}
function heading(text) {
  console.log(`\n\x1b[1m${text}\x1b[0m`)
}

const el = indexById(orbitalElements.planets)
const pos = (id, jd) => heliocentricAU(el[id], jd)
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const len = (v) => Math.hypot(v.x, v.y, v.z)
const angleDeg = (a, b) =>
  Math.acos(Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y + a.z * b.z) / (len(a) * len(b))))) * DEG
const eclipticLon = (v) => Math.atan2(v.y, v.x) * DEG
const eclipticLat = (v) => Math.asin(v.z / len(v)) * DEG
const wrap180 = (d) => {
  let x = d % 360
  if (x > 180) x -= 360
  if (x < -180) x += 360
  return x
}

/**
 * 求「黄经累计走满 360°」所需的时间：逐步解缠累加，再线性插值定位。
 * 用累计角而不是判等，避免落在采样点之间时找不到。
 */
function findLongitudeReturn(positionAt, t0, step = 0.2, maxSpan = 100000, turns = 1) {
  const target = 360 * turns
  let prev = eclipticLon(positionAt(t0))
  let acc = 0
  for (let t = t0 + step; t < t0 + maxSpan; t += step) {
    const cur = eclipticLon(positionAt(t))
    const delta = wrap180(cur - prev)
    if (acc + delta >= target) {
      // 在 [t-step, t] 内线性插值到恰好 target
      return t - step + (step * (target - acc)) / delta
    }
    acc += delta
    prev = cur
  }
  return null
}

// ---------------------------------------------------------------- 1. 开普勒方程
heading('1. 开普勒方程求解')
{
  let worst = 0
  let worstIter = 0
  for (const id of Object.keys(el)) {
    for (let year = 1800; year <= 2050; year += 10) {
      const jd = jdFromUTC(`${year}-01-01T00:00:00Z`)
      const r = heliocentricAU(el[id], jd)
      worst = Math.max(worst, r.solution.residual)
      worstIter = Math.max(worstIter, r.solution.iterations)
    }
  }
  check(
    `1800–2050 全行星残差 |M-(E-e·sinE)| ≤ ${KEPLER_TOLERANCE}`,
    worst <= KEPLER_TOLERANCE,
    `最大残差 ${worst.toExponential(2)} rad，最多 ${worstIter} 次迭代`,
  )
  const hard = solveKepler(0.3, 0.9)
  check(
    '高偏心率 e=0.9 仍收敛',
    hard.converged,
    `${hard.iterations} 次迭代，残差 ${hard.residual.toExponential(2)}`,
  )
}

// ------------------------------------------------- 2. 2003 年火星大冲
heading('2. 2003-08-28 火星大冲（近 6 万年最近一次）')
{
  const jd = jdFromUTC('2003-08-28T00:00:00Z')
  const earth = pos('earth', jd)
  const mars = pos('mars', jd)
  const toSun = { x: -earth.x, y: -earth.y, z: -earth.z }
  const toMars = sub(mars, earth)
  const sunEarthMars = angleDeg(toSun, toMars)
  const distAU = len(toMars)

  // 「冲」的定义是地心黄经相差 180°。火星轨道倾角 1.85°，2003 年这次冲又恰好
  // 发生在火星远离黄道面的位置，因此三维张角会比 180° 小几度 —— 这是真实现象，
  // 不是算错：当时火星的地心黄纬约 -6.6°，是那次大冲「特别偏南」的原因。
  // 08-28 00:00 UTC 距真正的冲还差 18 小时，所以留 1.5° 余量；精确时刻由下面的扫描定位
  const lonDiff = Math.abs(wrap180(eclipticLon(toMars) - eclipticLon(toSun)))
  check(
    '2003-08-28 当天 日–地–火 接近共线（地心黄经差 → 180°）',
    Math.abs(180 - lonDiff) < 1.5,
    `当日 00:00 UTC 黄经差 ${lonDiff.toFixed(3)}°；三维张角 ${sunEarthMars.toFixed(3)}°，差额来自火星当时的地心黄纬 ${eclipticLat(toMars).toFixed(2)}°`,
  )
  check(
    '地火距离接近 0.3727 AU',
    Math.abs(distAU - 0.3727) < 0.005,
    `实测 ${distAU.toFixed(5)} AU = ${(distAU * AU_KM / 1e6).toFixed(2)} 百万 km（历史值 0.37272 AU / 55.76 百万 km）`,
  )

  // 扫描全年找最近点与真正的冲，比单点更有说服力
  let best = { d: Infinity }
  let opposition = { diff: Infinity }
  for (let t = jdFromUTC('2003-07-01T00:00:00Z'); t < jdFromUTC('2003-10-01T00:00:00Z'); t += 1 / 48) {
    const e = pos('earth', t)
    const m = pos('mars', t)
    const d = len(sub(m, e))
    const lon = Math.abs(wrap180(eclipticLon(sub(m, e)) - eclipticLon({ x: -e.x, y: -e.y, z: -e.z })))
    if (d < best.d) best = { d, t }
    if (Math.abs(180 - lon) < opposition.diff) opposition = { diff: Math.abs(180 - lon), t, ang: lon }
  }
  check(
    '最近距离出现在 2003-08-27 前后',
    Math.abs(best.t - jdFromUTC('2003-08-27T09:51:00Z')) < 0.5,
    `实测最近 ${utcFromJD(best.t)}，距离 ${(best.d * AU_KM / 1e6).toFixed(2)} 百万 km（史实 2003-08-27 09:51 UTC）`,
  )
  check(
    '冲（黄经差最接近 180°）出现在 2003-08-28 前后',
    Math.abs(opposition.t - jdFromUTC('2003-08-28T17:59:00Z')) < 0.5,
    `实测 ${utcFromJD(opposition.t)}，张角 ${opposition.ang.toFixed(4)}°（史实 2003-08-28 17:59 UTC）`,
  )
}

// ------------------------------------------------------------ 3. 地球恒星年
heading('3. 地球公转周期 = 恒星年 365.256 天')
{
  for (const startISO of ['2000-01-01T12:00:00Z', '1899-07-04T00:00:00Z', '2035-11-20T00:00:00Z']) {
    const t0 = jdFromUTC(startISO)
    const period = findLongitudeReturn((t) => pos('earth', t), t0, 0.05, 500)
    check(
      `自 ${startISO.slice(0, 10)} 起绕行一整圈`,
      period !== null && Math.abs(period - t0 - 365.256) < 0.01,
      period === null ? '未找到' : `${(period - t0).toFixed(4)} 天（恒星年 365.2564 天）`,
    )
  }
}

// ------------------------------------------------- 4. 自转轴取向与自转方向
heading('4. 自转轴取向与自转方向')
{
  for (const body of planetsData.bodies) {
    if (!el[body.id]) continue
    const normal = orbitNormal(elementsAt(el[body.id], 0))
    const measured = obliquityToOrbitDeg(body, normal)
    const stated = body.obliquityDeg
    check(
      `${body.name} 自转轴相对自身轨道面 ${stated}°`,
      Math.abs(measured - stated) < 0.35,
      `由 IAU 极点 (α0=${body.poleRA}°, δ0=${body.poleDec}°) 算得 ${measured.toFixed(3)}°，相对黄道面 ${obliquityToEclipticDeg(body).toFixed(3)}°`,
    )
  }

  const uranus = planetsData.bodies.find((b) => b.id === 'uranus')
  const uranusTiltFromEcliptic = obliquityToEclipticDeg(uranus)
  check(
    '天王星是「躺着滚」的（自转轴与黄道面夹角 < 10°）',
    Math.abs(90 - uranusTiltFromEcliptic) < 10,
    `自转轴偏离黄道面仅 ${Math.abs(90 - uranusTiltFromEcliptic).toFixed(2)}°，几乎躺平`,
  )

  const spinPerDay = (b) => (spinAngleAt(b, 1) - spinAngleAt(b, 0)) * DEG
  const venus = planetsData.bodies.find((b) => b.id === 'venus')
  const earth = planetsData.bodies.find((b) => b.id === 'earth')
  check(
    '金星自转方向与地球相反',
    Math.sign(spinPerDay(venus)) === -Math.sign(spinPerDay(earth)),
    `金星 ${spinPerDay(venus).toFixed(3)}°/天，地球 ${spinPerDay(earth).toFixed(2)}°/天`,
  )
  check(
    '金星自转周期 243.02 天且为负值',
    venus.rotationPeriodHours < 0 && Math.abs(venus.rotationPeriodHours / 24 + 243.02) < 0.01,
    `${venus.rotationPeriodHours} 小时 = ${(venus.rotationPeriodHours / 24).toFixed(2)} 天`,
  )
  const retro = planetsData.bodies.filter(isRetrograde).map((b) => b.name)
  check('逆行自转的只有金星和天王星', retro.length === 2, retro.join('、'))
}

// ------------------------------------------------------------ 5. 轨道形状
heading('5. 轨道形状：椭圆、太阳在焦点、按倾角倾斜')
{
  const mercury = elementsAt(el.mercury, 0)
  const periAU = mercury.a * (1 - mercury.e)
  const aphAU = mercury.a * (1 + mercury.e)
  const periScene = toSceneDistance(periAU * AU_KM)
  const aphScene = toSceneDistance(aphAU * AU_KM)
  check(
    `水星 e=${mercury.e.toFixed(3)}，近日点/远日点在场景里明显不等距`,
    aphScene - periScene > 5,
    `近日点 ${periScene.toFixed(1)} 单位 / 远日点 ${aphScene.toFixed(1)} 单位，相差 ${(aphScene - periScene).toFixed(1)} 单位（${(periAU).toFixed(3)}–${aphAU.toFixed(3)} AU）`,
  )

  const inclinations = Object.entries(el).map(([id, set]) => ({
    id,
    I: elementsAt(set, 0).I,
  }))
  const distinct = inclinations.filter((p) => Math.abs(p.I) > 0.5).length
  check(
    '各行星轨道面不共面',
    distinct >= 6,
    inclinations.map((p) => `${p.id} ${p.I.toFixed(2)}°`).join('  '),
  )
}

// -------------------------------------------------- 6. 卫星与潮汐锁定（真实场景）
heading('6. 卫星系统（跑真实 bodySystem）')
{
  const scene = new THREE.Scene()
  const system = createBodySystem(scene, {
    planets: planetsData.bodies,
    elements: el,
    satellites: satellitesData.satellites,
  })

  const moon = system.get('moon')
  const earthBody = system.get('earth')
  const jupiter = system.get('jupiter')

  const built = system.bodies.filter((b) => b.kind === 'satellite').map((b) => b.data.id)
  const required = ['moon', 'io', 'europa', 'ganymede', 'callisto', 'titan']
  check(
    '月球 + 四颗伽利略卫星 + 土卫六已建立',
    required.every((id) => built.includes(id)),
    system.bodies.filter((b) => b.kind === 'satellite').map((b) => b.data.name).join('、'),
  )

  /**
   * 潮汐锁定要测的是「同一面朝向母天体」，也就是次天体点的【经度】不变。
   * 不能直接量本体 +X 与母天体方向的三维夹角：月球自转轴相对其轨道面倾斜 6.7°，
   * 地球方向本来就会周期性地跑到月球赤道面上下方（天平动的纬度分量），
   * 那个偏差是真实的，不是锁定失效。所以先投影到本体赤道面再量。
   */
  const inBodyFrame = new THREE.Vector3()
  const moonWorld = new THREE.Vector3()
  const parentWorld = new THREE.Vector3()
  const inverseMesh = new THREE.Quaternion()
  let worstLon = 0
  let worstLat = 0
  for (let d = 0; d < 400; d += 3.7) {
    system.update(J2000_JD + d)
    scene.updateMatrixWorld(true)
    moon.mesh.getWorldPosition(moonWorld)
    earthBody.group.getWorldPosition(parentWorld)
    inBodyFrame.subVectors(parentWorld, moonWorld).normalize()
    // 转到月球本体坐标系：本体 +X 是「正对地球」的那一面
    moon.mesh.getWorldQuaternion(inverseMesh).invert()
    inBodyFrame.applyQuaternion(inverseMesh)
    // 赤道面内的经度偏差（绕自转轴 +Y）
    worstLon = Math.max(worstLon, Math.abs(Math.atan2(-inBodyFrame.z, inBodyFrame.x) * DEG))
    worstLat = Math.max(worstLat, Math.abs(Math.asin(inBodyFrame.y) * DEG))
  }
  check(
    '月球潮汐锁定：次地点经度恒定（400 天采样）',
    worstLon < 0.01,
    `经度最大偏差 ${worstLon.toExponential(2)}°；纬度分量 ${worstLat.toFixed(2)}°（= 自转轴相对轨道面的倾角，真实天平动）`,
  )

  // 恒星月：月球相对母天体的黄经走满 360°
  // localKm 已经是黄道坐标系下的「相对地球」位置（km），直接取黄经
  const moonLongitudeAt = (jd) => {
    system.update(jd)
    return { x: moon.localKm.x, y: moon.localKm.y, z: moon.localKm.z }
  }
  // 单圈会受中心差影响（e=0.055 时真黄经速率有 ±13% 起伏），取 200 圈平均看平均恒星月
  const oneTurn = findLongitudeReturn(moonLongitudeAt, J2000_JD, 0.02, 60)
  const manyTurns = findLongitudeReturn(moonLongitudeAt, J2000_JD, 0.02, 6000, 200)
  const meanMonth = manyTurns === null ? null : (manyTurns - J2000_JD) / 200
  check(
    '月球平均恒星月 ≈ 27.3216 天',
    meanMonth !== null && Math.abs(meanMonth - 27.32158) < 0.005,
    `200 圈平均 ${meanMonth?.toFixed(5)} 天；单圈 ${(oneTurn - J2000_JD).toFixed(4)} 天（单圈与平均的差来自中心差，属真实效应）`,
  )

  /**
   * 伽利略卫星的拉普拉斯共振不是周期严格 1:2:4（实际是 1 : 2.007 : 4.044），
   * 真正严格成立的是平均运动之间的关系 n₁ - 3n₂ + 2n₃ = 0。
   */
  const meanMotion = (id) => satellitesData.satellites.find((s) => s.id === id).L[1]
  const laplace = meanMotion('io') - 3 * meanMotion('europa') + 2 * meanMotion('ganymede')
  check(
    '伽利略卫星满足拉普拉斯共振 n₁-3n₂+2n₃ = 0',
    Math.abs(laplace) < 1e-3,
    `实测 ${laplace.toExponential(2)} °/天；周期 ${(360 / meanMotion('io')).toFixed(4)} / ${(360 / meanMotion('europa')).toFixed(4)} / ${(360 / meanMotion('ganymede')).toFixed(4)} 天`,
  )

  // 伽利略卫星轨道面应该跟着木星赤道倾斜，而不是躺在黄道面上
  system.update(J2000_JD)
  scene.updateMatrixWorld(true)
  const ioBody = system.get('io')
  const jupiterPole = new THREE.Vector3(0, 1, 0).applyQuaternion(
    ioBody.frame.getWorldQuaternion(new THREE.Quaternion()),
  )
  check(
    '伽利略卫星轨道面对齐木星赤道面（而非黄道面）',
    jupiterPole.angleTo(new THREE.Vector3(0, 1, 0)) * DEG > 1,
    `轨道面法线偏离黄道法线 ${(jupiterPole.angleTo(new THREE.Vector3(0, 1, 0)) * DEG).toFixed(2)}°（木星转轴倾角 ${jupiter.data.obliquityDeg}°）`,
  )
}

// ------------------------------------------------------------------ JPL 对账
/**
 * 把 JPL 表里同一批数值再抄一份放在这里当**期望值**，核对运行时数据没有漂移。
 * 这是测试夹具，不是第二个数据源 —— 场景永远只读 data/*.json。
 */
{
  heading('与 JPL 表对账（自转、卫星、半径口径）')

  // 周期取绝对值比较：本项目用「极点 + 周期符号」表达自转方向，
  // JPL 那张表用「正周期 + 倾角 > 90°」，两种约定都对，但不能混用
  const JPL_ROTATION = {
    sun: [609.12, 7.25], mercury: [1407.6, 0.034], venus: [5832.5, 177.36],
    earth: [23.9345, 23.44], mars: [24.6229, 25.19], jupiter: [9.925, 3.13],
    saturn: [10.656, 26.73], uranus: [17.24, 97.77], neptune: [16.11, 28.32],
  }
  const rotationBad = []
  for (const [id, [hours, tilt]] of Object.entries(JPL_ROTATION)) {
    const b = planetsData.bodies.find((x) => x.id === id)
    if (!b) { rotationBad.push(`${id} 不存在`); continue }
    if (Math.abs(Math.abs(b.rotationPeriodHours) - hours) > 0.01) {
      rotationBad.push(`${id} 周期 ${b.rotationPeriodHours}h ≠ ${hours}h`)
    }
    if (Math.abs(b.obliquityDeg - tilt) > 0.01) {
      rotationBad.push(`${id} 倾角 ${b.obliquityDeg}° ≠ ${tilt}°`)
    }
  }
  check('自转周期与转轴倾角与 JPL 一致', rotationBad.length === 0, rotationBad.join('；') || '9 个天体全部相符')

  // 两种约定禁止重复计数：负周期的天体，其 IAU 极点必须几乎朝上（倾角 < 90°），
  // 否则「负号」和「倒立的极点」会互相抵消，天体会朝反方向自转
  const doubleCounted = planetsData.bodies.filter((b) => {
    if (!(b.rotationPeriodHours < 0)) return false
    const pole = poleVectorEcliptic(b)
    return pole.z < 0 // 极点朝下 + 负周期 = 翻了两次
  })
  check(
    '逆行天体没有「负周期 + 倒立极点」重复计数',
    doubleCounted.length === 0,
    doubleCounted.map((b) => b.id).join(', ') ||
      planetsData.bodies
        .filter((b) => b.rotationPeriodHours < 0)
        .map((b) => `${b.id} 极点 z=${poleVectorEcliptic(b).z.toFixed(4)}（朝上）`)
        .join('；'),
  )

  // 卫星：半长轴 / 离心率 / 倾角 / 恒星周期（周期由 L 的变化率反解）
  const JPL_SATELLITES = {
    moon: [384400, 0.0549, 5.145, 27.321661],
    io: [421800, 0.0041, 0.036, 1.769138],
    europa: [671100, 0.0094, 0.466, 3.551181],
    ganymede: [1070400, 0.0013, 0.177, 7.154553],
    callisto: [1882700, 0.0074, 0.192, 16.689017],
  }
  const satBad = []
  for (const [id, [aKm, e, iDeg, period]] of Object.entries(JPL_SATELLITES)) {
    const sat = satellitesData.satellites.find((x) => x.id === id)
    if (!sat) { satBad.push(`${id} 不存在`); continue }
    if (sat.aKm !== aKm) satBad.push(`${id} a=${sat.aKm} ≠ ${aKm} km`)
    if (Math.abs(sat.e - e) > 1e-6) satBad.push(`${id} e=${sat.e} ≠ ${e}`)
    if (Math.abs(sat.iDeg - iDeg) > 1e-4) satBad.push(`${id} i=${sat.iDeg}° ≠ ${iDeg}°`)
    const derived = 360 / sat.L[1]
    if (Math.abs(derived - period) > 1e-3) {
      satBad.push(`${id} 周期 ${derived.toFixed(6)} ≠ ${period} 天`)
    }
  }
  check('卫星要素与 JPL 一致（周期由 L 的变化率反解）', satBad.length === 0, satBad.join('；') || '5 颗卫星全部相符')

  // 半径是两个不同的口径，本来就不该相等 —— 检查差值落在已知范围内，
  // 免得日后有人拿赤道半径「顺手修正」掉体积平均半径
  // 近球天体（含太阳）直接比对；扁的那几颗只能比口径差
  const JPL_SPHERICAL = { sun: 695700, mercury: 2439.7, venus: 6051.8 }
  const sphericalBad = Object.entries(JPL_SPHERICAL).filter(
    ([id, r]) => planetsData.bodies.find((x) => x.id === id).radiusKm !== r,
  )
  check(
    '近球天体半径与 JPL 一致（太阳用 IAU 2015 B3 名义半径）',
    sphericalBad.length === 0,
    sphericalBad.map(([id, r]) => `${id} ≠ ${r}`).join('；') || '太阳、水星、金星相符',
  )

  const JPL_EQUATORIAL = { jupiter: 71492, saturn: 60268, earth: 6378.1, mars: 3396.2 }
  const flattening = Object.entries(JPL_EQUATORIAL).map(([id, eq]) => {
    const mean = planetsData.bodies.find((x) => x.id === id).radiusKm
    return `${id} ${((eq / mean - 1) * 100).toFixed(2)}%`
  })
  check(
    '半径用的是体积平均半径，比 JPL 赤道半径小（扁率所致）',
    Object.entries(JPL_EQUATORIAL).every(([id, eq]) => {
      const mean = planetsData.bodies.find((x) => x.id === id).radiusKm
      return mean < eq && eq / mean - 1 < 0.05
    }),
    `赤道 / 平均 之差：${flattening.join('，')}`,
  )
}

// ------------------------------------------------------------------ 导览脚本
{
  heading('导览脚本 data/tour.json')

  const knownIds = new Set([
    ...planetsData.bodies.map((b) => b.id),
    ...satellitesData.satellites.map((b) => b.id),
    ...(smallBodiesData.asteroids ?? []).map((b) => b.id),
    ...(smallBodiesData.comets ?? []).map((b) => b.id),
  ])
  const easings = new Set(EASING_NAMES)
  const transitions = new Set(['none', 'flash', 'starfield'])

  const problems = []
  const note = (ch, msg) => problems.push(`${ch.id ?? '?'}: ${msg}`)

  for (const ch of tourData.chapters) {
    if (!ch.id || !ch.title) note(ch, '缺 id 或 title')
    if (!(ch.duration > 0)) note(ch, 'duration 必须为正')
    if (ch.transition && !transitions.has(ch.transition)) note(ch, `未知过场 ${ch.transition}`)

    const cam = ch.camera ?? {}
    const path = cam.path ?? []
    if (path.length < 2) note(ch, `camera.path 只有 ${path.length} 个控制点，至少要 2 个`)
    for (const p of path) {
      if (![p.x, p.y, p.z].every(Number.isFinite)) note(ch, '控制点里有非数字')
    }
    if (cam.easing && !easings.has(cam.easing)) note(ch, `未知缓动 ${cam.easing}`)
    if (cam.frame && !knownIds.has(cam.frame)) note(ch, `camera.frame 指向不存在的天体 ${cam.frame}`)
    const target = cam.lookAt?.target
    if (!target) note(ch, '缺 camera.lookAt.target')
    else if (!knownIds.has(target)) note(ch, `lookAt.target 指向不存在的天体 ${target}`)

    const st = ch.sceneState ?? {}
    if (Array.isArray(st.visibleOrbits)) {
      for (const id of st.visibleOrbits) {
        if (!knownIds.has(id)) note(ch, `visibleOrbits 里有不存在的天体 ${id}`)
      }
    }
    if (st.highlight && !knownIds.has(st.highlight)) note(ch, `highlight 指向不存在的天体 ${st.highlight}`)

    // 字幕：区间合法、不重叠、不超出本章时长
    let cursor = -Infinity
    for (const sub of ch.subtitles ?? []) {
      if (!(sub.out > sub.in)) note(ch, `字幕区间非法 [${sub.in}, ${sub.out}]`)
      if (sub.in < cursor) note(ch, `字幕与上一句重叠于 ${sub.in}s`)
      if (sub.out > ch.duration) note(ch, `字幕 ${sub.out}s 超出本章 ${ch.duration}s`)
      if (!sub.text?.trim()) note(ch, '有空字幕')
      cursor = sub.out
    }
  }

  check(
    `${tourData.chapters.length} 个章节的结构、缓动名、天体 id 与字幕时序`,
    problems.length === 0,
    problems.length ? problems.join('；') : '全部合法',
  )

  // 引擎不得硬编码天体或文案：源码里出现具体天体 id 就是越界
  const engineSources = ['camera-director.js', 'tourPlayer.js', 'transitions.js', 'easing.js'].map(
    (f) => readFileSync(new URL(`../src/tour/${f}`, import.meta.url), 'utf8'),
  )
  const leaked = [...knownIds].filter((id) =>
    engineSources.some((src) => new RegExp(`['"\`]${id}['"\`]`).test(src)),
  )
  check('引擎代码里没有硬编码的天体 id', leaked.length === 0, leaked.join(', ') || '干净')

  check(
    '缓动表里没有 linear（禁止匀速直线运动）',
    !easings.has('linear'),
    `可用：${EASING_NAMES.join(', ')}`,
  )
}

// ------------------------------------------------------------------ 题记
{
  heading('资料面板题记 data/epigraphs.json')

  const needsText = [
    ...planetsData.bodies.map((b) => ({ id: b.id, name: b.name, narrative: b.narrative })),
    ...satellitesData.satellites.map((b) => ({ id: b.id, name: b.name, narrative: b.narrative })),
  ]
  const missing = needsText.filter(
    (b) => (b.narrative ?? '').startsWith('【占位') && !epigraphs.bodies[b.id],
  )
  check(
    '每个还是占位文案的天体都有题记顶上',
    missing.length === 0,
    missing.map((b) => b.name).join('、') || `${needsText.length} 个天体全部有中英题记`,
  )

  // 引文必须能追溯：缺出处的引文等于没出处
  const incomplete = []
  for (const [id, entry] of Object.entries(epigraphs.bodies)) {
    for (const lang of ['zh', 'en']) {
      const q = entry[lang]
      if (!q?.text?.trim()) { incomplete.push(`${id}.${lang} 缺引文`); continue }
      if (!q.source?.trim()) incomplete.push(`${id}.${lang} 缺出处`)
      if (!q.era?.trim()) incomplete.push(`${id}.${lang} 缺年代`)
      if (!q.note?.trim()) incomplete.push(`${id}.${lang} 缺相关性说明`)
    }
  }
  check(
    '每段引文都有出处、年代与相关性说明',
    incomplete.length === 0,
    incomplete.join('；') || `${Object.keys(epigraphs.bodies).length} 个天体 × 中英各一段，出处齐全`,
  )

  // 版权：只收公有领域。英文一律 1930 年前出版，中文一律 1912 年前
  const tooRecent = []
  for (const [id, entry] of Object.entries(epigraphs.bodies)) {
    for (const [lang, limit] of [['zh', 1912], ['en', 1930]]) {
      const years = [...(entry[lang]?.era ?? '').matchAll(/(\d{3,4})\s*年?/g)].map((m) => Number(m[1]))
      const latest = Math.max(...years, -Infinity)
      if (Number.isFinite(latest) && latest > limit) tooRecent.push(`${id}.${lang} ${latest}`)
    }
  }
  check(
    '引文均为公有领域（中文 ≤1912、英文 ≤1930 年出版）',
    tooRecent.length === 0,
    tooRecent.join('；') || '全部通过',
  )
}

// ------------------------------------------------------------------ 音频
{
  heading('背景音乐')

  const manifest = JSON.parse(readFileSync(new URL('../assets/music-manifest.json', import.meta.url), 'utf8'))
  const script = readFileSync(new URL('../scripts/fetch-music.js', import.meta.url), 'utf8')

  // 授权字段是硬约束：脚本必须在缺 license / author 时整批拒绝
  const badTracks = (manifest.tracks ?? []).filter((t) => !t.license?.trim() || !t.author?.trim())
  check(
    'manifest 里每条音轨都有 license 与 author',
    badTracks.length === 0,
    badTracks.map((t) => t.id ?? '?').join('、') || `${(manifest.tracks ?? []).length} 条`,
  )

  // 下载脚本不得含有任何搜索/发现音源的能力 —— 授权判断只能由人工做
  const forbidden = ['search', 'crawl', 'scrape', 'discover', 'youtube', 'spotify', 'soundcloud']
  const leaked = forbidden.filter((word) => new RegExp(`\\b${word}`, 'i').test(script))
  check('下载脚本里没有搜索/爬取音源的逻辑', leaked.length === 0, leaked.join('、') || '只按 manifest 的 url 下载')

  // 增益一律走斜坡：直接赋值 gain.value 会在波形上留阶跃
  const engine = readFileSync(new URL('../src/audio/audioEngine.js', import.meta.url), 'utf8')
  const rampCount = (engine.match(/linearRampToValueAtTime/g) ?? []).length
  const directAssign = [...engine.matchAll(/\.gain\.value\s*=/g)].length
  check(
    '增益变化走 linearRampToValueAtTime，没有运行时直接赋值',
    rampCount >= 2 && directAssign <= 2, // 仅允许构造时设初值
    `${rampCount} 处斜坡，${directAssign} 处初值赋值`,
  )

  const music = readFileSync(new URL('../src/audio/ambientMusic.js', import.meta.url), 'utf8')
  const fades = {
    淡出: /FADE_OUT = ([\d.]+)/.exec(music)?.[1],
    淡入: /FADE_IN = ([\d.]+)/.exec(music)?.[1],
    防抖: /DEBOUNCE_MS = (\d+)/.exec(music)?.[1],
  }
  check(
    '淡入比淡出慢，防抖 500 ms',
    Number(fades.淡入) > Number(fades.淡出) && fades.防抖 === '500',
    `淡出 ${fades.淡出}s，淡入 ${fades.淡入}s，防抖 ${fades.防抖}ms`,
  )
}

// ------------------------------------------------------------------ 外观真实性
{
  heading('外观：彗星结构、小天体外形、巨行星扁率')

  const comets = smallBodiesData.comets ?? []
  const asteroids = smallBodiesData.asteroids ?? []

  // 活跃彗星必须三件齐全：彗发 + 离子尾 + 尘埃尾
  const active = comets.filter((c) => c.coma || c.ionTail || c.dustTail)
  const incomplete = active.filter((c) => !(c.coma && c.ionTail && c.dustTail))
  check(
    '每颗活跃彗星都有彗发、离子尾、尘埃尾三层结构',
    incomplete.length === 0,
    incomplete.map((c) => c.id).join('、') || active.map((c) => c.id).join('、'),
  )

  // 奥陌陌恰恰是「没有彗发也没有尾」的那个 —— 这是它当年引发争议的原因，不能给它加
  const oumuamua = comets.find((c) => c.id === 'oumuamua')
  check(
    '奥陌陌没有彗发也没有尾（它的定义特征）',
    Boolean(oumuamua) && !oumuamua.coma && !oumuamua.ionTail && !oumuamua.dustTail,
    oumuamua ? '干净' : '找不到 oumuamua',
  )

  // 照片上的主次：尘埃尾更亮更宽、但更短，而且是弯的；离子尾更长更暗，必须笔直
  const wrongOrder = active.filter(
    (c) =>
      !(c.dustTail.opacity > c.ionTail.opacity) ||
      !(c.dustTail.widthKm > c.ionTail.widthKm) ||
      !(c.dustTail.lengthKm < c.ionTail.lengthKm) ||
      !(c.dustTail.curve > 0) ||
      (c.ionTail.curve ?? 0) !== 0,
  )
  check(
    '尘埃尾更亮更宽更短且弯曲，离子尾更长更暗且笔直',
    wrongOrder.length === 0,
    wrongOrder.map((c) => c.id).join('、') ||
      active.map((c) => `${c.id} 尘/离 亮度 ${c.dustTail.opacity}/${c.ionTail.opacity}`).join('；'),
  )

  // 小天体外形：只有够大的才能被自身引力压成球
  const ratio = (b) => b.shape?.axisRatio ?? 1
  const ceres = asteroids.find((a) => a.id === 'ceres')
  const vesta = asteroids.find((a) => a.id === 'vesta')
  const oum = comets.find((c) => c.id === 'oumuamua')
  check(
    '谷神星接近球形，灶神星明显不规则，奥陌陌极端细长',
    ratio(ceres) < 1.1 && ratio(vesta) > 1.2 && ratio(oum) >= 5,
    `谷神星 ${ratio(ceres)}、灶神星 ${ratio(vesta)}、奥陌陌 ${ratio(oum)}`,
  )

  const noShape = [...asteroids, ...comets].filter((b) => !b.shape)
  check('每颗命名小天体都有外形参数（不再是光滑球）', noShape.length === 0, noShape.map((b) => b.id).join('、') || '全部就位')

  // 巨行星扁率：与 NASA 行星情况说明书对齐，且土星最扁
  const JPL_FLATTENING = { jupiter: 0.06487, saturn: 0.09796, uranus: 0.02293, neptune: 0.01708 }
  const bad = Object.entries(JPL_FLATTENING).filter(([id, f]) => {
    const b = planetsData.bodies.find((x) => x.id === id)
    return !b?.flattening || Math.abs(b.flattening - f) > 1e-5
  })
  const saturnF = planetsData.bodies.find((b) => b.id === 'saturn').flattening
  check(
    '四颗巨行星的扁率与 NASA 情况说明书一致，土星最扁',
    bad.length === 0 && Object.values(JPL_FLATTENING).every((f) => f <= saturnF),
    bad.map(([id]) => id).join('、') ||
      Object.entries(JPL_FLATTENING).map(([id, f]) => `${id} ${(f * 100).toFixed(1)}%`).join('，'),
  )

  // 形状与彗尾的数值一律在 JSON 里，渲染代码不得硬编码
  const sources = ['cometTail.js', 'rockSurface.js', 'smallBodies.js'].map((f) =>
    readFileSync(new URL(`../src/bodies/${f}`, import.meta.url), 'utf8'),
  )
  const ids = [...asteroids, ...comets].map((b) => b.id)
  const leaked = ids.filter((id) => sources.some((src) => new RegExp(`['"\`]${id}['"\`]`).test(src)))
  check('渲染代码里没有硬编码的小天体 id', leaked.length === 0, leaked.join('、') || '干净')
}

// ------------------------------------------------------------------ 汇总
console.log(
  failures === 0
    ? `\n\x1b[32m全部通过\x1b[0m`
    : `\n\x1b[31m${failures} 项未通过\x1b[0m`,
)
process.exit(failures === 0 ? 0 : 1)
