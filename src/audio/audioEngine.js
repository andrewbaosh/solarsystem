/**
 * 音频引擎：AudioContext、增益链、以及一条音轨的播放/暂停/淡入淡出。
 *
 * 增益链是两级相乘的：
 *   source → musicGain(-20 dB 起) → masterGain(主音量) → destination
 * 淡入淡出只动 musicGain，主音量是另一路，互不干扰。
 *
 * 所有增益变化一律走 linearRampToValueAtTime。直接给 gain.value 赋值会在
 * 波形上留下一个阶跃，听起来就是「咔」的一声。
 *
 * 两种播放实现，按时长自动选：
 *   ≤ 5 分钟 → AudioBufferSourceNode，循环由 loopStart/loopEnd 在采样级完成，无缝
 *   > 5 分钟 → HTMLAudioElement + createMediaElementSource，流式播放
 * 分界线的理由是内存：decodeAudioData 会把压缩音频展开成 32 位浮点 PCM，
 * 48 kHz 立体声约 23 MB/分钟，十分钟的音床就是 230 MB 常驻。
 */

const MUSIC_GAIN_DB = -20
const STREAM_THRESHOLD_SECONDS = 300
/** 淡出到 0 之后再停，留一点余量避免踩在斜坡末尾 */
const STOP_GUARD_MS = 60

export const dbToGain = (db) => 10 ** (db / 20)

// ---- 播放器：缓冲区实现（短音轨，采样级无缝循环）----------------------------

function createBufferPlayer(ctx, buffer, track, destination) {
  const hasLoop =
    track.loopStart !== null &&
    track.loopEnd !== null &&
    track.loopEnd > track.loopStart &&
    track.loopEnd <= buffer.duration + 0.01

  if (!hasLoop && (track.loopStart !== null || track.loopEnd !== null)) {
    console.warn(`[audio] ${track.id} 的循环点不可用（超出时长或缺一个），退化为整文件循环`)
  } else if (!hasLoop) {
    console.warn(`[audio] ${track.id} 未标定循环点，退化为整文件循环`)
  }

  const loopStart = hasLoop ? track.loopStart : 0
  const loopEnd = hasLoop ? track.loopEnd : buffer.duration

  let source = null
  let startedAt = 0 // 起播时的 ctx.currentTime
  let startOffset = 0 // 起播时在音轨里的位置
  let pausedAt = 0 // 暂停时停在哪，恢复时从这里继续

  /** 当前播放到音轨的第几秒。循环是有周期的，位置要按环回来算 */
  function position() {
    if (!source) return pausedAt
    const elapsed = ctx.currentTime - startedAt + startOffset
    if (elapsed < loopEnd) return elapsed
    const span = loopEnd - loopStart
    return loopStart + ((elapsed - loopEnd) % span)
  }

  return {
    kind: 'buffer',
    duration: buffer.duration,
    loop: { start: loopStart, end: loopEnd, marked: hasLoop },
    position,
    isPlaying: () => Boolean(source),
    start() {
      if (source) return
      source = ctx.createBufferSource()
      source.buffer = buffer
      source.loop = true
      source.loopStart = loopStart
      source.loopEnd = loopEnd
      source.connect(destination)
      startOffset = pausedAt
      startedAt = ctx.currentTime
      source.start(0, startOffset)
    },
    stop() {
      if (!source) return
      pausedAt = position()
      try {
        source.stop()
      } catch {
        /* 已经停了 */
      }
      source.disconnect()
      source = null
    },
    dispose() {
      this.stop()
    },
  }
}

// ---- 播放器：流式实现（长音轨）---------------------------------------------

function createElementPlayer(ctx, url, track, destination) {
  const el = new Audio()
  el.src = url
  el.preload = 'auto'
  el.crossOrigin = 'anonymous'

  const hasLoop = track.loopStart !== null && track.loopEnd !== null && track.loopEnd > track.loopStart
  const loopStart = hasLoop ? track.loopStart : 0
  const loopEnd = hasLoop ? track.loopEnd : Infinity
  el.loop = !hasLoop // 没标循环点就交给浏览器整文件循环

  // 流式播放没法在采样级接缝，只能靠 seek。这里提前一点点跳，
  // 比等 timeupdate 报到 loopEnd 之后再跳要好，但接缝仍可能听得出来。
  if (hasLoop) {
    el.addEventListener('timeupdate', () => {
      if (el.currentTime >= loopEnd - 0.05) el.currentTime = loopStart
    })
  }

  const node = ctx.createMediaElementSource(el)
  node.connect(destination)

  return {
    kind: 'element',
    duration: track.duration,
    loop: { start: loopStart, end: hasLoop ? loopEnd : track.duration, marked: hasLoop },
    position: () => el.currentTime,
    isPlaying: () => !el.paused,
    start() {
      // 自动播放被拒是正常情况，不当错误处理
      el.play().catch(() => {})
    },
    stop() {
      el.pause()
    },
    dispose() {
      el.pause()
      node.disconnect()
      el.removeAttribute('src')
      el.load()
    },
  }
}

// ---- 引擎 -----------------------------------------------------------------

export function createAudioEngine({ musicGainDb = MUSIC_GAIN_DB } = {}) {
  const Ctor = window.AudioContext ?? window.webkitAudioContext
  if (!Ctor) {
    console.warn('[audio] 这个浏览器没有 Web Audio，音频静默降级')
    return createNullEngine()
  }

  const ctx = new Ctor()
  const masterGain = ctx.createGain()
  const musicGain = ctx.createGain()
  const fullGain = dbToGain(musicGainDb)

  musicGain.gain.value = 0 // 从静音起步，播放时淡入
  masterGain.gain.value = 1
  musicGain.connect(masterGain)
  masterGain.connect(ctx.destination)

  let player = null
  let stopTimer = null

  /** 取消挂起的斜坡并把当前值钉住，否则新斜坡会从旧的目标值开始算 */
  function anchor(param) {
    const now = ctx.currentTime
    param.cancelScheduledValues(now)
    param.setValueAtTime(param.value, now)
    return now
  }

  function rampTo(target, seconds) {
    const now = anchor(musicGain.gain)
    musicGain.gain.linearRampToValueAtTime(target, now + Math.max(0.01, seconds))
  }

  async function loadTrack(track, url) {
    unloadTrack()
    if (track.duration > STREAM_THRESHOLD_SECONDS) {
      player = createElementPlayer(ctx, url, track, musicGain)
      return player
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buffer = await ctx.decodeAudioData(await res.arrayBuffer())
    player = createBufferPlayer(ctx, buffer, track, musicGain)
    return player
  }

  function unloadTrack() {
    clearTimeout(stopTimer)
    stopTimer = null
    player?.dispose()
    player = null
  }

  /** 淡入并播放。已经在播就只把音量拉回去，不重开音源 */
  function fadeIn(seconds) {
    if (!player) return
    clearTimeout(stopTimer)
    stopTimer = null
    player.start()
    rampTo(fullGain, seconds)
  }

  /** 淡出，斜坡走完再 pause —— 位置保留，下次从这里继续 */
  function fadeOut(seconds) {
    if (!player) return
    clearTimeout(stopTimer)
    rampTo(0, seconds)
    stopTimer = setTimeout(() => {
      player?.stop()
      stopTimer = null
    }, seconds * 1000 + STOP_GUARD_MS)
  }

  return {
    available: true,
    context: ctx,
    loadTrack,
    unloadTrack,
    fadeIn,
    fadeOut,
    setMasterVolume(v) {
      const now = anchor(masterGain.gain)
      masterGain.gain.linearRampToValueAtTime(Math.max(0, v), now + 0.05)
    },
    getMasterVolume: () => masterGain.gain.value,
    getMusicGain: () => musicGain.gain.value,
    getPlayer: () => player,
    /** 必须在用户手势里调用，否则浏览器不给恢复 */
    resume: () => ctx.resume().catch(() => {}),
    state: () => ctx.state,
  }
}

/** 没有 Web Audio 时的空实现：调用点不必到处判空 */
function createNullEngine() {
  const noop = () => {}
  return {
    available: false,
    context: null,
    loadTrack: async () => null,
    unloadTrack: noop,
    fadeIn: noop,
    fadeOut: noop,
    setMasterVolume: noop,
    getMasterVolume: () => 0,
    getMusicGain: () => 0,
    getPlayer: () => null,
    resume: async () => {},
    state: () => 'unavailable',
  }
}
