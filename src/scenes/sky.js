import * as THREE from 'three'
import { loadColorTexture } from '../core/textures.js'

/**
 * 地表天空。
 *
 * 两种类型：
 *  - atmosphere：有大气，天顶到地平线做颜色渐变，太阳周围有辉光。
 *    火星的锈红、金星的昏黄、土卫六的橙雾都由 data 里的两个颜色 + 散射强度决定。
 *  - space：无大气，天空是纯黑的，星星在白天也照样看得见 ——
 *    这正是月面照片里天空全黑的原因，不是曝光问题。
 */

const vertexShader = /* glsl */ `
  varying vec3 vDirection;
  void main() {
    vDirection = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uZenith;
  uniform vec3 uSunDirection;
  uniform float uScattering;
  uniform float uSunAngularRadius;

  varying vec3 vDirection;

  void main() {
    vec3 dir = normalize( vDirection );

    // 天顶到地平线的渐变。用 pow 收束，让靠近地平线的一段更厚，
    // 模拟视线穿过大气的路径变长
    float height = clamp( dir.y, -1.0, 1.0 );
    float t = pow( clamp( 1.0 - height, 0.0, 1.0 ), mix( 1.2, 3.0, uScattering ) );
    vec3 color = mix( uZenith, uHorizon, t );

    // 太阳周围的前向散射光晕，大气越厚散得越开
    float cosAngle = dot( dir, normalize( uSunDirection ) );
    float halo = pow( max( cosAngle, 0.0 ), mix( 220.0, 12.0, uScattering ) );
    color += uHorizon * halo * uScattering * 1.6;

    // 日面本体
    float disc = smoothstep( cos( uSunAngularRadius * 2.2 ), cos( uSunAngularRadius ), cosAngle );
    color += vec3( 1.0, 0.96, 0.9 ) * disc * 3.0;

    // 地平线以下压暗，避免天空球在地面边缘露出亮边
    color *= smoothstep( -0.28, 0.02, height ) * 0.85 + 0.15;

    gl_FragColor = vec4( color, 1.0 );
  }
`

export function createSky(config, { sunDirection, sunAngularRadiusRad }) {
  const geometry = new THREE.SphereGeometry(6000, 48, 32)

  if (config.type === 'space') {
    // 无大气：黑天 + 真实星图，白天也看得见星星
    const texture = loadColorTexture(config.starMap ?? '2k_stars_milky_way.jpg')
    texture.mapping = THREE.EquirectangularReflectionMapping
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      color: new THREE.Color().setScalar(config.starBrightness ?? 0.5),
      toneMapped: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    return { mesh, update() {} }
  }

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uHorizon: { value: new THREE.Color(config.horizon ?? '#d9a07a') },
      uZenith: { value: new THREE.Color(config.zenith ?? '#6b4a3a') },
      uSunDirection: { value: sunDirection.clone() },
      uScattering: { value: config.scattering ?? 0.5 },
      uSunAngularRadius: { value: sunAngularRadiusRad },
    },
    side: THREE.BackSide,
    depthWrite: false,
    toneMapped: true,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.renderOrder = -1

  return {
    mesh,
    update(nextSunDirection) {
      material.uniforms.uSunDirection.value.copy(nextSunDirection)
    },
  }
}
