import * as THREE from 'three'

/**
 * 贴图加载。
 *
 * 色彩空间必须分清楚：颜色类贴图（漫反射、夜面灯光、星空）是 sRGB 编码的，
 * 数据类贴图（法线、alpha）是线性的，混了会导致光照发灰或法线方向错误。
 */

// verify 脚本在 Node 里跑同一套 bodySystem，那边没有 DOM 也不需要贴图，
// 所以这里做降级：无 DOM 时一律返回空白贴图，轨道/自转的校验不受影响。
const HAS_DOM = typeof document !== 'undefined'
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'textures/'
const textureLoader = HAS_DOM ? new THREE.TextureLoader() : null
const imageLoader = HAS_DOM ? new THREE.ImageLoader() : null

let maxAnisotropy = 4
let pending = 0
const listeners = new Set()

export function initTextures(renderer) {
  maxAnisotropy = renderer.capabilities.getMaxAnisotropy()
}

export function onTexturesSettled(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function track(promiseLike) {
  pending++
  return () => {
    pending--
    if (pending === 0) listeners.forEach((fn) => fn())
  }
}

function configure(texture, { srgb }) {
  texture.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace
  texture.anisotropy = maxAnisotropy
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  return texture
}

/** 颜色贴图（漫反射 / 自发光 / 星空） */
export function loadColorTexture(file) {
  if (!HAS_DOM) return configure(new THREE.Texture(), { srgb: true })
  const done = track()
  const texture = textureLoader.load(BASE + file, done, undefined, done)
  return configure(texture, { srgb: true })
}

/** 数据贴图（法线 / alpha） */
export function loadDataTexture(file) {
  if (!HAS_DOM) return configure(new THREE.Texture(), { srgb: false })
  const done = track()
  const texture = textureLoader.load(BASE + file, done, undefined, done)
  return configure(texture, { srgb: false })
}

/**
 * 从漫反射图的亮度用 Sobel 算子生成法线图。
 *
 * ⚠️ 这不是真实地形高程：Solar System Scope 的贴图包只提供了地球的法线图，
 * 月球和火星没有。反照率不等于高度（火星的暗区是玄武岩而非洼地），
 * 所以这里只是视觉近似，要考证级地形得换 LOLA / MOLA 高程数据。
 */
export function loadDerivedNormalMap(file, strength = 1) {
  // 先给一张 1×1 的平坦法线占位，图片解码完再替换，避免首帧材质缺贴图
  const texture = new THREE.DataTexture(
    new Uint8Array([128, 128, 255, 255]),
    1,
    1,
    THREE.RGBAFormat,
  )
  texture.needsUpdate = true
  configure(texture, { srgb: false })
  if (!HAS_DOM) return texture

  const done = track()
  imageLoader.load(
    BASE + file,
    (image) => {
      const { data, width, height } = sobelToNormals(image, strength)
      texture.image = { data, width, height }
      texture.needsUpdate = true
      done()
    },
    undefined,
    done,
  )
  return texture
}

function sobelToNormals(image, strength) {
  const canvas = document.createElement('canvas')
  const width = image.width
  const height = image.height
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0)
  const src = ctx.getImageData(0, 0, width, height).data

  // 先取亮度当作高度场
  const heightField = new Float32Array(width * height)
  for (let i = 0; i < width * height; i++) {
    heightField[i] =
      (0.2126 * src[i * 4] + 0.7152 * src[i * 4 + 1] + 0.0722 * src[i * 4 + 2]) / 255
  }

  // 等距圆柱投影：横向是环绕的，纵向到边界就夹住
  const at = (x, y) => {
    const xx = (x + width) % width
    const yy = Math.min(height - 1, Math.max(0, y))
    return heightField[yy * width + xx]
  }

  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx =
        at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
      const dy =
        at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))

      let nx = dx * strength
      let ny = dy * strength
      const nz = 1
      const inv = 1 / Math.hypot(nx, ny, nz)
      nx *= inv
      ny *= inv

      const i = (y * width + x) * 4
      out[i] = (nx * 0.5 + 0.5) * 255
      out[i + 1] = (ny * 0.5 + 0.5) * 255
      out[i + 2] = nz * inv * 255
      out[i + 3] = 255
    }
  }
  return { data: out, width, height }
}
