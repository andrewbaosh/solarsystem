import * as THREE from 'three'

/**
 * 行星环几何体。
 *
 * RingGeometry 自带的 UV 是把整个环当成一个正方形来铺的（u、v 都按 xy 位置线性映射），
 * 贴上径向条带贴图会沿半径方向被拉成放射状。这里重写 UV：
 *   u = 该顶点到中心的距离在 [inner, outer] 上的归一化位置
 *   v = 常数（条带贴图纵向是均匀的）
 * 于是贴图的 2048 个像素正好对应从 C 环内缘到 A 环外缘。
 */
export function createRingGeometry(innerRadius, outerRadius, segments = 256) {
  const geometry = new THREE.RingGeometry(innerRadius, outerRadius, segments, 1)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv
  const v = new THREE.Vector3()

  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i)
    const radial = (v.length() - innerRadius) / (outerRadius - innerRadius)
    uv.setXY(i, THREE.MathUtils.clamp(radial, 0, 1), 0.5)
  }
  uv.needsUpdate = true

  // RingGeometry 建在 XY 平面上，转到 XZ 平面才是赤道面；
  // 它会被挂到 tilt 组下，于是自动随自转轴倾角一起倾斜、始终垂直于自转轴。
  geometry.rotateX(-Math.PI / 2)
  return geometry
}
