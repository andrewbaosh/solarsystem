import './infoPanel.css'
import { elementsAt, centuriesSinceJ2000, AU_KM } from '../bodies/orbital.js'

/**
 * 右侧滑出的信息面板。
 *
 * 轨道参数不另存一份，一律从 orbital-elements.json / satellites.json 的
 * 轨道要素现算 —— 同一个数只有一个出处，改要素时面板自动跟着变。
 */

const GAS_COLORS = ['#6f9bd8', '#d8a86f', '#7fd8a0', '#d87f9b', '#b79bd8', '#d8d06f']

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs !== 0 && (abs >= 1e5 || abs < 1e-2)) {
    const [mantissa, exponent] = value.toExponential(digits).split('e')
    return `${mantissa} × 10<sup>${Number(exponent)}</sup>`
  }
  return value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

function formatDuration(days) {
  if (!Number.isFinite(days) || days === 0) return '—'
  const abs = Math.abs(days)
  const sign = days < 0 ? '逆行 ' : ''
  if (abs < 1) return `${sign}${(abs * 24).toFixed(2)} 小时`
  if (abs < 365.25) return `${sign}${abs.toFixed(2)} 天`
  return `${sign}${(abs / 365.25).toFixed(2)} 年（${formatNumber(abs, 0)} 天）`
}

function formatTemperature(range, note) {
  if (!range) return '—'
  const [min, max] = range
  const text = min === max ? `${min} °C` : `${min} °C ~ ${max} °C`
  return note ? `${text}<br><span style="color:#7f93b5">${escapeHtml(note)}</span>` : text
}

function row(key, value) {
  return `<div class="info-row"><span class="info-key">${key}</span><span class="info-value">${value}</span></div>`
}

/** 轨道要素 → 面板要显示的几个量 */
function orbitalSummary(body, elements, jd) {
  if (body.kind === 'satellite') {
    const data = body.data
    const periodDays = data.L[1] ? 360 / data.L[1] : NaN
    return {
      periodDays,
      eccentricity: data.e,
      semiMajorKm: data.aKm,
      distanceLabel: `到${body.parent.data.name}的平均距离`,
    }
  }
  const set = elements[body.data.id]
  if (!set) return null
  const el = elementsAt(set, centuriesSinceJ2000(jd))
  return {
    // 平黄经每世纪走 L[1] 度，走满 360° 即一个恒星周期
    periodDays: (36525 * 360) / set.L[1],
    eccentricity: el.e,
    semiMajorKm: el.a * AU_KM,
    distanceLabel: '到太阳的平均距离',
  }
}

export function createInfoPanel({ elements, missions, onClose, onLand }) {
  const panel = document.createElement('aside')
  panel.className = 'info-panel'
  panel.innerHTML = `
    <div class="info-head">
      <div>
        <div class="info-title"></div>
        <div class="info-subtitle"></div>
        <div class="info-kind"></div>
      </div>
      <button class="info-close" type="button" title="关闭 (ESC)">✕</button>
    </div>
    <div class="info-body"></div>
    <button class="info-land" type="button"></button>
  `
  document.body.appendChild(panel)

  const titleEl = panel.querySelector('.info-title')
  const subtitleEl = panel.querySelector('.info-subtitle')
  const kindEl = panel.querySelector('.info-kind')
  const bodyEl = panel.querySelector('.info-body')
  const landBtn = panel.querySelector('.info-land')
  panel.querySelector('.info-close').addEventListener('click', () => onClose())

  let current = null
  landBtn.addEventListener('click', () => {
    if (current && current.data.surface?.landable) onLand(current)
  })

  function renderAtmosphere(data) {
    const composition = data.atmosphere_composition ?? []
    if (!composition.length) {
      return `<div class="info-note">${escapeHtml(data.atmosphereNote ?? '无可报告的大气')}</div>`
    }
    const bar = composition
      .map((c, i) => `<span style="width:${c.percent}%;background:${GAS_COLORS[i % GAS_COLORS.length]}"></span>`)
      .join('')
    const legend = composition
      .map(
        (c, i) =>
          `<span><i style="background:${GAS_COLORS[i % GAS_COLORS.length]}"></i>${escapeHtml(c.gas)} ${c.percent}%</span>`,
      )
      .join('')
    const note = data.atmosphereNote
      ? `<div class="info-note">${escapeHtml(data.atmosphereNote)}</div>`
      : ''
    return `<div class="gas-bar">${bar}</div><div class="gas-legend">${legend}</div>${note}`
  }

  function renderTimeline(body) {
    // 卫星没有自己的任务列表时，退回看母天体系统的任务
    const id = body.data.id
    const list = missions.missions[id] ?? (body.parent ? missions.missions[body.parent.data.id] : null) ?? []
    const scopeNote =
      !missions.missions[id] && body.parent
        ? `<div class="info-note">下列任务针对${body.parent.data.name}系统，包含对${body.data.name}的观测。</div>`
        : ''

    if (!list.length) {
      return `<div class="timeline-empty">这颗天体的任务数据尚未录入。<br>数据结构已就绪，在 data/missions.json 里按同一格式补充即可。</div>`
    }

    const items = [...list]
      .sort((a, b) => a.launchDate.localeCompare(b.launchDate))
      .map((m) => {
        const typeLabel = missions.types[m.type] ?? m.type
        const statusLabel = missions.statuses[m.status] ?? m.status
        const arrival = m.arrivalDate
          ? `<span class="timeline-date"> → 抵达 ${m.arrivalDate}</span>`
          : ''
        return `
          <div class="timeline-item" style="--dot:${m.status === 'enroute' ? '#9cc4ff' : '#6f9bd8'}">
            <div class="timeline-date">发射 ${m.launchDate}${arrival}</div>
            <div class="timeline-name">${escapeHtml(m.name)}<small>${escapeHtml(m.nameEn)}</small></div>
            <div class="timeline-tags">
              <span class="timeline-tag">${escapeHtml(m.country)} · ${escapeHtml(m.agency)}</span>
              <span class="timeline-tag">${escapeHtml(typeLabel)}</span>
              <span class="timeline-tag status-${m.status}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="timeline-desc">${escapeHtml(m.description)}</div>
          </div>`
      })
      .join('')

    return `${scopeNote}<div class="timeline">${items}</div>`
  }

  function show(body, jd) {
    current = body
    const data = body.data

    // 登陆按钮只对有固体表面的天体可用
    const surface = data.surface ?? {}
    landBtn.classList.toggle('is-available', Boolean(surface.landable))
    landBtn.disabled = !surface.landable
    landBtn.textContent = surface.landable
      ? `登陆 ${data.name}　·　${surface.site?.name ?? ''}`
      : surface.reason ?? '这颗天体没有可站立的固体表面'
    titleEl.textContent = data.name
    subtitleEl.textContent = data.nameEn ?? ''
    kindEl.textContent =
      body.kind === 'satellite' ? `${body.parent.data.name}的卫星` : data.type === 'star' ? '恒星' : '行星'

    const orbit = orbitalSummary(body, elements, jd)
    const physical = [
      row('平均半径', `${formatNumber(data.radiusKm, 1)} km`),
      data.massKg !== undefined ? row('质量', `${formatNumber(data.massKg, 3)} kg`) : '',
      data.surfaceGravityMs2 !== undefined
        ? row('表面重力', `${data.surfaceGravityMs2} m/s²（地球的 ${(data.surfaceGravityMs2 / 9.807).toFixed(2)} 倍）`)
        : '',
      data.surfaceTempC ? row('表面温度', formatTemperature(data.surfaceTempC, data.surfaceTempNote)) : '',
    ].join('')

    const orbital = orbit
      ? [
          row('公转周期', formatDuration(orbit.periodDays)),
          row('自转周期', formatDuration(data.rotationPeriodHours / 24)),
          row('轨道离心率', orbit.eccentricity.toFixed(4)),
          row(orbit.distanceLabel, `${formatNumber(orbit.semiMajorKm, 3)} km`),
          data.obliquityDeg !== undefined ? row('转轴倾角', `${data.obliquityDeg}°`) : '',
        ].join('')
      : `<div class="timeline-empty">该天体位于坐标原点，没有可展示的轨道要素。</div>`

    const narrative = data.narrative ?? ''
    const isPlaceholder = narrative.startsWith('【占位')

    bodyEl.innerHTML = `
      <div class="info-section">
        <div class="info-narrative${isPlaceholder ? ' is-placeholder' : ''}">${escapeHtml(narrative)}</div>
      </div>
      <div class="info-section">
        <div class="info-section-title">物理参数</div>
        ${physical}
      </div>
      <div class="info-section">
        <div class="info-section-title">大气成分</div>
        ${renderAtmosphere(data)}
      </div>
      <div class="info-section">
        <div class="info-section-title">轨道参数</div>
        ${orbital}
      </div>
      <div class="info-section">
        <div class="info-section-title">探索历史</div>
        ${renderTimeline(body)}
      </div>
    `
    bodyEl.scrollTop = 0
    panel.classList.add('is-open')
    document.body.classList.add('info-open') // 让时间条与快捷键提示避让
  }

  function hide() {
    panel.classList.remove('is-open')
    document.body.classList.remove('info-open')
  }

  return { show, hide, element: panel }
}
