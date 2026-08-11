import './audioToggle.css'

/**
 * 底部控制条上的背景音乐开关。
 *
 * 它不是播放/暂停 —— 播放与否由视图状态决定。这个开关管的是「允不允许出声」：
 * 关掉就一直静默；开着但正聚焦某颗星球时也仍然静默，等回到全景才响。
 * 按钮文案要把这层区别说清楚，否则用户会以为按钮坏了。
 *
 * 浏览器在首次用户手势前会挂起 AudioContext，这时按钮变成「点击启用声音」，
 * 点它是解锁而不是切换。
 */

const LABEL = {
  locked: { icon: '🔈', text: '点击启用声音' },
  on: { icon: '🔊', text: '背景音乐' },
  off: { icon: '🔇', text: '背景音乐' },
}

export function createAudioToggle({ container, onToggle, onUnlock }) {
  const btn = document.createElement('button')
  btn.className = 'ctl-btn audio-toggle'
  btn.type = 'button'
  btn.innerHTML = `<i class="audio-icon"></i><span class="audio-label"></span>`
  container.appendChild(btn)

  const icon = btn.querySelector('.audio-icon')
  const label = btn.querySelector('.audio-label')

  let needsGesture = false

  btn.addEventListener('click', () => {
    if (needsGesture) onUnlock()
    else onToggle()
  })

  function render(s) {
    // 浏览器不支持 Web Audio 时整个按钮不出现，免得点了没反应
    btn.style.display = s.audioAvailable ? '' : 'none'
    needsGesture = s.needsGesture

    const key = s.needsGesture ? 'locked' : s.enabled ? 'on' : 'off'
    icon.textContent = LABEL[key].icon
    label.textContent = LABEL[key].text

    btn.classList.toggle('is-active', s.enabled && !s.needsGesture)
    btn.classList.toggle('is-muted', !s.enabled && !s.needsGesture)
    // 开着但此刻不出声（聚焦中 / 地表 / 导览接管）：给一点视觉区分，不是坏了
    btn.classList.toggle('is-idle', s.enabled && !s.needsGesture && !s.playing)

    btn.title = s.needsGesture
      ? '浏览器要求先有一次点击才能出声'
      : !s.hasTrack
        ? '还没有可用的音床素材（跑一次 npm run music）'
        : s.enabled
          ? s.playing
            ? '背景音乐已开启。聚焦某颗星球时会自动淡出，返回全景再淡入'
            : '背景音乐已开启，当前视图下保持静默；回到全景会自动响起'
          : '背景音乐已关闭'
  }

  return { render, element: btn }
}
