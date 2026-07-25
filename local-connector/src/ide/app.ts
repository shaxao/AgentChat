import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { AutoCodeApi } from './api'
import { CodeEditor, type AiCompletionContext } from './editor'
import { TerminalPanel } from './terminal'
import { createInitialState, loadSessionSnapshot, saveLayout, saveSessionSnapshot, saveTheme, type IdeSessionSnapshot } from './state'
import type {
  ActivityView,
  AgentEvent,
  AppState,
  Attachment,
  ComposerMode,
  DockTab,
  EditorTab,
  IdeBootstrap,
  IdeSettings,
  RecentProject,
  ToolCallRecord,
  WorkspaceEntry,
  WorkspaceFileSnapshot,
  WorkspaceFileStat,
  WorkspaceGitStatus,
  WorkspaceSearchResult,
} from './types'
import {
  basename,
  bytesLabel,
  compactPath,
  dirty,
  escapeHtml,
  findEntry,
  flattenEntries,
  formatTime,
  guessLanguage,
  nowLabel,
  projectName,
  relativeParent,
} from './utils'

type TerminalSessionInfo = {
  session_id: string
  shell: string
  cwd?: string
  ok?: boolean
  interactive?: boolean
  probe_output?: string
  fallback_from?: string
  local_echo?: boolean
  message?: string
}
type TerminalOutputEvent = { session_id: string; stream: string; data: string }
type TerminalExitEvent = { session_id: string; exit_code: number }

export class AutoCodeIde {
  private readonly state: AppState = createInitialState()
  private readonly api = new AutoCodeApi(() => this.state.settings)
  private readonly editor = new CodeEditor()
  private readonly terminal = new TerminalPanel()
  private externalPoll = 0
  private commandFilter = ''
  private voiceSessionId = ''
  private composerDraft = ''
  private terminalLastOutputAt = 0
  private terminalOutputBuffer = ''
  private terminalLocalEcho = false
  private terminalCommandMode = false
  private terminalCommandCwd = ''
  private terminalCommandShell = 'cmd.exe'
  private terminalCommandLine = ''
  private terminalCommandCursor = 0
  private terminalCommandHistory: string[] = []
  private terminalCommandHistoryIndex = -1
  private activeAssistantMessageId = ''
  private lastAssistantResponseText = ''
  private assistantTypingQueue = ''
  private assistantTypingTimer = 0
  private assistantTypingMessageId = ''
  private pendingToolProtocolBuffer = ''
  private sessionPersistTimer = 0
  private pendingSessionSnapshot: IdeSessionSnapshot | null = null
  private aiCompletionTimer = 0
  private aiCompletionAbort = 0
  private inlineCompletion = ''
  private pendingAiFallbackTimer = 0
  private pendingAiRequest: { prompt: string; contextRefs: any[] } | null = null
  private aiFallbackRunning = false
  private activeTurnStartedAt = 0
  private activeTurnToolIds: string[] = []
  private browserSpeech: any = null
  private browserSpeechText = ''
  private agentEventSource: EventSource | null = null
  private agentEventReconnectTimer = 0
  private lastAgentEventId = 0
  private seenAgentEventIds: number[] = []
  private seenAgentEventKeys: string[] = []
  private toolCompletionTimers: Record<string, number> = {}
  private toolCompletionSequence = 0
  private aiTemperature = Number(localStorage.getItem('autocode.ide.ai.temperature') || '0.2')
  private aiSystemPrompt = localStorage.getItem('autocode.ide.ai.systemPrompt') || '你是 AutoCode 本地 IDE 内置的 AI 开发助手。请基于用户本地工作区上下文给出可执行的代码开发建议。涉及文件修改时，优先输出按文件分组的清晰 patch 或完整替换片段，并说明验证命令。'
  private aiContextBudget = Number(localStorage.getItem('autocode.ide.ai.contextBudget') || '18000')

  constructor(private readonly root: HTMLElement) {}

  async start() {
    this.renderShell()
    this.applyTheme()
    this.mountEditor()
    this.mountTerminal()
    this.bindStaticEvents()
    this.applyLayout()
    window.addEventListener('beforeunload', () => this.persistSessionSnapshot())
    window.addEventListener('pagehide', () => this.persistSessionSnapshot())
    window.addEventListener('unload', () => this.persistSessionSnapshot())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.persistSessionSnapshot()
    })
    await this.bindBackendEvents()
    await this.bootstrap()
    this.externalPoll = window.setInterval(() => void this.checkExternalChanges(), 5000)
  }

  private async bindBackendEvents() {
    await listen<RecentProject>('connector://open-project', event => void this.openWorkspace(event.payload))
    await listen<TerminalOutputEvent>('ide://pty-output', event => {
      const record = this.state.terminalSessions.find(item => item.id === event.payload.session_id)
      if (record) {
        record.lastOutput = `${record.lastOutput}${event.payload.data}`.slice(-20000)
        record.health = 'ready'
      }
      if (event.payload.session_id === this.state.terminalSessionId) {
        this.terminalLastOutputAt = Date.now()
        this.terminalOutputBuffer = `${this.terminalOutputBuffer}${event.payload.data}`.slice(-12000)
        this.state.terminal.lastOutput = this.terminalOutputBuffer
        this.state.terminal.health = 'ready'
        this.terminal.write(event.payload.data)
        this.renderProblems()
        this.scheduleSessionPersist()
      }
    })
    await listen<TerminalExitEvent>('ide://pty-exit', event => {
      const record = this.state.terminalSessions.find(item => item.id === event.payload.session_id)
      if (record) record.health = 'idle'
      if (event.payload.session_id === this.state.terminalSessionId) {
        this.terminal.writeln(`[terminal exited: ${event.payload.exit_code}]`)
        this.state.terminalSessionId = ''
        this.state.terminal.running = false
        this.state.terminal.health = 'idle'
        this.renderProblems()
        this.scheduleSessionPersist()
      }
    })
    await listen<AgentEvent>('ide://agent-event', event => {
      this.handleAgentEvent(event.payload)
    })
  }

  private async bootstrap() {
    try {
      const boot = await invoke<IdeBootstrap>('ide_bootstrap')
      this.state.version = boot.version
      this.state.settings = boot.settings
      this.state.previewUrl = boot.settings.preview_url
      const diskSnapshot = await this.api.loadSession(null).catch(() => null)
      this.pendingSessionSnapshot = this.newerSessionSnapshot(diskSnapshot, loadSessionSnapshot())
      if (this.pendingSessionSnapshot?.settings) {
        const bootSettings = this.state.settings
        const snapshotSettings = this.pendingSessionSnapshot.settings
        this.state.settings = {
          ...bootSettings,
          ...snapshotSettings,
          last_workspace_path: bootSettings.last_workspace_path || snapshotSettings.last_workspace_path || '',
          default_workspace_path: bootSettings.default_workspace_path || snapshotSettings.default_workspace_path || '',
          recent_projects: bootSettings.recent_projects.length
            ? bootSettings.recent_projects
            : snapshotSettings.recent_projects || [],
        }
        this.state.previewUrl = this.state.settings.preview_url || this.state.previewUrl
      }
      if (this.pendingSessionSnapshot?.theme) {
        this.state.theme = this.pendingSessionSnapshot.theme
        this.applyTheme()
      }
      if (typeof this.pendingSessionSnapshot?.aiTemperature === 'number') this.aiTemperature = this.pendingSessionSnapshot.aiTemperature
      if (typeof this.pendingSessionSnapshot?.aiContextBudget === 'number') this.aiContextBudget = this.pendingSessionSnapshot.aiContextBudget
      if (this.pendingSessionSnapshot?.aiSystemPrompt) this.aiSystemPrompt = this.pendingSessionSnapshot.aiSystemPrompt
      const recent = this.resolveStartupProject()
      if (recent) await this.openWorkspace(recent, false)
      else this.renderAll()
      await this.refreshLocalServerStatus()
      this.toast('AutoCode IDE 已就绪', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
      this.renderAll()
    }
  }

  private newerSessionSnapshot(left: IdeSessionSnapshot | null, right: IdeSessionSnapshot | null) {
    if (!left) return right
    if (!right) return left
    return Date.parse(left.savedAt || '') >= Date.parse(right.savedAt || '') ? left : right
  }

  private currentRoot() {
    return this.state.workspace.currentProject?.path || this.state.settings.last_workspace_path || ''
  }

  private resolveStartupProject(): RecentProject | null {
    const snapshotProject = this.pendingSessionSnapshot?.currentProject || null
    if (snapshotProject?.path) return snapshotProject
    const snapshotLastPath = this.pendingSessionSnapshot?.settings?.last_workspace_path || ''
    if (snapshotLastPath.trim()) {
      return {
        path: snapshotLastPath,
        name: projectName(snapshotLastPath),
        preview_url: this.pendingSessionSnapshot?.settings?.preview_url || '',
      }
    }
    const recent = this.state.settings.recent_projects?.[0]
    if (recent?.path) return recent
    return this.projectFromLastPath()
  }

  private projectFromLastPath(): RecentProject | null {
    const path = this.state.settings.last_workspace_path || ''
    if (!path.trim()) return null
    return {
      path,
      name: projectName(path),
      task_id: '',
      preview_url: this.state.settings.preview_url || '',
      last_opened_at: new Date().toISOString(),
    }
  }

  private activeTab() {
    return this.state.workspace.tabs.find(tab => tab.path === this.state.workspace.activePath) || null
  }

  private selectedWorkspacePath() {
    return this.state.workspace.selectedPath || ''
  }

  private selectedWorkspaceEntry() {
    return findEntry(this.state.workspace.tree, this.selectedWorkspacePath())
  }

  private defaultTerminalShellArg() {
    const shell = (this.state.settings.default_shell || 'auto').toLowerCase()
    if (shell === 'cmd' || shell === 'cmd.exe') return 'cmd.exe'
    if (shell === 'powershell' || shell === 'powershell.exe') return 'powershell.exe'
    if (shell === 'pwsh' || shell === 'pwsh.exe') return 'pwsh.exe'
    return this.isWindowsRuntime() ? 'cmd.exe' : ''
  }

  private selectedTerminalShell() {
    const shell = this.$<HTMLSelectElement>('#terminal-shell-select')?.value || this.defaultTerminalShellArg()
    if (!shell && !this.isWindowsRuntime()) return ''
    if (shell === 'powershell' || shell === 'powershell.exe') return 'powershell.exe'
    if (shell === 'pwsh' || shell === 'pwsh.exe') return 'pwsh.exe'
    return this.isWindowsRuntime() ? 'cmd.exe' : ''
  }

  private formatTerminalPrompt(shell: string, cwd: string) {
    const promptPath = this.formatTerminalPath(cwd)
    const lower = shell.toLowerCase()
    if (lower.includes('powershell') || lower.includes('pwsh')) return `PS ${promptPath}>`
    return `${promptPath}>`
  }

  private createParentPath() {
    const selected = this.selectedWorkspacePath()
    const entry = this.selectedWorkspaceEntry()
    if (!selected) return ''
    return entry?.kind === 'dir' ? selected : relativeParent(selected)
  }

  private renderShell() {
    this.root.innerHTML = `
      <div class="ide-shell" id="ide-shell">
        <aside class="activity-rail">
          <div class="brand-mark">AI</div>
          <button class="rail-action active" data-activity="explorer" title="资源管理器">▤</button>
          <button class="rail-action" data-activity="search" title="搜索">⌕</button>
          <button class="rail-action" data-activity="git" title="Git">⑂</button>
          <button class="rail-action" data-activity="skills" title="技能">✦</button>
          <button class="rail-action" id="command-trigger" title="命令面板">⌘</button>
          <span class="rail-spacer"></span>
          <button class="rail-action" id="toggle-assistant" title="AI 助手">AI</button>
          <button class="rail-action" data-activity="settings" title="设置">⚙</button>
        </aside>

        <aside class="side-pane" id="side-pane">
          <div class="pane-resizer right" data-resize="explorer"></div>
          <section class="project-switcher">
            <div><strong>AutoCode IDE</strong><span id="version-label">Local AI Workspace</span></div>
            <button class="icon-button" id="refresh-workspace" title="刷新">↻</button>
          </section>
          <section class="project-actions">
            <button class="primary-button" id="pick-workspace">打开项目</button>
            <button class="secondary-button" id="create-task-top">新建任务</button>
          </section>
          <section class="workspace-card">
            <span>当前工作区</span>
            <strong id="workspace-name">未打开项目</strong>
            <small id="workspace-path">选择本地项目开始开发</small>
            <div class="workspace-stats">
              <b><span id="file-count">0</span> 文件</b>
              <b><span id="branch-name">-</span> 分支</b>
            </div>
          </section>

          <section class="side-view active" data-side-view="explorer">
            <div class="section-title"><span>资源管理器</span><button class="text-button" id="open-system">系统打开</button></div>
            <div class="selected-target" id="selected-target">当前选中：工作区根目录</div>
            <div class="file-tree" id="file-tree"></div>
          </section>

          <section class="side-view" data-side-view="search">
            <div class="section-title"><span>工作区搜索</span><button class="text-button" id="run-search">搜索</button></div>
            <input id="search-input" placeholder="搜索文件名或内容" spellcheck="false" />
            <label class="check-row"><input id="search-content" type="checkbox" /> 包含文件内容</label>
            <div class="search-results" id="search-results"></div>
          </section>

          <section class="side-view" data-side-view="git">
            <div class="section-title"><span>Git 状态</span><button class="text-button" id="refresh-git">刷新</button></div>
            <div class="git-mini" id="git-mini"></div>
          </section>

          <section class="side-view" data-side-view="skills">
            <div class="section-title"><span>技能商店</span><button class="text-button" id="load-skills">刷新</button></div>
            <input id="skill-query" placeholder="搜索技能" spellcheck="false" />
            <div class="skill-list" id="skill-list"></div>
          </section>

          <section class="recent-section">
            <div class="section-title"><span>最近项目</span></div>
            <div class="recent-list" id="recent-list"></div>
          </section>
        </aside>

        <main class="workbench">
          <header class="topbar">
            <div class="crumb"><span class="status-dot"></span><strong id="context-project">未打开项目</strong><small id="context-path">等待选择工作区</small></div>
            <div class="topbar-actions">
              <select class="topbar-select" id="workbench-provider" title="Provider">
                <option value="openai-responses">OpenAI Responses</option>
                <option value="openai-chat">OpenAI Chat</option>
                <option value="anthropic-messages">Claude</option>
                <option value="dashscope-qwen">Qwen</option>
                <option value="deepseek">DeepSeek</option>
                <option value="kimi">Kimi</option>
                <option value="xai-grok">Grok</option>
                <option value="custom-openai-compatible">Custom</option>
              </select>
              <select class="topbar-select model-select" id="workbench-model" title="当前模型"></select>
              <button class="secondary-button" id="refresh-models-top">刷新模型</button>
              <span class="account-pill" id="account-pill">余额未查询</span>
              <button class="secondary-button" id="test-api">测试 API</button>
              <button class="secondary-button" id="open-settings">设置</button>
              <button class="primary-button" id="save-file" disabled>保存</button>
            </div>
          </header>
          <nav class="tabbar" id="tabbar"></nav>
          <section class="editor-stage">
            <div class="empty-editor" id="empty-editor">
              <div class="hero-copy">
                <span>AI IDE · Local First</span>
                <h1>打开文件，开始本地开发</h1>
                <p>文件树、代码编辑器、内置终端、预览、Git 和 AI 助手都在这个工作台里。目录可以展开，终端可以直接输入命令，AI 会带上当前上下文。</p>
                <div class="hero-actions"><button class="primary-button" id="quick-open">打开本地项目</button><button class="secondary-button" id="quick-command">命令面板</button></div>
              </div>
              <div class="hero-console" aria-hidden="true"><span>AutoCode plan</span><code>read_workspace()</code><code>edit_current_file()</code><code>run_validation()</code><code class="good">local checks passed</code></div>
            </div>
            <div class="editor-host" id="editor-host" hidden>
              <div class="editor-toolbar">
                <div><strong id="editor-title">未打开文件</strong><span id="editor-meta">-</span></div>
                <div class="editor-actions">
                  <button class="secondary-button" id="reload-file">重新载入</button>
                  <button class="secondary-button" id="copy-path">复制路径</button>
                  <button class="secondary-button" id="ai-explain">解释</button>
                  <button class="secondary-button" id="ai-review">审查</button>
                </div>
              </div>
              <div class="codemirror-host" id="codemirror-host"></div>
              <footer class="statusbar"><span id="cursor-status">Ready</span><span id="encoding-status">UTF-8</span><span id="line-status">LF</span><span id="dirty-status">已同步</span></footer>
            </div>
          </section>

          <section class="bottom-dock" id="bottom-dock">
            <div class="pane-resizer top" data-resize="bottom"></div>
            <nav class="dock-tabs">
              <button class="dock-tab active" data-dock="terminal">终端</button>
              <button class="dock-tab" data-dock="preview">预览</button>
              <button class="dock-tab" data-dock="git">Git</button>
              <button class="dock-tab" data-dock="problems">问题</button>
              <button class="dock-tab" data-dock="skills">技能</button>
              <span></span>
              <select class="terminal-shell-select" id="terminal-shell-select" title="终端 shell">
                <option value="cmd.exe">cmd.exe</option>
                <option value="powershell.exe">PowerShell</option>
                <option value="pwsh.exe">pwsh</option>
              </select>
              <select class="terminal-session-select" id="terminal-session-select" title="终端会话"></select>
              <button class="icon-button" id="new-terminal" title="新建终端">＋</button>
              <button class="icon-button" id="close-terminal" title="关闭当前终端">×</button>
              <button class="icon-button" id="clear-terminal" title="清屏">⌫</button>
              <button class="icon-button" id="restart-terminal" title="重启终端">⟳</button>
              <button class="icon-button" id="toggle-bottom" title="折叠">⌄</button>
            </nav>
            <div class="dock-panel active" data-dock-panel="terminal">
              <div class="terminal-host" id="terminal-host"></div>
              <div class="terminal-actions">
                <button data-command="npm run dev">启动服务</button>
                <button data-command="npm run build">运行构建</button>
                <button data-command="npm test">运行测试</button>
                <button data-command="git status --short">Git 状态</button>
              </div>
              <div class="command-row"><input id="command-input" placeholder="也可以直接在上方终端输入命令，或在这里输入后按 Enter" spellcheck="false" /><button class="primary-button" id="run-command">运行</button></div>
            </div>
            <div class="dock-panel" data-dock-panel="preview">
              <div class="browser-bar"><input id="preview-url" placeholder="http://localhost:5173" spellcheck="false" /><button class="secondary-button" id="load-preview">打开</button><button class="secondary-button" id="reload-preview">刷新</button><button class="secondary-button" id="open-preview-external">外部打开</button></div>
              <div class="preview-shell">
                <iframe id="preview-frame" title="Project preview" allow="clipboard-read; clipboard-write; fullscreen"></iframe>
                <div class="preview-status" id="preview-status">
                  <strong>输入预览地址</strong>
                  <span>启动开发服务后打开 http://localhost:5173</span>
                </div>
              </div>
            </div>
            <div class="dock-panel" data-dock-panel="git"><div class="git-summary" id="git-summary">打开项目后显示 Git 状态。</div><pre class="git-diff" id="git-diff"></pre></div>
            <div class="dock-panel" data-dock-panel="problems"><div class="problem-list" id="problem-list"></div></div>
            <div class="dock-panel" data-dock-panel="skills"><div class="skill-list dock-skill-list" id="dock-skill-list"></div></div>
          </section>
        </main>

        <aside class="assistant-pane" id="assistant-pane">
          <div class="pane-resizer left" data-resize="assistant"></div>
          <header class="assistant-head"><div><strong>AI 开发助手</strong><span>AutoCode API · Local Runner</span></div><button class="icon-button" id="refresh-task">↻</button></header>
          <section class="assistant-state">
            <div class="notice-card" id="task-status">暂无任务。输入需求后可创建 AutoCode 任务。</div>
            <div class="assistant-metrics"><span>API <b id="api-status">待配置</b></span><span>项目 <b id="project-status">未打开</b></span></div>
            <div class="request-card" id="request-timeline" hidden></div>
            <div id="agent-runtime-panel"></div>
          </section>
          <section class="assistant-thread" id="assistant-thread"></section>
          <section class="composer">
            <div class="composer-modes">
              <button class="active" data-composer-mode="text">文本</button>
              <button data-composer-mode="image">图片</button>
              <button data-composer-mode="voice">语音</button>
              <button data-composer-mode="file">文件</button>
            </div>
            <div class="composer-body" id="composer-body"></div>
            <div class="composer-toolbar">
              <button class="tool-chip" id="attach-file">当前文件</button>
              <span></span>
              <button class="primary-button" id="create-task">发送</button>
            </div>
          </section>
        </aside>
      </div>

      <div class="settings-overlay" id="settings-overlay" hidden></div>
      <aside class="settings-drawer" id="settings-drawer" hidden>
        <header><div><strong>连接器设置</strong><span>API URL、Key、默认目录和预览地址</span></div><button class="icon-button" id="close-settings">×</button></header>
        <label><span>连接模式</span><select id="connection-mode"><option value="aiProvider">本地 Provider</option><option value="autocodePlatform">AutoCode 平台</option><option value="webConnector">网页连接器</option></select></label>
        <label><span>Provider</span><select id="provider-type"><option value="openai-responses">OpenAI Responses</option><option value="openai-chat">OpenAI Chat Completions</option><option value="anthropic-messages">Claude /v1/messages</option><option value="dashscope-qwen">阿里千问 DashScope</option><option value="deepseek">DeepSeek</option><option value="kimi">Kimi / Moonshot</option><option value="xai-grok">Grok / xAI</option><option value="custom-openai-compatible">自定义 OpenAI 兼容</option></select></label>
        <label><span>API URL</span><input id="api-base-url" spellcheck="false" placeholder="https://api.openai.com 或你的兼容服务地址" /></label>
        <label><span>API Key</span><input id="api-key" type="password" spellcheck="false" /></label>
        <label><span>模型</span><input id="provider-model" list="provider-model-list" spellcheck="false" placeholder="gpt-5 / claude-sonnet-4-5 / deepseek-reasoner ..." /><datalist id="provider-model-list"></datalist></label>
        <label><span>云端转写模型（可选）</span><input id="transcription-model" spellcheck="false" placeholder="留空时只尝试 Windows 原生语音识别" /></label>
        <div class="settings-row"><button class="secondary-button" id="refresh-models">刷新模型</button><button class="secondary-button" id="refresh-account">查询余额</button></div>
        <div class="provider-status" id="provider-status">模型和余额状态会显示在这里。</div>
        <label><span>思考模式</span><select id="reasoning-mode"><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="custom">自定义</option></select></label>
        <label><span>思考等级 / 自定义值</span><input id="reasoning-effort" spellcheck="false" placeholder="low / medium / high / xhigh" /></label>
        <label><span>思考预算 tokens</span><input id="reasoning-budget" type="number" min="1024" step="1024" /></label>
        <label><span>温度</span><input id="settings-temperature" type="number" min="0" max="2" step="0.1" /></label>
        <label><span>上下文预算</span><input id="settings-context-budget" type="number" min="2000" max="200000" step="1000" /></label>
        <label><span>系统提示词</span><textarea id="settings-system-prompt" spellcheck="false"></textarea></label>
        <label><span>默认终端</span><select id="default-shell"><option value="auto">自动：PowerShell 失败切 cmd</option><option value="powershell">PowerShell</option><option value="cmd">cmd.exe</option></select></label>
        <label><span>默认工作目录</span><input id="default-workspace-path" spellcheck="false" /></label>
        <label><span>预览地址</span><input id="settings-preview-url" spellcheck="false" /></label>
        <label><span>主题</span><select id="theme-select"><option value="auto-dark">Auto Dark</option><option value="graphite">Graphite</option><option value="light">Light</option></select></label>
        <button class="secondary-button" id="test-api">测试连接</button>
        <button class="primary-button" id="save-settings">保存设置</button>
      </aside>

      <section class="command-center" id="command-center" hidden>
        <div class="command-panel">
          <header><strong>命令面板</strong><button class="icon-button" id="close-command">×</button></header>
          <input id="command-search" placeholder="搜索命令或文件" spellcheck="false" />
          <div class="command-list" id="command-list"></div>
        </div>
      </section>
      <div class="context-menu" id="context-menu" hidden></div>
    `
  }

  private mountEditor() {
    const host = this.$('#codemirror-host')
    if (host) {
      this.editor.mount(host, value => this.updateDraft(value), () => void this.saveActiveFile())
      this.editor.setAiCompletionProvider(context => this.requestInlineCompletion(context))
    }
  }

  private mountTerminal() {
    const host = this.$('#terminal-host')
    if (host) {
      this.terminal.mount(
        host,
        data => void this.writeTerminalInput(data),
        (cols, rows) => void this.resizeTerminal(cols, rows),
      )
    }
  }

  private bindStaticEvents() {
    this.root.addEventListener('click', event => this.handleClick(event))
    this.root.addEventListener('contextmenu', event => this.handleContextMenu(event))
    this.root.addEventListener('input', event => this.handleInput(event))
    this.root.addEventListener('change', event => this.handleChange(event))
    this.root.addEventListener('paste', event => void this.handlePaste(event))
    document.addEventListener('keydown', event => this.handleKeydown(event))
    document.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('#context-menu')) this.hideContextMenu()
    })
    this.bindResizeHandles()
  }

  private handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    const button = target.closest<HTMLElement>('button')
    if (!button) return

    const mode = button.dataset.composerMode as ComposerMode | undefined
    const activity = button.dataset.activity as ActivityView | undefined
    const dock = button.dataset.dock as DockTab | undefined
    const command = button.dataset.command
    const tabPath = button.dataset.tabPath
    const openPath = button.dataset.openPath
    const recentPath = button.dataset.recentPath
    const commandAction = button.dataset.commandAction
    const agentId = button.dataset.agentId
    const removeAttachment = button.dataset.removeAttachment
    const copyCode = button.dataset.copyCode
    const applyPatch = button.dataset.applyPatch
    const editorCopyPath = button.dataset.editorCopyPath
    const closeTab = button.dataset.closeTab
    const closeOtherTabs = button.dataset.closeOtherTabs
    const agentApprove = button.dataset.agentApprove
    const agentDeny = button.dataset.agentDeny

    if (agentApprove) void this.answerAgentPermission(agentApprove, true)
    else if (agentDeny) void this.answerAgentPermission(agentDeny, false)
    else if (copyCode) void this.copyChatCode(copyCode)
    else if (applyPatch) void this.applyChatPatch(applyPatch)
    else if (editorCopyPath) void this.copyEditorPath(editorCopyPath as any)
    else if (closeTab) this.closeTab(closeTab)
    else if (closeOtherTabs) this.closeOtherTabs(closeOtherTabs)
    else if (mode) this.switchComposerMode(mode)
    else if (activity) this.switchActivity(activity)
    else if (dock) this.switchDock(dock)
    else if (command) void this.runCommand(command)
    else if (tabPath) this.activateTab(tabPath)
    else if (openPath) void this.handleTreeOpen(openPath)
    else if (recentPath) {
      const project = this.state.settings.recent_projects.find(item => item.path === recentPath)
      if (project) void this.openWorkspace(project)
    } else if (commandAction) this.runCommandAction(commandAction)
    else if (agentId) void this.installSkill(agentId)
    else if (removeAttachment !== undefined) this.removeAttachment(Number(removeAttachment))
    else this.handleButton(button.id, button)
  }

  private handleButton(id: string, button?: HTMLElement) {
    if (id === 'pick-workspace' || id === 'quick-open') void this.pickWorkspace()
    if (id === 'create-task-top') this.focusComposer()
    if (id === 'refresh-workspace') void this.refreshWorkspace(true)
    if (id === 'open-system') void this.openSystem()
    if (id === 'new-file') void this.createEntry('file')
    if (id === 'new-folder') void this.createEntry('dir')
    if (id === 'rename-entry') void this.renameEntry()
    if (id === 'delete-entry') void this.deleteEntry()
    if (id === 'run-search') void this.searchWorkspace()
    if (id === 'refresh-git') void this.refreshGit()
    if (id === 'load-skills') void this.loadSkills()
    if (id === 'test-api') void this.testApi()
    if (id === 'refresh-models' || id === 'refresh-models-top') void this.refreshProviderModels()
    if (id === 'refresh-account' || id === 'account-pill') void this.refreshProviderAccount()
    if (id === 'open-settings' || id === 'quick-settings') this.openSettings()
    if (id === 'save-file') void this.saveActiveFile()
    if (id === 'reload-file') void this.reloadActiveFile()
    if (id === 'copy-path' && button) this.showEditorPathMenu(button)
    if (id === 'copy-relative-path') void this.copyActivePath('relative')
    if (id === 'copy-absolute-path') void this.copyActivePath('absolute')
    if (id === 'copy-file-name') void this.copyActivePath('name')
    if (id === 'copy-parent-path') void this.copyActivePath('parent')
    if (id === 'ai-explain') this.prepareAiPrompt('请解释当前文件的核心逻辑，并指出潜在风险。')
    if (id === 'ai-review') this.prepareAiPrompt('请对当前文件和 Git diff 做代码审查，按严重程度列出问题。')
    if (id === 'quick-command' || id === 'command-trigger') this.openCommandCenter()
    if (id === 'close-command') this.closeCommandCenter()
    if (id === 'toggle-assistant') this.toggleAssistant()
    if (id === 'toggle-bottom') this.toggleBottom()
    if (id === 'clear-terminal') this.terminal.clear()
    if (id === 'restart-terminal') void this.restartTerminal()
    if (id === 'new-terminal') void this.startTerminal(this.selectedTerminalShell(), true)
    if (id === 'close-terminal') void this.killTerminal()
    if (id === 'run-command') void this.runCommandFromInput()
    if (id === 'load-preview' || id === 'reload-preview') this.loadPreview()
    if (id === 'open-preview-external') void this.openPreviewExternal()
    if (id === 'refresh-task') void this.refreshTask()
    if (id === 'view-agent-diff') this.showLatestAgentDiff()
    if (id === 'attach-file') this.insertComposer(this.currentFileContext())
    if (id === 'context-current-file') this.addContextChip('file')
    if (id === 'context-selection') this.addContextChip('selection')
    if (id === 'context-terminal') this.addContextChip('terminal')
    if (id === 'context-git') this.addContextChip('git')
    if (id === 'pick-image-attachments') void this.pickAttachments('image')
    if (id === 'pick-file-attachments') void this.pickAttachments('file')
    if (id === 'pick-audio-attachment') void this.pickAttachments('voice')
    if (id === 'fix-error') this.insertComposer('请根据终端错误和当前文件生成修复方案，并直接修改必要文件。')
    if (id === 'review-code') this.insertComposer('请审查当前项目的未提交改动，输出问题、风险和建议修复。')
    if (id === 'start-voice') void this.startVoiceInput()
    if (id === 'stop-voice') void this.stopVoiceInput()
    if (id === 'create-task') void this.createTask()
    if (id === 'close-settings' || id === 'settings-overlay') this.closeSettings()
    if (id === 'save-settings') void this.saveSettings()
  }

  private handleInput(event: Event) {
    const target = event.target as HTMLInputElement
    if (target.id === 'skill-query') {
      this.state.skills.query = target.value
      this.renderSkills()
    }
    if (target.id === 'command-search') {
      this.commandFilter = target.value
      this.renderCommandList()
    }
    if (target.id === 'task-prompt') {
      this.composerDraft = (target as HTMLTextAreaElement).value
      this.scheduleSessionPersist()
    }
    if (target.id === 'composer-temperature') {
      this.aiTemperature = Number(target.value || 0.2)
      localStorage.setItem('autocode.ide.ai.temperature', String(this.aiTemperature))
      this.scheduleSessionPersist()
    }
    if (target.id === 'composer-system-prompt') {
      this.aiSystemPrompt = (target as HTMLTextAreaElement).value
      localStorage.setItem('autocode.ide.ai.systemPrompt', this.aiSystemPrompt)
      this.scheduleSessionPersist()
    }
    if (target.id === 'composer-context-budget') {
      this.aiContextBudget = Number(target.value || 18000)
      localStorage.setItem('autocode.ide.ai.contextBudget', String(this.aiContextBudget))
      this.scheduleSessionPersist()
    }
  }

  private handleChange(event: Event) {
    const input = event.target as HTMLInputElement
    if (input.id === 'theme-select') {
      this.state.theme = input.value as AppState['theme']
      saveTheme(this.state.theme)
      this.applyTheme()
      return
    }
    if (input.id === 'workbench-provider') {
      this.state.settings.provider_type = input.value
      this.state.providerCatalog.models = []
      this.state.providerCatalog.error = ''
      this.renderProviderStatus()
      this.renderComposer()
      void this.persistSettingsFromState()
      void this.refreshProviderModels()
      return
    }
    if (input.id === 'workbench-model') {
      this.state.settings.model = input.value
      this.renderProviderStatus()
      this.renderComposer()
      void this.persistSettingsFromState()
      return
    }
    if (input.id === 'terminal-session-select') {
      void this.switchTerminalSession(input.value)
      return
    }
    if (input.id === 'terminal-shell-select') {
      const shell = this.selectedTerminalShell()
      this.state.settings.default_shell = shell === 'powershell.exe' ? 'powershell' : shell === 'pwsh.exe' ? 'pwsh' : 'cmd'
      this.terminalCommandShell = shell
      if (this.state.terminalSessionId) this.state.terminal.shell = shell
      const record = this.state.terminalSessions.find(item => item.id === this.state.terminalSessionId)
      if (record) {
        record.shell = shell
        record.label = `${shell} ${Math.max(1, this.state.terminalSessions.findIndex(item => item.id === record.id) + 1)}`
      }
      void this.persistSettingsFromState()
      this.renderTerminalSessions()
      if (this.terminalCommandMode) this.renderCommandLine()
      return
    }
    if (input.id === 'composer-reasoning-mode') {
      this.state.settings.reasoning_mode = input.value
      void this.persistSettingsFromState()
      return
    }
    if (input.id === 'composer-model') {
      this.state.settings.model = input.value
      this.renderProviderStatus()
      void this.persistSettingsFromState()
      return
    }
    if (input.id !== 'composer-file-input') return
    const files = Array.from(input.files || [])
    const kind = this.state.composerMode === 'image' ? 'image' : 'file'
    this.state.attachments.push(...files.map(file => ({
      kind,
      name: file.name,
      size: file.size,
      mime: file.type,
      preview: kind === 'image' ? URL.createObjectURL(file) : '',
    } as Attachment)))
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private removeAttachment(index: number) {
    const item = this.state.attachments[index]
    if (item?.preview) URL.revokeObjectURL(item.preview)
    this.state.attachments.splice(index, 1)
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private async pickAttachments(kind: 'image' | 'file' | 'voice') {
    try {
      const picked = await invoke<any[]>('ide_pick_attachments', { kind })
      this.state.attachments.push(...picked.map(item => ({
        kind: kind === 'image' ? 'image' : 'file',
        name: item.name,
        path: item.path,
        size: item.size,
        mime: item.mime,
        preview: item.previewable && String(item.mime || '').startsWith('image/') ? convertFileSrc(item.path) : '',
      } as Attachment)))
      this.renderComposer()
      this.scheduleSessionPersist()
      this.toast(`已添加 ${picked.length} 个附件`, 'ok')
    } catch (error) {
      if (!String(error).toLowerCase().includes('cancel')) this.toast(String(error), 'error')
    }
  }

  private async handlePaste(event: ClipboardEvent) {
    const target = event.target as HTMLElement
    if (target.id !== 'task-prompt') return
    const items = Array.from(event.clipboardData?.items || [])
    const files = items
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!files.length) return
    event.preventDefault()
    for (const file of files) {
      const isImage = file.type.startsWith('image/')
      const attachment: Attachment = {
        kind: isImage ? 'image' : 'file',
        name: file.name || (isImage ? `pasted-image-${Date.now()}.png` : `pasted-file-${Date.now()}`),
        size: file.size,
        mime: file.type || 'application/octet-stream',
      }
      if (isImage) {
        attachment.preview = await this.readFileAsDataUrl(file)
      } else if (file.type.startsWith('text/') || /\.(txt|md|json|js|ts|tsx|jsx|css|html|py|rs)$/i.test(file.name)) {
        attachment.text = (await file.text()).slice(0, 20000)
      }
      this.state.attachments.push(attachment)
    }
    this.state.composerMode = files.some(file => file.type.startsWith('image/')) ? 'image' : 'file'
    this.renderComposer()
    this.scheduleSessionPersist()
    this.toast(`已从剪贴板添加 ${files.length} 个附件`, 'ok')
  }

  private readFileAsDataUrl(file: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error || new Error('读取剪贴板图片失败'))
      reader.readAsDataURL(file)
    })
  }

  private handleContextMenu(event: MouseEvent) {
    const tabButton = (event.target as HTMLElement).closest<HTMLElement>('[data-tab-path]')
    if (tabButton) {
      event.preventDefault()
      this.activateTab(tabButton.dataset.tabPath || '')
      this.showTabContextMenu(event.clientX, event.clientY, tabButton.dataset.tabPath || '')
      return
    }
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-open-path]')
    if (!button) return
    event.preventDefault()
    this.state.workspace.selectedPath = button.dataset.openPath || ''
    this.renderTree()
    this.scheduleSessionPersist()
    this.showContextMenu(event.clientX, event.clientY)
  }

  private handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement
      if (target.id === 'task-prompt' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        this.insertTextAtComposerCursor('\n')
        return
      }
      if (target.id === 'task-prompt') {
        event.preventDefault()
        void this.createTask()
        return
      }
      if (target.id === 'command-input') {
        event.preventDefault()
        void this.runCommandFromInput()
        return
      }
      if (target.id === 'command-search') {
        event.preventDefault()
        this.$<HTMLButtonElement>('#command-list button')?.click()
        return
      }
    }

    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      this.closeCommandCenter()
      this.closeSettings()
      this.hideContextMenu()
      return
    }
    const targetElement = event.target as HTMLElement | null
    const terminalFocused = Boolean(targetElement?.closest?.('#terminal-host'))
    if (terminalFocused && this.state.terminalSessionId && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      const key = event.key.toLowerCase()
      if (key === 'c' || key === 'v') {
        event.preventDefault()
        if (key === 'c') {
          const selection = this.terminal.getSelection()
          if (selection) void this.terminal.copySelection()
          else void this.writeTerminalInput('\u0003')
        } else {
          void this.terminal.pasteFromClipboard()
        }
        return
      }
    }
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 's') {
      event.preventDefault()
      void this.saveActiveFile()
    } else if (key === 'p' && event.shiftKey) {
      event.preventDefault()
      this.openCommandCenter()
    } else if (key === 'p') {
      event.preventDefault()
      this.openCommandCenter('files')
    } else if (key === '`') {
      event.preventDefault()
      this.switchDock('terminal')
      this.state.layout.bottomCollapsed = false
      this.applyLayout()
    } else if (key === 'b') {
      event.preventDefault()
      this.state.layout.explorerCollapsed = !this.state.layout.explorerCollapsed
      this.applyLayout()
    } else if (key === 'f' && event.shiftKey) {
      event.preventDefault()
      this.switchActivity('search')
      this.$<HTMLInputElement>('#search-input')?.focus()
    }
  }

  private bindResizeHandles() {
    this.root.querySelectorAll<HTMLElement>('[data-resize]').forEach(handle => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault()
        const kind = handle.dataset.resize
        const startX = event.clientX
        const startY = event.clientY
        const start = { ...this.state.layout }
        const onMove = (move: PointerEvent) => {
          if (kind === 'explorer') this.state.layout.explorerWidth = Math.min(520, Math.max(220, start.explorerWidth + move.clientX - startX))
          if (kind === 'assistant') this.state.layout.assistantWidth = Math.min(560, Math.max(320, start.assistantWidth + startX - move.clientX))
          if (kind === 'bottom') this.state.layout.bottomHeight = Math.min(460, Math.max(150, start.bottomHeight + startY - move.clientY))
          this.applyLayout(false)
        }
        const onUp = () => {
          document.removeEventListener('pointermove', onMove)
          document.removeEventListener('pointerup', onUp)
          saveLayout(this.state.layout)
        }
        document.addEventListener('pointermove', onMove)
        document.addEventListener('pointerup', onUp)
      })
    })
  }

  private applyLayout(persist = true) {
    const shell = this.$<HTMLElement>('#ide-shell')
    if (!shell) return
    shell.style.setProperty('--explorer-width', `${this.state.layout.explorerCollapsed ? 0 : this.state.layout.explorerWidth}px`)
    shell.style.setProperty('--assistant-width', `${this.state.layout.assistantCollapsed ? 0 : this.state.layout.assistantWidth}px`)
    shell.style.setProperty('--bottom-height', `${this.state.layout.bottomCollapsed ? 42 : this.state.layout.bottomHeight}px`)
    shell.classList.toggle('explorer-collapsed', this.state.layout.explorerCollapsed)
    shell.classList.toggle('assistant-collapsed', this.state.layout.assistantCollapsed)
    shell.classList.toggle('bottom-collapsed', this.state.layout.bottomCollapsed)
    this.terminal.fit()
    if (persist) saveLayout(this.state.layout)
  }

  private applyTheme() {
    this.root.dataset.theme = this.state.theme
  }

  private async pickWorkspace() {
    try {
      const project = await invoke<RecentProject>('ide_pick_workspace')
      await this.openWorkspace(project)
    } catch (error) {
      if (!String(error).toLowerCase().includes('cancel')) this.toast(String(error), 'error')
    }
  }

  private async openWorkspace(project: RecentProject, notify = true) {
    if (this.state.workspace.tabs.some(dirty) && !window.confirm('当前有未保存文件，继续切换项目？')) return
    const bootSnapshot = this.pendingSessionSnapshot
    const opened = await invoke<RecentProject>('ide_open_workspace', {
      rootPath: project.path,
      taskId: project.task_id || null,
      previewUrl: project.preview_url || null,
    })
    if (this.state.terminalSessionId) await this.killTerminal()
    this.state.workspace.currentProject = opened
    this.state.settings.last_workspace_path = opened.path
    this.state.previewUrl = opened.preview_url || this.state.settings.preview_url || ''
    this.state.workspace.tabs = []
    this.state.workspace.activePath = ''
    this.state.workspace.selectedPath = ''
    this.state.workspace.expandedDirs = []
    this.state.workspace.searchResults = []
    this.state.agentRuntime = {
      sessionId: '',
      profileId: 'build',
      events: [],
      timeline: [],
      pendingPermissions: [],
      patchPreviews: [],
      thinking: '',
    }
    this.state.chat = [
      {
        id: 'welcome',
        role: 'system',
        text: '已进入本地项目。可以直接提需求，Agent 会自动读取项目文件、展示工具轨迹，并在改文件前请求确认。',
        at: new Date().toISOString(),
      },
    ]
    this.state.contextChips = []
    this.state.attachments = []
    this.composerDraft = ''
    this.state.terminalSessions = []
    this.upsertRecent(opened)
    this.editor.setTab(null)
    this.renderAll()
    await this.refreshWorkspace(true)
    const projectSnapshot = await this.api.loadSession(opened.path).catch(() => null)
    const usableBootSnapshot = bootSnapshot?.currentProject?.path === opened.path ? bootSnapshot : null
    this.pendingSessionSnapshot = this.newerSessionSnapshot(projectSnapshot, usableBootSnapshot)
    this.restoreSessionForProject(opened.path)
    await this.ensureAgentSession()
    await this.startTerminal(this.selectedTerminalShell())
    if (this.state.settings.connection_mode === 'aiProvider' && this.state.settings.api_base_url && !this.state.providerCatalog.models.length) void this.refreshProviderModels()
    if (opened.task_id) void this.refreshTask()
    this.persistSessionSnapshot()
    if (notify) this.toast(`已打开项目：${opened.name}`, 'ok')
  }

  private async ensureAgentSession() {
    if (!this.currentRoot()) return ''
    if (this.state.agentRuntime.sessionId) return this.state.agentRuntime.sessionId
    try {
      const existing = await this.api.agentSessions(this.currentRoot()).catch(() => [])
      const latest = existing
        .filter((item: any) => String(item?.rootPath || '') === this.currentRoot())
        .sort((a: any, b: any) => Number(b?.updatedAt || b?.createdAt || 0) - Number(a?.updatedAt || a?.createdAt || 0))[0]
      if (latest?.id) {
        this.state.agentRuntime.sessionId = String(latest.id)
        this.state.agentRuntime.profileId = String(latest.profileId || 'build')
        this.restoreAgentRuntimeFromSnapshot(latest)
        this.updateAgentDiagnostics()
        return this.state.agentRuntime.sessionId
      }
      const session = await this.api.agentSessionStart(this.currentRoot())
      this.state.agentRuntime.sessionId = String(session?.id || '')
      this.state.agentRuntime.profileId = String(session?.profileId || 'build')
      this.updateAgentDiagnostics()
      return this.state.agentRuntime.sessionId
    } catch (error) {
      this.toast(`Agent 会话创建失败：${String(error)}`, 'error')
      return ''
    }
  }

  private restoreAgentRuntimeFromSnapshot(snapshot: any) {
    const toolCalls = Array.isArray(snapshot?.toolCalls) ? snapshot.toolCalls : []
    const permissions = Array.isArray(snapshot?.pendingTools) ? snapshot.pendingTools : []
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
    this.state.agentRuntime.timeline = toolCalls.map((call: any, index: number) => ({
      id: String(call.id || `tool-restored-${index}`),
      name: String(call.name || call.tool || 'tool'),
      status: String(call.status || 'ok') === 'error' ? 'error' : 'ok',
      input: call.input || {},
      output: call.output,
      error: String(call.error || ''),
      startedAt: String(call.startedAt || call.started_at || snapshot.updatedAt || new Date().toISOString()),
      finishedAt: String(call.finishedAt || call.finished_at || snapshot.updatedAt || new Date().toISOString()),
    })).slice(-80)
    this.state.agentRuntime.pendingPermissions = permissions.map((item: any) => ({
      id: String(item.id || `permission-restored-${Date.now()}`),
      kind: (String(item.tool || '').includes('bash') ? 'command' : 'write') as 'command' | 'write',
      target: String(item.input?.command || item.input?.path || item.tool || ''),
      reason: '恢复的待确认 Agent 工具调用。',
      risk: 'medium' as const,
    })).slice(-20)
    const existingKeys = new Set(this.state.chat.map(item => `${item.role}\n${item.text}`))
    const restoredMessages = messages
      .map((item: any, index: number) => ({
        id: `agent-${String(snapshot?.id || 'session')}-${index}`,
        role: String(item?.role || '') === 'assistant' ? 'assistant' as const : String(item?.role || '') === 'user' ? 'user' as const : 'system' as const,
        text: String(item?.content || item?.text || '').trim(),
        at: String(item?.at || item?.createdAt || snapshot?.updatedAt || new Date().toISOString()),
      }))
      .filter((item: any) => item.text && item.role !== 'system' && !this.looksLikeToolProtocol(item.text))
      .filter((item: any) => {
        const key = `${item.role}\n${item.text}`
        if (existingKeys.has(key)) return false
        existingKeys.add(key)
        return true
      })
    if (restoredMessages.length) {
      const welcome = this.state.chat.filter(item => item.id === 'welcome' || item.role === 'system').slice(0, 1)
      const nonSystem = this.state.chat.filter(item => item.id !== 'welcome' && item.role !== 'system')
      this.state.chat = [...welcome, ...nonSystem, ...restoredMessages].slice(-90)
    }
  }

  private async refreshLocalServerStatus() {
    try {
      const status = await this.api.localServerStatus()
      this.state.localServer = {
        ok: Boolean(status?.ok),
        host: String(status?.host || '127.0.0.1'),
        port: typeof status?.port === 'number' ? status.port : null,
        baseUrl: String(status?.baseUrl || ''),
        latestEventId: Number(status?.latestEventId || 0),
      }
      if (!this.agentEventSource && this.state.localServer.latestEventId) {
        this.lastAgentEventId = Math.max(this.lastAgentEventId, this.state.localServer.latestEventId)
      }
      if (this.state.localServer.ok) this.startLocalAgentEventStream()
      else window.setTimeout(() => void this.refreshLocalServerStatus(), 1000)
      this.renderAssistant()
      this.renderProblems()
    } catch {
      this.state.localServer = { ok: false, host: '127.0.0.1', port: null, baseUrl: '', latestEventId: 0 }
      this.stopLocalAgentEventStream()
      window.setTimeout(() => void this.refreshLocalServerStatus(), 1500)
      this.renderProblems()
    }
  }

  private startLocalAgentEventStream() {
    const baseUrl = this.state.localServer.baseUrl
    if (!this.state.localServer.ok || !baseUrl) return
    const currentUrl = this.agentEventSource?.url || ''
    if (this.agentEventSource && currentUrl.startsWith(`${baseUrl}/events`)) return
    this.stopLocalAgentEventStream()
    const url = `${baseUrl}/events?since=${Math.max(0, this.lastAgentEventId)}`
    try {
      const source = new EventSource(url)
      this.agentEventSource = source
      const eventTypes: AgentEvent['type'][] = [
        'message_part',
        'message_delta',
        'tool_call_start',
        'tool_call_delta',
        'tool_call_result',
        'tool_start',
        'tool_result',
        'reasoning_delta',
        'permission_request',
        'patch_preview',
        'usage',
        'error',
        'session_done',
        'done',
      ]
      eventTypes.forEach(type => {
        source.addEventListener(type, event => {
          const data = (event as MessageEvent).data
          if (!data) return
          try {
            this.handleAgentEvent(JSON.parse(data) as AgentEvent)
          } catch {
            this.handleAgentEvent(data)
          }
        })
      })
      source.onerror = () => {
        this.stopLocalAgentEventStream(false)
        if (this.agentEventReconnectTimer) window.clearTimeout(this.agentEventReconnectTimer)
        this.agentEventReconnectTimer = window.setTimeout(() => this.startLocalAgentEventStream(), 900)
      }
    } catch {
      this.stopLocalAgentEventStream()
    }
  }

  private stopLocalAgentEventStream(clearReconnect = true) {
    if (this.agentEventSource) {
      this.agentEventSource.close()
      this.agentEventSource = null
    }
    if (clearReconnect && this.agentEventReconnectTimer) {
      window.clearTimeout(this.agentEventReconnectTimer)
      this.agentEventReconnectTimer = 0
    }
  }

  private restoreSessionForProject(rootPath: string) {
    const snapshot = this.pendingSessionSnapshot
    if (!snapshot?.currentProject || snapshot.currentProject.path !== rootPath) return
    if (snapshot.settings) {
      this.state.settings = { ...this.state.settings, ...snapshot.settings }
    }
    if (snapshot.theme) {
      this.state.theme = snapshot.theme
      this.applyTheme()
    }
    if (typeof snapshot.aiTemperature === 'number') this.aiTemperature = snapshot.aiTemperature
    if (typeof snapshot.aiContextBudget === 'number') this.aiContextBudget = snapshot.aiContextBudget
    if (snapshot.aiSystemPrompt) this.aiSystemPrompt = snapshot.aiSystemPrompt
    this.state.activeActivity = snapshot.activeActivity || this.state.activeActivity
    this.state.activeDock = snapshot.activeDock || this.state.activeDock
    this.state.composerMode = snapshot.composerMode || 'text'
    this.composerDraft = snapshot.composerDraft || ''
    this.state.previewUrl = snapshot.previewUrl || this.state.previewUrl
    this.state.workspace.activePath = snapshot.workspace?.activePath || ''
    this.state.workspace.selectedPath = snapshot.workspace?.selectedPath || ''
    this.state.workspace.expandedDirs = snapshot.workspace?.expandedDirs || []
    this.state.workspace.tabs = Array.isArray(snapshot.workspace?.tabs) ? snapshot.workspace.tabs : []
    this.state.chat = Array.isArray(snapshot.chat) && snapshot.chat.length ? snapshot.chat : this.state.chat
    this.state.contextChips = Array.isArray(snapshot.contextChips) ? snapshot.contextChips : []
    this.state.attachments = Array.isArray(snapshot.attachments) ? snapshot.attachments : []
    this.state.agentRuntime = {
      ...this.state.agentRuntime,
      ...snapshot.agentRuntime,
      sessionId: '',
      thinking: snapshot.agentRuntime?.thinking || '',
    }
    this.state.terminal = { ...this.state.terminal, ...snapshot.terminal, running: false, health: 'idle' }
    this.terminalCommandShell = this.state.terminal.shell || this.selectedTerminalShell()
    this.state.terminalSessions = Array.isArray(snapshot.terminalSessions)
      ? snapshot.terminalSessions.map(item => ({ ...item, health: 'idle' as const }))
      : []
    this.terminalOutputBuffer = snapshot.terminal?.lastOutput || ''
    this.editor.setTab(this.activeTab())
    this.pendingSessionSnapshot = null
    this.renderAll()
  }

  private scheduleSessionPersist() {
    if (this.sessionPersistTimer) window.clearTimeout(this.sessionPersistTimer)
    this.sessionPersistTimer = window.setTimeout(() => this.persistSessionSnapshot(), 150)
  }

  private persistSessionSnapshot() {
    const root = this.currentRoot()
    const snapshot: IdeSessionSnapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      settings: this.state.settings,
      theme: this.state.theme,
      aiTemperature: this.aiTemperature,
      aiContextBudget: this.aiContextBudget,
      aiSystemPrompt: this.aiSystemPrompt,
      currentProject: this.state.workspace.currentProject,
      activeActivity: this.state.activeActivity,
      activeDock: this.state.activeDock,
      composerMode: this.state.composerMode,
      composerDraft: this.composerDraft,
      previewUrl: this.state.previewUrl,
      workspace: {
        activePath: this.state.workspace.activePath,
        selectedPath: this.state.workspace.selectedPath,
        expandedDirs: this.state.workspace.expandedDirs,
        tabs: this.state.workspace.tabs,
      },
      chat: this.state.chat.slice(-80),
      contextChips: this.state.contextChips,
      attachments: this.state.attachments.map(item => ({
        ...item,
        preview: item.preview && item.preview.length > 900000 ? '' : item.preview,
        text: item.text && item.text.length > 50000 ? `${item.text.slice(0, 50000)}\n...[truncated]` : item.text,
      })),
      agentRuntime: {
        ...this.state.agentRuntime,
        events: this.state.agentRuntime.events.slice(-120),
        timeline: this.state.agentRuntime.timeline.slice(-80),
        pendingPermissions: this.state.agentRuntime.pendingPermissions.slice(-20),
        patchPreviews: this.state.agentRuntime.patchPreviews.slice(-8),
      },
      terminal: { ...this.state.terminal, lastOutput: this.terminalOutputBuffer.slice(-20000) },
      terminalSessionId: this.state.terminalSessionId,
      terminalSessions: this.state.terminalSessions.map(item => ({
        ...item,
        lastOutput: item.lastOutput.slice(-20000),
        health: item.id === this.state.terminalSessionId ? this.state.terminal.health : item.health,
      })),
    }
    saveSessionSnapshot(snapshot)
    if (root) void this.api.saveSession(root, snapshot).catch(() => {})
    void this.api.saveSession('', snapshot).catch(() => {})
  }

  private async refreshWorkspace(preserveExpanded = true) {
    const root = this.currentRoot()
    if (!root) return
    const expanded = preserveExpanded ? [...this.state.workspace.expandedDirs] : []
    try {
      const tree = await invoke<WorkspaceEntry[]>('ide_list_workspace', { rootPath: root, path: '', maxDepth: 1 })
      this.state.workspace.tree = tree.map(item => ({ ...item, loaded: item.kind !== 'dir' }))
      this.state.workspace.expandedDirs = []
      for (const path of expanded) await this.expandDirectory(path, false)
      await this.refreshGit()
      this.updateEditorCompletions()
      this.renderAll()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async handleTreeOpen(path: string) {
    const entry = findEntry(this.state.workspace.tree, path)
    this.state.workspace.selectedPath = path
    if (entry?.kind === 'dir') {
      if (this.state.workspace.expandedDirs.includes(path)) this.collapseDirectory(path)
      else await this.expandDirectory(path)
      this.renderTree()
      return
    }
    await this.openFile(path)
  }

  private async expandDirectory(path: string, render = true) {
    const entry = findEntry(this.state.workspace.tree, path)
    if (!entry || entry.kind !== 'dir') return
    if (!this.state.workspace.expandedDirs.includes(path)) this.state.workspace.expandedDirs.push(path)
    if (!entry.loaded) {
      const children = await invoke<WorkspaceEntry[]>('ide_list_workspace', { rootPath: this.currentRoot(), path, maxDepth: 1 })
      this.replaceEntry(path, { ...entry, children: children.map(child => ({ ...child, loaded: child.kind !== 'dir' })), loaded: true })
    }
    this.updateEditorCompletions()
    if (render) this.renderTree()
    this.scheduleSessionPersist()
  }

  private collapseDirectory(path: string) {
    this.state.workspace.expandedDirs = this.state.workspace.expandedDirs.filter(item => item !== path && !item.startsWith(`${path}/`))
    this.scheduleSessionPersist()
  }

  private replaceEntry(path: string, next: WorkspaceEntry) {
    const visit = (items: WorkspaceEntry[]): WorkspaceEntry[] => items.map(item => {
      if (item.path === path) return next
      return { ...item, children: visit(item.children || []) }
    })
    this.state.workspace.tree = visit(this.state.workspace.tree)
  }

  private async openFile(path: string) {
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    const existing = this.state.workspace.tabs.find(tab => tab.path === path)
    if (existing) return this.activateTab(path)
    try {
      const file = await invoke<WorkspaceFileSnapshot>('ide_read_workspace_file', { rootPath: this.currentRoot(), path })
      const tab: EditorTab = {
        path: file.path,
        name: basename(file.path),
        draft: file.content,
        original: file.content,
        encoding: file.encoding,
        lineEnding: file.line_ending,
        modifiedAt: file.modified_at,
        size: file.size,
        language: guessLanguage(file.path),
      }
      this.state.workspace.tabs.push(tab)
      this.activateTab(tab.path)
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private activateTab(path: string) {
    this.state.workspace.activePath = path
    this.state.workspace.selectedPath = path
    this.editor.setTab(this.activeTab())
    this.renderEditor()
    this.renderTabs()
    this.editor.focus()
    this.scheduleSessionPersist()
  }

  private closeTab(path: string) {
    const tab = this.state.workspace.tabs.find(item => item.path === path)
    if (!tab) return
    if (dirty(tab) && !window.confirm(`文件 ${path} 尚未保存，确认关闭？`)) return
    this.state.workspace.tabs = this.state.workspace.tabs.filter(item => item.path !== path)
    if (this.state.workspace.activePath === path) this.state.workspace.activePath = this.state.workspace.tabs[0]?.path || ''
    this.editor.setTab(this.activeTab())
    this.hideContextMenu()
    this.renderTabs()
    this.renderEditor()
    this.scheduleSessionPersist()
  }

  private closeOtherTabs(path: string) {
    const keep = this.state.workspace.tabs.find(item => item.path === path)
    if (!keep) return
    const dirtyOthers = this.state.workspace.tabs.filter(item => item.path !== path && dirty(item))
    if (dirtyOthers.length && !window.confirm(`有 ${dirtyOthers.length} 个未保存文件，确认关闭其他标签？`)) return
    this.state.workspace.tabs = [keep]
    this.state.workspace.activePath = keep.path
    this.editor.setTab(keep)
    this.hideContextMenu()
    this.renderTabs()
    this.renderEditor()
    this.scheduleSessionPersist()
  }

  private updateDraft(value: string) {
    const tab = this.activeTab()
    if (!tab) return
    tab.draft = value
    this.renderTabs()
    this.renderEditorStatus()
    this.scheduleSessionPersist()
  }

  private async saveActiveFile() {
    const tab = this.activeTab()
    if (!tab || !dirty(tab)) return
    try {
      const saved = await invoke<WorkspaceFileSnapshot>('ide_save_workspace_file', {
        rootPath: this.currentRoot(),
        path: tab.path,
        content: tab.draft,
        encoding: tab.encoding,
        lineEnding: tab.lineEnding,
      })
      Object.assign(tab, {
        draft: saved.content,
        original: saved.content,
        encoding: saved.encoding,
        lineEnding: saved.line_ending,
        modifiedAt: saved.modified_at,
        size: saved.size,
      })
      this.toast(`已保存 ${tab.name}`, 'ok')
      this.renderEditor()
      this.scheduleSessionPersist()
      await this.refreshGit()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async reloadActiveFile() {
    const tab = this.activeTab()
    if (!tab) return
    if (dirty(tab) && !window.confirm('当前文件未保存，确认重新载入？')) return
    const file = await invoke<WorkspaceFileSnapshot>('ide_read_workspace_file', { rootPath: this.currentRoot(), path: tab.path })
    Object.assign(tab, {
      draft: file.content,
      original: file.content,
      encoding: file.encoding,
      lineEnding: file.line_ending,
      modifiedAt: file.modified_at,
      size: file.size,
    })
    this.editor.setTab(tab)
    this.renderEditor()
    this.toast('文件已重新载入', 'ok')
  }

  private async checkExternalChanges() {
    const tab = this.activeTab()
    if (!tab || !this.currentRoot()) return
    try {
      const stat = await invoke<WorkspaceFileStat>('ide_stat_workspace_file', { rootPath: this.currentRoot(), path: tab.path })
      if (stat.exists && stat.modified_at !== tab.modifiedAt) {
        if (dirty(tab)) this.toast(`检测到外部修改：${tab.path}，请保存或重新载入后合并`, 'error')
        else await this.reloadActiveFile()
      }
    } catch {
      // Explicit operations will surface file deletion or permission errors.
    }
  }

  private async createEntry(kind: 'file' | 'dir') {
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    const parentPath = this.createParentPath()
    const name = window.prompt(kind === 'dir' ? '新建文件夹名称' : '新建文件名称')
    if (!name) return
    try {
      const entry = await invoke<WorkspaceEntry>('ide_create_workspace_entry', { rootPath: this.currentRoot(), parentPath, name, kind })
      if (parentPath) {
        const parent = findEntry(this.state.workspace.tree, parentPath)
        if (parent) parent.loaded = false
        await this.expandDirectory(parentPath)
      } else {
        await this.refreshWorkspace(true)
      }
      if (entry.kind === 'file') await this.openFile(entry.path)
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async renameEntry() {
    const path = this.selectedWorkspacePath()
    if (!path) return this.toast('请先选择文件或目录', 'idle')
    const next = window.prompt('输入新的相对路径', path)
    if (!next || next === path) return
    try {
      await invoke<WorkspaceEntry>('ide_rename_workspace_entry', { rootPath: this.currentRoot(), path, newPath: next })
      await this.refreshWorkspace(true)
      this.state.workspace.tabs = this.state.workspace.tabs.map(tab => tab.path === path ? { ...tab, path: next, name: basename(next) } : tab)
      if (this.state.workspace.activePath === path) this.state.workspace.activePath = next
      this.state.workspace.selectedPath = next
      this.renderAll()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async deleteEntry() {
    const path = this.selectedWorkspacePath()
    if (!path) return this.toast('请先选择文件或目录', 'idle')
    if (!window.confirm(`确认删除 ${path}？此操作只允许在当前工作区内执行。`)) return
    try {
      await invoke<void>('ide_delete_workspace_entry', { rootPath: this.currentRoot(), path, recursive: true })
      this.state.workspace.tabs = this.state.workspace.tabs.filter(tab => tab.path !== path && !tab.path.startsWith(`${path}/`))
      if (this.state.workspace.activePath === path || this.state.workspace.activePath.startsWith(`${path}/`)) this.state.workspace.activePath = this.state.workspace.tabs[0]?.path || ''
      await this.refreshWorkspace(true)
      this.editor.setTab(this.activeTab())
      this.renderEditor()
      this.toast(`已删除 ${path}`, 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async searchWorkspace() {
    const query = this.$<HTMLInputElement>('#search-input')?.value.trim() || ''
    const includeContent = Boolean(this.$<HTMLInputElement>('#search-content')?.checked)
    if (!query) return
    try {
      this.state.workspace.searchResults = await invoke<WorkspaceSearchResult[]>('ide_search_workspace', {
        rootPath: this.currentRoot(),
        query,
        includeContent,
        limit: 100,
      })
      this.renderSearch()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async startTerminal(shell: string | null = null, forceNew = false) {
    if (!this.currentRoot()) return
    if (this.state.terminalSessionId && !forceNew) {
      this.switchDock('terminal')
      this.terminal.focus()
      return
    }
    if (this.isWindowsRuntime()) {
      await this.startCommandTerminal(shell || this.selectedTerminalShell(), forceNew)
      return
    }
    try {
      this.state.terminal.health = 'starting'
      this.terminalLastOutputAt = 0
      const requestedShell = shell || this.defaultTerminalShellArg() || null
      const info = await invoke<TerminalSessionInfo>('ide_pty_start', { rootPath: this.currentRoot(), shell: requestedShell })
      this.state.terminalSessionId = info.session_id
      this.state.terminal.shell = info.shell
      this.state.terminal.cwd = info.cwd || this.currentRoot()
      this.state.terminal.running = true
      this.state.terminal.health = info.interactive === false ? 'unresponsive' : 'ready'
      this.terminalLocalEcho = Boolean(info.local_echo)
      this.terminalOutputBuffer = ''
      this.state.terminalSessions.push({
        id: info.session_id,
        shell: info.shell,
        cwd: this.state.terminal.cwd,
        label: `${info.shell} ${this.state.terminalSessions.length + 1}`,
        lastOutput: '',
        createdAt: new Date().toISOString(),
        health: this.state.terminal.health,
        localEcho: this.terminalLocalEcho,
      })
      this.state.layout.bottomCollapsed = false
      this.switchDock('terminal')
      this.terminal.writeln(`AutoCode IDE terminal: ${info.shell}`)
      this.terminal.writeln(`cwd: ${this.state.terminal.cwd}`)
      const probeText = this.cleanTerminalProbeOutput(info.probe_output || '')
      if (probeText) {
        this.terminal.write(probeText)
        this.terminalOutputBuffer = `${this.terminalOutputBuffer}${probeText}`.slice(-12000)
        this.state.terminal.lastOutput = this.terminalOutputBuffer
      }
      if (info.fallback_from) this.toast(`PowerShell 不可交互，已自动切换到 ${info.shell}`, 'idle')
      if (info.interactive === false) this.toast(info.message || '终端未响应探测命令', 'error')
      this.terminal.fit()
      this.terminal.focus()
      this.renderTerminalSessions()
      this.scheduleSessionPersist()
      await this.probeTerminal(info.session_id, shell)
    } catch (error) {
      this.state.terminal.health = 'error'
      this.toast(String(error), 'error')
    }
  }

  private isWindowsRuntime() {
    return navigator.userAgent.toLowerCase().includes('windows')
  }

  private async startCommandTerminal(shell: string | null = null, forceNew = false) {
    if (!this.currentRoot()) return
    if (this.state.terminalSessionId && !forceNew) {
      this.switchDock('terminal')
      this.terminal.focus()
      return
    }
    const resolvedShell = shell || this.selectedTerminalShell()
    this.terminalCommandMode = true
    this.terminalCommandCwd = this.formatTerminalPath(this.currentRoot())
    this.terminalCommandShell = resolvedShell
    this.terminalCommandLine = ''
    this.terminalCommandCursor = 0
    this.terminalCommandHistory = []
    this.terminalCommandHistoryIndex = -1
    this.state.terminalSessionId = `command-${Date.now()}`
    this.state.terminal.shell = resolvedShell
    this.state.terminal.cwd = this.terminalCommandCwd
    this.state.terminal.running = true
    this.state.terminal.health = 'ready'
    this.terminalLocalEcho = false
    this.terminalOutputBuffer = ''
    const sessionNumber = this.state.terminalSessions.length + 1
    this.state.terminalSessions = [
      ...this.state.terminalSessions,
      {
      id: this.state.terminalSessionId,
      shell: resolvedShell,
      cwd: this.terminalCommandCwd,
      label: `${resolvedShell} ${sessionNumber}`,
      lastOutput: '',
      createdAt: new Date().toISOString(),
      health: 'ready',
      commandMode: true,
      },
    ]
    this.state.layout.bottomCollapsed = false
    this.switchDock('terminal')
    this.terminal.clear()
    this.terminal.writeln(`AutoCode IDE terminal: ${resolvedShell}`)
    this.terminal.writeln(`cwd: ${this.terminalCommandCwd}`)
    this.renderCommandLine()
    this.terminal.fit()
    this.terminal.focus()
    this.renderTerminalSessions()
    this.scheduleSessionPersist()
  }

  private formatTerminalPath(path: string) {
    return String(path || '')
      .replace(/^\\\\\?\\UNC\\/i, '\\\\')
      .replace(/^\\\\\?\\/i, '')
  }

  private cleanTerminalProbeOutput(value: string) {
    return String(value || '')
      .replace(/^.*__AUTOCODE_PTY_READY__.*(?:\r?\n)?/gm, '')
      .replace(/^\s*(Write-Output|echo)\s+.*__AUTOCODE_PTY_READY__.*(?:\r?\n)?/gim, '')
  }

  private async probeTerminal(sessionId: string, _shell: string | null) {
    window.setTimeout(async () => {
      if (this.state.terminalSessionId !== sessionId) return
      try {
        const probe = await invoke<any>('ide_pty_probe', { sessionId })
        this.state.terminal.shell = probe?.shell || this.state.terminal.shell
        this.state.terminal.cwd = probe?.cwd || this.state.terminal.cwd
        this.state.terminal.lastOutput = probe?.lastOutput || this.state.terminal.lastOutput
        this.state.terminal.health = 'ready'
      } catch (error) {
        this.state.terminal.health = 'unresponsive'
        this.toast(`终端探测失败：${String(error)}`, 'error')
      }
    }, 800)
  }
  private async restartTerminal() {
    await this.killTerminal()
    this.terminal.clear()
    await this.startTerminal(this.selectedTerminalShell())
  }

  private async switchTerminalSession(sessionId: string) {
    if (!sessionId || sessionId === this.state.terminalSessionId) return
    const record = this.state.terminalSessions.find(item => item.id === sessionId)
    if (!record) return
    this.state.terminalSessionId = record.id
    this.state.terminal.shell = record.shell
    this.state.terminal.cwd = record.cwd
    this.state.terminal.health = record.health
    this.state.terminal.running = record.health !== 'idle'
    this.terminalLocalEcho = Boolean(record.localEcho)
    this.terminalCommandMode = Boolean(record.commandMode)
    this.terminalCommandCwd = record.cwd || this.currentRoot()
    this.terminalCommandShell = record.shell || this.selectedTerminalShell()
    this.terminalCommandLine = ''
    this.terminalOutputBuffer = record.lastOutput || ''
    this.terminal.clear()
    if (this.terminalOutputBuffer) this.terminal.write(this.terminalOutputBuffer)
    this.terminal.fit()
    this.terminal.focus()
    this.renderTerminalSessions()
    this.scheduleSessionPersist()
  }

  private async killTerminal() {
    if (!this.state.terminalSessionId) return
    const sessionId = this.state.terminalSessionId
    this.state.terminalSessionId = ''
    this.state.terminal.running = false
    this.state.terminal.health = 'idle'
    this.terminalLocalEcho = false
    this.terminalCommandMode = false
    this.terminalCommandCwd = ''
    this.terminalCommandShell = this.selectedTerminalShell()
    this.terminalCommandLine = ''
    const record = this.state.terminalSessions.find(item => item.id === sessionId)
    if (record) record.health = 'idle'
    try {
      await invoke<void>('ide_pty_kill', { sessionId })
    } catch {
      // Session may already be gone.
    }
    this.state.terminalSessions = this.state.terminalSessions.filter(item => item.id !== sessionId)
    const next = this.state.terminalSessions.find(item => item.health !== 'idle') || this.state.terminalSessions[0]
    this.terminal.clear()
    this.terminalOutputBuffer = ''
    this.state.terminal.lastOutput = ''
    if (next) {
      await this.switchTerminalSession(next.id)
    } else {
      this.state.terminal.shell = ''
      this.state.terminal.cwd = ''
      this.state.layout.bottomCollapsed = true
      this.applyLayout()
    }
    this.renderTerminalSessions()
    this.scheduleSessionPersist()
  }

  private async writeTerminalInput(data: string) {
    if (!this.currentRoot()) return
    if (!this.state.terminalSessionId) await this.startTerminal()
    if (!this.state.terminalSessionId) return
    if (this.terminalCommandMode) {
      await this.writeCommandTerminalInput(data)
      return
    }
    try {
      const outbound = this.terminalLocalEcho ? this.normalizePipeTerminalInput(data) : data
      if (this.terminalLocalEcho) this.echoTerminalInput(outbound)
      await invoke<void>('ide_pty_write', { sessionId: this.state.terminalSessionId, data: outbound })
    } catch (error) {
      this.state.terminal.health = 'error'
      this.terminal.writeln(`Terminal input failed: ${String(error)}`)
      this.toast(`终端输入失败：${String(error)}`, 'error')
    }
  }

  private async writeCommandTerminalInput(data: string) {
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]
      const escape3 = data.slice(index, index + 3)
      const escape4 = data.slice(index, index + 4)
      if (escape3 === '\u001b[A') {
        this.showCommandHistory(-1)
        index += 2
        continue
      }
      if (escape3 === '\u001b[B') {
        this.showCommandHistory(1)
        index += 2
        continue
      }
      if (escape3 === '\u001b[C') {
        this.moveCommandCursor(1)
        index += 2
        continue
      }
      if (escape3 === '\u001b[D') {
        this.moveCommandCursor(-1)
        index += 2
        continue
      }
      if (escape3 === '\u001b[H' || escape4 === '\u001b[1~' || escape4 === '\u001b[7~') {
        this.setCommandCursor(0)
        index += escape3 === '\u001b[H' ? 2 : 3
        continue
      }
      if (escape3 === '\u001b[F' || escape4 === '\u001b[4~' || escape4 === '\u001b[8~') {
        this.setCommandCursor(this.terminalCommandLine.length)
        index += escape3 === '\u001b[F' ? 2 : 3
        continue
      }
      if (escape4 === '\u001b[3~') {
        this.deleteAtCursor()
        index += 3
        continue
      }
      if (char === '\r' || char === '\n') {
        const command = this.terminalCommandLine.trim()
        this.terminal.write('\r\n')
        this.terminalCommandLine = ''
        this.terminalCommandCursor = 0
        this.terminalCommandHistoryIndex = -1
        if (command) this.terminalCommandHistory = [...this.terminalCommandHistory.filter(item => item !== command), command].slice(-80)
        await this.executeCommandTerminalLine(command)
        this.renderCommandLine()
        continue
      }
      if (char === '\u0003') {
        this.terminal.write('^C\r\n')
        this.terminalCommandLine = ''
        this.terminalCommandCursor = 0
        this.renderCommandLine()
        continue
      }
      if (char === '\u007f' || char === '\b') {
        this.deleteBeforeCursor()
        continue
      }
      if (char === '\t') {
        this.insertCommandText('    ')
        continue
      }
      if (char >= ' ' && char !== '\u007f') {
        this.insertCommandText(char)
      }
    }
  }

  private showCommandHistory(direction: -1 | 1) {
    if (!this.terminalCommandHistory.length) return
    if (this.terminalCommandHistoryIndex < 0) {
      this.terminalCommandHistoryIndex = direction < 0 ? this.terminalCommandHistory.length - 1 : 0
    } else {
      this.terminalCommandHistoryIndex = Math.max(0, Math.min(this.terminalCommandHistory.length - 1, this.terminalCommandHistoryIndex + direction))
    }
    const next = this.terminalCommandHistory[this.terminalCommandHistoryIndex] || ''
    this.replaceCommandLine(next)
  }

  private replaceCommandLine(next: string) {
    this.terminalCommandLine = next
    this.terminalCommandCursor = next.length
    this.renderCommandLine()
  }

  private moveCommandCursor(delta: number) {
    this.terminalCommandCursor = Math.max(0, Math.min(this.terminalCommandLine.length, this.terminalCommandCursor + delta))
    this.renderCommandLine()
  }

  private setCommandCursor(position: number) {
    this.terminalCommandCursor = Math.max(0, Math.min(this.terminalCommandLine.length, position))
    this.renderCommandLine()
  }

  private deleteBeforeCursor() {
    if (!this.terminalCommandCursor) return
    this.terminalCommandLine = `${this.terminalCommandLine.slice(0, this.terminalCommandCursor - 1)}${this.terminalCommandLine.slice(this.terminalCommandCursor)}`
    this.terminalCommandCursor -= 1
    this.renderCommandLine()
  }

  private deleteAtCursor() {
    if (this.terminalCommandCursor >= this.terminalCommandLine.length) return
    this.terminalCommandLine = `${this.terminalCommandLine.slice(0, this.terminalCommandCursor)}${this.terminalCommandLine.slice(this.terminalCommandCursor + 1)}`
    this.renderCommandLine()
  }

  private insertCommandText(text: string) {
    if (!text) return
    this.terminalCommandLine = `${this.terminalCommandLine.slice(0, this.terminalCommandCursor)}${text}${this.terminalCommandLine.slice(this.terminalCommandCursor)}`
    this.terminalCommandCursor += text.length
    this.renderCommandLine()
  }

  private renderCommandLine() {
    if (!this.terminalCommandMode) return
    const prompt = this.formatTerminalPrompt(this.terminalCommandShell, this.terminalCommandCwd)
    const line = this.terminalCommandLine
    const afterCursor = line.length - this.terminalCommandCursor
    this.terminal.write(`\r${prompt}${line}\u001b[K`)
    if (afterCursor > 0) this.terminal.write(`\u001b[${afterCursor}D`)
  }

  private async executeCommandTerminalLine(command: string) {
    if (!command) return
    try {
      const result = await invoke<any>('ide_shell_execute', {
        rootPath: this.currentRoot(),
        cwd: this.terminalCommandCwd || this.currentRoot(),
        command,
        shell: this.terminalCommandShell || this.selectedTerminalShell(),
        timeoutSecs: 120,
      })
      this.terminalCommandCwd = this.formatTerminalPath(String(result?.cwd || this.terminalCommandCwd || this.currentRoot()))
      this.state.terminal.cwd = this.terminalCommandCwd
      const output = String(result?.output || '')
      if (output) {
        const normalized = output.replace(/\r?\n/g, '\r\n')
        this.terminal.write(normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`)
        this.terminalOutputBuffer = `${this.terminalOutputBuffer}${output}`.slice(-12000)
        this.state.terminal.lastOutput = this.terminalOutputBuffer
      }
      this.state.terminal.health = result?.ok === false ? 'error' : 'ready'
      const record = this.state.terminalSessions.find(item => item.id === this.state.terminalSessionId)
      if (record) {
        record.cwd = this.terminalCommandCwd
        record.health = this.state.terminal.health
        record.lastOutput = this.terminalOutputBuffer
      }
    } catch (error) {
      this.terminal.writeln(`Command failed: ${String(error)}`)
      this.state.terminal.health = 'error'
      this.toast(`终端执行失败：${String(error)}`, 'error')
    } finally {
      this.renderTerminalSessions()
      this.scheduleSessionPersist()
    }
  }

  private echoTerminalInput(data: string) {
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]
      if (char === '\r') {
        this.terminal.write('\r\n')
        if (data[index + 1] === '\n') index += 1
      }
      else if (char === '\n') this.terminal.write('\r\n')
      else if (char === '\u0003') this.terminal.write('^C\r\n')
      else if (char === '\u007f' || char === '\b') this.terminal.write('\b \b')
      else this.terminal.write(char)
    }
  }

  private normalizePipeTerminalInput(data: string) {
    let output = ''
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]
      if (char === '\r') {
        output += '\r'
        if (data[index + 1] !== '\n') output += '\n'
      } else if (char === '\u007f') {
        output += '\b'
      } else {
        output += char
      }
    }
    return output
  }

  private async resizeTerminal(cols: number, rows: number) {
    if (!this.state.terminalSessionId) return
    if (this.terminalCommandMode) return
    await invoke<void>('ide_pty_resize', { sessionId: this.state.terminalSessionId, cols, rows })
  }

  private async runCommandFromInput() {
    const input = this.$<HTMLInputElement>('#command-input')
    const command = input?.value.trim() || ''
    if (!command) return
    if (input) input.value = ''
    await this.runCommand(command)
  }

  private async runCommand(command: string) {
    if (!this.currentRoot()) {
      this.toast('请先打开项目', 'idle')
      return
    }
    this.switchDock('terminal')
    if (this.terminalCommandMode) {
      this.terminalCommandLine = command
      await this.writeCommandTerminalInput('\r')
      return
    }
    if (!this.state.terminalSessionId) await this.startTerminal(this.selectedTerminalShell())
    await this.writeTerminalInput(`${command}\r`)
  }

  private async refreshGit() {
    if (!this.currentRoot()) return
    try {
      const git = await invoke<WorkspaceGitStatus>('ide_git_status', { rootPath: this.currentRoot() })
      this.renderGit(git)
    } catch (error) {
      this.renderGit({ branch: 'Git 不可用', ahead: 0, behind: 0, staged_count: 0, unstaged_count: 0, untracked_count: 0, summary: String(error), diff: '' })
    }
  }

  private async testApi() {
    this.toast('正在测试 API...', 'busy')
    try {
      await this.api.test()
      this.toast('API 连接正常', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async refreshProviderModels() {
    this.state.providerCatalog.loading = true
    this.state.providerCatalog.error = ''
    this.renderProviderStatus()
    try {
      const data = await this.api.refreshModels()
      const list = this.extractModelNames(data)
      this.state.providerCatalog.models = list
      this.state.providerCatalog.updatedAt = new Date().toISOString()
      this.toast(`已刷新 ${list.length} 个模型`, 'ok')
      this.renderProviderStatus()
      this.renderComposer()
      this.fillSettings()
    } catch (error) {
      this.state.providerCatalog.error = String(error)
      this.toast(String(error), 'error')
      this.renderProviderStatus()
      this.renderComposer()
    } finally {
      this.state.providerCatalog.loading = false
      this.renderProviderStatus()
      this.renderComposer()
    }
  }

  private async refreshProviderAccount() {
    this.state.providerCatalog.accountLoading = true
    this.state.providerCatalog.error = ''
    this.renderProviderStatus()
    try {
      const timeout = new Promise((_, reject) => window.setTimeout(() => reject(new Error('余额查询超时')), 15000))
      const data = await Promise.race([this.api.accountStatus(), timeout])
      this.state.providerCatalog.account = this.describeAccountStatus(data)
      this.state.providerCatalog.updatedAt = new Date().toISOString()
      this.toast('账户状态已刷新', 'ok')
      this.renderProviderStatus()
    } catch (error) {
      this.state.providerCatalog.error = String(error)
      this.toast(String(error), 'error')
      this.renderProviderStatus()
    } finally {
      this.state.providerCatalog.accountLoading = false
      this.renderProviderStatus()
    }
  }

  private extractModelNames(data: any): string[] {
    const source = Array.isArray(data) ? data : data?.data || data?.models || data?.items || data?.result || []
    if (!Array.isArray(source)) return []
    return [...new Set(source.map((item: any) => String(item?.id || item?.model || item?.name || item || '').trim()).filter(Boolean))].slice(0, 300)
  }

  private describeAccountStatus(data: any) {
    if (!data?.supported) return data?.message || '该 Provider 不支持通过当前 Key 查询余额。'
    const raw = data.data || data
    const balances = raw.balance_infos || raw.balances || raw.data || raw.items
    if (Array.isArray(balances)) {
      return balances.map((item: any) => `${item.currency || item.name || item.model || 'balance'}: ${item.total_balance ?? item.balance ?? item.amount ?? '-'}`).join(' · ')
    }
    return raw.total_balance || raw.balance || raw.remaining_credit || raw.message || '账户状态已返回，详情请展开 Provider 响应。'
  }

  private markRequest(state: AppState['requestTimeline']['state'], title: string, detail = '') {
    const now = Date.now()
    this.state.requestTimeline = {
      ...this.state.requestTimeline,
      state,
      title,
      detail,
      startedAt: state === 'busy' ? now : this.state.requestTimeline.startedAt,
      durationMs: state === 'busy' ? 0 : now - (this.state.requestTimeline.startedAt || now),
      error: state === 'error' ? detail : '',
    }
    this.renderRequestTimeline()
  }

  private handleAgentEvent(rawEvent: AgentEvent | string) {
    const event = typeof rawEvent === 'string'
      ? (() => {
          try {
            return JSON.parse(rawEvent) as AgentEvent
          } catch {
            return { sessionId: '', type: 'error', payload: { message: rawEvent }, at: new Date().toISOString() } as AgentEvent
          }
      })()
      : rawEvent
    const eventId = Number((event as any).id || 0)
    if (eventId > 0) {
      if (this.seenAgentEventIds.includes(eventId)) return
      this.seenAgentEventIds.push(eventId)
      this.seenAgentEventIds = this.seenAgentEventIds.slice(-1200)
      this.lastAgentEventId = Math.max(this.lastAgentEventId, eventId)
    }
    const eventKey = this.agentEventKey(event)
    if (eventKey) {
      if (this.seenAgentEventKeys.includes(eventKey)) return
      this.seenAgentEventKeys.push(eventKey)
      this.seenAgentEventKeys = this.seenAgentEventKeys.slice(-1600)
    }
    if (event.sessionId && (!this.state.agentRuntime.sessionId || event.sessionId !== this.state.agentRuntime.sessionId)) return
    this.state.agentRuntime.events.push(event)
    this.state.agentRuntime.events = this.state.agentRuntime.events.slice(-300)
    const payload = (event.payload || {}) as any
    if (event.type === 'message_part' || event.type === 'message_delta') {
      if (payload.role === 'assistant' && payload.content) {
        this.acceptAssistantStreamDelta(String(payload.content), event.type === 'message_part')
      }
      return
    }
    if (event.type === 'reasoning_delta') {
      this.state.agentRuntime.thinking = `${this.state.agentRuntime.thinking}${String(payload.content || '')}`.slice(-8000)
      this.state.requestTimeline.reasoning = this.state.agentRuntime.thinking
      // 推理正在流出，说明链路存活：续期看门狗，避免误触发无工具兜底
      this.bumpAiFallbackTimer()
      this.renderRequestTimeline()
      this.renderAssistant()
      this.scheduleSessionPersist()
      return
    }
    if (event.type === 'tool_call_start' || event.type === 'tool_start') {
      this.hideActiveToolProtocolMessage()
      this.pendingToolProtocolBuffer = ''
      const call: ToolCallRecord = {
        id: String(payload.id || `tool-${Date.now()}`),
        name: String(payload.name || 'tool'),
        status: 'running',
        input: payload.input || {},
        output: payload.output,
        error: '',
        startedAt: event.at,
      }
      this.state.agentRuntime.timeline = [
        ...this.state.agentRuntime.timeline.filter(item => item.id !== call.id),
        call,
      ].slice(-80)
      this.rememberActiveTurnTool(call.id, event)
      this.attachRuntimeToolsToActiveMessage()
      // 工具开始执行（如 dir/tree/终端命令），链路存活：续期看门狗，别用裸补全覆盖真正的 agent 流程
      this.bumpAiFallbackTimer()
    }
    if (event.type === 'tool_call_result' || event.type === 'tool_result') {
      const id = String(payload.id || `tool-${Date.now()}`)
      const existing = this.state.agentRuntime.timeline.find(item => item.id === id)
      const finalStatus = String(payload.status || 'ok') === 'error' ? 'error' : 'ok'
      const next: ToolCallRecord = {
        id,
        name: String(payload.name || existing?.name || 'tool'),
        status: existing?.status === 'running' ? 'running' : finalStatus,
        input: payload.input || existing?.input || {},
        output: payload.output,
        error: String(payload.error || ''),
        startedAt: existing?.startedAt || event.at,
        finishedAt: finalStatus === 'ok' || finalStatus === 'error' ? event.at : undefined,
      }
      this.state.agentRuntime.timeline = [
        ...this.state.agentRuntime.timeline.filter(item => item.id !== id),
        next,
      ].slice(-80)
      this.rememberActiveTurnTool(id, event)
      this.scheduleToolCompletion(id, finalStatus, event.at)
      this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== id)
      this.attachRuntimeToolsToActiveMessage()
      // 工具刚返回，ReAct 下一轮通常马上开始：续期看门狗
      this.bumpAiFallbackTimer()
      this.updateAgentDiagnostics()
    }
    if (event.type === 'permission_request') {
      this.hideActiveToolProtocolMessage()
      this.pendingToolProtocolBuffer = ''
      const rawKind = String(payload.kind || 'write')
      const decision = String(payload.decision || 'ask')
      const permission = {
        id: String(payload.id || `permission-${Date.now()}`),
        kind: (rawKind === 'read' || rawKind === 'command' ? rawKind : 'write') as 'read' | 'write' | 'command',
        target: String(payload.target || ''),
        reason: String(payload.reason || '需要用户确认后继续。'),
        risk: (payload.risk === 'low' || payload.risk === 'high' ? payload.risk : 'medium') as 'low' | 'medium' | 'high',
      }
      this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== permission.id)
      const existing = this.state.agentRuntime.timeline.find(item => item.id === permission.id)
      if (!existing) {
        this.state.agentRuntime.timeline.push({
          id: permission.id,
          name: String(payload.tool || payload.name || permission.kind),
          status: decision === 'deny' ? 'error' : 'approval_required',
          input: { target: permission.target },
          error: decision === 'deny' ? permission.reason : '',
          startedAt: event.at,
        })
      }
      this.rememberActiveTurnTool(permission.id, event)
      if (decision === 'deny') {
        this.markRequest('error', 'Agent 权限被策略拒绝', permission.target || permission.reason)
      } else {
        this.state.agentRuntime.pendingPermissions.push(permission)
        this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.slice(-20)
        this.markRequest('busy', '等待用户确认', permission.target || permission.reason)
        this.clearAiFallback(false)
      }
      this.attachRuntimeToolsToActiveMessage()
      this.updateAgentDiagnostics()
    }
    if (event.type === 'patch_preview') {
      this.state.agentRuntime.patchPreviews.push({
        id: String(payload.id || `patch-${Date.now()}`),
        patch: String(payload.patch || ''),
        files: Array.isArray(payload.files) ? payload.files : [],
        requiresApproval: payload.requiresApproval !== false,
      })
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.slice(-12)
      this.syncLatestAgentPatchToDiffPanel()
      this.updateAgentDiagnostics()
    }
    if (event.type === 'usage') {
      this.state.requestTimeline.usage = JSON.stringify(payload)
      this.renderRequestTimeline()
    }
    if (event.type === 'error') {
      this.markRequest('error', 'Agent 执行失败', String(payload.message || event.payload || '未知错误'))
    }
    if (event.type === 'session_done' || event.type === 'done') {
      this.pendingToolProtocolBuffer = ''
      const response = payload.response || {}
      if (response.provider || response.model) {
        this.state.requestTimeline.model = `${response.provider || this.state.settings.provider_type} / ${response.model || this.state.settings.model || '默认模型'}`
      }
      if (response.usage) this.state.requestTimeline.usage = JSON.stringify(response.usage)
      if (response.reasoningSummary) this.state.requestTimeline.reasoning = response.reasoningSummary
      const streamed = this.activeAssistantMessageId ? this.state.chat.find(item => item.id === this.activeAssistantMessageId) : null
      const finalAnswer = String(response.answer || '').trim()
      const waitingForApproval = Boolean(payload.requiresApproval) || this.state.agentRuntime.pendingPermissions.length > 0
      if (streamed && (streamed.text.trim() || streamed.toolCalls?.length)) {
        streamed.toolCalls = this.activeTurnToolCalls()
        if (!waitingForApproval) {
          if (streamed.text.trim()) this.state.ai.history.push({ role: 'assistant', text: streamed.text, at: new Date().toISOString() })
          this.clearAiFallback(true)
        } else {
          this.clearAiFallback(false)
        }
      } else if (finalAnswer && !this.looksLikeToolProtocol(finalAnswer)) {
        this.acceptAssistantStreamDelta(finalAnswer, true)
        const finalMessage = this.activeAssistantMessageId
          ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
          : null
        if (finalMessage) finalMessage.toolCalls = this.activeTurnToolCalls()
        if (!waitingForApproval) {
          this.state.ai.history.push({ role: 'assistant', text: finalAnswer, at: new Date().toISOString() })
          this.clearAiFallback(true)
        } else {
          this.clearAiFallback(false)
        }
      } else if (waitingForApproval) {
        this.activeAssistantMessageId = ''
        this.clearAiFallback(false)
        this.markRequest('busy', '等待用户确认', 'Agent 已暂停，确认工具或 patch 后会继续执行。')
        this.renderAssistant()
        this.scheduleSessionPersist()
        return
      } else if (this.pendingAiRequest && !this.aiFallbackRunning) {
        this.activeAssistantMessageId = ''
        void this.runAiDisplayFallback('Agent 已完成但没有收到可见正文，正在从后端会话快照恢复。')
        this.renderAssistant()
        this.scheduleSessionPersist()
        return
      }
      if (!waitingForApproval) this.activeAssistantMessageId = ''
      if (payload.ok === false || payload.error) this.markRequest('error', 'Agent 执行失败', String(payload.error || '未知错误'))
      else if (waitingForApproval) this.markRequest('busy', '等待用户确认', 'Agent 已暂停，确认后继续执行。')
      else this.markRequest('ok', 'Agent 执行完成', '请求详情、用量和工具轨迹已收纳到调试面板')
    }
    this.renderAssistant()
    this.scheduleSessionPersist()
  }

  private agentEventKey(event: AgentEvent) {
    const payload = (event.payload || {}) as any
    const payloadId = payload.id || payload.requestId || payload.toolCallId || ''
    const stableContent = payload.content
      || payload.message
      || payload.error
      || payload.name
      || payload.kind
      || ''
    const stableTarget = payload.target
      || payload.input?.path
      || payload.input?.command
      || payload.output?.path
      || payload.output?.command
      || ''
    if (!event.type && !payloadId && !stableContent && !stableTarget) return ''
    return [
      event.sessionId || '',
      event.type || '',
      event.at || '',
      String(payloadId),
      String(stableTarget).slice(0, 240),
      String(stableContent).slice(0, 240),
    ].join('|')
  }

  private rememberActiveTurnTool(id: string, event?: AgentEvent) {
    if (!id || (!this.pendingAiRequest && !this.activeAssistantMessageId)) return
    const eventAt = Number(event?.at || 0)
    if (this.activeTurnStartedAt && eventAt > 0 && eventAt < this.activeTurnStartedAt - 3000) return
    if (!this.activeTurnToolIds.includes(id)) {
      this.activeTurnToolIds.push(id)
      this.activeTurnToolIds = this.activeTurnToolIds.slice(-40)
    }
  }

  private activeTurnToolCalls() {
    if (!this.activeTurnToolIds.length) return []
    return this.activeTurnToolIds
      .map(id => this.state.agentRuntime.timeline.find(item => item.id === id))
      .filter(Boolean) as ToolCallRecord[]
  }

  private acceptAssistantStreamDelta(text: string, replace = false) {
    if (!text) return
    if (replace) this.pendingToolProtocolBuffer = ''
    const visibleMessage = this.activeAssistantMessageId
      ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
      : null
    if (!visibleMessage?.text.trim()) {
      const candidate = `${this.pendingToolProtocolBuffer}${text}`
      const toolState = this.classifyToolProtocolCandidate(candidate)
      if (toolState === 'tool') {
        this.pendingToolProtocolBuffer = candidate
        return
      }
      if (toolState === 'maybe') {
        this.pendingToolProtocolBuffer = candidate
        if (candidate.length < 600) return
      }
      if (this.pendingToolProtocolBuffer) {
        text = `${this.pendingToolProtocolBuffer}${text}`
        this.pendingToolProtocolBuffer = ''
      }
    }
    this.appendAssistantDelta(text, replace)
  }

  private classifyToolProtocolCandidate(text: string): 'tool' | 'maybe' | 'text' {
    const trimmed = text.trimStart()
    if (!trimmed) return 'maybe'
    if (this.looksLikeToolProtocol(trimmed)) return 'tool'
    const prefixes = ['`', '``', '```', '```t', '```to', '```too', '```tool', '```j', '```js', '```json', '{', '{"', '{"t', '{"to', '{"tool"', '[', '[{']
    if (prefixes.some(prefix => trimmed === prefix || prefix.startsWith(trimmed) || trimmed.startsWith(prefix))) {
      if (trimmed.length < 600 && !/\n\s*[A-Za-z\u4e00-\u9fa5]/.test(trimmed.replace(/^```(?:tool|json)?/i, ''))) return 'maybe'
    }
    return 'text'
  }

  private appendAssistantDelta(text: string, replace = false) {
    if (!text) return
    this.clearAiFallback(false)
    const message = this.ensureAssistantStreamMessage()
    if (replace) {
      message.text = ''
      this.assistantTypingQueue = ''
      this.assistantTypingMessageId = message.id
    }
    message.toolCalls = [...this.state.agentRuntime.timeline]
    this.assistantTypingMessageId = message.id
    this.assistantTypingQueue += text
    message.toolCalls = this.activeTurnToolCalls()
    this.lastAssistantResponseText = `${message.text}${this.assistantTypingQueue}`
    this.pumpAssistantTyping()
  }

  private ensureAssistantStreamMessage() {
    let message = this.activeAssistantMessageId
      ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
      : null
    if (!message) {
      message = {
        id: `msg-${Date.now()}-assistant-stream`,
        role: 'assistant' as const,
        text: '',
        at: new Date().toISOString(),
        toolCalls: [],
      }
      this.activeAssistantMessageId = message.id
      this.state.chat.push(message)
    }
    return message
  }

  private attachRuntimeToolsToActiveMessage() {
    if (!this.pendingAiRequest && !this.activeAssistantMessageId) return
    const message = this.ensureAssistantStreamMessage()
    message.toolCalls = this.activeTurnToolCalls()
  }

  private scheduleToolCompletion(id: string, status: ToolCallRecord['status'], finishedAt: string) {
    if (status !== 'ok' && status !== 'error') return
    if (this.toolCompletionTimers[id]) window.clearTimeout(this.toolCompletionTimers[id])
    const delay = 120 + Math.min(240, this.toolCompletionSequence++ * 30)
    this.toolCompletionTimers[id] = window.setTimeout(() => {
      delete this.toolCompletionTimers[id]
      const call = this.state.agentRuntime.timeline.find(item => item.id === id)
      if (!call) return
      call.status = status
      call.finishedAt = finishedAt
      this.attachRuntimeToolsToActiveMessage()
      this.renderAssistant()
      this.scheduleSessionPersist()
    }, delay)
  }

  private resetAssistantTyping() {
    if (this.assistantTypingTimer) window.clearTimeout(this.assistantTypingTimer)
    this.assistantTypingTimer = 0
    this.assistantTypingQueue = ''
    this.assistantTypingMessageId = ''
    this.pendingToolProtocolBuffer = ''
  }

  private pumpAssistantTyping() {
    if (this.assistantTypingTimer) return
    const tick = () => {
      const message = this.assistantTypingMessageId
        ? this.state.chat.find(item => item.id === this.assistantTypingMessageId)
        : this.ensureAssistantStreamMessage()
      if (!message || !this.assistantTypingQueue) {
        this.assistantTypingTimer = 0
        this.scheduleSessionPersist()
        return
      }
      const take = this.assistantTypingQueue.length > 3000 ? 96 : this.assistantTypingQueue.length > 900 ? 48 : 18
      const chunk = this.assistantTypingQueue.slice(0, take)
      this.assistantTypingQueue = this.assistantTypingQueue.slice(take)
      message.text += chunk
      message.toolCalls = this.activeTurnToolCalls()
      this.lastAssistantResponseText = `${message.text}${this.assistantTypingQueue}`
      this.renderAssistant()
      if (this.assistantTypingQueue) {
        this.assistantTypingTimer = window.setTimeout(tick, 18)
      } else {
        this.assistantTypingTimer = 0
        this.scheduleSessionPersist()
      }
    }
    this.assistantTypingTimer = window.setTimeout(tick, 0)
  }

  private hideActiveToolProtocolMessage() {
    const messageId = this.assistantTypingMessageId || this.activeAssistantMessageId
    if (!messageId) return
    const message = this.state.chat.find(item => item.id === messageId)
    if (!message) return
    const combined = `${message.text}${this.assistantTypingQueue}`.trim()
    if (!this.looksLikeToolProtocol(combined)) return
    this.resetAssistantTyping()
    this.state.chat = this.state.chat.filter(item => item.id !== messageId)
    this.activeAssistantMessageId = ''
    this.lastAssistantResponseText = ''
    this.renderAssistant()
  }

  private looksLikeToolProtocol(text: string) {
    const raw = text.trim()
    if (!raw) return false
    const fenced = raw.match(/^```(?:json|tool|agent)?\s*([\s\S]*?)```$/i)?.[1]?.trim()
    const candidate = fenced || raw
    if (!(candidate.startsWith('{') || candidate.startsWith('['))) return false
    try {
      const parsed = JSON.parse(candidate)
      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.tools)
          ? parsed.tools
          : Array.isArray(parsed?.tool_calls)
            ? parsed.tool_calls
            : [parsed]
      return items.some((item: any) => Boolean(item?.tool || item?.name))
    } catch {
      return /"tool"\s*:|"name"\s*:/.test(candidate)
    }
  }

  private async createTask() {
    const prompt = (this.$<HTMLTextAreaElement>('#task-prompt')?.value || this.composerDraft).trim()
    if (!prompt) return this.toast('请先输入开发需求', 'idle')
    if (!this.currentRoot()) return this.toast('请先打开本地项目', 'idle')
    if (this.state.settings.connection_mode !== 'autocodePlatform') {
      await this.runLocalAiTask(prompt)
      return
    }
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (input) input.value = ''
    this.composerDraft = ''
    this.renderComposer()
    this.toast('正在创建 AutoCode 任务...', 'busy')
    const tab = this.activeTab()
    const selected = this.editor.selectionText()
    try {
      const body = {
        title: `本地项目开发：${this.state.workspace.currentProject?.name || projectName(this.currentRoot())}`,
        description: [
          prompt,
          '',
          '[AutoCode Local IDE]',
          `workspace=${this.currentRoot()}`,
          `open_file=${tab?.path || ''}`,
          selected ? `selected_text=${selected.slice(0, 4000)}` : '',
          this.state.attachments.length ? `attachments=${this.state.attachments.map(item => item.name).join(', ')}` : '',
          '请优先通过 Local Connector 在用户本机读取、修改、运行和验证。',
        ].filter(Boolean).join('\n'),
        project_type: 'local',
        agent_types: ['general'],
        enable_smart_planning: true,
        tool_policy: 'full_access',
        metadata: {
          local_workspace: this.currentRoot(),
          open_file: tab?.path || '',
          attachments: this.state.attachments,
        },
      }
      const task = await this.api.createTask(body)
      this.state.ai.current = task
      this.state.ai.history.push({ role: 'user', text: prompt, at: new Date().toISOString() })
      const taskId = String(task.id || task.task_id || '')
      if (this.state.workspace.currentProject && taskId) {
        const updated = await invoke<RecentProject>('ide_open_workspace', {
          rootPath: this.state.workspace.currentProject.path,
          taskId,
          previewUrl: task.preview_url || this.state.workspace.currentProject.preview_url || null,
        })
        this.state.workspace.currentProject = updated
        this.upsertRecent(updated)
      }
      this.toast('AutoCode 任务已创建', 'ok')
      this.startTaskPolling()
      this.renderAll()
    } catch (error) {
      this.toast(String(error), 'error')
      this.renderComposer()
    }
  }

  private async runLocalAiTask(prompt: string) {
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (input) input.value = ''
    this.composerDraft = ''
    this.state.chat.push({ id: `msg-${Date.now()}-user`, role: 'user', text: prompt, at: new Date().toISOString() })
    this.activeAssistantMessageId = ''
    this.lastAssistantResponseText = ''
    this.activeTurnStartedAt = Date.now()
    this.activeTurnToolIds = []
    this.resetAssistantTyping()
    this.renderAssistant()
    this.renderComposer()
    this.toast('正在请求本地 Provider...', 'busy')
    this.markRequest('busy', 'Agent 执行中', `${this.state.settings.provider_type} / ${this.state.settings.model || '默认模型'}`)
    const tab = this.activeTab()
    const selected = this.editor.selectionText()
    Object.values(this.toolCompletionTimers).forEach(timer => window.clearTimeout(timer))
    this.toolCompletionTimers = {}
    this.toolCompletionSequence = 0
    this.state.agentRuntime.timeline = []
    this.state.agentRuntime.pendingPermissions = []
    this.state.agentRuntime.patchPreviews = []
    try {
      const sessionId = await this.ensureAgentSession()
      if (!sessionId) throw new Error('Agent 会话不可用')
      const contextRefs = [
        ...this.state.contextChips,
        tab ? { id: `active-file-${Date.now()}`, kind: 'file', label: `当前文件 ${tab.path}`, value: `@当前文件 ${tab.path}\n${tab.draft.slice(0, Math.min(12000, this.aiContextBudget))}` } : null,
        selected ? { id: `selection-${Date.now()}`, kind: 'selection', label: '当前选区', value: `@选区 ${tab?.path || ''}\n${selected.slice(0, 8000)}` } : null,
        this.terminalOutputBuffer.trim() ? { id: `terminal-${Date.now()}`, kind: 'terminal', label: '终端输出', value: `@终端输出\n${this.terminalOutputBuffer.slice(-8000)}` } : null,
        ...this.attachmentContextRefs(),
        { id: `agent-settings-${Date.now()}`, kind: 'workspace', label: 'Agent 设置', value: JSON.stringify({ systemPrompt: this.aiSystemPrompt, temperature: this.aiTemperature, contextBudget: this.aiContextBudget }) },
      ].filter(Boolean)
      this.pendingAiRequest = { prompt, contextRefs: contextRefs as any[] }
      this.clearAiFallback(false)
      this.pendingAiFallbackTimer = window.setTimeout(() => void this.runAiDisplayFallback('等待流式正文超时，正在切换非流式兜底。'), 22000)
      const accepted = await this.api.agentSend(sessionId, prompt, contextRefs as any[])
      this.state.ai.history.push({ role: 'user', text: prompt, at: new Date().toISOString() })
      this.state.requestTimeline.detail = `已接受请求：${accepted?.requestId || 'streaming'}`
      this.toast('Agent 已开始流式返回', 'busy')
      this.renderAssistant()
      this.renderComposer()
      this.scheduleSessionPersist()
    } catch (error) {
      this.clearAiFallback(true)
      this.markRequest('error', 'Provider 请求失败', String(error))
      this.toast(String(error), 'error')
      this.renderComposer()
    }
  }

  private clearAiFallback(clearRequest: boolean) {
    if (this.pendingAiFallbackTimer) {
      window.clearTimeout(this.pendingAiFallbackTimer)
      this.pendingAiFallbackTimer = 0
    }
    if (clearRequest) {
      this.pendingAiRequest = null
      this.aiFallbackRunning = false
    }
  }

  // 看门狗续期：任何 agent 进度事件（推理/工具开始/工具返回）都调用它。
  // 只要链路还在推进，就把 22s 兜底窗口向后顺延，避免把真正的 ReAct 流程
  // 误判为“流式卡死”而降级到无工具的裸补全。
  private bumpAiFallbackTimer() {
    if (!this.pendingAiRequest || this.aiFallbackRunning) return
    if (this.pendingAiFallbackTimer) window.clearTimeout(this.pendingAiFallbackTimer)
    this.pendingAiFallbackTimer = window.setTimeout(
      () => void this.runAiDisplayFallback('等待流式正文超时，正在切换非流式兜底。'),
      22000,
    )
  }

  // 链路是否正处于真实执行中：有工具在跑或有待用户确认的授权。
  // 这两种情况下即便长时间没有正文，也不能用裸补全覆盖——终端命令可能只是耗时长。
  private agentLinkActive(): boolean {
    const hasRunningTool = this.state.agentRuntime.timeline.some(item => item.status === 'running')
    const hasPendingPermission = this.state.agentRuntime.pendingPermissions.length > 0
    return hasRunningTool || hasPendingPermission
  }

  private async runAiDisplayFallback(reason: string) {
    if (this.aiFallbackRunning) return
    const pending = this.pendingAiRequest
    if (!pending || this.lastAssistantResponseText.trim()) {
      this.clearAiFallback(true)
      return
    }
    // 链路仍在真实执行（工具在跑 / 等授权）：不要用无工具裸补全覆盖真正的 agent 流程，
    // 顺延一个窗口继续等。这正是“跑 dir/tree/终端命令耗时长”被误降级的场景。
    if (this.agentLinkActive()) {
      this.bumpAiFallbackTimer()
      return
    }
    this.aiFallbackRunning = true
    this.clearAiFallback(false)
    this.markRequest('busy', '正在恢复 Agent 回复', reason)
    try {
      const restored = await this.restoreAgentResultFromSnapshot()
      if (!restored) {
        this.aiFallbackRunning = false
        this.bumpAiFallbackTimer()
        this.markRequest('busy', 'Agent 仍在执行', '后端还没有最终回复，继续等待事件或 session 结果。')
        return
      }
      const answer = String(restored.answer || '').trim()
      if (!answer) throw new Error('Agent session 已返回，但没有可显示正文。')
      if (this.looksLikeToolProtocol(answer)) {
        this.aiFallbackRunning = false
        this.markRequest('busy', 'Agent 正在等待工具结果', '当前快照是工具协议，已隐藏并继续等待工具事件或最终回答。')
        this.bumpAiFallbackTimer()
        return
      }
      this.acceptAssistantStreamDelta(answer, true)
      const message = this.activeAssistantMessageId
        ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
        : null
      if (message) message.toolCalls = this.activeTurnToolCalls()
      this.state.ai.history.push({ role: 'assistant', text: answer, at: new Date().toISOString() })
      this.activeAssistantMessageId = ''
      this.markRequest('ok', 'Agent 回复已显示', '流式事件未及时落到聊天区，已从后端 Agent session 恢复。')
      this.toast('Agent 回复已显示', 'ok')
    } catch (error) {
      this.markRequest('error', 'Agent 回复恢复失败', String(error))
      this.toast(`Agent 回复恢复失败：${String(error)}`, 'error')
    } finally {
      this.clearAiFallback(true)
      this.renderAssistant()
      this.scheduleSessionPersist()
    }
  }

  private async restoreAgentResultFromSnapshot(): Promise<{ answer: string } | null> {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return null
    const snapshot = await this.api.agentSessionSnapshot(sessionId)
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
    const lastAssistant = [...messages].reverse().find((item: any) => item?.role === 'assistant')
    const answer = String(lastAssistant?.content || '').trim()
    const toolCalls = Array.isArray(snapshot?.toolCalls) ? snapshot.toolCalls : []
    if (toolCalls.length) {
      this.state.agentRuntime.timeline = toolCalls.map((call: any, index: number) => ({
        id: String(call.id || `tool-snapshot-${index}`),
        name: String(call.name || 'tool'),
        status: String(call.status || 'ok') === 'error' ? 'error' : 'ok',
        input: call.input || {},
        output: call.output,
        error: String(call.error || ''),
        startedAt: String(call.startedAt || call.started_at || snapshot.updatedAt || new Date().toISOString()),
        finishedAt: String(call.finishedAt || call.finished_at || snapshot.updatedAt || new Date().toISOString()),
      })).slice(-80)
    }
    if (!answer) return null
    return { answer }
  }

  private startTaskPolling() {
    if (this.state.ai.polling) window.clearInterval(this.state.ai.polling)
    this.state.ai.polling = window.setInterval(() => void this.refreshTask(true), 5000)
  }

  private async refreshTask(silent = false) {
    const taskId = this.state.workspace.currentProject?.task_id || this.state.ai.current?.id || this.state.ai.current?.task_id
    if (!taskId) {
      if (!silent) this.toast('当前项目还没有绑定任务', 'idle')
      return
    }
    try {
      const task = await this.api.taskStatus(taskId)
      this.state.ai.current = task
      if (task.preview_url) {
        this.state.previewUrl = task.preview_url
        const input = this.$<HTMLInputElement>('#preview-url')
        if (input) input.value = task.preview_url
      }
      if (!silent) this.toast('任务状态已刷新', 'ok')
      this.renderAssistant()
    } catch (error) {
      if (!silent) this.toast(String(error), 'error')
    }
  }

  private async loadSkills() {
    if (this.state.settings.connection_mode !== 'autocodePlatform') {
      this.state.skills.items = [
        { id: 'local-generate', name: '本地代码生成', description: '基于当前文件、选区和附件请求 Provider。' },
        { id: 'local-review', name: '本地代码审查', description: '审查当前文件和 Git diff，不依赖平台任务。' },
        { id: 'local-fix-terminal', name: '终端报错修复', description: '把终端输出作为上下文生成修复建议。' },
        { id: 'local-explain', name: '解释代码', description: '解释当前文件结构、风险和改造点。' },
      ]
      this.state.skills.error = ''
      this.renderSkills()
      return
    }
    this.state.skills.loading = true
    this.state.skills.error = ''
    this.renderSkills()
    try {
      this.state.skills.items = await this.api.listSkills()
      this.toast(`已加载 ${this.state.skills.items.length} 个技能`, 'ok')
    } catch (error) {
      this.state.skills.error = String(error)
      this.toast(String(error), 'error')
    } finally {
      this.state.skills.loading = false
      this.renderSkills()
    }
  }

  private async installSkill(agentId: string) {
    if (this.state.settings.connection_mode !== 'autocodePlatform') {
      const prompts: Record<string, string> = {
        'local-generate': '请根据当前文件和项目上下文生成代码实现方案。',
        'local-review': '请审查当前文件和 Git diff，列出问题和修复建议。',
        'local-fix-terminal': '请根据终端输出和当前文件定位报错原因并给出修复。',
        'local-explain': '请解释当前文件的核心逻辑、依赖关系和风险点。',
      }
      this.insertComposer(prompts[agentId] || '请基于当前项目上下文继续开发。')
      return
    }
    try {
      await this.api.installSkill(agentId)
      this.toast('技能已安装，当前 IDE 会话可立即调用', 'ok')
      await this.loadSkills()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async persistSettingsFromState() {
    try {
      this.state.settings = await invoke<IdeSettings>('ide_save_settings', { settings: this.state.settings })
      this.renderProviderStatus()
      this.scheduleSessionPersist()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async saveSettings() {
    const next: IdeSettings = {
      ...this.state.settings,
      api_base_url: this.$<HTMLInputElement>('#api-base-url')?.value.trim().replace(/\/+$/, '') || '',
      api_key: this.$<HTMLInputElement>('#api-key')?.value || '',
      connection_mode: this.$<HTMLSelectElement>('#connection-mode')?.value || 'aiProvider',
      provider_type: this.$<HTMLSelectElement>('#provider-type')?.value || 'openai-responses',
      model: this.$<HTMLInputElement>('#provider-model')?.value.trim() || '',
      reasoning_mode: this.$<HTMLSelectElement>('#reasoning-mode')?.value || 'auto',
      reasoning_effort: this.$<HTMLInputElement>('#reasoning-effort')?.value.trim() || 'medium',
      reasoning_budget_tokens: Number(this.$<HTMLInputElement>('#reasoning-budget')?.value || 8192),
      reasoning_summary: true,
      custom_headers: this.state.settings.custom_headers || {},
      transcription_model: this.$<HTMLInputElement>('#transcription-model')?.value.trim() || '',
      default_shell: this.$<HTMLSelectElement>('#default-shell')?.value || 'auto',
      default_workspace_path: this.$<HTMLInputElement>('#default-workspace-path')?.value || '',
      preview_url: this.$<HTMLInputElement>('#settings-preview-url')?.value || '',
      last_workspace_path: this.currentRoot(),
    }
    this.aiTemperature = Number(this.$<HTMLInputElement>('#settings-temperature')?.value || this.aiTemperature)
    this.aiContextBudget = Number(this.$<HTMLInputElement>('#settings-context-budget')?.value || this.aiContextBudget)
    this.aiSystemPrompt = this.$<HTMLTextAreaElement>('#settings-system-prompt')?.value || this.aiSystemPrompt
    localStorage.setItem('autocode.ide.ai.temperature', String(this.aiTemperature))
    localStorage.setItem('autocode.ide.ai.contextBudget', String(this.aiContextBudget))
    localStorage.setItem('autocode.ide.ai.systemPrompt', this.aiSystemPrompt)
    try {
      this.state.settings = await invoke<IdeSettings>('ide_save_settings', { settings: next })
      this.state.theme = (this.$<HTMLSelectElement>('#theme-select')?.value as AppState['theme']) || this.state.theme
      saveTheme(this.state.theme)
      this.applyTheme()
      this.state.previewUrl = this.state.settings.preview_url
      this.closeSettings()
      this.renderAll()
      this.persistSessionSnapshot()
      this.toast('设置已保存', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async openSystem() {
    if (!this.currentRoot()) return
    try {
      await invoke<void>('ide_open_path', { path: this.selectedWorkspacePath() ? this.absolutePath(this.selectedWorkspacePath()) : this.currentRoot() })
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private loadPreview() {
    const input = this.$<HTMLInputElement>('#preview-url')
    const rawUrl = input?.value.trim() || this.state.previewUrl
    const url = this.normalizePreviewUrl(rawUrl)
    if (!url) return
    this.state.previewUrl = url
    if (input) input.value = url
    const frame = this.$<HTMLIFrameElement>('#preview-frame')
    this.setPreviewStatus('loading', '正在加载预览', url)
    if (frame) {
      let settled = false
      const timer = window.setTimeout(() => {
        if (!settled) this.setPreviewStatus('error', '预览加载超时', '请确认开发服务已启动，或点击“外部打开”。')
      }, 8000)
      frame.onload = () => {
        settled = true
        window.clearTimeout(timer)
        this.setPreviewStatus('ok', '', '')
      }
      frame.onerror = () => {
        settled = true
        window.clearTimeout(timer)
        this.setPreviewStatus('error', '预览无法嵌入', '该页面可能未启动、拒绝 iframe，或被 WebView 策略拦截。')
      }
      frame.src = url
    }
    this.scheduleSessionPersist()
  }

  private normalizePreviewUrl(value: string) {
    const url = value.trim()
    if (!url) return ''
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url
    if (/^(localhost|127\.0\.0\.1|\[::1\])/i.test(url)) return `http://${url}`
    return url
  }

  private setPreviewStatus(kind: 'idle' | 'loading' | 'ok' | 'error', title: string, detail: string) {
    const status = this.$<HTMLElement>('#preview-status')
    if (!status) return
    status.className = `preview-status ${kind}`
    status.hidden = kind === 'ok'
    if (kind !== 'ok') {
      status.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>`
    }
  }

  private async openPreviewExternal() {
    const input = this.$<HTMLInputElement>('#preview-url')
    const url = this.normalizePreviewUrl(input?.value.trim() || this.state.previewUrl)
    if (!url) {
      this.toast('请先输入预览地址', 'idle')
      return
    }
    try {
      await invoke<void>('ide_open_url', { url })
      this.toast('已在外部浏览器打开预览', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private switchActivity(view: ActivityView) {
    if (view === 'settings') return this.openSettings()
    this.state.activeActivity = view
    this.root.querySelectorAll<HTMLElement>('[data-activity]').forEach(item => item.classList.toggle('active', item.dataset.activity === view))
    this.root.querySelectorAll<HTMLElement>('[data-side-view]').forEach(item => item.classList.toggle('active', item.dataset.sideView === view))
    if (view === 'git') this.switchDock('git')
    if (view === 'skills') {
      this.switchDock('skills')
      if (!this.state.skills.items.length) void this.loadSkills()
    }
    this.scheduleSessionPersist()
  }

  private switchDock(tab: DockTab) {
    this.state.activeDock = tab
    this.root.querySelectorAll<HTMLElement>('[data-dock]').forEach(item => item.classList.toggle('active', item.dataset.dock === tab))
    this.root.querySelectorAll<HTMLElement>('[data-dock-panel]').forEach(item => item.classList.toggle('active', item.dataset.dockPanel === tab))
    this.terminal.fit()
    this.scheduleSessionPersist()
  }

  private switchComposerMode(mode: ComposerMode) {
    this.state.composerMode = mode
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private toggleAssistant() {
    this.state.layout.assistantCollapsed = !this.state.layout.assistantCollapsed
    this.applyLayout()
  }

  private toggleBottom() {
    this.state.layout.bottomCollapsed = !this.state.layout.bottomCollapsed
    this.applyLayout()
  }

  private openSettings() {
    this.state.settingsOpen = true
    this.fillSettings()
    this.$('#settings-overlay')?.removeAttribute('hidden')
    this.$('#settings-drawer')?.removeAttribute('hidden')
  }

  private closeSettings() {
    this.state.settingsOpen = false
    this.$('#settings-overlay')?.setAttribute('hidden', '')
    this.$('#settings-drawer')?.setAttribute('hidden', '')
  }

  private openCommandCenter(mode: 'commands' | 'files' = 'commands') {
    this.commandFilter = mode === 'files' ? '>' : ''
    this.$('#command-center')?.removeAttribute('hidden')
    const input = this.$<HTMLInputElement>('#command-search')
    if (input) {
      input.value = this.commandFilter
      input.focus()
    }
    this.renderCommandList()
  }

  private closeCommandCenter() {
    this.$('#command-center')?.setAttribute('hidden', '')
  }

  private runCommandAction(action: string) {
    this.closeCommandCenter()
    if (action === 'open-project') void this.pickWorkspace()
    if (action === 'save') void this.saveActiveFile()
    if (action === 'task') this.focusComposer()
    if (action === 'build') void this.runCommand('npm run build')
    if (action === 'test') void this.runCommand('npm test')
    if (action === 'git') this.switchDock('git')
    if (action === 'settings') this.openSettings()
  }

  private renderAll() {
    this.renderWorkspace()
    this.renderTree()
    this.renderRecent()
    this.renderTabs()
    this.renderEditor()
    this.renderSearch()
    this.renderSkills()
    this.renderProblems()
    this.renderProviderStatus()
    this.renderRequestTimeline()
    this.renderTerminalSessions()
    this.renderAssistant()
    this.renderComposer()
    this.syncComposerDraftToDom()
    this.fillSettings()
  }

  private renderTerminalSessions() {
    const select = this.$<HTMLSelectElement>('#terminal-session-select')
    const shellSelect = this.$<HTMLSelectElement>('#terminal-shell-select')
    if (!select) {
      if (shellSelect) shellSelect.value = this.state.terminal.shell || this.defaultTerminalShellArg()
      return
    }
    const sessions = this.state.terminalSessions
    select.innerHTML = sessions.length
      ? sessions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(compactPath(item.cwd))}</option>`).join('')
      : '<option value="">无终端</option>'
    select.value = this.state.terminalSessionId || ''
    if (shellSelect) shellSelect.value = this.state.terminal.shell || this.defaultTerminalShellArg()
  }

  private renderWorkspace() {
    const project = this.state.workspace.currentProject
    const fileCount = flattenEntries(this.state.workspace.tree).filter(item => item.kind === 'file').length
    this.text('#version-label', `v${this.state.version || '-'} · 本地增强版`)
    this.text('#workspace-name', project?.name || '未打开项目')
    this.text('#workspace-path', project ? compactPath(project.path) : '选择本地项目开始开发')
    this.text('#file-count', String(fileCount))
    this.text('#context-project', project?.name || '未打开项目')
    this.text('#context-path', project?.path || '等待选择工作区')
    this.text('#project-status', project ? '已打开' : '未打开')
    this.text('#api-status', this.state.apiState === 'ok' ? '正常' : this.state.apiState === 'error' ? '异常' : this.state.settings.api_base_url ? '已配置' : '待配置')
  }

  private renderTree() {
    const tree = this.$('#file-tree')
    if (!tree) return
    this.renderExplorerTarget()
    if (!this.currentRoot()) {
      tree.innerHTML = '<div class="empty-hint">打开项目后显示文件树。</div>'
      return
    }
    const renderItems = (items: WorkspaceEntry[], level = 0): string => items.map(item => {
      const selected = item.path === this.state.workspace.selectedPath || item.path === this.state.workspace.activePath
      const expanded = this.state.workspace.expandedDirs.includes(item.path)
      const icon = item.kind === 'dir' ? (expanded ? '▾' : '▸') : '•'
      const size = item.kind === 'file' ? bytesLabel(item.size) : ''
      return `
        <button class="tree-item ${item.kind} ${selected ? 'active' : ''}" data-open-path="${escapeHtml(item.path)}" style="--level:${level}">
          <span class="tree-icon">${icon}</span>
          <span class="tree-name">${escapeHtml(item.name)}</span>
          <span class="tree-size">${escapeHtml(size)}</span>
        </button>
        ${item.kind === 'dir' && expanded ? renderItems(item.children || [], level + 1) : ''}
      `
    }).join('')
    tree.innerHTML = renderItems(this.state.workspace.tree) || '<div class="empty-hint">该目录没有可显示文件。</div>'
  }

  private renderExplorerTarget() {
    const selected = this.selectedWorkspacePath()
    const label = this.$('#selected-target')
    if (label) label.textContent = selected ? `当前选中：${selected}` : '当前选中：工作区根目录'
    ;['#rename-entry', '#delete-entry', '#copy-relative-path', '#copy-absolute-path', '#copy-file-name', '#copy-parent-path'].forEach(selector => {
      const button = this.$<HTMLButtonElement>(selector)
      if (button) button.disabled = !selected
    })
  }

  private renderRecent() {
    const list = this.$('#recent-list')
    if (!list) return
    const recent = this.state.settings.recent_projects || []
    list.innerHTML = recent.length
      ? recent.slice(0, 8).map(item => `
        <button class="recent-item ${item.path === this.currentRoot() ? 'active' : ''}" data-recent-path="${escapeHtml(item.path)}">
          <strong>${escapeHtml(item.name || projectName(item.path))}</strong>
          <span>${escapeHtml(compactPath(item.path))}</span>
          <small>${escapeHtml(formatTime(item.last_opened_at))}</small>
        </button>
      `).join('')
      : '<div class="empty-hint">暂无最近项目。</div>'
  }

  private renderTabs() {
    const tabbar = this.$('#tabbar')
    if (!tabbar) return
    const tabs = this.state.workspace.tabs
    tabbar.innerHTML = tabs.length
      ? tabs.map(tab => `
        <div class="editor-tab ${tab.path === this.state.workspace.activePath ? 'active' : ''}" data-tab-container="${escapeHtml(tab.path)}">
          <button class="tab-main" data-tab-path="${escapeHtml(tab.path)}" title="${escapeHtml(tab.path)}">
            <span>${dirty(tab) ? '● ' : ''}${escapeHtml(tab.name)}</span>
            <small>${escapeHtml(tab.path)}</small>
          </button>
          <button class="tab-close" data-close-tab="${escapeHtml(tab.path)}" title="关闭">×</button>
        </div>
      `).join('')
      : '<div class="tab-placeholder">未打开文件</div>'
    const save = this.$<HTMLButtonElement>('#save-file')
    if (save) save.disabled = !this.activeTab() || !dirty(this.activeTab()!)
  }

  private renderEditor() {
    const tab = this.activeTab()
    const empty = this.$('#empty-editor')
    const host = this.$('#editor-host')
    if (!tab) {
      empty?.removeAttribute('hidden')
      host?.setAttribute('hidden', '')
      this.editor.setTab(null)
      return
    }
    empty?.setAttribute('hidden', '')
    host?.removeAttribute('hidden')
    this.editor.setTab(tab)
    this.text('#editor-title', tab.name)
    this.text('#editor-meta', `${tab.path} · ${bytesLabel(tab.size)} · ${tab.language}`)
    this.renderEditorStatus()
  }

  private renderEditorStatus() {
    const tab = this.activeTab()
    this.text('#encoding-status', tab?.encoding?.toUpperCase() || 'UTF-8')
    this.text('#line-status', tab?.lineEnding?.toUpperCase() || 'LF')
    this.text('#dirty-status', tab ? (dirty(tab) ? '未保存' : '已同步') : 'Ready')
    const save = this.$<HTMLButtonElement>('#save-file')
    if (save) save.disabled = !tab || !dirty(tab)
  }

  private renderSearch() {
    const list = this.$('#search-results')
    if (!list) return
    list.innerHTML = this.state.workspace.searchResults.length
      ? this.state.workspace.searchResults.map(item => `
        <button class="search-item" data-open-path="${escapeHtml(item.path)}">
          <strong>${escapeHtml(item.path)}${item.line > 0 ? `:${item.line}` : ''}</strong>
          <span>${escapeHtml(item.preview || item.name)}</span>
        </button>
      `).join('')
      : '<div class="empty-hint">输入关键词搜索文件。</div>'
  }

  private renderGit(git: WorkspaceGitStatus) {
    this.text('#branch-name', git.branch || '-')
    const mini = this.$('#git-mini')
    const summary = this.$('#git-summary')
    const diff = this.$('#git-diff')
    const html = `<strong>${escapeHtml(git.branch || '未检测到分支')}</strong><span>staged ${git.staged_count}</span><span>unstaged ${git.unstaged_count}</span><span>untracked ${git.untracked_count}</span><span>ahead ${git.ahead} / behind ${git.behind}</span>`
    if (mini) mini.innerHTML = html
    if (summary) summary.innerHTML = html
    if (diff) diff.textContent = git.diff || git.summary || '工作区干净。'
  }

  private syncLatestAgentPatchToDiffPanel() {
    const latest = this.state.agentRuntime.patchPreviews[this.state.agentRuntime.patchPreviews.length - 1]
    if (!latest?.patch) return
    const summary = this.$('#git-summary')
    const diff = this.$('#git-diff')
    if (summary) {
      summary.innerHTML = `
        <strong>Agent Patch 预览</strong>
        <span>${escapeHtml(this.patchSummary(latest.patch))}</span>
        <span>${latest.requiresApproval ? '等待确认' : '可直接应用'}</span>
      `
    }
    if (diff) diff.textContent = latest.patch
  }

  private showLatestAgentDiff() {
    if (!this.state.agentRuntime.patchPreviews.length) {
      this.toast('当前没有 Agent patch 预览', 'idle')
      return
    }
    this.syncLatestAgentPatchToDiffPanel()
    this.switchDock('git')
  }

  private updateAgentDiagnostics() {
    this.renderProblems()
    this.renderTerminalSessions()
  }

  private agentDiagnostics() {
    const runtime = this.state.agentRuntime
    const terminalReady = Boolean(this.state.terminalSessionId && this.state.terminal.health === 'ready')
    const providerReady = this.state.settings.connection_mode === 'autocodePlatform'
      ? Boolean(this.state.settings.api_base_url)
      : Boolean(this.state.settings.api_base_url && this.state.settings.model)
    const eventReady = Boolean(this.state.localServer.ok || runtime.events.length)
    const sessionReady = Boolean(runtime.sessionId)
    const pending = runtime.pendingPermissions.length
    const failed = runtime.timeline.filter(item => item.status === 'error').length
    const patchCount = runtime.patchPreviews.length
    return [
      {
        ok: Boolean(this.currentRoot()),
        title: '项目',
        detail: this.currentRoot() || '未打开项目',
      },
      {
        ok: sessionReady,
        title: 'Agent Session',
        detail: sessionReady ? runtime.sessionId : '未创建本地 Agent 会话',
      },
      {
        ok: eventReady,
        title: '事件流',
        detail: this.state.localServer.baseUrl || (runtime.events.length ? `${runtime.events.length} 个本地事件` : '等待本地事件服务'),
      },
      {
        ok: providerReady,
        title: 'Provider',
        detail: `${this.state.settings.provider_type || '-'} / ${this.state.settings.model || '未选择模型'}`,
      },
      {
        ok: terminalReady,
        title: '终端',
        detail: terminalReady ? `${this.state.terminal.shell} · ${this.state.terminal.cwd}` : `状态：${this.state.terminal.health || 'idle'}`,
      },
      {
        ok: pending === 0,
        title: '权限',
        detail: pending ? `${pending} 个操作等待确认` : '无待审批操作',
      },
      {
        ok: failed === 0,
        title: '工具调用',
        detail: `${runtime.timeline.length} 次调用${failed ? ` · ${failed} 次失败` : ''}`,
      },
      {
        ok: patchCount === 0 || pending > 0,
        title: 'Patch',
        detail: patchCount ? `${patchCount} 个预览，可在 Git 面板查看` : '暂无文件修改预览',
      },
    ]
  }

  private renderSkills() {
    const render = (target: Element | null) => {
      if (!target) return
      const query = this.state.skills.query.toLowerCase()
      const items = this.state.skills.items.filter(item => JSON.stringify(item).toLowerCase().includes(query))
      target.innerHTML = this.state.skills.loading
        ? '<div class="empty-hint">正在加载技能商店...</div>'
        : this.state.skills.error
          ? `<div class="empty-hint">技能加载失败：${escapeHtml(this.state.skills.error)}</div>`
        : items.length
          ? items.map(item => {
            const name = item.displayName || item.display_name || item.name || item.agentName || item.id || '未命名技能'
            const id = String(item.agentId || item.agent_id || item.id || '')
            const action = this.state.settings.connection_mode === 'autocodePlatform' ? '安装' : '使用'
            return `<article class="skill-item"><div><strong>${escapeHtml(name)}</strong><span>${escapeHtml(item.description || item.summary || '来自 AutoCode 技能商店')}</span></div><button class="secondary-button" data-agent-id="${escapeHtml(id)}">${action}</button></article>`
          }).join('')
          : '<div class="empty-hint">点击刷新从 API 加载技能。</div>'
    }
    render(this.$('#skill-list'))
    render(this.$('#dock-skill-list'))
  }

  private renderProblems() {
    const list = this.$('#problem-list')
    if (!list) return
    const diagnostics = this.agentDiagnostics()
    const problems = this.state.problems.slice(0, 20)
    list.innerHTML = `
      <section class="self-check-panel">
        <header><strong>IDE 自检</strong><span>${diagnostics.filter(item => item.ok).length}/${diagnostics.length}</span></header>
        ${diagnostics.map(item => `
          <div class="self-check-item ${item.ok ? 'ok' : 'warn'}">
            <span></span>
            <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>
          </div>
        `).join('')}
      </section>
      ${this.state.agentRuntime.patchPreviews.length ? `<button class="problem-action" id="view-agent-diff">查看最新 Agent Diff</button>` : ''}
      ${problems.length
        ? problems.map(item => `<div class="problem-item">${escapeHtml(item)}</div>`).join('')
        : '<div class="empty-hint">暂无构建问题。Agent 运行、终端、Provider 和会话状态会显示在上方自检中。</div>'}
    `
  }

  private renderProviderStatus() {
    const provider = this.$<HTMLSelectElement>('#workbench-provider')
    if (provider && document.activeElement !== provider) provider.value = this.state.settings.provider_type || 'openai-responses'
    const model = this.$<HTMLSelectElement>('#workbench-model')
    if (model) {
      const current = this.state.settings.model || ''
      const options = [current, ...this.state.providerCatalog.models].filter(Boolean)
      const unique = [...new Set(options)]
      model.innerHTML = unique.length
        ? unique.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')
        : '<option value="">未加载模型</option>'
      if (current) model.value = current
    }
    const account = this.$('#account-pill')
    if (account) account.textContent = this.state.providerCatalog.accountLoading ? '余额查询中...' : (this.state.providerCatalog.account || '余额未查询')
    const status = this.$('#provider-status')
    if (status) {
      const catalog = this.state.providerCatalog
      status.innerHTML = `
        <strong>${catalog.loading ? '正在刷新...' : 'Provider 状态'}</strong>
        <span>模型：${catalog.models.length ? `${catalog.models.length} 个` : '未刷新'} · 余额：${escapeHtml(catalog.account || '未查询')}</span>
        ${catalog.error ? `<small>${escapeHtml(catalog.error)}</small>` : ''}
      `
    }
    const list = this.$<HTMLDataListElement>('#provider-model-list')
    if (list) {
      list.innerHTML = this.state.providerCatalog.models.map(model => `<option value="${escapeHtml(model)}"></option>`).join('')
    }
  }

  private renderRequestTimeline() {
    const card = this.$('#request-timeline')
    if (!card) return
    const item = this.state.requestTimeline
    if (item.state === 'idle' || item.state === 'ok') {
      card.setAttribute('hidden', '')
      card.innerHTML = ''
      return
    }
    card.removeAttribute('hidden')
    card.className = `request-card ${item.state}`
    card.innerHTML = `
      <div><strong>${escapeHtml(item.title || '请求详情')}</strong><span>${item.durationMs ? `${item.durationMs}ms` : item.state}</span></div>
      <details ${item.state === 'error' ? 'open' : ''}>
        <summary>请求详情 / 调试</summary>
        ${item.detail ? `<small>${escapeHtml(item.detail)}</small>` : ''}
        ${item.model ? `<small>模型：${escapeHtml(item.model)}</small>` : ''}
        ${item.usage ? `<small>用量：${escapeHtml(item.usage)}</small>` : ''}
        ${item.reasoning ? `<pre>${escapeHtml(item.reasoning)}</pre>` : ''}
        ${item.error ? `<pre>${escapeHtml(item.error)}</pre>` : ''}
      </details>
    `
  }
  private renderAssistant() {
    const thread = this.$('#assistant-thread')
    const runtimePanel = this.$('#agent-runtime-panel')
    const status = this.$('#task-status')
    const task = this.state.ai.current
    const modeLabel = this.state.settings.connection_mode === 'autocodePlatform' ? 'AutoCode 平台' : '本地 Provider'
    if (status) {
      const server = this.state.localServer.ok && this.state.localServer.baseUrl
        ? ` · Server ${this.state.localServer.baseUrl}`
        : ''
      status.innerHTML = task
        ? `<strong>${escapeHtml(task.title || task.id || 'AutoCode 任务')}</strong><span>状态：${escapeHtml(task.status || '-')}${escapeHtml(server)}</span>`
        : `<strong>${escapeHtml(modeLabel)}</strong><span>${escapeHtml(this.state.settings.provider_type)} / ${escapeHtml(this.state.settings.model || '未选择模型')}${escapeHtml(server)}</span>`
    }
    if (runtimePanel) {
      runtimePanel.innerHTML = `${this.renderContextChips()}${this.renderAgentRuntime()}`
    }
    if (!thread) return
    const messages = this.state.chat.filter(item => item.role !== 'assistant' || item.text.trim() || item.toolCalls?.length).map(item => `
      <article class="assistant-message ${item.role}">
        <div class="message-title"><strong>${this.messageRoleLabel(item.role)}</strong><span>${escapeHtml(formatTime(item.at))}</span></div>
        ${this.renderChatMessageContent(item)}
      </article>
    `).join('')
    thread.innerHTML = messages
    thread.scrollTop = thread.scrollHeight
  }
  private messageRoleLabel(role: string) {
    if (role === 'user') return '你'
    if (role === 'assistant') return 'AI'
    if (role === 'error') return '错误'
    return '系统'
  }

  private renderContextChips() {
    if (!this.state.contextChips.length) {
      return `
        <details class="assistant-context">
          <summary><strong>快捷上下文</strong><span>当前文件 / 选区 / 终端 / Git</span></summary>
          <div>
            <button id="context-current-file">当前文件</button>
            <button id="context-selection">选区</button>
            <button id="context-terminal">终端输出</button>
            <button id="context-git">Git diff</button>
          </div>
        </details>
      `
    }
    return `
      <details class="assistant-context" open>
        <summary><strong>已引用上下文</strong><span>${this.state.contextChips.length} 项</span></summary>
        <div>${this.state.contextChips.map(chip => `<button title="${escapeHtml(chip.value)}">${escapeHtml(chip.label)}</button>`).join('')}</div>
      </details>
    `
  }

  private renderToolTrace(calls: ToolCallRecord[]) {
    if (!calls.length) return ''
    const collapsedCount = Math.max(0, calls.length - 18)
    const visible = calls.slice(-18)
    return `
      <div class="agent-tool-list">
        ${collapsedCount ? `<div class="tool-history-note">已折叠较早 ${collapsedCount} 个工具调用</div>` : ''}
        ${visible.map((call, index) => `
          <details class="agent-tool-card ${escapeHtml(call.status)} ${index === visible.length - 1 ? 'latest' : ''}" ${call.status === 'running' || call.status === 'error' || call.status === 'approval_required' ? 'open' : ''}>
            <summary>
              <span class="tool-status-dot"></span>
              <strong>${escapeHtml(this.toolNameLabel(call.name))}</strong>
              <small>${escapeHtml(this.toolSummary(call))}</small>
              <em>${escapeHtml(this.toolStatusLabel(call.status))}</em>
            </summary>
            ${this.renderToolDetail(call)}
          </details>
        `).join('')}
      </div>
    `
  }

  private renderAgentRuntime() {
    const runtime = this.state.agentRuntime
    if (!runtime.pendingPermissions.length && !runtime.patchPreviews.length && !runtime.thinking) return ''
    const latestPatch = runtime.patchPreviews[runtime.patchPreviews.length - 1]
    return `
      <article class="assistant-artifacts agent-runtime">
        <header class="agent-runtime-head">
          <div>
            <strong>本轮待处理</strong>
            <span>${runtime.pendingPermissions.length ? `${runtime.pendingPermissions.length} 个操作待确认` : '无待确认'}${latestPatch ? ` · ${this.patchSummary(latestPatch.patch)}` : ''}</span>
          </div>
          ${runtime.timeline.length ? `<b>${runtime.timeline.length} 个工具</b>` : ''}
        </header>
        ${runtime.thinking ? `
          <details class="thinking-summary">
            <summary><strong>思考摘要</strong><span>默认折叠</span></summary>
            <pre>${escapeHtml(runtime.thinking.slice(-3000))}</pre>
          </details>
        ` : ''}
        ${runtime.pendingPermissions.slice(-4).map(item => `
          <div class="permission-card ${escapeHtml(item.risk)}">
            <div><strong>${escapeHtml(item.kind)}</strong><span>${escapeHtml(item.risk)}</span></div>
            <p>${escapeHtml(item.reason)}</p>
            <small>${escapeHtml(item.target)}</small>
            <div class="permission-actions">
              <button data-agent-approve="${escapeHtml(item.id)}" data-agent-decision="once">允许一次</button>
              <button data-agent-deny="${escapeHtml(item.id)}">拒绝</button>
            </div>
          </div>
        `).join('')}
        ${runtime.patchPreviews.slice(-2).map(item => `
          <details class="patch-preview">
            <summary>Patch 预览 · ${escapeHtml(this.patchSummary(item.patch))}</summary>
            <pre>${escapeHtml(item.patch.slice(0, 12000))}</pre>
            <button class="primary-button" data-apply-patch="${escapeHtml(`patch:${item.id}`)}">应用 patch</button>
          </details>
        `).join('')}
      </article>
    `
  }

  private extractAgentTodos(calls: ToolCallRecord[]) {
    const todo = [...calls].reverse().find(call => call.name === 'todowrite')
    const source = (todo?.output as any)?.items ?? (todo?.input as any)?.items
    if (!Array.isArray(source)) return []
    return source.map((item: any) => {
      if (typeof item === 'string') return { text: item, done: false }
      return {
        text: String(item?.text || item?.content || item?.title || item?.task || ''),
        done: Boolean(item?.done || item?.completed || item?.status === 'done' || item?.status === 'completed'),
      }
    }).filter(item => item.text)
  }

  private renderAgentTodos(items: Array<{ text: string; done: boolean }>) {
    return `
      <section class="agent-todo-panel">
        <header><strong>Todo</strong><span>${items.filter(item => item.done).length}/${items.length}</span></header>
        <ol>
          ${items.slice(0, 8).map(item => `<li class="${item.done ? 'done' : ''}"><span></span>${escapeHtml(item.text)}</li>`).join('')}
        </ol>
      </section>
    `
  }

  private patchSummary(patch: string) {
    const plus = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).length
    const minus = patch.split('\n').filter(line => line.startsWith('-') && !line.startsWith('---')).length
    const files = new Set([...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1])).size || 1
    return `${files} 文件 · +${plus} / -${minus}`
  }

  private toolStatusLabel(status: ToolCallRecord['status']) {
    if (status === 'ok') return '完成'
    if (status === 'error') return '失败'
    if (status === 'approval_required') return '待确认'
    if (status === 'running') return '执行中'
    return '等待'
  }

  private toolNameLabel(name: string) {
    const labels: Record<string, string> = {
      list_files: '扫描目录',
      read_file: '读取文件',
      git_diff: '读取 Git diff',
      terminal_output: '读取终端输出',
      workspace_context: '整理项目上下文',
    }
    return labels[name] || name
  }

  private toolSummary(call: ToolCallRecord) {
    if (call.error) return call.error
    const input = call.input as any
    const output = call.output as any
    if (call.name === 'bash') return String(output?.command || input?.command || input?.cmd || '工作区命令')
    if (call.name === 'grep') return `${output?.count ?? '-'} 个匹配 · ${input?.query || input?.pattern || ''}`
    if (call.name === 'glob' || call.name === 'list_files') return `${output?.count ?? '-'} 项 · ${output?.path || input?.path || 'workspace'}`
    if (typeof output === 'string') return output.slice(0, 140)
    if (output?.path) return output.path
    if (output?.summary) return output.summary
    if (output?.count !== undefined) return `${output.count} 项`
    if (input?.path) return input.path
    return ''
  }

  private renderToolDetail(call: ToolCallRecord) {
    const input = call.input as any
    const output = call.output as any
    if (call.error) {
      return `<pre class="tool-output error">${escapeHtml(call.error)}</pre>`
    }
    if (call.name === 'bash') {
      const command = String(output?.command || input?.command || input?.cmd || '')
      const cwd = String(output?.cwd || input?.cwd || this.currentRoot())
      const exitCode = output?.exitCode ?? output?.exit_code ?? ''
      return `
        <div class="tool-kv"><span>cwd</span><code>${escapeHtml(cwd)}</code></div>
        <div class="tool-kv"><span>command</span><code>${escapeHtml(command)}</code></div>
        ${exitCode !== '' ? `<div class="tool-kv"><span>exit</span><code>${escapeHtml(String(exitCode))}</code></div>` : ''}
        <pre class="tool-output">${escapeHtml(String(output?.output || output?.stdout || '').slice(0, 12000) || '命令尚未返回输出。')}</pre>
      `
    }
    if (call.name === 'read_file') {
      const content = String(output?.content || '')
      return `
        <div class="tool-kv"><span>file</span><code>${escapeHtml(String(output?.path || input?.path || ''))}</code></div>
        ${content ? `<pre class="tool-output code">${escapeHtml(content.slice(0, 12000))}</pre>` : `<pre class="tool-output">${escapeHtml(this.safeJsonPreview(output || input, 4000))}</pre>`}
      `
    }
    if (call.name === 'grep') {
      const results = Array.isArray(output?.results) ? output.results : []
      return `
        <div class="tool-kv"><span>query</span><code>${escapeHtml(String(output?.query || input?.query || input?.pattern || ''))}</code></div>
        <div class="tool-result-list">
          ${results.slice(0, 20).map((item: any) => `
            <button data-open-path="${escapeHtml(String(item.path || ''))}">
              <strong>${escapeHtml(String(item.path || ''))}${item.line ? `:${escapeHtml(String(item.line))}` : ''}</strong>
              <span>${escapeHtml(String(item.preview || item.name || ''))}</span>
            </button>
          `).join('') || '<small>没有匹配结果。</small>'}
        </div>
      `
    }
    if (call.name === 'glob' || call.name === 'list_files') {
      const entries = Array.isArray(output?.entries) ? output.entries : []
      return `<pre class="tool-output">${escapeHtml(entries.slice(0, 160).join('\n') || this.safeJsonPreview(output || input, 8000))}</pre>`
    }
    if (call.name === 'git_diff') {
      return `<pre class="tool-output diff">${escapeHtml(String(output?.diff || this.safeJsonPreview(output || input, 10000)).slice(0, 12000))}</pre>`
    }
    if (call.name === 'todowrite') {
      const todos = this.extractAgentTodos([call])
      return todos.length ? this.renderAgentTodos(todos) : `<pre class="tool-output">${escapeHtml(this.safeJsonPreview(output || input, 4000))}</pre>`
    }
    if (call.name === 'apply_patch' || call.name === 'write') {
      return `<pre class="tool-output diff">${escapeHtml(String(input?.patch || input?.diff || output?.message || this.safeJsonPreview(output || input, 12000)).slice(0, 12000))}</pre>`
    }
    return `<pre class="tool-output">${escapeHtml(this.safeJsonPreview(output || input, 8000))}</pre>`
  }

  private safeJsonPreview(value: unknown, max = 8000) {
    try {
      return JSON.stringify(value ?? {}, null, 2).slice(0, max)
    } catch {
      return String(value ?? '').slice(0, max)
    }
  }

  private renderChatMessageContent(message: AppState['chat'][number]) {
    const messageId = message.id
    const text = message.text
    const raw = String(text || '')
    const parts = raw.split(/```([^\n`]*)\n([\s\S]*?)```/g)
    let codeIndex = 0
    const body = raw.trim() ? parts.map((part, index) => {
      if (index % 3 === 1) return ''
      if (index % 3 === 2) {
        const lang = parts[index - 1]?.trim() || 'text'
        const code = part
        const id = `${messageId}:${codeIndex++}`
        const isDiff = lang.toLowerCase().includes('diff') || code.includes('\n+++ ') || code.includes('\n--- ')
        return `
          <figure class="chat-code-block ${isDiff ? 'diff' : ''}">
            <figcaption><span>${escapeHtml(lang)}</span><button data-copy-code="${escapeHtml(id)}">复制</button>${isDiff ? `<button data-apply-patch="${escapeHtml(id)}">应用 patch</button>` : ''}</figcaption>
            <pre><code>${escapeHtml(code)}</code></pre>
          </figure>
        `
      }
      return `<div class="chat-markdown">${this.renderInlineMarkdown(part)}</div>`
    }).join('') : ''
    const tools = message.role === 'assistant' && message.toolCalls?.length
      ? this.renderMessageToolCalls(message.toolCalls)
      : ''
    return `${tools}${body}`
  }

  private renderMessageToolCalls(calls: ToolCallRecord[]) {
    const unique = calls.filter((call, index, list) => list.findIndex(item => item.id === call.id) === index)
    const running = unique.some(call => call.status === 'running')
    const approval = unique.some(call => call.status === 'approval_required')
    const failed = unique.filter(call => call.status === 'error').length
    const title = running ? '正在调用工具' : approval ? '等待工具授权' : '本轮工具调用'
    const detail = `${unique.length} 个工具${failed ? ` · ${failed} 个失败` : ''}`
    return `
      <section class="message-tools ${running ? 'running' : ''}">
        <header><strong>${title}</strong><span>${detail}</span></header>
        ${this.renderToolTrace(unique)}
      </section>
    `
  }

  private renderInlineMarkdown(text: string) {
    return escapeHtml(text)
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h4>$1</h4>')
      .replace(/^# (.*)$/gm, '<h4>$1</h4>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br />')
  }

  private findChatCode(ref: string) {
    const [messageId, rawIndex] = ref.split(':')
    const message = this.state.chat.find(item => item.id === messageId)
    if (!message) return ''
    const blocks = [...message.text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map(match => match[1])
    return blocks[Number(rawIndex)] || ''
  }

  private async copyChatCode(ref: string) {
    const code = this.findChatCode(ref)
    if (!code) return this.toast('没有可复制的代码块', 'idle')
    await navigator.clipboard.writeText(code)
    this.toast('代码块已复制', 'ok')
  }

  private async applyChatPatch(ref: string) {
    const patch = ref.startsWith('patch:')
      ? this.state.agentRuntime.patchPreviews.find(item => item.id === ref.slice('patch:'.length))?.patch || ''
      : this.findChatCode(ref)
    if (!patch) return this.toast('没有可应用的 patch', 'idle')
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    if (!window.confirm('应用 AI 生成的 patch？应用前请确认 diff 内容和目标文件。')) return
    try {
      const result = await invoke<any>('ide_agent_apply_patch', {
        rootPath: this.currentRoot(),
        patch,
        approvals: [{ kind: 'write', granted: true, at: new Date().toISOString() }],
      })
      this.toast(result?.message || 'Patch 已提交给本地 agent 应用', 'ok')
      await this.refreshWorkspace(true)
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async answerAgentPermission(permissionId: string, granted: boolean) {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    try {
      this.markRequest('busy', granted ? 'Agent 正在继续执行' : 'Agent 正在处理拒绝结果', permissionId)
      await this.api.agentApprove(sessionId, permissionId, granted)
      this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== permissionId)
      this.toast(granted ? '已允许本次 Agent 操作' : '已拒绝本次 Agent 操作', granted ? 'ok' : 'idle')
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.markRequest('error', 'Agent 审批失败', String(error))
      this.toast(String(error), 'error')
    }
  }

  private renderComposer() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-composer-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.composerMode === this.state.composerMode)
    })
    const body = this.$('#composer-body')
    if (!body) return
    const attachments = this.state.attachments.length
      ? `<div class="attachment-list">${this.state.attachments.map((item, index) => `
        <article class="attachment-card">
          ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="" />` : '<div class="attachment-icon">FILE</div>'}
          <div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.mime || item.kind)}${item.size ? ` · ${bytesLabel(item.size)}` : ''}</span></div>
          <button class="icon-button" data-remove-attachment="${index}" title="移除附件">×</button>
        </article>
      `).join('')}</div>`
      : ''
    const controls = this.renderComposerControls()
    if (this.state.composerMode === 'text') {
      body.innerHTML = `${controls}<textarea id="task-prompt" placeholder="输入新指令，可粘贴图片。Enter 发送，Ctrl+Enter 换行..." spellcheck="false"></textarea>${attachments}`
    } else if (this.state.composerMode === 'image') {
      body.innerHTML = `${controls}<div class="mode-panel attachment-drop"><strong>图片上下文</strong><p>可选择图片，也可以直接在文本输入框粘贴截图。</p><button class="secondary-button" id="pick-image-attachments">选择图片</button></div>${attachments}`
    } else if (this.state.composerMode === 'file') {
      body.innerHTML = `${controls}<div class="mode-panel attachment-drop"><strong>文件上下文</strong><p>添加需求文档、日志、配置或参考文件。</p><button class="secondary-button" id="pick-file-attachments">选择文件</button></div>${attachments}`
    } else {
      const recording = Boolean(this.voiceSessionId || this.browserSpeech || this.state.voice.recording)
      body.innerHTML = `${controls}<div class="mode-panel attachment-drop"><strong>语音转文字</strong><p>${recording ? '正在识别，停止后会自动把文字填入输入框。' : '优先使用 Edge Web Speech；不可用时保留录音附件，可选配置云端转写模型。'}</p><div class="voice-live" id="voice-live-text">${escapeHtml(this.state.voice.lastText || (recording ? '正在听...' : ''))}</div><button class="secondary-button" id="pick-audio-attachment">添加音频文件</button><button class="${recording ? 'primary-button' : 'secondary-button'}" id="${recording ? 'stop-voice' : 'start-voice'}">${recording ? '停止并填入文字' : '开始语音输入'}</button>${this.state.voice.transcribing ? '<span class="voice-state">正在转文字...</span>' : ''}${this.state.voice.error ? `<small class="error-text">${escapeHtml(this.state.voice.error)}</small>` : ''}</div>${attachments}`
    }
    this.syncComposerDraftToDom()
  }

  private renderComposerControls() {
    return ''
  }

  private reasoningLabel(mode: string) {
    const labels: Record<string, string> = {
      off: '思考关',
      auto: '思考自动',
      low: '思考低',
      medium: '思考中',
      high: '思考高',
      xhigh: '思考极高',
    }
    return labels[mode] || mode
  }

  private syncComposerDraftToDom() {
    const prompt = this.$<HTMLTextAreaElement>('#task-prompt')
    if (prompt && document.activeElement !== prompt) prompt.value = this.composerDraft
  }

  private async startVoiceInput() {
    if (this.startBrowserSpeechInput()) return
    await this.startDesktopVoiceRecording()
  }

  private startBrowserSpeechInput() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) return false
    try {
      const recognition = new SpeechRecognition()
      this.browserSpeech = recognition
      this.browserSpeechText = ''
      recognition.lang = 'zh-CN'
      recognition.continuous = true
      recognition.interimResults = true
      recognition.maxAlternatives = 1
      recognition.onresult = (event: any) => {
        let interim = ''
        for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
          const text = String(event.results[index]?.[0]?.transcript || '')
          if (event.results[index]?.isFinal) this.browserSpeechText += text
          else interim += text
        }
        this.state.voice.lastText = `${this.browserSpeechText}${interim}`.trim()
        this.updateVoiceLiveText()
      }
      recognition.onerror = (event: any) => {
        const detail = String(event?.error || 'unknown')
        this.state.voice.error = `Edge Web Speech 识别失败：${detail}`
        this.state.voice.recording = false
        this.browserSpeech = null
        this.toast(this.state.voice.error, 'error')
        this.renderComposer()
      }
      recognition.onend = () => {
        const text = this.browserSpeechText.trim()
        this.browserSpeech = null
        this.state.voice.recording = false
        if (text) {
          this.insertComposer(text)
          this.state.composerMode = 'text'
          this.toast('语音已转文字', 'ok')
        } else if (!this.state.voice.error) {
          this.state.voice.error = '没有识别到语音文字。'
          this.toast(this.state.voice.error, 'idle')
        }
        this.renderComposer()
        this.scheduleSessionPersist()
      }
      this.state.voice.error = ''
      this.state.voice.recording = true
      this.state.voice.transcribing = false
      this.state.voice.lastText = ''
      recognition.start()
      this.renderComposer()
      this.toast('正在使用 Edge Web Speech 识别语音', 'busy')
      return true
    } catch (error) {
      this.browserSpeech = null
      this.state.voice.error = `Edge Web Speech 不可用：${String(error)}`
      return false
    }
  }

  private updateVoiceLiveText() {
    const live = this.$('#voice-live-text')
    if (live) live.textContent = this.state.voice.lastText || '正在听...'
  }

  private async startDesktopVoiceRecording() {
    try {
      const status = await invoke<any>('ide_voice_record_start')
      if (status?.sessionId) {
        this.voiceSessionId = status.sessionId
        this.state.voice.recording = true
        this.renderComposer()
      }
      this.toast(status?.message || '桌面录音状态已返回', status?.supported ? 'ok' : 'idle')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async stopVoiceInput() {
    if (this.browserSpeech) {
      try {
        this.browserSpeech.stop()
      } catch {
        this.browserSpeech = null
        this.state.voice.recording = false
        this.renderComposer()
      }
      return
    }
    if (!this.voiceSessionId) return
    const sessionId = this.voiceSessionId
    this.voiceSessionId = ''
    this.state.voice.recording = false
    try {
      const item = await invoke<any>('ide_voice_record_stop', { sessionId })
      this.state.attachments.push({
        kind: 'file',
        name: item.name || 'voice.wav',
        path: item.path,
        size: item.size,
        mime: item.mime || 'audio/wav',
      })
      this.state.voice.transcribing = true
      this.state.voice.error = ''
      this.renderComposer()
      try {
        if (this.state.settings.transcription_model?.trim()) {
          const result = await this.api.transcribeAudio(item.path, this.state.settings.transcription_model)
          if (result?.text) {
            this.state.voice.lastText = result.text
            this.insertComposer(result.text)
            this.toast(`语音已转文字：${result.model || result.provider || 'ASR'}`, 'ok')
          } else {
            throw new Error(result?.message || 'Provider 未返回转写文本')
          }
        } else {
          this.state.voice.error = 'Edge Web Speech 不可用，且未配置云端转写模型，已保留音频附件。'
          this.toast(this.state.voice.error, 'idle')
        }
      } catch (error) {
        const detail = String(error)
        this.state.voice.error = `${detail}；已保留音频附件。`
        this.toast(`语音转文字失败：${detail}`, 'error')
      } finally {
        this.state.voice.transcribing = false
      }
      this.toast(item.message || '录音已保存', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    } finally {
      this.renderComposer()
    }
  }

  private renderCommandList() {
    const list = this.$('#command-list')
    if (!list) return
    const raw = this.commandFilter.trim()
    const query = raw.replace(/^>/, '').toLowerCase()
    const files = flattenEntries(this.state.workspace.tree)
      .filter(item => item.kind === 'file' && (!query || item.path.toLowerCase().includes(query)))
      .slice(0, 80)
    const commands = [
      ['open-project', '打开项目', '选择本地项目目录'],
      ['save', '保存当前文件', 'Ctrl+S'],
      ['task', '新建 AutoCode 任务', '打开右侧 AI 输入框'],
      ['build', '运行构建', 'npm run build'],
      ['test', '运行测试', 'npm test'],
      ['git', '查看 Git 状态', '打开底部 Git 面板'],
      ['settings', '打开设置', '配置 API URL 和 Key'],
    ].filter(([, title, meta]) => !query || `${title} ${meta}`.toLowerCase().includes(query))
    list.innerHTML = `
      ${commands.map(([id, title, meta]) => `<button data-command-action="${id}"><span>${title}</span><small>${meta}</small></button>`).join('')}
      ${files.map(file => `<button data-open-path="${escapeHtml(file.path)}"><span>${escapeHtml(file.path)}</span><small>打开文件</small></button>`).join('')}
    `
  }

  private showContextMenu(x: number, y: number) {
    const menu = this.$('#context-menu')
    if (!menu) return
    menu.innerHTML = `<button id="new-file">新建文件</button><button id="new-folder">新建文件夹</button><button id="rename-entry">重命名</button><button id="delete-entry">删除</button><button id="copy-relative-path">复制相对路径</button><button id="copy-absolute-path">复制绝对路径</button><button id="copy-file-name">复制文件名</button><button id="copy-parent-path">复制所在目录</button>`
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    menu.removeAttribute('hidden')
  }

  private showTabContextMenu(x: number, y: number, path: string) {
    const menu = this.$('#context-menu')
    if (!menu || !path) return
    menu.innerHTML = `
      <button data-editor-copy-path="relative">复制相对路径</button>
      <button data-editor-copy-path="absolute">复制绝对路径</button>
      <button data-editor-copy-path="name">复制文件名</button>
      <button data-editor-copy-path="parent">复制所在目录</button>
      <button data-close-tab="${escapeHtml(path)}">关闭</button>
      <button data-close-other-tabs="${escapeHtml(path)}">关闭其他</button>
    `
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`
    menu.removeAttribute('hidden')
  }

  private hideContextMenu() {
    this.$('#context-menu')?.setAttribute('hidden', '')
  }

  private fillSettings() {
    const set = (selector: string, value: string) => {
      const input = this.$<HTMLInputElement>(selector)
      if (input && document.activeElement !== input) input.value = value || ''
    }
    set('#api-base-url', this.state.settings.api_base_url)
    set('#api-key', this.state.settings.api_key)
    const setSelect = (selector: string, value: string) => {
      const input = this.$<HTMLSelectElement>(selector)
      if (input && document.activeElement !== input) input.value = value || ''
    }
    setSelect('#connection-mode', this.state.settings.connection_mode || 'aiProvider')
    setSelect('#provider-type', this.state.settings.provider_type || 'openai-responses')
    set('#provider-model', this.state.settings.model)
    set('#transcription-model', this.state.settings.transcription_model || '')
    setSelect('#reasoning-mode', this.state.settings.reasoning_mode || 'auto')
    set('#reasoning-effort', this.state.settings.reasoning_effort || 'medium')
    set('#reasoning-budget', String(this.state.settings.reasoning_budget_tokens || 8192))
    set('#settings-temperature', String(this.aiTemperature))
    set('#settings-context-budget', String(this.aiContextBudget))
    set('#settings-system-prompt', this.aiSystemPrompt)
    setSelect('#default-shell', this.state.settings.default_shell || 'auto')
    setSelect('#theme-select', this.state.theme)
    set('#default-workspace-path', this.state.settings.default_workspace_path)
    set('#settings-preview-url', this.state.settings.preview_url)
    set('#preview-url', this.state.previewUrl || this.state.settings.preview_url)
  }

  private upsertRecent(project: RecentProject) {
    this.state.settings.recent_projects = [project, ...this.state.settings.recent_projects.filter(item => item.path !== project.path)].slice(0, 24)
    this.state.settings.last_workspace_path = project.path
    this.state.settings.default_workspace_path = project.path || this.state.settings.default_workspace_path
    void this.persistSettingsFromState()
  }

  private updateEditorCompletions() {
    const paths = flattenEntries(this.state.workspace.tree).map(item => item.path)
    const symbols = this.activeTab()?.draft.match(/[A-Za-z_$][\w$]{2,}/g) || []
    this.editor.setCompletionWords([...paths, ...symbols])
  }

  private async requestInlineCompletion(context: AiCompletionContext) {
    if (!this.currentRoot()) return ''
    if (!this.state.settings.api_base_url.trim()) return ''
    if (this.state.settings.connection_mode === 'webConnector' || this.state.settings.connection_mode === 'autocodePlatform') return ''
    const prompt = [
      '你是 AutoCode IDE 的内联代码补全引擎。',
      '只返回应该插入到光标位置的代码，不要解释，不要 Markdown，不要代码围栏。',
      `文件：${context.path}`,
      `语言：${context.language}`,
      '',
      '<光标前>',
      context.prefix,
      '</光标前>',
      '<光标后>',
      context.suffix,
      '</光标后>',
      '',
      `当前行前缀：${context.linePrefix}`,
    ].join('\n')
    const response = await this.api.providerRequest({
      messages: [
        { role: 'system', content: 'Return only inline code completion text. No prose.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      maxTokens: 160,
    })
    return this.cleanInlineCompletion(String(response.answer || ''), context)
  }

  private cleanInlineCompletion(answer: string, context: AiCompletionContext) {
    let text = answer
      .replace(/^```[a-zA-Z0-9_-]*\s*/, '')
      .replace(/```$/, '')
      .replace(/^\s*复制\s*/i, '')
    if (text.startsWith(context.linePrefix)) text = text.slice(context.linePrefix.length)
    const lines = text.split(/\r?\n/)
    if (lines.length > 12) text = lines.slice(0, 12).join('\n')
    return text
  }

  private focusComposer() {
    this.state.composerMode = 'text'
    this.renderComposer()
    this.$<HTMLTextAreaElement>('#task-prompt')?.focus()
  }

  private addContextChip(kind: 'file' | 'selection' | 'terminal' | 'git') {
    const tab = this.activeTab()
    const selected = this.editor.selectionText()
    let label = ''
    let value = ''
    if (kind === 'file') {
      if (!tab) return this.toast('请先打开一个文件', 'idle')
      label = `当前文件 ${tab.path}`
      value = `@当前文件 ${tab.path}\n${tab.draft.slice(0, 12000)}`
    } else if (kind === 'selection') {
      if (!selected) return this.toast('请先在编辑器中选择代码', 'idle')
      label = `选区 ${tab?.path || ''}`
      value = `@选区 ${tab?.path || ''}\n${selected.slice(0, 8000)}`
    } else if (kind === 'terminal') {
      if (!this.terminalOutputBuffer.trim()) return this.toast('终端还没有可引用输出', 'idle')
      label = '终端输出'
      value = `@终端输出\n${this.terminalOutputBuffer.slice(-8000)}`
    } else {
      const diff = this.$<HTMLPreElement>('#git-diff')?.textContent || ''
      if (!diff.trim()) return this.toast('当前没有可引用的 Git diff', 'idle')
      label = 'Git diff'
      value = `@Git diff\n${diff.slice(0, 12000)}`
    }
    this.state.contextChips = this.state.contextChips.filter(chip => chip.kind !== kind)
    this.state.contextChips.push({ id: `${kind}-${Date.now()}`, label, value, kind })
    this.insertComposer(value)
    this.renderAssistant()
  }

  private insertComposer(text: string) {
    this.state.composerMode = 'text'
    this.renderComposer()
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (!input) return
    input.value = input.value ? `${input.value}\n${text}` : text
    this.composerDraft = input.value
    input.focus()
    this.scheduleSessionPersist()
  }

  private insertTextAtComposerCursor(text: string) {
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (!input) {
      this.composerDraft = `${this.composerDraft}${text}`
      return
    }
    const start = input.selectionStart ?? input.value.length
    const end = input.selectionEnd ?? input.value.length
    input.value = `${input.value.slice(0, start)}${text}${input.value.slice(end)}`
    const cursor = start + text.length
    input.selectionStart = cursor
    input.selectionEnd = cursor
    this.composerDraft = input.value
    this.scheduleSessionPersist()
  }

  private prepareAiPrompt(text: string) {
    this.insertComposer(`${text}\n${this.currentFileContext()}`)
  }

  private currentFileContext() {
    const tab = this.activeTab()
    return tab ? `当前文件：${tab.path}` : '当前未打开文件，请先根据项目结构定位需要修改的文件。'
  }

  private attachmentContextRefs() {
    return this.state.attachments.map((item, index) => {
      const lines = [
        `name=${item.name}`,
        `kind=${item.kind}`,
        `mime=${item.mime || ''}`,
        `size=${item.size || 0}`,
        item.path ? `path=${item.path}` : '',
        item.text ? `text:\n${item.text.slice(0, 16000)}` : '',
        item.preview?.startsWith('data:') ? `image_data_url=${item.preview.slice(0, 120000)}` : item.preview ? `preview=${item.preview}` : '',
      ].filter(Boolean)
      return {
        id: `attachment-${Date.now()}-${index}`,
        kind: item.kind === 'image' ? 'file' : 'workspace',
        label: `附件 ${item.name}`,
        value: `@附件\n${lines.join('\n')}`,
      }
    })
  }

  private absolutePath(path: string) {
    if (!path) return ''
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.startsWith('/')) return path
    return `${this.currentRoot().replace(/[\\/]+$/, '')}\\${path.replaceAll('/', '\\')}`
  }

  private showEditorPathMenu(anchor: HTMLElement) {
    const tab = this.activeTab()
    if (!tab) return this.toast('请先打开文件', 'idle')
    const menu = this.$('#context-menu')
    if (!menu) return
    menu.innerHTML = `
      <button data-editor-copy-path="relative">复制相对路径</button>
      <button data-editor-copy-path="absolute">复制绝对路径</button>
      <button data-editor-copy-path="name">复制文件名</button>
      <button data-editor-copy-path="parent">复制所在目录</button>
    `
    const rect = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, rect.left)}px`
    menu.style.top = `${rect.bottom + 6}px`
    menu.removeAttribute('hidden')
  }

  private async copyEditorPath(kind: 'relative' | 'absolute' | 'name' | 'parent' = 'relative') {
    const tab = this.activeTab()
    if (!tab) return this.toast('请先打开文件', 'idle')
    const absolute = this.absolutePath(tab.path)
    const value = kind === 'absolute'
      ? absolute
      : kind === 'name'
        ? basename(tab.path)
        : kind === 'parent'
          ? absolute.replace(/[\\/][^\\/]*$/, '')
          : tab.path
    await navigator.clipboard.writeText(value)
    this.hideContextMenu()
    this.toast('编辑器文件路径已复制', 'ok')
  }

  private async copyActivePath(kind: 'relative' | 'absolute' | 'name' | 'parent' = 'relative') {
    const path = this.selectedWorkspacePath()
    if (!path) return this.toast('请先在资源管理器中选择文件或目录', 'idle')
    const absolute = this.absolutePath(path)
    const value = kind === 'absolute'
      ? absolute
      : kind === 'name'
        ? basename(path)
        : kind === 'parent'
          ? absolute.replace(/[\\/][^\\/]*$/, '')
          : path
    await navigator.clipboard.writeText(value)
    this.toast('路径已复制', 'ok')
  }

  private toast(message: string, state: AppState['apiState']) {
    this.state.apiMessage = message
    this.state.apiState = state
    const dot = this.$('.status-dot')
    if (dot) dot.className = `status-dot ${state}`
    this.text('#api-status', state === 'ok' ? '正常' : state === 'error' ? '异常' : state === 'busy' ? '请求中' : '待配置')
  }

  private text(selector: string, value: string) {
    const node = this.$(selector)
    if (node) node.textContent = value
  }

  private $<T extends Element = HTMLElement>(selector: string): T | null {
    return this.root.querySelector<T>(selector) || document.querySelector<T>(selector)
  }
}
