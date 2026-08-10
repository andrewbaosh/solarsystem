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

/**
 * 岩石表面贴图：分形噪声做反照率，再由它的梯度生成法线图。
 *
 * 小行星表面是碎石堆与撞击坑构成的风化层，不是光滑的塑料球。
 * 这里生成一张可无缝平铺的噪声贴图 + 配套法线图，让掠射光下有真实的颗粒感。
 */
function createRegolithTextures(size = 256) {
  if (typeof document === 'undefined') return {}

  // 可平铺的值噪声
  const noise = new Float32Array(size * size)
  const octaves = [4, 8, 16, 32, 64]
  const weights = [0.42, 0.26, 0.16, 0.1, 0.06]
  for (let o = 0; o < octaves.length; o++) {
    const grid = octaves[o]
    const cell = size / grid
    const rand = new Float32Array((grid + 1) * (grid + 1))
    for (let i = 0; i < rand.length; i++) rand[i] = hash(i, 977 + o * 131)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = Math.floor(x / cell)
        const gy = Math.floor(y / cell)
        const fx = x / cell - gx
        const fy = y / cell - gy
        const sx = fx * fx * (3 - 2 * fx)
        const sy = fy * fy * (3 - 2 * fy)
        // 取模保证左右、上下接缝对齐
        const at = (ix, iy) => rand[(iy % grid) * (grid + 1) + (ix % grid)]
        const v =
          at(gx, gy) * (1 - sx) * (1 - sy) +
          at(gx + 1, gy) * sx * (1 - sy) +
          at(gx, gy + 1) * (1 - sx) * sy +
          at(gx + 1, gy + 1) * sx * sy
        noise[y * size + x] += v * weights[o]
      }
    }
  }

  // 反照率
  const albedoCanvas = document.createElement('canvas')
  albedoCanvas.width = albedoCanvas.height = size
  const actx = albedoCanvas.getContext('2d')
  const img = actx.createImageData(size, size)
  for (let i = 0; i < size * size; i++) {
    // 压高对比度，做出明暗斑驳的风化层观感
    const v = Math.pow(Math.min(1, Math.max(0, noise[i] * 1.25)), 1.5)
    const g = 90 + v * 130
    img.data[i * 4] = g * 1.04
    img.data[i * 4 + 1] = g * 0.97
    img.data[i * 4 + 2] = g * 0.88
    img.data[i * 4 + 3] = 255
  }
  actx.putImageData(img, 0, 0)

  // 由噪声梯度生成法线图 —— 这才是掠射光下颗粒感的来源
  const normalCanvas = document.createElement('canvas')
  normalCanvas.width = normalCanvas.height = size
  const nctx = normalCanvas.getContext('2d')
  const nimg = nctx.createImageData(size, size)
  const at = (x, y) => noise[((y + size) % size) * size + ((x + size) % size)]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * 5
      const dy = (at(x, y - 1) - at(x, y + 1)) * 5
      const len = Math.hypot(dx, dy, 1)
      const i = (y * size + x) * 4
      nimg.data[i] = ((dx / len) * 0.5 + 0.5) * 255
      nimg.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255
      nimg.data[i + 2] = (1 / len) * 255
      nimg.data[i + 3] = 255
    }
  }
  nctx.putImageData(nimg, 0, 0)

  const albedo = new THREE.CanvasTexture(albedoCanvas)
  albedo.colorSpace = THREE.SRGBColorSpace
  albedo.wrapS = albedo.wrapT = THREE.RepeatWrapping
  const normal = new THREE.CanvasTexture(normalCanvas)
  normal.wrapS = normal.wrapT = THREE.RepeatWrapping
  return { albedo, normal }
}

/**
 * 不规则岩块几何体。
 *
 * 小行星几乎没有能靠自身引力压成球的（只有谷神星那个量级才行），
 * 绝大多数是撞击碎片，形状是坑洼的多面体。这里把细分球的顶点按噪声推拉，
 * 做出棱角与凹陷；每个变体一个随机种子，避免整条带看起来是同一块石头。
 */
function createRockGeometry(variantSeed) {
  const geometry = new THREE.IcosahedronGeometry(1, 2)
  const pos = geometry.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const n = v.clone().normalize()
    // 三个不同频率的方向性扰动叠加：大起伏 + 棱角 + 细碎
    const lumpy =
      0.26 * Math.sin(n.x * 3.1 + variantSeed) * Math.cos(n.y * 2.7 - variantSeed) +
      0.14 * Math.sin(n.y * 6.3 - variantSeed * 2) * Math.cos(n.z * 5.1 + variantSeed) +
      0.07 * Math.sin(n.z * 11.2 + variantSeed * 3)
    v.setLength(1 + lumpy)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true
  geometry.computeVertexNormals()
  return geometry
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

  // ---- 材质与几何体：三种岩块变体，避免整条带是同一块石头 --------------------

  const { albedo, normal } = createRegolithTextures()
  const VARIANTS = 3

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(config.color ?? '#8d8175'),
    map: albedo ?? null,
    normalMap: normal ?? null,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughness: 0.95,
    metalness: 0.02,
  })

  const meshes = []
  const variantCounts = new Array(VARIANTS).fill(0)
  for (let i = 0; i < count; i++) variantCounts[i % VARIANTS]++

  for (let v = 0; v < VARIANTS; v++) {
    const m = new THREE.InstancedMesh(createRockGeometry(1.7 + v * 2.3), material, variantCounts[v])
    m.frustumCulled = false
    m.name = `asteroid-belt-${v}`
    // 每颗单独的色偏：碳质（暗）到石质（亮）的差异是真实存在的
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(variantCounts[v] * 3), 3)
    meshes.push(m)
    scene.add(m)
  }

  // 把每颗小行星分配到某个变体的某个槽位，并写入色偏
  {
    const slots = new Array(VARIANTS).fill(0)
    const tint = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const v = i % VARIANTS
      const slot = slots[v]++
      orbits[i].variant = v
      orbits[i].slot = slot
      // 亮度 0.55~1.25，再带一点色相偏移
      const shade = 0.55 + hash(i, seed + 41) * 0.7
      tint.setRGB(shade * (0.95 + hash(i, seed + 43) * 0.12), shade, shade * (0.86 + hash(i, seed + 47) * 0.14))
      meshes[v].setColorAt(slot, tint)
    }
    for (const m of meshes) m.instanceColor.needsUpdate = true
  }

  const matrix = new THREE.Matrix4()
  const position = new THREE.Vector3()
  const scaleVec = new THREE.Vector3()

  // 每颗一个固定的随机朝向 —— 撞击碎片不会整整齐齐地正着摆
  {
    const euler = new THREE.Euler()
    for (let i = 0; i < count; i++) {
      euler.set(hash(i, seed + 53) * Math.PI * 2, hash(i, seed + 59) * Math.PI * 2, hash(i, seed + 61) * Math.PI * 2)
      orbits[i].tilt = new THREE.Quaternion().setFromEuler(euler)
    }
  }

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
      meshes[o.variant].setMatrixAt(o.slot, matrix.compose(position, o.tilt, scaleVec))
    }
  }

  function update(daysSinceJ2000, radiusScale) {
    const size = Math.ceil(count / BATCHES)
    const from = batch * size
    updateRange(from, Math.min(count, from + size), daysSinceJ2000, radiusScale)
    batch = (batch + 1) % BATCHES
    for (const m of meshes) m.instanceMatrix.needsUpdate = true
  }

  /** 尺度切换等场合需要立刻全量刷新 */
  function updateAll(daysSinceJ2000, radiusScale) {
    updateRange(0, count, daysSinceJ2000, radiusScale)
    for (const m of meshes) m.instanceMatrix.needsUpdate = true
  }

  return {
    meshes,
    update,
    updateAll,
    count,
    orbits,
    setVisible: (v) => {
      for (const m of meshes) m.visible = v
    },
  }
}
