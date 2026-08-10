import * as THREE from 'three'

/**
 * 地表地形生成。
 *
 * 为什么不是真实 DEM：
 * 全球高程图在第一人称尺度下没有可用信息量。2K 全球图在火星上是 10.4 km/像素，
 * 一个 3 km 见方的场景只跨 0.29 个像素；即便换成 MOLA 最好的全球产品（463 m/px）
 * 也只有 6.5 个像素 —— 那是一道平缓斜坡，站在地面上看不出任何起伏。
 * 真要用真实地形，需要的是着陆点局部的 HiRISE DTM（~1 m/px）这一量级的数据。
 * 所以这里用程序化噪声按天体调参，并保留 heightSampler 接口：
 * 将来把局部 DEM 采样器传进来即可替换，不用改其它代码。
 *
 * 单位：米。地表场景是独立场景，1 单位 = 1 米，不经过 scale.js 的压缩。
 */

/** 确定性哈希，保证同一个 seed 每次生成同样的地形 */
function hash2(x, y, seed) {
  let h = x * 374761393 + y * 668265263 + seed * 2246822519
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const smooth = (t) => t * t * (3 - 2 * t)

function valueNoise(x, y, seed) {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = smooth(xf)
  const v = smooth(yf)
  const a = hash2(xi, yi, seed)
  const b = hash2(xi + 1, yi, seed)
  const c = hash2(xi, yi + 1, seed)
  const d = hash2(xi + 1, yi + 1, seed)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

/** 分形叠加：多个倍频的噪声相加，得到自然的起伏 */
function fbm(x, y, seed, octaves = 5, lacunarity = 2.03, gain = 0.5) {
  let sum = 0
  let amplitude = 1
  let frequency = 1
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += amplitude * (valueNoise(x * frequency, y * frequency, seed + i * 101) * 2 - 1)
    norm += amplitude
    amplitude *= gain
    frequency *= lacunarity
  }
  return sum / norm
}

/**
 * 撞击坑剖面：碗状凹陷 + 抬升的环形坑缘。
 * 无大气天体（月球、水星、伽利略卫星）表面主要由撞击主导，
 * 只叠分形噪声会像沙丘而不像月面，必须显式加坑。
 */
function craterProfile(distanceRatio) {
  if (distanceRatio > 1.35) return 0
  if (distanceRatio < 1) {
    // 坑内：抛物线碗底
    return -(1 - distanceRatio * distanceRatio) * 0.85
  }
  // 坑缘：向外衰减的抬升
  const t = (distanceRatio - 1) / 0.35
  return (1 - t) * (1 - t) * 0.42
}

export function createTerrain(config, seed) {
  const size = config.size ?? 3000 // 场景边长，米
  const segments = config.segments ?? 320
  const amplitude = config.amplitude ?? 20
  const featureScale = config.featureScale ?? 260 // 主起伏的水平尺度，米
  const craterDensity = config.craterDensity ?? 0
  const craterSeed = seed + 7717

  // 预先撒好撞击坑，heightAt 与网格共用同一份，保证碰撞与视觉一致
  const craters = []
  const craterCount = Math.round(craterDensity * 60)
  for (let i = 0; i < craterCount; i++) {
    const r = hash2(i, 31, craterSeed)
    craters.push({
      x: (hash2(i, 11, craterSeed) - 0.5) * size * 1.2,
      z: (hash2(i, 17, craterSeed) - 0.5) * size * 1.2,
      // 大坑少、小坑多，近似真实的尺寸分布
      radius: 14 + Math.pow(r, 2.6) * 240,
      depth: 0,
    })
  }
  for (const c of craters) c.depth = c.radius * 0.22

  /** 任意点的地面高度（米）。地形网格与玩家碰撞都走这个函数 */
  function heightAt(x, z) {
    let h = fbm(x / featureScale, z / featureScale, seed) * amplitude
    // 细节层：让近处地面不至于过分光滑
    h += fbm(x / 26, z / 26, seed + 991, 3) * amplitude * 0.07

    for (const c of craters) {
      const d = Math.hypot(x - c.x, z - c.z) / c.radius
      if (d < 1.35) h += craterProfile(d) * c.depth
    }
    return h
  }

  // ---- 网格 ----------------------------------------------------------------

  const geometry = new THREE.PlaneGeometry(size, size, segments, segments)
  geometry.rotateX(-Math.PI / 2)

  const position = geometry.attributes.position
  const colors = new Float32Array(position.count * 3)
  const base = new THREE.Color(config.groundColor ?? '#8c8a86')
  const alt = new THREE.Color(config.groundColorVariation ?? config.groundColor ?? '#6e6c68')
  const mixed = new THREE.Color()

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const z = position.getZ(i)
    const h = heightAt(x, z)
    position.setY(i, h)

    // 用一层低频噪声做颜色斑驳，避免地面是一整块死色
    const t = valueNoise(x / 140, z / 140, seed + 555)
    mixed.copy(base).lerp(alt, t * 0.85)
    colors[i * 3] = mixed.r
    colors[i * 3 + 1] = mixed.g
    colors[i * 3 + 2] = mixed.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.receiveShadow = true

  // ---- 散落的岩石 ----------------------------------------------------------

  let rocks = null
  const rockCount = Math.round((config.rockDensity ?? 0.5) * 2200)
  if (rockCount > 0) {
    const rockGeometry = new THREE.IcosahedronGeometry(1, 0)
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: alt.clone().multiplyScalar(0.8),
      roughness: 1,
      metalness: 0,
      flatShading: true,
    })
    rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockCount)
    rocks.castShadow = true
    rocks.receiveShadow = true

    const matrix = new THREE.Matrix4()
    const quaternion = new THREE.Quaternion()
    const euler = new THREE.Euler()
    const scaleVec = new THREE.Vector3()
    const positionVec = new THREE.Vector3()

    for (let i = 0; i < rockCount; i++) {
      const x = (hash2(i, 3, seed + 1234) - 0.5) * size * 0.96
      const z = (hash2(i, 5, seed + 1234) - 0.5) * size * 0.96
      const s = 0.25 + Math.pow(hash2(i, 7, seed + 1234), 3) * 3.4
      positionVec.set(x, heightAt(x, z) + s * 0.35, z)
      euler.set(
        hash2(i, 9, seed) * Math.PI,
        hash2(i, 13, seed) * Math.PI * 2,
        hash2(i, 19, seed) * Math.PI,
      )
      quaternion.setFromEuler(euler)
      scaleVec.set(s, s * (0.5 + hash2(i, 23, seed) * 0.5), s)
      rocks.setMatrixAt(i, matrix.compose(positionVec, quaternion, scaleVec))
    }
    rocks.instanceMatrix.needsUpdate = true
  }

  return { mesh, rocks, heightAt, size }
}
