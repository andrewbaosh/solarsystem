import './filters.css'

/**
 * 显示筛选器。
 *
 * 场景里现在有 8 颗行星 + 6 颗卫星 + 4 颗命名小行星 + 5 个彗星/星际天体
 * + 3600 颗小行星 + 一堆轨道线与标签，全开时相当拥挤。
 * 这里按类别开关，让人能把画面收拾干净、只看关心的东西。
 *
 * 每一项只负责改可见性，不影响任何计算 —— 关掉卫星不会让月球停止公转。
 */

const GROUPS = [
  { id: 'planets', label: '行星', hint: '八大行星与太阳' },
  { id: 'satellites', label: '卫星', hint: '月球、伽利略卫星、土卫六' },
  { id: 'asteroidBelt', label: '小行星带', hint: '3600 颗程序化生成的小行星' },
  { id: 'smallBodies', label: '彗星与星际天体', hint: '含命名小行星' },
  { id: 'orbits', label: '轨道线', hint: '所有天体的轨迹' },
  { id: 'labels', label: '名称标签', hint: '快捷键 L' },
]

export function createFilters({ onChange, initial = {} }) {
  const state = Object.fromEntries(GROUPS.map((g) => [g.id, initial[g.id] ?? true]))

  const panel = document.createElement('div')
  panel.className = 'filters'
  panel.innerHTML = `
    <button class="filters-toggle" type="button" title="显示筛选">显示 ▾</button>
    <div class="filters-body">
      ${GROUPS.map(
        (g) => `
        <label class="filters-row" title="${g.hint}">
          <input type="checkbox" data-id="${g.id}" ${state[g.id] ? 'checked' : ''}>
          <span>${g.label}</span>
          <small>${g.hint}</small>
        </label>`,
      ).join('')}
    </div>
  `
  document.body.appendChild(panel)

  const body = panel.querySelector('.filters-body')
  const toggle = panel.querySelector('.filters-toggle')
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('is-open')
    toggle.textContent = open ? '显示 ▴' : '显示 ▾'
  })

  body.addEventListener('change', (e) => {
    const input = e.target
    if (!input.dataset?.id) return
    state[input.dataset.id] = input.checked
    onChange({ ...state })
  })

  /** 供快捷键等外部途径同步状态（例如 L 键切标签） */
  function set(id, value) {
    if (state[id] === value) return
    state[id] = value
    const input = body.querySelector(`input[data-id="${id}"]`)
    if (input) input.checked = value
    onChange({ ...state })
  }

  return { state: () => ({ ...state }), set, element: panel }
}
