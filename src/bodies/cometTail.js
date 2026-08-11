import * as THREE from 'three'

/**
 * 彗星的可见部分：彗发 + 离子尾 + 尘埃尾。
 *
 * 之前这里是一个圆锥体，看起来像一道激光。真实彗星的结构是这样的：
 *
 *   彗核    几公里的脏雪球，反照率 0.04，比煤还黑。你其实看不见它。
 *   彗发    彗核周围被太阳晒出来的气体尘埃包层，直径可达十万公里以上 ——
 *           肉眼看到的「彗星的头」是它，不是彗核。C₂ 分子的荧光让它偏绿。
 *   离子尾  太阳风把电离的气体吹成一条**笔直**的尾巴，严格背离太阳，
 *           CO⁺ 的荧光让它偏蓝，又细又长，可以拖出上亿公里。
 *   尘埃尾  尘埃颗粒离开彗核后各自保留原来的轨道角动量，于是**落在后面**，
 *           被辐射压慢慢推开 —— 尾巴因此是**弯的**，颜色是反射阳光的黄白色，
 *           比离子尾更宽更短。
 *
 * 两条尾巴的颜色与弯曲差别，是照片上一眼能认出彗星的原因。
 *
 * 实现上两条尾都是「在顶点着色器里做广告牌的带状体」：几何体是一条平面带，
 * 每帧由着色器把它的宽度方向摆到垂直于视线，于是从任何角度看都是软的一片，
 * 没有多边形轮廓。尘埃尾的弯曲用一条二次曲线表达：
 *
 *   pos(t) = 背日方向 · L · t  +  反速度方向 · L · curve · t²
 *
 * t=0 处切线正是背日方向，随 t 增大逐渐偏向轨迹后方 —— 与真实的
 * syndyne 曲线同形。
 *
 * 本文件不含任何具体彗星的数值，全部由 data/small-bodies.json 传入。
 */

const SEGMENTS = 48

const TAIL_VERTEX = /* glsl */ `
  uniform vec3 uAntiSun;      // 背日方向（本地坐标系，已归一化）
  uniform vec3 uAntiVelocity; // 轨迹后方（本地坐标系，已归一化）
  uniform float uLength;      // 尾长，场景单位
  uniform float uWidth;       // 根部半宽，场景单位
  uniform float uCurve;       // 弯曲量：0 = 笔直的离子尾
  uniform float uFlare;       // 尾巴向外张开的程度

  attribute float aT;         // 沿尾长的参数 0..1
  attribute float aSide;      // 带宽方向 -1..1

  varying float vT;
  varying float vSide;

  void main() {
    vT = aT;
    vSide = aSide;

    // 轴线：起点切线是背日方向，随 t 弯向轨迹后方
    vec3 axis = uAntiSun * (uLength * aT) + uAntiVelocity * (uLength * uCurve * aT * aT);
    // 切线用于确定带宽方向，保证宽度始终垂直于尾巴自身
    vec3 tangent = normalize(uAntiSun + uAntiVelocity * (2.0 * uCurve * aT) + vec3(1e-6));

    vec4 originView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 axisView = modelViewMatrix * vec4(axis, 1.0);
    vec3 tangentView = normalize((modelViewMatrix * vec4(tangent, 0.0)).xyz);

    // 广告牌：宽度方向同时垂直于尾巴切线和视线
    vec3 toEye = normalize(-axisView.xyz);
    vec3 side = normalize(cross(tangentView, toEye) + vec3(1e-6));

    // 尾巴离彗核越远越宽，模仿真实的张角
    float halfWidth = uWidth * (1.0 + uFlare * aT);
    vec3 p = axisView.xyz + side * (aSide * halfWidth);

    gl_Position = projectionMatrix * vec4(p, 1.0);
  }
`

const TAIL_FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uFalloff;   // 沿长度的衰减指数

  varying float vT;
  varying float vSide;

  void main() {
    // 横向：中间亮、边缘为 0 —— 软边靠这一项，不靠几何体轮廓
    float across = 1.0 - vSide * vSide;
    across *= across;
    // 纵向：密度随距离衰减，尾梢化开
    float along = pow(max(0.0, 1.0 - vT), uFalloff);
    float a = across * along * uOpacity;
    if (a < 0.002) discard;
    gl_FragColor = vec4(uColor * a, a);
  }
`

/** 一条尾巴：带状几何体 + 广告牌着色器 */
function createTail(spec) {
  const positions = new Float32Array((SEGMENTS + 1) * 2 * 3) // 只占位，实际位置在着色器里算
  const aT = new Float32Array((SEGMENTS + 1) * 2)
  const aSide = new Float32Array((SEGMENTS + 1) * 2)
  const indices = []

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS
    aT[i * 2] = t
    aT[i * 2 + 1] = t
    aSide[i * 2] = -1
    aSide[i * 2 + 1] = 1
    if (i < SEGMENTS) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aT', new THREE.BufferAttribute(aT, 1))
  geometry.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1))
  geometry.setIndex(indices)
  // 位置由着色器决定，包围球没有意义，直接放大免得被误剔除
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)

  const material = new THREE.ShaderMaterial({
    vertexShader: TAIL_VERTEX,
    fragmentShader: TAIL_FRAGMENT,
    uniforms: {
      uAntiSun: { value: new THREE.Vector3(0, 0, 1) },
      uAntiVelocity: { value: new THREE.Vector3(0, 0, 1) },
      uLength: { value: 0 },
      uWidth: { value: 0 },
      uCurve: { value: spec.curve ?? 0 },
      uFlare: { value: spec.flare ?? 1.6 },
      uColor: { value: new THREE.Color(spec.color) },
      uOpacity: { value: 0 },
      uFalloff: { value: spec.falloff ?? 1.6 },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  mesh.renderOrder = 3
  return mesh
}

/**
 * 彗发：一张始终朝向相机的径向渐变贴图。
 * 彗发本来就是各向同性的球状包层，用广告牌表达没有信息损失，
 * 而且比半透明球壳更软、更不容易露出几何边缘。
 */
function comaTexture(size = 128) {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  // 中心近乎不透明，外缘平滑到零；中段刻意压得比线性快，做出「核心亮、外围雾」的层次
  g.addColorStop(0.0, 'rgba(255,255,255,1)')
  g.addColorStop(0.08, 'rgba(255,255,255,0.82)')
  g.addColorStop(0.25, 'rgba(255,255,255,0.34)')
  g.addColorStop(0.55, 'rgba(255,255,255,0.09)')
  g.addColorStop(1.0, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

let sharedComaTexture = null

/**
 * 造一套彗星的可见结构。
 * @param spec data/small-bodies.json 里该彗星的 coma / ionTail / dustTail 字段
 */
export function createCometVisuals(spec = {}) {
  const group = new THREE.Group()
  group.name = 'comet-visuals'

  let coma = null
  if (spec.coma) {
    sharedComaTexture ??= comaTexture()
    coma = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sharedComaTexture,
        color: new THREE.Color(spec.coma.color ?? '#cfe9d8'),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        opacity: 0,
      }),
    )
    coma.renderOrder = 2
    group.add(coma)
  }

  const ion = spec.ionTail ? createTail({ ...spec.ionTail, curve: 0 }) : null
  const dust = spec.dustTail ? createTail(spec.dustTail) : null
  if (dust) group.add(dust) // 尘埃尾先画，离子尾叠在上面
  if (ion) group.add(ion)

  /**
   * @param activity   0..1 的活跃度，由日距决定
   * @param antiSun    背离太阳的单位向量（本地坐标系）
   * @param antiVel    轨迹后方的单位向量（本地坐标系）
   * @param toScene    km → 场景单位 的换算函数
   */
  function update({ activity, antiSun, antiVel, toSceneLength, toSceneSize }) {
    if (coma) {
      const r = toSceneSize(spec.coma.radiusKm * (0.25 + 0.75 * activity))
      coma.scale.setScalar(Math.max(r, 1e-4) * 2)
      coma.material.opacity = Math.min(1, spec.coma.opacity ?? 0.9) * activity
      coma.visible = activity > 0.002
    }
    for (const [tail, s] of [
      [ion, spec.ionTail],
      [dust, spec.dustTail],
    ]) {
      if (!tail) continue
      const u = tail.material.uniforms
      u.uAntiSun.value.copy(antiSun)
      u.uAntiVelocity.value.copy(antiVel)
      u.uLength.value = toSceneLength(s.lengthKm * activity)
      u.uWidth.value = toSceneSize(s.widthKm)
      u.uOpacity.value = (s.opacity ?? 0.5) * activity
      tail.visible = activity > 0.004
    }
  }

  function dispose() {
    for (const t of [ion, dust]) {
      if (!t) continue
      t.geometry.dispose()
      t.material.dispose()
    }
    coma?.material.dispose()
  }

  return { group, update, dispose, coma, ion, dust }
}
