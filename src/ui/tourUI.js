import './tour.css'

/**
 * 导览的 HTML overlay：启动按钮、字幕层、播放条、章节列表。
 *
 * 章节标题来自 data/tour.json，这里不写死任何一章的名字。
 * 字幕逐句淡入淡出 —— 换句时先把旧句淡出，透明度归零后再换文本，
 * 否则会看到文字在原地被替换掉的"跳字"。
 */

const FADE_MS = 320

export function createTourUI({ chapters, handlers }) {
  const launch = document.createElement('button')
  launch.className = 'tour-launch'
  launch.type = 'button'
  launch.textContent = '导览'
  launch.title = '自动导览：镜头与解说按脚本走，中途可以随时接管'
  document.body.appendChild(launch)

  const root = document.createElement('div')
  root.className = 'tour-ui'
  root.innerHTML = `
    <div class="tour-subtitle"><span></span></div>
    <div class="tour-bar">
      <div class="tour-progress"><i></i></div>
      <div class="tour-row">
        <button class="tour-btn" data-act="prev" type="button" title="上一章">◀◀</button>
        <button class="tour-btn tour-play" data-act="play" type="button" title="播放 / 暂停">❚❚</button>
        <button class="tour-btn" data-act="next" type="button" title="下一章">▶▶</button>
        <button class="tour-btn tour-chapters-toggle" data-act="list" type="button">章节</button>
        <div class="tour-title"><b></b><small></small></div>
        <button class="tour-btn tour-resume" data-act="resume" type="button">继续导览</button>
        <button class="tour-btn" data-act="exit" type="button" title="退出导览">退出</button>
      </div>
      <ol class="tour-chapters">
        ${chapters
          .map(
            (c, i) =>
              `<li><button type="button" data-index="${i}"><span>${String(i + 1).padStart(2, '0')}</span>${c.title ?? c.id}</button></li>`,
          )
          .join('')}
      </ol>
    </div>
    <div class="tour-free-hint">自由观察中 —— 旁白仍在继续</div>
  `
  document.body.appendChild(root)

  const subtitleBox = root.querySelector('.tour-subtitle')
  const subtitleText = subtitleBox.querySelector('span')
  const progress = root.querySelector('.tour-progress i')
  const playBtn = root.querySelector('.tour-play')
  const titleMain = root.querySelector('.tour-title b')
  const titleSub = root.querySelector('.tour-title small')
  const list = root.querySelector('.tour-chapters')
  const chapterButtons = [...list.querySelectorAll('button')]

  const act = {
    prev: () => handlers.onPrev(),
    next: () => handlers.onNext(),
    play: () => handlers.onTogglePlay(),
    exit: () => handlers.onExit(),
    resume: () => handlers.onResume(),
    list: () => root.classList.toggle('is-list-open'),
  }

  root.addEventListener('click', (e) => {
    const button = e.target.closest('button')
    if (!button) return
    if (button.dataset.act) return act[button.dataset.act]?.()
    if (button.dataset.index !== undefined) {
      root.classList.remove('is-list-open')
      handlers.onGoto(Number(button.dataset.index))
    }
  })
  launch.addEventListener('click', () => handlers.onStart())

  // 播放条上的操作不该被当成"用户要接管相机"
  root.addEventListener('pointerdown', (e) => e.stopPropagation())

  let pendingText = null
  let fadeTimer = null
  let shownText = ''

  function setSubtitle(text) {
    if (text === shownText && !pendingText) return
    shownText = text
    pendingText = text
    subtitleBox.classList.remove('is-visible')
    clearTimeout(fadeTimer)
    fadeTimer = setTimeout(() => {
      subtitleText.textContent = pendingText
      subtitleBox.classList.toggle('is-visible', Boolean(pendingText))
      pendingText = null
    }, FADE_MS)
  }

  const last = { active: null, index: -1, playing: null, free: null }

  function setState(s) {
    if (s.active !== last.active) {
      last.active = s.active
      document.body.classList.toggle('tour-mode', s.active)
      root.classList.toggle('is-active', s.active)
      launch.classList.toggle('is-hidden', s.active)
      if (!s.active) root.classList.remove('is-list-open')
    }
    if (!s.active) return

    progress.style.width = `${Math.min(100, (s.elapsed / (s.duration || 1)) * 100).toFixed(2)}%`

    if (s.index !== last.index) {
      last.index = s.index
      titleMain.textContent = s.title
      titleSub.textContent = `第 ${s.index + 1} 章 / 共 ${s.count} 章`
      chapterButtons.forEach((b, i) => b.classList.toggle('is-current', i === s.index))
    }
    if (s.playing !== last.playing) {
      last.playing = s.playing
      playBtn.textContent = s.playing ? '❚❚' : '▶'
    }
    if (s.free !== last.free) {
      last.free = s.free
      root.classList.toggle('is-free', s.free)
    }
  }

  return { setState, setSubtitle, element: root }
}
