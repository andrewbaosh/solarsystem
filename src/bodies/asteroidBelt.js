import * as THREE from 'three'
import { toSceneDistance } from '../core/scale.js'
import { AU_KM, GAUSS_K } from './orbital.js'

const DEG = Math.PI / 180

/**
 * 主小行星带。
 *
 * 这是程序化生成的代表性群体（几千颗），不是真实编目 —— 真实编目有一百多万条，
 * 而且绝大多数小到根本不该在这个尺度下画出来。
 *
 * 但有一个结构是照真实数据做的：**柯克伍德空隙**。半长轴分布在与木星
 * 3:1、5:2、7:3、2:1 平均运动共振的位置被挖空，那是木星几十亿年清扫的结果，
 * 也是小行星带最有辨识度的特征 —— 带不是均匀的一圈，是有缝的。
 *
 * 每颗小行星都在自己的开普勒轨道上真实运动（各自的 a/e/i/Ω/ω/M₀），
 * 不是让整个带整体旋转。
 */

function hash(i, salt) {
  let h = i * 374761393 + salt * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

export function createAsteroidBelt(scene, config) {
  const count = config.count ?? 3000
  const gaps = config.kirkwoodGaps ?? []
  const seed = config.seed ?? 1

  /** 落在共振空隙里就重新抽，抽不到就接受 —— 空隙不是绝对真空，只是显著稀疏 */
  function sampleSemiMajorAxis(i) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = config.innerAU + hash(i, seed + attempt * 37) * (config.outerAU - config.innerAU)
      const inGap = gaps.some((g) => Math.abs(a - g.au) < g.widthAU)
      if (!inGap) return a
    }
    return config.innerAU + hash(i, seed) * (config.outerAU - config.innerAU)
  }

  /**
   * 每颗小行星的轨道要素一次算好。
   *
   * 关键优化：把「轨道平面 → 黄道」那个旋转矩阵的六个系数**预先算出来**。
   * 通用写法每帧要为每颗小行星做 6 次三角函数，3600 颗就是每帧 2 万多次，
   * 实测占掉 60fps 预算的 28%。这些系数只由 Ω/ω/i 决定，根本不随时间变。
   */
  const orbits = []
  for (let i = 0; i < count; i++) {
    const a = sampleSemiMajorAxis(i)
    const e = Math.pow(hash(i, seed + 11), 1.8) * (config.maxEccentricity ?? 0.18)
    const inc = Math.pow(hash(i, seed + 13), 1.7) * (config.maxInclinationDeg ?? 18) * DEG
    const om = hash(i, seed + 17) * 360 * DEG
    const w = hash(i, seed + 19) * 360 * DEG

    const cw = Math.cos(w)
    const sw = Math.sin(w)
    const cO = Math.cos(om)
    const sO = Math.sin(om)
    const ci = Math.cos(inc)
    const si = Math.sin(inc)

    orbits.push({
      a,
      e,
      M0: hash(i, seed + 23) * 2 * Math.PI,
      n: GAUSS_K / Math.sqrt(a * a * a), // rad/day
      b: a * Math.sqrt(1 - e * e), // 半短轴，省一次 sqrt
      size: 0.35 + Math.pow(hash(i, seed + 29), 3) * 2.2,
      // 预乘好的基向量：位置 = px * xp + qx * yp
      px: cw * cO - sw * sO * ci,
      py: cw * sO + sw * cO * ci,
      pz: sw * si,
      qx: -sw * cO - cw * sO * ci,
      qy: -sw * sO + cw * cO * ci,
      qz: cw * si,
      // 供自检脚本核对分布用
      incDeg: inc / DEG,
    })
  }

  const geometry = new THREE.IcosahedronGeometry(1, 0)
  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(config.color ?? '#8d8175'),
    roughness: 1,
    metalness: 0,
    flatShading: true,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, count)
  mesh.frustumCulled = false
  mesh.name = 'asteroid-belt'
  scene.add(mesh)

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const quaternion = new THREE.Quaternion()
  const scaleVec = new THREE.Vector3()

  /**
   * 分批更新：小行星公转周期以年计，在屏幕上每帧只挪不到一个像素，
   * 完全没必要每帧全算。轮流更新 1/BATCHES，视觉上分辨不出，开销降到 1/BATCHES。
   */
  const BATCHES = 4
  let batch = 0

  function updateRange(from, to, daysSinceJ2000, radiusScale) {
    for (let i = from; i < to; i++) {
      const o = orbits[i]

      // 开普勒方程，就地展开：偏心率都不大，三次牛顿迭代足够收敛到 1e-10
      let M = (o.M0 + o.n * daysSinceJ2000) % (2 * Math.PI)
      if (M > Math.PI) M -= 2 * Math.PI
      else if (M < -Math.PI) M += 2 * Math.PI
      let E = M + o.e * Math.sin(M)
      for (let k = 0; k < 3; k++) {
        E += (M - (E - o.e * Math.sin(E))) / (1 - o.e * Math.cos(E))
      }

      const xp = o.a * (Math.cos(E) - o.e)
      const yp = o.b * Math.sin(E)

      // 预乘好的基向量，零三角函数
      const x = o.px * xp + o.qx * yp
      const y = o.py * xp + o.qy * yp
      const z = o.pz * xp + o.qz * yp

      // 与行星一样：只压缩到太阳的距离、保留方向
      const rAU = Math.sqrt(x * x + y * y + z * z)
      const s = toSceneDistance(rAU * AU_KM) / rAU
      position.set(x * s, z * s, -y * s) // 黄道 → 场景（x, z, -y）

      scaleVec.setScalar(o.size * radiusScale)
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scaleVec))
    }
  }

  function update(daysSinceJ2000, radiusScale) {
    const size = Math.ceil(count / BATCHES)
    const from = batch * size
    updateRange(from, Math.min(count, from + size), daysSinceJ2000, radiusScale)
    batch = (batch + 1) % BATCHES
    mesh.instanceMatrix.needsUpdate = true
  }

  /** 尺度切换等场合需要立刻全量刷新 */
  function updateAll(daysSinceJ2000, radiusScale) {
    updateRange(0, count, daysSinceJ2000, radiusScale)
    mesh.instanceMatrix.needsUpdate = true
  }

  return {
    mesh,
    update,
    updateAll,
    count,
    orbits,
    setVisible: (v) => {
      mesh.visible = v
    },
  }
}
