import './style.css'
import { invoke } from '@tauri-apps/api/core'

type UiStatus = {
  status: string
  detail: string
  server: string
  session: string
  project: string
  redacted_ws_url: string
  version: string
  min_version: string
  last_error: string
  last_heartbeat_at: string
  connected: boolean
  running: boolean
  needs_project: boolean
}

type LocalProjectGrant = {
  grant_id: string
  server_base: string
  project_root: string
  project_name: string
  task_id: string
  expires_at: string
  last_used_at: string
  open_url: string
}

type ViewId = 'overview' | 'projects' | 'settings' | 'about'

const FALLBACK_STATUS: UiStatus = {
  status: 'ready',
  detail: '',
  server: '',
  session: '',
  project: '',
  redacted_ws_url: '',
  version: '',
  min_version: '',
  last_error: '',
  last_heartbeat_at: '',
  connected: false,
  running: false,
  needs_project: false,
}

const app = document.querySelector<HTMLDivElement>('#app')

let currentView: ViewId = 'overview'
let lastStatus: UiStatus = { ...FALLBACK_STATUS }
let lastGrants: LocalProjectGrant[] = []
let lastGrantsKey = ''

function escapeHtml(value: string) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function formatBeijingTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function relativeTime(value: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const diff = Date.now() - date.getTime()
  if (diff < 0) return '刚刚'
  const secs = Math.floor(diff / 1000)
  if (secs < 60) return `${secs} 秒前`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

type Tone = 'ok' | 'idle' | 'error' | 'busy'

function statusTone(status: UiStatus): Tone {
  if (status.status === 'error') return 'error'
  if (status.connected) return 'ok'
  if (status.needs_project || status.running) return 'busy'
  return 'idle'
}

function statusLabel(status: UiStatus) {
  if (status.connected) return '连接正常'
  if (status.needs_project) return '等待授权'
  if (status.status === 'reconnecting') return '重连中'
  if (status.running) return '连接中'
  if (status.status === 'error') return '连接异常'
  return '待命'
}

function serviceTitle(status: UiStatus) {
  if (status.connected) return '服务运行中'
  if (status.needs_project) return '等待选择项目目录'
  if (status.status === 'reconnecting') return '正在重新连接'
  if (status.running) return '正在连接 AutoCode'
  if (status.status === 'error') return '服务异常'
  return '本地服务已就绪'
}

function serviceDescription(status: UiStatus) {
  if (status.connected) return '浏览器已连接，正在等待 AutoCode 工具请求'
  if (status.needs_project) return '浏览器已唤起连接器，请授权本地项目目录'
  if (status.status === 'reconnecting') return status.detail || '连接中断，正在自动重连'
  if (status.running) return '正在建立本地执行通道'
  if (status.status === 'error') return status.last_error || status.detail || '连接异常'
  return '等待浏览器连接。请回到 AutoCode 网页点击“一键连接本地项目”。'
}

const NAV_ITEMS: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: 'overview', label: '概览', icon: 'nav-home' },
  { id: 'projects', label: '项目目录', icon: 'nav-folder' },
  { id: 'settings', label: '连接设置', icon: 'nav-link' },
  { id: 'about', label: '关于', icon: 'nav-info' },
]

function buildShell() {
  if (!app) return
  app.innerHTML = `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <span class="brand-mark">AC</span>
          <span>AutoCode</span>
        </div>
        <nav class="nav" id="nav">
          ${NAV_ITEMS.map((item, index) => `
            <button class="nav-item ${index === 0 ? 'active' : ''}" data-view="${item.id}">
              <span class="${item.icon}"></span>${item.label}
            </button>
          `).join('')}
        </nav>
        <div class="sidebar-footer">
          <div class="mini-status">
            <span class="status-dot idle" id="mini-dot"></span>
            <span id="mini-title">本地服务已就绪</span>
          </div>
          <div class="version-line" id="mini-version">版本 —</div>
        </div>
      </aside>

      <main class="content">
        <!-- 概览 -->
        <section class="view active" data-view="overview">
          <header class="page-header">
            <div>
              <div class="title-line">
                <h1>概览</h1>
                <span class="status-badge idle" id="ov-badge">待命</span>
              </div>
              <p id="ov-desc">等待浏览器连接</p>
            </div>
            <button class="ghost-button" id="ov-refresh"><span class="refresh-icon"></span>刷新</button>
          </header>

          <section class="card hero-card">
            <div class="hero-row">
              <div class="service-icon idle" id="ov-icon"></div>
              <div class="hero-text">
                <strong id="ov-title">本地服务已就绪</strong>
                <span id="ov-sub">等待浏览器连接</span>
              </div>
            </div>
            <div class="hero-error" id="ov-error" hidden></div>
          </section>

          <div class="fact-grid">
            <div class="fact">
              <span class="fact-label">连接器版本</span>
              <span class="fact-value" id="ov-version">—</span>
            </div>
            <div class="fact">
              <span class="fact-label">授权项目</span>
              <span class="fact-value" id="ov-project">未选择</span>
            </div>
            <div class="fact">
              <span class="fact-label">最近心跳</span>
              <span class="fact-value" id="ov-heartbeat">—</span>
            </div>
            <div class="fact">
              <span class="fact-label">已授权项目数</span>
              <span class="fact-value" id="ov-grantcount">0</span>
            </div>
          </div>

          <div class="actions" id="ov-actions">
            <button class="primary-action" id="ov-choose" hidden>选择项目目录并连接</button>
          </div>

          <div class="notice">
            <span class="lock-icon"></span>
            <span>连接器只会在你授权的项目目录内读写文件，并继续遵循 AutoCode 的命令审批策略。</span>
          </div>
        </section>

        <!-- 项目目录 -->
        <section class="view" data-view="projects">
          <header class="page-header">
            <div>
              <h1>项目目录</h1>
              <p>点击任意项目可直接在浏览器中打开对应的 AutoCode 开发页面。</p>
            </div>
          </header>

          <section class="card projects-card">
            <div class="section-heading">
              <div>
                <h2>已授权项目</h2>
                <p>授权记录保留 30 天，真正执行时仍会临时连接并遵循审批策略。</p>
              </div>
              <span class="pill" id="pj-count">0 个项目</span>
            </div>
            <div id="pj-list"></div>
          </section>
        </section>

        <!-- 连接设置 -->
        <section class="view" data-view="settings">
          <header class="page-header">
            <div>
              <h1>连接设置</h1>
              <p>当前会话的连接信息（由浏览器唤起时自动写入，只读）。</p>
            </div>
          </header>

          <section class="card detail-card">
            <h2>会话信息</h2>
            <dl class="detail-list">
              <div class="detail-row"><dt>连接状态</dt><dd id="st-state">待命</dd></div>
              <div class="detail-row"><dt>服务器</dt><dd id="st-server" class="mono">—</dd></div>
              <div class="detail-row"><dt>会话 ID</dt><dd id="st-session" class="mono">—</dd></div>
              <div class="detail-row"><dt>WebSocket</dt><dd id="st-ws" class="mono">—</dd></div>
              <div class="detail-row"><dt>授权项目</dt><dd id="st-project" class="mono">—</dd></div>
              <div class="detail-row"><dt>连接器版本</dt><dd id="st-version">—</dd></div>
              <div class="detail-row"><dt>最低要求版本</dt><dd id="st-minversion">—</dd></div>
              <div class="detail-row"><dt>最近心跳</dt><dd id="st-heartbeat">—</dd></div>
            </dl>
            <div class="detail-error" id="st-error" hidden></div>
          </section>

          <div class="actions">
            <button class="secondary-action" id="st-copy">复制诊断信息</button>
          </div>
        </section>

        <!-- 关于 -->
        <section class="view" data-view="about">
          <header class="page-header">
            <div>
              <h1>关于</h1>
              <p>AutoCode Local Connector</p>
            </div>
          </header>

          <section class="card about-card">
            <div class="about-hero">
              <span class="brand-mark large">AC</span>
              <div>
                <strong>AutoCode Local Connector</strong>
                <span id="ab-version">版本 —</span>
              </div>
            </div>
            <p class="about-lead">
              把 AutoCode 的能力安全地接入你本机的项目：AI 在你授权的目录内读取、修改、运行测试，
              全程遵循 AutoCode 的命令审批策略。
            </p>
            <dl class="detail-list">
              <div class="detail-row"><dt>唤起协议</dt><dd class="mono">muhuo-autocode://</dd></div>
              <div class="detail-row"><dt>连接方式</dt><dd>本机主动向 AutoCode 建立出站 WebSocket，无需公网 IP 或开放端口</dd></div>
              <div class="detail-row"><dt>数据范围</dt><dd>仅限你显式授权的项目目录，遵循 .autocodeignore 忽略规则</dd></div>
            </dl>
            <div class="notice">
              <span class="lock-icon"></span>
              <span>连接器不会上传授权目录以外的任何文件，敏感文件（.env、密钥等）默认被忽略。</span>
            </div>
          </section>
        </section>
      </main>
    </div>
  `

  // 导航切换（纯前端，无需重新拉取）
  document.querySelectorAll<HTMLButtonElement>('#nav .nav-item').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view as ViewId))
  })

  document.querySelector<HTMLButtonElement>('#ov-refresh')?.addEventListener('click', () => {
    void syncStatus(true)
  })

  document.querySelector<HTMLButtonElement>('#ov-choose')?.addEventListener('click', async () => {
    const button = document.querySelector<HTMLButtonElement>('#ov-choose')
    if (button) {
      button.disabled = true
      button.textContent = '正在打开选择框...'
    }
    try {
      const next = await invoke<UiStatus>('choose_project_and_connect')
      applyStatus(next)
    } catch (error) {
      applyStatus({ ...lastStatus, status: 'error', last_error: String(error), connected: false, running: false })
    } finally {
      if (button) {
        button.disabled = false
        button.textContent = '选择项目目录并连接'
      }
    }
  })

  document.querySelector<HTMLButtonElement>('#st-copy')?.addEventListener('click', async event => {
    const button = event.currentTarget as HTMLButtonElement
    const ok = await copyDiagnostics()
    button.textContent = ok ? '已复制' : '复制失败'
    button.classList.add('is-done')
    window.setTimeout(() => {
      button.textContent = '复制诊断信息'
      button.classList.remove('is-done')
    }, 1400)
  })

  // 项目列表事件委托（列表内容会重建，处理器只绑一次）
  document.querySelector<HTMLDivElement>('#pj-list')?.addEventListener('click', async event => {
    const row = (event.target as HTMLElement).closest<HTMLButtonElement>('.project-row')
    if (!row) return
    const grantId = row.dataset.grantId || ''
    if (!grantId) return
    row.classList.remove('row-error')
    try {
      await invoke('open_local_project_grant', { grantId })
    } catch (error) {
      row.classList.add('row-error')
      const target = row.querySelector('.project-time-cell')
      if (target) target.textContent = String(error)
    }
  })
}

function switchView(view: ViewId) {
  if (!view || view === currentView) return
  currentView = view
  document.querySelectorAll<HTMLButtonElement>('#nav .nav-item').forEach(button => {
    button.classList.toggle('active', button.dataset.view === view)
  })
  document.querySelectorAll<HTMLElement>('.content .view').forEach(section => {
    section.classList.toggle('active', section.dataset.view === view)
  })
}

function setText(id: string, value: string) {
  const node = document.getElementById(id)
  if (node && node.textContent !== value) node.textContent = value
}

function setTone(id: string, base: string, tone: Tone) {
  const node = document.getElementById(id)
  if (!node) return
  const next = `${base} ${tone}`
  if (node.className !== next) node.className = next
}

function applyStatus(status: UiStatus) {
  lastStatus = status
  renderStatusBits()
}

function renderStatusBits() {
  const status = lastStatus
  const tone = statusTone(status)
  const label = statusLabel(status)
  const title = serviceTitle(status)
  const desc = serviceDescription(status)
  const version = status.version || '—'
  const heartbeat = status.last_heartbeat_at
    ? `${formatBeijingTime(status.last_heartbeat_at)}（${relativeTime(status.last_heartbeat_at)}）`
    : '—'

  // 侧栏
  setTone('mini-dot', 'status-dot', tone)
  setText('mini-title', title)
  setText('mini-version', `版本 ${version}`)

  // 概览
  setText('ov-badge', label)
  setTone('ov-badge', 'status-badge', tone)
  setText('ov-desc', desc)
  setTone('ov-icon', 'service-icon', tone)
  setText('ov-title', title)
  setText('ov-sub', desc)
  setText('ov-version', status.min_version ? `${version} / 最低 ${status.min_version}` : version)
  setText('ov-project', status.project || '未选择')
  setText('ov-heartbeat', heartbeat)

  const ovError = document.getElementById('ov-error')
  if (ovError) {
    if (status.last_error) {
      ovError.textContent = status.last_error
      ovError.hidden = false
    } else {
      ovError.hidden = true
    }
  }

  const chooseBtn = document.getElementById('ov-choose') as HTMLButtonElement | null
  if (chooseBtn) chooseBtn.hidden = !status.needs_project

  // 连接设置
  setText('st-state', label)
  setText('st-server', status.server || '—')
  setText('st-session', status.session || '—')
  setText('st-ws', status.redacted_ws_url || '—')
  setText('st-project', status.project || '—')
  setText('st-version', version)
  setText('st-minversion', status.min_version || '—')
  setText('st-heartbeat', heartbeat)

  const stError = document.getElementById('st-error')
  if (stError) {
    if (status.last_error) {
      stError.textContent = `最近错误：${status.last_error}`
      stError.hidden = false
    } else {
      stError.hidden = true
    }
  }

  // 关于
  setText('ab-version', `版本 ${version}`)
}

function grantListHtml(grants: LocalProjectGrant[]) {
  if (!grants.length) {
    return `
      <div class="empty-state">
        <div class="empty-icon"></div>
        <div>
          <p>暂无授权项目</p>
          <span>从网页一键连接成功后，项目会自动保存到这里。</span>
        </div>
      </div>
    `
  }
  return `
    <div class="project-table">
      <div class="project-head">
        <span>项目名</span>
        <span>最后授权时间</span>
      </div>
      ${grants.map(grant => `
        <button class="project-row" data-grant-id="${escapeHtml(grant.grant_id)}" title="在浏览器中打开">
          <span class="project-name-cell">
            <i class="folder-icon"></i>
            <span class="project-name-text">
              <strong>${escapeHtml(grant.project_name || '本地项目')}</strong>
              <small>${escapeHtml(grant.project_root)}</small>
            </span>
          </span>
          <span class="project-time-cell">
            ${escapeHtml(formatBeijingTime(grant.last_used_at || grant.expires_at))}
            <span class="open-hint">打开 →</span>
          </span>
        </button>
      `).join('')}
    </div>
  `
}

function renderGrants(grants: LocalProjectGrant[]) {
  const key = JSON.stringify(grants.map(g => [g.grant_id, g.project_name, g.project_root, g.last_used_at]))
  lastGrants = grants
  setText('ov-grantcount', String(grants.length))
  setText('pj-count', `${grants.length} 个项目`)
  if (key === lastGrantsKey) return
  lastGrantsKey = key
  const list = document.getElementById('pj-list')
  if (list) list.innerHTML = grantListHtml(grants)
}

async function copyDiagnostics() {
  try {
    const text = await invoke<string>('connector_diagnostics')
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

async function syncStatus(force = false) {
  const [status, grants] = await Promise.all([
    invoke<UiStatus>('connector_status').catch<UiStatus>(error => ({
      ...FALLBACK_STATUS,
      status: 'error',
      last_error: String(error),
    })),
    invoke<LocalProjectGrant[]>('local_project_grants').catch(() => [] as LocalProjectGrant[]),
  ])
  applyStatus(status)
  renderGrants(grants)
  if (force) {
    // 强制刷新时给个轻量反馈
    const refresh = document.getElementById('ov-refresh')
    refresh?.classList.add('is-done')
    window.setTimeout(() => refresh?.classList.remove('is-done'), 500)
  }
}

buildShell()
renderStatusBits()
renderGrants(lastGrants)
void syncStatus()
window.setInterval(() => {
  void syncStatus()
}, 2000)
