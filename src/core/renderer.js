import * as THREE from 'three'

/**
 * 渲染器与相机。
 *
 * 太阳系的尺度跨度是 1e-3 ~ 1e12 场景单位，普通深度缓冲必然 z-fighting，
 * 所以 logarithmicDepthBuffer 是硬要求，near/far 也必须开到极限。
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.0
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  return renderer
}

export function createCamera() {
  const camera = new THREE.PerspectiveCamera(
    55,
    Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight),
    0.001,
    1e12,
  )
  camera.position.set(0, 260, 620)
  return camera
}

export function handleResize(renderer, camera) {
  const onResize = () => {
    // 窗口/画布高度为 0 时（标签页隐藏、面板折叠）aspect 会变成 NaN，
    // 投影矩阵一旦被污染，之后所有投影和拾取都会算出 NaN
    const width = Math.max(1, window.innerWidth)
    const height = Math.max(1, window.innerHeight)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height)
  }
  window.addEventListener('resize', onResize)
  return onResize
}
