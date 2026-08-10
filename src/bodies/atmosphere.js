import * as THREE from 'three'

/**
 * 大气边缘辉光（Fresnel）。
 *
 * 做法是在本体外面套一层略大的球壳，只渲染背面（side: BackSide）：
 * 这样球壳不会挡住本体，也不会跟本体的表面 z-fighting，
 * 叠加混合后只在轮廓边缘留下一圈光晕。
 *
 * 注意背面渲染时法线仍然朝外、也就是背对相机，所以边缘因子要取
 * 1 - |dot(N, V)|：正对相机处 |dot| ≈ 1 → 0（中心透明），
 * 轮廓处 |dot| ≈ 0 → 1（边缘最亮）。少了绝对值就会反过来糊成一坨。
 */
const vertexShader = /* glsl */ `
  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vWorldNormal = normalize( mat3( modelMatrix ) * normal );
    vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uSunPosition;
  uniform float uIntensity;
  uniform float uPower;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;

  void main() {
    vec3 normal = normalize( vWorldNormal );
    vec3 viewDir = normalize( cameraPosition - vWorldPosition );
    float rim = 1.0 - abs( dot( normal, viewDir ) );

    // 只有被照亮的一侧才有辉光，夜侧留一点余量当作大气散射
    // 过渡区收窄一点，否则夜侧边缘也亮得跟白天一样，整圈看着像描边
    vec3 sunDir = normalize( uSunPosition - vWorldPosition );
    float lit = smoothstep( -0.08, 0.45, dot( normal, sunDir ) );

    // 夜侧只留很小的余量：给满了会变成一圈均匀描边，不像大气散射
    float alpha = pow( rim, uPower ) * uIntensity * ( 0.05 + 0.95 * lit );
    gl_FragColor = vec4( uColor, clamp( alpha, 0.0, 1.0 ) );
  }
`

export function createAtmosphere(config) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color(config.color) },
      uSunPosition: { value: new THREE.Vector3() },
      uIntensity: { value: config.intensity ?? 1 },
      uPower: { value: config.power ?? 3 },
    },
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  })

  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), material)
  mesh.renderOrder = 1
  return mesh
}
