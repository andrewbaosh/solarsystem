import './surface.css'
import * as THREE from 'three'

/**
 * 地表 HUD：重力、体重换算、地表温度、日面大小与光照强度，
 * 以及按真实经纬度摆放的着陆点标记标签。
 */

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function formatTemp(range, note) {
  if (!range) return '—'
  const [min, max] = range
  const text = min === max ? `${min} °C` : `${min} ~ ${max} °C`
  return note ? `${text}（${note}）` : text
}

export function createSurfaceHud({ onExit }) {
  const root = document.createElement('div')
  root.className = 'surface-hud'
  root.innerHTML = `
    <div class="surface-panel"></div>
    <button class="surface-exit" type="button">← 返回轨道</button>
    <div class="surface-reticle"></div>
    <div class="surface-lock-prompt">点击进入第一人称　·　WASD 移动　空格 跳跃　Shift 加速</div>
    <div class="marker-card is-hidden">
      <button type="button" title="关闭">✕</button>
      <h4></h4>
      <div class="meta"></div>
      <p></p>
    </div>
  `
  document.body.appendChild(root)

  const panel = root.querySelector('.surface-panel')
  const prompt = root.querySelector('.surface-lock-prompt')
  const card = root.querySelector('.marker-card')
  const reticle = root.querySelector('.surface-reticle')

  root.querySelector('.surface-exit').addEventListener('click', () => onExit())
  card.querySelector('button').addEventListener('click', () => card.classList.add('is-hidden'))
  // 指针锁必须由用户手势触发，转场结束时那次点击早已过期，所以给一个提示按钮
  prompt.addEventListener('click', () => scene?.firstPerson.lock())

  const labels = new Map() // marker → element
  const worldPosition = new THREE.Vector3()
  const projected = new THREE.Vector3()

  let scene = null

  function attach(surfaceScene) {
    scene = surfaceScene
    const info = surfaceScene.info

    panel.innerHTML = [
      `<div class="surface-place">${escapeHtml(info.bodyName)}　地表<small>${escapeHtml(info.siteName)}</small></div>`,
      `<span class="surface-key">重力加速度</span>　<span class="surface-value">${info.gravity.toFixed(2)} m/s²</span>　<span class="surface-hint">地球的 ${(info.gravity / 9.807).toFixed(2)} 倍</span>`,
      `<span class="surface-key">你的体重  </span>　<span class="surface-value">${info.weightKg.toFixed(1)} kg</span>　<span class="surface-hint">地球上 ${info.referenceMassKg} kg 的人</span>`,
      `<span class="surface-key">跳跃高度  </span>　<span class="surface-value">${surfaceScene.firstPerson.getState().jumpHeight.toFixed(2)} m</span>　<span class="surface-hint">滞空 ${surfaceScene.firstPerson.getState().hangTime.toFixed(1)} 秒</span>`,
      `<span class="surface-key">地表温度  </span>　<span class="surface-value">${formatTemp(info.temperatureC, info.temperatureNote)}</span>`,
      `<span class="surface-key">日面视直径</span>　<span class="surface-value">${info.sunAngularDiameterDeg.toFixed(3)}°</span>　<span class="surface-hint">地球所见的 ${(info.sunAngularDiameterRatio * 100).toFixed(0)}%</span>`,
      `<span class="surface-key">太阳辐照度</span>　<span class="surface-value">${info.irradianceWm2.toFixed(0)} W/m²</span>　<span class="surface-hint">地球的 ${(info.irradianceRatio * 100).toFixed(1)}%（1/${(1 / info.irradianceRatio).toFixed(1)}）</span>`,
    ].join('<br>')

    // 着陆点标签
    for (const el of labels.values()) el.remove()
    labels.clear()

    for (const marker of info.markers) {
      const el = document.createElement('div')
      el.className = 'marker-label'
      const distance = marker.withinScene
        ? `${(marker.distanceKm * 1000).toFixed(0)} m`
        : `${marker.distanceKm.toFixed(0)} km`
      el.innerHTML = `${escapeHtml(marker.mission.name)}<small>${escapeHtml(marker.mission.landingSite.name)} · ${distance}</small>`
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        showMission(marker)
      })
      root.appendChild(el)
      labels.set(marker, el)
    }
  }

  function showMission(marker) {
    const m = marker.mission
    card.querySelector('h4').innerHTML = `${escapeHtml(m.name)}<small>${escapeHtml(m.nameEn)}</small>`
    card.querySelector('.meta').textContent =
      `${m.country} · ${m.agency}　发射 ${m.launchDate}　抵达 ${m.arrivalDate}　` +
      `着陆点 ${m.landingSite.lat.toFixed(4)}°, ${m.landingSite.lon.toFixed(4)}°　` +
      (marker.withinScene ? '就在此处' : `距此 ${marker.distanceKm.toFixed(0)} km`)
    card.querySelector('p').textContent = m.description
    card.classList.remove('is-hidden')
  }

  /** 每帧把 3D 标记投影到屏幕上 */
  function update() {
    if (!scene) return
    const camera = scene.camera
    const locked = scene.firstPerson.isLocked()
    prompt.classList.toggle('is-hidden', locked)
    reticle.style.opacity = locked ? '0.55' : '0'

    const w = window.innerWidth
    const h = window.innerHeight
    camera.updateMatrixWorld()
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert()

    for (const [marker, el] of labels) {
      marker.object.getWorldPosition(worldPosition)
      worldPosition.y += marker.withinScene ? 7 : 45
      projected.copy(worldPosition).project(camera)
      const visible = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1
      el.style.display = visible ? '' : 'none'
      if (!visible) continue
      el.style.left = `${(projected.x * 0.5 + 0.5) * w}px`
      el.style.top = `${(-projected.y * 0.5 + 0.5) * h}px`
    }
  }

  function show() {
    root.style.display = ''
  }
  function hide() {
    root.style.display = 'none'
    card.classList.add('is-hidden')
  }
  function dispose() {
    root.remove()
  }

  hide()
  return { attach, update, show, hide, dispose, showMission, element: root }
}
