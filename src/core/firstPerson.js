import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

/**
 * 地表第一人称控制。
 *
 * 重力直接用该天体的真实表面重力（m/s²），跳跃给的是固定的起跳速度，
 * 于是跳跃高度 h = v²/(2g)、滞空时间 t = 2v/g 都由重力自然决定，
 * 不需要另外为每颗星球调参 —— 月球上 1.62 m/s² 跳起来会明显飘，
 * 那是公式算出来的，不是手调的手感。
 *
 * 视角有两条路：
 *  1. 指针锁（首选，体验最好）
 *  2. 按住左键拖动（兜底）—— 指针锁会因浏览器策略、iframe 嵌入、
 *     权限设置等原因失败，只绑指针锁的话一旦失败就彻底动不了。
 * 移动（WASD/跳跃）只要处于第一人称就一直可用，不再依赖锁定状态。
 */

const EYE_HEIGHT = 1.7 // 米
const WALK_SPEED = 3.2 // m/s
const SPRINT_MULTIPLIER = 2.4
const JUMP_VELOCITY = 4.2 // m/s，固定起跳速度
const DRAG_SENSITIVITY = 0.0022
const PITCH_LIMIT = Math.PI / 2 - 0.05

export function createFirstPerson({ camera, domElement, heightAt, gravity, bounds }) {
  const controls = new PointerLockControls(camera, domElement)
  const player = controls.object ?? controls.getObject()

  const keys = new Set()
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()
  const move = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'YXZ')
  const UP = new THREE.Vector3(0, 1, 0)

  let active = false // 是否已交接到第一人称
  let onGround = true
  let verticalVelocity = 0
  let dragging = false
  let lastX = 0
  let lastY = 0
  let pointerLockFailed = false

  // ---- 输入 ----------------------------------------------------------------

  const onKeyDown = (e) => {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return
    keys.add(e.code)
    if (e.code === 'Space') {
      e.preventDefault()
      if (onGround) {
        verticalVelocity = JUMP_VELOCITY
        onGround = false
      }
    }
  }
  const onKeyUp = (e) => keys.delete(e.code)

  /** 拖动看视角：只在没有指针锁时接管 */
  const onPointerDown = (e) => {
    if (!active || controls.isLocked || e.button !== 0) return
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
  }
  const onPointerMove = (e) => {
    if (!dragging || controls.isLocked) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    euler.setFromQuaternion(camera.quaternion)
    euler.y -= dx * DRAG_SENSITIVITY
    euler.x = THREE.MathUtils.clamp(euler.x - dy * DRAG_SENSITIVITY, -PITCH_LIMIT, PITCH_LIMIT)
    euler.z = 0
    camera.quaternion.setFromEuler(euler)
  }
  const onPointerUp = () => {
    dragging = false
  }

  const onLockError = () => {
    pointerLockFailed = true
    console.warn('[firstPerson] 指针锁不可用，已回退到拖动视角')
  }

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  domElement.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  document.addEventListener('pointerlockerror', onLockError)

  // ---- 状态 ----------------------------------------------------------------

  function spawn(x = 0, z = 0) {
    player.position.set(x, heightAt(x, z) + EYE_HEIGHT, z)
    verticalVelocity = 0
    onGround = true
  }

  function activate() {
    active = true
  }

  function update(dt) {
    if (!active) return
    const step = Math.min(dt, 0.05) // 掉帧/切标签页时别让玩家穿地

    camera.getWorldDirection(forward)
    forward.y = 0
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1)
    forward.normalize()
    right.crossVectors(forward, UP).normalize()

    move.set(0, 0, 0)
    if (keys.has('KeyW')) move.add(forward)
    if (keys.has('KeyS')) move.sub(forward)
    if (keys.has('KeyD')) move.add(right)
    if (keys.has('KeyA')) move.sub(right)

    if (move.lengthSq() > 0) {
      move.normalize()
      const speed =
        WALK_SPEED * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? SPRINT_MULTIPLIER : 1)
      player.position.addScaledVector(move, speed * step)
    }

    // 竖直方向：自由落体 + 落地判定
    verticalVelocity -= gravity * step
    player.position.y += verticalVelocity * step

    const groundY = heightAt(player.position.x, player.position.z) + EYE_HEIGHT
    if (player.position.y <= groundY) {
      player.position.y = groundY
      verticalVelocity = 0
      onGround = true
    } else {
      onGround = false
    }

    if (bounds) {
      const limit = bounds / 2 - 20
      player.position.x = THREE.MathUtils.clamp(player.position.x, -limit, limit)
      player.position.z = THREE.MathUtils.clamp(player.position.z, -limit, limit)
    }
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    domElement.removeEventListener('pointerdown', onPointerDown)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    document.removeEventListener('pointerlockerror', onLockError)
    controls.disconnect?.()
    controls.dispose?.()
  }

  return {
    controls,
    player,
    update,
    spawn,
    activate,
    dispose,
    isActive: () => active,
    isLocked: () => controls.isLocked,
    /** 指针锁失败过就别再提示「点击锁定」，改提示拖动 */
    lockUnavailable: () => pointerLockFailed,
    lock: () => {
      try {
        controls.lock()
      } catch {
        pointerLockFailed = true
      }
    },
    unlock: () => controls.unlock(),
    getState: () => ({
      position: player.position,
      onGround,
      verticalVelocity,
      jumpHeight: (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * gravity),
      hangTime: (2 * JUMP_VELOCITY) / gravity,
    }),
  }
}
