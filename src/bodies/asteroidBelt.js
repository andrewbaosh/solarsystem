import * as THREE from 'three'
import { toSceneDistance } from '../core/scale.js'
import { AU_KM, GAUSS_K, solveKepler, orbitalPlaneToEcliptic, eclipticToScene } from './orbital.js'

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

  // 每颗小行星的轨道要素，一次算好
  const orbits = []
  for (let i = 0; i < count; i++) {
    const a = sampleSemiMajorAxis(i)
    orbits.push({
      a,
      e: Math.pow(hash(i, seed + 11), 1.8) * (config.maxEccentricity ?? 0.18),
      i: Math.pow(hash(i, seed + 13), 1.7) * (config.maxInclinationDeg ?? 18),
      om: hash(i, seed + 17) * 360,
      w: hash(i, seed + 19) * 360,
      M0: hash(i, seed + 23) * 360,
      // 平均运动，deg/day
      n: (GAUSS_K / Math.sqrt(a * a * a) / DEG),
      size: 0.35 + Math.pow(hash(i, seed + 29), 3) * 2.2,
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
  const plane = {}

  function update(daysSinceJ2000, radiusScale) {
    for (let i = 0; i < count; i++) {
      const o = orbits[i]
      const M = ((o.M0 + o.n * daysSinceJ2000) % 360) * DEG
      const { E } = solveKepler(M > Math.PI ? M - 2 * Math.PI : M, o.e)
      const xp = o.a * (Math.cos(E) - o.e)
      const yp = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E)
      orbitalPlaneToEcliptic(xp, yp, { peri: o.om + o.w, node: o.om, I: o.i }, plane)

      // 与行星一样：只压缩到太阳的距离、保留方向
      const rAU = Math.hypot(plane.x, plane.y, plane.z)
      const s = toSceneDistance(rAU * AU_KM) / rAU
      eclipticToScene(plane, position).multiplyScalar(s)

      scaleVec.setScalar(o.size * radiusScale)
      mesh.setMatrixAt(i, matrix.compose(position, quaternion, scaleVec))
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  return {
    mesh,
    update,
    count,
    orbits,
    setVisible: (v) => {
      mesh.visible = v
    },
  }
}
