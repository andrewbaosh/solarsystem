import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

/**
 * 后处理：只做辉光。
 *
 * 阈值调得比较高（0.72），只有太阳这种明确过曝的地方才进入 bloom，
 * 行星与星空不会被拖进去发糊。OutputPass 负责色调映射与 sRGB 转换，
 * 所以 renderer 上的 toneMapping 设置仍然生效，不需要在这里重复。
 */
export function createComposer(renderer, scene, camera, options = {}) {
  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  composer.setSize(window.innerWidth, window.innerHeight)

  composer.addPass(new RenderPass(scene, camera))

  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    options.strength ?? 0.55,
    options.radius ?? 0.4,
    options.threshold ?? 0.72,
  )
  composer.addPass(bloom)
  composer.addPass(new OutputPass())

  function setSize(width, height) {
    composer.setSize(width, height)
    bloom.setSize(width, height)
  }

  return { composer, bloom, setSize }
}
