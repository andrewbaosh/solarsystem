import './labels.css'
import * as THREE from 'three'

/**
 * 天体名称标签（中英文），HTML overlay，不在 canvas 内绘制。
 *
 * 每帧把天体世界坐标投影到屏幕，再把标签挪到球体正上方。
 * 文案全部来自 data/*.json，引擎不硬编码任何天体名字。
 */

const MARGIN = 48 // 出屏多少像素后就不再更新
const GAP = 6 // 球体顶端到标签底部的额外留白

export function createLabels(bodies, camera) {
  const container = document.createElement('div')
  container.className = 'labels'
  document.body.appendChild(container)

  const items = bodies.map((body) => {
    const el = document.createElement('div')
    el.className = 'label'
    el.innerHTML =
      `<span class="label-cn">${body.data.name}</span>` +
      `<span class="label-en">${body.data.nameEn ?? ''}</span>`
    container.appendChild(el)
    return { body, el, visible: true }
  })

  // 唯一可能挡住别人的天体就是恒星，按 type 取，不认具体 id
  const occluders = bodies.filter((b) => b.data.type === 'star')

  const worldPos = new THREE.Vector3()
  const camPos = new THREE.Vector3()
  const toBody = new THREE.Vector3()
  const toOccluder = new THREE.Vector3()
  const closest = new THREE.Vector3()
  const occluderPos = new THREE.Vector3()

  /** 天体是否被恒星挡在后面（相机 → 天体 的线段是否穿过恒星球体） */
  function isOccluded(body, bodyDistance) {
    for (const o of occluders) {
      if (o === body) continue
      o.group.getWorldPosition(occluderPos)
      toOccluder.subVectors(occluderPos, camPos)
      const along = toOccluder.dot(toBody) // toBody 已归一化
      if (along <= 0 || along >= bodyDistance) continue // 恒星在背后或在天体之后
      closest.copy(camPos).addScaledVector(toBody, along)
      if (closest.distanceTo(occluderPos) < o.sceneRadius) return true
    }
    return false
  }

  function update() {
    // 投影用的是 matrixWorldInverse，这里显式刷新，避免依赖 render 的调用顺序
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
    camera.getWorldPosition(camPos)

    const w = window.innerWidth
    const h = window.innerHeight
    // 每像素对应的角度，用来把场景半径换算成屏幕半径
    const pxPerRadian = h / (2 * Math.tan((camera.fov * Math.PI) / 360))

    for (const item of items) {
      const { body, el } = item
      body.group.getWorldPosition(worldPos)

      toBody.subVectors(worldPos, camPos)
      const distance = toBody.length()
      toBody.divideScalar(distance || 1)

      worldPos.project(camera)

      const x = (worldPos.x * 0.5 + 0.5) * w
      const y = (-worldPos.y * 0.5 + 0.5) * h

      // 屏幕半径：近似 r/d 弧度换算成像素；贴到表面时会变得很大
      const screenRadius = (body.sceneRadius / distance) * pxPerRadian

      const show =
        worldPos.z < 1 && // 在相机前方
        x > -MARGIN &&
        x < w + MARGIN &&
        y > -MARGIN &&
        y < h + MARGIN &&
        screenRadius < h * 0.5 && // 已经糊满屏幕时就没必要标注了
        !isOccluded(body, distance)

      if (show !== item.visible) {
        el.style.display = show ? '' : 'none'
        item.visible = show
      }
      if (!show) continue

      el.style.transform = `translate(-50%, -100%) translate3d(${x.toFixed(1)}px, ${(
        y - screenRadius - GAP
      ).toFixed(1)}px, 0)`
    }
  }

  function setVisible(next) {
    container.style.display = next ? '' : 'none'
  }

  return { update, setVisible }
}
