import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

const BASE = import.meta.env?.BASE_URL ?? '/'
const MODEL_BASE = BASE + 'models/'

/**
 * NASA 的部分官方模型（毅力号）用了 Draco 网格压缩，必须挂 DRACOLoader 才能解。
 * 解码器就在 three 包自带的 examples/jsm/libs/draco/gltf/ 里，已复制到 public/draco/，
 * 不是新增依赖。只保留 wasm 版本，纯 JS 回退和编码器删掉省了 1.4 MB。
 */
/**
 * 模型走**独立的** LoadingManager：着陆器模型最大 5 MB，是按需加载的，
 * 不能算进首屏进度条里，否则首屏会一直等一个当前根本用不到的文件。
 */
const modelManager = typeof document !== 'undefined' ? new THREE.LoadingManager() : null

const gltfLoader = (() => {
  if (typeof document === 'undefined') return null
  const loader = new GLTFLoader(modelManager)
  const draco = new DRACOLoader(modelManager)
  draco.setDecoderPath(BASE + 'draco/')
  loader.setDRACOLoader(draco)
  return loader
})()

/**
 * 已解析模型的缓存。
 *
 * 缓存的是解析结果，每次取用返回 clone —— clone 共享 geometry 与 material，
 * 所以给它们打上 shared 标记，地表场景 dispose 时会跳过，否则第二次登陆
 * 拿到的就是一堆已经被释放的资源。
 */
const modelCache = new Map()

function markShared(object) {
  object.traverse((child) => {
    if (!child.isMesh) return
    child.userData.shared = true
    if (child.geometry) child.geometry.userData.shared = true
    const mats = Array.isArray(child.material) ? child.material : [child.material]
    for (const m of mats) if (m) m.userData.shared = true
  })
}

/**
 * 确保模型已下载并解析完成。返回可直接使用的副本；无模型或加载失败返回 null。
 * 调用方（landing）会等它就绪再开始时序 —— 否则整个下降过程看到的都是
 * 程序化占位模型，等于白做。
 */
export function ensureLanderModel(file, targetHeight) {
  if (!file || !gltfLoader) return Promise.resolve(null)
  if (!modelCache.has(file)) {
    modelCache.set(
      file,
      loadModel(file, targetHeight).then((root) => {
        if (root) markShared(root)
        return root
      }),
    )
  }
  return modelCache.get(file).then((root) => (root ? root.clone(true) : null))
}

/** 资料面板打开时提前触发下载与解析，用户真点「登陆」时就无需等待 */
export function preloadLanderModel(file, targetHeight) {
  ensureLanderModel(file, targetHeight).catch(() => {})
}

/**
 * 把模型摆正：水平居中、最低点落在 y=0、按真实高度缩放。
 * glTF 里的单位和原点各家不同，不归一化的话不是陷进地里就是浮在空中。
 */
function normalizeModel(object, targetHeight) {
  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const scale = targetHeight && size.y > 1e-6 ? targetHeight / size.y : 1
  object.scale.setScalar(scale)
  object.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale)

  object.traverse((child) => {
    if (!child.isMesh) return
    child.castShadow = true
    child.receiveShadow = true
  })
  return { scale, size }
}

/** 异步加载官方模型；失败时保留程序化模型，不至于什么都看不到 */
function loadModel(file, targetHeight) {
  if (!gltfLoader) return Promise.resolve(null)
  return new Promise((resolve) => {
    gltfLoader.load(
      MODEL_BASE + file,
      (gltf) => {
        const root = gltf.scene
        normalizeModel(root, targetHeight)
        resolve(root)
      },
      undefined,
      (err) => {
        console.warn('[lander] 模型加载失败，继续使用程序化模型:', file, err)
        resolve(null)
      },
    )
  })
}

/**
 * 着陆器模型。
 *
 * 全部用基础几何体拼装（不引入外部模型依赖），目标是**轮廓可辨认**：
 * 阿波罗登月舱的四条外撑腿与折面上升级、金星 13 号的球形耐压舱加圆盘刹车环、
 * 好奇号的六轮车加上方悬停的下降级、惠更斯号的扁锥体 —— 这些剪影本身就是识别特征。
 *
 * 单位：米。尺寸取自各任务的实际外形数据。
 */

const materials = {
  foil: () => new THREE.MeshStandardMaterial({ color: 0xd9b45a, roughness: 0.45, metalness: 0.75 }),
  metal: () => new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.5, metalness: 0.8 }),
  dark: () => new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.7, metalness: 0.4 }),
  white: () => new THREE.MeshStandardMaterial({ color: 0xe8e6e1, roughness: 0.6, metalness: 0.2 }),
  black: () => new THREE.MeshStandardMaterial({ color: 0x17191c, roughness: 0.8, metalness: 0.3 }),
  copper: () => new THREE.MeshStandardMaterial({ color: 0xa86a3a, roughness: 0.5, metalness: 0.7 }),
  solar: () => new THREE.MeshStandardMaterial({ color: 0x1b2f5e, roughness: 0.35, metalness: 0.6 }),
}

/** 把组内所有子件整体抬起，使最低点正好落在组的原点上（原点 = 触地点） */
function sitOnOrigin(group) {
  const box = new THREE.Box3().setFromObject(group)
  if (!Number.isFinite(box.min.y)) return
  for (const child of group.children) child.position.y -= box.min.y
}

function mesh(geometry, material, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(geometry, material)
  m.position.set(x, y, z)
  m.castShadow = true
  m.receiveShadow = true
  return m
}

/** 四条外撑着陆腿 + 圆盘足垫，登月舱式 */
function addLegs(group, { count = 4, spread, top, footY, radius = 0.12, padRadius = 0.5 }) {
  const legMat = materials.metal()
  const padMat = materials.metal()
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.PI / count
    const dx = Math.cos(angle)
    const dz = Math.sin(angle)
    const length = Math.hypot(spread, top - footY)

    const leg = mesh(new THREE.CylinderGeometry(radius, radius, length, 8), legMat)
    leg.position.set((dx * spread) / 2, (top + footY) / 2, (dz * spread) / 2)
    leg.lookAt(new THREE.Vector3(dx * spread, footY, dz * spread))
    leg.rotateX(Math.PI / 2)
    group.add(leg)

    group.add(
      mesh(
        new THREE.CylinderGeometry(padRadius, padRadius * 0.85, 0.12, 12),
        padMat,
        dx * spread,
        footY + 0.06,
        dz * spread,
      ),
    )
  }
}

// ---- 阿波罗登月舱 ---------------------------------------------------------

function apolloLM() {
  const g = new THREE.Group()

  // 下降级：八边形箱体，包金箔
  g.add(mesh(new THREE.CylinderGeometry(2.1, 2.1, 1.7, 8), materials.foil(), 0, 2.0, 0))
  // 主发动机喷管
  g.add(mesh(new THREE.CylinderGeometry(0.35, 0.75, 1.1, 12), materials.dark(), 0, 0.75, 0))

  addLegs(g, { spread: 4.6, top: 2.0, footY: 0.0, radius: 0.1, padRadius: 0.48 })

  // 上升级：折面舱体
  const cabin = mesh(new THREE.CylinderGeometry(1.45, 1.6, 1.6, 8), materials.white(), 0, 3.65, 0)
  g.add(cabin)
  // 前部斜面与两扇三角窗（登月舱最好认的特征）
  const front = mesh(new THREE.BoxGeometry(1.9, 1.0, 0.9), materials.white(), 0, 3.55, 1.5)
  front.rotation.x = -0.32
  g.add(front)
  for (const sx of [-0.45, 0.45]) {
    const win = mesh(new THREE.BoxGeometry(0.5, 0.36, 0.08), materials.black(), sx, 3.72, 1.92)
    win.rotation.x = -0.32
    g.add(win)
  }
  // 舱顶对接口与交会雷达
  g.add(mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.5, 12), materials.metal(), 0, 4.65, 0))
  g.add(mesh(new THREE.SphereGeometry(0.3, 12, 8), materials.metal(), 0, 4.4, -1.2))
  // 四组姿控推力器
  for (const [x, z] of [[1.5, 1.5], [-1.5, 1.5], [1.5, -1.5], [-1.5, -1.5]]) {
    g.add(mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), materials.dark(), x, 4.0, z))
  }
  // 前腿上的梯子
  g.add(mesh(new THREE.BoxGeometry(0.5, 2.0, 0.06), materials.metal(), 0, 1.0, 2.25))

  return { group: g, height: 5.0 }
}

// ---- 金星 13 号 -----------------------------------------------------------

function venera() {
  const g = new THREE.Group()

  // 底部环形缓冲垫
  const ring = mesh(new THREE.TorusGeometry(1.0, 0.22, 10, 24), materials.metal(), 0, 0.25, 0)
  ring.rotation.x = Math.PI / 2
  g.add(ring)

  // 球形钛合金耐压舱 —— 金星着陆器的核心特征
  g.add(mesh(new THREE.SphereGeometry(1.0, 20, 14), materials.white(), 0, 1.5, 0))
  // 相机窗口
  for (const a of [0, Math.PI]) {
    const window_ = mesh(
      new THREE.CylinderGeometry(0.22, 0.22, 0.16, 12),
      materials.black(),
      Math.cos(a) * 0.98,
      1.5,
      Math.sin(a) * 0.98,
    )
    window_.rotation.z = Math.PI / 2
    g.add(window_)
  }

  // 顶部圆盘气动刹车环 —— 抛伞之后就靠它减速
  const disc = mesh(new THREE.CylinderGeometry(2.2, 1.4, 0.3, 24), materials.metal(), 0, 2.75, 0)
  g.add(disc)
  // 中央天线柱
  g.add(mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.1, 8), materials.metal(), 0, 3.4, 0))
  g.add(mesh(new THREE.SphereGeometry(0.26, 12, 8), materials.copper(), 0, 4.0, 0))
  // 侧面伸出的土壤取样臂
  const arm = mesh(new THREE.BoxGeometry(1.5, 0.12, 0.12), materials.metal(), 1.1, 0.7, 0.5)
  g.add(arm)

  return { group: g, height: 4.2 }
}

// ---- 好奇号 + 空中吊车 -----------------------------------------------------

function skyCrane() {
  const g = new THREE.Group()

  // ── 下降级（悬停在上方）
  const stage = new THREE.Group()
  stage.name = 'descentStage'
  stage.add(mesh(new THREE.BoxGeometry(3.2, 0.9, 3.2), materials.foil(), 0, 0, 0))
  stage.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.8, 12), materials.metal(), 0, 0.6, 0))
  // 四组各两台反推发动机，向外倾斜
  for (const [x, z] of [[1.3, 1.3], [-1.3, 1.3], [1.3, -1.3], [-1.3, -1.3]]) {
    for (const off of [-0.28, 0.28]) {
      const noz = mesh(
        new THREE.CylinderGeometry(0.1, 0.24, 0.6, 10),
        materials.dark(),
        x + off * Math.sign(x) * 0.4,
        -0.65,
        z,
      )
      noz.rotation.z = -Math.sign(x) * 0.28
      stage.add(noz)
    }
  }
  g.add(stage)

  // ── 缆绳（三根）
  const tethers = new THREE.Group()
  tethers.name = 'tethers'
  const tetherMat = new THREE.MeshBasicMaterial({ color: 0xd8d2c4 })
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2
    const t = mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 5), tetherMat, Math.cos(a) * 0.8, -0.5, Math.sin(a) * 0.8)
    tethers.add(t)
  }
  g.add(tethers)

  // ── 好奇号本体
  const rover = new THREE.Group()
  rover.name = 'rover'
  rover.add(mesh(new THREE.BoxGeometry(2.4, 0.75, 1.5), materials.white(), 0, 0, 0))
  // 六个轮子
  for (const x of [-0.95, 0, 0.95]) {
    for (const z of [-0.95, 0.95]) {
      const w = mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.34, 14), materials.dark(), x, -0.55, z)
      w.rotation.x = Math.PI / 2
      rover.add(w)
    }
  }
  // 桅杆与相机头
  rover.add(mesh(new THREE.CylinderGeometry(0.07, 0.07, 1.4, 8), materials.metal(), -0.75, 1.05, 0.4))
  rover.add(mesh(new THREE.BoxGeometry(0.5, 0.24, 0.24), materials.black(), -0.75, 1.8, 0.4))
  // 尾部核电池（带散热片）
  const rtg = mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.7, 12), materials.dark(), 1.35, 0.35, 0)
  rtg.rotation.z = Math.PI / 2
  rover.add(rtg)
  // 机械臂
  const arm = mesh(new THREE.BoxGeometry(1.1, 0.14, 0.14), materials.metal(), -1.4, -0.15, 0.3)
  arm.rotation.z = -0.4
  rover.add(arm)
  // 让 rover 组的原点落在轮子触地点上 —— 否则按「原点贴地」摆放时，
  // 半个车会陷进地里（截图里只看得见白盒子就是这个原因）
  sitOnOrigin(rover)
  g.add(rover)

  return { group: g, height: 3.0, parts: { stage, tethers, rover } }
}

// ---- 惠更斯号 -------------------------------------------------------------

function huygens() {
  const g = new THREE.Group()
  // 扁锥体外壳
  g.add(mesh(new THREE.CylinderGeometry(1.3, 0.55, 0.75, 24), materials.foil(), 0, 0.65, 0))
  g.add(mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.12, 24), materials.metal(), 0, 1.05, 0))
  // 顶部仪器与天线
  g.add(mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.3, 16), materials.white(), 0, 1.25, 0))
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), materials.metal(), 0.6, 1.4, 0))
  // 下方的下视成像窗
  g.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.12, 10), materials.black(), 0.3, 0.28, 0.2))
  return { group: g, height: 1.5 }
}

// ---- 神舟返回舱 -----------------------------------------------------------

function shenzhou() {
  const g = new THREE.Group()
  // 钟形返回舱，大底朝下
  g.add(mesh(new THREE.CylinderGeometry(1.2, 2.2, 2.0, 20), materials.white(), 0, 1.2, 0))
  g.add(mesh(new THREE.CylinderGeometry(2.2, 2.1, 0.25, 20), materials.dark(), 0, 0.15, 0))
  g.add(mesh(new THREE.CylinderGeometry(0.5, 1.2, 0.5, 20), materials.white(), 0, 2.4, 0))
  // 舷窗
  const win = mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.1, 12), materials.black(), 1.35, 1.6, 0)
  win.rotation.z = Math.PI / 2
  g.add(win)
  return { group: g, height: 2.8 }
}

// ---- 通用四腿着陆器（用于虚拟方案） -----------------------------------------

function genericLander() {
  const g = new THREE.Group()
  g.add(mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.9, 8), materials.foil(), 0, 1.5, 0))
  g.add(mesh(new THREE.CylinderGeometry(0.28, 0.55, 0.7, 12), materials.dark(), 0, 0.85, 0))
  addLegs(g, { spread: 3.6, top: 1.5, footY: 0, radius: 0.09, padRadius: 0.42 })
  // 高增益天线
  const dish = mesh(new THREE.SphereGeometry(0.7, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), materials.white(), 0.9, 2.4, 0)
  dish.rotation.z = -0.6
  g.add(dish)
  // 两侧太阳翼
  for (const sx of [-1, 1]) {
    g.add(mesh(new THREE.BoxGeometry(2.2, 0.06, 1.3), materials.solar(), sx * 2.4, 2.0, 0))
  }
  // 仪器桅杆
  g.add(mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.2, 8), materials.metal(), -0.7, 2.5, 0.5))
  g.add(mesh(new THREE.BoxGeometry(0.36, 0.2, 0.2), materials.black(), -0.7, 3.1, 0.5))
  return { group: g, height: 3.2 }
}

// ---- 降落伞 ---------------------------------------------------------------

/**
 * 伞衣贴图：按真实的伞幅（gore）分块生成。
 *
 * MSL / 火星 2020 的伞是「盘-缝-带」（disk-gap-band）构型，伞衣由 80 个伞幅拼成，
 * 染成橙白相间的图案 —— 这个图案不是装饰，是为了从下降影像里判读伞的旋转与摆动。
 * 这里用 Canvas 直接画出径向分块，比贴一张纯色省事也更准。
 */
function createParachuteTexture(gores = 32) {
  if (typeof document === 'undefined') return null
  const size = 512
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')

  ctx.fillStyle = '#efe9dd'
  ctx.fillRect(0, 0, size, size)

  // 径向伞幅：橙白相间
  const cx = size / 2
  for (let i = 0; i < gores; i++) {
    if (i % 2 === 0) continue
    const a0 = (i / gores) * Math.PI * 2
    const a1 = ((i + 1) / gores) * Math.PI * 2
    ctx.fillStyle = '#d4552a'
    ctx.beginPath()
    ctx.moveTo(cx, cx)
    ctx.arc(cx, cx, size, a0, a1)
    ctx.closePath()
    ctx.fill()
  }

  // 同心带：伞衣的加强带，同时打断纯径向的单调感
  ctx.strokeStyle = 'rgba(120, 90, 70, 0.5)'
  for (const r of [0.34, 0.62, 0.86]) {
    ctx.lineWidth = size * 0.012
    ctx.beginPath()
    ctx.arc(cx, cx, size * r * 0.5, 0, Math.PI * 2)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

let parachuteTexture = null

/**
 * 盘-缝-带伞：上方是主伞盘，下面隔一道通气缝，再接一圈伞带。
 * 这个构型是超音速开伞稳定性的关键，也是火星伞最好认的外形。
 */
function createParachute() {
  const g = new THREE.Group()
  if (!parachuteTexture) parachuteTexture = createParachuteTexture()

  const fabric = new THREE.MeshStandardMaterial({
    map: parachuteTexture,
    color: parachuteTexture ? 0xffffff : 0xe8e4dc,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  })

  const RADIUS = 6.4
  const TOP = 18

  // 伞盘：半球顶稍稍压扁，更接近充气后的形状
  const disk = mesh(
    new THREE.SphereGeometry(RADIUS, 48, 20, 0, Math.PI * 2, 0, Math.PI * 0.46),
    fabric,
    0,
    TOP,
    0,
  )
  disk.scale.y = 0.82
  g.add(disk)

  // 通气缝下方的伞带
  const band = mesh(
    new THREE.CylinderGeometry(RADIUS * 0.93, RADIUS * 0.82, RADIUS * 0.34, 48, 1, true),
    fabric,
    0,
    TOP - RADIUS * 0.62,
    0,
  )
  g.add(band)

  // 伞绳：从伞带下缘收拢到探测器
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xd8d2c6 })
  const LINE_COUNT = 16
  const attachY = TOP - RADIUS * 0.8
  for (let i = 0; i < LINE_COUNT; i++) {
    const a = (i / LINE_COUNT) * Math.PI * 2
    const from = new THREE.Vector3(Math.cos(a) * RADIUS * 0.85, attachY, Math.sin(a) * RADIUS * 0.85)
    const to = new THREE.Vector3(0, 2.2, 0)
    const length = from.distanceTo(to)
    const line = mesh(new THREE.CylinderGeometry(0.035, 0.035, length, 4), lineMat)
    line.position.copy(from).add(to).multiplyScalar(0.5)
    line.lookAt(to)
    line.rotateX(Math.PI / 2)
    line.castShadow = false
    g.add(line)
  }
  return g
}

// ---- 气动外壳 -------------------------------------------------------------

/**
 * 进入大气时探测器包在气动外壳里：下方是钝头隔热大底，上方是后盖。
 * 没有这一层的话，「125 km、5.8 km/s、隔热罩 2100 °C」那几步会直接看到裸车，
 * 与解说自相矛盾。无大气天体不会用到它。
 */
function createAeroshell(size = 2.4) {
  const g = new THREE.Group()
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x8a7f72,
    roughness: 0.75,
    metalness: 0.25,
  })
  // 钝头大底：迎风面，被加热到发亮
  const heatShield = new THREE.Mesh(
    new THREE.SphereGeometry(size, 24, 12, 0, Math.PI * 2, Math.PI * 0.62, Math.PI * 0.38),
    new THREE.MeshStandardMaterial({
      color: 0x4a3128,
      roughness: 0.55,
      metalness: 0.2,
      emissive: new THREE.Color(0xff6a20),
      emissiveIntensity: 0.0,
    }),
  )
  heatShield.position.y = size * 0.55
  heatShield.castShadow = true
  g.add(heatShield)

  // 后盖：截锥
  const backshell = new THREE.Mesh(
    new THREE.CylinderGeometry(size * 0.42, size * 0.98, size * 0.72, 24),
    shellMat,
  )
  backshell.position.y = size * 0.92
  backshell.castShadow = true
  g.add(backshell)

  return { group: g, heatShield }
}

// ---- 发动机尾焰 -----------------------------------------------------------

function createPlume() {
  const g = new THREE.Group()
  const mat = new THREE.MeshBasicMaterial({
    color: 0xfff0d0,
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const cone = mesh(new THREE.ConeGeometry(0.55, 3.2, 12, 1, true), mat, 0, -1.6, 0)
  cone.castShadow = false
  g.add(cone)
  return g
}

/** 空中吊车缆绳长度与车相对下降级的初始垂距（米） */
const TETHER_LENGTH = 7.5
const ROVER_OFFSET = 1.2

const BUILDERS = {
  apollo: apolloLM,
  venera,
  skycrane: skyCrane,
  huygens,
  shenzhou,
  generic: genericLander,
}

/**
 * 按类型构建着陆器。返回的对象带有可控的附属件：
 * parachute / plume 可开关，skycrane 还能单独控制缆绳长度。
 */
export function createLander(type = 'generic', options = {}) {
  const build = BUILDERS[type] ?? BUILDERS.generic
  const built = build()
  const root = new THREE.Group()
  root.add(built.group)

  /**
   * 有官方模型时用官方模型替换程序化外形。
   * 先把程序化版本挂上去、再异步替换：网络慢也不会出现空场景。
   */
  // 官方模型由调用方预先加载好后同步传入，setShell 需要知道当前是谁在显示
  let loadedModel = null
  let modelReplaced = false

  if (options.preloadedModel) {
    loadedModel = options.preloadedModel
    if (built.parts?.rover) {
      // 空中吊车：只换车，下降级与缆绳仍是程序化的
      built.parts.rover.clear()
      built.parts.rover.add(loadedModel)
    } else {
      built.group.visible = false
      modelReplaced = true
      root.add(loadedModel)
    }
  }

  const parachute = createParachute()
  parachute.visible = false
  root.add(parachute)

  const plume = createPlume()
  plume.visible = false
  plume.position.y = built.parts?.stage ? 0 : 0.6
  root.add(plume)

  const aeroshell = createAeroshell(options.shellSize ?? Math.max(2.0, built.height * 0.55))
  aeroshell.group.visible = false
  root.add(aeroshell.group)

  // 缆绳一旦切断就不能再被 setTether 重新点亮 —— 时序每帧都会调 setTether，
  // 没有这个标志的话，飞离动画结束后缆绳会重新挂回天上
  let craneReleased = false

  return {
    root,
    height: built.height,
    parts: built.parts ?? null,
    type,
    setParachute(visible) {
      parachute.visible = visible
    },
    setPlume(visible, scale = 1) {
      plume.visible = visible
      plume.scale.setScalar(scale)
    },

    /**
     * 气动外壳。包在里面时本体不可见 —— 真实的进入段本来就看不到探测器。
     * heat 控制大底的受热发光强度。
     */
    setShell(visible, heat = 0) {
      aeroshell.group.visible = visible
      aeroshell.heatShield.material.emissiveIntensity = heat * 2.2
      built.group.visible = !visible && !modelReplaced
      if (loadedModel) loadedModel.visible = !visible
    },
    /** 空中吊车专用：0 = 收拢，1 = 完全放下（约 7.5 m） */
    setTether(t) {
      if (!built.parts) return
      const { tethers, rover } = built.parts
      const drop = TETHER_LENGTH * t
      rover.position.y = -ROVER_OFFSET - drop
      tethers.visible = !craneReleased && t > 0.01
      for (const line of tethers.children) {
        line.scale.y = Math.max(0.001, drop + 1)
        line.position.y = -0.5 - drop / 2
      }
    },

    /** 车轮着地后缆绳被切断，下降级带着剩余燃料飞离（好奇号的真实动作） */
    setCraneRelease(t) {
      if (!built.parts) return
      const { stage, tethers } = built.parts
      if (t > 0.001) craneReleased = true
      tethers.visible = false
      stage.position.y = t * 60
      stage.position.x = t * 42
      stage.rotation.z = -t * 0.5
      stage.visible = t < 0.99
    },

    /** 缆绳完全放下时，车相对 root 的下沉量 —— 用来把 root 抬高，让车正好落在地面 */
    tetherDropAt(t) {
      return built.parts ? ROVER_OFFSET + TETHER_LENGTH * t : 0
    },
  }
}
