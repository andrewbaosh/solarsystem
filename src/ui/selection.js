import * as THREE from 'three'

/**
 * 点击拾取天体。
 *
 * 两级命中：
 *  1. Raycaster 直接打球体 —— 近距离时最准；
 *  2. 打空了再做屏幕空间就近匹配 —— 远景下行星只有一两个像素，
 *     光靠 raycast 基本点不中，这一层让「点它旁边」也算数。
 *
 * 另外要把拖动和点击区分开：OrbitControls 的旋转也会以 pointerup 收尾，
 * 不判断位移的话每转一下视角都会误选天体。
 */
const CLICK_MOVE_TOLERANCE = 5 // px
const SCREEN_PICK_RADIUS = 26 // px

export function createSelection({ domElement, camera, bodySystem, onSelect }) {
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  const worldPosition = new THREE.Vector3()
  const projected = new THREE.Vector3()

  let downAt = null

  function pickByRay(x, y) {
    const rect = domElement.getBoundingClientRect()
    pointer.x = ((x - rect.left) / rect.width) * 2 - 1
    pointer.y = -((y - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)

    const meshes = bodySystem.bodies.map((b) => b.mesh)
    const hits = raycaster.intersectObjects(meshes, false)
    if (!hits.length) return null
    return bodySystem.bodies.find((b) => b.mesh === hits[0].object) ?? null
  }

  function pickByScreenDistance(x, y) {
    const rect = domElement.getBoundingClientRect()
    let best = null
    let bestDistance = SCREEN_PICK_RADIUS

    for (const body of bodySystem.bodies) {
      body.group.getWorldPosition(worldPosition)
      projected.copy(worldPosition).project(camera)
      if (projected.z > 1) continue // 在相机背后

      const sx = rect.left + ((projected.x * 0.5 + 0.5) * rect.width)
      const sy = rect.top + ((-projected.y * 0.5 + 0.5) * rect.height)
      const distance = Math.hypot(sx - x, sy - y)
      if (distance < bestDistance) {
        bestDistance = distance
        best = body
      }
    }
    return best
  }

  function onPointerDown(event) {
    downAt = { x: event.clientX, y: event.clientY }
  }

  function onPointerUp(event) {
    if (!downAt) return
    const moved = Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y)
    downAt = null
    if (moved > CLICK_MOVE_TOLERANCE) return // 这是一次拖动，不是点击

    const body = pickByRay(event.clientX, event.clientY) ?? pickByScreenDistance(event.clientX, event.clientY)
    onSelect(body) // 点空则传 null，由调用方决定是否取消跟随
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)

  return {
    dispose() {
      domElement.removeEventListener('pointerdown', onPointerDown)
      domElement.removeEventListener('pointerup', onPointerUp)
    },
  }
}
