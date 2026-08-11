import './loading.css'

/**
 * 首屏加载界面与资源加载提示。
 *
 * 贴图有 3.4 MB，慢网络下不给反馈的话就是几秒白屏。这里挂在 three 的
 * DefaultLoadingManager 上显示真实进度，加载完再淡出。
 *
 * 着陆器模型（最大 5 MB）是按需加载的，不进首屏统计 ——
 * 它在转场时才取，用右下角的小提示单独告知。
 */

export function createLoadingScreen({ manager, onStart }) {
  const boot = document.createElement('div')
  boot.className = 'boot'
  boot.innerHTML = `
    <div class="boot-orb"><i></i><b></b></div>
    <div class="boot-title">太阳系 3D 交互模型</div>
    <div class="boot-bar"><i></i></div>
    <div class="boot-status">正在加载贴图…</div>
    <button class="boot-start" type="button">开始探索</button>
  `
  document.body.appendChild(boot)

  const bar = boot.querySelector('.boot-bar i')
  const status = boot.querySelector('.boot-status')
  const startBtn = boot.querySelector('.boot-start')

  let settled = false
  let dismissed = false

  /**
   * 加载完不自动进场，而是等这一下点击。
   * 唯一的理由是声音：浏览器在首次用户手势前会挂起 AudioContext，
   * 没有这个按钮，背景音乐就得等用户碰巧点到别的东西才能启用。
   */
  function dismiss() {
    if (dismissed) return
    dismissed = true
    onStart?.() // 就在这次点击的调用栈里 resume()，手势才算数
    boot.classList.add('is-done')
    setTimeout(() => boot.remove(), 900)
  }

  startBtn.addEventListener('click', dismiss)

  function setProgress(loaded, total) {
    const pct = total > 0 ? Math.round((loaded / total) * 100) : 0
    bar.style.width = `${pct}%`
    status.textContent = `正在加载贴图…　${loaded} / ${total}`
  }

  function finish() {
    if (settled) return
    settled = true
    bar.style.width = '100%'
    status.textContent = '就绪'
    boot.classList.add('is-ready')
    startBtn.focus()
  }

  manager.onProgress = (_url, loaded, total) => setProgress(loaded, total)
  manager.onLoad = () => finish()
  manager.onError = (url) => {
    status.textContent = `资源加载失败：${String(url).split('/').pop()}`
  }

  // 兜底：贴图全部命中缓存时 onLoad 可能在监听挂上之前就触发过
  setTimeout(() => {
    if (!settled && manager.itemsTotal === 0) finish()
  }, 1200)
  // 再兜一层，避免个别资源卡住导致永远停在加载页
  setTimeout(finish, 15000)

  return { finish, dismiss, element: boot }
}

/** 转场期间的模型加载提示 */
export function createAssetToast() {
  const toast = document.createElement('div')
  toast.className = 'asset-toast'
  toast.innerHTML = `<i></i><span></span>`
  document.body.appendChild(toast)
  const label = toast.querySelector('span')

  return {
    show(text) {
      label.textContent = text
      toast.classList.add('is-visible')
    },
    hide() {
      toast.classList.remove('is-visible')
    },
  }
}
