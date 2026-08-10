import * as THREE from 'three'
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js'

/**
 * 地表第一人称控制。
 *
 * 重力直接用该天体的真实表面重力（m/s²），跳跃给的是固定的起跳速度，
 * 于是跳跃高度 h = v²/(2g)、滞空时间 t = 2v/g 都由重力自然决定，
 * 不需要另外为每颗星球调参 —— 月球上 1.62 m/s² 跳起来会明显飘，
 * 那是公式算出来的，不是手调的手感。
 */

const EYE_HEIGHT = 1.7 // 米
const WALK_SPEED = 3.2 // m/s，穿着装备的行进速度
const SPRINT_MULTIPLIER = 2.4
const JUMP_VELOCITY = 4.2 // m/s，固定起跳速度

export function createFirstPerson({ camera, domElement, heightAt, gravity, bounds }) {
  const controls = new PointerLockControls(camera, domElement)
  const player = controls.object ?? controls.getObject()

  const keys = new Set()
  const velocity = new THREE.Vector3() // 只用 y 分量做竖直运动
  const forward = new THREE.Vector3()
  const right = new THREE.Vector3()
  const move = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)

  let onGround = true
  let verticalVelocity = 0

  const onKeyDown = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    keys.add(e.code)
    if (e.code === 'Space' && controls.isLocked) {
      e.preventDefault()
      if (onGround) {
        verticalVelocity = JUMP_VELOCITY
        onGround = false
      }
    }
  }
  const onKeyUp = (e) => keys.delete(e.code)

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)

  function spawn(x = 0, z = 0) {
    player.position.set(x, heightAt(x, z) + EYE_HEIGHT, z)
    verticalVelocity = 0
    onGround = true
  }

  function update(dt) {
    // dt 过大（切标签页回来）时不要让玩家瞬间穿地
    const step = Math.min(dt, 0.05)

    if (controls.isLocked) {
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

    // 别走出地形边界
    if (bounds) {
      const limit = bounds / 2 - 20
      player.position.x = THREE.MathUtils.clamp(player.position.x, -limit, limit)
      player.position.z = THREE.MathUtils.clamp(player.position.z, -limit, limit)
    }

    velocity.set(0, verticalVelocity, 0)
  }

  function dispose() {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    controls.disconnect?.()
    controls.dispose?.()
  }

  return {
    controls,
    player,
    update,
    spawn,
    dispose,
    isLocked: () => controls.isLocked,
    lock: () => controls.lock(),
    unlock: () => controls.unlock(),
    getState: () => ({
      position: player.position,
      onGround,
      verticalVelocity,
      /** 当前重力下这一跳能跳多高 / 滞空多久 */
      jumpHeight: (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * gravity),
      hangTime: (2 * JUMP_VELOCITY) / gravity,
    }),
  }
}
