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

import {
  heliocentricAU,
  solveKepler,
  orbitNormal,
  elementsAt,
  centuriesSinceJ2000,
  AU_KM,
  J2000_JD,
  KEPLER_TOLERANCE,
} from '../src/bodies/orbital.js'
import {
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

const el = orbitalElements.planets
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
    elements: orbitalElements.planets,
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

// ------------------------------------------------------------------ 汇总
console.log(
  failures === 0
    ? `\n\x1b[32m全部通过\x1b[0m`
    : `\n\x1b[31m${failures} 项未通过\x1b[0m`,
)
process.exit(failures === 0 ? 0 : 1)
