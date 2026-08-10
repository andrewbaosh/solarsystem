import * as THREE from 'three'
import { loadColorTexture, loadDataTexture, loadDerivedNormalMap } from '../core/textures.js'

/**
 * 材质构建：全部由 data/*.json 的 textures 字段驱动，引擎不认具体天体。
 */

/** 恒星：自发光，不参与光照 */
export function createStarMaterial(data) {
  const material = new THREE.MeshBasicMaterial({
    color: new THREE.Color(data.color),
    toneMapped: true,
  })
  if (data.textures?.map) {
    material.map = loadColorTexture(data.textures.map)
    // 贴图自带颜色，本体色只留一点点提亮，用来把太阳推到 bloom 阈值之上
    material.color.setRGB(1.25, 1.2, 1.1)
  }
  return material
}

/** 行星 / 卫星：受光照 */
export function createBodyMaterial(data) {
  const tex = data.textures ?? {}
  const material = new THREE.MeshStandardMaterial({
    color: tex.map ? 0xffffff : new THREE.Color(data.color),
    roughness: 1,
    metalness: 0,
  })

  if (tex.map) material.map = loadColorTexture(tex.map)
  if (tex.normalMap) material.normalMap = loadDataTexture(tex.normalMap)
  else if (tex.derivedNormalFrom) {
    material.normalMap = loadDerivedNormalMap(tex.derivedNormalFrom, tex.derivedNormalStrength ?? 1)
  }
  if (material.normalMap) material.normalScale = new THREE.Vector2(0.8, 0.8)

  if (tex.emissiveMap) {
    material.emissiveMap = loadColorTexture(tex.emissiveMap)
    material.emissive = new THREE.Color(0xffffff)
    material.emissiveIntensity = 1.1
    applyNightSideOnly(material)
  }

  return material
}

/**
 * 夜面灯光只在背光面亮。
 *
 * emissiveMap 默认是无条件叠加的，白天也会亮，看着像贴了一层脏东西。
 * 这里改 shader：按片元法线与太阳方向的夹角把自发光压掉。
 * pointLights[0].position 是视空间坐标，片元视空间位置是 -vViewPosition，
 * 所以指向光源的方向是 normalize(pointLights[0].position + vViewPosition)。
 */
function applyNightSideOnly(material) {
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      #if NUM_POINT_LIGHTS > 0
        vec3 sunDirView = normalize( pointLights[ 0 ].position + vViewPosition );
        float dayness = dot( normal, sunDirView );
        // 晨昏线上做一段平滑过渡，避免灯光边缘出现硬切
        totalEmissiveRadiance *= 1.0 - smoothstep( -0.10, 0.22, dayness );
      #endif`,
    )
  }
  material.customProgramCacheKey = () => 'night-side-emissive'
}

/** 云层：灰度图当 alpha，本身受光照 */
export function createCloudMaterial(cloudLayer) {
  return new THREE.MeshStandardMaterial({
    color: 0xffffff,
    alphaMap: loadDataTexture(cloudLayer.map),
    transparent: true,
    depthWrite: false,
    roughness: 1,
    metalness: 0,
  })
}

/**
 * 土星环：带 alpha 的径向条带贴图 + 解析求解的行星投影。
 *
 * 为什么不用 MeshStandardMaterial 接 shadowMap：环是一张几乎与光线共面的薄片，
 * 朗伯着色下 dot(N,L)≈0 会把它压成全黑。真实的环是无数颗粒各向散射，
 * 本来就不该按平面朗伯体来算。
 *
 * 所以材质保持不受光照，另外解析地算「该片元是否落在土星的影锥里」：
 * 点光源 + 球体的本影就是一条射线与球的相交测试，比 shadowMap 更准也更便宜，
 * 还顺带避开了点光源立方阴影图在这个尺度下的精度问题。
 */
export function createRingMaterial(ring) {
  const map = loadColorTexture(ring.map)
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: map },
      uSunPosition: { value: new THREE.Vector3() },
      uPlanetCenter: { value: new THREE.Vector3() },
      uPlanetRadius: { value: 1 },
      uShadowFloor: { value: 0.16 }, // 影子里残留的环境散射，全黑会显得很假
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        vec4 worldPosition = modelMatrix * vec4( position, 1.0 );
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uSunPosition;
      uniform vec3 uPlanetCenter;
      uniform float uPlanetRadius;
      uniform float uShadowFloor;

      varying vec2 vUv;
      varying vec3 vWorldPosition;

      void main() {
        vec4 texel = texture2D( uMap, vUv );

        // 从太阳射向该片元的光线，是否在到达之前先被土星本体挡住
        vec3 toFragment = vWorldPosition - uSunPosition;
        float fragmentDistance = length( toFragment );
        vec3 rayDir = toFragment / fragmentDistance;

        float along = dot( uPlanetCenter - uSunPosition, rayDir );
        vec3 closest = uSunPosition + rayDir * along;
        float missDistance = distance( closest, uPlanetCenter );

        // 只有当土星在太阳与片元之间时才可能遮挡；边缘做一点软化当半影
        float blocked = step( 0.0, along ) * step( along, fragmentDistance );
        float umbra = 1.0 - smoothstep( uPlanetRadius * 0.97, uPlanetRadius * 1.03, missDistance );
        float shade = mix( 1.0, uShadowFloor, blocked * umbra );

        gl_FragColor = vec4( texel.rgb * shade, texel.a );
      }
    `,
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
  })
}
