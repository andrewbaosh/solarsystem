import * as THREE from 'three'
import { createCameraDirector } from './camera-director.js'
import { createTransitions } from './transitions.js'

/**
 * 章节播放器。
 *
 * 引擎里没有任何一句文案、任何一个镜头坐标 —— 全部来自 data/tour.json。
 * 它只负责四件事：
 *   1. 按 duration 推进章节，到点自动进入下一章
 *   2. 进入新章时套用 sceneState（时间倍率、轨道线、高亮、尺度…）
 *   3. 按 in/out 时间戳挑出当前该显示的字幕
 *   4. 处理"用户中途接管 → 点继续 → 平滑归位"这条支线
 *
 * scene 适配器由 main.js 注入，播放器不认识 bodySystem / filters / time 这些具体模块，
 * 于是引擎与场景实现之间只隔着一层可替换的接口。
 */

export function createTour({ chapters, camera, scene, ui }) {
  const director = createCameraDirector({ camera, resolveBody: scene.resolveBody })
  const transitions = createTransitions()
  const scratch = new THREE.Vector3()

  let active = false
  let playing = false
  let index = 0
  let elapsed = 0
  let subtitleKey = null
  let snapshot = null
  // 过场已经开始、但机位还没换的那一小段：镜头必须冻住。
  // 否则 elapsed 已经归零、shot 还是上一章的，镜头会先弹回上一章的起点，
  // 而那时遮罩才刚起，弹跳是看得见的。
  let awaitingSwap = false

  const chapter = () => chapters[index] ?? null

  function emit() {
    ui.setState({
      active,
      playing,
      index,
      count: chapters.length,
      elapsed,
      duration: chapter()?.duration ?? 0,
      title: chapter()?.title ?? '',
      free: director.getState() === 'free',
    })
  }

  /** 章节进入时套用场景状态；缺省的字段一律不动，方便脚本只写关心的那几项 */
  function applySceneState(state = {}) {
    if (state.date !== undefined) scene.setDate(state.date)
    if (state.jd !== undefined) scene.setJD(state.jd)
    if (state.timeSpeed !== undefined) scene.setTimeSpeed(state.timeSpeed)
    if (state.timePaused !== undefined) scene.setPaused(state.timePaused)
    if (state.scaleMode !== undefined) scene.setScaleMode(state.scaleMode)
    if (state.filters !== undefined) scene.setFilters(state.filters)
    if (state.visibleOrbits !== undefined) scene.setVisibleOrbits(state.visibleOrbits)
    if (state.highlight !== undefined) scene.setHighlight(state.highlight)
  }

  /**
   * 进入某一章。
   * 过场存在时，套用场景状态与切换机位都安排在遮罩最不透明的那一刻，
   * 于是"世界突然变了"这件事是看不见的。
   */
  function enter(i, { withTransition = true, snap = null } = {}) {
    index = Math.max(0, Math.min(chapters.length - 1, i))
    elapsed = 0
    subtitleKey = null
    ui.setSubtitle('')

    const ch = chapter()
    const swap = () => {
      awaitingSwap = false
      applySceneState(ch.sceneState)
      // 过场盖住时切机位，朝向可以直接吸附；没有过场就让镜头自己摆过去
      director.setShot(ch, { snap: snap ?? covered })
      emit()
    }

    const kind = withTransition ? (ch.transition ?? 'none') : 'none'
    const covered = kind !== 'none'
    awaitingSwap = covered
    if (!transitions.play(kind, swap)) swap()
  }

  function start(i = 0) {
    if (active) return
    snapshot = scene.snapshot()
    active = true
    playing = true
    scene.onEnter()
    // 开场也走本章声明的过场（脚本第一章通常写 flash，好把这一刀盖住）；
    // 朝向一律吸附 —— 位置本来就是切过去的，朝向再慢慢摆过去只会显得脱节
    enter(i, { snap: true })
    emit()
  }

  function stop() {
    if (!active) return
    awaitingSwap = false
    active = false
    playing = false
    director.stop()
    transitions.cancel()
    ui.setSubtitle('')
    scene.onExit(snapshot)
    snapshot = null
    emit()
  }

  function togglePlay() {
    if (!active) return start()
    playing = !playing
    emit()
  }

  function goto(i) {
    if (!active) return start(i)
    if (i < 0 || i >= chapters.length) return stop()
    enter(i)
  }

  const next = () => goto(index + 1)
  const prev = () => goto(index - 1)

  /** 用户拖动/滚轮 → 立刻接管相机，旁白与字幕继续走 */
  function takeOver() {
    if (!active || director.getState() === 'free') return
    director.takeOver()
    scene.onTakeOver(director.getLookPoint(scratch))
    emit()
  }

  function resume() {
    if (!active) return
    director.resume()
    emit()
  }

  /** 按 in/out 时间戳挑当前字幕；同一句不重复写 DOM，交给 CSS 做淡入淡出 */
  function updateSubtitle(ch) {
    const list = ch.subtitles ?? []
    let hit = null
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      if (elapsed >= (s.in ?? 0) && elapsed < (s.out ?? Infinity)) {
        hit = { key: `${index}:${i}`, text: s.text ?? '' }
        break
      }
    }
    if ((hit?.key ?? null) === subtitleKey) return
    subtitleKey = hit?.key ?? null
    ui.setSubtitle(hit?.text ?? '')
  }

  function update(dt) {
    if (!active) return
    transitions.update(dt)
    const ch = chapter()
    if (!ch) return

    // 过场期间不推进章节时间，否则字幕会在遮罩后面白走一段
    if (playing && !transitions.isPlaying()) elapsed += dt

    const duration = ch.duration || 1
    if (!awaitingSwap) director.update(dt, Math.min(1, elapsed / duration))
    updateSubtitle(ch)

    if (elapsed >= duration) {
      if (index + 1 < chapters.length) enter(index + 1)
      else stop()
      return
    }
    emit()
  }

  return {
    start,
    stop,
    togglePlay,
    next,
    prev,
    goto,
    takeOver,
    resume,
    update,
    isActive: () => active,
    /** 相机是否由脚本驱动；自由观察时为 false，主循环据此决定跑不跑 OrbitControls */
    isDrivingCamera: () => active && director.isDriving(),
    getLookPoint: (out) => director.getLookPoint(out),
    getState: () => ({ active, playing, index, elapsed, free: director.getState() === 'free' }),
  }
}
