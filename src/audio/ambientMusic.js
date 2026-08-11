import { createAudioEngine } from './audioEngine.js'

/**
 * 状态驱动的背景音床。
 *
 * 音乐不由用户手动播放/暂停，而是跟着「你在看什么」自动走：
 *
 *   OVERVIEW  自由视角，没锁定任何天体   → 放
 *   FOCUSED   已聚焦并跟随某个天体       → 停（贴近看一颗星球时，音乐是干扰）
 *   SURFACE   地表场景                   → 停（将来接该星球的环境音，接口已留）
 *
 * 淡入 2.5 秒比淡出 1.8 秒慢，是刻意的：回到全景时音乐该「渐渐浮现」，
 * 而不是「突然响起」。恢复播放一律从上次暂停的位置继续 ——
 * 每点开一颗星球再返回就重听一遍开头，听三次就会想关掉它。
 *
 * 防抖 500 ms：连点五颗星球会快速经历 FOCUSED→OVERVIEW→FOCUSED，
 * 每次都执行完整淡入淡出的话音乐会来回抽搐。只对「稳定下来的状态」响应。
 */

export const VIEW = {
  OVERVIEW: 'OVERVIEW',
  FOCUSED: 'FOCUSED',
  SURFACE: 'SURFACE',
}

const FADE_OUT = 1.8
const FADE_IN = 2.5
/** 开关关闭时要立刻安静，用更短的淡出 */
const FADE_OFF = 1.0
const DEBOUNCE_MS = 500
const STORAGE_KEY = 'solarsystem.music.enabled'

function readEnabled() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === null ? true : raw === '1'
  } catch {
    return true // 隐私模式下 localStorage 会抛，默认开启
  }
}

function writeEnabled(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    /* 存不下就算了，不影响本次会话 */
  }
}

export function createAmbientMusic({ baseUrl = '/', onChange } = {}) {
  const engine = createAudioEngine()

  let enabled = readEnabled()
  let controlMode = 'ambient' // 'ambient' | 'tour'
  let track = null

  let desired = VIEW.OVERVIEW // 外面告诉我们的最新状态
  let applied = null // 音频真正响应过的状态
  let timer = null

  const notify = () => onChange?.(status())

  function status() {
    return {
      enabled,
      controlMode,
      viewState: desired,
      appliedState: applied,
      hasTrack: Boolean(track),
      playing: Boolean(engine.getPlayer()?.isPlaying()),
      gain: engine.getMusicGain(),
      contextState: engine.state(),
      needsGesture: engine.state() === 'suspended',
      position: engine.getPlayer()?.position() ?? 0,
      audioAvailable: engine.available,
    }
  }

  // ---- 素材 ---------------------------------------------------------------

  /**
   * 载入音床。索引由 scripts/fetch-music.js 生成；
   * 还没跑过脚本、或者下载失败，一律静默降级 —— 不弹错、不拦 3D 场景。
   */
  async function load() {
    if (!engine.available) return false
    try {
      const res = await fetch(`${baseUrl}audio/music/index.json`, { cache: 'no-cache' })
      if (!res.ok) throw new Error(`索引 HTTP ${res.status}`)
      const index = await res.json()
      const first = index.tracks?.[0]
      if (!first) throw new Error('索引里没有音轨')

      await engine.loadTrack(first, `${baseUrl}${first.file}`)
      track = first
      notify()
      // 载入完成时可能已经稳定在某个状态了，补一次判断
      reconcile()
      return true
    } catch (err) {
      console.info(`[audio] 没有可用的背景音床（${err.message}），静默跳过`)
      notify()
      return false
    }
  }

  // ---- 状态机 -------------------------------------------------------------

  /** 此刻「应该」出声吗 */
  function shouldPlay(state) {
    return enabled && controlMode === 'ambient' && state === VIEW.OVERVIEW
  }

  function apply(state) {
    applied = state
    if (!track) return
    if (shouldPlay(state)) engine.fadeIn(FADE_IN)
    else engine.fadeOut(FADE_OUT)
    notify()
  }

  /**
   * 视图状态变了。
   * 延迟 DEBOUNCE_MS 再动音频；这段时间里状态又变回去了就取消 ——
   * 关键就在 `desired === applied` 这一条：它意味着「白跑一趟」。
   */
  function setViewState(next) {
    if (!VIEW[next]) return
    if (next === desired) return
    desired = next
    clearTimeout(timer)
    timer = null
    notify()
    if (desired === applied) return // 转了一圈又回来，本次动作取消
    timer = setTimeout(() => {
      timer = null
      apply(desired)
    }, DEBOUNCE_MS)
  }

  /** 开关、控制权这类变化要立即生效，不走防抖 */
  function reconcile({ fadeOutSeconds = FADE_OFF } = {}) {
    clearTimeout(timer)
    timer = null
    applied = desired
    if (!track) return notify()
    if (shouldPlay(desired)) engine.fadeIn(FADE_IN)
    else engine.fadeOut(fadeOutSeconds)
    notify()
  }

  // ---- 开关 ---------------------------------------------------------------

  /**
   * 开启时不立即播放，而是交给状态机判断：
   * 当前在全景就淡入，正聚焦着某颗星球就保持静默，等回到全景自然响起。
   */
  function setEnabled(next) {
    if (next === enabled) return
    enabled = next
    writeEnabled(enabled)
    reconcile({ fadeOutSeconds: FADE_OFF })
  }

  /** 必须由用户手势触发 */
  async function unlock() {
    await engine.resume()
    notify()
    // 解锁前挂起期间可能已经错过一次状态判断
    if (applied !== null) reconcile()
  }

  /**
   * 导览接管期间本状态机让位（音乐由 tour.json 的 chapter.music 负责，尚未实现）；
   * 交还时按当前视图状态重新接管。
   */
  function setControlMode(mode) {
    if (mode !== 'ambient' && mode !== 'tour') return
    if (mode === controlMode) return
    controlMode = mode
    reconcile({ fadeOutSeconds: FADE_OUT })
  }

  return {
    VIEW,
    load,
    setViewState,
    setEnabled,
    toggle: () => setEnabled(!enabled),
    isEnabled: () => enabled,
    setControlMode,
    getControlMode: () => controlMode,
    unlock,
    status,
    engine,
  }
}
