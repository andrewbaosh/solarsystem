import './events.css'

/**
 * 天象面板。
 *
 * 事件不是查表来的，是**现算的** —— 点「搜索」时按 data/events.json 的定义
 * 在时间轴上扫描几何量的极值。所以你换个年份区间，它会重新算一遍。
 *
 * 文案与阈值都在 JSON 里，这里只负责渲染与交互。
 */

const KIND_LABEL = {
  total: { text: '全食', cls: 'is-total' },
  annular: { text: '环食', cls: 'is-annular' },
  partial: { text: '偏食', cls: 'is-partial' },
  penumbral: { text: '半影食', cls: 'is-penumbral' },
}

const RANGES = [
  { label: '未来 2 年', years: 2 },
  { label: '未来 10 年', years: 10 },
  { label: '未来 50 年', years: 50 },
]

export function createEventsPanel({ groups, onSearch, onJump }) {
  const launch = document.createElement('button')
  launch.className = 'events-launch'
  launch.type = 'button'
  launch.innerHTML = '<b>天象</b><small>日月食 · 冲 · 大距 · 相合</small>'
  document.body.appendChild(launch)

  const panel = document.createElement('aside')
  panel.className = 'events-panel'
  panel.innerHTML = `
    <div class="events-head">
      <div>
        <div class="events-title">天象搜索</div>
        <div class="events-sub">从当前模拟时刻起，按几何判据实时计算</div>
      </div>
      <button class="events-close" type="button" aria-label="关闭">×</button>
    </div>
    <div class="events-controls">
      <div class="events-ranges">
        ${RANGES.map(
          (r, i) =>
            `<button class="events-range${i === 0 ? ' is-active' : ''}" data-years="${r.years}">${r.label}</button>`,
        ).join('')}
      </div>
      <div class="events-kinds">
        ${groups
          .map(
            (g) =>
              `<label class="events-kind"><input type="checkbox" data-id="${g.id}" checked><span>${g.name}</span></label>`,
          )
          .join('')}
      </div>
      <button class="events-search" type="button">搜索</button>
    </div>
    <div class="events-status"></div>
    <div class="events-list"></div>
    <div class="events-note"></div>
  `
  document.body.appendChild(panel)

  const list = panel.querySelector('.events-list')
  const status = panel.querySelector('.events-status')
  const note = panel.querySelector('.events-note')
  let years = RANGES[0].years

  const open = (v) => {
    panel.classList.toggle('is-open', v)
    document.body.classList.toggle('events-open', v)
    launch.classList.toggle('is-hidden', v)
  }
  launch.addEventListener('click', () => {
    open(true)
    run()
  })
  panel.querySelector('.events-close').addEventListener('click', () => open(false))

  panel.querySelector('.events-ranges').addEventListener('click', (e) => {
    const b = e.target.closest('.events-range')
    if (!b) return
    years = Number(b.dataset.years)
    panel.querySelectorAll('.events-range').forEach((x) => x.classList.toggle('is-active', x === b))
    run()
  })
  panel.querySelector('.events-search').addEventListener('click', () => run())

  function selected() {
    return [...panel.querySelectorAll('.events-kinds input')].filter((i) => i.checked).map((i) => i.dataset.id)
  }

  function run() {
    status.textContent = '计算中…'
    list.innerHTML = ''
    // 让浏览器先把「计算中」画出来，再做这段同步的扫描。
    // 这里不能用 requestAnimationFrame —— 标签页在后台时它可能永远不触发，
    // 搜索就会永远停在「计算中」。setTimeout 会被节流但一定会跑。
    setTimeout(() => {
      const { events, ms, warning } = onSearch({ years, ids: selected() })
      render(events, ms, warning)
    }, 16)
  }

  function render(events, ms, warning) {
    status.textContent = events.length
      ? `找到 ${events.length} 次事件　${ms.toFixed(0)} ms`
      : '这个区间里没有符合条件的事件'
    note.textContent = warning ?? ''
    note.classList.toggle('is-visible', Boolean(warning))

    list.innerHTML = events
      .map((e, i) => {
        const k = KIND_LABEL[e.kind]
        return `
        <button class="events-row" data-index="${i}">
          <span class="events-date">${e.date}</span>
          <span class="events-name">${e.name}${k ? `<i class="events-tag ${k.cls}">${k.text}</i>` : ''}</span>
          <span class="events-detail">${e.detail}</span>
        </button>`
      })
      .join('')

    list.querySelectorAll('.events-row').forEach((row) => {
      row.addEventListener('click', () => onJump(events[Number(row.dataset.index)]))
    })
  }

  return { element: panel, open: () => open(true), close: () => open(false), refresh: run }
}
