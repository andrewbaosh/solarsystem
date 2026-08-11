import * as THREE from 'three'

/**
 * 岩石天体的表面与外形。
 *
 * 小行星带的三千多颗程序化小行星、四颗命名小行星、以及彗核，共用这一套 ——
 * 它们在物理上本来就是同一类东西：没有被自身引力压成球的撞击碎片。
 *
 * 这里不含任何具体天体的数值，形状参数由调用方从 data/*.json 传进来。
 */

/** 整数哈希 → [0,1)，用来做可重现的伪随机 */
export function hash(i, salt) {
  let h = i * 374761393 + salt * 668265263
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * 岩石表面贴图：分形噪声做反照率，再由它的梯度生成法线图。
 *
 * 小行星表面是碎石堆与撞击坑构成的风化层，不是光滑的塑料球。
 * 这里生成一张可无缝平铺的噪声贴图 + 配套法线图，让掠射光下有真实的颗粒感。
 * 结果做了缓存：全场只需要一份。
 */
let cachedTextures = null

export function createRegolithTextures(size = 256) {
  if (cachedTextures) return cachedTextures
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
  cachedTextures = { albedo, normal }
  return cachedTextures
}

/**
 * 不规则岩块几何体。
 *
 * 小行星几乎没有能靠自身引力压成球的 —— 只有谷神星那个量级才够。绝大多数是
 * 撞击碎片，形状是坑洼的多面体。这里把细分球的顶点按噪声推拉，做出棱角与凹陷。
 *
 * @param seed       变体种子，同一个种子永远得到同一块石头
 * @param roughness  起伏幅度。0 = 光滑球（谷神星那种流体静力学平衡的天体），
 *                   1 = 典型撞击碎片
 * @param axisRatio  长短轴比。奥陌陌那种极端细长体靠它表达，球形天体填 1
 * @param detail     细分级别，近距离观察的天体给 3，远处的给 2
 */
export function createRockGeometry({ seed = 1, roughness = 1, axisRatio = 1, detail = 2 } = {}) {
  const geometry = new THREE.IcosahedronGeometry(1, detail)
  const pos = geometry.attributes.position
  const v = new THREE.Vector3()
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i)
    const n = v.clone().normalize()
    // 三个不同频率的方向性扰动叠加：大起伏 + 棱角 + 细碎
    const lumpy =
      0.26 * Math.sin(n.x * 3.1 + seed) * Math.cos(n.y * 2.7 - seed) +
      0.14 * Math.sin(n.y * 6.3 - seed * 2) * Math.cos(n.z * 5.1 + seed) +
      0.07 * Math.sin(n.z * 11.2 + seed * 3)
    v.setLength(1 + lumpy * roughness)
    pos.setXYZ(i, v.x, v.y, v.z)
  }
  pos.needsUpdate = true

  // 拉长：沿 X 轴拉、另两轴压，保持体积不变，这样 radiusKm 仍然是等效球半径
  if (axisRatio !== 1) {
    const a = Math.cbrt(axisRatio * axisRatio)
    const b = 1 / Math.cbrt(axisRatio)
    geometry.scale(a, b, b)
  }

  geometry.computeVertexNormals()
  return geometry
}
