import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { AutoCodeApi } from './api'
import { CodeEditor, type AiCompletionContext } from './editor'
import { TerminalPanel } from './terminal'
import { createInitialState, loadSessionSnapshot, saveLayout, saveSessionSnapshot, saveTheme, type IdeSessionSnapshot } from './state'
import type {
  ActivityView,
  AgentEvent,
  AgentRuntimeState,
  AgentApprovedPlan,
  AgentPlanTodo,
  AppState,
  Attachment,
  ComposerMode,
  DockTab,
  EditorTab,
  IdeBootstrap,
  IdeSettings,
  MainRegion,
  OfflineSttDownloadProgress,
  PatchPreview,
  PermissionRequest,
  ProviderChannel,
  RecentProject,
  ToolCallRecord,
  WorkspaceEntry,
  WorkspaceFileIndex,
  WorkspaceFileIndexItem,
  WorkspaceFileSnapshot,
  WorkspaceFileStat,
  WorkspaceGitStatus,
  WorkspaceSearchResult,
} from './types'
import {
  basename,
  bytesLabel,
  compactPath,
  displayPath,
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
type UpdateProgressEvent = { event: 'progress' | 'finished'; chunkLength?: number; contentLength?: number; version?: string }
const mainRegionOrderDefault: MainRegion[] = ['side', 'workbench', 'assistant']
const mainRegionLabels: Record<MainRegion, string> = {
  side: '侧栏',
  workbench: '工作台',
  assistant: 'AI',
}
const mainLayoutPresets: Array<{ id: string; title: string; meta: string; order: MainRegion[] }> = [
  { id: 'default', title: '默认布局', meta: '侧栏 / 工作台 / AI', order: ['side', 'workbench', 'assistant'] },
  { id: 'assistant-left', title: 'AI 在左', meta: 'AI / 工作台 / 侧栏', order: ['assistant', 'workbench', 'side'] },
  { id: 'workbench-left', title: '工作台居左', meta: '工作台 / 侧栏 / AI', order: ['workbench', 'side', 'assistant'] },
  { id: 'assistant-center', title: 'AI 居中', meta: '侧栏 / AI / 工作台', order: ['side', 'assistant', 'workbench'] },
  { id: 'side-center', title: '侧栏居中', meta: 'AI / 侧栏 / 工作台', order: ['assistant', 'side', 'workbench'] },
  { id: 'workbench-assistant-side', title: '工作台 / AI / 侧栏', meta: '工作台 / AI / 侧栏', order: ['workbench', 'assistant', 'side'] },
]
type AgentProblemItem = {
  id: string
  source: string
  severity: 'error' | 'warning' | 'info'
  message: string
  path?: string
  line?: number
  character?: number
}
type WorkspaceFileReferenceRule = {
  raw: string
  normalized: string
  confidence: 'exact' | 'known-path' | 'unique-name' | 'ambiguous-name' | 'plausible-path'
  candidates?: WorkspaceFileReferenceCandidate[]
}
type WorkspaceFileReferenceIndex = {
  pathSet: Set<string>
  byName: Map<string, string[]>
  itemsByPath: Map<string, WorkspaceFileIndexItem>
}
type WorkspaceFileReferenceCandidate = {
  path: string
  name: string
  parent: string
  badge?: string
}
type RenderedChatBlock =
  | { kind: 'text'; content: string }
  | { kind: 'code'; content: string; language: string }
  | { kind: 'diagram'; content: string; diagramType: string }
  | { kind: 'autocode'; blockType: string; title: string; content: string }

type AppUpdateState = {
  checking: boolean
  installing: boolean
  available: boolean
  error: string
  message: string
  version: string
  currentVersion: string
  date: string
  body: string
  downloadedBytes: number
  totalBytes: number
}

export class AutoCodeIde {
  private readonly state: AppState = createInitialState()
  private readonly api = new AutoCodeApi(() => this.state.settings)
  private readonly editor = new CodeEditor()
  private readonly terminal = new TerminalPanel()
  private notifiedAgentKeys: string[] = []
  private readonly updateState: AppUpdateState = {
    checking: false,
    installing: false,
    available: false,
    error: '',
    message: '',
    version: '',
    currentVersion: '',
    date: '',
    body: '',
    downloadedBytes: 0,
    totalBytes: 0,
  }
  private externalPoll = 0
  private commandFilter = ''
  private voiceSessionId = ''
  private offlineSttProxyUrl = localStorage.getItem('autocode.ide.offlineSttProxyUrl') || ''
  private composerDraft = ''
  private composerOptimizeBusy = false
  private lastComposerPromptBeforeOptimize = ''
  private composerOptimizeUndoTimer = 0
  private composerSuggestions: Array<{ label: string; value: string; kind: 'file' | 'folder' | 'command' | 'mcp'; description: string }> = []
  private composerSuggestionIndex = 0
  private terminalLastOutputAt = 0
  private terminalOutputBuffer = ''
  private terminalPollTimer = 0
  private terminalProbeSnapshots = new Map<string, string>()
  private terminalLocalEcho = false
  private terminalCommandMode = false
  private terminalCommandCwd = ''
  private terminalCommandShell = 'cmd.exe'
  private terminalCommandLine = ''
  private terminalCommandCursor = 0
  private terminalCommandHistory: string[] = []
  private terminalCommandHistoryIndex = -1
  private agentConsoleExpanded = localStorage.getItem('autocode.ide.agentConsoleExpanded') === '1'
  private agentConsoleHeight = Number(localStorage.getItem('autocode.ide.agentConsoleHeight') || '0')
  private backendEventsBinding: Promise<void> | null = null
  private backendEventsBound = false
  private activeAssistantMessageId = ''
  private lastAssistantResponseText = ''
  private assistantTypingQueue = ''
  private assistantTypingTimer = 0
  private assistantTypingMessageId = ''
  private pendingToolProtocolBuffer = ''
  private sessionPersistTimer = 0
  private assistantRenderTimer = 0
  private assistantRenderFrame = 0
  private assistantRenderLastAt = 0
  private assistantStatusHtml = ''
  private assistantRuntimeHtml = ''
  private assistantThreadHtml = ''
  private pendingSessionSnapshot: IdeSessionSnapshot | null = null
  private aiCompletionTimer = 0
  private aiCompletionAbort = 0
  private inlineCompletion = ''
  private pendingAiFallbackTimer = 0
  private pendingAiRequest: { prompt: string; contextRefs: any[]; turnId: string; requestId?: string; queuedIds?: string[]; previousAssistantText?: string } | null = null
  private aiFallbackRunning = false
  private activeTurnStartedAt = 0
  private activeTurnToolIds: string[] = []
  private activeTurnPermissionIds: string[] = []
  private activeTurnPatchIds: string[] = []
  private activeTurnCheckpointIds: string[] = []
  private activeTurnReasoning = ''
  private staleAssistantPrefixBuffer = ''
  private requestTimelineTicker = 0
  private collapsedToolIds = new Set<string>()
  private openedToolIds = new Set<string>()
  private collapsedToolGroupIds = new Set<string>()
  private activeRenderFileReferenceIndex: WorkspaceFileReferenceIndex | null = null
  private fileReferenceIndexCache: { key: string; value: WorkspaceFileReferenceIndex } | null = null
  private workspaceFileIndexCache: { root: string; value: WorkspaceFileIndex; loadedAt: number } | null = null
  private workspaceFileIndexLoading = false
  private mermaidModule: any = null
  private mermaidLoading: Promise<any> | null = null
  private gitDiffFocusPath = ''
  private gitOperationMessage = ''
  private gitOperationState: 'idle' | 'busy' | 'ok' | 'error' = 'idle'
  private gitStatusRefreshing = false
  private gitRefreshInFlight: Promise<void> | null = null
  private gitLastRefreshAt = 0
  private browserSpeech: any = null
  private browserSpeechText = ''
  private agentEventSource: EventSource | null = null
  private agentEventReconnectTimer = 0
  private lastAgentEventId = 0
  private seenAgentEventIds: number[] = []
  private seenAgentEventKeys: string[] = []
  private completedAgentRequestIds: string[] = []
  private toolCompletionTimers: Record<string, number> = {}
  private toolCompletionSequence = 0
  private collapsedChannelIds = new Set<string>()
  private channelCollapseInitializedForOpen = false
  private visibleChannelKeyIds = new Set<string>()
  private editorSavePath = ''
  private editorSaveState: 'idle' | 'saving' | 'ok' | 'error' = 'idle'
  private editorSaveTimer = 0
  private aiTemperature = Number(localStorage.getItem('autocode.ide.ai.temperature') || '0.2')
  private aiSystemPrompt = localStorage.getItem('autocode.ide.ai.systemPrompt') || '你是 AutoCode 本地 IDE 内置的 AI 开发助手。请基于用户本地工作区上下文主动调用工具完成任务。最终回复优先使用 AutoCode Blocks 或清晰 Markdown：用简短摘要、优先级列表、文件清单、验证结果和后续建议分块表达；涉及文件必须尽量写相对路径；命令和代码必须放 fenced code block；涉及流程可以输出 ```mermaid 流程图。不要输出完整 html/head/body 文档，不要使用脚本、内联事件或外部样式。'
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
    await this.bindBackendEventsWithTimeout()
    await this.bootstrap()
    this.externalPoll = window.setInterval(() => void this.checkExternalChanges(), 5000)
  }

  private async bindBackendEventsWithTimeout() {
    if (!this.backendEventsBinding) {
      this.backendEventsBinding = this.bindBackendEvents()
    }
    let timedOut = false
    await Promise.race([
      this.backendEventsBinding,
      new Promise<void>(resolve => window.setTimeout(() => {
        timedOut = true
        resolve()
      }, 1800)),
    ]).catch(error => {
      this.toast(`后端事件监听初始化失败：${String(error)}`, 'error')
    })
    if (timedOut) {
      this.toast('后端事件监听初始化较慢，已先进入 IDE；事件流会在后台继续连接。', 'idle')
      void this.backendEventsBinding.catch(error => {
        this.toast(`后端事件监听连接失败：${String(error)}`, 'error')
      })
    }
  }

  private async bindBackendEvents() {
    if (this.backendEventsBound) return
    this.backendEventsBound = true
    await listen<RecentProject>('connector-open-project', event => void this.openWorkspace(event.payload))
    await listen<TerminalOutputEvent>('ide-pty-output', event => {
      const record = this.state.terminalSessions.find(item => item.id === event.payload.session_id)
      if (record) {
        record.lastOutput = `${record.lastOutput}${event.payload.data}`.slice(-20000)
        record.health = 'ready'
      }
      const previousProbeOutput = this.terminalProbeSnapshots.get(event.payload.session_id) || ''
      this.terminalProbeSnapshots.set(event.payload.session_id, `${previousProbeOutput}${event.payload.data}`.slice(-12000))
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
    await listen<TerminalExitEvent>('ide-pty-exit', event => {
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
    await listen<AgentEvent>('ide-agent-event', event => {
      this.handleAgentEvent(event.payload)
    })
    await listen<UpdateProgressEvent>('ide-update-progress', event => {
      this.handleUpdateProgress(event.payload)
    })
    await listen<OfflineSttDownloadProgress>('ide-offline-stt-download', event => {
      this.state.voice.offlineDownload = event.payload
      this.state.voice.offlineBusy = !['done', 'error', 'canceled'].includes(String(event.payload.phase))
      if (event.payload.phase === 'error') this.state.voice.error = event.payload.message || '离线模型下载失败'
      if (event.payload.phase === 'canceled') this.state.voice.error = ''
      this.renderComposer()
      this.scheduleSessionPersist()
    })
  }

  private async bootstrap() {
    try {
      const boot = await invoke<IdeBootstrap>('ide_bootstrap')
      this.state.version = boot.version
      this.state.settings = boot.settings
      this.ensureProviderChannels()
      this.state.previewUrl = boot.settings.preview_url
      const bootStartupProject = this.startupProjectFromSettings(boot.settings)
      const diskSnapshot = await this.api.loadSession(null).catch(() => null)
      this.pendingSessionSnapshot = this.normalizeSessionSnapshot(this.newerSessionSnapshot(diskSnapshot, loadSessionSnapshot()))
      if (this.pendingSessionSnapshot?.settings) {
        const bootSettings = this.state.settings
        const snapshotSettings = this.pendingSessionSnapshot.settings
        const snapshotProject = this.normalizeRecentProject(this.pendingSessionSnapshot.currentProject)
        const snapshotRecent = snapshotProject
          ? [snapshotProject, ...(snapshotSettings.recent_projects || [])]
          : snapshotSettings.recent_projects || []
        this.state.settings = {
          ...snapshotSettings,
          ...bootSettings,
          api_base_url: bootSettings.api_base_url || snapshotSettings.api_base_url || '',
          api_key: bootSettings.api_key || snapshotSettings.api_key || '',
          provider_type: bootSettings.provider_type || snapshotSettings.provider_type || 'openai-responses',
          api_protocol: bootSettings.api_protocol || snapshotSettings.api_protocol || '',
          model: bootSettings.model || snapshotSettings.model || '',
          connection_mode: bootSettings.connection_mode || snapshotSettings.connection_mode || 'aiProvider',
          default_shell: bootSettings.default_shell || snapshotSettings.default_shell || 'auto',
          last_workspace_path: displayPath(bootSettings.last_workspace_path || snapshotSettings.last_workspace_path || snapshotProject?.path || ''),
          default_workspace_path: displayPath(bootSettings.default_workspace_path || snapshotSettings.default_workspace_path || snapshotProject?.path || ''),
          recent_projects: bootSettings.recent_projects.length
            ? bootSettings.recent_projects.map(item => this.normalizeRecentProject(item)).filter(Boolean) as RecentProject[]
            : this.dedupeRecentProjects(snapshotRecent),
        }
        this.state.previewUrl = this.state.settings.preview_url || this.state.previewUrl
        this.ensureProviderChannels()
      }
      this.normalizeAppearanceSettings(this.state.settings)
      if (this.pendingSessionSnapshot?.theme) {
        this.state.theme = this.pendingSessionSnapshot.theme
        this.applyTheme()
      }
      if (typeof this.pendingSessionSnapshot?.aiTemperature === 'number') this.aiTemperature = this.pendingSessionSnapshot.aiTemperature
      if (typeof this.pendingSessionSnapshot?.aiContextBudget === 'number') this.aiContextBudget = this.pendingSessionSnapshot.aiContextBudget
      if (this.pendingSessionSnapshot?.aiSystemPrompt) this.aiSystemPrompt = this.pendingSessionSnapshot.aiSystemPrompt
      this.editor.setAiCompletionOptions({ debounceMs: this.state.settings.code_completion?.debounce_ms || 750 })
      const recent = bootStartupProject || this.resolveStartupProject()
      this.renderAll()
      void this.refreshLocalServerStatus().catch(error => {
        this.toast(`本地服务状态刷新失败：${String(error)}`, 'error')
      })
      void this.refreshAgentProfiles(false).catch(error => {
        this.toast(`Agent 配置刷新失败：${String(error)}`, 'error')
      })
      if (recent) this.scheduleStartupWorkspaceOpen(recent)
      else this.toast('AutoCode IDE 已就绪', 'ok')
      this.scheduleStartupUpdateCheck()
    } catch (error) {
      this.toast(String(error), 'error')
      this.renderAll()
    }
  }

  private scheduleStartupWorkspaceOpen(project: RecentProject) {
    const safeProject = this.normalizeRecentProject(project)
    if (!safeProject) return
    window.setTimeout(() => {
      void this.openStartupWorkspaceSafely(safeProject)
    }, 120)
  }

  private async openStartupWorkspaceSafely(project: RecentProject) {
    try {
      await this.openWorkspace(project, false)
      this.toast(`已恢复上次工作区：${project.name || project.path}`, 'ok')
    } catch (error) {
      console.error('[AutoCode] startup workspace restore failed', error)
      this.pendingSessionSnapshot = null
      this.state.workspace.currentProject = null
      this.state.workspace.tree = []
      this.state.workspace.tabs = []
      this.state.workspace.activePath = ''
      this.state.workspace.selectedPath = ''
      this.state.settings.last_workspace_path = ''
      this.renderAll()
      this.toast(`上次工作区自动恢复失败，已进入安全启动模式：${String(error)}`, 'error')
    }
  }

  private newerSessionSnapshot(left: IdeSessionSnapshot | null, right: IdeSessionSnapshot | null) {
    if (!left) return right
    if (!right) return left
    return Date.parse(left.savedAt || '') >= Date.parse(right.savedAt || '') ? left : right
  }

  private normalizeSessionSnapshot(snapshot: IdeSessionSnapshot | null) {
    if (!snapshot) return null
    const currentProject = this.normalizeRecentProject(snapshot.currentProject)
    const settings = snapshot.settings
      ? {
          ...snapshot.settings,
          last_workspace_path: displayPath(snapshot.settings.last_workspace_path || currentProject?.path || ''),
          default_workspace_path: displayPath(snapshot.settings.default_workspace_path || currentProject?.path || ''),
          recent_projects: this.dedupeRecentProjects([
            ...(currentProject ? [currentProject] : []),
            ...(snapshot.settings.recent_projects || []),
          ]),
        }
      : undefined
    return { ...snapshot, currentProject, settings }
  }

  private normalizeRecentProject(project: RecentProject | null | undefined): RecentProject | null {
    if (!project?.path) return null
    const path = displayPath(project.path)
    return {
      ...project,
      path,
      name: project.name || projectName(path),
    }
  }

  private dedupeRecentProjects(projects: Array<RecentProject | null | undefined>) {
    const seen = new Set<string>()
    const out: RecentProject[] = []
    for (const item of projects) {
      const project = this.normalizeRecentProject(item)
      if (!project?.path) continue
      const key = project.path.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(project)
    }
    return out.slice(0, 24)
  }

  private currentRoot() {
    return displayPath(this.state.workspace.currentProject?.path || this.state.settings.last_workspace_path || '')
  }

  private resolveStartupProject(): RecentProject | null {
    const snapshotProject = this.pendingSessionSnapshot?.currentProject || null
    if (snapshotProject?.path) return this.normalizeRecentProject(snapshotProject)
    const snapshotLastPath = this.pendingSessionSnapshot?.settings?.last_workspace_path || ''
    if (snapshotLastPath.trim()) {
      const path = displayPath(snapshotLastPath)
      return {
        path,
        name: projectName(path),
        preview_url: this.pendingSessionSnapshot?.settings?.preview_url || '',
      }
    }
    const recent = this.state.settings.recent_projects?.[0]
    if (recent?.path) return recent
    return this.projectFromLastPath()
  }

  private startupProjectFromSettings(settings: IdeSettings): RecentProject | null {
    const recent = settings.recent_projects?.find(item => item?.path?.trim())
    if (recent?.path) return this.normalizeRecentProject(recent)
    const path = settings.last_workspace_path || settings.default_workspace_path || ''
    if (!path.trim()) return null
    const normalizedPath = displayPath(path)
    return {
      path: normalizedPath,
      name: projectName(normalizedPath),
      task_id: '',
      preview_url: settings.preview_url || '',
      last_opened_at: new Date().toISOString(),
    }
  }

  private projectFromLastPath(): RecentProject | null {
    const path = this.state.settings.last_workspace_path || ''
    if (!path.trim()) return null
    const normalizedPath = displayPath(path)
    return {
      path: normalizedPath,
      name: projectName(normalizedPath),
      task_id: '',
      preview_url: this.state.settings.preview_url || '',
      last_opened_at: new Date().toISOString(),
    }
  }

  private activeTab() {
    return this.state.workspace.tabs.find(tab => tab.path === this.state.workspace.activePath) || null
  }

  private normalizeAppearanceSettings(settings = this.state.settings) {
    const clamp = (value: unknown, fallback: number, min: number, max: number) => {
      const numeric = Number(value)
      if (!Number.isFinite(numeric)) return fallback
      return Math.max(min, Math.min(max, Math.round(numeric)))
    }
    settings.ui_font_size = clamp(settings.ui_font_size, 14, 12, 20)
    settings.code_font_size = clamp(settings.code_font_size, 12, 10, 20)
    settings.ui_font_family = String(settings.ui_font_family || 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif').trim()
    settings.code_font_family = String(settings.code_font_family || '"Cascadia Code", Consolas, monospace').trim()
    settings.appearance_density = ['comfortable', 'compact'].includes(String(settings.appearance_density)) ? settings.appearance_density : 'comfortable'
    settings.ui_contrast = clamp(settings.ui_contrast, 100, 80, 120)
    settings.reduced_motion = ['system', 'on', 'off'].includes(String(settings.reduced_motion)) ? settings.reduced_motion : 'system'
    settings.desktop_notifications_enabled = settings.desktop_notifications_enabled !== false
    settings.desktop_notification_sound_enabled = settings.desktop_notification_sound_enabled !== false
    settings.notify_on_agent_waiting = settings.notify_on_agent_waiting !== false
    settings.notify_on_agent_done = settings.notify_on_agent_done !== false
    settings.notify_on_agent_failed = settings.notify_on_agent_failed !== false
    settings.auto_update_enabled = settings.auto_update_enabled !== false
    settings.update_manifest_url = String(settings.update_manifest_url || '').trim()
    settings.update_public_key = String(settings.update_public_key || '').trim()
    settings.update_check_on_startup = settings.update_check_on_startup !== false
    settings.update_check_interval_hours = clamp(settings.update_check_interval_hours, 12, 1, 168)
    settings.last_update_check_at = String(settings.last_update_check_at || '')
    settings.skipped_update_version = String(settings.skipped_update_version || '')
    return settings
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
    return this.isWindowsRuntime() ? 'auto' : ''
  }

  private selectedTerminalShell() {
    const shell = this.$<HTMLSelectElement>('#terminal-shell-select')?.value || this.defaultTerminalShellArg()
    if (!shell && !this.isWindowsRuntime()) return ''
    if (shell === 'auto') return 'auto'
    if (shell === 'powershell' || shell === 'powershell.exe') return 'powershell.exe'
    if (shell === 'pwsh' || shell === 'pwsh.exe') return 'pwsh.exe'
    return this.isWindowsRuntime() ? 'cmd.exe' : ''
  }

  private terminalShellSelectValue(shell: string) {
    const lower = String(shell || '').toLowerCase()
    if (!lower || lower === 'auto') return this.defaultTerminalShellArg()
    if (lower.includes('pwsh')) return 'pwsh.exe'
    if (lower.includes('powershell')) return 'powershell.exe'
    if (lower.includes('cmd')) return 'cmd.exe'
    return lower
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
          <button class="rail-action" data-activity="channels" title="渠道管理">◎</button>
          <button class="rail-action" data-activity="recent" title="最近项目">◷</button>
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
            <div class="git-side-content" id="git-side-content"></div>
          </section>

          <section class="side-view" data-side-view="skills">
            <div class="section-title"><span>技能商店</span><button class="text-button" id="load-skills">刷新</button></div>
            <input id="skill-query" placeholder="搜索技能" spellcheck="false" />
            <div class="skill-list" id="skill-list"></div>
          </section>

          <section class="side-view" data-side-view="channels">
            <div class="section-title"><span>渠道管理</span><button class="text-button" id="add-channel">新增渠道</button></div>
            <div class="channel-route-summary" id="channel-route-summary"></div>
            <div class="channel-list" id="channel-list"></div>
          </section>

          <section class="side-view" data-side-view="recent">
            <div class="section-title"><span>最近项目</span><small>点击切换工作区</small></div>
            <div class="recent-list" id="recent-list"></div>
          </section>
        </aside>

        <main class="workbench">
          <div class="pane-resizer right" data-resize="workbench"></div>
          <header class="topbar">
            <div class="crumb"><span class="status-dot"></span><strong id="context-project">未打开项目</strong><small id="context-path">等待选择工作区</small></div>
            <div class="topbar-actions">
              <span class="channel-routing-pill" title="系统会按优先级在支持当前模型的启用渠道间自动重试">多渠道自动路由</span>
              <select class="topbar-select model-select" id="workbench-model" title="从所有启用渠道汇总的模型"></select>
              <span class="account-pill" id="account-pill">余额未查询</span>
              <button class="secondary-button layout-menu-button" id="layout-menu" title="调整侧栏、工作台和 AI 助手的位置">布局</button>
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
              <div class="editor-git-strip" id="editor-git-strip" hidden></div>
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
                <option value="auto">Auto</option>
                <option value="powershell.exe">PowerShell</option>
                <option value="cmd.exe">cmd.exe</option>
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
            <div class="dock-panel" data-dock-panel="git"><div class="git-summary" id="git-summary">打开项目后显示 Git 状态。</div><div class="git-file-list" id="git-file-list"></div><pre class="git-diff" id="git-diff"></pre></div>
            <div class="dock-panel" data-dock-panel="problems"><div class="problem-list" id="problem-list"></div></div>
            <div class="dock-panel" data-dock-panel="skills"><div class="skill-list dock-skill-list" id="dock-skill-list"></div></div>
          </section>
        </main>

        <aside class="assistant-pane" id="assistant-pane">
          <div class="pane-resizer left" data-resize="assistant"></div>
          <header class="assistant-head"><div><strong>AI 开发助手</strong><span>AutoCode API · Local Runner</span></div><button class="icon-button" id="refresh-task">↻</button></header>
          <section class="assistant-state">
            <div class="assistant-status-compact">
              <div class="notice-card" id="task-status">暂无任务。输入需求后可创建 AutoCode 任务。</div>
              <div class="assistant-metrics"><span>API <b id="api-status">待配置</b></span><span>项目 <b id="project-status">未打开</b></span></div>
            </div>
            <div class="request-card" id="request-timeline" hidden></div>
            <details class="agent-console ${this.agentConsoleExpanded ? 'expanded' : ''} ${this.agentConsoleHeight ? 'manual-height' : ''}" id="agent-console" ${this.agentConsoleHeight ? `style="--agent-console-height:${this.agentConsoleHeight}px"` : ''}>
              <summary>
                <div>
                  <strong>智能体控制台</strong>
                  <span id="agent-console-summary">会话、工具、上下文和本地服务</span>
                </div>
                <span class="agent-console-summary-actions">
                  <button type="button" class="agent-console-size-toggle" data-agent-console-size="toggle">${this.agentConsoleExpanded ? '紧凑' : '舒展'}</button>
                  <em>展开</em>
                </span>
              </summary>
              <div class="agent-console-body" id="agent-runtime-panel"></div>
              <div class="agent-console-resizer" data-agent-console-resize title="拖拽调整智能体控制台高度"></div>
            </details>
          </section>
          <section class="assistant-thread" id="assistant-thread"></section>
          <section class="composer">
            <div class="composer-modes">
              <div class="composer-mode-tabs">
                <button class="active" data-composer-mode="text">文本</button>
                <button data-composer-mode="image">图片</button>
                <button data-composer-mode="voice">语音</button>
                <button data-composer-mode="file">文件</button>
              </div>
              <div class="composer-mode-actions" id="composer-mode-actions"></div>
            </div>
            <div class="composer-body" id="composer-body"></div>
            <div class="composer-toolbar">
              <button class="tool-chip" id="attach-file">当前文件</button>
              <button class="tool-chip composer-optimize-button" id="optimize-composer-prompt" title="优化输入内容，让需求更清晰精炼">优化</button>
              <span></span>
              <button class="secondary-button danger composer-cancel-button" id="cancel-agent-from-composer" hidden title="请求 Agent 收尾停止">停止</button>
              <button class="primary-button" id="create-task">发送</button>
            </div>
          </section>
        </aside>
      </div>

      <div class="settings-overlay" id="settings-overlay" hidden></div>
      <aside class="settings-drawer" id="settings-drawer" hidden>
        <header><div><strong>全局设置</strong><span>工作区、Agent、终端、语音与界面偏好</span></div><button class="icon-button" id="close-settings">×</button></header>
        <details class="settings-group">
          <summary>外观</summary>
          <label><span>主题</span><select id="theme-select"><option value="auto-dark">Auto Dark</option><option value="graphite">Graphite</option><option value="light">Light</option></select></label>
          <div class="settings-row">
            <label><span>UI 字号</span><input id="ui-font-size" type="number" min="12" max="20" step="1" /></label>
            <label><span>代码字号</span><input id="code-font-size" type="number" min="10" max="20" step="1" /></label>
          </div>
          <label><span>UI 字体</span><input id="ui-font-family" spellcheck="false" placeholder='Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif' /></label>
          <label><span>代码字体</span><input id="code-font-family" spellcheck="false" placeholder='"Cascadia Code", Consolas, monospace' /></label>
          <div class="settings-row">
            <label><span>对比度</span><input id="appearance-contrast" type="range" min="80" max="120" step="1" /></label>
            <label><span>减少动态效果</span><select id="reduced-motion"><option value="system">系统</option><option value="on">开启</option><option value="off">关闭</option></select></label>
          </div>
          <label><span>紧凑度</span><select id="appearance-density"><option value="comfortable">舒适</option><option value="compact">紧凑</option></select></label>
          <p class="settings-help">这一组只影响界面显示，不会改动项目文件。字体、字号和紧凑度会同步作用到编辑器、终端和聊天区。</p>
        </details>
        <details class="settings-group">
          <summary>通知与更新</summary>
          <label class="inline-check"><input id="desktop-notifications-enabled" type="checkbox" />启用 Windows 桌面通知</label>
          <label class="inline-check"><input id="desktop-notification-sound-enabled" type="checkbox" />播放通知声音</label>
          <div class="settings-row">
            <label class="inline-check"><input id="notify-agent-waiting" type="checkbox" />等待操作时通知</label>
            <label class="inline-check"><input id="notify-agent-done" type="checkbox" />任务完成时通知</label>
            <label class="inline-check"><input id="notify-agent-failed" type="checkbox" />失败/取消时通知</label>
          </div>
          <button class="secondary-button" id="test-desktop-notification">发送测试通知</button>
          <label class="inline-check"><input id="auto-update-enabled" type="checkbox" />启用自动更新检查</label>
          <div class="settings-row">
            <label class="inline-check"><input id="update-check-on-startup" type="checkbox" />启动时检查</label>
            <label><span>检查间隔（小时）</span><input id="update-check-interval" type="number" min="1" max="168" step="1" /></label>
          </div>
          <div class="update-settings-status" id="update-settings-status"></div>
          <div class="settings-row">
            <button class="secondary-button" id="check-app-update">检查更新</button>
            <button class="primary-button" id="install-app-update" hidden>立即安装</button>
          </div>
          <p class="settings-help">更新地址和签名公钥由安装包配置。用户只需要决定是否自动检查、何时检查以及是否安装新版本。</p>
        </details>
        <details class="settings-group">
          <summary>连接与渠道</summary>
          <label><span>连接模式</span><select id="connection-mode"><option value="aiProvider">本地 Provider</option><option value="autocodePlatform">AutoCode 平台</option></select></label>
          <p class="settings-help">Provider、API Key、模型启用与代码补全模型统一在左侧“渠道管理”中配置。</p>
        </details>
        <details class="settings-group">
          <summary>网页端互联</summary>
          <section class="autocode-project-card">
            <header>
              <div>
                <strong>muhuo.site AutoCode</strong>
                <span>网页端负责需求、计划、Todo、审批和结果展示；本地 IDE 负责真实文件、终端、Git 与本地验证。</span>
              </div>
              <button class="secondary-button" id="open-web-autocode">打开网页端</button>
            </header>
            <div class="autocode-file-grid">
              <div><b>绑定域名</b><code>https://muhuo.site</code><span>安装包内置更新与互联目标，用户不需要填写更新 JSON 地址或签名公钥。</span></div>
              <div><b>本地互联</b><code>local_ide</code><span>默认不上传完整本地项目代码，网页按需通过连接器读取必要文件。</span></div>
              <div><b>云端开发</b><code>cloud_workspace</code><span>网页端仍保留完整 Coding Agent、文件树、编辑器、终端和 Git 能力。</span></div>
            </div>
            <p>“网页连接器”不再作为模型 Provider 连接模式出现。需要互联时，请在网页端选择“连接本地 IDE 项目”，或从这里打开网页端。</p>
          </section>
        </details>
        <details class="settings-group">
          <summary>语音转写</summary>
          <label><span>云端转写模型（可选）</span><input id="transcription-model" spellcheck="false" placeholder="留空时优先使用本地离线 STT" /></label>
          <div class="settings-row">
            <label class="inline-check"><input id="offline-stt-enabled" type="checkbox" />启用 sherpa-onnx 离线转写</label>
            <select id="offline-stt-model"><option value="zh-streaming-small">中文小型离线模型</option><option value="zh-accurate">中文高精度离线模型</option></select>
          </div>
        </details>
        <details class="settings-group">
          <summary>模型与思考</summary>
          <label><span>思考模式</span><select id="reasoning-mode"><option value="auto">自动</option><option value="off">关闭</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">极高</option><option value="custom">自定义</option></select></label>
          <label><span>思考等级 / 自定义值</span><input id="reasoning-effort" spellcheck="false" placeholder="low / medium / high / xhigh" /></label>
          <label><span>思考预算 tokens</span><input id="reasoning-budget" type="number" min="1024" step="1024" /></label>
          <label><span>温度</span><input id="settings-temperature" type="number" min="0" max="2" step="0.1" /></label>
          <label><span>上下文预算</span><input id="settings-context-budget" type="number" min="2000" max="200000" step="1000" /></label>
          <label><span>系统提示词</span><textarea id="settings-system-prompt" spellcheck="false"></textarea></label>
        </details>
        <details class="settings-group">
          <summary>Agent 高级配置</summary>
          <section class="autocode-project-card">
            <header>
              <div>
                <strong>项目 .autocode 配置</strong>
                <span>打开项目时自动初始化；缺失文件可在这里补齐，已有文件不会被覆盖。</span>
              </div>
              <button class="secondary-button" id="init-autocode-project">初始化/修复</button>
            </header>
            <div class="autocode-file-grid">
              <div><b>规则</b><code>.autocode/AGENTS.md</code><span>项目约定、常用命令、危险区域，智能体每次理解项目都会读取。</span></div>
              <div><b>记忆</b><code>.autocode/memory.md</code><span>长期事实、用户偏好、决策记录；智能体更新时必须先给 diff 审批。</span></div>
              <div><b>项目配置</b><code>.autocode/settings.json</code><span>项目级 MCP 服务等配置；会和全局设置合并后进入工具注册表。</span></div>
            </div>
            <p>这三个文件属于当前项目，不是全局设置。全局 Provider、主题、默认终端仍保存在 IDE 设置里。</p>
          </section>
          <label><span>审批模式</span><select id="approval-mode"><option value="suggest">Suggest：读搜为主</option><option value="autoEdit">Auto Edit：写入需确认</option><option value="fullAuto">Full Auto：安全范围自动执行</option><option value="custom">Custom：使用策略 JSON</option></select></label>
          <label><span>权限策略 JSON</span><textarea id="permission-policy" spellcheck="false" placeholder='{"bash":{"decision":"ask"},"apply_patch":"ask"}'></textarea></label>
          <details class="settings-help-block">
            <summary>权限策略示例与规范</summary>
            <p>仅当审批模式选择 Custom 时，下面 JSON 会覆盖默认策略。支持 <code>allow</code> 自动执行、<code>ask</code> 执行前确认、<code>deny</code> 禁止执行。</p>
            <pre>{
  "*": "ask",
  "read_file": "allow",
  "grep": "allow",
  "glob": "allow",
  "git_diff": "allow",
  "bash": { "decision": "ask" },
  "apply_patch": "ask",
  "mcp_call": "ask"
}</pre>
          </details>
          <label><span>MCP 服务 JSON</span><textarea id="mcp-servers" spellcheck="false" placeholder='[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","D:/project"]}]'></textarea></label>
          <p class="settings-help">MCP 用来连接外部工具服务。配置后点击“刷新工具”，它会以“需确认”的 MCP 工具出现在工具注册表中。</p>
          <details class="settings-help-block">
            <summary>MCP 服务示例与字段要求</summary>
            <p><code>name</code> 是服务名；<code>command</code> 是启动命令；<code>args</code> 是参数数组；<code>enabled</code> 可禁用；<code>timeoutSecs</code> 是请求超时秒数。</p>
            <pre>[
  {
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/project"],
    "enabled": true,
    "timeoutSecs": 30
  }
]</pre>
          </details>
          <label><span>记忆文件</span><input id="memory-files" spellcheck="false" placeholder=".autocode/AGENTS.md,.autocode/memory.md,.autocode/settings.json" /></label>
          <p class="settings-help">打开项目时会自动初始化 .autocode 目录和这三个文件；已有文件不会被覆盖。智能体读取它们作为项目规则、长期记忆和项目级配置，Memory 更新仍需审批。</p>
          <label><span>自动压缩阈值</span><input id="auto-compact-threshold" type="number" min="4000" step="1000" /></label>
          <label><span>Checkpoint 策略</span><select id="checkpoint-policy"><option value="before_write">写入前创建</option><option value="manual">仅手动</option></select></label>
        </details>
        <details class="settings-group">
          <summary>工作区与终端</summary>
          <label><span>默认终端</span><select id="default-shell"><option value="auto">自动：PowerShell 失败切 cmd</option><option value="powershell">PowerShell</option><option value="cmd">cmd.exe</option></select></label>
          <label><span>默认工作目录</span><input id="default-workspace-path" spellcheck="false" /></label>
          <label><span>预览地址</span><input id="settings-preview-url" spellcheck="false" /></label>
        </details>
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
      this.editor.setAiCompletionOptions({ debounceMs: this.state.settings.code_completion?.debounce_ms || 750 })
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
    this.root.addEventListener('toggle', event => this.handleToggle(event), true)
    this.root.addEventListener('paste', event => void this.handlePaste(event))
    document.addEventListener('keydown', event => this.handleKeydown(event))
    document.addEventListener('click', event => {
      if (!(event.target as HTMLElement).closest('#context-menu')) this.hideContextMenu()
    })
    this.bindResizeHandles()
  }

  private handleToggle(event: Event) {
    const details = event.target as HTMLElement
    if (!(details instanceof HTMLDetailsElement)) return
    if (details.classList.contains('message-tools')) {
      const groupId = details.dataset.toolGroupId || ''
      if (!groupId) return
      if (details.open) this.collapsedToolGroupIds.delete(groupId)
      else this.collapsedToolGroupIds.add(groupId)
      return
    }
    if (!details.classList.contains('agent-tool-card')) return
    const toolId = details.dataset.toolId || ''
    if (!toolId) return
    if (details.open) {
      this.collapsedToolIds.delete(toolId)
      this.openedToolIds.add(toolId)
    } else {
      this.openedToolIds.delete(toolId)
      this.collapsedToolIds.add(toolId)
    }
    this.scheduleAssistantRender('tool_card_toggle')
  }

  private handleClick(event: MouseEvent) {
    const target = event.target as HTMLElement
    const button = target.closest<HTMLElement>('button')
    const attachmentPreview = target.closest<HTMLElement>('[data-attachment-preview-src]')
    if (attachmentPreview && !button) {
      event.preventDefault()
      event.stopPropagation()
      this.showAttachmentPreview(
        attachmentPreview.dataset.attachmentPreviewSrc || '',
        attachmentPreview.dataset.attachmentPreviewTitle || '附件预览',
        attachmentPreview.dataset.attachmentPreviewText || '',
        attachmentPreview.dataset.attachmentPreviewNote || '',
      )
      return
    }
    if (!button) return

    const mode = button.dataset.composerMode as ComposerMode | undefined
    const activity = button.dataset.activity as ActivityView | undefined
    const dock = button.dataset.dock as DockTab | undefined
    const command = button.dataset.command
    const tabPath = button.dataset.tabPath
    const openPath = button.dataset.openPath
    const gitFilePath = button.dataset.gitFilePath
    const gitStagePath = button.dataset.gitStagePath
    const gitUnstagePath = button.dataset.gitUnstagePath
    const gitAction = button.dataset.gitAction
    const gitCommitHash = button.dataset.gitCommitHash
    const recentPath = button.dataset.recentPath
    const removeRecentPath = button.dataset.removeRecentPath
    const commandAction = button.dataset.commandAction
    const agentId = button.dataset.agentId
    const agentSession = button.dataset.agentSession
    const removeAttachment = button.dataset.removeAttachment
    const copyCode = button.dataset.copyCode
    const applyPatch = button.dataset.applyPatch
    const editorCopyPath = button.dataset.editorCopyPath
    const openSystemPath = button.dataset.openSystemPath
    const closeTab = button.dataset.closeTab
    const closeOtherTabs = button.dataset.closeOtherTabs
    const agentApprove = button.dataset.agentApprove
    const agentDeny = button.dataset.agentDeny
    const agentDecision = button.dataset.agentDecision
    const checkpointRevert = button.dataset.checkpointRevert
    const processKill = button.dataset.processKill
    const problemPath = button.dataset.problemPath
    const turnRevert = button.dataset.turnRevert
    const subagentProfile = button.dataset.subagentProfile
    const copyMessage = button.dataset.copyMessage
    const editMessage = button.dataset.editMessage
    const resendMessage = button.dataset.resendMessage
    const composerSuggestion = button.dataset.composerSuggestion
    const sttDownloadModel = button.dataset.sttDownloadModel
    const sttCancelDownload = button.dataset.sttCancelDownload
    const sttUseModel = button.dataset.sttUseModel
    const channelAction = button.dataset.channelAction
    const channelId = button.dataset.channelId
    const channelToggle = button.dataset.channelToggle
    const channelKeyToggle = button.dataset.channelKeyToggle
    const agentQuestionAnswer = button.dataset.agentQuestionAnswer
    const agentQuestionSubmit = button.dataset.agentQuestionSubmit
    const chatFilePath = button.dataset.chatFilePath
    const chatFileCandidates = button.dataset.chatFileCandidates
    const deleteAgentSession = button.dataset.deleteAgentSession
    const copyNearCode = button.dataset.copyNearCode
    const queuedCancel = button.dataset.queuedCancel
    const queuedPromote = button.dataset.queuedPromote
    const queuedInsert = button.dataset.queuedInsert
    const attachmentPreviewClose = button.dataset.attachmentPreviewClose
    const skipUpdate = button.dataset.skipUpdate
    const startBuildPlan = button.dataset.startBuildPlan
    const planningFollowupAction = button.dataset.planningFollowupAction
    const planningFollowupMessage = button.dataset.planningFollowupMessage
    const layoutPreset = button.dataset.layoutPreset
    const agentConsoleSize = button.dataset.agentConsoleSize

    if (button.id === 'copy-path' || button.id === 'layout-menu' || agentConsoleSize || editorCopyPath || chatFilePath || chatFileCandidates || copyNearCode) {
      event.preventDefault()
      event.stopPropagation()
    }

    if (agentConsoleSize) this.toggleAgentConsoleSize()
    else if (layoutPreset) this.applyLayoutPreset(layoutPreset)
    else if (channelKeyToggle) this.toggleChannelKeyVisible(channelKeyToggle)
    else if (channelToggle) this.toggleChannelCollapsed(channelToggle)
    else if (channelAction && channelId) void this.runChannelAction(channelAction, channelId, button)
    else if (agentQuestionAnswer !== undefined) void this.answerAgentQuestion(button.dataset.agentQuestionId || '', decodeURIComponent(agentQuestionAnswer), button)
    else if (agentQuestionSubmit) void this.answerAgentQuestionFromCard(agentQuestionSubmit, button)
    else if (deleteAgentSession) void this.deleteAgentSession(deleteAgentSession, button)
    else if (attachmentPreviewClose) this.hideAttachmentPreview()
    else if (queuedCancel) this.cancelQueuedUserMessage(queuedCancel)
    else if (queuedPromote) this.promoteQueuedUserMessage(queuedPromote)
    else if (queuedInsert) this.insertQueuedUserMessageIntoCurrentTurn(queuedInsert)
    else if (startBuildPlan) void this.startBuildFromPlan(startBuildPlan)
    else if (planningFollowupAction) void this.handlePlanningFollowup(planningFollowupAction, planningFollowupMessage || '', button)
    else if (skipUpdate) void this.skipUpdateVersion(skipUpdate)
    else if (agentApprove) void this.answerAgentPermission(agentApprove, true, agentDecision || 'once', button)
    else if (agentDeny) void this.answerAgentPermission(agentDeny, false, agentDecision || 'deny', button)
    else if (problemPath) void this.openProblem(problemPath, Number(button.dataset.problemLine || 1), Number(button.dataset.problemCharacter || 0))
    else if (turnRevert) void this.revertTurnCheckpoints(turnRevert)
    else if (subagentProfile) void this.runSubagent(subagentProfile)
    else if (agentSession) void this.switchAgentSession(agentSession)
    else if (checkpointRevert) void this.revertAgentCheckpoint(checkpointRevert)
    else if (processKill) void this.killAgentProcess(processKill)
    else if (copyMessage) void this.copyChatMessage(copyMessage, button)
    else if (editMessage) this.editChatMessage(editMessage)
    else if (resendMessage) void this.resendChatMessage(resendMessage)
    else if (composerSuggestion) this.applyComposerSuggestion(composerSuggestion)
    else if (sttDownloadModel) void this.downloadOfflineSttModel(sttDownloadModel)
    else if (sttCancelDownload) void this.cancelOfflineSttDownload(sttCancelDownload)
    else if (sttUseModel) void this.useOfflineSttModel(sttUseModel)
    else if (copyCode) void this.copyChatCode(copyCode, button)
    else if (copyNearCode) void this.copyNearbyCode(button)
    else if (applyPatch) void this.applyChatPatch(applyPatch, button)
    else if (editorCopyPath) void this.copyEditorPath(editorCopyPath as any, button)
    else if (chatFileCandidates) this.showFileReferenceCandidates(button, chatFileCandidates)
    else if (chatFilePath) {
      this.gitDiffFocusPath = this.resolveWorkspaceMessagePath(chatFilePath)
      void this.openFile(this.gitDiffFocusPath || chatFilePath)
      void this.refreshGit()
      this.renderEditorStatus()
    }
    else if (openSystemPath) void this.openSystemPath(openSystemPath, button)
    else if (closeTab) this.closeTab(closeTab)
    else if (closeOtherTabs) this.closeOtherTabs(closeOtherTabs)
    else if (mode) this.switchComposerMode(mode)
    else if (activity) this.switchActivity(activity)
    else if (dock) this.switchDock(dock)
    else if (command) void this.runCommand(command)
    else if (tabPath) this.activateTab(tabPath)
    else if (gitFilePath) {
      this.gitDiffFocusPath = this.resolveWorkspaceMessagePath(gitFilePath)
      void this.openFile(this.gitDiffFocusPath || gitFilePath)
      void this.showGitFileDiff(this.gitDiffFocusPath || gitFilePath)
    }
    else if (gitAction === 'stage-all') void this.stageGitChanges([], button)
    else if (gitAction === 'unstage-all') void this.unstageGitChanges([], button)
    else if (gitStagePath) void this.stageGitChanges([gitStagePath], button)
    else if (gitUnstagePath) void this.unstageGitChanges([gitUnstagePath], button)
    else if (gitCommitHash) void this.showGitCommit(gitCommitHash)
    else if (openPath) void this.handleTreeOpen(openPath)
    else if (removeRecentPath) void this.removeRecentProject(removeRecentPath)
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
    if (id === 'refresh-git') void this.refreshGit(true)
    if (id === 'init-git-repository') void this.initializeGitRepository()
    if (id === 'git-stage-all') void this.stageGitChanges([], button)
    if (id === 'git-unstage-all') void this.unstageGitChanges([], button)
    if (id === 'git-commit-staged') void this.commitStagedChanges(button)
    if (id === 'load-skills') void this.loadSkills()
    if (id === 'test-api') void this.testApi()
    if (id === 'test-desktop-notification') void this.testDesktopNotification()
    if (id === 'check-app-update') void this.checkForAppUpdate('manual')
    if (id === 'install-app-update') void this.downloadAndInstallUpdate()
    if (id === 'open-web-autocode') void this.openWebAutocode(button)
    if (id === 'refresh-models') void this.refreshProviderModels()
    if (id === 'refresh-account' || id === 'account-pill') void this.refreshProviderAccount()
    if (id === 'open-settings' || id === 'quick-settings') this.openSettings()
    if (id === 'layout-menu' && button) this.showLayoutMenu(button)
    if (id === 'save-file') void this.saveActiveFile()
    if (id === 'reload-file') void this.reloadActiveFile()
    if (id === 'copy-path' && button) this.showEditorPathMenu(button)
    if (id === 'show-active-file-diff') this.showActiveFileDiff()
    if (id === 'copy-relative-path') void this.copyActivePath('relative', button)
    if (id === 'copy-absolute-path') void this.copyActivePath('absolute', button)
    if (id === 'copy-file-name') void this.copyActivePath('name', button)
    if (id === 'copy-parent-path') void this.copyActivePath('parent', button)
    if (id === 'open-entry-explorer') void this.openSelectedPathInExplorer(button)
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
    if (id === 'agent-continue') void this.continueAgent()
    if (id === 'agent-create-checkpoint') void this.createAgentCheckpoint()
    if (id === 'refresh-agent-sessions') void this.refreshAgentSessions()
    if (id === 'new-agent-session') void this.createAgentSession()
    if (id === 'cancel-agent-session') void this.cancelAgentSession()
    if (id === 'cancel-agent-from-composer') void this.cancelAgentSession({ force: String(this.state.agentRuntime.status || '') === 'cancelling', skipConfirm: false })
    if (id === 'fork-agent-session') void this.forkAgentSession()
    if (id === 'revert-latest-checkpoint') void this.revertLatestAgentCheckpoint()
    if (id === 'refresh-local-server') void this.refreshLocalServerStatus()
    if (id === 'copy-local-server-url') void this.copyLocalServerUrl()
    if (id === 'refresh-agent-tools') void this.refreshAgentTools()
    if (id === 'run-smoke-check') void this.runAgentSmokeCheck()
    if (id === 'attach-file') this.insertComposer(this.currentFileContext())
    if (id === 'optimize-composer-prompt') void this.optimizeComposerPrompt()
    if (id === 'context-current-file') this.addContextChip('file')
    if (id === 'context-selection') this.addContextChip('selection')
    if (id === 'context-terminal') this.addContextChip('terminal')
    if (id === 'context-git') this.addContextChip('git')
    if (id === 'pick-image-attachments') void this.pickAttachments('image')
    if (id === 'pick-file-attachments') void this.pickAttachments('file')
    if (id === 'pick-audio-attachment') void this.pickAttachments('voice')
    if (id === 'refresh-offline-stt') void this.refreshOfflineSttStatus(true)
    if (id === 'fix-error') this.insertComposer('请根据终端错误和当前文件生成修复方案，并直接修改必要文件。')
    if (id === 'review-code') this.insertComposer('请审查当前项目的未提交改动，输出问题、风险和建议修复。')
    if (id === 'start-voice') void this.startVoiceInput()
    if (id === 'stop-voice') void this.stopVoiceInput()
    if (id === 'create-task') void this.createTask()
    if (id === 'close-settings' || id === 'settings-overlay') this.closeSettings()
    if (id === 'init-autocode-project') void this.initializeAutocodeProject()
    if (id === 'save-settings') void this.saveSettings()
    if (id === 'add-channel') void this.addProviderChannel()
  }

  private handleInput(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    if (target.dataset.channelField) {
      this.updateChannelField(target)
      return
    }
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
      this.clearComposerOptimizationUndo(false)
      this.updateComposerSuggestions(target as HTMLTextAreaElement)
      this.scheduleSessionPersist()
      this.updateComposerSubmitButton()
    }
    if (target.id === 'offline-stt-proxy-url') {
      this.offlineSttProxyUrl = target.value.trim()
      localStorage.setItem('autocode.ide.offlineSttProxyUrl', this.offlineSttProxyUrl)
      return
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
    if (['ui-font-size', 'code-font-size', 'ui-font-family', 'code-font-family', 'appearance-contrast'].includes(target.id)) {
      this.previewAppearanceSettings()
    }
  }

  private handleChange(event: Event) {
    const input = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    if (input.dataset.channelField) {
      this.updateChannelField(input)
      this.renderProviderStatus()
      return
    }
    if (input.dataset.channelModel && input.dataset.channelId) {
      const channel = this.state.settings.channels.find(item => item.id === input.dataset.channelId)
      if (channel) {
        const selected = new Set((channel.enabled_models?.length ? channel.enabled_models : channel.models) || [])
        if ((input as HTMLInputElement).checked) selected.add(input.dataset.channelModel)
        else selected.delete(input.dataset.channelModel)
        channel.enabled_models = [...selected]
        channel.model_filter_configured = true
        this.renderProviderStatus()
      }
      return
    }
    if (input.id === 'channel-completion-enabled') {
      this.state.settings.code_completion.enabled = (input as HTMLInputElement).checked
      void this.persistSettingsFromState()
      return
    }
    if (input.id === 'theme-select') {
      this.state.theme = input.value as AppState['theme']
      saveTheme(this.state.theme)
      this.applyTheme()
      return
    }
    if (['appearance-density', 'reduced-motion'].includes(input.id)) {
      this.previewAppearanceSettings()
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
    if (input.id === 'composer-reasoning-mode') {
      this.state.settings.reasoning_mode = input.value
      this.renderComposer()
      void this.persistSettingsFromState()
      return
    }
    if (input.id === 'agent-profile-select') {
      this.state.agentRuntime.profileId = input.value || 'build'
      void this.refreshAgentTools()
      this.renderAssistant()
      this.scheduleSessionPersist()
      return
    }
    if (input.id === 'terminal-session-select') {
      void this.switchTerminalSession(input.value)
      return
    }
    if (input.id === 'terminal-shell-select') {
      const shell = this.selectedTerminalShell()
      this.state.settings.default_shell = shell === 'auto' ? 'auto' : shell === 'powershell.exe' ? 'powershell' : shell === 'pwsh.exe' ? 'pwsh' : 'cmd'
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
    if (input.id === 'composer-model') {
      this.state.settings.model = input.value
      this.renderProviderStatus()
      void this.persistSettingsFromState()
      return
    }
    if (input.id !== 'composer-file-input') return
    void this.addInputFilesAsAttachments(Array.from(input.files || []))
  }

  private async addInputFilesAsAttachments(files: File[]) {
    if (!files.length) return
    const kind = this.state.composerMode === 'image' ? 'image' : 'file'
    const attachments = await Promise.all(files.map(file => this.attachmentFromBrowserFile(file, kind)))
    this.state.attachments.push(...attachments)
    this.renderComposer()
    this.scheduleSessionPersist()
    this.toast(`已添加 ${attachments.length} 个附件`, 'ok')
  }

  private async attachmentFromBrowserFile(file: File, kind: 'image' | 'file') {
    const attachment: Attachment = {
      kind: kind === 'image' || file.type.startsWith('image/') ? 'image' : 'file',
      name: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      readable: false,
    }
    if (attachment.kind === 'image') {
      attachment.dataUrl = await this.readFileAsDataUrl(file)
      attachment.preview = attachment.dataUrl
      attachment.readable = true
    } else if (file.type.startsWith('text/') || /\.(txt|md|json|js|ts|tsx|jsx|css|html|py|rs|toml|yaml|yml|xml|csv|log)$/i.test(file.name)) {
      attachment.text = (await file.text()).slice(0, 240000)
      attachment.readable = true
    } else {
      attachment.note = '二进制文件仅作为附件记录，当前模型不会直接读取内容。'
    }
    return attachment
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
      const attachments = await Promise.all(picked.map(item => this.attachmentFromPickedFile(item, kind)))
      this.state.attachments.push(...attachments)
      this.renderComposer()
      this.scheduleSessionPersist()
      this.toast(`已添加 ${picked.length} 个附件`, 'ok')
    } catch (error) {
      if (!String(error).toLowerCase().includes('cancel')) this.toast(String(error), 'error')
    }
  }

  private async attachmentFromPickedFile(item: any, kind: 'image' | 'file' | 'voice') {
    const mime = String(item.mime || '')
    const attachment: Attachment = {
      kind: kind === 'image' || mime.startsWith('image/') ? 'image' : 'file',
      name: String(item.name || 'attachment'),
      path: String(item.path || ''),
      size: Number(item.size || 0),
      mime,
      preview: item.previewable && mime.startsWith('image/') ? convertFileSrc(String(item.path || '')) : '',
      readable: false,
    }
    try {
      if (attachment.path) {
        const preview = await this.api.attachmentPreview(attachment.path)
        attachment.text = String(preview?.text || '')
        attachment.dataUrl = String(preview?.dataUrl || '')
        attachment.note = String(preview?.note || '')
        attachment.readable = Boolean(attachment.text || attachment.dataUrl)
        if (attachment.dataUrl && !attachment.preview) attachment.preview = attachment.dataUrl
      }
    } catch (error) {
      attachment.note = `附件预览读取失败：${String(error)}`
    }
    return attachment
  }

  private async handlePaste(event: ClipboardEvent) {
    const target = event.target as HTMLElement
    if (target.id !== 'task-prompt') return
    this.clearComposerOptimizationUndo(false)
    const items = Array.from(event.clipboardData?.items || [])
    const pastedText = event.clipboardData?.getData('text/plain') || ''
    const files = items
      .filter(item => item.kind === 'file')
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file))
    if (!files.length && pastedText.length > 6000) {
      event.preventDefault()
      const name = `pasted-text-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`
      this.state.attachments.push({
        kind: 'file',
        name,
        size: new Blob([pastedText]).size,
        mime: 'text/plain;charset=utf-8',
        text: pastedText.slice(0, 240000),
      })
      const input = event.target as HTMLTextAreaElement
      const hint = `@附件 ${name}`
      const start = input.selectionStart ?? input.value.length
      const end = input.selectionEnd ?? input.value.length
      input.value = `${input.value.slice(0, start)}${hint}${input.value.slice(end)}`
      input.selectionStart = start + hint.length
      input.selectionEnd = input.selectionStart
      this.composerDraft = input.value
      this.renderComposer()
      this.scheduleSessionPersist()
      this.toast(`长文本已转为附件：${name}`, 'ok')
      return
    }
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
        attachment.dataUrl = await this.readFileAsDataUrl(file)
        attachment.preview = attachment.dataUrl
        attachment.readable = true
      } else if (file.type.startsWith('text/') || /\.(txt|md|json|js|ts|tsx|jsx|css|html|py|rs)$/i.test(file.name)) {
        attachment.text = (await file.text()).slice(0, 240000)
        attachment.readable = true
      } else {
        attachment.note = '二进制文件仅作为附件记录，当前模型不会直接读取内容。'
      }
      this.state.attachments.push(attachment)
    }
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
    const keyTarget = event.target as HTMLElement
    if (keyTarget.id === 'task-prompt' && this.composerSuggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      this.composerSuggestionIndex = Math.max(0, Math.min(this.composerSuggestions.length - 1, this.composerSuggestionIndex + (event.key === 'ArrowDown' ? 1 : -1)))
      this.renderComposerSuggestions()
      return
    }
    if (keyTarget.id === 'task-prompt' && this.composerSuggestions.length && event.key === 'Tab') {
      event.preventDefault()
      this.applyComposerSuggestion(encodeURIComponent(this.composerSuggestions[this.composerSuggestionIndex]?.value || ''))
      return
    }
    if (event.key === 'Enter') {
      const target = event.target as HTMLElement
      if (target instanceof HTMLInputElement && target.dataset.agentQuestionInput) {
        event.preventDefault()
        void this.answerAgentQuestionFromCard(target.dataset.agentQuestionInput, target)
        return
      }
      if (target.id === 'task-prompt' && this.composerSuggestions.length && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        this.applyComposerSuggestion(encodeURIComponent(this.composerSuggestions[this.composerSuggestionIndex]?.value || ''))
        return
      }
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
        const resizeSide = kind === 'explorer' || kind === 'assistant' || kind === 'workbench' ? this.getPaneResizeSide(kind) : 'top'
        const onMove = (move: PointerEvent) => {
          const horizontalDelta = resizeSide === 'right' ? move.clientX - startX : startX - move.clientX
          if (kind === 'explorer') this.state.layout.explorerWidth = Math.min(520, Math.max(220, start.explorerWidth + horizontalDelta))
          if (kind === 'assistant') this.state.layout.assistantWidth = Math.min(560, Math.max(320, start.assistantWidth + horizontalDelta))
          if (kind === 'workbench') this.state.layout.workbenchSideWidth = Math.min(920, Math.max(420, start.workbenchSideWidth + horizontalDelta))
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
    this.root.querySelectorAll<HTMLElement>('[data-agent-console-resize]').forEach(handle => {
      handle.addEventListener('pointerdown', event => {
        event.preventDefault()
        event.stopPropagation()
        const console = this.$<HTMLElement>('#agent-console')
        const body = this.$<HTMLElement>('#agent-runtime-panel')
        if (!console || !body) return
        if (!(console as HTMLDetailsElement).open) (console as HTMLDetailsElement).open = true
        const startY = event.clientY
        const startHeight = this.agentConsoleHeight || body.getBoundingClientRect().height || 260
        handle.setPointerCapture?.(event.pointerId)
        console.classList.add('resizing')
        document.body.classList.add('agent-console-resizing')
        const applyHeight = (height: number) => {
          this.agentConsoleHeight = height
          console.style.setProperty('--agent-console-height', `${height}px`)
          console.classList.add('expanded', 'manual-height')
          this.agentConsoleExpanded = true
          const button = this.$('.agent-console-size-toggle')
          if (button) button.textContent = '紧凑'
        }
        const onMove = (move: PointerEvent) => {
          move.preventDefault()
          const maxHeight = Math.max(220, Math.floor(window.innerHeight * 0.72))
          const next = Math.min(maxHeight, Math.max(180, Math.round(startHeight + move.clientY - startY)))
          applyHeight(next)
          const button = this.$('.agent-console-size-toggle')
          if (button) button.textContent = '紧凑'
        }
        const onUp = () => {
          console.classList.remove('resizing')
          document.body.classList.remove('agent-console-resizing')
          handle.releasePointerCapture?.(event.pointerId)
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          window.removeEventListener('pointercancel', onUp)
          localStorage.setItem('autocode.ide.agentConsoleHeight', String(this.agentConsoleHeight || ''))
          localStorage.setItem('autocode.ide.agentConsoleExpanded', this.agentConsoleExpanded ? '1' : '0')
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
        window.addEventListener('pointercancel', onUp)
      })
    })
  }

  private normalizeMainRegionOrder(order = this.state.layout.regionOrder): MainRegion[] {
    const allowed = new Set<MainRegion>(mainRegionOrderDefault)
    const next = Array.isArray(order) ? order.filter((item): item is MainRegion => allowed.has(item as MainRegion)) : []
    return next.length === 3 && new Set(next).size === 3 ? next : [...mainRegionOrderDefault]
  }

  private getRegionPhysicalIndex(region: MainRegion) {
    return this.normalizeMainRegionOrder().indexOf(region)
  }

  private getPaneResizeSide(kind: string): 'left' | 'right' {
    const region: MainRegion = kind === 'assistant' ? 'assistant' : kind === 'workbench' ? 'workbench' : 'side'
    const order = this.normalizeMainRegionOrder()
    return order.indexOf(region) < this.mainRegionBossIndex(order) ? 'right' : 'left'
  }

  private isMainRegionCollapsed(region: MainRegion) {
    return (region === 'side' && this.state.layout.explorerCollapsed)
      || (region === 'assistant' && this.state.layout.assistantCollapsed)
  }

  private mainRegionFixedColumn(region: MainRegion) {
    if (region === 'side') return 'var(--explorer-width)'
    if (region === 'assistant') return 'var(--assistant-width)'
    return 'var(--workbench-side-width)'
  }

  private mainRegionBossIndex(order: MainRegion[]) {
    if (!this.isMainRegionCollapsed(order[1])) return 1
    const workbenchIndex = order.indexOf('workbench')
    if (workbenchIndex >= 0 && !this.isMainRegionCollapsed('workbench')) return workbenchIndex
    const fallbackIndex = order.findIndex(region => !this.isMainRegionCollapsed(region))
    return fallbackIndex >= 0 ? fallbackIndex : 1
  }

  private applyPaneResizerPosition(selector: string, side: 'left' | 'right', visible = true) {
    const handle = this.$<HTMLElement>(selector)
    if (!handle) return
    handle.hidden = !visible
    handle.classList.toggle('left', side === 'left')
    handle.classList.toggle('right', side === 'right')
  }

  private applyLayout(persist = true) {
    const shell = this.$<HTMLElement>('#ide-shell')
    if (!shell) return
    const order = this.normalizeMainRegionOrder()
    this.state.layout.regionOrder = order
    const bossIndex = this.mainRegionBossIndex(order)
    const columns = order.map((region, index) => {
      if (this.isMainRegionCollapsed(region)) return '0px'
      if (index === bossIndex) return 'minmax(0, 1fr)'
      return this.mainRegionFixedColumn(region)
    })
    shell.style.setProperty('--main-region-columns', columns.join(' '))
    shell.style.setProperty('--main-region-areas', `"rail ${order.join(' ')}"`)
    shell.dataset.regionOrder = order.join('-')
    order.forEach((region, index) => {
      const element = this.$<HTMLElement>(region === 'side' ? '#side-pane' : region === 'assistant' ? '#assistant-pane' : '.workbench')
      if (element) element.dataset.regionPosition = index === 0 ? 'left' : index === 1 ? 'middle' : 'right'
    })
    this.applyPaneResizerPosition('#side-pane [data-resize="explorer"]', this.getPaneResizeSide('explorer'), order.indexOf('side') !== bossIndex && !this.isMainRegionCollapsed('side'))
    this.applyPaneResizerPosition('#assistant-pane [data-resize="assistant"]', this.getPaneResizeSide('assistant'), order.indexOf('assistant') !== bossIndex && !this.isMainRegionCollapsed('assistant'))
    this.applyPaneResizerPosition('.workbench > [data-resize="workbench"]', this.getPaneResizeSide('workbench'), order.indexOf('workbench') !== bossIndex)
    shell.style.setProperty('--explorer-width', `${this.state.layout.explorerCollapsed ? 0 : this.state.layout.explorerWidth}px`)
    shell.style.setProperty('--assistant-width', `${this.state.layout.assistantCollapsed ? 0 : this.state.layout.assistantWidth}px`)
    shell.style.setProperty('--workbench-side-width', `${this.state.layout.workbenchSideWidth}px`)
    shell.style.setProperty('--bottom-height', `${this.state.layout.bottomCollapsed ? 42 : this.state.layout.bottomHeight}px`)
    shell.classList.toggle('explorer-collapsed', this.state.layout.explorerCollapsed)
    shell.classList.toggle('assistant-collapsed', this.state.layout.assistantCollapsed)
    shell.classList.toggle('bottom-collapsed', this.state.layout.bottomCollapsed)
    this.terminal.fit()
    if (persist) saveLayout(this.state.layout)
  }

  private applyTheme() {
    this.normalizeAppearanceSettings()
    this.root.dataset.theme = this.state.theme
    this.root.dataset.density = this.state.settings.appearance_density || 'comfortable'
    this.root.dataset.motion = this.state.settings.reduced_motion || 'system'
    this.root.style.setProperty('--ui-font-family', this.state.settings.ui_font_family)
    this.root.style.setProperty('--code-font-family', this.state.settings.code_font_family)
    this.root.style.setProperty('--ui-font-size', `${this.state.settings.ui_font_size}px`)
    this.root.style.setProperty('--code-font-size', `${this.state.settings.code_font_size}px`)
    this.root.style.setProperty('--ui-contrast', String(this.state.settings.ui_contrast / 100))
    this.terminal.setTheme(this.state.theme === 'light' ? 'light' : 'dark')
    this.terminal.setAppearance({
      fontFamily: this.state.settings.code_font_family,
      fontSize: this.state.settings.code_font_size,
    })
  }

  private previewAppearanceSettings() {
    this.state.settings.ui_font_size = Number(this.$<HTMLInputElement>('#ui-font-size')?.value || this.state.settings.ui_font_size || 14)
    this.state.settings.code_font_size = Number(this.$<HTMLInputElement>('#code-font-size')?.value || this.state.settings.code_font_size || 12)
    this.state.settings.ui_font_family = this.$<HTMLInputElement>('#ui-font-family')?.value.trim() || this.state.settings.ui_font_family
    this.state.settings.code_font_family = this.$<HTMLInputElement>('#code-font-family')?.value.trim() || this.state.settings.code_font_family
    this.state.settings.appearance_density = this.$<HTMLSelectElement>('#appearance-density')?.value || this.state.settings.appearance_density
    this.state.settings.ui_contrast = Number(this.$<HTMLInputElement>('#appearance-contrast')?.value || this.state.settings.ui_contrast || 100)
    this.state.settings.reduced_motion = this.$<HTMLSelectElement>('#reduced-motion')?.value || this.state.settings.reduced_motion
    this.applyTheme()
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
    const requested = this.normalizeRecentProject(project) || project
    const bootSnapshot = this.pendingSessionSnapshot
    const opened = await invoke<RecentProject>('ide_open_workspace', {
      rootPath: requested.path,
      taskId: requested.task_id || null,
      previewUrl: requested.preview_url || null,
    })
    const normalizedOpened = this.normalizeRecentProject(opened) || opened
    if (this.state.terminalSessionId) await this.killTerminal()
    this.state.workspace.currentProject = normalizedOpened
    this.state.settings.last_workspace_path = normalizedOpened.path
    this.state.previewUrl = normalizedOpened.preview_url || this.state.settings.preview_url || ''
    this.state.workspace.tabs = []
    this.state.workspace.activePath = ''
    this.state.workspace.selectedPath = ''
    this.state.workspace.expandedDirs = []
    this.state.workspace.searchResults = []
    this.state.agentRuntime = {
      sessionId: '',
      profileId: 'build',
      activeTurnId: '',
      activeRequestId: '',
      queuedUserMessages: [],
      phase: undefined,
      phaseHistory: [],
      events: [],
      timeline: [],
      pendingPermissions: [],
      patchPreviews: [],
      thinking: '',
      status: 'idle',
      resumeReason: '',
      stepCount: 0,
      compactionCount: 0,
      compactedSummary: null,
      checkpoints: [],
      memoryRefs: [],
      sessions: [],
      subagents: [],
      processes: [],
      profiles: this.state.agentRuntime.profiles || [],
      hooks: [],
      smokeChecks: [],
      tools: [],
      mcpTools: [],
      diagnostics: [],
      approvedPlan: null,
      planTodos: [],
      planningAnswers: [],
      planningConfirmation: this.emptyPlanningConfirmation(),
      planDevelopment: this.emptyPlanDevelopment(),
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
    this.state.activeActivity = 'explorer'
    this.upsertRecent(normalizedOpened)
    this.editor.setTab(null)
    this.renderAll()
    await this.refreshWorkspace(true)
    const projectSnapshot = await this.api.loadSession(normalizedOpened.path).catch(() => null)
    const usableBootSnapshot = displayPath(bootSnapshot?.currentProject?.path || '') === normalizedOpened.path ? bootSnapshot : null
    this.pendingSessionSnapshot = this.normalizeSessionSnapshot(this.newerSessionSnapshot(projectSnapshot, usableBootSnapshot))
    this.restoreSessionForProject(normalizedOpened.path)
    await this.refreshAgentSessions(false)
    await this.ensureAgentSession()
    await this.refreshAgentProcesses()
    await this.refreshAgentProfiles(false)
    await this.refreshAgentTools()
    await this.startTerminal(this.selectedTerminalShell())
    if (this.state.settings.connection_mode === 'aiProvider' && this.state.settings.api_base_url && !this.state.providerCatalog.models.length) void this.refreshProviderModels()
    if (normalizedOpened.task_id) void this.refreshTask()
    this.persistSessionSnapshot()
    if (notify) this.toast(`已打开项目：${normalizedOpened.name}`, 'ok')
  }

  private async ensureAgentSession() {
    if (!this.currentRoot()) return ''
    if (this.state.agentRuntime.sessionId) return this.state.agentRuntime.sessionId
    try {
      const existing = await this.api.agentSessions(this.currentRoot()).catch(() => [])
      const latest = existing
        .filter((item: any) => String(item?.rootPath || '') === this.currentRoot())
        .sort((a: any, b: any) => this.sessionTime(b) - this.sessionTime(a))[0]
      if (latest?.id) {
        this.state.agentRuntime.sessionId = String(latest.id)
        this.state.agentRuntime.profileId = String(latest.profileId || 'build')
        this.restoreAgentRuntimeFromSnapshot(latest)
        this.state.agentRuntime.sessions = existing
          .filter((item: any) => String(item?.rootPath || '') === this.currentRoot())
          .sort((a: any, b: any) => this.sessionTime(b) - this.sessionTime(a))
          .slice(0, 24)
        this.updateAgentDiagnostics()
        return this.state.agentRuntime.sessionId
      }
      const session = await this.api.agentSessionStart(this.currentRoot(), this.state.agentRuntime.profileId || 'build')
      this.state.agentRuntime.sessionId = String(session?.id || '')
      this.state.agentRuntime.profileId = String(session?.profileId || 'build')
      await this.refreshAgentSessions(false)
      this.updateAgentDiagnostics()
      return this.state.agentRuntime.sessionId
    } catch (error) {
      this.toast(`Agent 会话创建失败：${String(error)}`, 'error')
      return ''
    }
  }

  private sessionTime(session: any) {
    return Date.parse(String(session?.updatedAt || session?.createdAt || '')) || 0
  }

  private emptyPlanningConfirmation() {
    return {
      status: 'idle',
      answers: [],
      openQuestions: [],
      confirmedRequirements: [],
    }
  }

  private emptyPlanDevelopment() {
    return {
      status: 'idle',
      planId: '',
      planFilePath: '',
      todoItems: [],
      completedTodoIds: [],
      checkpointIds: [],
      continuationCount: 0,
    }
  }

  private resetSessionScopedAgentRuntime(_reason = '') {
    this.state.agentRuntime = {
      ...this.state.agentRuntime,
      activeTurnId: '',
      activeRequestId: '',
      queuedUserMessages: [],
      phase: undefined,
      phaseHistory: [],
      events: [],
      timeline: [],
      pendingPermissions: [],
      patchPreviews: [],
      thinking: '',
      status: 'idle',
      resumeReason: '',
      stepCount: 0,
      compactionCount: 0,
      compactedSummary: null,
      checkpoints: [],
      memoryRefs: [],
      subagents: [],
      processes: [],
      hooks: [],
      smokeChecks: [],
      approvedPlan: null,
      planTodos: [],
      planningAnswers: [],
      planningConfirmation: this.emptyPlanningConfirmation(),
      planDevelopment: this.emptyPlanDevelopment(),
    }
  }

  private normalizeRestoredAgentRuntime(snapshot: any) {
    const planningConfirmation = snapshot?.planningConfirmation && typeof snapshot.planningConfirmation === 'object'
      ? {
        ...this.emptyPlanningConfirmation(),
        status: String(snapshot.planningConfirmation.status || 'idle'),
        answers: Array.isArray(snapshot.planningConfirmation.answers) ? snapshot.planningConfirmation.answers : [],
        openQuestions: Array.isArray(snapshot.planningConfirmation.openQuestions) ? snapshot.planningConfirmation.openQuestions : [],
        confirmedRequirements: Array.isArray(snapshot.planningConfirmation.confirmedRequirements) ? snapshot.planningConfirmation.confirmedRequirements : [],
      }
      : this.emptyPlanningConfirmation()
    const planDevelopment = snapshot?.planDevelopment && typeof snapshot.planDevelopment === 'object'
      ? {
        ...this.emptyPlanDevelopment(),
        ...snapshot.planDevelopment,
        todoItems: Array.isArray(snapshot.planDevelopment.todoItems) ? snapshot.planDevelopment.todoItems : [],
        completedTodoIds: Array.isArray(snapshot.planDevelopment.completedTodoIds) ? snapshot.planDevelopment.completedTodoIds : [],
        checkpointIds: Array.isArray(snapshot.planDevelopment.checkpointIds) ? snapshot.planDevelopment.checkpointIds : [],
      }
      : this.emptyPlanDevelopment()
    return {
      approvedPlan: snapshot?.approvedPlan || null,
      planTodos: Array.isArray(snapshot?.planTodos) ? snapshot.planTodos : [],
      planningAnswers: Array.isArray(snapshot?.planningAnswers) ? snapshot.planningAnswers : [],
      planningConfirmation,
      planDevelopment,
    }
  }

  private async refreshAgentSessions(render = true) {
    if (!this.currentRoot()) return
    try {
      const sessions = await this.api.agentSessions(this.currentRoot())
      this.state.agentRuntime.sessions = (Array.isArray(sessions) ? sessions : [])
        .filter((item: any) => String(item?.rootPath || '') === this.currentRoot())
        .sort((a: any, b: any) => this.sessionTime(b) - this.sessionTime(a))
        .slice(0, 24)
      if (render) {
        this.renderAssistant()
        this.renderProblems()
      }
    } catch (error) {
      if (render) this.toast(`Agent 会话刷新失败：${String(error)}`, 'error')
    }
  }

  private async switchAgentSession(sessionId: string) {
    if (!sessionId || sessionId === this.state.agentRuntime.sessionId) return
    try {
      const snapshot = await this.api.agentSessionSnapshot(sessionId)
      this.resetSessionScopedAgentRuntime('switch_agent_session')
      this.state.agentRuntime.sessionId = String(snapshot?.id || sessionId)
      this.state.agentRuntime.profileId = String(snapshot?.profileId || 'build')
      this.state.chat = [{
        id: `session-switch-${Date.now()}`,
        role: 'system',
        text: '已切换到选中的 Agent 会话。',
        at: new Date().toISOString(),
      }]
      this.restoreAgentRuntimeFromSnapshot(snapshot)
      this.activeAssistantMessageId = ''
      this.activeTurnToolIds = []
      this.activeTurnPermissionIds = []
      this.activeTurnPatchIds = []
      this.activeTurnCheckpointIds = []
      this.activeTurnReasoning = ''
      await this.refreshAgentSessions(false)
      await this.refreshAgentTools()
      this.renderAssistant()
      this.renderProblems()
      this.scheduleSessionPersist()
      this.toast('已切换 Agent 会话', 'ok')
    } catch (error) {
      this.toast(`切换 Agent 会话失败：${String(error)}`, 'error')
    }
  }

  private async createAgentSession() {
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    try {
      const session = await this.api.agentSessionStart(this.currentRoot(), this.state.agentRuntime.profileId || 'build')
      this.resetSessionScopedAgentRuntime('create_agent_session')
      this.state.agentRuntime.sessionId = String(session?.id || '')
      this.state.agentRuntime.profileId = String(session?.profileId || 'build')
      this.state.agentRuntime.status = String(session?.status || 'idle')
      this.state.agentRuntime.profiles = this.state.agentRuntime.profiles || []
      this.activeAssistantMessageId = ''
      this.activeTurnToolIds = []
      this.activeTurnPermissionIds = []
      this.activeTurnPatchIds = []
      this.activeTurnCheckpointIds = []
      this.activeTurnReasoning = ''
      this.state.chat = [{
        id: `session-${Date.now()}`,
        role: 'system',
        text: '已创建新的本地 Agent 会话。上一会话仍保留在会话列表中，可以随时切回。',
        at: new Date().toISOString(),
      }]
      await this.refreshAgentSessions(false)
      await this.refreshAgentTools()
      this.renderAssistant()
      this.renderProblems()
      this.scheduleSessionPersist()
      this.toast('已创建新的 Agent 会话', 'ok')
    } catch (error) {
      this.toast(`创建 Agent 会话失败：${String(error)}`, 'error')
    }
  }

  private async cancelAgentSession(options: { force?: boolean; skipConfirm?: boolean } = {}) {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    const status = String(this.state.agentRuntime.status || '')
    const force = Boolean(options.force || status === 'cancelling')
    const cancelledRequestId = String(this.state.agentRuntime.activeRequestId || this.pendingAiRequest?.requestId || '')
    if (!options.skipConfirm) {
      const confirmText = force
        ? '强制停止 Agent？将立即清理待审批操作并结束当前会话状态（进行中的模型请求可能仍在后台结束）。'
        : '请求 Agent 停止？它会尽量在当前模型轮或工具执行后收尾；若卡住可再次点击强制停止。'
      if (!window.confirm(confirmText)) return
    }
    this.isolateCancelledAgentRequest(cancelledRequestId)
    this.state.agentRuntime.status = 'cancelled'
    this.markRequest('ok', 'Agent 已本地停止', '输入区已释放，后台继续清理 Provider 请求和子进程。')
    this.renderAssistant()
    this.renderComposer()
    this.scheduleSessionPersist()
    try {
      const result = await this.api.agentCancel(sessionId)
      this.state.agentRuntime.status = String(result?.status || (force ? 'cancelled' : 'cancelling'))
      if (this.state.agentRuntime.status !== 'cancelled') this.state.agentRuntime.status = 'cancelled'
      this.state.agentRuntime.pendingPermissions = []
      this.markRequest('ok', 'Agent 已完全停止', String(result?.message || '运行态、待审批和子进程已清理。'))
      await this.refreshAgentSessions(false)
      this.renderAssistant()
      this.renderProblems()
      this.renderComposer()
      this.scheduleSessionPersist()
      this.toast(
        String(result?.message || (this.state.agentRuntime.status === 'cancelled' ? 'Agent 已停止' : '已请求 Agent 停止')),
        this.state.agentRuntime.status === 'cancelled' ? 'ok' : 'busy',
      )
    } catch (error) {
      this.state.agentRuntime.status = 'cancelled'
      this.finalizeFrontendAgentTurn({
        status: 'cancelled',
        requestId: cancelledRequestId,
        queueStatus: 'queued',
        clearActionCards: true,
        message: `后端停止请求返回异常：${String(error)}`,
      })
      this.markRequest('ok', 'Agent 已本地停止', `后端停止请求返回异常，但前端运行态已清理：${String(error)}`)
      this.renderComposer()
      this.toast(`已本地停止；后端停止请求返回异常：${String(error)}`, 'error')
    }
  }

  private async forkAgentSession() {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    try {
      const fork = await this.api.agentFork(sessionId, `Fork from ${sessionId}`)
      const forkId = String(fork?.id || '')
      if (!forkId) throw new Error('fork did not return a session id')
      await this.refreshAgentSessions(false)
      await this.switchAgentSession(forkId)
      this.toast('已从当前上下文分叉新会话', 'ok')
    } catch (error) {
      this.toast(`分叉 Agent 会话失败：${String(error)}`, 'error')
    }
  }

  private async deleteAgentSession(sessionId: string, button?: HTMLElement) {
    if (!sessionId) return
    const current = sessionId === this.state.agentRuntime.sessionId
    if (!window.confirm(current ? '删除当前 Agent 会话？聊天、工具轨迹和待审批记录都会从本机快照移除。' : `删除 Agent 会话 ${sessionId}？`)) return
    try {
      this.setInlineActionFeedback(button, 'loading', '删除中...')
      await this.api.agentDeleteSession(sessionId)
      this.state.agentRuntime.sessions = (this.state.agentRuntime.sessions || []).filter((item: any) => String(item?.id || '') !== sessionId)
      if (current) {
        const next = (this.state.agentRuntime.sessions as any[]).find(item => String(item?.id || '') !== sessionId)
        this.state.agentRuntime.sessionId = ''
        this.state.agentRuntime.timeline = []
        this.state.agentRuntime.pendingPermissions = []
        this.state.agentRuntime.patchPreviews = []
        this.state.agentRuntime.thinking = ''
        this.state.agentRuntime.status = 'idle'
        this.state.agentRuntime.resumeReason = ''
        this.state.agentRuntime.checkpoints = []
        this.state.chat = [{
          id: `session-delete-${Date.now()}`,
          role: 'system',
          text: '已删除当前 Agent 会话。',
          at: new Date().toISOString(),
        }]
        if (next?.id) await this.switchAgentSession(String(next.id))
        else await this.ensureAgentSession()
      } else {
        await this.refreshAgentSessions(false)
      }
      this.setInlineActionFeedback(button, 'ok', '已删除')
      this.renderAssistant()
      this.renderProblems()
      this.scheduleSessionPersist()
      this.toast('Agent 会话已删除', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '删除失败')
      this.toast(`删除 Agent 会话失败：${String(error)}`, 'error')
    }
  }

  private async revertLatestAgentCheckpoint() {
    const latest = [...this.state.agentRuntime.checkpoints].reverse().find((item: any) => item?.id) as any
    if (!latest?.id) return this.toast('当前没有可回退的 checkpoint', 'idle')
    await this.revertAgentCheckpoint(String(latest.id))
  }

  private async refreshAgentProcesses() {
    if (!this.currentRoot()) return
    try {
      const result = await this.api.agentProcesses(this.currentRoot())
      const processes = Array.isArray(result?.processes) ? result.processes : []
      this.state.agentRuntime.processes = processes.slice(-20)
      this.updateAgentDiagnostics()
    } catch {
      this.state.agentRuntime.processes = this.state.agentRuntime.processes.map((item: any) =>
        String(item?.status || 'running') === 'running' ? { ...item, status: 'unknown' } : item,
      )
    }
  }

  private async refreshAgentTools() {
    try {
      const result = await this.api.agentTools(this.currentRoot() || null, this.state.agentRuntime.profileId || 'build')
      this.state.agentRuntime.tools = Array.isArray(result?.tools) ? result.tools : []
      this.state.agentRuntime.mcpTools = Array.isArray(result?.mcpTools) ? result.mcpTools : []
      this.updateAgentDiagnostics()
      this.renderAssistant()
      this.renderProblems()
    } catch {
      this.state.agentRuntime.tools = []
      this.state.agentRuntime.mcpTools = []
      this.renderAssistant()
    }
  }

  private async refreshAgentProfiles(render = true) {
    try {
      const result = await this.api.agentProfiles()
      this.state.agentRuntime.profiles = Array.isArray(result?.profiles) ? result.profiles : []
      if (render) this.renderAssistant()
    } catch {
      this.state.agentRuntime.profiles = this.state.agentRuntime.profiles || []
    }
  }

  private async runAgentSmokeCheck() {
    try {
      this.markRequest('busy', '正在运行 IDE smoke check', this.currentRoot() || '未打开项目')
      const result = await this.api.agentSmokeCheck(this.currentRoot() || null, this.state.previewUrl || this.state.settings.preview_url || null)
      this.state.agentRuntime.smokeChecks = Array.isArray(result?.checks) ? result.checks : []
      this.markRequest(result?.ok ? 'ok' : 'error', 'IDE smoke check 完成', String(result?.summary || '检查完成'))
      this.renderProblems()
      this.scheduleSessionPersist()
    } catch (error) {
      this.markRequest('error', 'IDE smoke check 失败', String(error))
      this.toast(String(error), 'error')
      this.renderProblems()
    }
  }

  private restoreAgentRuntimeFromSnapshot(snapshot: any) {
    const toolCalls = Array.isArray(snapshot?.toolCalls) ? snapshot.toolCalls : []
    const permissions = Array.isArray(snapshot?.pendingTools) ? snapshot.pendingTools : []
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
    this.state.agentRuntime.status = String(snapshot?.status || this.state.agentRuntime.status || 'idle')
    this.state.agentRuntime.phase = snapshot?.phase
    this.state.agentRuntime.phaseHistory = Array.isArray(snapshot?.phaseHistory) ? snapshot.phaseHistory.slice(-40) : []
    this.state.agentRuntime.resumeReason = String(snapshot?.resumeReason || '')
    this.state.agentRuntime.stepCount = Number(snapshot?.stepCount || 0)
    this.state.agentRuntime.compactionCount = Number(snapshot?.compactionCount || 0)
    this.state.agentRuntime.compactedSummary = snapshot?.compactedSummary || null
    this.state.agentRuntime.checkpoints = Array.isArray(snapshot?.checkpoints) ? snapshot.checkpoints.slice(-20) : []
    this.state.agentRuntime.memoryRefs = Array.isArray(snapshot?.memoryRefs) ? snapshot.memoryRefs.slice(-20) : []
    this.state.agentRuntime.subagents = Array.isArray(snapshot?.subagents)
      ? snapshot.subagents.slice(-20).map((item: any) => {
          const status = String(item?.status || '')
          return status === 'running' ? { ...item, status: 'failed', error: '上次运行异常中断，已停止恢复为执行中。' } : item
        })
      : []
    this.state.agentRuntime.processes = Array.isArray(snapshot?.processes)
      ? snapshot.processes.slice(-20).map((item: any) => {
          const status = String(item?.status || '')
          return status === 'running' ? { ...item, status: 'interrupted', error: '上次运行异常中断，已停止恢复为执行中。' } : item
        })
      : []
    this.state.agentRuntime.tools = Array.isArray(snapshot?.tools) ? snapshot.tools.slice(-40) : this.state.agentRuntime.tools
    this.state.agentRuntime.mcpTools = Array.isArray(snapshot?.mcpTools) ? snapshot.mcpTools.slice(-40) : this.state.agentRuntime.mcpTools
    const restoredPlanning = this.normalizeRestoredAgentRuntime(snapshot)
    this.state.agentRuntime.approvedPlan = restoredPlanning.approvedPlan
    this.state.agentRuntime.planTodos = restoredPlanning.planTodos
    this.state.agentRuntime.planningAnswers = restoredPlanning.planningAnswers
    this.state.agentRuntime.planningConfirmation = restoredPlanning.planningConfirmation
    this.state.agentRuntime.planDevelopment = restoredPlanning.planDevelopment
    const restoredSessionStatus = String(snapshot?.status || '')
    this.state.agentRuntime.timeline = toolCalls.map((call: any, index: number) => {
      const rawStatus = String(call.status || 'ok')
      const interrupted = rawStatus === 'running' || rawStatus === 'approval_required'
      return {
        id: String(call.id || `tool-restored-${index}`),
        name: String(call.name || call.tool || 'tool'),
        status: rawStatus === 'error' || interrupted ? 'error' as const : 'ok' as const,
        input: call.input || {},
        output: call.output,
        error: String(call.error || (interrupted ? `会话已${restoredSessionStatus === 'cancelled' ? '停止' : '恢复'}，该工具未收到完成事件。` : '')),
        startedAt: String(call.startedAt || call.started_at || snapshot.updatedAt || new Date().toISOString()),
        finishedAt: String(call.finishedAt || call.finished_at || snapshot.updatedAt || new Date().toISOString()),
      }
    }).slice(-80)
    this.state.agentRuntime.pendingPermissions = permissions.map((item: any) => ({
      id: String(item.id || `permission-restored-${Date.now()}`),
      kind: (String(item.tool || '').includes('bash') ? 'command' : 'write') as 'command' | 'write',
      target: String(item.input?.command || item.input?.path || item.tool || ''),
      reason: '恢复的待确认 Agent 工具调用。',
      risk: 'medium' as const,
    })).slice(-20)
    const existingKeys = new Set(this.state.chat.map(item => `${item.role}\n${item.text}`))
    const restoredMessages = messages
      .slice(-18)
      .map((item: any, index: number) => ({
        id: `agent-${String(snapshot?.id || 'session')}-${index}`,
        role: String(item?.role || '') === 'assistant' ? 'assistant' as const : String(item?.role || '') === 'user' ? 'user' as const : 'system' as const,
        text: String(item?.content || item?.text || '').trim().slice(0, 60000),
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
      this.state.chat = [...welcome, ...nonSystem, ...restoredMessages].slice(-45)
    }
    this.repairInvalidQuestionWaitState()
    this.repairStaleAgentRuntime(String(snapshot?.resumeReason || '检测到上次 Agent 运行异常中断，已清理旧运行态。'))
  }

  private isQuestionPermissionLike(item: any) {
    const tool = String(item?.tool || item?.name || item?.kind || '').toLowerCase()
    const target = String(item?.target || item?.input?.target || item?.input?.path || item?.input?.command || '').toLowerCase()
    return tool === 'question' || target === 'question'
  }

  private hasPendingAgentQuestion() {
    const calls = [
      ...this.state.chat.flatMap(message => message.toolCalls || []),
      ...this.state.agentRuntime.timeline,
    ]
    return calls.some(call => {
      if (call.name !== 'question') return false
      const output = call.output as any
      return Boolean(output?.requiresUserResponse) && !Boolean(output?.answered)
    })
  }

  private repairInvalidQuestionWaitState() {
    const beforePermissionCount = this.state.agentRuntime.pendingPermissions.length
    this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions
      .filter(item => !this.isQuestionPermissionLike(item))
    this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(call => {
      if (call.status !== 'approval_required' || !this.isQuestionPermissionLike(call)) return call
      return {
        ...call,
        status: 'error' as const,
        error: '已忽略无效的 question 工具授权卡。question 应直接显示为需要回答的提问，而不是写入审批。',
        finishedAt: call.finishedAt || new Date().toISOString(),
      }
    })
    this.state.chat = this.state.chat.map(message => ({
      ...message,
      pendingPermissions: message.pendingPermissions?.filter(item => !this.isQuestionPermissionLike(item)),
      toolCalls: message.toolCalls?.map(call => {
        if (call.status !== 'approval_required' || !this.isQuestionPermissionLike(call)) return call
        return {
          ...call,
          status: 'error' as const,
          error: '已忽略无效的 question 工具授权卡。',
          finishedAt: call.finishedAt || new Date().toISOString(),
        }
      }),
    }))
    if (this.state.agentRuntime.status === 'waiting_question' && !this.hasPendingAgentQuestion()) {
      this.state.agentRuntime.status = this.pendingAiRequest ? 'running' : 'completed'
      if (!this.pendingAiRequest) {
        this.state.agentRuntime.activeRequestId = ''
        this.state.agentRuntime.activeTurnId = ''
        this.clearAiFallback(true)
        this.markRequest('ok', '已清理无效等待状态', '检测到 question 被错误显示为写入审批，已恢复会话。')
      }
    } else if (beforePermissionCount !== this.state.agentRuntime.pendingPermissions.length && this.state.agentRuntime.status === 'waiting_permission' && !this.state.agentRuntime.pendingPermissions.length) {
      this.state.agentRuntime.status = this.pendingAiRequest ? 'running' : 'completed'
    }
  }

  private async refreshLocalServerStatus() {
    try {
      const status = await this.api.localServerStatus()
      const baseUrl = String(status?.baseUrl || '')
      const health = status?.ok && baseUrl ? await this.fetchLocalServerHealth(baseUrl) : null
      this.state.localServer = {
        ok: Boolean(status?.ok),
        host: String(status?.host || '127.0.0.1'),
        port: typeof status?.port === 'number' ? status.port : null,
        baseUrl,
        latestEventId: Number(status?.latestEventId || 0),
        name: String(health?.name || ''),
        version: String(health?.version || ''),
        capabilities: Array.isArray(health?.capabilities) ? health.capabilities.map(String) : [],
        checkedAt: health ? new Date().toISOString() : '',
        error: health?.error ? String(health.error) : '',
      }
      if (!this.agentEventSource && this.state.localServer.latestEventId) {
        this.lastAgentEventId = Math.max(this.lastAgentEventId, this.state.localServer.latestEventId)
      }
      if (this.state.localServer.ok) this.startLocalAgentEventStream()
      else window.setTimeout(() => void this.refreshLocalServerStatus(), 1000)
      this.renderAssistant()
      this.renderProblems()
    } catch {
      this.state.localServer = { ok: false, host: '127.0.0.1', port: null, baseUrl: '', latestEventId: 0, capabilities: [] }
      this.stopLocalAgentEventStream()
      window.setTimeout(() => void this.refreshLocalServerStatus(), 1500)
      this.renderProblems()
    }
  }

  private async copyLocalServerUrl() {
    const url = this.state.localServer.baseUrl
    if (!url) return this.toast('本地 Agent Server 尚未就绪', 'idle')
    await navigator.clipboard.writeText(url)
    this.toast('本地 Agent Server URL 已复制', 'ok')
  }

  private async fetchLocalServerHealth(baseUrl: string) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 1600)
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: controller.signal })
      if (!response.ok) throw new Error(`health returned ${response.status}`)
      return await response.json()
    } catch (error) {
      return { error: String(error), capabilities: [] }
    } finally {
      window.clearTimeout(timer)
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
        'agent_phase',
        'reasoning_delta',
        'permission_request',
        'patch_preview',
        'step_limit_reached',
        'context_compaction_start',
        'context_compaction_result',
        'context_compaction_error',
        'checkpoint_created',
        'checkpoint_reverted',
        'cancellation_requested',
        'memory_read',
        'memory_update_preview',
        'subagent_start',
        'subagent_result',
        'hook_start',
        'hook_result',
        'process_start',
        'process_output',
        'process_exit',
        'lsp_diagnostics',
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
    const normalizedRoot = displayPath(rootPath)
    if (!snapshot?.currentProject || displayPath(snapshot.currentProject.path) !== normalizedRoot) return
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
    this.state.chat = this.normalizeRestoredChat(snapshot.chat)
    this.state.contextChips = Array.isArray(snapshot.contextChips) ? snapshot.contextChips : []
    this.state.attachments = Array.isArray(snapshot.attachments)
      ? snapshot.attachments.filter(item => !item.transient && item.source !== 'voice-recording')
      : []
    const restoredAgentRuntime = this.normalizeRestoredAgentRuntime(snapshot.agentRuntime || {})
    this.state.agentRuntime = {
      ...this.state.agentRuntime,
      ...snapshot.agentRuntime,
      sessionId: '',
      activeTurnId: '',
      activeRequestId: '',
      queuedUserMessages: Array.isArray(snapshot.agentRuntime?.queuedUserMessages)
        ? this.normalizeRestoredQueuedMessages(snapshot.agentRuntime!.queuedUserMessages)
        : [],
      status: this.normalizeRestoredAgentStatus(String(snapshot.agentRuntime?.status || this.state.agentRuntime.status || 'idle')),
      thinking: snapshot.agentRuntime?.thinking || '',
      approvedPlan: restoredAgentRuntime.approvedPlan,
      planTodos: restoredAgentRuntime.planTodos,
      planningAnswers: restoredAgentRuntime.planningAnswers,
      planningConfirmation: restoredAgentRuntime.planningConfirmation,
      planDevelopment: restoredAgentRuntime.planDevelopment,
    }
    this.repairInvalidQuestionWaitState()
    this.state.terminal = {
      ...this.state.terminal,
      shell: snapshot.terminal?.shell || this.state.settings.default_shell || this.state.terminal.shell,
      cwd: normalizedRoot,
      running: false,
      health: 'idle',
      lastOutput: '',
      selection: '',
    }
    this.terminalCommandShell = this.state.terminal.shell || this.selectedTerminalShell()
    this.state.terminalSessionId = ''
    this.state.terminalSessions = []
    this.terminalOutputBuffer = ''
    this.terminalProbeSnapshots.clear()
    this.editor.setTab(this.activeTab())
    this.pendingSessionSnapshot = null
    this.renderAll()
  }

  private normalizeRestoredQueuedMessages(items: unknown[]) {
    return items
      .filter(item => item && typeof item === 'object')
      .map((item: any) => {
        const status = String(item.status || 'queued')
        if (status === 'queued' || status === 'processing') {
          return {
            ...item,
            status: 'failed',
            error: '从上次运行恢复的排队消息已停止自动消费，避免异常退出后串轮或卡死。可编辑后重新发送。',
          }
        }
        return item
      })
      .slice(-20)
  }

  private normalizeRestoredAgentStatus(status: string) {
    if (['running', 'compacting', 'cancelling'].includes(status)) return 'paused'
    if (status === 'waiting_permission' || status === 'waiting_question') return status
    return status || 'idle'
  }

  private normalizeRestoredChat(chat: unknown) {
    if (!Array.isArray(chat) || !chat.length) return this.state.chat
    const maxMessages = 40
    const maxTextChars = 60000
    return chat.slice(-maxMessages).map((raw, index) => {
      const item = raw && typeof raw === 'object' ? raw as any : {}
      const role = ['system', 'user', 'assistant', 'error'].includes(String(item.role)) ? item.role : 'system'
      const text = String(item.text || '')
      return {
        ...item,
        id: String(item.id || `restored-${Date.now()}-${index}`),
        role,
        text: text.length > maxTextChars ? `${text.slice(0, maxTextChars)}\n\n...[历史消息过长，已在启动恢复时截断]` : text,
        at: String(item.at || new Date().toISOString()),
        toolCalls: Array.isArray(item.toolCalls) ? item.toolCalls.slice(-18) : undefined,
        pendingPermissions: Array.isArray(item.pendingPermissions) ? item.pendingPermissions.slice(-4) : undefined,
        patchPreviews: Array.isArray(item.patchPreviews) ? item.patchPreviews.slice(-3) : undefined,
        attachments: Array.isArray(item.attachments) ? item.attachments.slice(0, 8) : undefined,
        queued: item.queued && ['queued', 'processing'].includes(String(item.queued.status || ''))
          ? { ...item.queued, status: 'failed' }
          : item.queued,
      }
    })
  }

  private scheduleSessionPersist() {
    if (this.sessionPersistTimer) window.clearTimeout(this.sessionPersistTimer)
    this.sessionPersistTimer = window.setTimeout(() => this.persistSessionSnapshot(), 150)
  }

  private scheduleAssistantRender(_reason = 'agent-event', immediate = false) {
    if (immediate) {
      this.cancelScheduledAssistantRender()
      this.renderAssistant()
      this.assistantRenderLastAt = this.nowForRenderThrottle()
      return
    }
    if (this.assistantRenderTimer || this.assistantRenderFrame) return
    const now = this.nowForRenderThrottle()
    const active = Boolean(this.pendingAiRequest || ['running', 'compacting', 'cancelling'].includes(this.state.agentRuntime.status))
    const minDelay = active ? 120 : 50
    const delay = Math.max(0, minDelay - (now - this.assistantRenderLastAt))
    this.assistantRenderTimer = window.setTimeout(() => {
      this.assistantRenderTimer = 0
      this.assistantRenderFrame = window.requestAnimationFrame(() => {
        this.assistantRenderFrame = 0
        this.renderAssistant()
        this.assistantRenderLastAt = this.nowForRenderThrottle()
      })
    }, delay)
  }

  private cancelScheduledAssistantRender() {
    if (this.assistantRenderTimer) window.clearTimeout(this.assistantRenderTimer)
    if (this.assistantRenderFrame) window.cancelAnimationFrame(this.assistantRenderFrame)
    this.assistantRenderTimer = 0
    this.assistantRenderFrame = 0
  }

  private nowForRenderThrottle() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
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
      chat: this.state.chat.slice(-40),
      contextChips: this.state.contextChips,
      attachments: this.state.attachments
        .filter(item => !item.transient && item.source !== 'voice-recording')
        .map(item => ({
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
        checkpoints: this.state.agentRuntime.checkpoints.slice(-20),
        sessions: this.state.agentRuntime.sessions.slice(-20),
        subagents: this.state.agentRuntime.subagents.slice(-20),
        processes: this.state.agentRuntime.processes.slice(-20),
        hooks: this.state.agentRuntime.hooks.slice(-40),
        smokeChecks: this.state.agentRuntime.smokeChecks.slice(-20),
        tools: this.state.agentRuntime.tools.slice(-40),
        mcpTools: this.state.agentRuntime.mcpTools.slice(-40),
        diagnostics: this.state.agentRuntime.diagnostics.slice(-80),
      },
      terminal: {
        ...this.state.terminal,
        running: false,
        health: 'idle',
        lastOutput: '',
      },
      terminalSessionId: '',
      terminalSessions: [],
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
      this.fileReferenceIndexCache = null
      this.updateEditorCompletions()
      this.renderAll()
      void this.refreshWorkspaceFileIndex(true)
      void this.refreshGit()
    } catch (error) {
      this.state.workspace.tree = []
      this.renderTreeError(String(error))
      this.toast(String(error), 'error')
    }
  }

  private async refreshWorkspaceFileIndex(force = false) {
    const root = this.currentRoot()
    if (!root || this.workspaceFileIndexLoading) return
    if (!force && this.workspaceFileIndexCache?.root === root && Date.now() - this.workspaceFileIndexCache.loadedAt < 60000) return
    this.workspaceFileIndexLoading = true
    try {
      const value = await this.api.workspaceFileIndex(root, 8000)
      if (root !== this.currentRoot()) return
      this.workspaceFileIndexCache = { root, value, loadedAt: Date.now() }
      this.fileReferenceIndexCache = null
      const input = this.$<HTMLTextAreaElement>('#task-prompt')
      if (input) this.updateComposerSuggestions(input)
      this.renderAssistant()
    } catch (error) {
      console.warn('[AutoCode] workspace file index failed', error)
    } finally {
      this.workspaceFileIndexLoading = false
    }
  }

  private renderTreeError(message: string) {
    const tree = this.$('#file-tree')
    if (!tree) return
    tree.innerHTML = `
      <div class="empty-hint error">
        <strong>工作区文件加载失败</strong>
        <span>${escapeHtml(message || '未知错误')}</span>
        <button class="secondary-button" id="refresh-workspace">重新加载</button>
      </div>
    `
    this.renderWorkspace()
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
      void this.refreshGit()
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
    void this.refreshGit()
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
    if (this.editorSavePath === tab.path && this.editorSaveState !== 'saving') {
      this.editorSaveState = 'idle'
      this.editorSavePath = ''
    }
    this.renderTabs()
    this.renderEditorStatus()
    this.scheduleSessionPersist()
  }

  private async saveActiveFile() {
    const tab = this.activeTab()
    if (!tab) {
      this.toast('请先打开一个文件', 'idle')
      return
    }
    this.setEditorSaveState('saving', tab.path)
    try {
      const wasDirty = dirty(tab)
      let content = tab.draft
      let formattedBy = ''
      try {
        const formatted = await this.api.formatWorkspaceContent(this.currentRoot(), tab.path, tab.draft, tab.lineEnding)
        if (typeof formatted?.content === 'string') {
          content = formatted.content
          formattedBy = String(formatted.formatter || '')
          if (content !== tab.draft) {
            tab.draft = content
            this.editor.setTab(tab)
            this.renderEditorStatus()
          }
        }
      } catch (formatError) {
        this.toast(`格式化失败，已继续保存原内容：${String(formatError)}`, 'idle')
      }
      const changedByFormat = content !== tab.original
      if (!wasDirty && !changedByFormat) {
        this.toast(`无需保存，${tab.name} 已是最新`, 'idle')
        this.setEditorSaveState('idle', tab.path)
        return
      }
      try {
        const sessionId = await this.ensureAgentSession()
        if (sessionId) {
          const checkpoint = await this.api.agentCheckpointCreate(sessionId, `保存前：${tab.path}`, [tab.path])
          this.state.agentRuntime.checkpoints = [
            ...this.state.agentRuntime.checkpoints.filter((item: any) => String(item?.id || '') !== String(checkpoint?.id || '')),
            checkpoint,
          ].slice(-20)
        }
      } catch {
        // 保存不能因为 checkpoint 失败而中断；Git diff 仍会显示当前变更。
      }
      const saved = await invoke<WorkspaceFileSnapshot>('ide_save_workspace_file', {
        rootPath: this.currentRoot(),
        path: tab.path,
        content,
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
      this.toast(formattedBy ? `已保存并格式化 ${tab.name}（${formattedBy}）` : `已保存 ${tab.name}`, 'ok')
      this.setEditorSaveState('ok', tab.path)
      this.fileReferenceIndexCache = null
      this.renderEditor()
      this.scheduleSessionPersist()
      await this.autoStageChangedPaths([tab.path], '保存后已加入 Git 跟踪')
    } catch (error) {
      this.setEditorSaveState('error', tab.path)
      this.toast(String(error), 'error')
    }
  }

  private setEditorSaveState(state: 'idle' | 'saving' | 'ok' | 'error', path = this.activeTab()?.path || '') {
    if (this.editorSaveTimer) {
      window.clearTimeout(this.editorSaveTimer)
      this.editorSaveTimer = 0
    }
    this.editorSaveState = state
    this.editorSavePath = path
    this.renderEditorStatus()
    if (state === 'ok' || state === 'error') {
      this.editorSaveTimer = window.setTimeout(() => {
        if (this.editorSavePath === path && this.editorSaveState === state) {
          this.editorSaveState = 'idle'
          this.editorSavePath = ''
          this.renderEditorStatus()
        }
      }, state === 'ok' ? 1200 : 2000)
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

  private async refreshOpenTabs(paths?: string[]) {
    if (!this.currentRoot()) return
    const wanted = new Set((paths || []).map(path => this.normalizeWorkspacePath(path)).filter(Boolean))
    const tabs = this.state.workspace.tabs.filter(tab => !wanted.size || wanted.has(this.normalizeWorkspacePath(tab.path)))
    for (const tab of tabs) {
      if (dirty(tab)) {
        this.toast(`文件已在磁盘更新，但 ${tab.path} 有未保存内容，请手动合并或重新载入`, 'error')
        continue
      }
      try {
        const file = await invoke<WorkspaceFileSnapshot>('ide_read_workspace_file', { rootPath: this.currentRoot(), path: tab.path })
        Object.assign(tab, {
          draft: file.content,
          original: file.content,
          encoding: file.encoding,
          lineEnding: file.line_ending,
          modifiedAt: file.modified_at,
          size: file.size,
        })
      } catch {
        // Deleted files or permission errors are reflected by workspace refresh/Git status.
      }
    }
    this.editor.setTab(this.activeTab())
    this.renderEditor()
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
      this.terminalProbeSnapshots.set(info.session_id, info.probe_output || '')
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
      this.applyLayout(false)
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
      this.startTerminalOutputPolling()
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
    this.applyLayout(false)
    this.switchDock('terminal')
    this.terminal.clear()
    this.terminal.writeln(`AutoCode IDE terminal: ${resolvedShell}`)
    this.terminal.writeln(`cwd: ${this.terminalCommandCwd}`)
    this.renderCommandLine()
    this.terminal.fit()
    this.terminal.focus()
    this.renderTerminalSessions()
    this.scheduleSessionPersist()
    this.startTerminalOutputPolling()
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

  private startTerminalOutputPolling() {
    if (this.terminalPollTimer) return
    this.terminalPollTimer = window.setInterval(() => void this.pollActiveTerminalOutput(), 450)
  }

  private stopTerminalOutputPollingIfIdle() {
    if (!this.terminalPollTimer) return
    if (this.state.terminalSessions.some(item => item.health !== 'idle')) return
    window.clearInterval(this.terminalPollTimer)
    this.terminalPollTimer = 0
  }

  private async pollActiveTerminalOutput() {
    const sessionId = this.state.terminalSessionId
    if (!sessionId || this.terminalCommandMode) return
    try {
      const probe = await invoke<any>('ide_pty_probe', { sessionId })
      const lastOutput = String(probe?.lastOutput || '')
      const previous = this.terminalProbeSnapshots.get(sessionId) || ''
      if (lastOutput && lastOutput !== previous) {
        let delta = ''
        if (lastOutput.startsWith(previous)) {
          delta = lastOutput.slice(previous.length)
        } else if (previous && previous.endsWith(lastOutput)) {
          delta = ''
        } else {
          delta = this.cleanTerminalProbeOutput(lastOutput)
          this.terminal.clear()
          this.terminal.writeln(`AutoCode IDE terminal: ${probe?.shell || this.state.terminal.shell}`)
          this.terminal.writeln(`cwd: ${probe?.cwd || this.state.terminal.cwd || this.currentRoot()}`)
        }
        this.terminalProbeSnapshots.set(sessionId, lastOutput)
        if (delta) {
          this.terminalLastOutputAt = Date.now()
          this.terminalOutputBuffer = `${this.terminalOutputBuffer}${delta}`.slice(-12000)
          this.state.terminal.lastOutput = this.terminalOutputBuffer
          this.state.terminal.health = 'ready'
          const record = this.state.terminalSessions.find(item => item.id === sessionId)
          if (record) {
            record.lastOutput = `${record.lastOutput}${delta}`.slice(-20000)
            record.health = 'ready'
            record.cwd = String(probe?.cwd || record.cwd)
          }
          this.terminal.write(delta)
          this.renderProblems()
        }
      }
      if (probe?.cwd) this.state.terminal.cwd = String(probe.cwd)
      if (probe?.shell) this.state.terminal.shell = String(probe.shell)
    } catch {
      // The session may have exited between ticks; exit events or killTerminal will update UI state.
    }
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
      this.stopTerminalOutputPollingIfIdle()
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

  private async refreshGit(force = false) {
    if (!this.currentRoot()) return
    const root = this.currentRoot()!
    const now = Date.now()
    if (!force && this.state.workspace.git && now - this.gitLastRefreshAt < 6000) {
      this.renderGit(this.state.workspace.git)
      return
    }
    if (this.gitRefreshInFlight) {
      if (force) this.toast('Git 状态正在刷新，请稍候...', 'idle')
      return this.gitRefreshInFlight
    }
    this.gitStatusRefreshing = true
    const summary = this.$('#git-summary')
    const fileList = this.$('#git-file-list')
    const diff = this.$('#git-diff')
    if (this.state.workspace.git) {
      this.renderGit(this.state.workspace.git)
    } else {
      if (summary) summary.innerHTML = '<strong>正在加载 Git 状态...</strong><span>首次读取只加载文件列表、计数和最近提交。</span>'
      if (fileList) fileList.innerHTML = '<div class="empty-hint">正在刷新变更列表...</div>'
      if (diff) diff.textContent = ''
    }
    this.gitRefreshInFlight = (async () => {
      try {
        const git = await invoke<WorkspaceGitStatus>('ide_git_status', { rootPath: root })
        if (root !== this.currentRoot()) return
        this.state.workspace.git = git
        this.gitLastRefreshAt = Date.now()
        this.renderGit(git)
        this.renderEditorStatus()
      } catch (error) {
        if (root !== this.currentRoot()) return
        const message = String(error)
        const git: WorkspaceGitStatus = {
          branch: 'Git 不可用',
          ahead: 0,
          behind: 0,
          repository: false,
          staged_count: 0,
          unstaged_count: 0,
          untracked_count: 0,
          summary: message,
          repository_message: message,
          diff: '',
          staged_diff: '',
          unstaged_diff: '',
          status_short: message,
          files: [],
          untracked_files: [],
        }
        this.state.workspace.git = git
        this.gitLastRefreshAt = Date.now()
        this.renderGit(git)
        this.renderEditorStatus()
      } finally {
        this.gitStatusRefreshing = false
        this.gitRefreshInFlight = null
        if (this.state.workspace.git && root === this.currentRoot()) this.renderGit(this.state.workspace.git)
      }
    })()
    return this.gitRefreshInFlight
  }

  private async initializeGitRepository() {
    const root = this.currentRoot()
    if (!root) {
      this.toast('请先打开项目', 'idle')
      return
    }
    try {
      this.toast('正在初始化 Git 仓库...', 'busy')
      await this.api.gitInit(root)
      const git = await this.api.gitStage(root, [])
      this.state.workspace.git = git
      this.gitDiffFocusPath = ''
      this.renderGit(git)
      this.renderEditorStatus()
      await this.refreshWorkspace(true)
      this.toast('Git 仓库已初始化，当前文件已加入跟踪', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async stageGitChanges(paths: string[] = [], button?: HTMLElement) {
    const root = this.currentRoot()
    if (!root) return this.toast('请先打开项目', 'idle')
    try {
      this.gitOperationState = 'busy'
      this.gitOperationMessage = paths.length ? `正在后台暂存 ${paths.length} 个文件...` : '正在后台跟踪全部变更，界面仍可继续操作...'
      if (this.state.workspace.git) this.renderGit(this.state.workspace.git)
      this.setInlineActionFeedback(button, 'loading', paths.length ? '暂存中...' : '跟踪中...')
      const git = await this.api.gitStage(root, paths)
      this.state.workspace.git = git
      this.renderGit(git)
      this.renderEditorStatus()
      const skippedPaths = git.skipped_paths || []
      if (!paths.length && git.staged_count === 0 && (git.unstaged_count + git.untracked_count) > 0 && !skippedPaths.length) {
        this.gitOperationState = 'error'
        this.gitOperationMessage = `跟踪全部变更未生效：仍有 ${git.untracked_count} 个未跟踪、${git.unstaged_count} 个未暂存文件。`
        this.renderGit(git)
        this.setInlineActionFeedback(button, 'error', '未生效')
        this.toast(`跟踪全部变更未生效：仍有 ${git.untracked_count} 个未跟踪、${git.unstaged_count} 个未暂存文件`, 'error')
        return
      }
      this.gitOperationState = 'ok'
      this.gitOperationMessage = skippedPaths.length
        ? `已处理可安全跟踪的文件，跳过 ${skippedPaths.length} 个大型目录或嵌套 Git 仓库：${skippedPaths.join('、')}。`
        : paths.length ? `已暂存 ${paths.length} 个文件。` : `已跟踪全部变更：暂存 ${git.staged_count} / 未暂存 ${git.unstaged_count} / 未跟踪 ${git.untracked_count}。`
      this.renderGit(git)
      this.setInlineActionFeedback(button, 'ok', paths.length ? '已暂存' : '已跟踪')
      this.toast(paths.length ? `已暂存 ${paths.length} 个文件` : '已跟踪全部变更', 'ok')
    } catch (error) {
      this.gitOperationState = 'error'
      this.gitOperationMessage = `Git 跟踪失败：${String(error)}`
      if (this.state.workspace.git) this.renderGit(this.state.workspace.git)
      this.setInlineActionFeedback(button, 'error', '失败')
      this.toast(String(error), 'error')
    }
  }

  private async unstageGitChanges(paths: string[] = [], button?: HTMLElement) {
    const root = this.currentRoot()
    if (!root) return this.toast('请先打开项目', 'idle')
    try {
      this.setInlineActionFeedback(button, 'loading', '取消中...')
      const git = await this.api.gitUnstage(root, paths)
      this.state.workspace.git = git
      this.renderGit(git)
      this.renderEditorStatus()
      this.setInlineActionFeedback(button, 'ok', '已取消')
      this.toast(paths.length ? `已取消暂存 ${paths.length} 个文件` : '已取消全部暂存', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '失败')
      this.toast(String(error), 'error')
    }
  }

  private async commitStagedChanges(button?: HTMLElement) {
    const root = this.currentRoot()
    if (!root) return this.toast('请先打开项目', 'idle')
    const input = this.$<HTMLInputElement>('#git-commit-message')
    const message = (input?.value || '').trim()
    if (!message) return this.toast('请先填写提交说明', 'idle')
    try {
      this.setInlineActionFeedback(button, 'loading', '提交中...')
      const git = await this.api.gitCommit(root, message)
      if (input) input.value = ''
      this.state.workspace.git = git
      this.gitDiffFocusPath = ''
      this.renderGit(git)
      this.renderEditorStatus()
      this.setInlineActionFeedback(button, 'ok', '已提交')
      this.toast(`已提交：${message}`, 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '提交失败')
      this.toast(String(error), 'error')
    }
  }

  private async autoStageChangedPaths(paths: string[], successMessage = '变更已加入 Git 跟踪') {
    const clean = [...new Set(paths.map(path => this.resolveWorkspaceMessagePath(path)).filter(Boolean))]
    const git = this.state.workspace.git
    if (!this.currentRoot() || !clean.length) {
      await this.refreshGit()
      return
    }
    if (git?.repository !== true) {
      await this.refreshGit()
      return
    }
    try {
      const next = await this.api.gitStage(this.currentRoot()!, clean)
      this.state.workspace.git = next
      this.renderGit(next)
      this.renderEditorStatus()
      this.toast(successMessage, 'ok')
    } catch (error) {
      await this.refreshGit()
      this.toast(`Git 自动跟踪失败：${String(error)}`, 'error')
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
    this.ensureProviderChannels()
    this.state.providerCatalog.loading = true
    this.state.providerCatalog.error = ''
    this.renderProviderStatus()
    const enabled = this.state.settings.channels.filter(channel => channel.enabled)
    const errors: string[] = []
    let refreshed = 0
    for (const channel of enabled) {
      try {
        const hadExplicitSelection = channel.model_filter_configured === true
        const data = await this.api.channelRefreshModels(channel.id)
        channel.models = this.extractModelNames(data)
        if (!hadExplicitSelection) channel.enabled_models = [...channel.models]
        channel.model_filter_configured = true
        if (!channel.default_model && channel.models[0]) channel.default_model = channel.models[0]
        await this.api.channelSave(channel)
        refreshed += 1
      } catch (error) {
        channel.last_error = String(error)
        errors.push(`${channel.name || channel.id}: ${String(error)}`)
      }
    }
    this.state.providerCatalog.models = this.aggregateProviderModels()
    this.state.providerCatalog.updatedAt = new Date().toISOString()
    this.state.providerCatalog.error = errors.join('\n')
    this.state.providerCatalog.loading = false
    this.toast(errors.length ? `已刷新 ${refreshed} 个渠道，${errors.length} 个失败` : `已刷新 ${refreshed} 个渠道、${this.state.providerCatalog.models.length} 个去重模型`, errors.length ? 'error' : 'ok')
    this.renderChannels()
    this.renderProviderStatus()
    this.renderComposer()
  }

  private async refreshProviderAccount() {
    this.ensureProviderChannels()
    this.state.providerCatalog.accountLoading = true
    this.state.providerCatalog.error = ''
    this.renderProviderStatus()
    const enabled = this.state.settings.channels.filter(channel => channel.enabled)
    const summaries: string[] = []
    const errors: string[] = []
    for (const channel of enabled) {
      try {
        const timeout = new Promise((_, reject) => window.setTimeout(() => reject(new Error('账户查询超时')), 15000))
        const data = await Promise.race([this.api.channelAccountStatus(channel.id), timeout])
        channel.account_status = this.describeAccountStatus(data)
        this.replaceChannel(await this.api.channelSave(channel))
        summaries.push(`${channel.name}: ${channel.account_status}`)
      } catch (error) {
        channel.last_error = String(error)
        errors.push(`${channel.name}: ${String(error)}`)
      }
    }
    this.state.providerCatalog.account = summaries.length ? summaries.join('；') : '无可查询渠道'
    this.state.providerCatalog.error = errors.join('\n')
    this.state.providerCatalog.updatedAt = new Date().toISOString()
    this.state.providerCatalog.accountLoading = false
    this.toast(errors.length ? '部分渠道账户查询失败' : '渠道账户状态已刷新', errors.length ? 'error' : 'ok')
    this.renderChannels()
    this.renderProviderStatus()
  }

  private extractModelNames(data: any): string[] {
    const source = Array.isArray(data) ? data : data?.data || data?.models || data?.items || data?.result || []
    if (!Array.isArray(source)) return []
    return [...new Set(source.map((item: any) => String(item?.id || item?.model || item?.name || item || '').trim()).filter(Boolean))].slice(0, 300)
  }

  private describeAccountStatus(data: any) {
    if (!data?.supported) return data?.message || '该 Provider 不支持通过当前 Key 查询余额。'
    const raw = data.data || data
    const formatValue = (value: any) => {
      if (value === undefined || value === null || value === '') return ''
      return typeof value === 'number' ? String(value) : String(value)
    }
    const balances = raw.balance_infos || raw.balances || raw.data || raw.items
    if (Array.isArray(balances)) {
      const rows = balances.map((item: any) => {
        const label = item.currency || item.name || item.model || item.type || '余额'
        const total = formatValue(item.total_balance ?? item.balance ?? item.amount ?? item.available_balance ?? item.remaining_credit)
        const topped = formatValue(item.topped_up_balance ?? item.cash_balance ?? item.recharge_balance)
        const granted = formatValue(item.granted_balance ?? item.free_balance ?? item.voucher_balance)
        const parts = [
          total ? `总余额 ${total}` : '',
          topped ? `充值 ${topped}` : '',
          granted ? `赠送 ${granted}` : '',
        ].filter(Boolean)
        return `${label}${parts.length ? `：${parts.join('，')}` : ''}`
      }).filter(Boolean)
      const available = raw.is_available === true ? '账户可用' : raw.is_available === false ? '账户不可用' : ''
      return [available, ...rows].filter(Boolean).join(' · ') || '账户状态已返回，但未识别到余额字段。'
    }
    const direct = raw.total_balance ?? raw.balance ?? raw.available_balance ?? raw.remaining_credit ?? raw.credit ?? raw.quota
    if (direct !== undefined && direct !== null && direct !== '') return `余额：${formatValue(direct)}`
    if (raw.message) return String(raw.message)
    if (typeof raw === 'string') return raw
    const pairs = Object.entries(raw)
      .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      .slice(0, 6)
      .map(([key, value]) => `${key}: ${String(value)}`)
    return pairs.length ? pairs.join(' · ') : '账户状态已返回，但未识别到余额字段。'
  }

  private displayAccountStatus(status: string) {
    const raw = String(status || '').trim()
    if (!raw) return ''
    if (!/^[{[]/.test(raw)) return raw
    try {
      return this.describeAccountStatus(JSON.parse(raw))
    } catch {
      return raw
    }
  }

  private markRequest(state: AppState['requestTimeline']['state'], title: string, detail = '') {
    const now = Date.now()
    const previous = this.state.requestTimeline
    const startedAt = state === 'busy'
      ? (previous.state === 'busy' && previous.startedAt ? previous.startedAt : now)
      : previous.startedAt
    this.state.requestTimeline = {
      ...previous,
      state,
      title,
      detail,
      startedAt,
      durationMs: state === 'busy' ? Math.max(0, now - (startedAt || now)) : now - (startedAt || now),
      error: state === 'error' ? detail : '',
    }
    this.syncRequestTimelineTicker()
    this.renderRequestTimeline()
    this.state.apiMessage = title
    this.state.apiState = state === 'busy' ? 'busy' : state === 'error' ? 'error' : 'ok'
    const dot = this.$('.status-dot')
    if (dot) dot.className = `status-dot ${this.state.apiState}`
    this.text('#api-status', this.state.apiState === 'ok' ? '正常' : this.state.apiState === 'error' ? '异常' : '请求中')
  }

  private syncRequestTimelineTicker() {
    const busy = this.state.requestTimeline.state === 'busy'
    if (busy && !this.requestTimelineTicker) {
      this.requestTimelineTicker = window.setInterval(() => {
        if (this.state.requestTimeline.state !== 'busy') {
          this.syncRequestTimelineTicker()
          return
        }
        const startedAt = this.state.requestTimeline.startedAt || Date.now()
        this.state.requestTimeline.durationMs = Math.max(0, Date.now() - startedAt)
        this.renderRequestTimeline()
      }, 1000)
      return
    }
    if (!busy && this.requestTimelineTicker) {
      window.clearInterval(this.requestTimelineTicker)
      this.requestTimelineTicker = 0
    }
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
    const payload = (event.payload || {}) as any
    const turnScoped = this.isTurnScopedAgentEvent(String(event.type || ''))
    const eventRequestId = String(payload.requestId || payload.request_id || '')
    const activeRequestId = String(this.state.agentRuntime.activeRequestId || this.pendingAiRequest?.requestId || '')
    const eventAt = Date.parse(String(event.at || '')) || 0
    if (
      turnScoped
      && this.pendingAiRequest
      && !eventRequestId
      && eventAt > 0
      && this.activeTurnStartedAt > 0
      && eventAt < this.activeTurnStartedAt - 1000
    ) {
      return
    }
    const debugOnly = Boolean(turnScoped && activeRequestId && !eventRequestId)
    if (turnScoped && activeRequestId && eventRequestId && eventRequestId !== activeRequestId) return
    if (turnScoped && eventRequestId && this.completedAgentRequestIds.includes(eventRequestId)) {
      const doneStatus = String(payload.status || payload.finishReason || payload.finish_reason || payload.response?.finishReason || payload.response?.finish_reason || '')
      if (event.type !== 'session_done' && event.type !== 'done') return
      if (!/cancel/i.test(doneStatus)) return
    }
    if (turnScoped && !eventRequestId && !this.pendingAiRequest && String(this.state.agentRuntime.status || '') === 'cancelled') return
    this.state.agentRuntime.events.push(event)
    this.state.agentRuntime.events = this.state.agentRuntime.events.slice(-300)
    if (debugOnly) {
      this.scheduleSessionPersist()
      return
    }
    if (event.type === 'agent_phase') {
      const now = Date.now()
      const started = Date.parse(String(payload.startedAt || event.at || '')) || now
      const phase = {
        phase: String(payload.phase || 'running'),
        status: String(payload.status || 'running'),
        label: this.repairMojibakeText(String(payload.label || 'Agent 执行中')),
        detail: this.repairMojibakeText(String(payload.detail || '')),
        startedAt: String(payload.startedAt || event.at || new Date().toISOString()),
        durationMs: Number(payload.durationMs || Math.max(0, now - started)),
        at: event.at,
      }
      this.state.agentRuntime.phase = phase
      this.state.agentRuntime.phaseHistory = [
        ...this.state.agentRuntime.phaseHistory.filter(item => item.phase !== phase.phase || item.status !== phase.status),
        phase,
      ].slice(-40)
      const route = this.activeProviderLabel('agent')
      this.markRequest(
        phase.status === 'error' ? 'error' : phase.status === 'done' ? 'ok' : 'busy',
        phase.label,
        phase.detail || route.text,
      )
      this.attachRuntimeToolsToActiveMessage()
      this.bumpAiFallbackTimer()
      this.scheduleAssistantRender('agent_phase')
      this.scheduleSessionPersist()
      return
    }
    if (event.type === 'message_part' || event.type === 'message_delta') {
      const role = String(payload.role || 'assistant')
      const content = payload.content ?? payload.delta ?? payload.text ?? payload.message ?? ''
      if (role === 'assistant' && content) {
        this.acceptAssistantStreamDelta(String(content), event.type === 'message_part')
      }
      return
    }
    if (event.type === 'reasoning_delta') {
      this.state.agentRuntime.thinking = `${this.state.agentRuntime.thinking}${String(payload.content || '')}`.slice(-8000)
      this.activeTurnReasoning = `${this.activeTurnReasoning}${String(payload.content || '')}`.slice(-8000)
      this.state.requestTimeline.reasoning = this.state.agentRuntime.thinking
      this.attachRuntimeToolsToActiveMessage()
      // 推理正在流出，说明链路存活：续期看门狗，避免误触发无工具兜底
      this.bumpAiFallbackTimer()
      this.renderRequestTimeline()
      this.scheduleAssistantRender('reasoning_delta')
      this.scheduleSessionPersist()
      return
    }
    if (event.type === 'tool_call_start' || event.type === 'tool_start') {
      this.hideActiveToolProtocolMessage()
      this.pendingToolProtocolBuffer = ''
      const isSubagentTool = Boolean(payload.subagent)
      const call: ToolCallRecord = {
        id: String(payload.id || `tool-${Date.now()}`),
        name: String(payload.name || 'tool'),
        status: 'running',
        input: payload.input || {},
        output: payload.output,
        error: '',
        startedAt: event.at,
        internal: payload.internal === true,
        patchDiagnostics: payload.patchDiagnostics || payload.diagnostics,
        subagent: isSubagentTool,
        subagentId: String(payload.subagentId || payload.subagent_id || ''),
      }
      if (isSubagentTool) {
        this.upsertSubagentTool(call)
        this.bumpAiFallbackTimer()
        this.scheduleAssistantRender('subagent_tool_start')
        this.scheduleSessionPersist()
        return
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
      const isSubagentTool = Boolean(payload.subagent)
      const input = payload.input || {}
      const existing = this.state.agentRuntime.timeline.find(item => item.id === id)
        || [...this.state.agentRuntime.timeline].reverse().find(item =>
          item.status === 'running'
          && item.name === String(payload.name || 'tool')
          && this.stableToolInput(item.input) === this.stableToolInput(input),
        )
      const resolvedId = existing?.id || id
      const finalStatus = String(payload.status || 'ok') === 'error' ? 'error' : 'ok'
      const next: ToolCallRecord = {
        id: resolvedId,
        name: String(payload.name || existing?.name || 'tool'),
        status: finalStatus,
        input: input || existing?.input || {},
        output: payload.output,
        error: String(payload.error || ''),
        startedAt: existing?.startedAt || event.at,
        finishedAt: finalStatus === 'ok' || finalStatus === 'error' ? event.at : undefined,
        internal: Boolean(payload.internal || existing?.internal),
        patchDiagnostics: payload.patchDiagnostics || payload.diagnostics || existing?.patchDiagnostics,
        subagent: isSubagentTool,
        subagentId: String(payload.subagentId || payload.subagent_id || ''),
      }
      if (isSubagentTool) {
        this.upsertSubagentTool(next)
        this.bumpAiFallbackTimer()
        this.scheduleAssistantRender('subagent_tool_result')
        this.scheduleSessionPersist()
        return
      }
      this.state.agentRuntime.timeline = [
        ...this.state.agentRuntime.timeline.filter(item => item.id !== id && item.id !== resolvedId),
        next,
      ].slice(-80)
      if (next.name === 'todowrite' && finalStatus === 'ok') {
        this.syncPlanDevelopmentTodos(next)
      }
      if (next.name === 'question' && Boolean((next.output as any)?.answered)) {
        this.markAgentQuestionAnswered(resolvedId, String((next.output as any)?.answer || '已提交'))
        this.bumpAiFallbackTimer()
        this.scheduleAssistantRender('question_answered', true)
        this.scheduleSessionPersist()
        return
      }
      this.rememberActiveTurnTool(resolvedId, event)
      this.scheduleToolCompletion(resolvedId, finalStatus, event.at)
      this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== id && item.id !== resolvedId)
      if (next.name === 'apply_patch' && finalStatus === 'ok') {
        this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.filter(item => item.id !== id && item.id !== resolvedId)
        this.state.chat = this.state.chat.map(message => ({
          ...message,
          patchPreviews: message.patchPreviews?.filter(item => item.id !== id && item.id !== resolvedId),
        }))
      }
      this.attachRuntimeToolsToActiveMessage()
      if (['apply_patch', 'write', 'write_file'].includes(next.name)) {
        const changedPaths = Array.isArray((next.output as any)?.changed)
          ? (next.output as any).changed.map((item: any) => String(item?.path || '')).filter(Boolean)
          : [String((next.output as any)?.path || (next.input as any)?.path || '')].filter(Boolean)
        void this.refreshOpenTabs(changedPaths)
        void this.autoStageChangedPaths(changedPaths, 'Agent 修改已加入 Git 跟踪')
      }
      // 工具刚返回，ReAct 下一轮通常马上开始：续期看门狗
      this.bumpAiFallbackTimer()
      this.updateAgentDiagnostics()
    }
    if (event.type === 'permission_request') {
      this.hideActiveToolProtocolMessage()
      this.pendingToolProtocolBuffer = ''
      if (this.isQuestionPermissionLike(payload)) {
        this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => !this.isQuestionPermissionLike(item))
        this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(item =>
          item.id === String(payload.id || '') ? { ...item, status: 'error' as const, error: '已忽略无效的 question 工具授权卡。' } : item,
        )
        this.repairInvalidQuestionWaitState()
        this.scheduleAssistantRender('ignore_question_permission', true)
        this.scheduleSessionPersist()
        return
      }
      const rawKind = String(payload.kind || (String(payload.tool || payload.name || '') === 'mcp_call' ? 'tool' : 'write'))
      const decision = String(payload.decision || 'ask')
      const kind = (rawKind === 'read' || rawKind === 'command' || rawKind === 'tool' ? rawKind : 'write') as 'read' | 'write' | 'command' | 'tool'
      const permission = {
        id: String(payload.id || `permission-${Date.now()}`),
        kind,
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
      } else if (decision === 'ask') {
        this.rememberActiveTurnPermission(permission.id, event)
        this.state.agentRuntime.pendingPermissions.push(permission)
        this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.slice(-20)
        this.setAgentWaitingPhase('waiting_permission', '等待用户确认', permission.target || permission.reason)
        this.markRequest('busy', '等待用户确认', permission.target || permission.reason)
        this.notifyAgentWaiting('permission', permission.target || permission.reason, permission.id)
        this.clearAiFallback(false)
      } else {
        this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(item =>
          item.id === permission.id ? { ...item, status: 'ok' as const, error: '' } : item,
        )
      }
      this.attachRuntimeToolsToMessage(true)
      this.updateAgentDiagnostics()
    }
    if (event.type === 'patch_preview') {
      const preview = {
        id: String(payload.id || `patch-${Date.now()}`),
        patch: String(payload.patch || ''),
        files: Array.isArray(payload.files) ? payload.files : [],
        requiresApproval: payload.requiresApproval !== false,
        kind: String(payload.kind || 'patch'),
        patchKind: String(payload.patchKind || payload.patch_kind || ''),
        summary: String(payload.summary || ''),
        diagnostics: Array.isArray(payload.diagnostics) ? payload.diagnostics : [],
      }
      this.state.agentRuntime.patchPreviews = [
        ...this.state.agentRuntime.patchPreviews.filter(item => item.id !== preview.id),
        preview,
      ]
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.slice(-12)
      this.rememberActiveTurnPatch(preview.id, event)
      this.attachRuntimeToolsToMessage(true)
      this.syncLatestAgentPatchToDiffPanel()
      if (preview.requiresApproval) this.notifyAgentWaiting('patch', preview.summary || this.patchSummary(preview.patch), preview.id)
      this.updateAgentDiagnostics()
    }
    if (event.type === 'step_limit_reached') {
      this.state.agentRuntime.status = 'compacting'
      this.state.agentRuntime.stepCount = Number(payload.maxSteps || this.state.agentRuntime.stepCount || 0)
      this.markRequest(
        'busy',
        'Agent 达到步数上限',
        payload.autoContinue === false ? '已达到连续压缩上限，等待用户继续。' : '正在自动压缩上下文并继续执行。',
      )
      if (payload.autoContinue === false) this.notifyAgentWaiting('step', '达到最大执行步数，等待你点击继续。', String(payload.requestId || event.id || Date.now()))
      this.clearAiFallback(false)
    }
    if (event.type === 'context_compaction_start') {
      this.state.agentRuntime.status = 'compacting'
      this.markRequest('busy', '正在压缩上下文', String(payload.reason || '长任务继续执行前整理上下文。'))
      this.clearAiFallback(false)
    }
    if (event.type === 'context_compaction_result') {
      this.state.agentRuntime.status = 'running'
      this.state.agentRuntime.compactionCount = Math.max(this.state.agentRuntime.compactionCount, Number(payload.compactionCount || 0))
      this.state.agentRuntime.compactedSummary = payload
      this.attachRuntimeToolsToMessage(true)
      this.markRequest('busy', '上下文压缩完成', 'Agent 将基于摘要继续执行。')
      this.bumpAiFallbackTimer()
    }
    if (event.type === 'context_compaction_error') {
      this.state.agentRuntime.status = 'paused'
      this.markRequest('error', '上下文压缩失败', String(payload.message || event.payload || '未知错误'))
    }
    if (event.type === 'checkpoint_created') {
      this.state.agentRuntime.checkpoints = [
        ...this.state.agentRuntime.checkpoints.filter((item: any) => String(item?.id || '') !== String(payload.id || '')),
        payload,
      ].slice(-20)
      const checkpointId = String(payload.id || '')
      if (checkpointId && (this.pendingAiRequest || this.activeAssistantMessageId)) {
        if (!this.activeTurnCheckpointIds.includes(checkpointId)) {
          this.activeTurnCheckpointIds.push(checkpointId)
          this.activeTurnCheckpointIds = this.activeTurnCheckpointIds.slice(-20)
        }
        const message = this.activeAssistantMessageId
          ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
          : null
        if (message) this.attachRuntimeToolsToActiveMessage()
      }
      this.toast('已创建 Agent checkpoint', 'ok')
      this.updateAgentDiagnostics()
      void this.refreshGit()
      this.renderEditorStatus()
    }
    if (event.type === 'checkpoint_reverted') {
      this.state.agentRuntime.status = 'paused'
      this.toast('已回退到 checkpoint', 'ok')
      this.updateAgentDiagnostics()
      const restored = Array.isArray(payload.restored) ? payload.restored.map((item: any) => String(item?.path || '')).filter(Boolean) : []
      void this.refreshOpenTabs(restored)
      void this.refreshWorkspace(true)
    }
    if (event.type === 'cancellation_requested') {
      const cancelledRequestId = String(payload.requestId || this.state.agentRuntime.activeRequestId || this.pendingAiRequest?.requestId || '')
      this.state.agentRuntime.status = String(payload.status || 'cancelling')
      this.isolateCancelledAgentRequest(cancelledRequestId)
      if (this.state.agentRuntime.status === 'cancelled') {
        this.state.agentRuntime.pendingPermissions = []
      }
      const forced = payload.forced === true
      this.markRequest(
        this.state.agentRuntime.status === 'cancelled' ? 'ok' : 'busy',
        this.state.agentRuntime.status === 'cancelled'
          ? (forced ? 'Agent 已强制停止' : 'Agent 已停止')
          : 'Agent 正在收尾停止',
        String(payload.message || (this.state.agentRuntime.status === 'cancelled'
          ? '已停止并清理待审批操作。'
          : '已请求停止，等待当前步骤结束；可再次点击强制停止。')),
      )
      this.toast(String(payload.message || '已请求 Agent 停止'), this.state.agentRuntime.status === 'cancelled' ? 'ok' : 'busy')
      this.scheduleAssistantRender('cancellation_requested', true)
      this.renderComposer()
      this.scheduleSessionPersist()
    }
    if (event.type === 'memory_read') {
      this.state.agentRuntime.memoryRefs = Array.isArray(payload.files) ? payload.files : []
      this.updateAgentDiagnostics()
    }
    if (event.type === 'memory_update_preview') {
      const preview = {
        id: String(payload.id || `memory-${Date.now()}`),
        patch: String(payload.patch || ''),
        files: Array.isArray(payload.files) ? payload.files : [],
        requiresApproval: true,
        kind: 'memory',
      }
      this.state.agentRuntime.patchPreviews = [
        ...this.state.agentRuntime.patchPreviews.filter(item => item.id !== preview.id),
        preview,
      ]
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.slice(-12)
      this.rememberActiveTurnPatch(preview.id, event)
      this.attachRuntimeToolsToActiveMessage()
      this.markRequest('busy', 'Memory 更新待确认', '记忆文件修改需要审批后落盘。')
    }
    if (event.type === 'memory_update_applied') {
      this.toast('Memory 更新已应用', 'ok')
      if (this.currentRoot()) void this.api.agentMemoryRead(this.currentRoot()!)
      this.updateAgentDiagnostics()
    }
    if (event.type === 'subagent_start') {
      const id = String(payload.id || `subagent-${Date.now()}`)
      this.state.agentRuntime.subagents = [
        ...this.state.agentRuntime.subagents.filter((item: any) => String(item?.id || '') !== id),
        { ...payload, id, status: 'running', startedAt: event.at, tools: [] },
      ].slice(-20)
      this.markRequest('busy', `${String(payload.profileId || 'Subagent')} 子 Agent 执行中`, String(payload.task || ''))
      this.bumpAiFallbackTimer()
    }
    if (event.type === 'subagent_result') {
      const id = String(payload.id || `subagent-${Date.now()}`)
      const existing = this.state.agentRuntime.subagents.find((item: any) => String(item?.id || '') === id) as any
      this.state.agentRuntime.subagents = [
        ...this.state.agentRuntime.subagents.filter((item: any) => String(item?.id || '') !== id),
        { ...payload, id, status: 'completed', finishedAt: event.at, tools: this.subagentEvidenceTools(payload, existing?.tools || []) },
      ].slice(-20)
      this.markRequest('busy', `${String(payload.profileId || 'Subagent')} 子 Agent 完成`, String(payload.summary || '').slice(0, 180))
      this.bumpAiFallbackTimer()
    }
    if (event.type === 'process_start') {
      const id = String(payload.id || `process-${payload.pid || Date.now()}`)
      this.state.agentRuntime.processes = [
        ...this.state.agentRuntime.processes.filter((item: any) => String(item?.id || '') !== id),
        { ...payload, id, status: 'running', startedAt: payload.startedAt || event.at },
      ].slice(-20)
      this.updateAgentDiagnostics()
    }
    if (event.type === 'process_output') {
      const id = String(payload.id || `process-${payload.pid || Date.now()}`)
      const data = String(payload.data || '')
      this.state.agentRuntime.processes = this.state.agentRuntime.processes.map((item: any) => {
        if (String(item?.id || '') !== id) return item
        const lastOutput = `${String(item?.lastOutput || '')}${data}`.slice(-12000)
        return { ...item, lastOutput, lastOutputAt: event.at }
      })
      this.updateAgentDiagnostics()
    }
    if (event.type === 'process_exit') {
      const id = String(payload.id || `process-${payload.pid || Date.now()}`)
      this.state.agentRuntime.processes = this.state.agentRuntime.processes.map((item: any) =>
        String(item?.id || '') === id ? { ...item, ...payload, id, status: String(payload.status || 'exited'), finishedAt: payload.finishedAt || event.at } : item,
      )
      this.updateAgentDiagnostics()
    }
    if (event.type === 'process_start' || event.type === 'process_output' || event.type === 'process_exit' || event.type === 'lsp_diagnostics') {
      this.state.agentRuntime.diagnostics = [
        ...this.state.agentRuntime.diagnostics,
        { type: event.type, payload, at: event.at },
      ].slice(-80)
      this.updateAgentDiagnostics()
    }
    if (event.type === 'hook_start' || event.type === 'hook_result') {
      this.state.agentRuntime.hooks = [
        ...this.state.agentRuntime.hooks,
        { type: event.type, payload, at: event.at },
      ].slice(-40)
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
      const requestAtDone = this.pendingAiRequest
      if (eventRequestId) {
        this.completedAgentRequestIds.push(eventRequestId)
        this.completedAgentRequestIds = this.completedAgentRequestIds.slice(-80)
      }
      const response = payload.response || payload || {}
      if (response.provider || response.model) {
        const route = this.activeProviderLabel('agent')
        this.state.requestTimeline.model = `${response.provider || route.provider} / ${response.model || route.model || '默认模型'}`
      }
      if (response.usage) this.state.requestTimeline.usage = JSON.stringify(response.usage)
      if (response.reasoningSummary) this.state.requestTimeline.reasoning = response.reasoningSummary
      const streamed = this.activeAssistantMessageId ? this.state.chat.find(item => item.id === this.activeAssistantMessageId) : null
      const finalAnswer = String(response.answer || response.content || response.text || response.message || '').trim()
      const repeatedPreviousAnswer = this.isRepeatedPreviousAssistantAnswer(finalAnswer, requestAtDone)
      const pausedStepLimit = payload.status === 'paused_step_limit' || payload.paused === true || response.finishReason === 'step_limit_reached' || response.finish_reason === 'step_limit_reached'
      const cancelled = payload.status === 'cancelled' || response.finishReason === 'cancelled' || response.finish_reason === 'cancelled'
      const waitingQuestion = payload.status === 'waiting_question' || response.finishReason === 'waiting_question' || response.finish_reason === 'waiting_question'
      const pausedPatchFailed = payload.status === 'paused_patch_failed' || response.finishReason === 'paused_patch_failed' || response.finish_reason === 'paused_patch_failed'
      const providerFailed = payload.ok === false || Boolean(payload.error)
      const explicitWaitingStatus = payload.status === 'waiting_permission' || payload.status === 'waiting_question'
      const waitingForPermission = !providerFailed && (explicitWaitingStatus || this.state.agentRuntime.pendingPermissions.length > 0)
      const waitingForPatch = !providerFailed && !pausedPatchFailed && this.state.agentRuntime.patchPreviews.some(item => item.requiresApproval !== false)
      const waitingForApproval = waitingForPermission || waitingForPatch
      if (cancelled) this.state.agentRuntime.status = 'cancelled'
      else if (waitingQuestion) this.state.agentRuntime.status = 'waiting_question'
      else if (pausedStepLimit) this.state.agentRuntime.status = 'paused_step_limit'
      else if (pausedPatchFailed) this.state.agentRuntime.status = 'paused_patch_failed'
      else if (waitingForPermission) this.state.agentRuntime.status = 'waiting_permission'
      else if (waitingForPatch) this.state.agentRuntime.status = 'paused'
      else if (providerFailed) this.state.agentRuntime.status = 'failed'
      else this.state.agentRuntime.status = 'completed'
      this.repairInvalidQuestionWaitState()
      if (streamed && (streamed.text.trim() || streamed.toolCalls?.length)) {
        this.attachRuntimeToolsToActiveMessage()
        if (!waitingForApproval && !pausedStepLimit && !waitingQuestion && !pausedPatchFailed) {
          if (streamed.text.trim()) this.state.ai.history.push({ role: 'assistant', text: streamed.text, at: new Date().toISOString() })
          this.clearAiFallback(true)
        } else {
          this.clearAiFallback(waitingQuestion || pausedPatchFailed)
        }
      } else if (finalAnswer && !repeatedPreviousAnswer && !this.looksLikeToolProtocol(finalAnswer)) {
        this.acceptAssistantStreamDelta(finalAnswer, true)
        const finalMessage = this.activeAssistantMessageId
          ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
          : null
        if (finalMessage) {
          this.attachRuntimeToolsToActiveMessage()
        }
        if (!waitingForApproval && !pausedStepLimit && !waitingQuestion && !pausedPatchFailed) {
          this.state.ai.history.push({ role: 'assistant', text: finalAnswer, at: new Date().toISOString() })
          this.clearAiFallback(true)
        } else {
          this.clearAiFallback(waitingQuestion || pausedPatchFailed)
        }
      } else if (waitingForApproval || pausedStepLimit || waitingQuestion || pausedPatchFailed) {
        this.activeAssistantMessageId = ''
        this.clearAiFallback(waitingQuestion || pausedPatchFailed)
        this.ensureRuntimeActionCardsInThread()
        this.markRequest(
          pausedPatchFailed ? 'error' : 'busy',
          pausedPatchFailed ? 'Patch 应用失败' : waitingQuestion ? '等待你的回答' : pausedStepLimit ? 'Agent 已暂停' : waitingForPermission ? '等待用户确认' : 'Patch 待处理',
          pausedPatchFailed
            ? String(payload.error || payload.message || '已停止自动重试，请重新生成 Patch 或改用整文件写入。')
            : pausedStepLimit
            ? '达到最大执行步数并完成上下文压缩，点击继续后恢复执行。'
            : waitingQuestion
              ? '请直接在输入框回复，Agent 会把它作为上一轮问题的答案继续执行。'
              : waitingForPermission
              ? '请在当前 AI 回复里的审批卡继续。'
              : '请在当前 AI 回复里的 Patch 预览卡应用或忽略。',
        )
        this.scheduleAssistantRender('agent_waiting', true)
        this.scheduleSessionPersist()
        return
      } else if (this.pendingAiRequest && !this.aiFallbackRunning && !repeatedPreviousAnswer && !providerFailed && !cancelled) {
        this.activeAssistantMessageId = ''
        void this.runAiDisplayFallback('Agent 已完成但没有收到可见正文，正在从后端会话快照恢复。')
        this.scheduleAssistantRender('agent_fallback', true)
        this.scheduleSessionPersist()
        return
      } else if (repeatedPreviousAnswer) {
        this.activeAssistantMessageId = ''
        this.markQueuedMessages(requestAtDone?.queuedIds || [], 'failed', false, 'Provider 返回了上一轮重复答复，本轮已结束，可重试这条消息。')
        this.clearAiFallback(true)
        this.pendingAiRequest = null
        this.aiFallbackRunning = false
        this.state.agentRuntime.activeRequestId = ''
        this.state.agentRuntime.activeTurnId = ''
        this.state.agentRuntime.status = providerFailed ? 'failed' : 'completed'
      }
      if (!waitingForApproval && !pausedStepLimit && !pausedPatchFailed) this.activeAssistantMessageId = ''
      if (!waitingForApproval && !pausedStepLimit && !pausedPatchFailed && !waitingQuestion && !cancelled && !repeatedPreviousAnswer) {
        this.markQueuedMessages(requestAtDone?.queuedIds || [], 'consumed', true)
      } else if (cancelled || providerFailed) {
        this.markQueuedMessages(requestAtDone?.queuedIds || [], 'failed')
      }
      if (!waitingForApproval && !pausedStepLimit && !pausedPatchFailed && !waitingQuestion) {
        this.finalizeFrontendAgentTurn({
          status: cancelled ? 'cancelled' : providerFailed || repeatedPreviousAnswer ? 'failed' : 'completed',
          requestId: eventRequestId || String(payload.requestId || ''),
          clearActionCards: cancelled || providerFailed || repeatedPreviousAnswer,
          message: String(payload.error || payload.message || ''),
        })
      }
      if (cancelled) this.markRequest('ok', 'Agent 会话已取消', '历史记录已保留，可新建或切换会话继续。')
      else if (pausedPatchFailed) this.markRequest('error', 'Patch 应用失败', String(payload.error || payload.message || '已停止自动重试。'))
      else if (providerFailed) this.markRequest('error', 'Agent 执行失败', String(payload.error || '未知错误'))
      else if (repeatedPreviousAnswer) this.markRequest('error', '本轮没有收到新回复', '检测到 Provider 返回上一轮重复答复，已阻止串轮显示并结束本轮，避免继续卡住。')
      else if (waitingForPermission) this.markRequest('busy', '等待用户确认', '请在当前 AI 回复里的审批卡继续。')
      else if (waitingQuestion) this.markRequest('busy', '等待你的回答', '请直接在输入框回复，Agent 会继续上一轮任务。')
      else if (waitingForPatch) this.markRequest('busy', 'Patch 待处理', '请在当前 AI 回复里的 Patch 预览卡应用或忽略。')
      else if (pausedStepLimit) this.markRequest('busy', 'Agent 已暂停', '达到最大执行步数，已压缩上下文，等待继续。')
      else this.markRequest('ok', 'Agent 执行完成', '请求详情、用量和工具轨迹已收纳到调试面板')
      if (!waitingForApproval && !pausedStepLimit && !waitingQuestion && !pausedPatchFailed && !cancelled && !providerFailed && !repeatedPreviousAnswer) {
        this.captureApprovedPlanFromLatestAssistant()
      }
      const doneKey = eventRequestId || String(payload.requestId || payload.sessionId || event.id || Date.now())
      if (waitingQuestion) this.notifyAgentWaiting('question', '请直接在输入框回复，Agent 会继续上一轮任务。', doneKey)
      else if (waitingForPermission) this.notifyAgentWaiting('permission', '请在当前 AI 回复里的审批卡继续。', doneKey)
      else if (waitingForPatch) this.notifyAgentWaiting('patch', '请在当前 AI 回复里的 Patch 预览卡应用或忽略。', doneKey)
      else if (pausedStepLimit) this.notifyAgentWaiting('step', '达到最大执行步数，等待继续。', doneKey)
      else if (cancelled) this.notifyAgentCompleted('cancelled', 'Agent 会话已取消，历史记录已保留。', doneKey)
      else if (pausedPatchFailed) this.notifyAgentCompleted('paused_patch_failed', String(payload.error || payload.message || 'Patch 应用失败。'), doneKey)
      else if (providerFailed || repeatedPreviousAnswer) this.notifyAgentCompleted('failed', String(payload.error || '本轮没有完成。'), doneKey)
      else this.notifyAgentCompleted('completed', 'Agent 执行完成。', doneKey)
      void this.refreshAgentSessions(false)
      this.renderComposer()
      const shouldContinuePlan = !waitingForApproval && !pausedStepLimit && !waitingQuestion && !pausedPatchFailed && !cancelled && !providerFailed && !repeatedPreviousAnswer && this.shouldContinuePlanDevelopment()
      if (shouldContinuePlan) {
        this.markRequest('busy', '计划开发未完成，继续执行', '仍有 Todo 未完成，正在按计划自动续跑。')
        window.setTimeout(() => void this.continuePlanDevelopment('todo_incomplete'), 160)
      }
      if (!waitingForApproval && !pausedStepLimit && !waitingQuestion && !pausedPatchFailed && !cancelled && !providerFailed && !shouldContinuePlan) {
        window.setTimeout(() => void this.drainNextQueuedUserMessageAfterDone(), 120)
      }
    }
    this.scheduleAssistantRender('agent-event')
    this.scheduleSessionPersist()
  }

  private setAgentWaitingPhase(phaseName: string, label: string, detail = '') {
    const now = new Date().toISOString()
    const phase = {
      phase: phaseName,
      status: 'running',
      label,
      detail,
      startedAt: now,
      durationMs: 0,
      at: now,
    }
    this.state.agentRuntime.phase = phase
    this.state.agentRuntime.phaseHistory = [
      ...this.state.agentRuntime.phaseHistory.filter(item => item.phase !== phase.phase),
      phase,
    ].slice(-40)
  }

  private stableToolInput(value: unknown) {
    try {
      const clean = (input: unknown): unknown => {
        if (!input || typeof input !== 'object') return input
        if (Array.isArray(input)) return input.map(clean)
        const out: Record<string, unknown> = {}
        for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
          if (key === '__cacheKey' || key === '__cacheHit') continue
          out[key] = clean(item)
        }
        return out
      }
      return JSON.stringify(clean(value || {}))
    } catch {
      return String(value || '')
    }
  }

  private isTurnScopedAgentEvent(type: string) {
    return [
      'message_part',
      'message_delta',
      'reasoning_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call_result',
      'tool_start',
      'tool_result',
      'permission_request',
      'patch_preview',
      'step_limit_reached',
      'context_compaction_start',
      'context_compaction_result',
      'context_compaction_error',
      'checkpoint_created',
      'checkpoint_reverted',
      'usage',
      'error',
      'session_done',
      'done',
    ].includes(type)
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
    const eventAt = Date.parse(String(event?.at || '')) || 0
    if (this.activeTurnStartedAt && eventAt > 0 && eventAt < this.activeTurnStartedAt - 3000) return
    if (!this.activeTurnToolIds.includes(id)) {
      this.activeTurnToolIds.push(id)
      this.activeTurnToolIds = this.activeTurnToolIds.slice(-40)
    }
  }

  private rememberActiveTurnPermission(id: string, event?: AgentEvent) {
    if (!id || (!this.pendingAiRequest && !this.activeAssistantMessageId)) return
    const eventAt = Date.parse(String(event?.at || '')) || 0
    if (this.activeTurnStartedAt && eventAt > 0 && eventAt < this.activeTurnStartedAt - 3000) return
    if (!this.activeTurnPermissionIds.includes(id)) {
      this.activeTurnPermissionIds.push(id)
      this.activeTurnPermissionIds = this.activeTurnPermissionIds.slice(-20)
    }
  }

  private rememberActiveTurnPatch(id: string, event?: AgentEvent) {
    if (!id || (!this.pendingAiRequest && !this.activeAssistantMessageId)) return
    const eventAt = Date.parse(String(event?.at || '')) || 0
    if (this.activeTurnStartedAt && eventAt > 0 && eventAt < this.activeTurnStartedAt - 3000) return
    if (!this.activeTurnPatchIds.includes(id)) {
      this.activeTurnPatchIds.push(id)
      this.activeTurnPatchIds = this.activeTurnPatchIds.slice(-20)
    }
  }

  private activeTurnToolCalls() {
    if (!this.activeTurnToolIds.length) return []
    return this.activeTurnToolIds
      .map(id => this.state.agentRuntime.timeline.find(item => item.id === id))
      .filter(call => !call?.subagent && !call?.internal && !this.isBootstrapTodoCall(call))
      .filter(Boolean) as ToolCallRecord[]
  }

  private activeTurnPermissions() {
    if (!this.activeTurnPermissionIds.length) return []
    return this.activeTurnPermissionIds
      .map(id => this.state.agentRuntime.pendingPermissions.find(item => item.id === id))
      .filter((item): item is PermissionRequest => Boolean(item))
  }

  private activeTurnPatchPreviews() {
    if (!this.activeTurnPatchIds.length) return []
    return this.activeTurnPatchIds
      .map(id => this.state.agentRuntime.patchPreviews.find(item => item.id === id))
      .filter((item): item is PatchPreview => Boolean(item))
  }

  private upsertSubagentTool(call: ToolCallRecord) {
    const subagentId = call.subagentId || 'subagent'
    const existing = this.state.agentRuntime.subagents.find((item: any) => String(item?.id || '') === subagentId) as any
    const base = existing || {
      id: subagentId,
      profileId: 'Subagent',
      status: 'running',
      startedAt: call.startedAt,
      tools: [],
    }
    const tools = Array.isArray(base.tools) ? base.tools as ToolCallRecord[] : []
    const next = {
      ...base,
      tools: [
        ...tools.filter(item => item.id !== call.id),
        call,
      ].slice(-40),
    }
    this.state.agentRuntime.subagents = [
      ...this.state.agentRuntime.subagents.filter((item: any) => String(item?.id || '') !== subagentId),
      next,
    ].slice(-20)
  }

  private subagentEvidenceTools(item: any, fallback: ToolCallRecord[] = []) {
    const evidenceTools = Array.isArray(item?.evidence?.tools) ? item.evidence.tools : []
    if (!evidenceTools.length) return fallback
    const subagentId = String(item?.id || '')
    return evidenceTools.map((entry: any, index: number) => {
      const ok = entry?.ok !== false && !entry?.error
      return {
        id: String(entry?.id || `subagent-evidence-${subagentId}-${index}`),
        name: String(entry?.tool || entry?.name || 'tool'),
        status: ok ? 'ok' : 'error',
        input: entry?.input || {},
        output: entry?.output,
        error: String(entry?.error || ''),
        startedAt: String(item?.startedAt || item?.finishedAt || new Date().toISOString()),
        finishedAt: String(item?.finishedAt || new Date().toISOString()),
        subagent: true,
        subagentId,
      } satisfies ToolCallRecord
    })
  }

  private acceptAssistantStreamDelta(text: string, replace = false) {
    if (!text) return
    if (replace) this.pendingToolProtocolBuffer = ''
    text = this.filterRepeatedPreviousAssistantPrefix(text, replace)
    if (!text) return
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

  private filterRepeatedPreviousAssistantPrefix(text: string, replace = false) {
    const previous = this.pendingAiRequest?.previousAssistantText || ''
    if (!previous.trim()) return text
    const visibleMessage = this.activeAssistantMessageId
      ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
      : null
    if (visibleMessage?.text.trim() || this.assistantTypingQueue.trim()) return text
    const incoming = replace ? text : `${this.staleAssistantPrefixBuffer}${text}`
    if (!incoming.trim()) return text
    if (previous === incoming || previous.startsWith(incoming)) {
      this.staleAssistantPrefixBuffer = incoming
      return ''
    }
    if (incoming.startsWith(previous)) {
      this.staleAssistantPrefixBuffer = ''
      return incoming.slice(previous.length).replace(/^\s+/, '')
    }
    if (this.staleAssistantPrefixBuffer && incoming.length > this.staleAssistantPrefixBuffer.length) {
      let shared = 0
      const max = Math.min(previous.length, incoming.length)
      while (shared < max && previous[shared] === incoming[shared]) shared += 1
      if (shared > this.staleAssistantPrefixBuffer.length - 8) {
        this.staleAssistantPrefixBuffer = ''
        return incoming.slice(shared).replace(/^\s+/, '')
      }
    }
    this.staleAssistantPrefixBuffer = ''
    return text
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
    this.attachRuntimeToolsToActiveMessage()
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
        checkpointIds: [...this.activeTurnCheckpointIds],
      }
      this.activeAssistantMessageId = message.id
      this.state.chat.push(message)
    }
    return message
  }

  private attachRuntimeToolsToActiveMessage() {
    this.attachRuntimeToolsToMessage(false)
  }

  private attachRuntimeToolsToMessage(allowLastAssistantFallback: boolean) {
    if (!this.pendingAiRequest && !this.activeAssistantMessageId && !allowLastAssistantFallback) return
    let message = this.activeAssistantMessageId
      ? this.state.chat.find(item => item.id === this.activeAssistantMessageId)
      : null
    if (!message && allowLastAssistantFallback) {
      message = [...this.state.chat].reverse().find(item => item.role === 'assistant') || null
      if (message) this.activeAssistantMessageId = message.id
    }
    if (!message) message = this.ensureAssistantStreamMessage()
    message.toolCalls = this.activeTurnToolCalls()
    message.pendingPermissions = this.activeTurnPermissions()
    message.patchPreviews = this.activeTurnPatchPreviews()
    message.reasoning = this.activeTurnReasoning || message.reasoning || ''
    message.compactedSummary = this.state.agentRuntime.compactedSummary || message.compactedSummary
    message.checkpointIds = [...this.activeTurnCheckpointIds]
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
      this.scheduleAssistantRender('tool_completion')
      this.scheduleSessionPersist()
    }, delay)
  }

  private resetAssistantTyping() {
    if (this.assistantTypingTimer) window.clearTimeout(this.assistantTypingTimer)
    this.assistantTypingTimer = 0
    this.assistantTypingQueue = ''
    this.assistantTypingMessageId = ''
    this.pendingToolProtocolBuffer = ''
    this.staleAssistantPrefixBuffer = ''
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
      this.attachRuntimeToolsToActiveMessage()
      this.lastAssistantResponseText = `${message.text}${this.assistantTypingQueue}`
      this.scheduleAssistantRender('assistant_typing')
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
    this.scheduleAssistantRender('hide_tool_protocol', true)
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
    this.clearComposerOptimizationUndo(false)
    if (this.state.agentRuntime.status === 'waiting_question') {
      const input = this.$<HTMLTextAreaElement>('#task-prompt')
      if (input) input.value = ''
      this.composerDraft = ''
      this.renderComposer()
      await this.answerAgentQuestion('', prompt)
      return
    }
    if (this.isAgentRunningForComposer()) {
      this.enqueueUserMessageWhileRunning(prompt)
      return
    }
    const attachments = this.snapshotComposerAttachments()
    if (this.state.settings.connection_mode !== 'autocodePlatform') {
      await this.runLocalAiTask(prompt, { attachments })
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
          attachments.length ? `attachments=${attachments.map(item => item.name).join(', ')}` : '',
          '请优先通过 Local Connector 在用户本机读取、修改、运行和验证。',
        ].filter(Boolean).join('\n'),
        project_type: 'local',
        agent_types: ['general'],
        enable_smart_planning: true,
        tool_policy: 'full_access',
        metadata: {
          local_workspace: this.currentRoot(),
          open_file: tab?.path || '',
          attachments,
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
      this.clearComposerAttachments()
      this.startTaskPolling()
      this.renderAll()
    } catch (error) {
      this.toast(String(error), 'error')
      this.renderComposer()
    }
  }

  private shouldAutoDispatchSubagents(prompt: string) {
    if (localStorage.getItem('autocode.ide.autoSubagents') !== '1') return false
    const clean = prompt.trim()
    if (clean.length < 120) return false
    if (/^(?:测试|test|ping|hello|你好|收到回复|回复\s*ok)[，,。.\s\w-]*$/i.test(clean)) return false
    return /(多文件|复杂|全项目|整个项目|架构|技术框架|大范围|重构|迁移|性能|并发|安全|测试套件|端到端|e2e)/i.test(clean)
  }

  private async autoDispatchSubagents(sessionId: string, prompt: string, contextRefs: any[]) {
    if (!this.shouldAutoDispatchSubagents(prompt)) return []
    const isPlanProfile = String(this.state.agentRuntime.profileId || '').toLowerCase() === 'plan'
    const profiles = isPlanProfile
      ? ['Explore', 'Review']
      : /(测试|构建|运行|报错|失败)/i.test(prompt) ? ['Explore', 'Test'] : ['Explore', 'Review']
    this.toast(`${isPlanProfile ? '规划证据' : '复杂任务'}：自动派发 ${profiles.join('、')} 子智能体`, 'busy')
    const run = Promise.allSettled(profiles.map(profile => {
      const subPrompt = isPlanProfile
        ? this.buildPlanningSubagentEvidencePrompt(prompt, profile)
        : `${prompt}\n请只做证据收集和只读分析，返回关键文件、命令或风险，不要修改文件。`
      return this.api.agentSubagentRun(sessionId, profile, subPrompt, contextRefs)
    }))
    const timeout = new Promise<PromiseSettledResult<any>[]>(resolve => {
      window.setTimeout(() => resolve([]), 8000)
    })
    const results = await Promise.race([run, timeout])
    if (!results.length) {
      this.toast('子智能体证据收集超时，已跳过，不阻塞主回复。', 'idle')
      return []
    }
    return results.flatMap(result => result.status === 'fulfilled' && result.value?.summary ? [{
      id: `subagent-evidence-${Date.now()}-${Math.random()}`,
      kind: 'workspace',
      label: `${isPlanProfile ? '规划' : ''}${result.value.profileId || '子智能体'}证据`,
      value: String(result.value.summary).slice(0, isPlanProfile ? 3000 : 6000),
    }] : [])
  }

  private buildPlanningSubagentEvidencePrompt(prompt: string, profile: string) {
    return [
      '你是规划模式的只读证据采集子智能体，不是最终规划者。',
      '只允许收集事实证据，禁止输出方案、建议、优先级、最终计划、Todo 或“下一步可以”。',
      '请用非常短的中文要点返回：',
      '1. 相关文件/目录/入口',
      '2. 已确认的现有能力或约束',
      '3. 仍需主 Agent 用问题卡向用户确认的关键不确定点',
      '4. 可能影响计划的风险证据',
      '不要修改文件，不要调用写入类工具，不要替主 Agent 做产品决策。',
      `子智能体角色：${profile}`,
      '',
      '【用户原始规划需求】',
      prompt,
    ].join('\n')
  }

  private queuedStatusLabel(status: string) {
    if (status === 'processing') return '处理中'
    if (status === 'consumed') return '已处理'
    if (status === 'failed') return '处理失败'
    return '已排队'
  }

  private async startBuildFromPlan(planId: string) {
    if (this.isAgentRunningForComposer()) {
      this.toast('当前 Agent 仍在执行，请等本轮结束后再按计划开发。', 'idle')
      return
    }
    const plan = this.resolvePlanById(planId)
    if (!plan) {
      this.toast('没有找到可执行的计划，请重新生成规划。', 'error')
      return
    }
    if (!this.planHasConfirmation(plan)) {
      this.toast('该规划还没有经过问题卡确认，请先在规划模式完成需求确认。', 'idle')
      return
    }
    if (!this.planHasStrictStructure(plan.content)) {
      this.toast('该规划缺少固定五段结构，请先重新生成完整计划。', 'idle')
      return
    }
    const root = this.currentRoot()
    if (!root) {
      this.toast('请先打开本地项目', 'idle')
      return
    }
    this.state.agentRuntime.profileId = 'build'
    const savedPlan = await this.saveApprovedPlanFile(plan) || plan
    this.state.agentRuntime.approvedPlan = savedPlan
    this.state.agentRuntime.planTodos = savedPlan.todos || []
    this.state.agentRuntime.planningAnswers = savedPlan.answers || this.state.agentRuntime.planningAnswers || []
    const executionReady = savedPlan.executionReady !== false && this.planLooksExecutionReady(savedPlan.content, savedPlan.todos || [])
    this.state.agentRuntime.planDevelopment = {
      status: executionReady ? 'executing_plan' : 'blocked',
      planId: savedPlan.id,
      planFilePath: savedPlan.planFilePath || '',
      todoItems: savedPlan.todos || [],
      activeTodoId: this.firstIncompleteTodoId(savedPlan.todos || []),
      completedTodoIds: this.completedTodoIds(savedPlan.todos || []),
      blockedReason: executionReady ? '' : '当前计划偏分析/建议，需要先转成可执行开发计划。',
      validationStatus: '',
      checkpointIds: [],
      continuationCount: 0,
    }
    try {
      const session = await this.api.agentSessionStart(root, 'build')
      this.state.agentRuntime.sessionId = String(session?.id || '')
      this.state.agentRuntime.profileId = String(session?.profileId || 'build')
      await this.refreshAgentSessions(false)
    } catch (error) {
      this.toast(`创建构建会话失败：${String(error)}`, 'error')
      return
    }
    const todoText = savedPlan.todos?.length
      ? savedPlan.todos.map((item, index) => `${index + 1}. [${item.status || 'pending'}] ${item.text}`).join('\n')
      : '按计划拆解并维护 Todo。'
    const prompt = !executionReady
      ? [
        'EXECUTE_APPROVED_PLAN_PREPARE',
        '',
        '当前计划偏分析/建议，不能直接进入代码开发。请把它转成可执行开发计划。',
        '要求：',
        '- 不要写项目文档，不要继续输出泛泛建议。',
        '- 先定位可实施的代码/页面目标；如果目标模块不明确，必须用 question 工具给出 2-3 个选项和自由输入框。',
        '- 最终输出固定五段中文开发计划，标题必须依次为：Summary（摘要）/ Key Changes（关键改动）/ Public Interfaces（公共接口）/ Test Plan（测试计划）/ Assumptions（假设），并调用 todowrite 生成可开发任务清单。',
        '',
        '【原计划文件】',
        savedPlan.planFilePath || '尚未保存',
        '',
        '【原计划】',
        savedPlan.content,
      ].join('\n')
      : [
      'EXECUTE_APPROVED_PLAN',
      '',
      '硬性要求：',
      '- 你现在处于 executing_plan 连续开发状态，不是规划模式。',
      '- 严格跟随任务清单推进，第一步必须用 todowrite 同步任务状态。',
      '- 随后必须定位相关源码文件并执行第一个未完成 Todo。',
      '- 需要修改文件时直接使用工具，并按现有审批规则展示变更。',
      '- 不要重新讨论计划本身，不要继续写计划文档，不要输出“后续建议”代替执行。',
      '- Todo 未完成前不要自然结束；如果被迫暂停，明确说明阻塞原因。',
      '- 只有发现计划不可执行、缺少目标文件或存在高风险歧义时才用 question 工具提问。',
      '',
      '【计划文件】',
      savedPlan.planFilePath || '尚未保存',
      '',
      '【已确认计划】',
      savedPlan.content,
      '',
      '【开发任务清单】',
      todoText,
    ].join('\n')
    const contextRefs = [
      { id: `approved-plan-${savedPlan.id}`, kind: 'workspace', label: '已确认计划', value: savedPlan.content },
      { id: `approved-plan-file-${savedPlan.id}`, kind: 'file', label: '计划文件', value: savedPlan.planFilePath || '' },
      { id: `approved-plan-todos-${savedPlan.id}`, kind: 'workspace', label: '计划任务清单', value: JSON.stringify(savedPlan.todos || [], null, 2) },
      savedPlan.answers?.length ? { id: `planning-answers-${savedPlan.id}`, kind: 'workspace', label: '规划确认回答', value: savedPlan.answers.join('\n') } : null,
    ].filter(Boolean)
    await this.runLocalAiTask(prompt, { extraContextRefs: contextRefs as any[] })
  }

  private firstIncompleteTodoId(todos: AgentPlanTodo[]) {
    const index = todos.findIndex(item => !['done', 'completed'].includes(String(item.status || '').toLowerCase()))
    return index >= 0 ? `todo-${index}` : ''
  }

  private completedTodoIds(todos: AgentPlanTodo[]) {
    return todos.flatMap((item, index) =>
      ['done', 'completed'].includes(String(item.status || '').toLowerCase()) ? [`todo-${index}`] : [],
    )
  }

  private resolvePlanById(planId: string) {
    const active = this.state.agentRuntime.approvedPlan
    if (active?.id === planId) return active
    for (const message of [...this.state.chat].reverse()) {
      if (message.role !== 'assistant') continue
      const plan = message.plan || this.detectAgentPlanFromText(this.repairMojibakeText(message.text), message.id, message.at, false)
      if (plan?.id === planId) return plan
    }
    return active || null
  }

  private snapshotComposerAttachments() {
    return this.state.attachments
      .filter(item => !item.transient)
      .map(item => ({ ...item }))
  }

  private clearComposerAttachments() {
    for (const item of this.state.attachments) {
      if (item.preview?.startsWith('blob:')) URL.revokeObjectURL(item.preview)
    }
    this.state.attachments = []
  }

  private enqueueUserMessageWhileRunning(prompt: string) {
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (input) input.value = ''
    this.composerDraft = ''
    const attachments = this.snapshotComposerAttachments()
    const id = `queue-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const queued = {
      id,
      text: prompt,
      attachments,
      contextRefs: [...this.state.contextChips, ...this.attachmentContextRefs(attachments)],
      createdAt: new Date().toISOString(),
      status: 'queued' as const,
    }
    this.state.agentRuntime.queuedUserMessages = [...this.state.agentRuntime.queuedUserMessages, queued].slice(-20)
    this.state.chat.push({ id: `msg-${Date.now()}-queued`, role: 'user', text: prompt, at: queued.createdAt, attachments, queued: { id, status: 'queued' } })
    this.clearComposerAttachments()
    this.toast('已排队，当前任务结束后自动处理', 'ok')
    this.markRequest('busy', 'Agent 执行中', `已排队 ${this.state.agentRuntime.queuedUserMessages.filter(item => item.status === 'queued').length} 条补充消息`)
    this.renderAssistant()
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private cancelQueuedUserMessage(id: string) {
    const before = this.state.agentRuntime.queuedUserMessages.length
    this.state.agentRuntime.queuedUserMessages = this.state.agentRuntime.queuedUserMessages.filter(item => item.id !== id)
    this.state.chat = this.state.chat.filter(message => message.queued?.id !== id)
    if (before !== this.state.agentRuntime.queuedUserMessages.length) this.toast('已取消排队消息', 'ok')
    this.renderAssistant()
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private promoteQueuedUserMessage(id: string) {
    const queue = [...this.state.agentRuntime.queuedUserMessages]
    const index = queue.findIndex(item => item.id === id && item.status === 'queued')
    if (index <= 0) {
      if (index === 0) this.toast('这条消息已经是下一条', 'idle')
      return
    }
    const [item] = queue.splice(index, 1)
    queue.unshift({ ...item, priority: Date.now() })
    this.state.agentRuntime.queuedUserMessages = queue
    this.toast('已设为下一条处理', 'ok')
    this.renderAssistant()
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private insertQueuedUserMessageIntoCurrentTurn(id: string) {
    const queue = [...this.state.agentRuntime.queuedUserMessages]
    const index = queue.findIndex(item => item.id === id && item.status === 'queued')
    if (index < 0) return
    const [item] = queue.splice(index, 1)
    const text = item.text.startsWith('【插入本轮】') ? item.text : `【插入本轮】${item.text}`
    queue.unshift({ ...item, priority: Date.now(), text })
    this.state.agentRuntime.queuedUserMessages = queue
    this.state.chat = this.state.chat.map(message =>
      message.queued?.id === id
        ? { ...message, text: message.text.startsWith('【插入本轮】') ? message.text : `【插入本轮】${message.text}` }
        : message,
    )
    this.toast('已插入本轮：当前任务收尾后会优先处理这条补充', 'ok')
    this.renderAssistant()
    this.renderComposer()
    this.scheduleSessionPersist()
  }

  private markQueuedMessages(ids: string[] = [], status: 'processing' | 'consumed' | 'failed' | 'queued', removeFromQueue = false, error = '') {
    if (!ids.length) return
    const idSet = new Set(ids)
    this.state.agentRuntime.queuedUserMessages = removeFromQueue
      ? this.state.agentRuntime.queuedUserMessages.filter(item => !idSet.has(item.id))
      : this.state.agentRuntime.queuedUserMessages.map(item => idSet.has(item.id) ? { ...item, status, error } : item)
    this.state.chat = this.state.chat.map(message =>
      message.queued && idSet.has(message.queued.id)
        ? { ...message, queued: { ...message.queued, status } }
        : message,
    )
  }

  private repairStuckQueuedMessages() {
    if (this.pendingAiRequest || this.state.agentRuntime.activeRequestId || this.state.agentRuntime.activeTurnId) return
    const stuck = this.state.agentRuntime.queuedUserMessages.filter(item => item.status === 'processing')
    if (!stuck.length) return
    this.markQueuedMessages(stuck.map(item => item.id), 'queued', false, '上一轮请求未正常启动，已自动放回队列。')
  }

  private canDrainQueuedMessages() {
    const runtime = this.state.agentRuntime
    if (['running', 'waiting_permission', 'waiting_question', 'compacting', 'cancelling', 'paused_step_limit', 'paused_patch_failed'].includes(String(runtime.status || ''))) return false
    if (runtime.pendingPermissions.length) return false
    if (runtime.patchPreviews.some(item => item.requiresApproval !== false)) return false
    return true
  }

  private async drainQueuedUserMessagesAfterDone() {
    await this.drainNextQueuedUserMessageAfterDone()
  }

  private async drainNextQueuedUserMessageAfterDone() {
    this.repairStuckQueuedMessages()
    if (this.pendingAiRequest || !this.canDrainQueuedMessages()) return
    const queued = this.state.agentRuntime.queuedUserMessages.find(item => item.status === 'queued')
    if (!queued) return
    const ids = [queued.id]
    this.markQueuedMessages(ids, 'processing')
    const rawText = queued.text || ''
    const inserted = rawText.startsWith('【插入本轮】')
    const userText = inserted ? rawText.replace(/^【插入本轮】/, '').trim() : rawText
    const prompt = [
      inserted
        ? '用户在上一轮 Agent 执行期间插入了一条补充需求。请把上一轮结果只作为上下文，直接处理这条补充需求。'
        : '用户在上一轮 Agent 执行期间排队发送了一条新消息。请直接处理这条消息。',
      '',
      '硬性要求：不要复述上一轮最终答复，不要重新总结上一轮已完成内容，不要为了回顾而重复输出旧回复；只有在补充需求需要时才引用上一轮结论。',
      '',
      inserted ? '插入补充需求：' : '排队消息：',
      userText,
    ].join('\n')
    const contextRefs = queued.contextRefs || []
    this.toast('开始处理下一条排队消息', 'busy')
    await this.runLocalAiTask(prompt, { displayUserMessage: false, queuedIds: ids, extraContextRefs: contextRefs as any[], attachments: queued.attachments || [] })
  }

  private beginAgentTurn(prompt: string, contextRefs: any[], queuedIds: string[] = []) {
    const turnId = `turn-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const previousAssistantText = [...this.state.chat].reverse()
      .find(item => item.role === 'assistant' && item.text.trim())
      ?.text
      ?.trim()
      ?.slice(0, 30000) || ''
    this.state.agentRuntime.activeTurnId = turnId
    this.state.agentRuntime.activeRequestId = ''
    this.state.agentRuntime.status = 'running'
    this.pendingAiRequest = { prompt, contextRefs, turnId, queuedIds, previousAssistantText }
    this.staleAssistantPrefixBuffer = ''
    this.clearAiFallback(false)
    return turnId
  }

  private async runLocalAiTask(prompt: string, options: { displayUserMessage?: boolean; queuedIds?: string[]; extraContextRefs?: any[]; attachments?: Attachment[] } = {}) {
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (input) input.value = ''
    this.composerDraft = ''
    const attachments = (options.attachments || this.snapshotComposerAttachments()).map(item => ({ ...item }))
    if (options.displayUserMessage !== false) {
      this.state.chat.push({ id: `msg-${Date.now()}-user`, role: 'user', text: prompt, at: new Date().toISOString(), attachments })
    }
    this.clearComposerAttachments()
    this.activeAssistantMessageId = ''
    this.lastAssistantResponseText = ''
    this.activeTurnStartedAt = Date.now()
    this.activeTurnToolIds = []
    this.activeTurnPermissionIds = []
    this.activeTurnPatchIds = []
    this.activeTurnCheckpointIds = []
    this.activeTurnReasoning = ''
    this.resetAssistantTyping()
    this.renderAssistant()
    this.renderComposer()
    this.toast('正在请求本地 Provider...', 'busy')
    this.ensureProviderChannels()
    this.syncLegacyProviderFieldsFromDefaultChannel()
    const route = this.activeProviderLabel('agent')
    this.markRequest('busy', 'Agent 执行中', route.text)
    const tab = this.activeTab()
    const selected = this.editor.selectionText()
    Object.values(this.toolCompletionTimers).forEach(timer => window.clearTimeout(timer))
    this.toolCompletionTimers = {}
    this.toolCompletionSequence = 0
    this.state.agentRuntime.timeline = []
    this.state.agentRuntime.pendingPermissions = []
    this.state.agentRuntime.patchPreviews = []
    this.state.agentRuntime.thinking = ''
    this.state.agentRuntime.compactedSummary = null
    try {
      const sessionId = await this.ensureAgentSession()
      if (!sessionId) throw new Error('Agent 会话不可用')
      const activeProfile = String(this.state.agentRuntime.profileId || '').toLowerCase()
      const isPlanExecution = /\bEXECUTE_APPROVED_PLAN\b/.test(prompt)
      const includeAgentSettings = activeProfile !== 'plan' && !isPlanExecution
      const agentPrompt = this.decoratePromptForActiveProfile(prompt, activeProfile)
      const contextRefs = [
        ...this.state.contextChips,
        tab ? { id: `active-file-${Date.now()}`, kind: 'file', label: `当前文件 ${tab.path}`, value: `@当前文件 ${tab.path}\n${tab.draft.slice(0, Math.min(12000, this.aiContextBudget))}` } : null,
        selected ? { id: `selection-${Date.now()}`, kind: 'selection', label: '当前选区', value: `@选区 ${tab?.path || ''}\n${selected.slice(0, 8000)}` } : null,
        this.terminalOutputBuffer.trim() ? { id: `terminal-${Date.now()}`, kind: 'terminal', label: '终端输出', value: `@终端输出\n${this.terminalOutputBuffer.slice(-8000)}` } : null,
        ...this.attachmentContextRefs(attachments),
        includeAgentSettings ? { id: `agent-settings-${Date.now()}`, kind: 'workspace', label: 'Agent 设置', value: JSON.stringify({ systemPrompt: this.aiSystemPrompt, temperature: this.aiTemperature, contextBudget: this.aiContextBudget }) } : null,
      ].filter(Boolean)
      this.beginAgentTurn(agentPrompt, [...contextRefs, ...(options.extraContextRefs || [])] as any[], options.queuedIds || [])
      const subagentRefs = await this.autoDispatchSubagents(sessionId, prompt, contextRefs as any[])
      const enrichedContextRefs = [...contextRefs, ...(options.extraContextRefs || []), ...subagentRefs]
      if (this.pendingAiRequest) this.pendingAiRequest.contextRefs = enrichedContextRefs as any[]
      await this.refreshLocalServerStatus()
      this.startLocalAgentEventStream()
      this.pendingAiFallbackTimer = window.setTimeout(
        () => void this.runAiDisplayFallback('等待流式正文超时，正在切换非流式兜底。'),
        this.aiFallbackDelayMs(),
      )
      const accepted = await this.api.agentSend(sessionId, agentPrompt, enrichedContextRefs as any[])
      const requestId = String(accepted?.requestId || '')
      if (requestId && this.pendingAiRequest) {
        this.pendingAiRequest.requestId = requestId
        this.state.agentRuntime.activeRequestId = requestId
      }
      this.state.ai.history.push({ role: 'user', text: prompt, at: new Date().toISOString() })
      this.state.requestTimeline.detail = `已接受请求：${accepted?.requestId || 'streaming'}`
      this.toast('Agent 已开始流式返回', 'busy')
      this.renderAssistant()
      this.renderComposer()
      this.scheduleSessionPersist()
    } catch (error) {
      this.markQueuedMessages(options.queuedIds || [], 'failed', false, String(error))
      this.clearAiFallback(true)
      this.pendingAiRequest = null
      this.aiFallbackRunning = false
      this.state.agentRuntime.status = 'failed'
      this.state.agentRuntime.activeRequestId = ''
      this.state.agentRuntime.activeTurnId = ''
      this.markRequest('error', 'Provider 请求失败', String(error))
      this.toast(String(error), 'error')
      this.renderComposer()
    }
  }

  private decoratePromptForActiveProfile(prompt: string, activeProfile: string) {
    if (activeProfile !== 'plan') return prompt
    if (/PLAN_MODE_(?:START|FINALIZE)_PROTOCOL/.test(prompt)) return prompt
    const hasConfirmation = Boolean((this.state.agentRuntime.planningAnswers || []).length)
    const protocol = hasConfirmation
      ? [
        'PLAN_MODE_FINALIZE_PROTOCOL',
        '你现在处于规划模式的最终计划生成阶段。',
        '本轮不得输出分析报告、建议清单、经验总结或“下一步可以”。',
        '必须基于已确认需求生成可执行开发计划，并调用 todowrite 生成任务清单。',
        '最终可见计划必须使用中文内容，并严格按以下标题顺序输出：',
        'Summary（摘要）',
        'Key Changes（关键改动）',
        'Public Interfaces（公共接口）',
        'Test Plan（测试计划）',
        'Assumptions（假设）',
        '如果没有公共接口变化，Public Interfaces（公共接口）下写 None（无）。',
      ]
      : [
        'PLAN_MODE_START_PROTOCOL',
        '你现在处于规划模式的启动阶段。不要把用户请求当作普通分析问答。',
        '规划模式唯一目标是形成“可确认、可落盘、可执行、可点击开发”的开发计划。',
        '本轮首个可见结果必须是 question 工具问题卡，除非用户明确写了“不需要确认，直接出计划”。',
        'question 工具必须包含一个明确问题、2-3 个选项、推荐项第一、以及自由输入 placeholder。',
        '问题卡要确认开发目标和范围，例如：要修改哪个功能/文件、产出是代码改动还是项目内文档、验收方式是什么。',
        '禁止用正文输出“需要确认”列表代替 question 工具；禁止直接输出分析报告、建议清单、经验总结或开发计划。',
        '可以先使用只读工具查看必要上下文，但查看后仍必须以 question 工具结束本轮。',
      ]
    return [
      protocol.join('\n'),
      '',
      '【用户原始请求】',
      prompt,
    ].join('\n')
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

  private isolateCancelledAgentRequest(requestId = '') {
    const id = String(requestId || this.state.agentRuntime.activeRequestId || this.pendingAiRequest?.requestId || '').trim()
    if (id && !this.completedAgentRequestIds.includes(id)) {
      this.completedAgentRequestIds.push(id)
      this.completedAgentRequestIds = this.completedAgentRequestIds.slice(-80)
    }
    this.clearAiFallback(true)
    this.pendingAiRequest = null
    this.aiFallbackRunning = false
    this.pendingToolProtocolBuffer = ''
    this.state.agentRuntime.activeRequestId = ''
    this.state.agentRuntime.activeTurnId = ''
    this.activeAssistantMessageId = ''
    this.state.agentRuntime.phase = null
    this.state.agentRuntime.phaseHistory = []
    this.state.agentRuntime.pendingPermissions = []
    this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(item =>
      item.status === 'running' || item.status === 'approval_required'
        ? { ...item, status: 'error' as const, error: 'Agent 已停止，运行中的工具已中断显示。' }
        : item,
    )
    this.unlockInteractiveSurface('agent_cancelled')
  }

  private finalizeFrontendAgentTurn(outcome: { status: string; requestId?: string; queuedIds?: string[]; queueStatus?: 'consumed' | 'failed' | 'queued'; clearActionCards?: boolean; message?: string }) {
    const requestId = String(outcome.requestId || this.state.agentRuntime.activeRequestId || this.pendingAiRequest?.requestId || '').trim()
    if (requestId && !this.completedAgentRequestIds.includes(requestId)) {
      this.completedAgentRequestIds.push(requestId)
      this.completedAgentRequestIds = this.completedAgentRequestIds.slice(-80)
    }
    const queuedIds = outcome.queuedIds || this.pendingAiRequest?.queuedIds || []
    if (queuedIds.length && outcome.queueStatus) {
      this.markQueuedMessages(queuedIds, outcome.queueStatus, outcome.queueStatus === 'consumed', outcome.message || '')
    }
    this.clearAiFallback(true)
    this.pendingAiRequest = null
    this.aiFallbackRunning = false
    this.pendingToolProtocolBuffer = ''
    this.state.agentRuntime.activeRequestId = ''
    this.state.agentRuntime.activeTurnId = ''
    this.activeAssistantMessageId = ''
    this.state.agentRuntime.status = outcome.status
    if (outcome.clearActionCards !== false) {
      this.state.agentRuntime.pendingPermissions = []
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.filter(item => item.requiresApproval === false)
      this.state.chat = this.state.chat.map(message => ({
        ...message,
        pendingPermissions: [],
        patchPreviews: message.patchPreviews?.filter(item => item.requiresApproval === false),
      }))
    }
    if (['failed', 'cancelled'].includes(outcome.status)) {
      this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(item =>
        item.status === 'running' || item.status === 'approval_required'
          ? { ...item, status: 'error' as const, error: outcome.message || '本轮 Agent 已结束，运行态已清理。', finishedAt: item.finishedAt || new Date().toISOString() }
          : item,
      )
    }
    if (!['running', 'waiting_permission', 'waiting_question', 'compacting', 'cancelling'].includes(outcome.status)) {
      this.state.agentRuntime.phase = null
    }
    this.repairStuckQueuedMessages()
    this.unlockInteractiveSurface(`agent_finalized:${outcome.status}`)
  }

  private unlockInteractiveSurface(reason = 'agent cleanup') {
    this.hideContextMenu()
    this.hideAttachmentPreview()
    this.$('#command-center')?.setAttribute('hidden', '')

    const unlockTargets = [
      '#assistant-thread button.loading',
      '#assistant-thread button.message-action[disabled]',
      '#assistant-thread button[data-copy-code][disabled]',
      '#assistant-thread button[data-copy-message][disabled]',
      '#assistant-thread button[data-copy-near-code][disabled]',
      '#assistant-thread button[data-agent-approve][disabled]',
      '#assistant-thread button[data-agent-deny][disabled]',
      '#assistant-thread button[data-agent-question-submit][disabled]',
      '#agent-runtime-panel button.loading',
      '#agent-runtime-panel button[data-agent-session][disabled]',
      '#agent-runtime-panel button[data-checkpoint-revert][disabled]',
      '#agent-runtime-panel button[data-process-kill][disabled]',
      '#agent-runtime-panel button[id="agent-create-checkpoint"][disabled]',
      '#agent-runtime-panel button[id="agent-continue"][disabled]',
    ].join(',')

    this.root.querySelectorAll<HTMLButtonElement>(unlockTargets).forEach(button => {
      button.disabled = false
      button.classList.remove('loading', 'copy-ok', 'copy-error')
      const original = button.dataset.originalLabel
      if (original) button.textContent = original
    })

    window.setTimeout(() => {
      this.root.querySelectorAll<HTMLButtonElement>(unlockTargets).forEach(button => {
        button.disabled = false
        button.classList.remove('loading', 'copy-ok', 'copy-error')
        const original = button.dataset.originalLabel
        if (original) button.textContent = original
      })
    }, 0)

    console.debug('[AutoCode] interactive surface unlocked', reason)
  }

  private repairStaleAgentRuntime(reason = '检测到上次异常中断，已清理旧运行态。') {
    const status = String(this.state.agentRuntime.status || '')
    const stale = ['running', 'compacting', 'cancelling'].includes(status)
      || (status === 'waiting_permission' && !this.pendingAiRequest)
      || Boolean(this.state.agentRuntime.activeRequestId && !this.pendingAiRequest)
    if (!stale) {
      this.repairStuckQueuedMessages()
      return
    }
    this.finalizeFrontendAgentTurn({
      status: status === 'cancelling' ? 'cancelled' : 'failed',
      requestId: this.state.agentRuntime.activeRequestId,
      queueStatus: 'queued',
      clearActionCards: true,
      message: reason,
    })
    this.state.agentRuntime.resumeReason = reason
  }

  // 看门狗续期：任何 agent 进度事件（推理/工具开始/工具返回）都调用它。
  // 只要链路还在推进，就把 22s 兜底窗口向后顺延，避免把真正的 ReAct 流程
  // 误判为“流式卡死”而降级到无工具的裸补全。
  private bumpAiFallbackTimer() {
    if (!this.pendingAiRequest || this.aiFallbackRunning) return
    if (this.pendingAiFallbackTimer) window.clearTimeout(this.pendingAiFallbackTimer)
    this.pendingAiFallbackTimer = window.setTimeout(
      () => void this.runAiDisplayFallback('等待流式正文超时，正在切换非流式兜底。'),
      this.aiFallbackDelayMs(),
    )
  }

  private aiFallbackDelayMs() {
    const route = this.activeProviderLabel('agent')
    const model = `${route.model || this.state.settings.model || ''}`.toLowerCase()
    const provider = `${route.provider || this.state.settings.provider_type || ''}`.toLowerCase()
    const reasoning = `${this.state.settings.reasoning_mode || ''} ${this.state.settings.reasoning_effort || ''}`.toLowerCase()
    const longReasoningModel = /\bgpt-5|5\.5|reason|thinking|o\d/.test(model)
      || provider.includes('responses')
      || /(high|xhigh|极高|高)/.test(reasoning)
    return longReasoningModel ? 180000 : 60000
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
    let keepWaiting = false
    try {
      const restored = await this.restoreAgentResultFromSnapshot()
      if (restored?.repeated) {
        this.aiFallbackRunning = false
        this.bumpAiFallbackTimer()
        keepWaiting = true
        this.markRequest('busy', '等待本轮新回复', '快照仍是上一轮答复，已静默忽略并继续等待当前请求。')
        return
      }
      if (!restored) {
        this.aiFallbackRunning = false
        this.bumpAiFallbackTimer()
        keepWaiting = true
        this.markRequest('busy', 'Agent 仍在执行', '后端还没有最终回复，继续等待事件或 session 结果。')
        return
      }
      const answer = String(restored.answer || '').trim()
      if (!answer) throw new Error('Agent session 已返回，但没有可显示正文。')
      if (this.looksLikeToolProtocol(answer)) {
        this.aiFallbackRunning = false
        this.markRequest('busy', 'Agent 正在等待工具结果', '当前快照是工具协议，已隐藏并继续等待工具事件或最终回答。')
        this.bumpAiFallbackTimer()
        keepWaiting = true
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
      if (!keepWaiting) this.clearAiFallback(true)
      this.renderAssistant()
      this.scheduleSessionPersist()
    }
  }

  private async restoreAgentResultFromSnapshot(): Promise<{ answer: string; repeated?: boolean } | null> {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return null
    const snapshot = await this.api.agentSessionSnapshot(sessionId)
    const pending = this.pendingAiRequest
    const snapshotRequestId = String(snapshot?.lastRequestId || snapshot?.activeRequestId || '')
    if (pending?.requestId && snapshotRequestId && snapshotRequestId !== pending.requestId) return null
    const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
    const lastAssistant = [...messages].reverse().find((item: any) => item?.role === 'assistant')
    const answer = String(lastAssistant?.content || '').trim()
    const messageAt = Date.parse(String(lastAssistant?.at || snapshot?.updatedAt || '')) || 0
    if (
      pending
      && !pending.requestId
      && messageAt > 0
      && this.activeTurnStartedAt > 0
      && messageAt < this.activeTurnStartedAt - 1000
    ) {
      return null
    }
    if (this.isRepeatedPreviousAssistantAnswer(answer)) return { answer: '', repeated: true }
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

  private isRepeatedPreviousAssistantAnswer(answer: string, pending = this.pendingAiRequest) {
    const previous = String(pending?.previousAssistantText || '').trim()
    const current = String(answer || '').trim()
    if (!previous || !current) return false
    const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()
    return normalize(previous) === normalize(current)
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
    const parseJsonSetting = (selector: string, fallback: unknown) => {
      const raw = this.$<HTMLTextAreaElement>(selector)?.value.trim() || ''
      if (!raw) return fallback
      try {
        return JSON.parse(raw)
      } catch {
        this.toast(`${selector} JSON 格式错误，已保留原配置`, 'error')
        return fallback
      }
    }
    const next: IdeSettings = {
      ...this.state.settings,
      api_base_url: this.state.settings.api_base_url,
      api_key: this.state.settings.api_key,
      connection_mode: this.$<HTMLSelectElement>('#connection-mode')?.value === 'webConnector'
        ? 'aiProvider'
        : (this.$<HTMLSelectElement>('#connection-mode')?.value || 'aiProvider'),
      provider_type: this.state.settings.provider_type,
      api_protocol: this.state.settings.api_protocol || '',
      model: this.state.settings.model,
      reasoning_mode: this.$<HTMLSelectElement>('#reasoning-mode')?.value || 'auto',
      reasoning_effort: this.$<HTMLInputElement>('#reasoning-effort')?.value.trim() || 'medium',
      reasoning_budget_tokens: Number(this.$<HTMLInputElement>('#reasoning-budget')?.value || 8192),
      reasoning_summary: true,
      custom_headers: this.state.settings.custom_headers || {},
      channels: this.state.settings.channels,
      default_routes: this.state.settings.default_routes,
      code_completion: this.state.settings.code_completion,
      transcription_model: this.$<HTMLInputElement>('#transcription-model')?.value.trim() || '',
      offline_stt_enabled: this.$<HTMLInputElement>('#offline-stt-enabled')?.checked ?? true,
      offline_stt_engine: 'sherpa-onnx',
      offline_stt_model: this.$<HTMLSelectElement>('#offline-stt-model')?.value || 'zh-streaming-small',
      approval_mode: this.$<HTMLSelectElement>('#approval-mode')?.value || 'autoEdit',
      permission_policy: parseJsonSetting('#permission-policy', this.state.settings.permission_policy || {}),
      mcp_servers: parseJsonSetting('#mcp-servers', this.state.settings.mcp_servers || []),
      memory_files: (this.$<HTMLInputElement>('#memory-files')?.value || '')
        .split(',')
        .map(item => item.trim())
        .filter(Boolean),
      context_budget: Number(this.$<HTMLInputElement>('#settings-context-budget')?.value || this.state.settings.context_budget || 18000),
      auto_compact_threshold: Number(this.$<HTMLInputElement>('#auto-compact-threshold')?.value || this.state.settings.auto_compact_threshold || 24000),
      checkpoint_policy: this.$<HTMLSelectElement>('#checkpoint-policy')?.value || 'before_write',
      default_shell: this.$<HTMLSelectElement>('#default-shell')?.value || 'auto',
      default_workspace_path: this.$<HTMLInputElement>('#default-workspace-path')?.value || '',
      preview_url: this.$<HTMLInputElement>('#settings-preview-url')?.value || '',
      ui_font_size: Number(this.$<HTMLInputElement>('#ui-font-size')?.value || this.state.settings.ui_font_size || 14),
      code_font_size: Number(this.$<HTMLInputElement>('#code-font-size')?.value || this.state.settings.code_font_size || 12),
      ui_font_family: this.$<HTMLInputElement>('#ui-font-family')?.value.trim() || this.state.settings.ui_font_family || 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
      code_font_family: this.$<HTMLInputElement>('#code-font-family')?.value.trim() || this.state.settings.code_font_family || '"Cascadia Code", Consolas, monospace',
      appearance_density: this.$<HTMLSelectElement>('#appearance-density')?.value || 'comfortable',
      ui_contrast: Number(this.$<HTMLInputElement>('#appearance-contrast')?.value || this.state.settings.ui_contrast || 100),
      reduced_motion: this.$<HTMLSelectElement>('#reduced-motion')?.value || 'system',
      desktop_notifications_enabled: this.$<HTMLInputElement>('#desktop-notifications-enabled')?.checked ?? true,
      desktop_notification_sound_enabled: this.$<HTMLInputElement>('#desktop-notification-sound-enabled')?.checked ?? true,
      notify_on_agent_waiting: this.$<HTMLInputElement>('#notify-agent-waiting')?.checked ?? true,
      notify_on_agent_done: this.$<HTMLInputElement>('#notify-agent-done')?.checked ?? true,
      notify_on_agent_failed: this.$<HTMLInputElement>('#notify-agent-failed')?.checked ?? true,
      auto_update_enabled: this.$<HTMLInputElement>('#auto-update-enabled')?.checked ?? true,
      update_manifest_url: this.state.settings.update_manifest_url || '',
      update_public_key: this.state.settings.update_public_key || '',
      update_check_on_startup: this.$<HTMLInputElement>('#update-check-on-startup')?.checked ?? true,
      update_check_interval_hours: Number(this.$<HTMLInputElement>('#update-check-interval')?.value || this.state.settings.update_check_interval_hours || 12),
      last_update_check_at: this.state.settings.last_update_check_at || '',
      skipped_update_version: this.state.settings.skipped_update_version || '',
      last_workspace_path: this.currentRoot(),
    }
    this.normalizeAppearanceSettings(next)
    if (!next.channels.length) next.channels = [this.defaultProviderChannel()]
    this.aiTemperature = Number(this.$<HTMLInputElement>('#settings-temperature')?.value || this.aiTemperature)
    this.aiContextBudget = next.context_budget || Number(this.$<HTMLInputElement>('#settings-context-budget')?.value || this.aiContextBudget)
    this.aiSystemPrompt = this.$<HTMLTextAreaElement>('#settings-system-prompt')?.value || this.aiSystemPrompt
    localStorage.setItem('autocode.ide.ai.temperature', String(this.aiTemperature))
    localStorage.setItem('autocode.ide.ai.contextBudget', String(this.aiContextBudget))
    localStorage.setItem('autocode.ide.ai.systemPrompt', this.aiSystemPrompt)
    try {
      this.state.settings = next
      this.ensureProviderChannels()
      this.syncLegacyProviderFieldsFromDefaultChannel()
      this.state.settings = await invoke<IdeSettings>('ide_save_settings', { settings: next })
      this.ensureProviderChannels()
      this.editor.setAiCompletionOptions({ debounceMs: this.state.settings.code_completion?.debounce_ms || 750 })
      this.state.theme = (this.$<HTMLSelectElement>('#theme-select')?.value as AppState['theme']) || this.state.theme
      saveTheme(this.state.theme)
      this.applyTheme()
      this.state.previewUrl = this.state.settings.preview_url
      void this.refreshAgentTools()
      this.closeSettings()
      this.renderAll()
      this.persistSessionSnapshot()
      this.toast('设置已保存', 'ok')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async ensureNotificationPermission() {
    if (this.state.settings.desktop_notifications_enabled === false) return false
    try {
      if (await isPermissionGranted()) return true
      return (await requestPermission()) === 'granted'
    } catch (error) {
      this.toast(`系统通知不可用：${String(error)}`, 'error')
      return false
    }
  }

  private rememberNotificationKey(key: string) {
    if (!key) return false
    if (this.notifiedAgentKeys.includes(key)) return false
    this.notifiedAgentKeys.push(key)
    this.notifiedAgentKeys = this.notifiedAgentKeys.slice(-160)
    return true
  }

  private async sendDesktopNotification(title: string, body: string, key = '') {
    if (key && !this.rememberNotificationKey(key)) return
    if (!(await this.ensureNotificationPermission())) return
    try {
      sendNotification({
        title,
        body,
        group: 'autocode-agent',
        autoCancel: true,
      })
      if (this.state.settings.desktop_notification_sound_enabled !== false) {
        void invoke('ide_play_notification_sound')
      }
    } catch (error) {
      this.toast(`系统通知发送失败：${String(error)}`, 'error')
    }
  }

  private notifyAgentWaiting(kind: string, detail: string, key: string) {
    if (this.state.settings.notify_on_agent_waiting === false) return
    const titles: Record<string, string> = {
      permission: 'Agent 需要你确认操作',
      question: 'Agent 正在等待你的回答',
      patch: 'Patch 已生成，等待应用',
      step: 'Agent 已暂停，等待继续',
    }
    void this.sendDesktopNotification(titles[kind] || 'Agent 正在等待你操作', detail, `waiting:${key}`)
  }

  private notifyAgentCompleted(status: string, detail: string, key: string) {
    const failed = ['failed', 'cancelled', 'paused_patch_failed'].includes(status)
    if (failed && this.state.settings.notify_on_agent_failed === false) return
    if (!failed && this.state.settings.notify_on_agent_done === false) return
    const title = failed ? 'Agent 执行未完成' : 'Agent 任务已完成'
    void this.sendDesktopNotification(title, detail, `done:${key}:${status}`)
  }

  private async testDesktopNotification() {
    await this.sendDesktopNotification('AutoCode IDE 通知测试', 'Windows 桌面通知已可用。', `test:${Date.now()}`)
  }

  private async openWebAutocode(button?: HTMLElement) {
    try {
      this.setInlineActionFeedback(button, 'loading', '打开中...')
      const opened = await invoke<string>('open_autocode_workspace', { grantId: null })
      this.setInlineActionFeedback(button, 'ok', '已打开')
      this.toast('已打开网页端互联任务入口', 'ok')
      console.info('[AutoCode] opened web workspace', opened)
      return
    } catch (error) {
      const root = this.currentRoot()
      const url = new URL('https://muhuo.site/')
      url.searchParams.set('view', 'autocode')
      if (root) {
        url.searchParams.set('connector_action', 'import_local')
        url.searchParams.set('auto_launch_local', '1')
        url.searchParams.set('local_project_path', root)
        url.searchParams.set('local_project_name', projectName(root))
      }
      await invoke<void>('ide_open_url', { url: url.toString() })
      this.setInlineActionFeedback(button, 'ok', '已打开')
      this.toast(root ? '已打开网页端本地项目导入入口' : '已打开网页端代码开发页', 'idle')
    }
  }

  private scheduleStartupUpdateCheck() {
    const settings = this.state.settings
    if (settings.auto_update_enabled === false || settings.update_check_on_startup === false) return
    const intervalHours = Number(settings.update_check_interval_hours || 12)
    const last = Date.parse(settings.last_update_check_at || '') || 0
    if (last && Date.now() - last < intervalHours * 60 * 60 * 1000) return
    window.setTimeout(() => void this.checkForAppUpdate('startup'), 1800)
  }

  private renderUpdateSettingsStatus() {
    const host = this.$('#update-settings-status')
    if (!host) return
    const settings = this.state.settings
    const parts = []
    parts.push(`当前版本：v${this.state.version || '-'}`)
    if (this.updateState.currentVersion && this.updateState.currentVersion !== this.state.version) {
      parts.push(`运行版本：v${this.updateState.currentVersion}`)
    }
    if (settings.auto_update_enabled === false) parts.push('自动更新检查已关闭')
    else parts.push('自动更新检查已开启')
    if (settings.last_update_check_at) parts.push(`上次检查：${formatTime(settings.last_update_check_at)}`)
    if (this.updateState.checking) parts.push('正在检查更新...')
    if (this.updateState.installing) {
      const total = this.updateState.totalBytes
      const done = this.updateState.downloadedBytes
      parts.push(total ? `正在下载：${bytesLabel(done)} / ${bytesLabel(total)}` : `正在下载：${bytesLabel(done)}`)
    }
    if (this.updateState.available) parts.push(`发现新版本：${this.updateState.version}`)
    if (this.updateState.message) parts.push(this.updateState.message)
    if (this.updateState.error) parts.push(`错误：${this.updateState.error}`)
    const updateCard = this.updateState.available ? `
      <article class="update-card">
        <strong>发现新版本 ${escapeHtml(this.updateState.version || '新版本')}</strong>
        <small>${escapeHtml(this.updateState.date || '')}</small>
        <pre>${escapeHtml((this.updateState.body || '此版本没有提供更新说明。').slice(0, 4000))}</pre>
        <div class="settings-row">
          <button class="secondary-button" data-skip-update="${escapeHtml(this.updateState.version)}">跳过此版本</button>
        </div>
      </article>
    ` : ''
    host.innerHTML = `${parts.map(item => `<span>${escapeHtml(item)}</span>`).join('')}${updateCard}`
    const install = this.$<HTMLButtonElement>('#install-app-update')
    if (install) {
      const canInstall = this.updateState.available && !this.updateState.installing
      install.hidden = !canInstall
      install.textContent = this.updateState.installing ? '安装中...' : `安装 ${this.updateState.version || '更新'}`
    }
  }

  private async checkForAppUpdate(source: 'startup' | 'manual' = 'manual') {
    const settings = this.state.settings
    if (settings.auto_update_enabled === false && source === 'startup') return
    this.updateState.checking = true
    this.updateState.error = ''
    this.updateState.message = ''
    this.updateState.available = false
    this.renderUpdateSettingsStatus()
    try {
      const result = await this.api.updateCheck(settings)
      this.state.settings.last_update_check_at = new Date().toISOString()
      this.updateState.currentVersion = String(result.currentVersion || this.state.version || '')
      this.updateState.version = String(result.version || '')
      this.updateState.date = String(result.date || '')
      this.updateState.body = String(result.body || result.rawJson?.notes || '')
      const skipped = Boolean(result.available) && this.state.settings.skipped_update_version === this.updateState.version
      this.updateState.available = Boolean(result.available) && !skipped
      if (skipped) {
        this.updateState.available = false
        this.updateState.message = `已跳过版本 ${this.updateState.version}`
      } else {
        this.updateState.message = this.updateState.available ? '发现可安装的新版本' : String(result.message || '已是最新版本')
      }
      if (this.updateState.available && this.state.settings.skipped_update_version !== this.updateState.version) {
        this.showUpdateDialog()
      } else if (source === 'manual') {
        this.toast(this.updateState.message, this.updateState.available ? 'ok' : 'idle')
      }
      void this.persistSettingsFromState()
    } catch (error) {
      this.updateState.error = String(error)
      if (source === 'manual') this.toast(`检查更新失败：${String(error)}`, 'error')
    } finally {
      this.updateState.checking = false
      this.renderUpdateSettingsStatus()
    }
  }

  private showUpdateDialog() {
    const version = this.updateState.version || '新版本'
    this.toast(`发现新版本 ${version}，可在设置中查看并安装。`, 'ok')
    this.renderUpdateSettingsStatus()
  }

  private handleUpdateProgress(event: UpdateProgressEvent) {
    if (event.event === 'finished') {
      this.updateState.message = '更新包已下载，正在启动安装程序'
      this.updateState.installing = false
    } else {
      this.updateState.installing = true
      this.updateState.downloadedBytes += Number(event.chunkLength || 0)
      if (event.contentLength) this.updateState.totalBytes = Number(event.contentLength)
    }
    this.renderUpdateSettingsStatus()
  }

  private async downloadAndInstallUpdate() {
    if (!this.updateState.available) {
      await this.checkForAppUpdate('manual')
      if (!this.updateState.available) return
    }
    this.updateState.installing = true
    this.updateState.error = ''
    this.updateState.downloadedBytes = 0
    this.updateState.totalBytes = 0
    this.renderUpdateSettingsStatus()
    try {
      await this.api.updateInstall(this.state.settings)
      this.toast('更新安装程序已启动，应用可能会自动重启。', 'ok')
    } catch (error) {
      this.updateState.error = String(error)
      this.toast(`安装更新失败：${String(error)}`, 'error')
    } finally {
      this.updateState.installing = false
      this.renderUpdateSettingsStatus()
    }
  }

  private async skipUpdateVersion(version: string) {
    this.state.settings.skipped_update_version = version
    this.updateState.available = false
    this.updateState.message = `已跳过版本 ${version}`
    await this.persistSettingsFromState()
    this.renderUpdateSettingsStatus()
    this.toast(`已跳过版本 ${version}`, 'idle')
  }

  private async initializeAutocodeProject() {
    const root = this.currentRoot()
    if (!root) {
      this.toast('请先打开一个项目，再初始化 .autocode 配置', 'error')
      return
    }
    try {
      const result = await this.api.initializeAutocodeProject(root)
      const created = Array.isArray(result?.created) ? result.created : []
      if (created.length) {
        this.toast(`已创建 ${created.join('、')}`, 'ok')
      } else {
        this.toast('.autocode 配置已存在，未覆盖任何文件', 'ok')
      }
      void this.api.agentMemoryRead(root)
      void this.refreshAgentTools()
    } catch (error) {
      this.toast(`初始化 .autocode 失败：${String(error)}`, 'error')
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
    const previous = this.state.activeActivity
    if (previous !== view && previous === 'channels') this.channelCollapseInitializedForOpen = false
    this.state.activeActivity = view
    if (view === 'channels' && !this.channelCollapseInitializedForOpen) {
      this.collapseAllProviderChannels()
      this.channelCollapseInitializedForOpen = true
    }
    this.applyActivityState()
    if (view === 'git') this.switchDock('git')
    if (view === 'skills') {
      this.switchDock('skills')
      if (!this.state.skills.items.length) void this.loadSkills()
    }
    if (view === 'channels') this.renderChannels()
    this.scheduleSessionPersist()
  }

  private applyActivityState() {
    const view = this.state.activeActivity
    this.root.querySelectorAll<HTMLElement>('[data-activity]').forEach(item => item.classList.toggle('active', item.dataset.activity === view))
    this.root.querySelectorAll<HTMLElement>('[data-side-view]').forEach(item => item.classList.toggle('active', item.dataset.sideView === view))
  }

  private switchDock(tab: DockTab) {
    this.state.activeDock = tab
    this.root.querySelectorAll<HTMLElement>('[data-dock]').forEach(item => item.classList.toggle('active', item.dataset.dock === tab))
    this.root.querySelectorAll<HTMLElement>('[data-dock-panel]').forEach(item => item.classList.toggle('active', item.dataset.dockPanel === tab))
    if (tab === 'terminal') this.terminal.fit()
    if (tab === 'git') void this.refreshGit()
    this.scheduleSessionPersist()
  }

  private switchComposerMode(mode: ComposerMode) {
    this.state.composerMode = mode
    this.renderComposer()
    if (mode === 'voice') void this.refreshOfflineSttStatus(false)
    this.scheduleSessionPersist()
  }

  private toggleAssistant() {
    this.state.layout.assistantCollapsed = !this.state.layout.assistantCollapsed
    this.applyLayout()
  }

  private toggleAgentConsoleSize() {
    this.agentConsoleExpanded = !this.agentConsoleExpanded
    this.agentConsoleHeight = 0
    localStorage.setItem('autocode.ide.agentConsoleExpanded', this.agentConsoleExpanded ? '1' : '0')
    localStorage.removeItem('autocode.ide.agentConsoleHeight')
    const console = this.$('#agent-console')
    console?.classList.toggle('expanded', this.agentConsoleExpanded)
    console?.classList.remove('manual-height')
    console?.style.removeProperty('--agent-console-height')
    const button = this.$('.agent-console-size-toggle')
    if (button) button.textContent = this.agentConsoleExpanded ? '紧凑' : '舒展'
  }

  private setMainRegionOrder(order: MainRegion[]) {
    this.state.layout.regionOrder = this.normalizeMainRegionOrder(order)
    this.applyLayout()
    this.hideContextMenu()
    this.toast(`布局已切换：${this.state.layout.regionOrder.map(region => mainRegionLabels[region]).join(' / ')}`, 'ok')
    this.scheduleSessionPersist()
  }

  private applyLayoutPreset(presetId: string) {
    if (presetId === 'cycle') return this.cycleLayoutPreset()
    const preset = mainLayoutPresets.find(item => item.id === presetId)
    if (!preset) return
    this.setMainRegionOrder(preset.order)
  }

  private cycleLayoutPreset() {
    const current = this.normalizeMainRegionOrder().join('-')
    const index = Math.max(0, mainLayoutPresets.findIndex(item => item.order.join('-') === current))
    const next = mainLayoutPresets[(index + 1) % mainLayoutPresets.length]
    this.setMainRegionOrder(next.order)
  }

  private showLayoutMenu(anchor: HTMLElement) {
    const menu = this.$('#context-menu')
    if (!menu) return
    const current = this.normalizeMainRegionOrder().join('-')
    menu.innerHTML = `
      <div class="context-title">三栏布局</div>
      ${mainLayoutPresets.map(item => {
        const active = item.order.join('-') === current
        return `
          <button data-layout-preset="${escapeHtml(item.id)}" class="${active ? 'active' : ''}">
            <span>${active ? '✓' : '▦'}</span>
            <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></div>
            ${active ? '<em>当前</em>' : ''}
          </button>
        `
      }).join('')}
      <button data-layout-preset="cycle">
        <span>⟳</span>
        <div><strong>轮换下一个布局</strong><small>依次切换全部 6 种排列</small></div>
      </button>
    `
    const rect = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 360))}px`
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 360))}px`
    menu.removeAttribute('hidden')
  }

  private toggleBottom() {
    this.state.layout.bottomCollapsed = !this.state.layout.bottomCollapsed
    this.applyLayout()
  }

  private isAgentRunningForComposer() {
    return Boolean(
      this.pendingAiRequest
      || this.aiFallbackRunning
      || ['running', 'waiting_permission', 'compacting', 'cancelling'].includes(String(this.state.agentRuntime.status || '')),
    )
  }

  private updateComposerSubmitButton() {
    const button = this.$<HTMLButtonElement>('#create-task')
    const stopButton = this.$<HTMLButtonElement>('#cancel-agent-from-composer')
    const optimizeButton = this.$<HTMLButtonElement>('#optimize-composer-prompt')
    if (!button) return
    const running = this.isAgentRunningForComposer()
    const cancelling = String(this.state.agentRuntime.status || '') === 'cancelling'
    button.classList.toggle('composer-queue-button', running)
    button.classList.toggle('loading', false)
    button.disabled = false
    button.title = running
      ? '当前 Agent 正在执行，发送会排队到下一轮'
      : '发送消息'
    button.innerHTML = running
      ? `排队发送`
      : '发送'
    if (stopButton) {
      stopButton.hidden = !running
      stopButton.classList.toggle('loading', cancelling)
      stopButton.title = cancelling ? '再次点击强制停止 Agent' : '请求 Agent 收尾停止'
      stopButton.innerHTML = `<span class="stop-icon" aria-hidden="true"></span><span>${cancelling ? '强制停止' : '停止'}</span>`
    }
    if (optimizeButton) {
      const draft = (this.$<HTMLTextAreaElement>('#task-prompt')?.value || this.composerDraft || '').trim()
      const canUndo = Boolean(this.lastComposerPromptBeforeOptimize) && !this.composerOptimizeBusy
      optimizeButton.classList.toggle('loading', this.composerOptimizeBusy)
      optimizeButton.classList.toggle('undo-ready', canUndo)
      optimizeButton.disabled = this.composerOptimizeBusy || (!draft && !canUndo)
      optimizeButton.title = this.composerOptimizeBusy
        ? '正在优化输入内容'
        : canUndo
          ? '撤销上一次优化'
          : '优化输入内容，让需求更清晰精炼'
      optimizeButton.textContent = this.composerOptimizeBusy ? '优化中' : canUndo ? '撤销优化' : '优化'
    }
  }

  private openSettings() {
    this.state.settingsOpen = true
    this.fillSettings()
    this.root.querySelectorAll<HTMLDetailsElement>('#settings-drawer details').forEach(details => { details.open = false })
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
    if (action === 'layout') this.cycleLayoutPreset()
    if (action === 'settings') this.openSettings()
  }

  private renderAll() {
    this.ensureProviderChannels()
    this.applyActivityState()
    this.renderWorkspace()
    this.renderTree()
    this.renderRecent()
    this.renderTabs()
    this.renderEditor()
    this.renderSearch()
    this.renderSkills()
    this.renderChannels()
    this.renderProblems()
    this.renderProviderStatus()
    this.renderRequestTimeline()
    this.renderTerminalSessions()
    this.renderAssistant()
    this.renderComposer()
    this.syncComposerDraftToDom()
    this.fillSettings()
  }

  private showActiveFileDiff() {
    const tab = this.activeTab()
    if (!tab) return this.toast('请先打开一个文件', 'idle')
    const diff = this.extractFileDiff(tab.path)
    const summary = this.$('#git-summary')
    const diffNode = this.$('#git-diff')
    if (!diff.trim()) {
      this.toast('当前文件没有 Git diff', 'idle')
      return
    }
    this.gitDiffFocusPath = tab.path
    if (summary) {
      summary.innerHTML = `<strong>当前文件 diff</strong><span>${escapeHtml(tab.path)}</span>`
    }
    if (diffNode) diffNode.textContent = diff
    this.switchDock('git')
  }

  private async showGitFileDiff(path: string, staged = false) {
    if (!this.currentRoot()) return
    const normalized = this.resolveWorkspaceMessagePath(path)
    this.gitDiffFocusPath = normalized
    try {
      const result = await this.api.gitFileDiff(this.currentRoot()!, normalized, staged)
      const summary = this.$('#git-summary')
      const diffNode = this.$('#git-diff')
      if (summary) summary.innerHTML = `<strong>当前文件 diff</strong><span>${escapeHtml(normalized)}</span><span>${staged ? '已暂存' : '工作区'}</span>`
      if (diffNode) diffNode.textContent = String(result?.diff || '')
      this.switchDock('git')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async showGitCommit(commitHash: string) {
    if (!this.currentRoot()) return
    try {
      const result = await this.api.gitCommitShow(this.currentRoot()!, commitHash)
      const summary = this.$('#git-summary')
      const diffNode = this.$('#git-diff')
      if (summary) {
        summary.innerHTML = `
          <strong>提交详情</strong>
          <span>${escapeHtml(String(result?.short_hash || commitHash))}</span>
          <span>${escapeHtml(String(result?.subject || ''))}</span>
          <span>${escapeHtml(String(result?.author || ''))}</span>
        `
      }
      if (diffNode) diffNode.textContent = String(result?.summary || '这个提交没有文件变更摘要。')
      this.switchDock('git')
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private defaultProviderChannel(): ProviderChannel {
    return {
      id: 'default',
      name: '默认渠道',
      provider_type: this.state.settings.provider_type || 'openai-responses',
      api_protocol: this.state.settings.api_protocol || '',
      api_base_url: this.state.settings.api_base_url || '',
      api_key: this.state.settings.api_key || '',
      custom_headers: this.state.settings.custom_headers || {},
      enabled: true,
      priority: 10,
      weight: 1,
      purposes: ['chat', 'agent', 'reasoning', 'codeCompletion', 'audioTranscription'],
      models: this.state.settings.model ? [this.state.settings.model] : [],
      enabled_models: this.state.settings.model ? [this.state.settings.model] : [],
      model_filter_configured: false,
      default_model: this.state.settings.model || '',
      code_completion_model: '',
      account_status: '',
      last_error: '',
      capabilities: {},
      updated_at: new Date().toISOString(),
    }
  }

  private ensureProviderChannels() {
    const settings = this.state.settings
    if (!Array.isArray(settings.channels) || !settings.channels.length) {
      settings.channels = [this.defaultProviderChannel()]
    }
    settings.default_routes = settings.default_routes || {}
    for (const purpose of ['chat', 'agent', 'reasoning', 'codeCompletion', 'audioTranscription']) {
      if (!settings.default_routes[purpose]) settings.default_routes[purpose] = settings.channels[0]?.id || 'default'
    }
    settings.code_completion = {
      enabled: true,
      trigger: 'idle',
      debounce_ms: 750,
      max_prefix_chars: 5000,
      max_suffix_chars: 2000,
      model: '',
      channel_id: '',
      prompt: '只返回应该插入到光标位置的代码，不要解释，不要 Markdown，不要代码围栏，不要重复已有前缀。',
      ...(settings.code_completion || {}),
    }
    for (const channel of settings.channels) {
      channel.models = Array.isArray(channel.models) ? [...new Set(channel.models)] : []
      channel.enabled_models = Array.isArray(channel.enabled_models) ? channel.enabled_models : []
      channel.model_filter_configured = channel.model_filter_configured === true
      channel.code_completion_model = channel.code_completion_model || ''
      channel.custom_headers = channel.custom_headers || {}
      channel.api_protocol = channel.api_protocol || (channel.provider_type === 'local-openai-compatible' ? 'auto' : '')
    }
  }

  private enabledChannelModels(channel: ProviderChannel) {
    return channel.model_filter_configured ? (channel.enabled_models || []) : (channel.models || [])
  }

  private channelSupportsPurpose(channel: ProviderChannel, purpose = 'agent') {
    if (!channel.enabled) return false
    if (purpose === 'chat' || purpose === 'agent' || purpose === 'reasoning') return true
    return !channel.purposes?.length || channel.purposes.includes(purpose)
  }

  private channelSupportsSelectedModel(channel: ProviderChannel, model = this.state.settings.model) {
    const cleanModel = String(model || '').trim()
    if (!cleanModel || cleanModel.toLowerCase() === 'auto') return true
    const models = this.enabledChannelModels(channel)
    return !models.length || models.includes(cleanModel) || channel.default_model === cleanModel
  }

  private sortedEnabledChannels(purpose = 'agent', model = this.state.settings.model) {
    return this.state.settings.channels
      .filter(channel => this.channelSupportsPurpose(channel, purpose))
      .filter(channel => this.channelSupportsSelectedModel(channel, model))
      .sort((a, b) =>
        (b.priority ?? 10) - (a.priority ?? 10)
        || (b.weight ?? 1) - (a.weight ?? 1)
        || a.id.localeCompare(b.id),
      )
  }

  private activeProviderChannel(purpose = 'agent') {
    const model = this.state.settings.model
    return this.sortedEnabledChannels(purpose, model)[0]
      || this.state.settings.channels.filter(channel => channel.enabled).sort((a, b) => (b.priority ?? 10) - (a.priority ?? 10))[0]
      || null
  }

  private activeProviderModel(channel = this.activeProviderChannel('agent')) {
    const selected = String(this.state.settings.model || '').trim()
    if (selected && selected.toLowerCase() !== 'auto' && (!channel || this.channelSupportsSelectedModel(channel, selected))) return selected
    return channel?.default_model || (channel ? this.enabledChannelModels(channel)[0] : '') || this.aggregateProviderModels()[0] || ''
  }

  private activeProviderLabel(purpose = 'agent') {
    const channel = this.activeProviderChannel(purpose)
    const provider = channel?.provider_type || this.state.settings.provider_type || '未配置 Provider'
    const model = this.activeProviderModel(channel) || this.state.settings.model || '未选择模型'
    return {
      channel,
      provider,
      model,
      text: channel
        ? `${provider} / ${model} · 渠道 ${channel.name || channel.id}`
        : `${provider} / ${model}`,
    }
  }

  private aggregateProviderModels() {
    const models = this.state.settings.channels
      .filter(channel => channel.enabled)
      .flatMap(channel => this.enabledChannelModels(channel))
      .filter(Boolean)
    return [...new Set(models)].sort((a, b) => a.localeCompare(b))
  }

  private toggleChannelCollapsed(channelId: string) {
    if (this.collapsedChannelIds.has(channelId)) this.collapsedChannelIds.delete(channelId)
    else this.collapsedChannelIds.add(channelId)
    this.renderChannels()
  }

  private collapseAllProviderChannels() {
    this.ensureProviderChannels()
    this.collapsedChannelIds = new Set(this.state.settings.channels.map(channel => channel.id).filter(Boolean))
  }

  private toggleChannelKeyVisible(channelId: string) {
    this.syncChannelCardFromDom(channelId)
    if (this.visibleChannelKeyIds.has(channelId)) this.visibleChannelKeyIds.delete(channelId)
    else this.visibleChannelKeyIds.add(channelId)
    this.renderChannels()
  }

  private renderChannels() {
    this.ensureProviderChannels()
    if (this.state.activeActivity === 'channels' && !this.channelCollapseInitializedForOpen) {
      this.collapseAllProviderChannels()
      this.channelCollapseInitializedForOpen = true
    }
    const list = this.$('#channel-list')
    const summary = this.$('#channel-route-summary')
    const enabled = this.state.settings.channels.filter(channel => channel.enabled)
    const models = this.aggregateProviderModels()
    if (summary) {
      summary.innerHTML =         `<div><b>请求路由</b><span>按模型匹配 · 高优先级优先 · 失败自动切换</span></div>
         <div><b>已启用</b><span>${enabled.length} 个渠道 · ${models.length} 个去重模型</span></div>
         <label class="channel-global-toggle"><input type="checkbox" id="channel-completion-enabled" ${this.state.settings.code_completion?.enabled !== false ? 'checked' : ''} /><span>启用 AI 代码补全</span></label>`
    }
    if (!list) return
    const providerOptions = [
      ['openai-responses', 'OpenAI Responses'], ['openai-chat', 'OpenAI Chat'],
      ['anthropic-messages', 'Claude Messages'], ['dashscope-qwen', '阿里千问 Chat Completions'],
      ['qwen-responses', '千问 Responses / 内建网页工具'],
      ['deepseek', 'DeepSeek 官方 Chat Completions'], ['kimi', 'Kimi / Moonshot'], ['zhipu', '智谱 / Z.ai'],
      ['xai-grok', 'Grok / xAI'],
      ['local-openai-compatible', '本地模型 / Ollama'],
      ['custom-openai-compatible', '自定义 OpenAI 兼容'],
    ]
    list.innerHTML = this.state.settings.channels.map(channel => {
      const models = channel.models || []
      const enabledModels = new Set(this.enabledChannelModels(channel))
      const modelOptions = models.map(model => `<option value="${escapeHtml(model)}" ${model === channel.default_model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')
      const completionOptions = models.map(model => `<option value="${escapeHtml(model)}" ${model === channel.code_completion_model ? 'selected' : ''}>${escapeHtml(model)}</option>`).join('')
      const modelChecks = models.length ? models.map(model =>         `<label class="channel-model-item"><input type="checkbox" data-channel-model="${escapeHtml(model)}" data-channel-id="${escapeHtml(channel.id)}" ${enabledModels.has(model) ? 'checked' : ''} /><span>${escapeHtml(model)}</span></label>`).join('') : '<div class="empty-hint">尚未刷新模型列表。</div>'
      const protocol = channel.api_protocol || (channel.provider_type === 'local-openai-compatible' ? 'auto' : '')
      const keyLabel = channel.provider_type === 'local-openai-compatible' ? 'API Key（本地可留空）' : 'API Key'
      const collapsed = this.collapsedChannelIds.has(channel.id)
      const keyVisible = this.visibleChannelKeyIds.has(channel.id)
      return `<article class="channel-card ${collapsed ? 'collapsed' : ''}" data-channel-card="${escapeHtml(channel.id)}">
        <header>
          <button class="channel-collapse-button" data-channel-toggle="${escapeHtml(channel.id)}" title="${collapsed ? '展开渠道' : '收起渠道'}">${collapsed ? '▸' : '▾'}</button>
          <div><strong>${escapeHtml(channel.name || channel.id)}</strong><span>${escapeHtml(channel.provider_type)} · ${models.length ? `${enabledModels.size}/${models.length} 模型` : '未刷新模型'}</span></div>
          <label class="channel-enable"><input type="checkbox" data-channel-field="enabled" data-channel-id="${escapeHtml(channel.id)}" ${channel.enabled ? 'checked' : ''} /><span>启用</span></label>
        </header>
        <div class="channel-body" ${collapsed ? 'hidden' : ''}>
          <div class="channel-form-grid">
            <label><span>渠道名称</span><input data-channel-field="name" data-channel-id="${escapeHtml(channel.id)}" value="${escapeHtml(channel.name || '')}" /></label>
            <label><span>Provider 类型</span><select data-channel-field="provider_type" data-channel-id="${escapeHtml(channel.id)}">${providerOptions.map(([value, label]) => `<option value="${value}" ${value === channel.provider_type ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
            <label><span>协议策略</span><select data-channel-field="api_protocol" data-channel-id="${escapeHtml(channel.id)}"><option value="" ${protocol === '' ? 'selected' : ''}>跟随 Provider 默认</option><option value="auto" ${protocol === 'auto' ? 'selected' : ''}>Responses 优先，Chat 兜底</option><option value="responses" ${protocol === 'responses' ? 'selected' : ''}>强制 Responses</option><option value="chat_completions" ${protocol === 'chat_completions' ? 'selected' : ''}>强制 Chat Completions</option></select></label>
            <label class="channel-wide"><span>API URL</span><input data-channel-field="api_base_url" data-channel-id="${escapeHtml(channel.id)}" value="${escapeHtml(channel.api_base_url || '')}" spellcheck="false" /></label>
            <label class="channel-wide channel-key-field"><span>${keyLabel}</span><div><input type="${keyVisible ? 'text' : 'password'}" data-channel-field="api_key" data-channel-id="${escapeHtml(channel.id)}" value="${escapeHtml(channel.api_key || '')}" spellcheck="false" autocomplete="off" /><button type="button" class="secondary-button" data-channel-key-toggle="${escapeHtml(channel.id)}">${keyVisible ? '隐藏' : '查看'}</button></div></label>
            <label><span>优先级（数值越大越优先）</span><input type="number" data-channel-field="priority" data-channel-id="${escapeHtml(channel.id)}" value="${channel.priority ?? 10}" /></label>
            <label><span>默认模型</span><select data-channel-field="default_model" data-channel-id="${escapeHtml(channel.id)}"><option value="">自动选择</option>${modelOptions}</select></label>
            <label class="channel-wide"><span>代码补全专用模型</span><select data-channel-field="code_completion_model" data-channel-id="${escapeHtml(channel.id)}"><option value="">不用于补全 / 使用默认模型</option>${completionOptions}</select></label>
            <label class="channel-wide"><span>自定义 Headers JSON</span><textarea data-channel-field="custom_headers" data-channel-id="${escapeHtml(channel.id)}" spellcheck="false">${escapeHtml(JSON.stringify(channel.custom_headers || {}, null, 2))}</textarea></label>
          </div>
          <details class="channel-models" ${models.length && models.length <= 12 ? 'open' : ''}>
            <summary>启用模型（${enabledModels.size}/${models.length}）</summary>
            <div class="channel-model-list">${modelChecks}</div>
          </details>
        </div>
        ${channel.last_error ? `<small class="error-text">${escapeHtml(channel.last_error)}</small>` : ''}
        ${channel.account_status ? `<div class="channel-account-status"><strong>账户余额</strong><span>${escapeHtml(this.displayAccountStatus(channel.account_status).slice(0, 260))}</span></div>` : ''}
        <div class="channel-actions">
          <button class="primary-button" data-channel-action="save" data-channel-id="${escapeHtml(channel.id)}">保存渠道</button>
          <button class="secondary-button" data-channel-action="test" data-channel-id="${escapeHtml(channel.id)}">测试</button>
          <button class="secondary-button" data-channel-action="models" data-channel-id="${escapeHtml(channel.id)}">刷新模型</button>
          <button class="secondary-button" data-channel-action="account" data-channel-id="${escapeHtml(channel.id)}">查询账户</button>
          ${channel.id !== 'default' ? `<button class="secondary-button danger" data-channel-action="delete" data-channel-id="${escapeHtml(channel.id)}">删除</button>` : ''}
        </div>
      </article>`
    }).join('')
  }

  private updateChannelField(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
    const channelId = target.dataset.channelId
    const field = target.dataset.channelField as keyof ProviderChannel | undefined
    const channel = this.state.settings.channels.find(item => item.id === channelId)
    if (!channel || !field) return
    if (field === 'enabled') channel.enabled = (target as HTMLInputElement).checked
    else if (field === 'priority' || field === 'weight') (channel as any)[field] = Number(target.value || 0)
    else if (field === 'provider_type') {
      channel.provider_type = target.value
      if (target.value === 'local-openai-compatible') {
        if (!channel.api_base_url?.trim()) channel.api_base_url = 'http://127.0.0.1:11434'
        if (!channel.name?.trim() || channel.name.startsWith('渠道 ')) channel.name = '本地模型 / Ollama'
        channel.api_protocol = channel.api_protocol || 'auto'
        channel.api_key = channel.api_key || ''
      } else if (channel.api_protocol === 'auto') {
        channel.api_protocol = ''
      }
      this.renderChannels()
    }
    else if (field === 'custom_headers') {
      try {
        channel.custom_headers = JSON.parse(target.value || '{}')
        target.classList.remove('invalid')
      } catch {
        target.classList.add('invalid')
      }
    } else (channel as any)[field] = target.value
  }

  private syncChannelCardFromDom(channelId: string) {
    const card = this.root.querySelector<HTMLElement>(`[data-channel-card="${CSS.escape(channelId)}"]`)
    if (!card) return
    card
      .querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[data-channel-field]')
      .forEach(input => this.updateChannelField(input))
    const channel = this.state.settings.channels.find(item => item.id === channelId)
    if (!channel) return
    const selected = new Set<string>()
    let sawModelCheckbox = false
    card.querySelectorAll<HTMLInputElement>('[data-channel-model]').forEach(input => {
      sawModelCheckbox = true
      if (input.checked && input.dataset.channelModel) selected.add(input.dataset.channelModel)
    })
    if (sawModelCheckbox) {
      channel.enabled_models = [...selected]
      channel.model_filter_configured = true
    }
  }

  private syncLegacyProviderFieldsFromDefaultChannel() {
    const primary = this.activeProviderChannel('agent')
    if (!primary) return
    this.state.settings.provider_type = primary.provider_type
    this.state.settings.api_protocol = primary.api_protocol || ''
    this.state.settings.api_base_url = primary.api_base_url
    this.state.settings.api_key = primary.api_key
    this.state.settings.custom_headers = primary.custom_headers || {}
    const availableModels = this.aggregateProviderModels()
    const current = this.state.settings.model || ''
    this.state.settings.model = current && availableModels.includes(current)
      ? current
      : primary.default_model || this.enabledChannelModels(primary)[0] || availableModels[0] || ''
  }

  private replaceChannel(saved: ProviderChannel) {
    const index = this.state.settings.channels.findIndex(item => item.id === saved.id)
    if (index >= 0) this.state.settings.channels[index] = { ...this.state.settings.channels[index], ...saved }
    else this.state.settings.channels.push(saved)
    return this.state.settings.channels.find(item => item.id === saved.id) || saved
  }

  private channelActionFeedback(channelId: string, action: string, state: 'loading' | 'ok' | 'error', label?: string) {
    const button = this.root.querySelector<HTMLButtonElement>(
      `[data-channel-action="${CSS.escape(action)}"][data-channel-id="${CSS.escape(channelId)}"]`,
    )
    if (!button) return
    const original = button.dataset.originalLabel || button.textContent || ''
    button.dataset.originalLabel = original
    button.classList.toggle('loading', state === 'loading')
    button.classList.toggle('copy-ok', state === 'ok')
    button.classList.toggle('copy-error', state === 'error')
    button.disabled = state === 'loading'
    button.textContent = label || (state === 'loading' ? '处理中...' : state === 'ok' ? '已完成' : '失败')
    if (state !== 'loading') {
      window.setTimeout(() => {
        const current = this.root.querySelector<HTMLButtonElement>(
          `[data-channel-action="${CSS.escape(action)}"][data-channel-id="${CSS.escape(channelId)}"]`,
        )
        if (!current) return
        current.classList.remove('copy-ok', 'copy-error', 'loading')
        current.disabled = false
        current.textContent = current.dataset.originalLabel || original
      }, state === 'ok' ? 900 : 1400)
    }
  }

  private channelActionLabel(action: string, state: 'loading' | 'ok' | 'error') {
    const labels: Record<string, Record<string, string>> = {
      save: { loading: '保存中...', ok: '已保存', error: '保存失败' },
      test: { loading: '测试中...', ok: '测试通过', error: '测试失败' },
      models: { loading: '刷新中...', ok: '已刷新', error: '刷新失败' },
      account: { loading: '查询中...', ok: '已查询', error: '查询失败' },
      delete: { loading: '删除中...', ok: '已删除', error: '删除失败' },
    }
    return labels[action]?.[state] || (state === 'loading' ? '处理中...' : state === 'ok' ? '已完成' : '失败')
  }

  private async runChannelAction(action: string, channelId: string, button?: HTMLElement) {
    this.ensureProviderChannels()
    this.syncChannelCardFromDom(channelId)
    const channel = this.state.settings.channels.find(item => item.id === channelId)
    if (!channel) return
    this.channelActionFeedback(channelId, action, 'loading', this.channelActionLabel(action, 'loading'))
    try {
      const invalid = this.root.querySelector(`[data-channel-card="${CSS.escape(channelId)}"] .invalid`)
      if (invalid && action !== 'delete') throw new Error('自定义 Headers JSON 格式错误。')
      if (action === 'save') {
        channel.updated_at = new Date().toISOString()
        this.replaceChannel(await this.api.channelSave(channel))
        this.syncLegacyProviderFieldsFromDefaultChannel()
        await this.persistSettingsFromState()
        this.toast('渠道配置已保存', 'ok')
      } else if (action === 'test') {
        this.replaceChannel(await this.api.channelSave(channel))
        this.syncLegacyProviderFieldsFromDefaultChannel()
        this.toast('正在测试渠道...', 'busy')
        await this.api.channelTest(channelId)
        this.toast('渠道连接正常', 'ok')
      } else if (action === 'models') {
        const saved = this.replaceChannel(await this.api.channelSave(channel))
        this.toast('正在刷新渠道模型...', 'busy')
        const hadExplicitSelection = saved.model_filter_configured === true
        const result = await this.api.channelRefreshModels(channelId)
        saved.models = this.extractModelNames(result)
        if (!hadExplicitSelection) saved.enabled_models = [...saved.models]
        saved.model_filter_configured = hadExplicitSelection || saved.models.length > 0
        this.replaceChannel(await this.api.channelSave(saved))
        this.toast(`已刷新 ${saved.models.length} 个模型`, 'ok')
      } else if (action === 'account') {
        const saved = this.replaceChannel(await this.api.channelSave(channel))
        this.toast('正在查询渠道账户...', 'busy')
        const result = await this.api.channelAccountStatus(channelId)
        saved.account_status = this.describeAccountStatus(result)
        saved.last_error = ''
        this.replaceChannel(await this.api.channelSave(saved))
        this.toast('渠道账户状态已刷新', 'ok')
      } else if (action === 'delete') {
        if (!window.confirm(`删除渠道“${channel.name || channelId}”？`)) return
        await this.api.channelDelete(channelId)
        this.state.settings.channels = this.state.settings.channels.filter(item => item.id !== channelId)
        this.toast('渠道已删除', 'ok')
      }
      this.renderChannels()
      this.channelActionFeedback(channelId, action, 'ok', this.channelActionLabel(action, 'ok'))
    } catch (error) {
      channel.last_error = String(error)
      this.toast(String(error), 'error')
      this.renderChannels()
      this.channelActionFeedback(channelId, action, 'error', this.channelActionLabel(action, 'error'))
    }
    this.renderProviderStatus()
    this.renderComposer()
  }

  private async addProviderChannel() {
    this.ensureProviderChannels()
    const id = `channel-${Date.now()}`
    const channel: ProviderChannel = {
      ...this.defaultProviderChannel(), id, name: `渠道 ${this.state.settings.channels.length + 1}`,
      api_base_url: '', api_key: '', models: [], enabled_models: [], model_filter_configured: false, default_model: '', code_completion_model: '',
      updated_at: new Date().toISOString(),
    }
    this.state.settings.channels.push(channel)
    await this.api.channelSave(channel)
    this.renderChannels()
    this.toast('已新增渠道，请直接在渠道卡片中完成配置。', 'ok')
  }

  private renderTerminalSessions() {
    const select = this.$<HTMLSelectElement>('#terminal-session-select')
    const shellSelect = this.$<HTMLSelectElement>('#terminal-shell-select')
    if (!select) {
      if (shellSelect) shellSelect.value = this.terminalShellSelectValue(this.state.terminal.shell || this.defaultTerminalShellArg())
      return
    }
    const sessions = this.state.terminalSessions
    select.innerHTML = sessions.length
      ? sessions.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)} · ${escapeHtml(compactPath(item.cwd))}</option>`).join('')
      : '<option value="">无终端</option>'
    select.value = this.state.terminalSessionId || ''
    if (shellSelect) shellSelect.value = this.terminalShellSelectValue(this.state.terminal.shell || this.defaultTerminalShellArg())
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
      ? recent.map(item => `
        <article class="recent-item ${item.path === this.currentRoot() ? 'active' : ''}">
          <button class="recent-main" data-recent-path="${escapeHtml(item.path)}" title="打开 ${escapeHtml(item.path)}">
            <strong>${escapeHtml(item.name || projectName(item.path))}</strong>
            <span>${escapeHtml(compactPath(item.path))}</span>
            <small>${escapeHtml(formatTime(item.last_opened_at))}</small>
          </button>
          <button class="recent-remove" data-remove-recent-path="${escapeHtml(item.path)}" title="从最近项目移除，不删除文件">×</button>
        </article>
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
    if (save) this.renderEditorSaveButton(save, this.activeTab())
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
    const savingCurrent = tab && this.editorSavePath === tab.path && this.editorSaveState === 'saving'
    this.text('#dirty-status', tab ? (savingCurrent ? '保存中' : dirty(tab) ? '未保存' : '已同步') : 'Ready')
    const save = this.$<HTMLButtonElement>('#save-file')
    if (save) this.renderEditorSaveButton(save, tab)
    this.renderEditorGitStrip()
    this.updateEditorDiffHighlights()
  }

  private renderEditorSaveButton(button: HTMLButtonElement, tab: EditorTab | null) {
    const state = tab && this.editorSavePath === tab.path ? this.editorSaveState : 'idle'
    button.classList.toggle('loading', state === 'saving')
    button.classList.toggle('copy-ok', state === 'ok')
    button.classList.toggle('copy-error', state === 'error')
    button.disabled = !tab || state === 'saving'
    button.textContent = state === 'saving'
      ? '保存中...'
      : state === 'ok'
        ? '已保存'
        : state === 'error'
          ? '保存失败'
          : '保存'
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
    const sideContent = this.$('#git-side-content')
    const summary = this.$('#git-summary')
    const fileList = this.$('#git-file-list')
    const diff = this.$('#git-diff')
    const repository = git.repository !== false
    const initButton = !repository ? '<button class="secondary-button" id="init-git-repository">初始化 Git</button>' : ''
    const hasAnyChanges = (git.staged_count + git.unstaged_count + git.untracked_count) > 0
    const operationMessages = [
      this.gitStatusRefreshing
        ? '<div class="git-operation-status busy">正在后台刷新 Git 状态，当前列表可继续操作。</div>'
        : '',
      this.gitOperationMessage
        ? `<div class="git-operation-status ${escapeHtml(this.gitOperationState)}">${escapeHtml(this.gitOperationMessage)}</div>`
        : '',
    ].filter(Boolean).join('')
    const gitActions = repository ? `
      <div class="git-action-row">
        <span class="git-action-hint">${git.staged_count ? `已暂存 ${git.staged_count} 个文件，填写说明后提交` : hasAnyChanges ? '先暂存变更，再填写提交说明' : '暂无可提交变更'}</span>
        ${operationMessages}
        <button class="secondary-button" data-git-action="stage-all" ${hasAnyChanges ? '' : 'disabled'}>跟踪全部变更</button>
        <button class="secondary-button" data-git-action="unstage-all" ${git.staged_count ? '' : 'disabled'}>取消暂存</button>
        <input id="git-commit-message" placeholder="提交说明，例如：保存编辑器修改" ${git.staged_count ? '' : 'disabled'} />
        <button class="primary-button" id="git-commit-staged" ${git.staged_count ? '' : 'disabled'}>提交</button>
      </div>
    ` : ''
    const html = repository
      ? `<strong>${escapeHtml(git.branch || '未检测到分支')}</strong><span>暂存 ${git.staged_count}</span><span>未暂存 ${git.unstaged_count}</span><span>未跟踪 ${git.untracked_count}</span><span>ahead ${git.ahead} / behind ${git.behind}</span>`
      : `<strong>当前项目还不是 Git 仓库</strong><span>${escapeHtml(git.repository_message || '点击初始化后，代码更改将进入 Git 管理。')}</span>${initButton}`
    const focusedDiff = this.gitDiffFocusPath ? this.extractFileDiff(this.gitDiffFocusPath, git) : ''
    if (mini) mini.innerHTML = html
    if (sideContent) {
      sideContent.innerHTML = repository
        ? this.renderGitSidePanel(git)
        : `<div class="empty-hint">当前目录尚未初始化 Git 仓库。点击初始化后，侧栏会显示变更文件树和提交历史。</div>`
    }
    if (summary) summary.innerHTML = focusedDiff
      ? `<strong>当前文件 diff</strong><span>${escapeHtml(this.gitDiffFocusPath)}</span><span>${escapeHtml(git.branch || '-')}</span>${gitActions}`
      : repository
        ? `${html}${gitActions}`
        : `<strong>当前项目还不是 Git 仓库</strong><span>${escapeHtml(git.repository_message || '点击初始化后，代码更改将进入 Git 管理。')}</span>${initButton}`
    if (fileList) {
      fileList.innerHTML = repository
        ? `${this.renderGitChangeTree(git)}${this.renderGitCommitHistory(git)}`
        : `<div class="empty-hint">当前目录尚未初始化 Git 仓库。点击上方按钮开始跟踪变更。</div>`
    }
    if (diff) {
      diff.textContent = focusedDiff
        ? this.truncateGitDiffForDisplay(focusedDiff)
        : repository
          ? (hasAnyChanges ? '选择左侧文件查看单文件 diff。为避免大仓库卡顿，Git 面板默认不渲染全量 diff。' : '工作区干净。')
          : git.summary || '当前目录尚未初始化 Git 仓库。'
    }
  }

  private renderGitSidePanel(git: WorkspaceGitStatus) {
    const hasAnyChanges = (git.staged_count + git.unstaged_count + git.untracked_count) > 0
    return `
      <div class="git-side-actions">
        <button class="secondary-button" data-git-action="stage-all" ${hasAnyChanges ? '' : 'disabled'}>跟踪全部</button>
        <button class="secondary-button" data-git-action="unstage-all" ${git.staged_count ? '' : 'disabled'}>取消暂存</button>
      </div>
      ${hasAnyChanges ? this.renderGitChangeTree(git, { compact: true }) : this.renderGitCleanState(git)}
      ${this.renderGitCommitHistory(git, { compact: true })}
    `
  }

  private truncateGitDiffForDisplay(diff: string, maxChars = 120000) {
    if (diff.length <= maxChars) return diff
    return `${diff.slice(0, maxChars)}\n\n...[diff 内容过长，已截断显示；请选择更小的文件或使用终端查看完整 diff]`
  }

  private gitGroupedFiles(git: WorkspaceGitStatus) {
    const files = git.files || []
    return git.grouped_files || {
      staged: files.filter(file => file.kind === 'staged' || file.kind === 'staged+unstaged' || file.staged),
      unstaged: files.filter(file => file.kind === 'unstaged' || file.kind === 'staged+unstaged' || (file.unstaged && !file.untracked)),
      untracked: files.filter(file => file.kind === 'untracked' || file.untracked),
    }
  }

  private renderGitCleanState(git: WorkspaceGitStatus) {
    const latest = git.recent_commits?.[0]
    return `
      <section class="git-clean-card">
        <strong>工作区干净</strong>
        <span>没有待暂存、未暂存或未跟踪文件。</span>
        ${latest ? `<small>最近提交：${escapeHtml(latest.short_hash)} · ${escapeHtml(latest.subject || '(无提交说明)')}</small>` : '<small>提交后会在下面显示历史记录。</small>'}
      </section>
    `
  }

  private renderGitChangeTree(git: WorkspaceGitStatus, options: { compact?: boolean } = {}) {
    const groups = this.gitGroupedFiles(git)
    const sections = [
      ['staged', '已暂存', groups.staged, true],
      ['unstaged', '更改', groups.unstaged, false],
      ['untracked', '未跟踪', groups.untracked, false],
    ] as Array<[string, string, WorkspaceGitStatus['files'], boolean]>
    const content = sections.map(([kind, label, files, staged]) => `
      <details class="git-change-section ${kind}" open>
        <summary><strong>${label}</strong><span>${files?.length || 0}</span></summary>
        <div class="git-change-tree">
          ${files?.length ? this.renderGitFileRows(files, Boolean(staged)) : '<div class="empty-hint compact">暂无文件。</div>'}
        </div>
      </details>
    `).join('')
    const hasAnyChanges = sections.some(([, , files]) => Boolean(files?.length))
    if (!hasAnyChanges && options.compact) return this.renderGitCleanState(git)
    return `<section class="git-scm-view ${options.compact ? 'compact' : ''}">${content}</section>`
  }

  private renderGitFileRows(files: NonNullable<WorkspaceGitStatus['files']>, stagedSection: boolean) {
    const maxRows = 200
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
    const visible = sorted.slice(0, maxRows)
    let lastParent = ''
    const rows = visible.map(file => {
      const parent = file.parent || file.path.split('/').slice(0, -1).join('/')
      const name = file.name || basename(file.path)
      const folder = parent && parent !== lastParent
        ? `<div class="git-folder-row">${escapeHtml(parent)}/</div>`
        : ''
      if (parent) lastParent = parent
      const canStage = file.kind !== 'staged' && file.kind !== 'staged+unstaged'
      const canUnstage = file.kind === 'staged' || file.kind === 'staged+unstaged' || stagedSection
      return `
        ${folder}
        <article class="git-file-row ${escapeHtml(file.kind)}">
          <button class="git-file-main" data-git-file-path="${escapeHtml(file.path)}" title="打开并查看 diff">
            <strong>${escapeHtml(name)}</strong>
            <span>${escapeHtml(parent || '.')} · ${escapeHtml(this.gitFileKindLabel(file.kind))} · ${escapeHtml(file.index_status || ' ')}${escapeHtml(file.worktree_status || ' ')}</span>
          </button>
          <div class="git-file-actions">
            ${canStage ? `<button class="icon-button" data-git-stage-path="${escapeHtml(file.path)}" title="暂存此文件">+</button>` : ''}
            ${canUnstage ? `<button class="icon-button" data-git-unstage-path="${escapeHtml(file.path)}" title="取消暂存">−</button>` : ''}
            <button class="icon-button" data-open-system-path="${escapeHtml(this.absolutePath(file.path))}" title="在资源管理器中显示">↗</button>
          </div>
        </article>
      `
    }).join('')
    const hidden = sorted.length - visible.length
    return hidden > 0
      ? `${rows}<div class="empty-hint compact">还有 ${hidden} 个文件未渲染。请使用搜索、暂存全部，或在终端查看完整列表。</div>`
      : rows
  }

  private renderGitCommitHistory(git: WorkspaceGitStatus, options: { compact?: boolean } = {}) {
    const commits = git.recent_commits || []
    return `
      <section class="git-history-view ${options.compact ? 'compact' : ''}">
        <header><strong>提交历史</strong><span>${commits.length ? `${commits.length} 条最近提交` : '暂无提交'}</span></header>
        <div class="git-history-list">
          ${commits.length ? commits.map(commit => `
            <button data-git-commit-hash="${escapeHtml(commit.hash)}">
              <span class="git-history-dot"></span>
              <div>
                <strong>${escapeHtml(commit.subject || '(无提交说明)')}</strong>
                <small><b>${escapeHtml(commit.short_hash)}</b> · ${escapeHtml(commit.author || '-')} · ${escapeHtml(commit.relative_time || commit.timestamp || '')}</small>
              </div>
            </button>
          `).join('') : '<div class="empty-hint compact">提交后会在这里保留历史记录。</div>'}
        </div>
      </section>
    `
  }

  private gitFileKindLabel(kind: string) {
    if (kind === 'staged') return '已暂存'
    if (kind === 'unstaged') return '未暂存'
    if (kind === 'staged+unstaged') return '暂存+未暂存'
    if (kind === 'untracked') return '未跟踪'
    return kind || '变更'
  }

  private normalizeWorkspacePath(path: string) {
    return String(path || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  }

  private resolveWorkspaceMessagePath(rawPath: string) {
    const normalized = this.normalizeWorkspacePath(rawPath)
    if (!normalized) return ''
    const root = this.normalizeWorkspacePath(this.currentRoot())
    if (!root) return normalized
    const lowerPath = normalized.toLowerCase()
    const lowerRoot = root.toLowerCase()
    if (lowerPath === lowerRoot) return ''
    if (lowerPath.startsWith(`${lowerRoot}/`)) return normalized.slice(root.length + 1)
    if (normalized.startsWith('/workspace/')) return normalized.slice('/workspace/'.length)
    return normalized
  }

  private workspacePathExists(path: string) {
    const normalized = this.resolveWorkspaceMessagePath(path)
    if (!normalized) return false
    const known = Boolean(
      this.findWorkspaceEntryCapped(normalized)
      || (this.state.workspace.git?.files || []).some(item => this.normalizeWorkspacePath(item.path) === normalized)
      || (this.workspaceFileIndexCache?.root === this.currentRoot() && this.workspaceFileIndexCache.value.files.some(item => this.normalizeWorkspacePath(item.path) === normalized))
      || this.checkpointsForPath(normalized).length
      || this.state.workspace.tabs.some(tab => this.normalizeWorkspacePath(tab.path) === normalized),
    )
    if (known) return true
    if (!this.currentRoot()) return false
    if (/^[A-Za-z]:[\\/]/.test(path)) return this.normalizeWorkspacePath(path).toLowerCase().startsWith(`${this.normalizeWorkspacePath(this.currentRoot()).toLowerCase()}/`)
    if (/^(?:node_modules|dist|build|target|\.git)\//.test(normalized)) return false
    return /^[A-Za-z0-9_.@()[\]\- \u4e00-\u9fa5]+(?:\/[A-Za-z0-9_.@()[\]\- \u4e00-\u9fa5]+)+\.[A-Za-z0-9]{1,12}$/.test(normalized)
  }

  private findWorkspaceEntryCapped(path: string, maxEntries = 800) {
    const target = this.normalizeWorkspacePath(path)
    if (!target) return null
    const stack = [...this.state.workspace.tree]
    let visited = 0
    while (stack.length && visited < maxEntries) {
      const item = stack.shift()
      if (!item) continue
      visited += 1
      if (this.normalizeWorkspacePath(item.path) === target) return item
      if (item.children?.length) stack.push(...item.children)
    }
    return null
  }

  private checkpointsForPath(path: string) {
    const normalized = this.normalizeWorkspacePath(path)
    return (this.state.agentRuntime.checkpoints as any[])
      .filter(item => Array.isArray(item?.files) && item.files.some((file: any) => this.normalizeWorkspacePath(String(file?.path || '')) === normalized))
      .reverse()
  }

  private extractFileDiff(path: string, git = this.state.workspace.git) {
    const normalized = this.resolveWorkspaceMessagePath(path)
    if (!git?.diff || !normalized) return ''
    const blocks: string[] = []
    let section = ''
    let current = ''
    const flush = () => {
      if (current && (current.includes(` b/${normalized}`) || current.includes(` a/${normalized}`) || current.includes(`/${normalized}\n`))) {
        blocks.push(`${section}${current}`.trim())
      }
      current = ''
    }
    for (const line of git.diff.split('\n')) {
      if (line === '[staged]' || line === '[unstaged]' || line === '[untracked]') {
        flush()
        section = `${line}\n`
        continue
      }
      if (line.startsWith('diff --git ')) flush()
      current += `${line}\n`
    }
    flush()
    if (blocks.length) return blocks.join('\n\n')
    const file = (git.files || []).find(item => this.normalizeWorkspacePath(item.path) === normalized)
    if (file?.kind === 'untracked') return `[untracked]\n${normalized}`
    return ''
  }

  private diffLineCounts(diff: string) {
    let plus = 0
    let minus = 0
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) plus += 1
      if (line.startsWith('-')) minus += 1
    }
    return { plus, minus }
  }

  private diffChangedLines(diff: string) {
    const addedLines: number[] = []
    const removedNearLines: number[] = []
    let oldLine = 0
    let newLine = 0
    for (const line of diff.split('\n')) {
      const hunk = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
      if (hunk) {
        oldLine = Number(hunk[1])
        newLine = Number(hunk[2])
        continue
      }
      if (!newLine && !oldLine) continue
      if (line.startsWith('+++') || line.startsWith('---')) continue
      if (line.startsWith('+')) {
        addedLines.push(newLine)
        newLine += 1
      } else if (line.startsWith('-')) {
        removedNearLines.push(Math.max(1, newLine))
        oldLine += 1
      } else {
        oldLine += 1
        newLine += 1
      }
    }
    return {
      addedLines: [...new Set(addedLines)],
      removedNearLines: [...new Set(removedNearLines)],
    }
  }

  private updateEditorDiffHighlights() {
    const tab = this.activeTab()
    if (!tab) {
      this.editor.setDiffHighlights([], [])
      return
    }
    const diff = this.extractFileDiff(tab.path)
    if (!diff.trim() || diff.startsWith('[untracked]')) {
      this.editor.setDiffHighlights([], [])
      return
    }
    const changed = this.diffChangedLines(diff)
    this.editor.setDiffHighlights(changed.addedLines, changed.removedNearLines)
  }

  private fileChangeMeta(path: string) {
    const normalized = this.resolveWorkspaceMessagePath(path)
    if (!normalized) {
      return {
        gitFile: null,
        diff: '',
        checkpoints: [],
        counts: { plus: 0, minus: 0 },
        badge: '',
        title: '点击打开文件',
      }
    }
    const gitFile = (this.state.workspace.git?.files || []).find(item => this.normalizeWorkspacePath(item.path) === normalized)
    const diff = this.extractFileDiff(normalized)
    const counts = this.diffLineCounts(diff)
    const checkpoints = this.checkpointsForPath(normalized)
    const parts: string[] = []
    if (gitFile) parts.push(this.gitFileKindLabel(gitFile.kind))
    if (counts.plus || counts.minus) parts.push(`+${counts.plus} / -${counts.minus}`)
    if (checkpoints.length) parts.push(`${checkpoints.length} 个修改历史`)
    return {
      gitFile,
      diff,
      checkpoints,
      counts,
      badge: counts.plus || counts.minus
        ? `+${counts.plus} / -${counts.minus}`
        : gitFile
          ? this.gitFileKindLabel(gitFile.kind)
          : checkpoints.length
            ? `${checkpoints.length} 次`
            : '',
      title: parts.length ? parts.join(' · ') : '点击打开文件',
    }
  }

  private checkpointFileForPath(checkpoint: any, path: string) {
    const normalized = this.normalizeWorkspacePath(path)
    return Array.isArray(checkpoint?.files)
      ? checkpoint.files.find((file: any) => this.normalizeWorkspacePath(String(file?.path || '')) === normalized)
      : null
  }

  private lineDiffPreview(before: string, after: string, maxLines = 90) {
    const oldLines = before.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    const newLines = after.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
    if (oldLines.at(-1) === '') oldLines.pop()
    if (newLines.at(-1) === '') newLines.pop()
    const rows: Array<{ type: 'same' | 'add' | 'remove'; oldLine: number | null; newLine: number | null; text: string }> = []
    let plus = 0
    let minus = 0
    let oldNumber = 1
    let newNumber = 1
    let started = false
    const max = Math.max(oldLines.length, newLines.length)
    for (let index = 0; index < max; index += 1) {
      const oldLine = oldLines[index]
      const newLine = newLines[index]
      if (oldLine === newLine) {
        if (started && rows.length < maxLines) rows.push({ type: 'same', oldLine: oldNumber, newLine: newNumber, text: oldLine ?? '' })
        oldNumber += 1
        newNumber += 1
        continue
      }
      if (oldLine !== undefined) {
        minus += 1
        started = true
        if (rows.length < maxLines) rows.push({ type: 'remove', oldLine: oldNumber, newLine: null, text: oldLine })
        oldNumber += 1
      }
      if (newLine !== undefined) {
        plus += 1
        started = true
        if (rows.length < maxLines) rows.push({ type: 'add', oldLine: null, newLine: newNumber, text: newLine })
        newNumber += 1
      }
    }
    const trimmed = rows.length >= maxLines
    return {
      plus,
      minus,
      rows,
      trimmed,
      text: rows.length ? rows.map(row => `${row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' '}${row.text}`).join('\n') : '内容没有变化。',
    }
  }

  private renderCheckpointCodeLine(text: string, filePath: string) {
    const source = text || ' '
    const trimmed = source.trim()
    if (/^(\/\/|#|--|\/\*|\*)/.test(trimmed)) {
      return `<span class="checkpoint-token comment">${escapeHtml(source)}</span>`
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    const keywordGroups: Record<string, string[]> = {
      ts: ['async', 'await', 'break', 'catch', 'class', 'const', 'constructor', 'continue', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'interface', 'let', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'super', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var'],
      tsx: ['async', 'await', 'break', 'catch', 'class', 'const', 'constructor', 'continue', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'interface', 'let', 'new', 'null', 'private', 'protected', 'public', 'return', 'static', 'super', 'this', 'throw', 'true', 'try', 'type', 'undefined', 'var'],
      js: ['async', 'await', 'break', 'catch', 'class', 'const', 'constructor', 'continue', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'let', 'new', 'null', 'return', 'static', 'super', 'this', 'throw', 'true', 'try', 'undefined', 'var'],
      jsx: ['async', 'await', 'break', 'catch', 'class', 'const', 'constructor', 'continue', 'else', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'if', 'import', 'let', 'new', 'null', 'return', 'static', 'super', 'this', 'throw', 'true', 'try', 'undefined', 'var'],
      py: ['and', 'as', 'async', 'await', 'class', 'def', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'if', 'import', 'in', 'is', 'None', 'not', 'or', 'pass', 'raise', 'return', 'self', 'True', 'try', 'with', 'yield'],
      rs: ['async', 'await', 'break', 'const', 'continue', 'crate', 'else', 'enum', 'false', 'fn', 'for', 'if', 'impl', 'let', 'match', 'mod', 'mut', 'pub', 'return', 'self', 'struct', 'true', 'use', 'where'],
      css: ['align-items', 'background', 'border', 'color', 'display', 'flex', 'font-size', 'gap', 'grid', 'height', 'justify-content', 'margin', 'overflow', 'padding', 'position', 'width'],
    }
    const keywords = keywordGroups[ext] || keywordGroups.ts
    const keywordPattern = keywords.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    const tokenPattern = new RegExp(`(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|\\\`(?:\\\\.|[^\\\`\\\\])*\\\`|\\b(?:${keywordPattern})\\b|\\b\\d+(?:\\.\\d+)?\\b)`, 'g')
    let output = ''
    let cursor = 0
    for (const match of source.matchAll(tokenPattern)) {
      const index = match.index ?? 0
      output += escapeHtml(source.slice(cursor, index))
      const token = match[0]
      const kind = /^["'`]/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword'
      output += `<span class="checkpoint-token ${kind}">${escapeHtml(token)}</span>`
      cursor = index + token.length
    }
    output += escapeHtml(source.slice(cursor))
    return output
  }

  private renderCheckpointDiffRows(diff: ReturnType<AutoCodeIde['lineDiffPreview']>, filePath = '') {
    if (!diff.rows.length) return '<div class="checkpoint-empty-diff">内容没有变化。</div>'
    const rows = diff.rows.map(row => `
      <div class="checkpoint-diff-row ${row.type}">
        <span class="checkpoint-diff-line old">${row.oldLine ?? ''}</span>
        <span class="checkpoint-diff-line new">${row.newLine ?? ''}</span>
        <code>${this.renderCheckpointCodeLine(row.text || ' ', filePath)}</code>
      </div>
    `).join('')
    return `
      <div class="checkpoint-diff-table">
        <div class="checkpoint-diff-head">
          <span>旧</span>
          <span>新</span>
          <span>内容</span>
        </div>
        ${rows}
        ${diff.trimmed ? '<div class="checkpoint-diff-more">diff 较长，已截断显示。</div>' : ''}
      </div>
    `
  }

  private renderCheckpointHistoryItem(checkpoint: any, tab: EditorTab) {
    const file = this.checkpointFileForPath(checkpoint, tab.path)
    const before = String(file?.content || '')
    const after = tab.draft
    const diff = this.lineDiffPreview(before, after)
    const label = String(checkpoint?.label || 'Checkpoint')
    const id = String(checkpoint?.id || '')
    return `
      <article class="checkpoint-history-item">
        <header>
          <div>
            <strong>${escapeHtml(label)}</strong>
            <span>${escapeHtml(formatTime(String(checkpoint?.createdAt || '')))}</span>
          </div>
          <em>+${diff.plus} / -${diff.minus}</em>
        </header>
        ${this.renderCheckpointDiffRows(diff, tab.path)}
        <button class="secondary-button" data-checkpoint-revert="${escapeHtml(id)}">回退到此历史</button>
      </article>
    `
  }

  private renderEditorGitStrip() {
    const strip = this.$('#editor-git-strip')
    const tab = this.activeTab()
    if (!strip || !tab) return
    const { gitFile, diff: fileDiff, checkpoints, badge, title } = this.fileChangeMeta(tab.path)
    if (!gitFile && !checkpoints.length) {
      strip.setAttribute('hidden', '')
      strip.innerHTML = ''
      return
    }
    strip.removeAttribute('hidden')
    strip.innerHTML = `
      <div class="editor-git-strip-top">
        <div class="editor-git-main">
          <span class="git-change-pill">${gitFile ? `${escapeHtml(this.gitFileKindLabel(gitFile.kind))} · ${escapeHtml(gitFile.index_status || ' ')}${escapeHtml(gitFile.worktree_status || ' ')}` : '无 Git 变更'}</span>
          ${badge ? `<span class="git-change-count" title="${escapeHtml(title)}">${escapeHtml(badge)}</span>` : ''}
          <span>${escapeHtml(tab.path)}</span>
        </div>
        <div class="editor-git-actions">
          ${fileDiff ? '<button class="secondary-button" id="show-active-file-diff">查看当前文件 diff</button>' : ''}
          ${checkpoints.length ? `
            <details class="editor-checkpoint-menu">
              <summary>${checkpoints.length} 个修改历史</summary>
              <div>
                ${checkpoints.slice(0, 8).map((item: any) => this.renderCheckpointHistoryItem(item, tab)).join('')}
              </div>
            </details>
          ` : ''}
        </div>
      </div>
    `
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
    const baseDiagnostics = [
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
        ok: runtime.tools.length > 0,
        title: 'Agent 工具',
        detail: runtime.tools.length
          ? `${runtime.tools.length} 个内置工具${runtime.mcpTools.length ? ` · ${runtime.mcpTools.length} 个 MCP 配置` : ''}`
          : '工具注册表未加载',
      },
      {
        ok: patchCount === 0 || pending > 0,
        title: 'Patch',
        detail: patchCount ? `${patchCount} 个预览，可在 Git 面板查看` : '暂无文件修改预览',
      },
    ]
    const smokeTitleMap: Record<string, string> = {
      workspace: '后端自检 · Workspace',
      'agent-session': '后端自检 · Agent Session',
      'tool-registry': '后端自检 · Tool Registry',
      processes: '后端自检 · Processes',
      memory: '后端自检 · Memory',
      git: '后端自检 · Git',
      'browser-preview': '后端自检 · Preview',
    }
    const smokeDiagnostics = Array.isArray(runtime.smokeChecks)
      ? runtime.smokeChecks.map((item: any) => {
        const id = String(item?.id || item?.key || item?.title || '')
        return {
          ok: Boolean(item?.ok),
          title: smokeTitleMap[id] || `后端自检 · ${String(item?.title || id || '检查项')}`,
          detail: String(item?.detail || item?.message || ''),
        }
      })
      : []
    return [...baseDiagnostics, ...smokeDiagnostics]
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
    const problems = this.collectProblemItems().slice(0, 60)
    list.innerHTML = `
      <section class="self-check-panel">
        <header>
          <strong>IDE 自检</strong>
          <div class="self-check-actions">
            <span>${diagnostics.filter(item => item.ok).length}/${diagnostics.length}</span>
            <button class="mini-button" id="run-smoke-check">Smoke Check</button>
          </div>
        </header>
        ${diagnostics.map(item => `
          <div class="self-check-item ${item.ok ? 'ok' : 'warn'}">
            <span></span>
            <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.detail)}</small></div>
          </div>
        `).join('')}
      </section>
      ${this.state.agentRuntime.patchPreviews.length ? `<button class="problem-action" id="view-agent-diff">查看最新 Agent Diff</button>` : ''}
      ${problems.length
        ? `
          <section class="problem-section">
            <header><strong>问题</strong><span>${problems.length} 项</span></header>
            ${problems.map(item => `
              <button class="problem-item ${escapeHtml(item.severity)}" ${item.path ? `data-problem-path="${escapeHtml(item.path)}"` : ''} data-problem-line="${escapeHtml(String(item.line || 1))}" data-problem-character="${escapeHtml(String(item.character || 0))}">
                <span>${escapeHtml(item.severity)}</span>
                <div>
                  <strong>${escapeHtml(item.path ? `${item.path}${item.line ? `:${item.line}` : ''}` : item.source)}</strong>
                  <small>${escapeHtml(item.message)}</small>
                </div>
              </button>
            `).join('')}
          </section>
        `
        : '<div class="empty-hint">暂无构建问题。Agent 运行、终端、Provider 和会话状态会显示在上方自检中。</div>'}
    `
  }

  private collectProblemItems(): AgentProblemItem[] {
    const items: AgentProblemItem[] = []
    const seen = new Set<string>()
    const add = (item: Omit<AgentProblemItem, 'id'> & { id?: string }) => {
      const message = String(item.message || '').trim()
      if (!message) return
      const key = [item.source, item.severity, item.path || '', item.line || 0, message].join('|')
      if (seen.has(key)) return
      seen.add(key)
      items.push({ ...item, id: item.id || `problem-${items.length}` })
    }

    this.state.problems.forEach((message, index) => add({
      source: 'IDE',
      severity: /error|failed|失败|错误/i.test(message) ? 'error' : 'warning',
      message,
      id: `state-${index}`,
    }))

    for (const event of this.state.agentRuntime.diagnostics) {
      const payload = (event as any)?.payload || {}
      if ((event as any)?.type === 'lsp_diagnostics') {
        this.addStructuredDiagnostics(add, payload, 'LSP')
      }
      if (String((event as any)?.type || '').startsWith('process_')) {
        const data = String(payload.data || payload.lastOutput || '')
        this.parseProblemOutput(data, String(payload.command || 'Agent process')).forEach(add)
      }
    }

    for (const call of this.state.agentRuntime.timeline) {
      const output = call.output as any
      if (call.name === 'diagnostics' || call.name === 'test_runner' || call.name === 'bash') {
        if (call.status === 'error' && call.error) {
          add({ source: this.toolNameLabel(call.name), severity: 'error', message: call.error })
        }
        const text = String(output?.output || output?.stdout || output?.stderr || output?.message || '')
        this.parseProblemOutput(text, String(output?.command || (call.input as any)?.command || this.toolNameLabel(call.name))).forEach(add)
      }
      if (call.name === 'lsp') {
        this.addStructuredDiagnostics(add, output?.result || output || {}, 'LSP')
      }
    }

    return items.slice(-80).reverse()
  }

  private addStructuredDiagnostics(add: (item: Omit<AgentProblemItem, 'id'> & { id?: string }) => void, payload: any, source: string) {
    const diagnostics = Array.isArray(payload?.diagnostics)
      ? payload.diagnostics
      : Array.isArray(payload?.result?.diagnostics)
        ? payload.result.diagnostics
        : []
    diagnostics.forEach((item: any, index: number) => {
      const severityRaw = String(item?.severity || item?.level || '').toLowerCase()
      add({
        id: `${source}-${index}-${String(item?.path || '')}-${String(item?.line || '')}`,
        source,
        severity: severityRaw.includes('error') || severityRaw === '1' ? 'error' : severityRaw.includes('warn') || severityRaw === '2' ? 'warning' : 'info',
        path: String(item?.path || item?.file || ''),
        line: Number(item?.line || item?.range?.start?.line + 1 || 1),
        character: Number(item?.character || item?.column || item?.range?.start?.character || 0),
        message: String(item?.message || item?.preview || item?.detail || ''),
      })
    })
    const commandOutput = payload?.commandResult?.output || payload?.result?.commandResult?.output
    if (commandOutput) {
      this.parseProblemOutput(String(commandOutput), source).forEach(add)
    }
  }

  private parseProblemOutput(output: string, source: string): AgentProblemItem[] {
    if (!output.trim()) return []
    const items: AgentProblemItem[] = []
    const lines = output.split(/\r?\n/).slice(-600)
    const patterns = [
      /^(?<path>[A-Za-z]:[\\/][^:(]+|[^:(\s][^:(]*?)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning|info)\b[:\s]*(?<message>.*)$/i,
      /^(?<path>[A-Za-z]:[\\/][^:]+|[^:\s][^:]*?):(?<line>\d+):(?:(?<column>\d+):)?\s*(?<severity>error|warning|info|fatal)?\b[:\s]*(?<message>.*)$/i,
      /^\s*-->\s*(?<path>[^:]+):(?<line>\d+):(?<column>\d+)\s*$/i,
    ]
    let pendingRustLocation: { path: string; line: number; character: number } | null = null
    for (const raw of lines) {
      const line = raw.trimEnd()
      if (!line.trim()) continue
      const rust = line.match(patterns[2])
      if (rust?.groups) {
        pendingRustLocation = {
          path: rust.groups.path.replace(/\\/g, '/').trim(),
          line: Number(rust.groups.line || 1),
          character: Number(rust.groups.column || 0),
        }
        continue
      }
      const rustMessage = line.match(/^(error|warning)(?:\[[^\]]+\])?:\s*(.+)$/i)
      if (rustMessage && pendingRustLocation) {
        items.push({
          id: `parsed-${items.length}`,
          source,
          severity: rustMessage[1].toLowerCase() === 'warning' ? 'warning' : 'error',
          message: rustMessage[2],
          ...pendingRustLocation,
        })
        continue
      }
      for (const pattern of patterns.slice(0, 2)) {
        const match = line.match(pattern)
        if (!match?.groups) continue
        const severity = String(match.groups.severity || '').toLowerCase()
        items.push({
          id: `parsed-${items.length}`,
          source,
          severity: severity.includes('warn') ? 'warning' : severity.includes('info') ? 'info' : 'error',
          path: match.groups.path.replace(/\\/g, '/').trim(),
          line: Number(match.groups.line || 1),
          character: Number(match.groups.column || 0),
          message: String(match.groups.message || line).trim(),
        })
        break
      }
    }
    return items
  }

  private async openProblem(path: string, line = 1, character = 0) {
    if (!path) return
    await this.openFile(path.replace(/\\/g, '/'))
    this.editor.revealLine(line || 1, character || 0)
    this.switchDock('problems')
  }

  private renderProviderStatus() {
    this.ensureProviderChannels()
    const models = this.aggregateProviderModels()
    this.state.providerCatalog.models = models
    const select = this.$<HTMLSelectElement>('#workbench-model')
    if (select) {
      const current = this.state.settings.model || ''
      const options = models
      select.innerHTML = options.length
        ? options.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`).join('')
        : '<option value="">请先在渠道管理中刷新并启用模型</option>'
      if (current && options.includes(current)) select.value = current
      else if (options[0] && document.activeElement !== select) {
        select.value = options[0]
        this.state.settings.model = options[0]
      }
    }
    const enabledChannels = this.state.settings.channels.filter(channel => channel.enabled)
    const supporting = this.state.settings.model
      ? enabledChannels.filter(channel => this.channelSupportsSelectedModel(channel))
      : enabledChannels
    const account = this.$('#account-pill')
    if (account) {
      const accountSummary = this.state.providerCatalog.account || enabledChannels.map(channel => this.displayAccountStatus(channel.account_status)).filter(Boolean).join('；')
      account.textContent = this.state.providerCatalog.accountLoading ? '账户查询中...' : accountSummary || `${supporting.length} 个可用渠道`
      account.title = account.textContent || ''
    }
    const status = this.$('#provider-status')
    if (status) status.innerHTML = `<strong>多渠道自动路由</strong><span>${enabledChannels.length} 个启用渠道 · ${models.length} 个去重模型 · 当前模型可由 ${supporting.length} 个渠道承载</span>`
  }

  private formatTimelineDuration(durationMs: number) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000))
    if (seconds <= 0) return '<1s'
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const minuteRest = minutes % 60
    return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`
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
    const phases = this.renderAgentPhaseProgress()
    card.innerHTML = `
      <div><strong>${escapeHtml(item.title || '请求详情')}</strong><span>${item.state === 'busy' ? this.formatTimelineDuration(item.durationMs || 0) : item.state}</span></div>
      ${phases}
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

  private renderAgentPhaseProgress() {
    const current = this.state.agentRuntime.phase
    const history = this.state.agentRuntime.phaseHistory || []
    if (!current && !history.length) return ''
    const order = ['received', 'planning', 'context', 'model_request', 'waiting_permission', 'tool', 'streaming', 'finalizing']
    const labels: Record<string, string> = {
      received: '接收',
      planning: '理解',
      context: '上下文',
      model_request: '请求模型',
      streaming: '接收回复',
      tool: '工具',
      waiting_permission: '等待确认',
      finalizing: '整理',
    }
    const currentIndex = Math.max(0, order.indexOf(String(current?.phase || 'received')))
    const percent = Math.min(100, Math.max(8, ((currentIndex + 1) / order.length) * 100))
    const started = Date.parse(String(current?.startedAt || current?.at || '')) || Date.now()
    const elapsed = Math.max(0, Date.now() - started)
    return `
      <section class="agent-phase-progress">
        <div class="agent-phase-bar"><span style="width:${percent}%"></span></div>
        <div class="agent-phase-current">
          <strong>${escapeHtml(this.repairMojibakeText(current?.label || labels[order[currentIndex]] || 'Agent 执行中'))}</strong>
          <span>${this.formatTimelineDuration(elapsed)} · ${escapeHtml(this.repairMojibakeText(current?.detail || ''))}</span>
        </div>
        <ol>
          ${order.map((phase, index) => {
            const seen = history.some(item => item.phase === phase) || index <= currentIndex
            const active = current?.phase === phase
            return `<li class="${seen ? 'done' : ''} ${active ? 'active' : ''}">${escapeHtml(labels[phase] || phase)}</li>`
          }).join('')}
        </ol>
      </section>
    `
  }
  private renderAssistant() {
    const thread = this.$('#assistant-thread')
    const runtimePanel = this.$('#agent-runtime-panel')
    const status = this.$('#task-status')
    const task = this.state.ai.current
    const modeLabel = this.state.settings.connection_mode === 'autocodePlatform' ? 'AutoCode 平台' : '本地渠道'
    if (status) {
      const server = this.state.localServer.ok && this.state.localServer.baseUrl
        ? ` · Server ${this.state.localServer.baseUrl}`
        : ''
      const route = this.activeProviderLabel('agent')
      const statusHtml = task
        ? `<strong>${escapeHtml(task.title || task.id || 'AutoCode 任务')}</strong><span>状态：${escapeHtml(task.status || '-')}${escapeHtml(server)}</span>`
        : `<strong>${escapeHtml(modeLabel)}</strong><span>${escapeHtml(route.text)}${escapeHtml(server)}</span>`
      if (this.assistantStatusHtml !== statusHtml || status.innerHTML !== statusHtml) {
        status.innerHTML = statusHtml
        this.assistantStatusHtml = statusHtml
      }
    }
    if (runtimePanel) {
      const runtimeHtml = `${this.renderAgentSessions()}${this.renderLocalServerPanel()}${this.renderAgentToolRegistry()}${this.renderSubagentPanel()}${this.renderContextChips()}${this.renderAgentRuntime()}`
      if (this.assistantRuntimeHtml !== runtimeHtml || runtimePanel.innerHTML !== runtimeHtml) {
        runtimePanel.innerHTML = runtimeHtml
        this.assistantRuntimeHtml = runtimeHtml
      }
    }
    const consoleSummary = this.$('#agent-console-summary')
    if (consoleSummary) consoleSummary.textContent = this.agentConsoleSummary()
    if (!thread) return
    this.ensureRuntimeActionCardsInThread()
    const previousScrollTop = thread.scrollTop
    const previousScrollHeight = thread.scrollHeight
    const stickToBottom = previousScrollHeight <= thread.clientHeight
      || previousScrollHeight - previousScrollTop - thread.clientHeight < 120
    let messages = ''
    try {
      this.activeRenderFileReferenceIndex = this.buildWorkspaceFileReferenceIndex()
      messages = this.state.chat.filter(item =>
        item.role !== 'assistant'
        || item.text.trim()
        || item.toolCalls?.length
        || item.pendingPermissions?.length
        || item.patchPreviews?.length
        || item.reasoning
        || item.compactedSummary
      ).map(item => this.renderAssistantMessageSafe(item)).join('')
    } catch (error) {
      console.error('[AutoCode] assistant thread render failed', error)
      messages = `
        <article class="assistant-message error">
          <div class="message-title"><div><strong>聊天渲染失败</strong><span>${escapeHtml(formatTime(new Date().toISOString()))}</span></div></div>
          <div class="message-body"><div class="chat-markdown">已进入安全渲染模式：${escapeHtml(String(error))}</div></div>
        </article>
      `
      this.toast(`聊天渲染失败，已启用安全模式：${String(error)}`, 'error')
    } finally {
      this.activeRenderFileReferenceIndex = null
    }
    const messagesChanged = this.assistantThreadHtml !== messages || (!thread.childElementCount && Boolean(messages))
    if (messagesChanged) {
      thread.innerHTML = messages
      this.assistantThreadHtml = messages
      if (messages.includes('data-mermaid-source')) void this.renderPendingMermaidDiagrams(thread)
      if (stickToBottom || this.activeAssistantMessageId) thread.scrollTop = thread.scrollHeight
      else thread.scrollTop = Math.max(0, previousScrollTop + (thread.scrollHeight - previousScrollHeight))
    }
    if (['completed', 'failed', 'cancelled', 'idle'].includes(String(this.state.agentRuntime.status || ''))) {
      window.setTimeout(() => this.unlockInteractiveSurface(`assistant_render:${this.state.agentRuntime.status}`), 0)
    }
  }

  private renderAssistantMessageSafe(item: AppState['chat'][number]) {
    try {
      return `
        <article class="assistant-message ${item.role} ${item.queued ? `queued ${escapeHtml(item.queued.status)}` : ''}">
          <div class="message-title">
            <div><strong>${this.messageRoleLabel(item.role)}</strong><span>${escapeHtml(formatTime(item.at))}</span></div>
            <div class="message-actions">
              <button class="message-action" data-copy-message="${escapeHtml(item.id)}" title="复制消息">复制</button>
              ${item.queued && item.queued.status === 'queued' ? `<button class="message-action" data-queued-promote="${escapeHtml(item.queued.id)}" title="设为当前任务结束后的下一条">设为下一条</button>` : ''}
              ${item.queued && item.queued.status === 'queued' && !item.text.startsWith('【插入本轮】') ? `<button class="message-action" data-queued-insert="${escapeHtml(item.queued.id)}" title="作为当前任务的补充，当前任务结束后优先消费">插入本轮</button>` : ''}
              ${item.queued && ['queued', 'failed'].includes(item.queued.status) ? `<button class="message-action" data-queued-cancel="${escapeHtml(item.queued.id)}" title="取消排队">取消排队</button>` : ''}
              ${item.role === 'user' ? `<button class="message-action" data-edit-message="${escapeHtml(item.id)}" title="编辑后重新发送">编辑</button><button class="message-action" data-resend-message="${escapeHtml(item.id)}" title="重新发送">重发</button>` : ''}
            </div>
          </div>
          <div class="message-body">${this.renderChatMessageContent(item)}</div>
        </article>
      `
    } catch (error) {
      console.error('[AutoCode] chat message render failed', item?.id, error)
      return `
        <article class="assistant-message ${escapeHtml(item.role || 'system')} render-failed">
          <div class="message-title">
            <div><strong>${this.messageRoleLabel(item.role)}</strong><span>${escapeHtml(formatTime(item.at))}</span></div>
            <div class="message-actions"><button class="message-action" data-copy-message="${escapeHtml(item.id)}" title="复制原文">复制</button></div>
          </div>
          <div class="message-body">
            <div class="chat-markdown">这条历史消息渲染失败，已显示为安全纯文本。</div>
            <pre>${escapeHtml(String(item.text || '').slice(0, 12000))}</pre>
          </div>
        </article>
      `
    }
  }

  private ensureRuntimeActionCardsInThread() {
    const runtime = this.state.agentRuntime
    if (!runtime.pendingPermissions.length && !runtime.patchPreviews.length) return
    const pendingIds = new Set(runtime.pendingPermissions.map(item => item.id))
    const patchIds = new Set(runtime.patchPreviews.map(item => item.id))
    const alreadyShown = this.state.chat.some(message =>
      message.role === 'assistant'
      && (
        message.pendingPermissions?.some(item => pendingIds.has(item.id))
        || message.patchPreviews?.some(item => patchIds.has(item.id))
      ),
    )
    if (alreadyShown) return
    let message = [...this.state.chat].reverse().find(item => item.role === 'assistant')
    if (!message) {
      message = {
        id: `msg-${Date.now()}-assistant-actions`,
        role: 'assistant',
        text: '',
        at: new Date().toISOString(),
      }
      this.state.chat.push(message)
    }
    message.pendingPermissions = runtime.pendingPermissions.slice(-4)
    message.patchPreviews = runtime.patchPreviews.slice(-3)
    message.toolCalls = this.normalizeToolTraceForRender(runtime.timeline).slice(-18)
    message.reasoning = message.reasoning || runtime.thinking || ''
    message.compactedSummary = message.compactedSummary || runtime.compactedSummary
  }
  private messageRoleLabel(role: string) {
    if (role === 'user') return '你'
    if (role === 'assistant') return 'AI'
    if (role === 'error') return '错误'
    return '系统'
  }

  private agentConsoleSummary() {
    const runtime = this.state.agentRuntime
    const session = runtime.sessionId ? runtime.sessionId.replace(/^agent-/, '#') : '未创建会话'
    const tools = Array.isArray(runtime.tools) ? runtime.tools.length : 0
    const mcp = Array.isArray(runtime.mcpTools) ? runtime.mcpTools.length : 0
    const refs = this.state.contextChips.length
    const server = this.state.localServer.ok ? '服务正常' : '服务未就绪'
    return `${session} · ${tools} 工具 / ${mcp} MCP · ${refs} 上下文 · ${server}`
  }

  private renderContextChips() {
    if (!this.state.contextChips.length) {
      return `
        <details class="assistant-context">
          <summary>
            <div class="panel-heading compact">
              <span class="feature-icon">文</span>
              <div>
                <strong>快捷上下文</strong>
                <span>把当前文件、选区、终端输出或 Git 差异附加给下一轮对话</span>
              </div>
            </div>
          </summary>
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
        <summary>
          <div class="panel-heading compact">
            <span class="feature-icon">文</span>
            <div>
              <strong>已引用上下文</strong>
              <span>${this.state.contextChips.length} 项会随下一条消息一起发送</span>
            </div>
          </div>
        </summary>
        <div>${this.state.contextChips.map(chip => `<button title="${escapeHtml(chip.value)}">${escapeHtml(chip.label)}</button>`).join('')}</div>
      </details>
    `
  }

  private renderToolTrace(calls: ToolCallRecord[]) {
    if (!calls.length) return ''
    const normalizedCalls = this.normalizeToolTraceForRender(calls)
    const collapsedCount = Math.max(0, normalizedCalls.length - 18)
    const visible = normalizedCalls.slice(-18)
    return `
      <div class="agent-tool-list">
        ${collapsedCount ? `<div class="tool-history-note">已折叠较早 ${collapsedCount} 个工具调用</div>` : ''}
        ${visible.map((call, index) => {
          const toolId = String(call.id || `${call.name}-${index}`)
          const candidateDetail = index >= visible.length - 6 || call.status === 'running' || call.status === 'approval_required'
          const defaultOpen = candidateDetail && (call.status === 'running' || call.status === 'error')
          const open = this.collapsedToolIds.has(toolId) ? false : this.openedToolIds.has(toolId) ? true : defaultOpen
          const renderDetail = open && candidateDetail
          return `
          <details class="agent-tool-card ${escapeHtml(call.status)} ${index === visible.length - 1 ? 'latest' : ''}" data-tool-id="${escapeHtml(toolId)}" ${open ? 'open' : ''}>
            <summary>
              <span class="tool-status-dot"></span>
              <strong>${escapeHtml(this.toolNameLabel(call.name))}</strong>
              <small>${escapeHtml(this.toolSummary(call))}</small>
              <em>${escapeHtml(this.toolStatusLabel(call.status))}</em>
            </summary>
            ${renderDetail ? this.renderToolDetail(call) : '<small class="tool-history-note">详情已折叠，保留摘要以降低运行中渲染压力。</small>'}
          </details>
        `}).join('')}
      </div>
    `
  }

  private normalizeToolTraceForRender(calls: ToolCallRecord[]) {
    const completed = new Set<string>()
    const seenCompleted = new Set<string>()
    const nonCachedGlobKeys = new Set(
      calls
        .filter(call => (call.name === 'glob' || call.name === 'list_files') && !(call.output as any)?.cached)
        .map(call => `${call.name}::${this.stableToolInput(call.input)}`),
    )
    const out: ToolCallRecord[] = []
    for (const call of [...calls].reverse()) {
      if (call.internal || this.isBootstrapTodoCall(call)) continue
      if (this.isMalformedPatchFailure(call)) continue
      const key = `${call.name}::${this.stableToolInput(call.input)}`
      const cachedGlob = (call.name === 'glob' || call.name === 'list_files') && Boolean((call.output as any)?.cached)
      if (cachedGlob && nonCachedGlobKeys.has(key)) continue
      if (call.status !== 'running' && seenCompleted.has(key)) continue
      if (call.status !== 'running') completed.add(key)
      if (call.status === 'running' && completed.has(key)) continue
      if (out.some(item => item.id === call.id)) continue
      out.push(call)
      if (call.status !== 'running') seenCompleted.add(key)
    }
    return out.reverse()
  }

  private isBootstrapTodoCall(call: ToolCallRecord) {
    if (call.name !== 'todowrite') return false
    const output = call.output as any
    const input = call.input as any
    const summary = String(output?.summary || '').toLowerCase()
    const items = Array.isArray(input?.items) ? input.items : []
    return summary.includes('agent todo') || (items.length === 4 && summary.includes('todo'))
  }

  private isMalformedPatchFailure(call: ToolCallRecord) {
    if (call.name !== 'apply_patch' || call.status !== 'error') return false
    const text = [
      call.error,
      typeof call.output === 'string' ? call.output : this.safeJsonPreview(call.output || {}, 3000),
      typeof call.input === 'string' ? call.input : this.safeJsonPreview(call.input || {}, 3000),
    ].join('\n').toLowerCase()
    return text.includes('corrupt patch')
      || text.includes('malformed')
      || text.includes('not a valid unified diff')
      || text.includes('patch cannot be empty')
      || text.includes('patch 格式损坏')
      || text.includes('缺少文件头')
      || text.includes('缺少')
  }

  private renderAgentSessions() {
    const runtime = this.state.agentRuntime
    const sessions = (runtime.sessions || []) as any[]
    const current = runtime.sessionId
    const visible = sessions
    const running = runtime.status === 'running' || runtime.status === 'waiting_permission' || runtime.status === 'compacting'
    const hasCheckpoint = runtime.checkpoints.length > 0
    return `
      <section class="agent-session-strip">
        <header>
          <div class="panel-heading">
            <span class="feature-icon">会</span>
            <div>
              <strong>智能体会话</strong>
              <span>${current ? `当前会话：${escapeHtml(current)}` : '保存每轮对话、工具调用和审批记录'}</span>
            </div>
          </div>
          <div class="agent-session-actions">
            <select class="agent-profile-select" id="agent-profile-select" title="选择智能体工作模式">
              ${this.agentProfileOptions().map(profile => `<option value="${escapeHtml(profile.id)}" ${profile.id === String(runtime.profileId || 'build') ? 'selected' : ''}>${escapeHtml(profile.label)}</option>`).join('')}
            </select>
            <button class="secondary-button" id="refresh-agent-sessions">刷新</button>
            <button class="secondary-button" id="new-agent-session">新建</button>
            ${current ? '<button class="secondary-button" id="fork-agent-session">分叉</button>' : ''}
            ${hasCheckpoint ? '<button class="secondary-button" id="revert-latest-checkpoint">撤销最近修改</button>' : ''}
            ${current && (running || runtime.status === 'cancelling')
              ? `<button class="secondary-button danger" id="cancel-agent-session">${runtime.status === 'cancelling' ? '强制停止' : '请求停止'}</button>`
              : ''}
          </div>
        </header>
        ${visible.length ? `
          <div class="agent-session-list">
            ${visible.map((item: any) => {
              const id = String(item?.id || '')
              const status = String(item?.status || 'idle')
              const active = id && id === current
              const toolCount = Array.isArray(item?.toolCalls) ? item.toolCalls.length : 0
              const messageCount = Array.isArray(item?.messages) ? item.messages.length : 0
              const title = this.agentSessionTitle(item)
              const profile = String(item?.profileId || 'build')
              return `
                <div class="agent-session-row ${active ? 'active' : ''} ${escapeHtml(status)}">
                  <button class="agent-session-item" data-agent-session="${escapeHtml(id)}" title="${escapeHtml(id)}">
                    <strong>${escapeHtml(title)}</strong>
                    <span>${escapeHtml(this.agentProfileLabel(profile))} · ${escapeHtml(this.agentStatusLabel(status))}</span>
                    <small>${escapeHtml(formatTime(String(item?.updatedAt || item?.createdAt || '')))} · ${messageCount} 消息 · ${toolCount} 工具</small>
                  </button>
                  <button class="agent-session-delete" data-delete-agent-session="${escapeHtml(id)}" title="删除此会话">×</button>
                </div>
              `
            }).join('')}
          </div>
        ` : '<div class="empty-hint">当前项目暂无历史 Agent 会话。</div>'}
      </section>
    `
  }

  private agentProfileOptions() {
    const registry = Array.isArray(this.state.agentRuntime.profiles)
      ? this.state.agentRuntime.profiles.map((item: any) => ({
          id: String(item?.id || '').toLowerCase(),
          label: this.agentProfileLabel(String(item?.id || item?.name || item?.label || '')),
        })).filter(item => item.id && item.label)
      : []
    const builtins = [
      { id: 'build', label: '构建模式' },
      { id: 'plan', label: '规划模式' },
      { id: 'explore', label: '探索模式' },
      { id: 'review', label: '审查模式' },
      { id: 'debug', label: '调试模式' },
      { id: 'test', label: '测试模式' },
      { id: 'refactor', label: '重构模式' },
      { id: 'docs', label: '文档模式' },
    ]
    const configured = Array.isArray(this.state.settings.agent_profiles)
      ? this.state.settings.agent_profiles.map((item: any) => ({
          id: String(item?.id || item?.name || '').toLowerCase(),
          label: this.agentProfileLabel(String(item?.id || item?.name || item?.label || '')),
        })).filter(item => item.id && item.label)
      : []
    const seen = new Set<string>()
    return [...registry, ...builtins, ...configured].filter(item => {
      const key = item.id.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  private agentProfileLabel(profileId: string) {
    const labels: Record<string, string> = {
      build: '构建模式',
      plan: '规划模式',
      explore: '探索模式',
      review: '审查模式',
      debug: '调试模式',
      test: '测试模式',
      refactor: '重构模式',
      docs: '文档模式',
      doc: '文档模式',
    }
    return labels[String(profileId || '').toLowerCase()] || profileId || '默认模式'
  }

  private agentSessionTitle(session: any) {
    const explicit = String(session?.title || session?.label || '').trim()
    if (explicit) return explicit.slice(0, 64)
    const messages = Array.isArray(session?.messages) ? session.messages : []
    const latestUser = [...messages].reverse().find((item: any) => String(item?.role || '') === 'user')
    const text = String(latestUser?.content || latestUser?.text || '').trim().replace(/\s+/g, ' ')
    if (text) return text.slice(0, 64)
    const root = String(session?.rootPath || this.currentRoot() || '')
    const profile = String(session?.profileId || 'build')
    return `${this.agentProfileLabel(profile)} · ${projectName(root)}`
  }

  private renderLocalServerPanel() {
    const server = this.state.localServer
    const capabilities = server.capabilities || []
    const state = server.ok ? 'ok' : 'warn'
    return `
      <details class="local-server-panel" ${server.error ? 'open' : ''}>
        <summary>
          <span class="status-dot ${state}"></span>
          <div class="panel-heading compact">
            <span class="feature-icon">服</span>
            <div>
              <strong>本地智能体服务</strong>
              <small>${server.ok ? escapeHtml(server.baseUrl || '运行中') : '桌面端内部运行时：事件流、工具执行、权限审核和会话恢复'}</small>
            </div>
          </div>
        </summary>
        <div class="local-server-body">
          <p class="panel-help">这是 AutoCode IDE 在本机启动的智能体运行时，不是外部模型服务。它让桌面界面、工具执行、审批记录和会话恢复使用同一套本地能力。</p>
          <div class="tool-kv"><span>URL</span><code>${escapeHtml(server.baseUrl || '-')}</code></div>
          <div class="tool-kv"><span>事件</span><code>${escapeHtml(String(server.latestEventId || 0))}</code></div>
          <div class="tool-kv"><span>版本</span><code>${escapeHtml(server.version || this.state.version || '-')}</code></div>
          ${server.error ? `<pre class="tool-output error">${escapeHtml(server.error)}</pre>` : ''}
          <div class="server-capabilities">
            ${capabilities.length
              ? capabilities.map(item => `<span>${escapeHtml(this.localServerCapabilityLabel(item))}</span>`).join('')
              : '<small>等待服务能力上报</small>'}
          </div>
          <div class="local-server-actions">
            <button class="secondary-button" id="refresh-local-server">刷新</button>
            <button class="secondary-button" id="copy-local-server-url" ${server.baseUrl ? '' : 'disabled'}>复制 URL</button>
          </div>
        </div>
      </details>
    `
  }

  private renderAgentToolRegistry() {
    const runtime = this.state.agentRuntime
    const tools = Array.isArray(runtime.tools) ? runtime.tools as any[] : []
    const mcpTools = Array.isArray(runtime.mcpTools) ? runtime.mcpTools as any[] : []
    const all = [...tools, ...mcpTools]
    const counts = {
      allow: all.filter(item => String(item?.permission || '') === 'allow').length,
      ask: all.filter(item => String(item?.permission || '') === 'ask').length,
      deny: all.filter(item => String(item?.permission || '') === 'deny').length,
    }
    return `
      <details class="agent-tool-registry">
        <summary>
          <div class="panel-heading compact">
            <span class="feature-icon">具</span>
            <div>
              <strong>工具注册表</strong>
              <span>${tools.length} 个内置工具 · ${mcpTools.length} 个 MCP 工具 · 自动 ${counts.allow} / 需确认 ${counts.ask} / 禁止 ${counts.deny}</span>
            </div>
          </div>
        </summary>
        <div class="agent-tool-registry-body">
          <div class="agent-runtime-actions">
            <button class="secondary-button" id="refresh-agent-tools">刷新工具</button>
          </div>
          <p class="panel-help">这里列出智能体可调用的能力。读取和搜索通常自动执行；写文件、运行命令和外部工具会按权限策略确认。</p>
          <p class="panel-help">工具注册表不是“新增工具商店”，它展示当前已经接入的工具。要给项目扩展更多工具，请在设置里的 MCP 服务 JSON，或项目 .autocode/settings.json 中配置 MCP 服务，刷新后会显示为 MCP 工具。</p>
          ${all.length ? `
            <div class="tool-registry-grid">
              ${all.slice(0, 48).map(item => {
                const permission = String(item?.permission || 'ask')
                const risk = String(item?.risk || 'medium')
                const kind = String(item?.kind || 'builtin')
                const description = String(item?.description || item?.message || '')
                return `
                  <article class="tool-registry-item ${escapeHtml(permission)} ${escapeHtml(risk)}">
                    <header>
                      <strong>${escapeHtml(this.toolNameLabel(String(item?.name || item?.id || 'tool')))}</strong>
                      <span>${escapeHtml(this.toolKindLabel(kind))}</span>
                    </header>
                    <p>${escapeHtml(description || this.toolRegistryFallbackDescription(String(item?.name || '')))}</p>
                    <footer>
                      <span>${escapeHtml(this.permissionLabel(permission))}</span>
                      <span>${escapeHtml(this.riskLabel(risk))}</span>
                      ${item?.implemented === false ? '<span>待接入</span>' : '<span>可用</span>'}
                    </footer>
                  </article>
                `
              }).join('')}
            </div>
          ` : '<div class="empty-hint">工具注册表尚未加载。点击刷新工具。</div>'}
        </div>
      </details>
    `
  }

  private toolRegistryFallbackDescription(name: string) {
    const labels: Record<string, string> = {
      read_file: '读取工作区文件。',
      glob: '按模式扫描工作区文件。',
      grep: '搜索文件名和内容。',
      git_diff: '读取当前 Git diff。',
      todowrite: '维护当前任务 Todo。',
      bash: '执行受控工作区命令。',
      apply_patch: '应用经过审批的 patch。',
      diagnostics: '运行项目诊断命令。',
      test_runner: '运行检测到的测试命令。',
      browser_preview: '检查本地 localhost 预览页面状态。',
      lsp: '提供轻量语言服务。',
      mcp_call: '调用已配置的 MCP 外部工具服务。',
    }
    return labels[name] || 'Agent 可调用工具。'
  }

  private permissionLabel(value: string) {
    if (value === 'allow') return '自动执行'
    if (value === 'ask') return '需要确认'
    if (value === 'deny') return '禁止执行'
    return value || '未配置'
  }

  private riskLabel(value: string) {
    if (value === 'low') return '低风险'
    if (value === 'medium') return '中风险'
    if (value === 'high') return '高风险'
    return value || '未知风险'
  }

  private toolKindLabel(value: string) {
    if (value === 'builtin') return '内置'
    if (value === 'mcp') return 'MCP'
    if (value === 'lsp') return '语言服务'
    return value || '工具'
  }

  private localServerCapabilityLabel(value: string) {
    const key = String(value || '').trim().toLowerCase()
    const labels: Record<string, string> = {
      sessions: '会话',
      session: '会话',
      events: '事件流',
      event: '事件流',
      tools: '工具',
      tool: '工具',
      permissions: '权限',
      permission: '权限',
      files: '文件',
      file: '文件',
      diff: '差异',
      patch: '补丁',
      memory: '记忆',
      hooks: '钩子',
      hook: '钩子',
      mcp: 'MCP',
      lsp: '语言服务',
      processes: '进程',
      process: '进程',
      project: '项目',
      agent: '智能体',
      message: '消息',
      messages: '消息',
      preview: '预览',
      smoke: '自检',
    }
    return labels[key] || value
  }

  private renderSubagentPanel() {
    const running = this.state.agentRuntime.subagents.filter((item: any) => String(item?.status || '') === 'running').length
    const recent = this.state.agentRuntime.subagents.slice(-4) as any[]
    return `
      <details class="subagent-panel">
        <summary>
          <div class="panel-heading compact">
            <span class="feature-icon">专</span>
            <div>
              <strong>专用智能体</strong>
              <span>${running ? `${running} 个正在分析` : `${recent.length} 个最近结果`} · 自动派发已启用</span>
            </div>
          </div>
        </summary>
        <p class="panel-help">复杂任务会由主智能体自动派发探索、审查、调试或测试子智能体；你也可以手动触发。子智能体只返回证据摘要，不把完整过程塞进聊天区。</p>
        <div class="subagent-actions">
          <button data-subagent-profile="Explore"><strong>探索</strong><span>梳理结构</span></button>
          <button data-subagent-profile="Review"><strong>审查</strong><span>检查改动</span></button>
          <button data-subagent-profile="Debug"><strong>调试</strong><span>定位报错</span></button>
          <button data-subagent-profile="Test"><strong>测试</strong><span>找验证命令</span></button>
        </div>
        ${recent.length ? `
          <div class="subagent-results">
            ${recent.reverse().map((item: any) => this.renderSubagentResult(item)).join('')}
          </div>
        ` : '<div class="empty-hint">复杂任务会自动派发；也可以手动触发只读探索、审查、调试或测试分析。</div>'}
      </details>
    `
  }

  private renderSubagentResult(item: any) {
    const status = String(item?.status || 'completed')
    const tools = this.subagentEvidenceTools(item, Array.isArray(item?.tools) ? item.tools : [])
    const running = tools.some(tool => tool.status === 'running')
    const summary = this.repairMojibakeText(String(item?.summary || this.safeJsonPreview(item, 2200))).slice(0, 2200)
    const memory = this.repairMojibakeText(String(item?.evidence?.memory || '')).trim()
    return `
      <details class="subagent-result ${escapeHtml(status)}" ${status === 'running' || running ? 'open' : ''}>
        <summary>
          <strong>${escapeHtml(this.subagentLabel(String(item?.profileId || 'Explore')))}</strong>
          <span>${escapeHtml(status)}${tools.length ? ` · ${tools.length} 个证据工具` : ''}</span>
        </summary>
        ${summary ? `<pre>${escapeHtml(summary)}</pre>` : ''}
        ${tools.length ? `<div class="subagent-tool-evidence">${this.renderToolTrace(tools)}</div>` : ''}
        ${memory ? `
          <details class="subagent-memory">
            <summary><strong>Memory</strong><span>${memory.length} 字符</span></summary>
            <pre>${escapeHtml(memory.slice(0, 4000))}</pre>
          </details>
        ` : ''}
      </details>
    `
  }

  private subagentLabel(profileId: string) {
    const labels: Record<string, string> = {
      Explore: '探索智能体',
      Review: '审查智能体',
      Debug: '调试智能体',
      Test: '测试智能体',
      Refactor: '重构智能体',
      Docs: '文档智能体',
    }
    return labels[profileId] || this.agentProfileLabel(profileId) || '专用智能体'
  }

  private renderAgentRuntime() {
    const runtime = this.state.agentRuntime
    const planTodos = (runtime.planTodos || []).map(item => ({
      text: String(item.text || ''),
      done: ['done', 'completed'].includes(String(item.status || '').toLowerCase()),
      status: String(item.status || 'pending'),
    })).filter(item => item.text)
    const planDevelopment = runtime.planDevelopment
    const hasPlanDevelopment = Boolean(planDevelopment?.planId && planDevelopment.status !== 'idle')
    if (runtime.status !== 'paused_step_limit' && !runtime.resumeReason && !runtime.checkpoints.length && !runtime.subagents.length && !runtime.processes.length && !runtime.hooks.length && !planTodos.length && !hasPlanDevelopment) return ''
    return `
      <article class="assistant-artifacts agent-runtime">
        <header class="agent-runtime-head">
          <div>
            <strong>${runtime.status === 'paused_step_limit' ? 'Agent 已暂停' : '运行时设施'}</strong>
            <span>本轮工具、审批、Patch 与思考摘要已显示在对应回复中</span>
          </div>
          <div class="agent-runtime-actions">
            ${runtime.status === 'paused_step_limit' && !runtime.resumeReason ? '<button class="secondary-button" id="agent-continue">继续</button>' : ''}
            <button class="secondary-button" id="agent-create-checkpoint">Checkpoint</button>
          </div>
        </header>
        ${runtime.resumeReason ? `
          <div class="checkpoint-row">
            <span>${escapeHtml(runtime.resumeReason)}</span>
            <small>${escapeHtml(this.agentStatusLabel(runtime.status))}</small>
            ${runtime.status === 'paused' || runtime.status === 'paused_step_limit' ? '<button class="secondary-button" id="agent-continue">继续</button>' : '<span></span>'}
          </div>
        ` : ''}
        ${runtime.subagents.slice(-3).map((item: any) => this.renderSubagentResult(item)).join('')}
        ${hasPlanDevelopment ? `
          <div class="checkpoint-row plan-development-row">
            <span>${escapeHtml(String(planDevelopment?.planFilePath || '计划文件保存中'))}</span>
            <small>${escapeHtml(String(planDevelopment?.status || 'idle'))}${planDevelopment?.activeTodoId ? ` · ${escapeHtml(planDevelopment.activeTodoId)}` : ''}</small>
            ${planDevelopment?.status === 'executing_plan' ? '<button class="secondary-button" id="agent-continue">继续</button>' : '<span></span>'}
          </div>
          ${planDevelopment?.blockedReason ? `<div class="checkpoint-row warning"><span>${escapeHtml(planDevelopment.blockedReason)}</span><small>blocked</small><span></span></div>` : ''}
        ` : ''}
        ${planTodos.length ? this.renderAgentTodos(planTodos) : ''}
        ${runtime.processes.slice(-4).map((item: any) => `
          <details class="checkpoint-row process-row" ${String(item.status || 'running') === 'running' ? 'open' : ''}>
            <summary>
              <span>${escapeHtml(String(item.command || 'Agent process'))}</span>
              <small>${escapeHtml(String(item.status || 'running'))}${item.pid ? ` · PID ${escapeHtml(String(item.pid))}` : ''}</small>
              ${String(item.status || 'running') === 'running' ? `<button class="secondary-button" data-process-kill="${escapeHtml(String(item.id || ''))}">停止</button>` : '<span></span>'}
            </summary>
            <pre class="tool-output">${escapeHtml(String(item.lastOutput || '等待进程输出...').slice(-6000))}</pre>
          </details>
        `).join('')}
        ${this.renderHookEvents()}
        ${runtime.checkpoints.slice(-3).map((item: any) => `
          <div class="checkpoint-row">
            <span>${escapeHtml(String(item.label || 'Checkpoint'))}</span>
            <small>${escapeHtml(String(item.createdAt || ''))}</small>
            <button class="secondary-button" data-checkpoint-revert="${escapeHtml(String(item.id || ''))}">回退</button>
          </div>
        `).join('')}
      </article>
    `
  }

  private renderHookEvents() {
    const hooks = this.state.agentRuntime.hooks.slice(-6) as any[]
    if (!hooks.length) return ''
    return `
      <details class="thinking-summary hook-audit">
        <summary><strong>Hooks</strong><span>${hooks.length} 条最近审计</span></summary>
        ${hooks.map(item => {
          const payload = item?.payload || {}
          const commands = Array.isArray(payload.commands) ? payload.commands : []
          const blocked = Boolean(payload.blocked)
          return `
            <article class="hook-audit-row ${blocked ? 'blocked' : ''}">
              <header>
                <strong>${escapeHtml(String(payload.event || item.type || 'hook'))}</strong>
                <span>${escapeHtml(String(payload.tool || ''))} · ${escapeHtml(formatTime(String(item.at || '')))}</span>
              </header>
              ${payload.reason ? `<p>${escapeHtml(String(payload.reason))}</p>` : ''}
              ${commands.length ? commands.slice(0, 4).map((command: any) => `
                <div class="tool-kv"><span>${command.skipped ? 'skipped' : command.ok === false ? 'failed' : 'command'}</span><code>${escapeHtml(String(command.command || ''))}</code></div>
                ${(command.output || command.error || command.reason) ? `<pre class="tool-output ${command.ok === false ? 'error' : ''}">${escapeHtml(String(command.output || command.error || command.reason).slice(0, 4000))}</pre>` : ''}
              `).join('') : '<small>没有配置可执行 hook command。</small>'}
            </article>
          `
        }).join('')}
      </details>
    `
  }

  private agentStatusLabel(status: AgentRuntimeState['status']) {
    if (status === 'running') return '执行中'
    if (status === 'waiting_permission') return '等待确认'
    if (status === 'waiting_question') return '等待回答'
    if (status === 'compacting') return '正在压缩上下文'
    if (status === 'cancelling') return '正在收尾停止'
    if (status === 'paused_step_limit') return '达到步数上限，等待继续'
    if (status === 'paused_patch_failed') return 'Patch 应用失败'
    if (status === 'paused') return '已暂停'
    if (status === 'completed') return '已完成'
    if (status === 'failed') return '失败'
    if (status === 'cancelled') return '已取消'
    return '无待确认'
  }

  private extractAgentTodos(calls: ToolCallRecord[]) {
    const todo = [...calls].reverse().find(call => call.name === 'todowrite')
    const source = (todo?.output as any)?.items ?? (todo?.input as any)?.items
    if (!Array.isArray(source)) return []
    return source.map((item: any) => {
      if (typeof item === 'string') return { text: item, done: false, status: 'pending' }
      const status = String(item?.status || (item?.done || item?.completed ? 'completed' : 'pending'))
      return {
        text: String(item?.text || item?.content || item?.title || item?.task || ''),
        done: Boolean(item?.done || item?.completed || status === 'done' || status === 'completed'),
        status,
      }
    }).filter(item => item.text)
  }

  private syncPlanDevelopmentTodos(call: ToolCallRecord) {
    const source = (call.output as any)?.items ?? (call.input as any)?.items
    if (!Array.isArray(source)) return
    const todos: AgentPlanTodo[] = source.map((item: any) => {
      if (typeof item === 'string') return { text: item, status: 'pending', source: 'plan' }
      return {
        text: String(item?.text || item?.content || item?.title || item?.task || ''),
        status: String(item?.status || (item?.done || item?.completed ? 'completed' : 'pending')),
        source: String(item?.source || 'plan'),
      }
    }).filter(item => item.text)
    if (!todos.length) return
    this.state.agentRuntime.planTodos = todos
    const current = this.state.agentRuntime.planDevelopment
    if (current?.planId) {
      this.state.agentRuntime.planDevelopment = {
        ...current,
        todoItems: todos,
        activeTodoId: this.firstIncompleteTodoId(todos),
        completedTodoIds: this.completedTodoIds(todos),
        status: this.allPlanTodosComplete(todos) ? 'completed' : (current.status === 'idle' ? 'executing_plan' : current.status),
      }
    }
  }

  private allPlanTodosComplete(todos = this.state.agentRuntime.planTodos || []) {
    return todos.length > 0 && todos.every(item => ['done', 'completed'].includes(String(item.status || '').toLowerCase()))
  }

  private shouldContinuePlanDevelopment() {
    const development = this.state.agentRuntime.planDevelopment
    if (!development || development.status !== 'executing_plan') return false
    if (this.pendingAiRequest || this.isAgentRunningForComposer()) return false
    const todos = this.state.agentRuntime.planTodos?.length ? this.state.agentRuntime.planTodos : development.todoItems
    if (this.allPlanTodosComplete(todos)) return false
    return Number(development.continuationCount || 0) < 8
  }

  private async continuePlanDevelopment(reason = 'manual') {
    const development = this.state.agentRuntime.planDevelopment
    const plan = this.state.agentRuntime.approvedPlan
    if (!development?.planId || !plan || !this.currentRoot()) return
    if (this.pendingAiRequest || this.isAgentRunningForComposer()) return
    const todos = this.state.agentRuntime.planTodos?.length ? this.state.agentRuntime.planTodos : development.todoItems
    if (this.allPlanTodosComplete(todos)) {
      this.state.agentRuntime.planDevelopment = { ...development, status: 'completed', todoItems: todos }
      return
    }
    const nextCount = Number(development.continuationCount || 0) + 1
    this.state.agentRuntime.planDevelopment = {
      ...development,
      status: 'executing_plan',
      continuationCount: nextCount,
      todoItems: todos,
      activeTodoId: this.firstIncompleteTodoId(todos),
      blockedReason: '',
    }
    const todoText = todos.map((item, index) => `${index + 1}. [${item.status || 'pending'}] ${item.text}`).join('\n')
    const prompt = [
      'CONTINUE_EXECUTING_APPROVED_PLAN',
      '',
      `续跑原因：${reason}`,
      '你仍处于 executing_plan 连续开发状态。',
      '不要重新规划，不要写计划文档，不要输出建议代替执行。',
      '请读取/使用计划文件和当前 Todo 状态，继续执行第一个未完成 Todo。',
      '如果需要写文件或运行命令，直接调用工具并按审批规则处理。',
      '',
      '【计划文件】',
      development.planFilePath || plan.planFilePath || '',
      '',
      '【当前 Todo】',
      todoText,
      '',
      '【已确认计划】',
      plan.content,
    ].join('\n')
    const contextRefs = [
      { id: `continue-plan-${plan.id}`, kind: 'workspace', label: '连续计划开发状态', value: JSON.stringify(this.state.agentRuntime.planDevelopment, null, 2) },
      { id: `continue-plan-file-${plan.id}`, kind: 'file', label: '计划文件', value: development.planFilePath || plan.planFilePath || '' },
    ]
    await this.runLocalAiTask(prompt, { extraContextRefs: contextRefs as any[], displayUserMessage: false })
  }

  private renderAgentTodos(items: Array<{ text: string; done: boolean; status?: string }>) {
    return `
      <section class="agent-todo-panel">
        <header><strong>Todo</strong><span>${items.filter(item => item.done).length}/${items.length}</span></header>
        <ol>
          ${items.slice(0, 8).map(item => `<li class="${escapeHtml(item.done ? 'done' : String(item.status || 'pending'))}"><span></span>${escapeHtml(item.text)}</li>`).join('')}
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
      diagnostics: '运行诊断',
      test_runner: '运行测试',
      symbol_search: '搜索符号',
      process_manager: '进程管理',
      browser_preview: '预览检查',
      lsp: '语言服务',
      mcp_call: 'MCP 工具',
      question: '询问用户',
    }
    return labels[name] || name
  }

  private toolSummary(call: ToolCallRecord) {
    if (call.error) return this.repairMojibakeText(call.error)
    const input = call.input as any
    const output = call.output as any
    if (call.name === 'bash') return String(output?.command || input?.command || input?.cmd || '工作区命令')
    if (call.name === 'diagnostics') return String(output?.command || output?.message || '项目诊断')
    if (call.name === 'test_runner') return String(output?.command || output?.message || '项目测试')
    if (call.name === 'symbol_search') return `${output?.count ?? output?.symbols?.length ?? '-'} 个结果 · ${input?.query || input?.symbol || ''}`
    if (call.name === 'process_manager') {
      const action = String(input?.action || (output?.background ? 'start' : 'list'))
      if (action === 'start') return `${output?.pid ? `PID ${output.pid}` : '启动进程'} · ${output?.command || input?.command || ''}`
      if (action === 'kill' || action === 'stop') return `${output?.status || 'stopped'} · ${output?.id || input?.processId || ''}`
      return `${output?.processes?.length ?? 0} 个 Agent 进程`
    }
    if (call.name === 'browser_preview') return `${output?.status || '-'} · ${output?.title || output?.url || input?.url || 'localhost'}`
    if (call.name === 'lsp') return String(output?.method || input?.method || 'language service')
    if (call.name === 'mcp_call') return `${input?.server || output?.server || 'MCP'} · ${input?.tool || output?.method || input?.action || 'tools/list'}`
    if (call.name === 'grep') return `${output?.count ?? '-'} 个匹配 · ${input?.query || input?.pattern || ''}`
    if (call.name === 'glob' || call.name === 'list_files') {
      const cached = output?.cached ? ' · 缓存' : ''
      return `${output?.count ?? '-'} 项 · ${output?.path || input?.path || 'workspace'}${cached}`
    }
    if (typeof output === 'string') return this.repairMojibakeText(output).slice(0, 140)
    if (output?.path) return output.path
    if (output?.summary) return this.repairMojibakeText(String(output.summary))
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
      const message = output?.message
        ? `<div class="tool-kv"><span>${output?.cached ? 'cache' : 'note'}</span><code>${escapeHtml(this.repairMojibakeText(String(output.message)))}</code></div>`
        : ''
      return `${message}<pre class="tool-output">${escapeHtml(entries.slice(0, 160).join('\n') || this.safeJsonPreview(output || input, 8000))}</pre>`
    }
    if (call.name === 'git_diff') {
      return `<pre class="tool-output diff">${escapeHtml(String(output?.diff || this.safeJsonPreview(output || input, 10000)).slice(0, 12000))}</pre>`
    }
    if (call.name === 'diagnostics' || call.name === 'test_runner') {
      return `
        <div class="tool-kv"><span>command</span><code>${escapeHtml(String(output?.command || '未配置'))}</code></div>
        ${output?.exitCode !== undefined ? `<div class="tool-kv"><span>exit</span><code>${escapeHtml(String(output.exitCode))}</code></div>` : ''}
        <pre class="tool-output ${output?.ok === false ? 'error' : ''}">${escapeHtml(String(output?.output || output?.message || this.safeJsonPreview(output || input, 8000)).slice(0, 12000))}</pre>
      `
    }
    if (call.name === 'symbol_search') {
      const symbols = Array.isArray(output?.symbols) ? output.symbols : []
      return `
        <div class="tool-result-list">
          ${symbols.slice(0, 30).map((item: any) => `
            <button data-open-path="${escapeHtml(String(item.path || ''))}">
              <strong>${escapeHtml(String(item.path || ''))}${item.line ? `:${escapeHtml(String(item.line))}` : ''}</strong>
              <span>${escapeHtml(String(item.preview || item.name || ''))}</span>
            </button>
          `).join('') || '<small>没有符号匹配。</small>'}
        </div>
      `
    }
    if (call.name === 'process_manager') {
      if (output?.background || input?.action === 'start') {
        return `
          <div class="tool-kv"><span>process</span><code>${escapeHtml(String(output?.id || ''))}</code></div>
          <div class="tool-kv"><span>pid</span><code>${escapeHtml(String(output?.pid || '-'))}</code></div>
          <div class="tool-kv"><span>cwd</span><code>${escapeHtml(String(output?.cwd || this.currentRoot()))}</code></div>
          <div class="tool-kv"><span>command</span><code>${escapeHtml(String(output?.command || input?.command || ''))}</code></div>
          <pre class="tool-output">${escapeHtml(String(output?.message || '进程已交给 Agent 受控进程管理，后续输出会显示在运行时面板。'))}</pre>
        `
      }
      if (input?.action === 'kill' || input?.action === 'stop') {
        return `
          <div class="tool-kv"><span>process</span><code>${escapeHtml(String(output?.id || input?.processId || ''))}</code></div>
          <div class="tool-kv"><span>status</span><code>${escapeHtml(String(output?.status || 'killed'))}</code></div>
          <pre class="tool-output">${escapeHtml(String(output?.lastOutput || output?.message || '进程已停止。').slice(-6000))}</pre>
        `
      }
      const processes = Array.isArray(output?.processes) ? output.processes : []
      return processes.length
        ? processes.map((item: any) => `
            <details class="agent-tool-card ${escapeHtml(String(item.status || 'running'))}">
              <summary><strong>${escapeHtml(String(item.status || 'running'))}</strong><small>${escapeHtml(String(item.pid || ''))} · ${escapeHtml(String(item.command || ''))}</small></summary>
              <pre class="tool-output">${escapeHtml(String(item.lastOutput || '暂无输出。').slice(-6000))}</pre>
            </details>
          `).join('')
        : '<pre class="tool-output">暂无 Agent 后台进程。</pre>'
    }
    if (call.name === 'browser_preview') {
      return `
        <div class="tool-kv"><span>url</span><code>${escapeHtml(String(output?.url || input?.url || ''))}</code></div>
        <div class="tool-kv"><span>status</span><code>${escapeHtml(String(output?.status || '-'))}</code></div>
        <div class="tool-kv"><span>title</span><code>${escapeHtml(String(output?.title || '-'))}</code></div>
        <div class="tool-kv"><span>type</span><code>${escapeHtml(String(output?.contentType || '-'))}</code></div>
        <pre class="tool-output ${output?.ok === false ? 'error' : ''}">${escapeHtml(String(output?.snippet || output?.message || this.safeJsonPreview(output || input, 4000)).slice(0, 6000))}</pre>
      `
    }
    if (call.name === 'lsp') {
      const result = output?.result || output || {}
      const locations = Array.isArray(result?.locations) ? result.locations : Array.isArray(result?.editsPreview) ? result.editsPreview : []
      const symbols = Array.isArray(result?.symbols) ? result.symbols : []
      if (locations.length || symbols.length) {
        const items = locations.length ? locations : symbols
        return `
          <div class="tool-kv"><span>method</span><code>${escapeHtml(String(output?.method || input?.method || 'lsp'))}</code></div>
          <div class="tool-result-list">
            ${items.slice(0, 40).map((item: any) => `
              <button data-open-path="${escapeHtml(String(item.path || ''))}">
                <strong>${escapeHtml(String(item.path || ''))}${item.line ? `:${escapeHtml(String(item.line))}` : ''}</strong>
                <span>${escapeHtml(String(item.preview || item.name || item.symbol || ''))}</span>
              </button>
            `).join('')}
          </div>
          ${result?.requiresApproval ? '<small>应用 rename/edit 必须走 patch 审批。</small>' : ''}
          ${result?.patch ? `<pre class="tool-output diff">${escapeHtml(String(result.patch).slice(0, 12000))}</pre>` : ''}
        `
      }
      return `<pre class="tool-output">${escapeHtml(this.safeJsonPreview(result, 10000))}</pre>`
    }
    if (call.name === 'mcp_call') {
      return `
        <div class="tool-kv"><span>server</span><code>${escapeHtml(String(output?.server || input?.server || ''))}</code></div>
        <div class="tool-kv"><span>tool</span><code>${escapeHtml(String(input?.tool || input?.action || output?.method || 'tools/list'))}</code></div>
        <pre class="tool-output">${escapeHtml(this.safeJsonPreview(output?.result || output || input, 12000))}</pre>
      `
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
      return this.repairMojibakeText(JSON.stringify(value ?? {}, null, 2)).slice(0, max)
    } catch {
      return this.repairMojibakeText(String(value ?? '')).slice(0, max)
    }
  }

  private repairMojibakeText(text: string) {
    if (!text) return ''
    return text
      .replace(/\s*class="tok-[^"]+">/g, '')
      .replace(/璇诲彇椤圭洰璁板繂鏂囦欢/g, '读取项目记忆文件')
      .replace(/鎬濊€冩憳瑕佷腑鏂囪ִ琛屾憳瑕侊紝鍘熷璋冭瘯淇℃伅涓嶅崰鐢ㄨ亰澶╁尯/g, '思考摘要中文执行摘要，原始调试信息不占用聊天区')
      .replace(/鏈疆宸ュ叿璋冪敤/g, '本轮工具调用')
      .replace(/姝ｅ湪璇锋眰 Provider/g, '正在请求 Provider')
      .replace(/濮濓絽婀拠閿嬬湴 Provider/g, '正在请求 Provider')
      .replace(/濮濓絽婀幍褑顢戝銉ュ徔/g, '正在执行工具')
      .replace(/宸蹭慨澶嶈繖涓/g, '已修复这个')
      .replace(/淇鍐呭/g, '修复内容')
      .replace(/楠岃瘉缁撴灉/g, '验证结果')
      .replace(/瀹屾垚/g, '完成')
      .replace(/璇诲彇/g, '读取')
      .replace(/瀛\?Agent 宸插畬鎴愬彧璇绘帰绱€備换鍔★細/g, '子智能体已完成只读探索。任务：')
      .replace(/Memory refs:/g, '记忆引用：')
      .replace(/Evidence:/g, '证据：')
      .replace(/Git:/g, 'Git 分支：')
  }

  private htmlEntityDecode(text: string) {
    const textarea = document.createElement('textarea')
    textarea.innerHTML = text
    return textarea.value
  }

  private isRenderableHtmlSnippet(lang: string, code: string) {
    return lang.toLowerCase().includes('html') && /<(?:section|article|div|pre|code|h[1-6]|p|ul|ol|table|details|blockquote)\b/i.test(code)
  }

  private highlightCode(code: string, lang: string) {
    const language = lang.toLowerCase()
    const escaped = escapeHtml(code)
    const keywordSets: Record<string, string[]> = {
      python: ['from', 'import', 'class', 'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'raise', 'True', 'False', 'None', 'async', 'await'],
      py: ['from', 'import', 'class', 'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'as', 'raise', 'True', 'False', 'None', 'async', 'await'],
      javascript: ['import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'try', 'catch', 'throw', 'type', 'interface'],
      js: ['import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'try', 'catch', 'throw'],
      typescript: ['import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'try', 'catch', 'throw', 'type', 'interface'],
      ts: ['import', 'export', 'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'await', 'async', 'try', 'catch', 'throw', 'type', 'interface'],
      rust: ['fn', 'let', 'mut', 'pub', 'struct', 'enum', 'impl', 'trait', 'match', 'if', 'else', 'use', 'mod', 'async', 'await', 'Result', 'Option'],
      java: ['class', 'public', 'private', 'protected', 'static', 'final', 'void', 'return', 'if', 'else', 'new', 'try', 'catch', 'throw', 'interface'],
      go: ['package', 'import', 'func', 'return', 'if', 'else', 'for', 'range', 'type', 'struct', 'interface', 'go', 'defer'],
    }
    const keys = keywordSets[language] || keywordSets[language.split('-')[0] || ''] || []
    if (!keys.length) return escaped
    return escaped
      .replace(/(&quot;.*?&quot;|&#39;.*?&#39;|`.*?`)/g, '<span class="tok-string">$1</span>')
      .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>')
      .replace(new RegExp(`\\b(${keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g'), '<span class="tok-keyword">$1</span>')
      .replace(/(#.*)$/gm, '<span class="tok-comment">$1</span>')
  }

  private isMostlyEnglish(text: string) {
    const sample = text.replace(/[`"'{}()[\]\d\s:;,.\/\\_\-+=<>|@#$%^&*!?]/g, '')
    if (!sample) return false
    const latin = (sample.match(/[A-Za-z]/g) || []).length
    const cjk = (sample.match(/[\u4e00-\u9fff]/g) || []).length
    return latin > cjk * 2 && latin > 24
  }

  private chineseTurnSummary(message?: AppState['chat'][number]) {
    const calls = message?.toolCalls || this.activeTurnToolCalls()
    const parts: string[] = []
    if (calls.length) {
      const running = calls.filter(call => call.status === 'running').length
      const failed = calls.filter(call => call.status === 'error').length
      const done = calls.filter(call => call.status === 'ok').length
      parts.push(`本轮已调用 ${calls.length} 个工具，其中 ${done} 个完成${running ? `、${running} 个执行中` : ''}${failed ? `、${failed} 个失败` : ''}。`)
      const names = [...new Set(calls.slice(-6).map(call => this.toolNameLabel(call.name)))]
      if (names.length) parts.push(`最近步骤：${names.join('、')}。`)
    }
    if (message?.patchPreviews?.length) parts.push(`已生成 ${message.patchPreviews.length} 个 Patch 预览，等待你在当前回复中确认或应用。`)
    if (message?.pendingPermissions?.length) parts.push(`有 ${message.pendingPermissions.length} 个操作需要你确认后继续执行。`)
    if (!parts.length) parts.push('正在分析需求、整理上下文，并准备继续执行。')
    return parts.join('\n')
  }

  private renderChatMessageContent(message: AppState['chat'][number]) {
    const messageId = message.id
    const text = this.repairMojibakeText(message.text)
    const raw = String(text || '')
    const parts = raw.split(/```([^\n`]*)\n([\s\S]*?)```/g)
    let codeIndex = 0
    const body = raw.trim() ? parts.map((part, index) => {
      if (index % 3 === 1) return ''
      if (index % 3 === 2) {
        const lang = parts[index - 1]?.trim() || 'text'
        const code = part
        const id = `${messageId}:${codeIndex++}`
        if (lang.toLowerCase() === 'mermaid') return this.renderMermaidBlock(code, 'mermaid')
        const isDiff = lang.toLowerCase().includes('diff') || code.includes('\n+++ ') || code.includes('\n--- ') || code.includes('*** Begin Patch')
        const showInlineApply = isDiff && !(message.patchPreviews?.length)
        if (this.isRenderableHtmlSnippet(lang, code)) return this.renderRichText(this.htmlEntityDecode(code))
        return `
          <figure class="chat-code-block ${isDiff ? 'diff' : ''}">
            <figcaption><span>${escapeHtml(lang)}</span><button data-copy-code="${escapeHtml(id)}">复制</button></figcaption>
            <pre><code>${this.highlightCode(code, lang)}</code></pre>
            ${showInlineApply ? `<footer class="message-action-bar code-actions"><button data-apply-patch="${escapeHtml(id)}">应用 patch</button></footer>` : ''}
          </figure>
        `
      }
      return this.renderRichText(part)
    }).join('') : ''
    const questionCalls = message.role === 'assistant' && message.toolCalls?.length
      ? message.toolCalls.filter(call => call.name === 'question')
      : []
    const nonQuestionToolCalls = message.role === 'assistant' && message.toolCalls?.length
      ? message.toolCalls.filter(call => call.name !== 'question')
      : []
    const tools = nonQuestionToolCalls.length
      ? this.renderMessageToolCalls(nonQuestionToolCalls)
      : ''
    const questions = questionCalls.length ? this.renderAgentQuestionCards(questionCalls) : ''
    const reasoning = message.role === 'assistant' && (message.reasoning || message.compactedSummary)
      ? this.renderMessageReasoning(message.reasoning || '', message.compactedSummary, message)
      : ''
    const permissions = message.role === 'assistant' && message.pendingPermissions?.length
      ? this.renderMessagePermissions(message.pendingPermissions)
      : ''
    const patches = message.role === 'assistant' && message.patchPreviews?.length
      ? this.renderMessagePatchPreviews(message.patchPreviews)
      : ''
    const plan = message.role === 'assistant'
      ? message.plan || this.detectAgentPlanFromText(raw, message.id, message.at, false)
      : null
    const queueRecord = message.queued ? this.state.agentRuntime.queuedUserMessages.find(item => item.id === message.queued?.id) : null
    const insertedQueue = Boolean(message.text.startsWith('【插入本轮】') || queueRecord?.text?.startsWith('【插入本轮】'))
    const queued = message.queued
      ? `<div class="queued-message-status ${escapeHtml(message.queued.status)}"><span>${escapeHtml(insertedQueue && message.queued.status === 'queued' ? '已插入本轮' : this.queuedStatusLabel(message.queued.status))}</span><small>${message.queued.status === 'queued' ? (insertedQueue ? '当前任务结束后优先作为本轮补充处理，不会打断正在执行的工具。' : '等当前任务完成后自动处理，不会打断正在执行的工具。') : message.queued.status === 'processing' ? '正在作为下一轮补充消息处理。' : message.queued.status === 'failed' ? escapeHtml(queueRecord?.error || '未能自动处理，可编辑后重发。') : '已被下一轮 Agent 消费。'}</small></div>`
      : ''
    const turnActions = message.role === 'assistant' && message.checkpointIds?.length
      ? `
        <div class="message-turn-actions">
          <span>${message.checkpointIds.length} 个 checkpoint 可回退</span>
          <button class="secondary-button" data-turn-revert="${escapeHtml(message.id)}">撤销本轮修改</button>
        </div>
      `
      : ''
    const attachments = this.renderMessageAttachments(message.attachments || [])
    if (message.role === 'assistant' && (message as any).planInvalidHidden) {
      return `${queued}${reasoning}${tools}${this.renderPlanOutputBlockedCard(message)}${attachments}${turnActions}${patches}${permissions}${questions}`
    }
    const planCard = plan && this.canRenderFinalPlanCard() && this.planHasConfirmation(plan) && this.planHasStrictStructure(plan.content)
      ? this.renderAgentPlanCard(plan)
      : ''
    const planningFollowup = !planCard && !questions && this.shouldRenderPlanningFollowup(message, raw)
      ? this.renderPlanningFollowupCard(message)
      : ''
    return `${queued}${reasoning}${tools}${planCard || body}${attachments}${turnActions}${patches}${permissions}${planningFollowup}${questions}`
  }

  private renderPlanOutputBlockedCard(message: AppState['chat'][number]) {
    const reason = String((message as any).planInvalidReason || '规划模式输出不是合格开发计划')
    const retrying = Boolean((message as any).planAutoRepairRunning)
    return `
      <article class="agent-question-card planning-followup-card">
        <header>
          <span>规划模式</span>
          <strong>${retrying ? '正在自动纠偏' : '规划输出已拦截'}</strong>
        </header>
        <p>${escapeHtml(reason)}。规划模式只允许输出问题卡或完整开发计划。</p>
        ${retrying ? '<small>正在重新请求问题卡或完整开发计划...</small>' : `
          <footer class="message-action-bar question-actions">
            <div class="question-options">
              <button class="recommended" data-planning-followup-action="plan" data-planning-followup-message="${escapeHtml(message.id)}">重新生成开发计划</button>
            </div>
          </footer>
        `}
      </article>
    `
  }

  private shouldRenderPlanningFollowup(message: AppState['chat'][number], raw: string) {
    void message
    void raw
    return false
  }

  private shouldRenderPlanningFollowupLegacy(message: AppState['chat'][number], raw: string) {
    if (message.role !== 'assistant') return false
    if (String(this.state.agentRuntime.profileId || '').toLowerCase() !== 'plan') return false
    if (message.pendingPermissions?.length || message.patchPreviews?.length) return false
    if (message.toolCalls?.some(call => call.name === 'question')) return false
    if (message.plan) return false
    if ((message as any).planningFollowupResolved) return false
    const text = raw.trim()
    if (text.length < 120) return false
    return !this.planHasConfirmation(this.detectAgentPlanFromText(text, message.id, message.at, false) || {
      id: '',
      title: '',
      content: text,
      todos: [],
      answers: [],
      createdAt: '',
      executionReady: false,
    })
  }

  private renderPlanningFollowupCard(message: AppState['chat'][number]) {
    const messageId = message.id || ''
    const actions = [
      ['plan', '重新生成开发计划', '先用问题卡确认需求，再输出完整开发计划和 Todo'],
    ]
    return `
      <article class="agent-question-card planning-followup-card">
        <header>
          <span>规划模式</span>
          <strong>规划未完成</strong>
        </header>
        <p>本轮没有产出合格开发计划。规划模式必须先确认需求，再生成完整 Plan 文档、Todo 和“按此计划开发”入口。</p>
        <footer class="message-action-bar question-actions">
          <div class="question-options">
            ${actions.map(([action, label, description]) => `
              <button
                class="${action === 'plan' ? 'recommended' : ''}"
                data-planning-followup-action="${escapeHtml(action)}"
                data-planning-followup-message="${escapeHtml(messageId)}"
                title="${escapeHtml(description)}"
              >${escapeHtml(label)}</button>
            `).join('')}
          </div>
        </footer>
      </article>
    `
  }

  private async handlePlanningFollowup(action: string, messageId: string, button?: HTMLElement) {
    const source = this.state.chat.find(item => item.id === messageId)
    if (!source) return this.toast('没有找到对应的分析回复', 'error')
    if (this.isAgentRunningForComposer()) return this.toast('当前 Agent 仍在执行，请等本轮结束后再选择下一步。', 'idle')
    const sourceText = this.repairMojibakeText(source.text || '').trim()
    const labels: Record<string, string> = {
      plan: '重新生成开发计划',
    }
    this.state.chat = this.state.chat.map(item =>
      item.id === messageId ? { ...item, planningFollowupResolved: action } as any : item,
    )
    if (action !== 'plan') return this.toast('规划模式只允许生成开发计划', 'idle')
    const label = labels[action] || '继续处理'
    this.state.chat.push({
      id: `msg-${Date.now()}-planning-followup`,
      role: 'user',
      text: `选择下一步：${label}`,
      at: new Date().toISOString(),
    })
    this.setInlineActionFeedback(button, 'loading', '处理中...')
    const contextRefs = [{
      id: `planning-analysis-${messageId}`,
      kind: 'workspace',
      label: '上一轮规划分析回复',
      value: sourceText.slice(0, 30000),
    }]
    try {
      this.state.agentRuntime.profileId = 'plan'
      this.state.agentRuntime.planningConfirmation = {
        status: 'collecting_requirements',
        answers: [],
        openQuestions: ['需要重新确认开发计划目标。'],
        confirmedRequirements: [],
      }
      this.state.agentRuntime.planningAnswers = []
      await this.runLocalAiTask([
        '上一轮规划模式输出不合格：它输出了分析/建议，而不是开发计划。',
        '',
        '现在必须纠偏为标准规划流程。',
        '',
        '硬性要求：',
        '- 你现在仍是规划模式，唯一目标是生成可执行开发计划，不允许输出分析/建议作为最终交付。',
        '- 不能写文件，不能更新 memory，不能调用 todowrite，直到用户确认需求并产出最终计划。',
        '- 先基于上一轮内容和只读项目证据，调用 question 工具让用户确认具体开发目标和范围。',
        '- question 必须有 2-3 个选项和自由输入框；推荐项放第一。',
        '- 用户确认后，下一轮输出完整五段中文开发计划，标题必须依次为：Summary（摘要）/ Key Changes（关键改动）/ Public Interfaces（公共接口）/ Test Plan（测试计划）/ Assumptions（假设）。',
        '- 最终计划必须能生成 Todo，并显示“按此计划开发”。',
      ].join('\n'), { displayUserMessage: false, extraContextRefs: contextRefs as any[] })
    } finally {
      this.setInlineActionFeedback(button, 'ok', '已选择')
      this.renderAssistant()
      this.scheduleSessionPersist()
    }
  }

  private canRenderFinalPlanCard() {
    const confirmation = this.state.agentRuntime.planningConfirmation
    return !(confirmation?.openQuestions || []).length
  }

  private detectAgentPlanFromText(text: string, messageId = '', createdAt = '', allowLoose = false, answers: string[] = []): AgentApprovedPlan | null {
    const raw = String(text || '').trim()
    if (!raw) return null
    const sections = this.extractPlanSections(raw)
    if (!this.planSectionsAreComplete(sections)) {
      if (!allowLoose || !this.looksLikeLoosePlanningAnswer(raw)) return null
      this.fillLoosePlanSections(raw, sections)
    }
    if (!this.planSectionsAreComplete(sections)) return null
    const extractedTodos = this.extractPlanTodos(sections)
    const executionReady = this.planLooksExecutionReady(raw, extractedTodos)
    const todos = executionReady ? extractedTodos : []
    return {
      id: messageId || `plan-${this.hashText(raw)}`,
      title: this.extractPlanTitle(raw) || (executionReady ? '已确认实施计划' : '规划分析报告'),
      content: raw,
      todos,
      answers: answers.slice(-12),
      createdAt: createdAt || new Date().toISOString(),
      executionReady,
      planKind: executionReady ? 'development' : 'analysis',
    }
  }

  private planSectionsAreComplete(sections: Record<string, string>) {
    return ['summary', 'key changes', 'public interfaces', 'test plan', 'assumptions']
      .every(key => Boolean(sections[key]?.trim()))
  }

  private standardPlanSectionDefinitions() {
    return [
      { key: 'summary', title: 'Summary', zh: '摘要', display: 'Summary（摘要）' },
      { key: 'key changes', title: 'Key Changes', zh: '关键改动', display: 'Key Changes（关键改动）' },
      { key: 'public interfaces', title: 'Public Interfaces', zh: '公共接口', display: 'Public Interfaces（公共接口）' },
      { key: 'test plan', title: 'Test Plan', zh: '测试计划', display: 'Test Plan（测试计划）' },
      { key: 'assumptions', title: 'Assumptions', zh: '假设', display: 'Assumptions（假设）' },
    ] as const
  }

  private strictPlanHeadingKey(line: string) {
    const clean = line
      .replace(/^#{1,4}\s*/, '')
      .trim()
      .replace(/[：:]\s*$/, '')
      .replace(/\s+/g, ' ')
    for (const section of this.standardPlanSectionDefinitions()) {
      const ascii = `${section.title} (${section.zh})`
      if (clean === section.display || clean === ascii) return section.key
    }
    return ''
  }

  private planHasStrictStructure(content: string) {
    const normalized = content.replace(/\r\n/g, '\n')
    const lines = normalized.split('\n')
    const positions = this.standardPlanSectionDefinitions().map(section => {
      let offset = 0
      let found = -1
      for (const line of lines) {
        if (this.strictPlanHeadingKey(line) === section.key) {
          found = offset
          break
        }
        offset += line.length + 1
      }
      return found
    })
    const headingCounts = this.standardPlanSectionDefinitions().map(section =>
      lines.filter(line => this.strictPlanHeadingKey(line) === section.key).length,
    )
    return positions.every(index => index >= 0)
      && positions.every((index, offset) => offset === 0 || index > positions[offset - 1])
      && headingCounts.every(count => count === 1)
      && this.planSectionsAreComplete(this.extractPlanSections(content))
  }

  private planHasConfirmation(plan: AgentApprovedPlan) {
    return Boolean((plan.answers || []).length || (this.state.agentRuntime.planningAnswers || []).length)
  }

  private planLooksExecutionReady(content: string, todos: AgentPlanTodo[]) {
    const text = `${content}\n${todos.map(item => item.text).join('\n')}`.toLowerCase()
    if (this.planLooksAnalysisOnly(content)) return false
    const hasAction = /(修改|实现|新增|修复|接入|改造|重构|优化|调整|删除|替换|验证|测试|build|implement|update|fix|refactor|test)/i.test(text)
    const hasConcreteTarget = /(\.[a-z0-9]{1,8}\b|src\/|app\/|components?\/|pages?\/|routes?\/|api\/|backend\/|frontend\/|按钮|输入框|页面|组件|接口|样式|布局|状态|渲染)/i.test(text)
    const analysisOnly = /(建议|分析|后续发展|优化方向|评审稿|报告|文档|不改|只输出|仅分析)/i.test(text)
      && !/(修改|实现|新增|修复|落地|开发|代码|组件|接口)/i.test(text)
    return todos.length > 0 && hasAction && hasConcreteTarget && !analysisOnly
  }

  private planLooksAnalysisOnly(content: string) {
    const text = content.toLowerCase()
    const analysisSignals = [
      /主流\s*coding agent|claude code|codex harness|对话系统\s*agent|agent\s*优化点/i.test(text),
      /对比|机制分析|能力分析|架构分析|优化点|经验|主流/.test(text),
      /页面优化分析|优化分析|现状分析|后续发展建议|发展建议|优化建议|迭代建议/.test(text),
      /输出一份|整理成一份|便于后续|评审|排期|建议清单|分析表/.test(text),
      /如果你愿意|我下一步可以继续|可以继续帮你/.test(text),
      /不改变原有业务目标|不要无范围扩展|不做无范围扩展/.test(text),
      /只分析|仅分析|只输出|不修改|不改变/.test(text),
    ].filter(Boolean).length
    const implementationSignals = [
      /按此计划开发|开始开发|立即实现|进行修改|修改文件|新增文件|修复 bug|落地实现/.test(text),
      /使用 write|apply_patch|运行测试|提交变更|改造代码/.test(text),
      /src\/|app\/|components?\/|pages?\/|routes?\/|api\/|backend\/|frontend\//i.test(text),
    ].filter(Boolean).length
    return analysisSignals >= 2 && implementationSignals < 2
  }

  private extractPlanSections(text: string) {
    const normalized = text.replace(/\r\n/g, '\n')
    const matches: Array<{ key: string; index: number; length: number }> = []
    let offset = 0
    for (const line of normalized.split('\n')) {
      const key = this.strictPlanHeadingKey(line)
      if (key) matches.push({ key, index: offset, length: line.length })
      offset += line.length + 1
    }
    const sections: Record<string, string> = {}
    for (let index = 0; index < matches.length; index += 1) {
      const key = matches[index].key
      const start = matches[index].index + matches[index].length
      const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length
      sections[key] = normalized.slice(start, end).trim()
    }
    return sections
  }

  private looksLikeLoosePlanningAnswer(text: string) {
    const normalized = text.toLowerCase()
    const headingCount = (text.match(/^#{2,4}\s+/gm) || []).length
    const bulletCount = (text.match(/^\s*(?:[-*]|\d+[.)、])\s+/gm) || []).length
    const priorityCount = (text.match(/\bP[0-3]\b/gi) || []).length
    const signals = [
      headingCount >= 4,
      bulletCount >= 8,
      priorityCount >= 2,
      /(^|\n)#{1,4}\s*(?:[一二三四五六七八九十]+、|\d+[.)、])/.test(text),
      /优化|建议|计划|方案|迭代|优先级|验收|验证|约束|需要确认/.test(text),
      /\bP[0-3]\b|第一阶段|第二阶段|第三阶段/i.test(text),
      /目标|具体要求|测试|Assumptions|Key Changes|Test Plan/i.test(text),
    ].filter(Boolean).length
    return text.length > 500 && signals >= 2 && !/^\s*(error|exception|traceback)\b/i.test(normalized)
  }

  private fillLoosePlanSections(text: string, sections: Record<string, string>) {
    const normalized = text.replace(/\r\n/g, '\n').trim()
    if (!sections.summary) {
      const firstBlock = normalized.split(/\n\s*\n/).find(block => block.trim().length > 30) || normalized.slice(0, 700)
      sections.summary = firstBlock.trim().slice(0, 1200)
    }
    if (!sections['key changes']) {
      const keyLines = this.extractLoosePlanLines(normalized, /(建议|优化|新增|支持|调整|改造|强化|提升|阶段|P[0-3]|优先级)/i)
      sections['key changes'] = keyLines.length ? keyLines.join('\n') : normalized.slice(0, 2200)
    }
    if (!sections['test plan']) {
      const testLines = this.extractLoosePlanLines(normalized, /(验证|测试|验收|确认|检查|运行|build|check|test)/i)
      sections['test plan'] = testLines.length ? testLines.join('\n') : '重新打开规划回复，确认计划卡、任务清单和“按此计划开发”按钮可见；点击后进入构建模式并携带计划上下文。'
    }
    if (!sections.assumptions) {
      const assumptionLines = this.extractLoosePlanLines(normalized, /(约束|假设|前提|不改变|保持|需要确认|无法|暂不)/i)
      sections.assumptions = assumptionLines.length ? assumptionLines.join('\n') : '规划内容来自当前回复；未明确的信息保持为需要确认项，实施前不自动修改文件。'
    }
  }

  private extractLoosePlanLines(text: string, matcher: RegExp) {
    const lines = text.split(/\r?\n/)
      .map(line => line.trim())
      .map(line => line.replace(/^#{1,4}\s*/, '').replace(/^[-*]\s+/, '').replace(/^\d+[.)、]\s+/, '').trim())
      .filter(line => line.length >= 8 && line.length <= 180 && matcher.test(line))
    const seen = new Set<string>()
    return lines.filter(line => {
      const key = line.replace(/\s+/g, ' ')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 18)
  }

  private extractPlanTitle(text: string) {
    const first = text.split(/\r?\n/).map(line => line.trim()).find(line => line && !this.strictPlanHeadingKey(line))
    return first?.replace(/^#+\s*/, '').replace(/^#\s*/, '').slice(0, 80) || ''
  }

  private hashText(text: string) {
    let hash = 2166136261
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
  }

  private extractPlanTodos(sections: Record<string, string>): AgentPlanTodo[] {
    const source = [sections['key changes'], sections['public interfaces'], sections['test plan']]
      .filter(Boolean)
      .join('\n')
    const lines = source.split(/\r?\n/)
      .map(line => line.trim().replace(/^[-*]\s+/, '').replace(/^\d+[.)]\s+/, ''))
      .filter(line => this.lineLooksExecutableTodo(line))
    const seen = new Set<string>()
    return lines.slice(0, 18).flatMap(line => {
      const text = line.replace(/\s+/g, ' ').slice(0, 160)
      if (seen.has(text)) return []
      seen.add(text)
      return [{ text, status: 'pending', source: /test|验证|测试/i.test(text) ? 'test' : 'plan' }]
    })
  }

  private lineLooksExecutableTodo(line: string) {
    const text = line.trim()
    if (!text || /^`{3}/.test(text) || text.length < 8 || text.length > 180) return false
    if (/^[一二三四五六七八九十]+、/.test(text)) return false
    if (/^(当前|下面是|代码里已经|如果你愿意|例如|如有|是否|为什么|怎么|如何|可优化点|问题|结论)/.test(text)) return false
    if (/[？?]$/.test(text)) return false
    if (/^(支持|当前|是否|“|")/.test(text) && !/(新增|修改|实现|修复|调整|改造|接入|补齐|验证|测试|删除|替换)/.test(text)) return false
    return /(新增|修改|实现|修复|调整|改造|接入|补齐|完善|优化|重构|删除|替换|验证|测试|运行|更新|迁移|拆分|抽取|统一|渲染|持久化|build|implement|update|fix|refactor|test)/i.test(text)
  }

  private renderAgentPlanCard(plan: AgentApprovedPlan) {
    const sections = this.extractPlanSections(plan.content)
    const todos = plan.todos?.length ? plan.todos : this.extractPlanTodos(sections)
    const summary = sections.summary || plan.content.slice(0, 600)
    const executionReady = plan.executionReady !== false && this.planLooksExecutionReady(plan.content, todos)
    const renderSection = (title: string, content?: string) => content?.trim()
      ? `<section><h4>${escapeHtml(title)}</h4>${this.renderRichText(content)}</section>`
      : ''
    return `
      <article class="agent-plan-card" data-plan-id="${escapeHtml(plan.id)}">
        <header>
          <div>
            <span>${executionReady ? '规划模式' : '分析规划'}</span>
            <strong>${escapeHtml(plan.title || (executionReady ? '已确认实施计划' : '规划分析报告'))}</strong>
          </div>
        </header>
        <div class="agent-plan-meta">
          <span>${escapeHtml(plan.planFilePath ? `计划文件 ${plan.planFilePath}` : '计划文件保存中')}</span>
          <span>${escapeHtml(executionReady ? '可按计划连续开发' : '分析/建议类结果，需先转成开发计划')}</span>
        </div>
        ${renderSection('Summary（摘要）', summary)}
        ${renderSection('Key Changes（关键改动）', sections['key changes'])}
        ${sections['public interfaces'] ? renderSection('Public Interfaces（公共接口）', sections['public interfaces']) : ''}
        ${todos.length ? `
          <section>
            <h4>任务清单</h4>
            <ol class="agent-plan-todos">
              ${todos.slice(0, 12).map(item => `<li class="${escapeHtml(String(item.status || 'pending'))}"><span></span>${escapeHtml(item.text)}</li>`).join('')}
            </ol>
          </section>
        ` : ''}
        ${renderSection('Test Plan（测试计划）', sections['test plan'])}
        ${renderSection('Assumptions（假设）', sections.assumptions)}
        <footer class="message-action-bar plan-actions">
          <button class="${executionReady ? 'primary-button' : 'secondary-button'}" data-start-build-plan="${escapeHtml(plan.id)}">${executionReady ? '按此计划开发' : '转成开发计划'}</button>
        </footer>
      </article>
    `
  }

  private captureApprovedPlanFromLatestAssistant() {
    if (String(this.state.agentRuntime.profileId || '').toLowerCase() !== 'plan') return
    const message = [...this.state.chat].reverse().find(item => item.role === 'assistant' && item.text.trim())
    if (!message) return
    const hasQuestion = Boolean(message.toolCalls?.some(call => call.name === 'question'))
    if (!this.canRenderFinalPlanCard()) {
      this.markRequest('ok', '仍有规划问题待确认', '用户自由输入提出了新问题或新约束，需要继续问题卡确认后再生成计划。')
      return
    }
    if (!(this.state.agentRuntime.planningAnswers || []).length) {
      if (!hasQuestion) void this.repairInvalidPlanOutput(message, '本轮没有先用问题卡确认开发目标')
      return
    }
    const plan = message.plan || this.detectAgentPlanFromText(this.repairMojibakeText(message.text), message.id, message.at, false, this.state.agentRuntime.planningAnswers || [])
    if (!plan) {
      void this.repairInvalidPlanOutput(message, '本轮没有输出完整开发计划')
      return
    }
    if (!this.planHasStrictStructure(plan.content)) {
      void this.repairInvalidPlanOutput(message, '开发计划缺少 Summary（摘要）/ Key Changes（关键改动）/ Public Interfaces（公共接口）/ Test Plan（测试计划）/ Assumptions（假设）固定结构')
      return
    }
    message.plan = plan
    this.state.agentRuntime.approvedPlan = plan
    this.state.agentRuntime.planTodos = plan.todos || []
    this.state.agentRuntime.planningConfirmation = {
      ...(this.state.agentRuntime.planningConfirmation || { status: 'idle', answers: [], openQuestions: [], confirmedRequirements: [] }),
      status: 'plan_generated',
      answers: this.state.agentRuntime.planningAnswers || [],
      openQuestions: [],
      confirmedRequirements: this.extractConfirmedRequirementsForPlan(plan),
    }
    if (plan.executionReady !== false) this.schedulePlanTodoWrite(plan)
    void this.saveApprovedPlanFile(plan, message.id)
  }

  private async repairInvalidPlanOutput(message: AppState['chat'][number], reason: string) {
    if ((message as any).planRepairAttempted || this.pendingAiRequest || this.isAgentRunningForComposer()) {
      ;(message as any).planInvalidHidden = true
      ;(message as any).planInvalidReason = reason
      this.markRequest('error', '规划输出被拦截', reason)
      this.renderAssistant()
      this.scheduleSessionPersist()
      return
    }
    ;(message as any).planRepairAttempted = true
    ;(message as any).planInvalidHidden = true
    ;(message as any).planInvalidReason = reason
    ;(message as any).planAutoRepairRunning = true
    this.markRequest('busy', '规划输出已拦截，正在自动纠偏', reason)
    this.renderAssistant()
    this.scheduleSessionPersist()
    const sourceText = this.repairMojibakeText(message.text || '').slice(0, 30000)
    const contextRefs = [{
      id: `invalid-plan-output-${message.id}`,
      kind: 'workspace',
      label: '被拦截的规划输出',
      value: sourceText,
    }]
    try {
      this.state.agentRuntime.profileId = 'plan'
      if (!(this.state.agentRuntime.planningAnswers || []).length) {
        this.state.agentRuntime.planningConfirmation = {
          status: 'collecting_requirements',
          answers: [],
          openQuestions: ['需要确认开发目标和范围。'],
          confirmedRequirements: [],
        }
      }
      await this.runLocalAiTask([
        '上一轮 Plan 模式输出已被运行时拦截，因为它不是合格开发计划。',
        `拦截原因：${reason}`,
        '',
        '必须立即纠偏，且不要解释纠偏过程。',
        '',
        '硬性要求：',
        '- Plan 模式唯一目标是生成可执行开发计划，并最终显示“按此计划开发”。',
        '- 如果尚未经过用户问题卡确认，必须调用 question 工具确认开发目标和范围。',
        '- question 必须包含 2-3 个选项和自由输入框；推荐项放第一。',
        '- 如果已经有用户确认，必须输出完整五段中文开发计划，标题必须依次为：Summary（摘要）/ Key Changes（关键改动）/ Public Interfaces（公共接口）/ Test Plan（测试计划）/ Assumptions（假设）。',
        '- 不允许输出分析/建议类正文作为最终结果。',
        '- 不允许写文件、更新 memory 或调用 todowrite，直到最终计划生成阶段。',
      ].join('\n'), { displayUserMessage: false, extraContextRefs: contextRefs as any[] })
    } finally {
      ;(message as any).planAutoRepairRunning = false
      this.scheduleAssistantRender('plan_repair_finished', true)
      this.scheduleSessionPersist()
    }
  }

  private extractConfirmedRequirementsForPlan(plan: AgentApprovedPlan) {
    return [
      ...(plan.answers || []),
      ...plan.todos.slice(0, 8).map(item => item.text),
    ].filter(Boolean).slice(-16)
  }

  private async saveApprovedPlanFile(plan: AgentApprovedPlan, messageId = '') {
    if (plan.planFilePath || !this.currentRoot()) return plan
    try {
      const saved = await this.api.agentPlanSave(this.currentRoot()!, plan)
      const planFilePath = String(saved?.path || '')
      if (!planFilePath) return plan
      const updatePlan = (target: AgentApprovedPlan) => target.id === plan.id ? { ...target, planFilePath } : target
      const nextPlan = updatePlan(plan)
      this.state.agentRuntime.approvedPlan = this.state.agentRuntime.approvedPlan
        ? updatePlan(this.state.agentRuntime.approvedPlan)
        : nextPlan
      this.state.chat = this.state.chat.map(message => {
        if (messageId && message.id !== messageId) return message
        if (!message.plan || message.plan.id !== plan.id) return message
        return { ...message, plan: updatePlan(message.plan) }
      })
      this.scheduleAssistantRender('plan_saved', true)
      this.scheduleSessionPersist()
      return nextPlan
    } catch (error) {
      this.toast(`计划文件保存失败：${String(error)}`, 'error')
      return plan
    }
  }

  private schedulePlanTodoWrite(plan: AgentApprovedPlan) {
    if (!plan.todos?.length) return
    const existing = [...this.state.agentRuntime.timeline].reverse().find(call => call.name === 'todowrite')
    const existingItems = (existing?.output as any)?.items || (existing?.input as any)?.items
    if (Array.isArray(existingItems) && existingItems.length) return
    const now = new Date().toISOString()
    this.state.agentRuntime.timeline.push({
      id: `tool-plan-todowrite-${Date.now()}`,
      name: 'todowrite',
      status: 'ok',
      input: { items: plan.todos },
      output: { items: plan.todos, summary: 'planning todo ready' },
      startedAt: now,
      finishedAt: now,
    })
    this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.slice(-80)
  }

  private renderMessageAttachments(attachments: Attachment[]) {
    if (!attachments.length) return ''
    return `
      <div class="message-attachments">
        ${attachments.map(item => {
          const isImage = item.kind === 'image' || String(item.mime || '').startsWith('image/')
          const preview = item.preview || item.dataUrl || ''
          const note = item.note || (isImage && !item.dataUrl ? '当前渠道未读取图片内容，仅保留附件记录。' : '')
          const previewSrc = preview || ''
          const previewText = item.text || ''
          return `
            <article class="message-attachment-card ${isImage ? 'image' : 'file'}" ${previewSrc || previewText ? `data-attachment-preview-src="${escapeHtml(previewSrc)}" data-attachment-preview-title="${escapeHtml(item.name)}" data-attachment-preview-text="${escapeHtml(previewText)}" data-attachment-preview-note="${escapeHtml(note)}"` : ''}>
              ${isImage && preview ? `<img src="${escapeHtml(preview)}" alt="" />` : '<div class="attachment-icon">FILE</div>'}
              <div>
                <strong>${escapeHtml(item.name)}</strong>
                <span>${escapeHtml(item.mime || item.kind)}${item.size ? ` · ${bytesLabel(item.size)}` : ''}${item.readable ? ' · 已进入请求上下文' : ' · 仅记录'}</span>
                ${item.text ? `<pre>${escapeHtml(item.text.slice(0, 1200))}${item.text.length > 1200 ? '\n...' : ''}</pre>` : ''}
                ${note ? `<small>${escapeHtml(note)}</small>` : ''}
              </div>
            </article>
          `
        }).join('')}
      </div>
    `
  }

  private showAttachmentPreview(src: string, title: string, text = '', note = '') {
    this.hideAttachmentPreview()
    const overlay = document.createElement('div')
    overlay.className = 'attachment-preview-overlay'
    overlay.innerHTML = `
      <div class="attachment-preview-dialog">
        <header>
          <strong>${escapeHtml(title || '附件预览')}</strong>
          <button class="icon-button" data-attachment-preview-close="1">×</button>
        </header>
        <div class="attachment-preview-body">
          ${src ? `<img src="${escapeHtml(src)}" alt="" />` : ''}
          ${text ? `<pre>${escapeHtml(text.slice(0, 20000))}${text.length > 20000 ? '\n...' : ''}</pre>` : ''}
          ${note ? `<small>${escapeHtml(note)}</small>` : ''}
        </div>
      </div>
    `
    overlay.addEventListener('click', event => {
      const clickTarget = event.target as HTMLElement
      if (clickTarget === overlay || clickTarget.closest('[data-attachment-preview-close]')) this.hideAttachmentPreview()
    })
    document.body.appendChild(overlay)
  }

  private hideAttachmentPreview() {
    document.querySelector('.attachment-preview-overlay')?.remove()
  }

  private renderMessageReasoning(reasoning: string, compactedSummary?: unknown, message?: AppState['chat'][number]) {
    const compactSummary = compactedSummary
      ? String((compactedSummary as any)?.summary || this.safeJsonPreview(compactedSummary, 3000)).slice(0, 3000)
      : ''
    const visibleReasoning = reasoning && !this.isMostlyEnglish(reasoning)
      ? this.repairMojibakeText(reasoning.slice(-3000))
      : this.chineseTurnSummary(message)
    return `
      <section class="message-agent-block">
        ${visibleReasoning ? `
          <details class="thinking-summary">
            <summary><strong>思考摘要</strong><span>中文执行摘要，原始调试信息不占用聊天区</span></summary>
            <pre>${escapeHtml(visibleReasoning)}</pre>
          </details>
        ` : ''}
        ${compactSummary ? `
          <details class="thinking-summary">
            <summary><strong>上下文压缩</strong><span>${escapeHtml(String((compactedSummary as any)?.reason || '长任务继续'))}</span></summary>
            <pre>${escapeHtml(compactSummary)}</pre>
          </details>
        ` : ''}
      </section>
    `
  }

  private renderMessagePermissions(items: PermissionRequest[]) {
    const patchIds = new Set(this.state.agentRuntime.patchPreviews.map(item => item.id))
    const visible = items.filter(item => !patchIds.has(item.id))
    if (!visible.length) return ''
    return `
      <section class="message-permissions">
        <header><strong>等待用户确认</strong><span>${visible.length} 个操作需要审批</span></header>
        ${visible.slice(-4).map(item => `
          <div class="permission-card ${escapeHtml(item.risk)}">
            <div><strong>${escapeHtml(this.permissionKindLabel(item.kind))}</strong><span>${escapeHtml(this.riskLabel(item.risk))}</span></div>
            <p>${escapeHtml(item.reason)}</p>
            <small>${escapeHtml(item.target)}</small>
            <footer class="message-action-bar permission-actions">
              <button data-agent-approve="${escapeHtml(item.id)}" data-agent-decision="once">允许一次</button>
              <button data-agent-approve="${escapeHtml(item.id)}" data-agent-decision="session">本会话允许</button>
              <button data-agent-approve="${escapeHtml(item.id)}" data-agent-decision="project">项目允许</button>
              <button data-agent-deny="${escapeHtml(item.id)}" data-agent-decision="deny">拒绝</button>
              <button data-agent-deny="${escapeHtml(item.id)}" data-agent-decision="remember">拒绝并记住</button>
            </footer>
          </div>
        `).join('')}
      </section>
    `
  }

  private renderMessagePatchPreviews(items: PatchPreview[]) {
    return `
      <section class="message-patches">
        <header><strong>Patch 预览</strong><span>${items.length} 个变更草案</span></header>
        ${items.slice(-3).map(item => {
          const pendingPermission = this.state.agentRuntime.pendingPermissions.some(permission => permission.id === item.id)
            || this.state.chat.some(message => message.pendingPermissions?.some(permission => permission.id === item.id))
          const buttonLabel = item.kind === 'memory'
            ? '应用 Memory 更新'
            : pendingPermission
              ? '批准并应用'
              : '应用 patch'
          const diagnostics = Array.isArray(item.diagnostics) ? item.diagnostics : []
          const patchKind = item.patchKind || (item.patch.includes('*** Begin Patch') ? 'codex' : 'unified')
          return `
          <details class="patch-preview" ${item.requiresApproval ? 'open' : ''}>
            <summary>${escapeHtml(item.kind === 'memory' ? 'Memory 更新' : 'Patch 预览')} · ${escapeHtml(item.summary || this.patchSummary(item.patch))}</summary>
            <div class="patch-meta">
              <span>${escapeHtml(patchKind === 'codex' ? '结构化 Patch' : 'Unified Diff')}</span>
              <span>${escapeHtml(this.patchSummary(item.patch))}</span>
              <span>${diagnostics.length ? `${diagnostics.length} 条诊断` : '预检通过'}</span>
            </div>
            ${diagnostics.length ? `<pre class="patch-diagnostics">${escapeHtml(diagnostics.map(item => typeof item === 'string' ? item : this.safeJsonPreview(item, 1200)).join('\n'))}</pre>` : ''}
            <pre>${escapeHtml(item.patch.slice(0, 12000))}</pre>
            <footer class="message-action-bar patch-actions">
              ${pendingPermission ? '<small class="patch-apply-hint">将通过权限审批落盘，并让 Agent 继续执行。</small>' : '<span></span>'}
              <button class="primary-button" data-apply-patch="${escapeHtml(`patch:${item.id}`)}">${buttonLabel}</button>
            </footer>
          </details>
        `}).join('')}
      </section>
    `
  }

  private permissionKindLabel(kind: string) {
    if (kind === 'command') return '执行命令'
    if (kind === 'tool') return '调用工具'
    if (kind === 'write') return '写入文件'
    if (kind === 'read') return '读取文件'
    return kind || '工具操作'
  }

  private renderMessageToolCalls(calls: ToolCallRecord[]) {
    const unique = calls.filter((call, index, list) => list.findIndex(item => item.id === call.id) === index)
    const questions = unique.filter(call => call.name === 'question')
    const toolCalls = this.normalizeToolTraceForRender(unique.filter(call => call.name !== 'question'))
    const running = toolCalls.some(call => call.status === 'running')
    const approval = toolCalls.some(call => call.status === 'approval_required')
    const failed = toolCalls.filter(call => call.status === 'error').length
    const title = running ? '正在调用工具' : approval ? '等待工具授权' : '本轮工具调用'
    const detail = `${toolCalls.length} 个工具${failed ? ` · ${failed} 个失败` : ''}`
    const groupId = `tools-${toolCalls[0]?.id || unique[0]?.id || 'active'}`
    const groupOpen = !this.collapsedToolGroupIds.has(groupId)
    const questionCards = questions.length ? this.renderAgentQuestionCards(questions) : ''
    const toolCards = toolCalls.length ? `
      <details class="message-tools ${running ? 'running' : ''}" data-tool-group-id="${escapeHtml(groupId)}" ${groupOpen ? 'open' : ''}>
        <summary><header><strong>${title}</strong><span>${detail}</span></header></summary>
        ${this.renderToolTrace(toolCalls)}
      </details>
    ` : ''
    return `${questionCards}${toolCards}`
  }

  private renderAgentQuestionCards(calls: ToolCallRecord[]) {
    return `
      <section class="message-questions">
        ${calls.slice(-3).map(call => this.renderAgentQuestionCard(call)).join('')}
      </section>
    `
  }

  private renderAgentQuestionCard(call: ToolCallRecord) {
    const input = call.input as any
    const output = call.output as any
    const question = this.repairMojibakeText(String(output?.question || input?.question || input?.prompt || '需要你补充信息后继续。'))
    const answered = Boolean(output?.answered)
    const answer = this.repairMojibakeText(String(output?.answer || ''))
    const options = this.agentQuestionOptions(question, output?.options || input?.options)
    const placeholder = String(output?.placeholder || input?.placeholder || '输入补充说明、路径或选择范围...')
    return `
      <article class="agent-question-card ${answered ? 'answered' : 'waiting'}">
        <header>
          <span class="question-icon">?</span>
          <div>
            <strong>${answered ? '已回答 Agent 问题' : 'Agent 需要你决定'}</strong>
            <small>${answered ? '回答已提交，Agent 会基于它继续' : '选择一个选项，或在下方补充具体路径/要求'}</small>
          </div>
        </header>
        <p>${escapeHtml(question)}</p>
        ${answered ? `<div class="question-answer"><span>你的回答</span><strong>${escapeHtml(answer || '已提交')}</strong></div>` : `
          <footer class="message-action-bar question-actions">
            ${options.length ? `
              <div class="question-options">
                ${options.map(option => `
                  <button
                    class="${escapeHtml(option.kind || '')}"
                    data-agent-question-id="${escapeHtml(call.id)}"
                    data-agent-question-answer="${escapeHtml(encodeURIComponent(option.value))}"
                  >${escapeHtml(option.label)}</button>
                `).join('')}
              </div>
            ` : '<span></span>'}
            <div class="question-freeform">
              <input data-agent-question-input="${escapeHtml(call.id)}" placeholder="${escapeHtml(placeholder)}" />
              <button class="primary-button" data-agent-question-submit="${escapeHtml(call.id)}">提交回答</button>
            </div>
          </footer>
        `}
      </article>
    `
  }

  private agentQuestionOptions(question: string, rawOptions: unknown) {
    const seen = new Set<string>()
    const options: Array<{ label: string; value: string; kind: string }> = []
    const push = (label: string, value: string, kind = 'normal') => {
      const cleanValue = value.trim()
      if (!cleanValue || seen.has(cleanValue)) return
      seen.add(cleanValue)
      options.push({ label, value: cleanValue, kind })
    }
    if (Array.isArray(rawOptions)) {
      for (const item of rawOptions) {
        if (typeof item === 'string') push(item, item)
        else if (item && typeof item === 'object') {
          const value = String((item as any).value || (item as any).label || '').trim()
          const label = String((item as any).label || value).trim()
          push(label, value, String((item as any).kind || 'normal'))
        }
      }
    }
    const backtickPaths = [...question.matchAll(/`([^`]+)`/g)]
      .map(match => match[1].trim())
      .filter(value => value.includes('/') || value.includes('\\') || value.includes('.'))
    if (/全项目|整个项目|whole project|workspace/i.test(question)) push('允许全项目', '允许全项目', 'scope')
    for (const path of backtickPaths.slice(0, 4)) push(`按 ${path} 继续`, `${path} 目录`, 'scope')
    if (/是否|允许|确认|approve/i.test(question)) {
      push('允许继续', '允许', 'allow')
      push('不允许', '不允许', 'deny')
    }
    return options.slice(0, 6)
  }

  private renderRichText(text: string) {
    const raw = text.trim()
    if (!raw) return ''
    const autocodeBlocks = this.parseAutocodeBlocks(raw)
    if (autocodeBlocks.length) return autocodeBlocks.map(block => this.renderChatBlock(block)).join('')
    if (/<(?:section|article|div|pre|code|h[1-6]|p|ul|ol|table|details|blockquote|hr|dl)\b/i.test(raw)) {
      return `<div class="chat-html">${this.sanitizeHtml(raw)}</div>`
    }
    return this.renderMarkdownWithDetectedCode(text)
  }

  private parseAutocodeBlocks(text: string): RenderedChatBlock[] {
    const pattern = /:::autocode\s+([^\n]+)\n([\s\S]*?)\n:::/g
    const blocks: RenderedChatBlock[] = []
    let cursor = 0
    for (const match of text.matchAll(pattern)) {
      const start = match.index || 0
      if (start > cursor) blocks.push(...this.parseMarkdownBlocks(text.slice(cursor, start)))
      const attrs = this.parseAutocodeBlockAttrs(match[1] || '')
      blocks.push({
        kind: attrs.type === 'diagram' ? 'diagram' : 'autocode',
        blockType: attrs.type || 'summary',
        title: attrs.title || this.autocodeBlockTitle(attrs.type || 'summary'),
        content: match[2] || '',
        diagramType: attrs.diagram || 'mermaid',
      } as RenderedChatBlock)
      cursor = start + match[0].length
    }
    if (cursor < text.length) blocks.push(...this.parseMarkdownBlocks(text.slice(cursor)))
    return blocks.length && cursor > 0 ? blocks : []
  }

  private parseAutocodeBlockAttrs(raw: string) {
    const attrs: Record<string, string> = {}
    raw.replace(/([a-zA-Z_-]+)=("[^"]*"|'[^']*'|\S+)/g, (_match, key, value) => {
      attrs[key] = String(value || '').replace(/^['"]|['"]$/g, '')
      return ''
    })
    if (!attrs.type && raw.trim()) attrs.type = raw.trim().split(/\s+/)[0]
    return attrs
  }

  private autocodeBlockTitle(type: string) {
    const labels: Record<string, string> = {
      summary: '摘要',
      priorityList: '优先级',
      fileList: '涉及文件',
      steps: '执行步骤',
      checkResult: '验证结果',
      warning: '注意事项',
      code: '代码',
      table: '表格',
      diagram: '流程图',
    }
    return labels[type] || '说明'
  }

  private renderChatBlock(block: RenderedChatBlock) {
    if (block.kind === 'code') return this.renderCodeBlock(block.content, block.language || 'text', 'detected')
    if (block.kind === 'diagram') return this.renderMermaidBlock(block.content, block.diagramType || 'mermaid')
    if (block.kind === 'autocode') {
      const tone = /warning|risk|注意|风险/i.test(block.blockType) ? 'warning' : /check|done|验证|完成/i.test(block.blockType) ? 'success' : ''
      return `
        <section class="chat-structured-card ${escapeHtml(tone)}">
          <header><strong>${escapeHtml(block.title || this.autocodeBlockTitle(block.blockType))}</strong></header>
          <div>${this.renderMarkdownWithDetectedCode(block.content)}</div>
        </section>
      `
    }
    return `<div class="chat-markdown">${this.renderInlineMarkdown(block.content)}</div>`
  }

  private sanitizeHtml(html: string) {
    const template = document.createElement('template')
    template.innerHTML = html
    const allowed = new Set(['SECTION', 'ARTICLE', 'DIV', 'SPAN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD', 'CODE', 'PRE', 'STRONG', 'EM', 'B', 'I', 'BR', 'HR', 'DETAILS', 'SUMMARY', 'BLOCKQUOTE', 'DL', 'DT', 'DD', 'A'])
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT)
    const elements: Element[] = []
    let node = walker.nextNode()
    while (node) { elements.push(node as Element); node = walker.nextNode() }
    for (const element of elements) {
      if (!allowed.has(element.tagName)) {
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED'].includes(element.tagName)) element.remove()
        else element.replaceWith(...Array.from(element.childNodes))
        continue
      }
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase()
        const value = attribute.value
        if (name.startsWith('on') || name === 'style' || (name === 'href' && !/^(https?:|mailto:|#)/i.test(value))) element.removeAttribute(attribute.name)
      }
      if (element.tagName === 'A') { element.setAttribute('target', '_blank'); element.setAttribute('rel', 'noreferrer') }
    }
    return template.innerHTML
  }

  private renderMarkdownWithDetectedCode(text: string) {
    const markdownBlocks = this.parseMarkdownBlocks(text)
    if (!markdownBlocks.length) return ''
    if (markdownBlocks.length === 1 && markdownBlocks[0].kind === 'text') {
      return this.renderMarkdownTextBlock(markdownBlocks[0].content)
    }
    return markdownBlocks.map(block => {
      if (block.kind === 'text') return this.renderMarkdownTextBlock(block.content)
      if (block.kind === 'diagram') return this.renderMermaidBlock(block.content, block.diagramType || 'mermaid')
      return this.renderCodeBlock(block.content, block.language || 'text', 'detected')
    }).join('')
  }

  private parseMarkdownBlocks(text: string): RenderedChatBlock[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const blocks: RenderedChatBlock[] = []
    let textBuffer: string[] = []
    let codeBuffer: string[] = []
    const flushText = () => {
      if (!textBuffer.length) return
      blocks.push({ kind: 'text', content: textBuffer.join('\n') })
      textBuffer = []
    }
    const flushCode = () => {
      if (!codeBuffer.length) return
      const content = codeBuffer.join('\n')
      const language = this.guessInlineCodeLanguage(content)
      blocks.push(this.shouldRenderDetectedCodeBlock(codeBuffer)
        ? { kind: 'code', content, language }
        : { kind: 'text', content })
      codeBuffer = []
    }
    for (const line of lines) {
      const codeLike = this.isLikelyCodeLine(line)
      if (codeLike) {
        flushText()
        codeBuffer.push(line)
      } else {
        flushCode()
        textBuffer.push(line)
      }
    }
    flushCode()
    flushText()
    return blocks
  }

  private renderMarkdownTextBlock(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return ''
    const sections = this.splitMarkdownSections(trimmed)
    if (sections.length <= 1 && !this.shouldCardMarkdownText(trimmed)) {
      return `<div class="chat-markdown">${this.renderMarkdownBody(text)}</div>`
    }
    return sections.map(section => `
      <section class="chat-structured-card ${escapeHtml(section.tone)}">
        ${section.title ? `<header><strong>${escapeHtml(section.title)}</strong></header>` : ''}
        <div class="chat-markdown">${this.renderMarkdownBody(section.body || section.title || '')}</div>
      </section>
    `).join('')
  }

  private renderMarkdownBody(text: string) {
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const chunks: string[] = []
    let buffer: string[] = []
    const flushText = () => {
      if (!buffer.length) return
      chunks.push(this.renderInlineMarkdown(buffer.join('\n')))
      buffer = []
    }
    for (let index = 0; index < lines.length; index += 1) {
      if (this.isMarkdownTableStart(lines, index)) {
        flushText()
        const tableLines = [lines[index], lines[index + 1]]
        index += 2
        while (index < lines.length && this.isMarkdownTableRow(lines[index])) {
          tableLines.push(lines[index])
          index += 1
        }
        index -= 1
        chunks.push(this.renderMarkdownTable(tableLines))
      } else {
        buffer.push(lines[index])
      }
    }
    flushText()
    return chunks.join('')
  }

  private isMarkdownTableStart(lines: string[], index: number) {
    return this.isMarkdownTableRow(lines[index] || '') && this.isMarkdownTableSeparator(lines[index + 1] || '')
  }

  private isMarkdownTableRow(line: string) {
    const trimmed = line.trim()
    return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed)
  }

  private isMarkdownTableSeparator(line: string) {
    const trimmed = line.trim()
    if (!trimmed.includes('|')) return false
    const cells = this.parseMarkdownTableCells(trimmed)
    return cells.length >= 2 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
  }

  private parseMarkdownTableCells(line: string) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
  }

  private renderMarkdownTable(lines: string[]) {
    const header = this.parseMarkdownTableCells(lines[0] || '')
    const rows = lines.slice(2).map(line => this.parseMarkdownTableCells(line)).filter(row => row.length)
    if (header.length < 2) return this.renderInlineMarkdown(lines.join('\n'))
    return `
      <div class="chat-table-wrap">
        <table class="chat-table">
          <thead><tr>${header.map(cell => `<th>${this.renderInlineMarkdown(cell)}</th>`).join('')}</tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr>${header.map((_cell, index) => `<td>${this.renderInlineMarkdown(row[index] || '')}</td>`).join('')}</tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
  }

  private splitMarkdownSections(text: string) {
    const lines = text.split('\n')
    const sections: Array<{ title: string; body: string; tone: string }> = []
    let current: { title: string; body: string[]; tone: string } | null = null
    const flush = () => {
      if (!current) return
      sections.push({ title: current.title, body: current.body.join('\n').trim(), tone: current.tone })
      current = null
    }
    for (const line of lines) {
      const heading = line.match(/^(?:#{1,4}\s+|\*\*)?([^\n*：:]{2,32}(?:优先级|问题|风险|文件|验证|结果|完成|建议|步骤|改动|摘要|说明)[^：:\n*]*)(?:\*\*)?[：:]?\s*$/)
      if (heading) {
        flush()
        const title = heading[1].trim()
        current = { title, body: [], tone: this.sectionTone(title) }
      } else {
        if (!current) current = { title: '', body: [], tone: '' }
        current.body.push(line)
      }
    }
    flush()
    return sections.filter(section => section.title || section.body)
  }

  private shouldCardMarkdownText(text: string) {
    const lines = text.split('\n').filter(line => line.trim())
    if (lines.length >= 8) return true
    return /(?:高优先级|中优先级|低优先级|严重|风险|验证结果|改动文件|涉及文件)/.test(text)
  }

  private sectionTone(title: string) {
    if (/高优先级|严重|失败|风险|错误|注意/.test(title)) return 'warning'
    if (/完成|成功|验证|通过/.test(title)) return 'success'
    if (/文件|改动|路径/.test(title)) return 'files'
    return ''
  }

  private renderCodeBlock(code: string, lang: string, extraClass = '') {
    const language = lang || 'text'
    return `
      <figure class="chat-code-block ${escapeHtml(extraClass)}">
        <figcaption><span>${escapeHtml(language)}</span><button data-copy-near-code="1">复制</button></figcaption>
        <pre><code>${this.highlightCode(code, language)}</code></pre>
      </figure>
    `
  }

  private renderMermaidBlock(source: string, diagramType = 'mermaid') {
    const id = `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const escapedSource = escapeHtml(source.trim())
    window.setTimeout(() => this.renderPendingMermaidDiagrams(), 0)
    return `
      <figure class="chat-diagram-block" data-mermaid-block="${escapeHtml(id)}">
        <figcaption><span>${escapeHtml(diagramType || 'mermaid')}</span><button data-copy-near-code="1">复制</button></figcaption>
        <div class="chat-diagram-canvas" data-mermaid-source="${escapedSource}" data-mermaid-id="${escapeHtml(id)}">
          <pre><code>${escapedSource}</code></pre>
        </div>
      </figure>
    `
  }

  private async loadMermaid() {
    if (this.mermaidModule) return this.mermaidModule
    if (!this.mermaidLoading) {
      this.mermaidLoading = import('mermaid').then(module => {
        const mermaid = (module as any).default || module
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: this.state.theme === 'light' ? 'default' : 'dark',
        })
        this.mermaidModule = mermaid
        return mermaid
      })
    }
    return this.mermaidLoading
  }

  private async renderPendingMermaidDiagrams(root: ParentNode = document) {
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-mermaid-source]:not([data-mermaid-rendered])'))
    if (!nodes.length) return
    let mermaid: any
    try {
      mermaid = await this.loadMermaid()
    } catch (error) {
      nodes.forEach(node => {
        node.dataset.mermaidRendered = 'error'
        node.classList.add('error')
      })
      console.warn('[AutoCode] mermaid load failed', error)
      return
    }
    for (const node of nodes) {
      const source = this.htmlEntityDecode(node.dataset.mermaidSource || '').trim()
      const id = node.dataset.mermaidId || `mermaid-${Date.now()}`
      if (!source) continue
      node.dataset.mermaidRendered = 'pending'
      try {
        const rendered = await mermaid.render(id, source)
        node.innerHTML = rendered.svg || ''
        node.dataset.mermaidRendered = 'ok'
      } catch (error) {
        node.dataset.mermaidRendered = 'error'
        node.classList.add('error')
        node.innerHTML = `<pre><code>${escapeHtml(source)}</code></pre><small>流程图渲染失败，已保留 Mermaid 源码：${escapeHtml(String(error))}</small>`
      }
    }
  }

  private isLikelyCodeLine(line: string) {
    const trimmed = line.trim()
    if (!trimmed) return false
    if (this.isMarkdownNarrativeLine(trimmed)) return false
    const hasCjk = /[\u4e00-\u9fa5]/.test(trimmed)
    if (/^[A-Za-z]:\\[^>]+>/.test(trimmed)) return true
    if (/^(?:\$|>|PS [A-Za-z]:\\|[A-Za-z]:\\.*>)\s*/.test(trimmed)) return true
    if (/^(?:python|py|pip|npm|pnpm|yarn|node|npx|cargo|git|cd|dir|tree|pytest|uvicorn|gradio|java|go|rustc)\s+\S+/i.test(trimmed)) return true
    if (/^(?:diff --git|index [0-9a-f]+(?:\.\.)?|@@\s|---\s|--- a\/|\+\+\+\s|\+\+\+ b\/)/i.test(trimmed)) return true
    if (/^(?:[-*+]\s+|\d+[.)]\s+)?(?:python|py|pip|npm|pnpm|yarn|node|npx|cargo|git|cd|dir|tree|pytest|uvicorn|gradio|java|go|rustc)\s+\S+/i.test(trimmed)) return true
    if (/^(?:Traceback|File \"[^\"]+\", line \d+|[A-Za-z_][\w.]*Error:|TypeError:|RuntimeError:|ValueError:)/.test(trimmed)) return true
    if (hasCjk) return false
    if (/^(?:import|from|def|class|async def|const|let|var|function|export|interface|type|public|private|protected|fn|use|package|for|if|elif|else|try|except|while|return|yield)\b/.test(trimmed)) return true
    if (/^[A-Za-z_][\w.-]*\s*[=:]\s*["'“”][^"'“”]+["'“”]\s*,?$/.test(trimmed)) return true
    if (/^[A-Za-z_][\w.-]*\([^)]*\)\s*(?:->|=>|\{|:|;)?$/.test(trimmed)) return true
    if (/^[A-Za-z_][\w.-]*(?:_[A-Za-z0-9]+)+\s+[A-Za-z0-9_.-]+$/.test(trimmed)) return true
    if (/^[{}\[\]],?$/.test(trimmed)) return true
    if (/^[\w"'.-]+\s*[:=]\s*.+[,;]?$/.test(trimmed) && /[{}()[\]=>"'`]/.test(trimmed)) return true
    if (/^<\/?[A-Za-z][^>]*>$/.test(trimmed)) return true
    return false
  }

  private isMarkdownNarrativeLine(trimmed: string) {
    if (/^#{1,6}\s+/.test(trimmed)) return true
    if (/^(?:[-*+]\s+|\d+[.)]\s+)(?:\*\*|[\u4e00-\u9fa5]|[^`]*[\u4e00-\u9fa5])/.test(trimmed)) return true
    if (/^\d+[.)]\s+/.test(trimmed) && /\*\*.+\*\*/.test(trimmed)) return true
    return false
  }

  private shouldRenderDetectedCodeBlock(lines: string[]) {
    const visible = lines.map(line => line.trim()).filter(Boolean)
    if (!visible.length) return false
    const commandLike = visible.some(line => /^(?:\$|>|PS [A-Za-z]:\\|[A-Za-z]:\\.*>)\s*/.test(line) || /^(?:python|py|pip|npm|pnpm|yarn|node|npx|cargo|git|cd|dir|tree|pytest|uvicorn|gradio|java|go|rustc)\s+\S+/i.test(line))
    const diffLike = visible.some(line => /^(?:diff --git|index [0-9a-f]+(?:\.\.)?|@@\s|---\s|\+\+\+\s)/i.test(line))
    const tracebackLike = visible.some(line => /^(?:Traceback|File \"[^\"]+\", line \d+|[A-Za-z_][\w.]*Error:)/.test(line))
    if (commandLike || diffLike || tracebackLike) return true
    if (visible.length < 2) return false
    if (visible.some(line => /[\u4e00-\u9fa5]/.test(line) && !line.trim().startsWith('#'))) return false
    const codeLines = visible.filter(line => this.isLikelyCodeLine(line)).length
    return codeLines >= 2 && codeLines / visible.length >= 0.6
  }

  private guessInlineCodeLanguage(code: string) {
    const sample = code.trim()
    if (/^[A-Za-z]:\\[^>]+>|^(?:cd|dir|tree)\b/im.test(sample)) return 'bat'
    if (/^(?:npm|pnpm|yarn|node|npx|python|py|pip|pytest|cargo|git|uvicorn|gradio|java|go|rustc)\b/im.test(sample)) return 'bash'
    if (/Traceback|\.py", line|^(?:import|from|def|class)\b/m.test(sample)) return 'python'
    if (/\b(?:const|let|function|interface|export)\b/.test(sample)) return 'typescript'
    if (/^(?:fn|use|let mut)\b/m.test(sample)) return 'rust'
    if (/^<\/?[A-Za-z][^>]*>$/m.test(sample)) return 'html'
    return 'text'
  }

  private renderInlineMarkdown(text: string) {
    const codeTokens: string[] = []
    const fileIndex = this.workspaceFileReferenceIndex()
    const withCodeTokens = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code) => {
      const index = codeTokens.length
      const fileRef = this.renderWorkspaceFileReferenceChip(this.htmlEntityDecode(String(code)), fileIndex)
      codeTokens.push(fileRef || `<code>${code}</code>`)
      return `@@AUTOCODE_CODE_${index}@@`
    })
    return this.renderWorkspaceFileReferences(withCodeTokens, fileIndex)
      .replace(/^### (.*)$/gm, '<h4>$1</h4>')
      .replace(/^## (.*)$/gm, '<h4>$1</h4>')
      .replace(/^# (.*)$/gm, '<h4>$1</h4>')
      .replace(/^(\d+[.)])\s+(.+)$/gm, '<div class="chat-list-line ordered"><span>$1</span><p>$2</p></div>')
      .replace(/^[-*+]\s+(.+)$/gm, '<div class="chat-list-line"><span>•</span><p>$1</p></div>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br />')
      .replace(/@@AUTOCODE_CODE_(\d+)@@/g, (_match, index) => codeTokens[Number(index)] || '')
  }

  private renderWorkspaceFileReferences(html: string, fileIndex = this.workspaceFileReferenceIndex()) {
    const fileTokens: string[] = []
    const emitFileRef = (prefix: string, rawPath: string) => {
      const chip = this.renderWorkspaceFileReferenceChip(rawPath, fileIndex)
      if (!chip) return `${prefix}${rawPath}`
      const index = fileTokens.length
      fileTokens.push(chip)
      return `${prefix}@@AUTOCODE_FILE_${index}@@`
    }
    const pathPattern = /(^|[\s([{"'：:，,;；、>-])((?:[A-Za-z]:[\\/]|\/)?(?:\.autocode|[A-Za-z0-9_.\-\u4e00-\u9fa5]+)(?:[\\/][A-Za-z0-9_.@()[\]\- \u4e00-\u9fa5]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s)\]}"'，,。.;；:：!?！？<])/g
    const bareFilePattern = /(^|[\s([{"'：:，,;；、>-])([A-Za-z0-9_.\-\u4e00-\u9fa5]+\.[A-Za-z0-9]{1,12})(?=$|[\s)\]}"'，,。.;；:：!?！？<])/g
    return html
      .replace(pathPattern, (_match, prefix: string, rawPath: string) => emitFileRef(prefix, rawPath))
      .replace(bareFilePattern, (_match, prefix: string, rawPath: string) => emitFileRef(prefix, rawPath))
      .replace(/@@AUTOCODE_FILE_(\d+)@@/g, (_match, index) => fileTokens[Number(index)] || '')
  }

  private renderWorkspaceFileReferenceChip(rawPath: string, fileIndex = this.workspaceFileReferenceIndex()) {
    const ref = this.resolveWorkspaceFileReference(rawPath, fileIndex)
    if (!ref) return ''
    if (ref.confidence === 'ambiguous-name' && ref.candidates?.length) {
      const candidates = ref.candidates.slice(0, 12)
      const encoded = encodeURIComponent(JSON.stringify(candidates))
      return `<button type="button" class="chat-file-ref ambiguous" data-chat-file-candidates="${escapeHtml(encoded)}" title="找到 ${candidates.length} 个同名文件，点击选择"><span>${escapeHtml(ref.raw)}</span><span class="chat-file-ref-badge">${candidates.length} 处</span></button>`
    }
    const meta = this.fileChangeMeta(ref.normalized)
    const badge = meta.badge ? `<span class="chat-file-ref-badge">${escapeHtml(meta.badge)}</span>` : ''
    return `<button type="button" class="chat-file-ref" data-chat-file-path="${escapeHtml(ref.normalized)}" title="${escapeHtml(`${meta.title} · ${this.fileReferenceConfidenceLabel(ref.confidence)}`)}"><span>${escapeHtml(ref.normalized)}</span>${badge}</button>`
  }

  private resolveWorkspaceFileReference(rawPath: string, index = this.workspaceFileReferenceIndex()): WorkspaceFileReferenceRule | null {
    const raw = this.cleanWorkspaceFileReferenceText(rawPath)
    const normalized = this.resolveWorkspaceMessagePath(raw)
    if (!normalized || this.isBlockedFileReference(normalized)) return null
    if (index.pathSet.has(normalized.toLowerCase())) return { raw, normalized, confidence: 'exact' }
    if (this.workspacePathExists(normalized)) return { raw, normalized, confidence: 'known-path' }
    if (!/[\\/]/.test(normalized) && this.hasFileExtension(normalized)) {
      const matches = this.resolveBareWorkspaceFileName(normalized, index)
      if (matches.length === 1) return { raw, normalized: matches[0].path, confidence: 'unique-name', candidates: matches }
      if (matches.length > 1) return { raw, normalized: matches[0].path, confidence: 'ambiguous-name', candidates: matches }
      return null
    }
    if (/[\\/]/.test(normalized) && this.hasFileExtension(normalized) && this.isPlausibleWorkspacePath(normalized)) {
      return { raw, normalized, confidence: 'plausible-path' }
    }
    return null
  }

  private cleanWorkspaceFileReferenceText(rawPath: string) {
    return this.htmlEntityDecode(String(rawPath || ''))
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/[，,。.;；:：!?！？)\]}]+$/g, '')
      .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, '')
  }

  private isBlockedFileReference(path: string) {
    const normalized = this.normalizeWorkspacePath(path)
    if (!normalized || normalized.includes('://') || normalized.startsWith('http/')) return true
    if (/^(?:node_modules|dist|build|target|\.git)\//.test(normalized)) return true
    if (/\s{2,}/.test(normalized)) return true
    return false
  }

  private hasFileExtension(path: string) {
    return /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(this.normalizeWorkspacePath(path))
  }

  private isPlausibleWorkspacePath(path: string) {
    return /^[A-Za-z0-9_.@()[\]\- \u4e00-\u9fa5]+(?:\/[A-Za-z0-9_.@()[\]\- \u4e00-\u9fa5]+)+\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(this.normalizeWorkspacePath(path))
  }

  private workspaceFileReferenceIndex(): WorkspaceFileReferenceIndex {
    if (this.currentRoot() && this.workspaceFileIndexCache?.root !== this.currentRoot()) {
      void this.refreshWorkspaceFileIndex()
    }
    return this.activeRenderFileReferenceIndex || this.buildWorkspaceFileReferenceIndex()
  }

  private buildWorkspaceFileReferenceIndex(): WorkspaceFileReferenceIndex {
    const gitFiles = this.state.workspace.git?.files || []
    const key = [
      this.currentRoot(),
      this.state.workspace.tabs.map(tab => tab.path).join('|'),
      this.workspaceFileIndexCache?.root || '',
      this.workspaceFileIndexCache?.value.generated_at || '',
      this.workspaceFileIndexCache?.value.files.length || 0,
      gitFiles.length,
      gitFiles[0]?.path || '',
      gitFiles[gitFiles.length - 1]?.path || '',
      this.state.workspace.tree.length,
      this.state.agentRuntime.checkpoints.length,
    ].join('::')
    if (this.fileReferenceIndexCache?.key === key) return this.fileReferenceIndexCache.value
    const maxPaths = 8000
    const maxTreeEntries = 800
    const paths: string[] = []
    const itemsByPath = new Map<string, WorkspaceFileIndexItem>()
    const addPath = (path: string) => {
      if (paths.length >= maxPaths) return
      const normalized = this.normalizeWorkspacePath(path)
      if (normalized) paths.push(normalized)
    }
    const addItem = (item: Partial<WorkspaceFileIndexItem> & { path?: string }) => {
      const normalized = this.normalizeWorkspacePath(String(item.path || ''))
      if (!normalized) return
      addPath(normalized)
      if (!itemsByPath.has(normalized.toLowerCase())) {
        itemsByPath.set(normalized.toLowerCase(), {
          path: normalized,
          name: item.name || basename(normalized),
          parent: item.parent || relativeParent(normalized),
          size: Number(item.size || 0),
          modified_at: String(item.modified_at || ''),
        })
      }
    }
    this.state.workspace.tabs.forEach(tab => addPath(tab.path))
    ;(this.workspaceFileIndexCache?.root === this.currentRoot() ? this.workspaceFileIndexCache.value.files : []).forEach(item => addItem(item))
    ;(this.state.workspace.git?.files || []).forEach(item => addItem({
      path: item.path,
      name: item.name || basename(item.path),
      parent: item.parent || relativeParent(item.path),
    }))
    let visitedTreeEntries = 0
    const addTreePaths = (items: WorkspaceEntry[]) => {
      for (const item of items) {
        if (paths.length >= maxPaths || visitedTreeEntries >= maxTreeEntries) break
        visitedTreeEntries += 1
        if (item.kind === 'file') addPath(item.path)
        else if (item.loaded && item.children?.length) addTreePaths(item.children)
      }
    }
    addTreePaths(this.state.workspace.tree)
    for (const checkpoint of this.state.agentRuntime.checkpoints as any[]) {
      if (paths.length >= maxPaths) break
      if (!Array.isArray(checkpoint?.files)) continue
      for (const file of checkpoint.files) {
        if (paths.length >= maxPaths) break
        addPath(String(file?.path || ''))
      }
    }
    const pathSet = new Set(paths.map(path => path.toLowerCase()))
    const byName = new Map<string, string[]>()
    for (const path of [...new Set(paths)]) {
      const name = basename(path).toLowerCase()
      if (!name) continue
      const bucket = byName.get(name) || []
      bucket.push(path)
      byName.set(name, bucket)
    }
    for (const [name, bucket] of byName) byName.set(name, [...new Set(bucket)])
    const value = { pathSet, byName, itemsByPath }
    this.fileReferenceIndexCache = { key, value }
    return value
  }

  private resolveBareWorkspaceFileName(fileName: string, index = this.workspaceFileReferenceIndex()): WorkspaceFileReferenceCandidate[] {
    const target = this.normalizeWorkspacePath(fileName).toLowerCase()
    if (!target) return []
    const active = this.activeTab()?.path
    if (active && basename(active).toLowerCase() === target) {
      const normalized = this.normalizeWorkspacePath(active)
      return [{ path: normalized, name: basename(normalized), parent: relativeParent(normalized), badge: this.fileChangeMeta(normalized).badge }]
    }
    const unique = index.byName.get(target) || []
    return unique.slice(0, 24).map(path => {
      const item = index.itemsByPath.get(path.toLowerCase())
      return {
        path,
        name: item?.name || basename(path),
        parent: item?.parent || relativeParent(path),
        badge: this.fileChangeMeta(path).badge,
      }
    })
  }

  private fileReferenceConfidenceLabel(confidence: WorkspaceFileReferenceRule['confidence']) {
    if (confidence === 'exact') return '精确路径'
    if (confidence === 'known-path') return '已知项目文件'
    if (confidence === 'unique-name') return '唯一文件名匹配'
    if (confidence === 'ambiguous-name') return '同名文件候选'
    return '路径格式匹配'
  }

  private findChatCode(ref: string) {
    const [messageId, rawIndex] = ref.split(':')
    const message = this.state.chat.find(item => item.id === messageId)
    if (!message) return ''
    const blocks = [...message.text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map(match => match[1])
    return blocks[Number(rawIndex)] || ''
  }

  private async copyChatMessage(messageId: string, button: HTMLElement) {
    const message = this.state.chat.find(item => item.id === messageId)
    if (!message) return
    try {
      await navigator.clipboard.writeText(message.text)
      button.classList.remove('copy-error')
      button.classList.add('copy-ok')
      button.textContent = '已复制'
      window.setTimeout(() => { button.classList.remove('copy-ok'); button.textContent = '复制' }, 1200)
      this.toast('消息已复制', 'ok')
    } catch (error) {
      button.classList.remove('copy-ok')
      button.classList.add('copy-error')
      button.textContent = '复制失败'
      window.setTimeout(() => { button.classList.remove('copy-error'); button.textContent = '复制' }, 1500)
      this.toast(`复制失败：${String(error)}`, 'error')
    }
  }

  private editChatMessage(messageId: string) {
    const message = this.state.chat.find(item => item.id === messageId && item.role === 'user')
    if (!message) return
    if (message.queued && message.queued.status === 'queued') this.cancelQueuedUserMessage(message.queued.id)
    this.composerDraft = message.text
    this.state.attachments = (message.attachments || []).map(item => ({ ...item }))
    this.state.composerMode = 'text'
    this.renderComposer()
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    input?.focus()
    if (input) { input.selectionStart = input.value.length; input.selectionEnd = input.value.length }
    this.toast('消息已放回输入框，可修改后发送', 'ok')
  }

  private async resendChatMessage(messageId: string) {
    const message = this.state.chat.find(item => item.id === messageId && item.role === 'user')
    if (!message) return
    this.composerDraft = message.text
    this.state.attachments = (message.attachments || []).map(item => ({ ...item }))
    this.state.composerMode = 'text'
    this.renderComposer()
    await this.createTask()
  }
  private async copyChatCode(ref: string, button?: HTMLElement) {
    const code = this.findChatCode(ref)
    if (!code) return this.toast('没有可复制的代码块', 'idle')
    try {
      await navigator.clipboard.writeText(code)
      this.setInlineActionFeedback(button, 'ok', '已复制')
      this.toast('代码块已复制', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '复制失败')
      this.toast(`代码块复制失败：${String(error)}`, 'error')
    }
  }

  private async copyNearbyCode(button: HTMLElement) {
    const code = button.closest('figure')?.querySelector('pre')?.textContent || ''
    if (!code) return this.toast('没有可复制的代码块', 'idle')
    try {
      await navigator.clipboard.writeText(code)
      this.setInlineActionFeedback(button, 'ok', '已复制')
      this.toast('代码块已复制', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '复制失败')
      this.toast(`代码块复制失败：${String(error)}`, 'error')
    }
  }

  private setInlineActionFeedback(button: HTMLElement | undefined, state: 'loading' | 'ok' | 'error', label: string) {
    if (!button) return
    const original = button.dataset.originalLabel || button.textContent || ''
    button.dataset.originalLabel = original
    button.classList.toggle('loading', state === 'loading')
    button.classList.toggle('copy-ok', state === 'ok')
    button.classList.toggle('copy-error', state === 'error')
    ;(button as HTMLButtonElement).disabled = state === 'loading'
    button.textContent = label
    if (state !== 'loading') {
      window.setTimeout(() => {
        button.classList.remove('loading', 'copy-ok', 'copy-error')
        ;(button as HTMLButtonElement).disabled = false
        button.textContent = button.dataset.originalLabel || original
      }, state === 'ok' ? 1200 : 1800)
    }
  }

  private formatPatchApplyError(error: unknown) {
    const raw = String(error || '')
    const cleaned = raw
      .replace(/^Error:\s*/i, '')
      .replace(/^failed to apply patch:\s*/i, '')
      .trim()
    // Prefer the first actionable lines for toast; full text still goes to markRequest.
    const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const hint = lines.find(line => /^hint:/i.test(line))
    const head = lines.find(line => !/^hint:/i.test(line)) || cleaned
    if (hint) return `${head}\n${hint}`
    return cleaned || raw
  }

  private async applyChatPatch(ref: string, button?: HTMLElement) {
    const preview = ref.startsWith('patch:')
      ? this.state.agentRuntime.patchPreviews.find(item => item.id === ref.slice('patch:'.length))
      : undefined
    const patch = preview?.patch || this.findChatCode(ref)
    if (!patch) return this.toast('没有可应用的 patch', 'idle')
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    const isMemoryPatch = preview?.kind === 'memory' || String(preview?.id || '').startsWith('memory-')
    const sessionId = this.state.agentRuntime.sessionId
    const previewId = String(preview?.id || '')
    const pendingPermission = Boolean(
      previewId
      && !isMemoryPatch
      && sessionId
      && (
        this.state.agentRuntime.pendingPermissions.some(item => item.id === previewId)
        || this.state.chat.some(message => message.pendingPermissions?.some(item => item.id === previewId))
        || this.state.agentRuntime.timeline.some(item => item.id === previewId && item.status === 'approval_required')
      ),
    )

    // Pending agent tool approval: route through approve so the tool executes and the loop continues.
    if (pendingPermission && sessionId && previewId) {
      this.setInlineActionFeedback(button, 'loading', '批准中...')
      this.markRequest('busy', '正在批准并应用 Patch', this.patchSummary(patch))
      const approval = await this.answerAgentPermission(previewId, true, 'once')
      if (!approval?.ok) {
        this.setInlineActionFeedback(button, 'error', '应用失败')
        return
      }
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.filter(item => item.id !== previewId)
      this.state.chat = this.state.chat.map(message => ({
        ...message,
        patchPreviews: message.patchPreviews?.filter(item => item.id !== previewId),
      }))
      this.setInlineActionFeedback(button, 'ok', '已批准')
      this.renderAssistant()
      return
    }

    const confirmText = isMemoryPatch
      ? '应用 Memory 更新？只允许修改 .autocode/AGENTS.md、.autocode/memory.md、.autocode/settings.json。'
      : '手动应用 AI 生成的 patch？这不会继续 Agent 循环，仅把 diff 落到磁盘。'
    if (!window.confirm(confirmText)) return
    try {
      this.setInlineActionFeedback(button, 'loading', '应用中...')
      this.markRequest('busy', isMemoryPatch ? '正在应用 Memory 更新' : '正在应用 Patch', this.patchSummary(patch))
      const approvals = [{ kind: isMemoryPatch ? 'memory' : 'write', granted: true, at: new Date().toISOString() }]
      const result = isMemoryPatch
        ? await this.api.agentMemoryApply(this.currentRoot()!, patch, approvals)
        : await invoke<any>('ide_agent_apply_patch', {
            rootPath: this.currentRoot(),
            patch,
            approvals,
          })
      this.toast(result?.message || (isMemoryPatch ? 'Memory 更新已应用' : 'Patch 已应用'), 'ok')
      this.markRequest('ok', isMemoryPatch ? 'Memory 更新已应用' : 'Patch 已应用', this.patchSummary(patch))
      this.setInlineActionFeedback(button, 'ok', '已应用')
      this.state.agentRuntime.patchPreviews = this.state.agentRuntime.patchPreviews.filter(item => item.id !== preview?.id)
      if (preview?.id) {
        this.state.chat = this.state.chat.map(message => ({
          ...message,
          patchPreviews: message.patchPreviews?.filter(item => item.id !== preview.id),
        }))
      }
      if (isMemoryPatch) {
        const memory = await this.api.agentMemoryRead(this.currentRoot()!)
        this.state.agentRuntime.memoryRefs = Array.isArray(memory?.files) ? memory.files : this.state.agentRuntime.memoryRefs
      }
      const changedPaths = Array.isArray(result?.changed)
        ? result.changed.map((item: any) => String(item?.path || '')).filter(Boolean)
        : (preview?.files || []).map((item: any) => String(item?.path || item || '')).filter(Boolean)
      await this.refreshOpenTabs(changedPaths)
      await this.refreshWorkspace(true)
      await this.autoStageChangedPaths(changedPaths, isMemoryPatch ? 'Memory 更新已加入 Git 跟踪' : 'Patch 修改已加入 Git 跟踪')
    } catch (error) {
      const message = this.formatPatchApplyError(error)
      this.markRequest('error', 'Patch 应用失败', String(error))
      this.setInlineActionFeedback(button, 'error', '应用失败')
      this.toast(message, 'error')
    }
  }

  private latestPendingAgentQuestionId() {
    const calls = [
      ...this.state.chat.flatMap(message => message.toolCalls || []),
      ...this.state.agentRuntime.timeline,
    ]
    const question = [...calls].reverse().find(call => {
      if (call.name !== 'question') return false
      const output = call.output as any
      return output?.requiresUserResponse && !output?.answered
    })
    return question?.id || ''
  }

  private markAgentQuestionAnswered(questionId: string, answer: string) {
    const apply = (call: ToolCallRecord) => {
      if (call.name !== 'question') return call
      if (questionId && call.id !== questionId) return call
      const output = { ...((call.output as any) || {}), answered: true, answer }
      return { ...call, output, status: 'ok' as const, finishedAt: call.finishedAt || new Date().toISOString() }
    }
    this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(apply)
    this.state.chat = this.state.chat.map(message => ({
      ...message,
      toolCalls: message.toolCalls?.map(apply),
    }))
  }

  private detectUserFollowupQuestion(answer: string) {
    const clean = answer.trim()
    if (!clean) return false
    return /[?？]|为什么|怎么|如何|能不能|可不可以|是不是|是否|那如果|我觉得|我想|不要|不想|改成|还是|或者|补充|另外|等等|不确定/.test(clean)
  }

  private recordPlanningAnswer(answer: string, questionId = '') {
    const current = this.state.agentRuntime.planningConfirmation || {
      status: 'idle',
      answers: [],
      openQuestions: [],
      confirmedRequirements: [],
    }
    const isFollowup = this.detectUserFollowupQuestion(answer)
    const nextAnswers = [...(current.answers || []), answer].slice(-40)
    const nextOpenQuestions = isFollowup
      ? [...(current.openQuestions || []), answer].slice(-20)
      : (current.openQuestions || []).slice(0, -1)
    const confirmed = isFollowup
      ? current.confirmedRequirements || []
      : [...(current.confirmedRequirements || []), answer].slice(-40)
    this.state.agentRuntime.planningConfirmation = {
      status: isFollowup ? 'answering_user_followup' : 'waiting_user_confirmation',
      answers: nextAnswers,
      openQuestions: nextOpenQuestions,
      confirmedRequirements: confirmed,
    }
    this.state.agentRuntime.planningAnswers = nextAnswers.slice(-12)
    const question = questionId ? ` · ${questionId}` : ''
    this.markRequest(
      'busy',
      isFollowup ? '正在处理你的补充问题' : '已记录规划确认',
      `${answer}${question}`,
    )
  }

  private async answerAgentQuestionFromCard(questionId: string, button?: HTMLElement) {
    const input = this.root.querySelector<HTMLInputElement>(`[data-agent-question-input="${CSS.escape(questionId)}"]`)
    const answer = (input?.value || '').trim()
    if (!answer) return this.toast('请先输入回答', 'idle')
    await this.answerAgentQuestion(questionId, answer, button?.tagName === 'BUTTON' ? button : undefined)
  }

  private async answerAgentQuestion(questionId: string, answer: string, button?: HTMLElement) {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    const resolvedQuestionId = questionId || this.latestPendingAgentQuestionId()
    const cleanAnswer = answer.trim()
    if (!cleanAnswer) return this.toast('请先输入回答', 'idle')
    try {
      this.setInlineActionFeedback(button, 'loading', '提交中...')
      this.markAgentQuestionAnswered(resolvedQuestionId, cleanAnswer)
      if (String(this.state.agentRuntime.profileId || '').toLowerCase() === 'plan') {
        this.recordPlanningAnswer(cleanAnswer, resolvedQuestionId)
      }
      this.state.chat.push({ id: `msg-${Date.now()}-user-question-answer`, role: 'user', text: cleanAnswer, at: new Date().toISOString() })
      this.activeAssistantMessageId = ''
      this.lastAssistantResponseText = ''
      this.activeTurnStartedAt = Date.now()
      this.activeTurnToolIds = []
      this.activeTurnPermissionIds = []
      this.activeTurnPatchIds = []
      this.activeTurnCheckpointIds = []
      this.activeTurnReasoning = ''
      this.resetAssistantTyping()
      this.beginAgentTurn(cleanAnswer, [])
      this.startLocalAgentEventStream()
      this.pendingAiFallbackTimer = window.setTimeout(
        () => void this.runAiDisplayFallback('等待流式正文超时，正在切换非流式兜底。'),
        this.aiFallbackDelayMs(),
      )
      this.markRequest('busy', '已提交回答，Agent 继续执行', cleanAnswer)
      const accepted = await this.api.agentSend(sessionId, cleanAnswer, [])
      const requestId = String(accepted?.requestId || '')
      if (requestId && this.pendingAiRequest) {
        this.pendingAiRequest.requestId = requestId
        this.state.agentRuntime.activeRequestId = requestId
      }
      this.setInlineActionFeedback(button, 'ok', '已提交')
      this.toast('已提交回答，Agent 正在继续', 'busy')
      this.renderAssistant()
      this.renderComposer()
      this.scheduleSessionPersist()
    } catch (error) {
      this.clearAiFallback(true)
      this.state.agentRuntime.status = 'waiting_question'
      this.markRequest('error', '回答提交失败', String(error))
      this.setInlineActionFeedback(button, 'error', '提交失败')
      this.toast(String(error), 'error')
      this.renderAssistant()
      this.renderComposer()
    }
  }

  private async answerAgentPermission(permissionId: string, granted: boolean, scope = granted ? 'once' : 'deny', button?: HTMLElement) {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) {
      this.toast('当前没有 Agent 会话', 'idle')
      return { ok: false, error: '当前没有 Agent 会话' }
    }
    try {
      this.setInlineActionFeedback(button, 'loading', granted ? '允许中...' : '拒绝中...')
      this.markRequest('busy', granted ? 'Agent 正在继续执行' : 'Agent 正在处理拒绝结果', `${permissionId} · ${scope}`)
      this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== permissionId)
      this.state.agentRuntime.timeline = this.state.agentRuntime.timeline.map(item =>
        item.id === permissionId ? { ...item, status: granted ? 'running' as const : 'error' as const, error: granted ? '' : '已拒绝' } : item,
      )
      this.state.chat = this.state.chat.map(message => ({
        ...message,
        pendingPermissions: message.pendingPermissions?.filter(item => item.id !== permissionId),
        toolCalls: message.toolCalls?.map(item =>
          item.id === permissionId ? { ...item, status: granted ? 'running' as const : 'error' as const, error: granted ? '' : '已拒绝' } : item,
        ),
      }))
      this.setAgentWaitingPhase(granted ? 'tool' : 'waiting_permission', granted ? '正在执行已批准工具' : '已拒绝，等待 Agent 处理', permissionId)
      this.renderAssistant()
      const previousRequestId = String(this.state.agentRuntime.activeRequestId || '')
      this.state.agentRuntime.activeRequestId = ''
      this.state.agentRuntime.activeTurnId = ''
      const approveRequest = this.api.agentApprove(sessionId, permissionId, granted, scope)
      approveRequest.catch(() => {})
      const result = await Promise.race([
        approveRequest,
        new Promise(resolve => window.setTimeout(
          () => resolve({ ok: true, accepted: true, running: true, approvalTimeout: true }),
          8000,
        )),
      ]) as any
      const approvalRequestId = String(result?.requestId || result?.result?.requestId || '').trim()
      if (approvalRequestId) {
        this.completedAgentRequestIds = this.completedAgentRequestIds.filter(id => id !== approvalRequestId && id !== previousRequestId)
        this.state.agentRuntime.activeRequestId = approvalRequestId
        this.state.agentRuntime.activeTurnId = approvalRequestId
      }
      const toolError = String(result?.error || result?.result?.error || '').trim()
      const toolFailed = granted && (result?.ok === false || Boolean(toolError))
      if (/approval target not found/i.test(toolError)) {
        await this.refreshAgentSessions(false).catch(() => {})
        this.state.agentRuntime.pendingPermissions = this.state.agentRuntime.pendingPermissions.filter(item => item.id !== permissionId)
        this.state.chat = this.state.chat.map(message => ({
          ...message,
          pendingPermissions: message.pendingPermissions?.filter(item => item.id !== permissionId),
        }))
        this.markRequest('error', '审批已失效', '这张审批卡对应的后端待执行工具已经不存在，已清理。请重新发送或继续当前会话。')
        this.setInlineActionFeedback(button, 'error', '已失效')
        this.toast('审批卡已失效，已刷新会话状态', 'error')
        this.renderAssistant()
        this.scheduleSessionPersist()
        return { ok: false, error: 'approval target not found', result }
      }
      if (toolFailed) {
        const message = this.formatPatchApplyError(toolError || '工具执行失败')
        this.markRequest('error', '已批准但执行失败', toolError || message)
        this.setInlineActionFeedback(button, 'error', '失败')
        this.toast(message, 'error')
      } else {
        const toastText = granted
          ? (result?.approvalTimeout || result?.running
            ? '已允许，工具正在后台执行'
            : scope === 'session' ? '本会话后续同类操作将自动允许' : scope === 'project' ? '当前项目后续同类操作将自动允许' : '已允许本次 Agent 操作')
          : (scope === 'remember' ? '已拒绝并记住该规则' : '已拒绝本次 Agent 操作')
        if (granted && (result?.running || approvalRequestId)) {
          this.state.agentRuntime.status = 'running'
          this.markRequest('busy', 'Agent 正在继续执行', approvalRequestId || `${permissionId} · ${scope}`)
          this.bumpAiFallbackTimer()
        }
        this.toast(toastText, granted ? 'ok' : 'idle')
        this.setInlineActionFeedback(button, 'ok', granted ? '已允许' : '已拒绝')
      }
      this.renderAssistant()
      this.scheduleSessionPersist()
      return {
        ok: !toolFailed,
        error: toolFailed ? (toolError || '工具执行失败') : '',
        result,
      }
    } catch (error) {
      this.markRequest('error', 'Agent 审批失败', String(error))
      this.setInlineActionFeedback(button, 'error', '失败')
      this.toast(String(error), 'error')
      return { ok: false, error: String(error) }
    } finally {
      window.setTimeout(() => this.unlockInteractiveSurface('approval_finished'), 0)
    }
  }

  private async continueAgent() {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    if (this.state.agentRuntime.planDevelopment?.status === 'executing_plan' || this.state.agentRuntime.planDevelopment?.status === 'blocked') {
      await this.continuePlanDevelopment('manual_continue')
      return
    }
    try {
      this.state.agentRuntime.status = 'running'
      this.markRequest('busy', 'Agent 正在继续执行', '从压缩摘要和暂停点恢复。')
      await this.api.agentContinue(sessionId)
      this.toast('Agent 已继续执行', 'busy')
      this.bumpAiFallbackTimer()
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.state.agentRuntime.status = 'paused'
      this.markRequest('error', 'Agent 继续执行失败', String(error))
      this.toast(String(error), 'error')
    }
  }

  private async createAgentCheckpoint() {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    try {
      const checkpoint = await this.api.agentCheckpointCreate(sessionId, 'Manual checkpoint')
      this.state.agentRuntime.checkpoints = [
        ...this.state.agentRuntime.checkpoints.filter((item: any) => String(item?.id || '') !== String(checkpoint?.id || '')),
        checkpoint,
      ].slice(-20)
      this.toast('Checkpoint 已创建', 'ok')
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async revertAgentCheckpoint(checkpointId: string) {
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    if (!window.confirm('回退到这个 Agent checkpoint？当前相关文件会被恢复。')) return
    try {
      await this.api.agentCheckpointRevert(sessionId, checkpointId)
      this.toast('已回退 checkpoint', 'ok')
      await this.refreshWorkspace(true)
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private async revertTurnCheckpoints(messageId: string) {
    const message = this.state.chat.find(item => item.id === messageId)
    const checkpointIds = [...new Set(message?.checkpointIds || [])].filter(Boolean).reverse()
    if (!checkpointIds.length) return this.toast('这一轮没有可回退的 checkpoint', 'idle')
    const sessionId = this.state.agentRuntime.sessionId
    if (!sessionId) return this.toast('当前没有 Agent 会话', 'idle')
    if (!window.confirm(`撤销这一轮 Agent 修改？将按逆序回退 ${checkpointIds.length} 个 checkpoint。`)) return
    try {
      this.markRequest('busy', '正在撤销本轮修改', `${checkpointIds.length} 个 checkpoint`)
      for (const checkpointId of checkpointIds) {
        await this.api.agentCheckpointRevert(sessionId, checkpointId)
      }
      message.checkpointIds = []
      this.toast('已撤销本轮 Agent 修改', 'ok')
      this.markRequest('ok', '本轮修改已撤销', `${checkpointIds.length} 个 checkpoint 已回退`)
      await this.refreshWorkspace(true)
      await this.refreshGit()
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.markRequest('error', '撤销本轮修改失败', String(error))
      this.toast(String(error), 'error')
    }
  }

  private async runSubagent(profileId: string) {
    if (!this.currentRoot()) return this.toast('请先打开项目', 'idle')
    const normalized = profileId || 'Explore'
    try {
      const sessionId = await this.ensureAgentSession()
      if (!sessionId) throw new Error('Agent 会话不可用')
      const task = this.subagentTask(normalized)
      this.markRequest('busy', `${this.subagentLabel(normalized)}启动中`, task)
      const result = await this.api.agentSubagentRun(sessionId, normalized, task, this.currentContextRefsForAgent())
      const id = String(result?.id || `subagent-${Date.now()}`)
      this.state.agentRuntime.subagents = [
        ...this.state.agentRuntime.subagents.filter((item: any) => String(item?.id || '') !== id),
        { ...result, id, status: 'completed' },
      ].slice(-20)
      this.toast(`${this.subagentLabel(normalized)}已完成`, 'ok')
      this.markRequest('ok', `${this.subagentLabel(normalized)}完成`, String(result?.summary || '').slice(0, 180))
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.markRequest('error', `${this.subagentLabel(normalized)}失败`, String(error))
      this.toast(String(error), 'error')
    }
  }

  private subagentTask(profileId: string) {
    const draft = (this.$<HTMLTextAreaElement>('#task-prompt')?.value || this.composerDraft || '').trim()
    if (draft) return draft
    const tab = this.activeTab()
    const base: Record<string, string> = {
      Explore: '探索当前项目结构、技术栈、关键入口和风险点，给主 Agent 一份简洁证据摘要。',
      Review: '审查当前 Git diff 和打开文件，按严重程度总结问题、风险和建议。',
      Debug: '基于当前终端输出、问题面板和项目配置定位可能的运行/构建问题。',
      Test: '识别项目测试能力、可运行命令、缺失测试和建议的验证路径。',
      Refactor: '分析当前文件或项目中适合重构的区域，只给方案和风险，不直接写入。',
      Docs: '总结当前项目或文件的文档缺口，给出可落地的文档结构。',
    }
    return `${base[profileId] || base.Explore}${tab ? ` 当前文件：${tab.path}` : ''}`
  }

  private currentContextRefsForAgent() {
    const tab = this.activeTab()
    const selected = this.editor.selectionText()
    return [
      ...this.state.contextChips,
      tab ? { id: `subagent-file-${Date.now()}`, kind: 'file', label: `当前文件 ${tab.path}`, value: `@当前文件 ${tab.path}\n${tab.draft.slice(0, 12000)}` } : null,
      selected ? { id: `subagent-selection-${Date.now()}`, kind: 'selection', label: '当前选区', value: `@选区 ${tab?.path || ''}\n${selected.slice(0, 8000)}` } : null,
      this.terminalOutputBuffer.trim() ? { id: `subagent-terminal-${Date.now()}`, kind: 'terminal', label: '终端输出', value: `@终端输出\n${this.terminalOutputBuffer.slice(-8000)}` } : null,
      ...this.attachmentContextRefs(),
    ].filter(Boolean)
  }

  private async killAgentProcess(processId: string) {
    try {
      const result = await this.api.agentProcessKill(processId)
      this.state.agentRuntime.processes = this.state.agentRuntime.processes.map((item: any) =>
        String(item?.id || '') === processId ? { ...item, ...result, status: 'killed', finishedAt: result?.finishedAt || new Date().toISOString() } : item,
      )
      this.toast('Agent 后台进程已停止', 'ok')
      this.renderAssistant()
      this.scheduleSessionPersist()
    } catch (error) {
      this.toast(String(error), 'error')
    }
  }

  private updateComposerSuggestions(input: HTMLTextAreaElement) {
    const before = input.value.slice(0, input.selectionStart ?? input.value.length)
    const match = before.match(/(?:^|\s)([@/])([^\s@]*)$/)
    if (!match) { this.composerSuggestions = []; this.renderComposerSuggestions(); return }
    const trigger = match[1]
    const query = match[2].toLowerCase()
    if (trigger === '@') {
      this.composerSuggestions = this.buildComposerFileSuggestions(query)
      if (this.currentRoot() && (!this.workspaceFileIndexCache || this.workspaceFileIndexCache.root !== this.currentRoot())) {
        void this.refreshWorkspaceFileIndex(false)
      }
    } else {
      const commands = [
        ['mcp', 'MCP', '查看并显式调用当前项目配置的 MCP 服务'],
        ['test', '测试', '运行并分析项目测试'],
        ['build', '构建', '运行项目构建并修复错误'],
        ['review', '审查', '审查当前 Git diff'],
        ['fix', '修复', '根据错误和上下文直接修复'],
        ['plan', '规划', '先确认需求并制定可执行计划'],
        ['git', 'Git 差异', '引用当前 Git diff'],
        ['terminal', '终端输出', '引用最近终端输出'],
      ]
      const commandSuggestions = commands
        .filter(([, label, description]) => !query || `${label} ${description}`.toLowerCase().includes(query))
        .map(([id, label, description]) => ({ label: `/${label}`, value: `/:${id}`, kind: 'command' as const, description }))
      const mcpSuggestions = this.mcpComposerSuggestions(query)
      this.composerSuggestions = [...commandSuggestions, ...mcpSuggestions].slice(0, 14)
    }
    this.composerSuggestionIndex = 0
    this.renderComposerSuggestions()
  }

  private buildComposerFileSuggestions(query: string) {
    const normalizedQuery = this.normalizeWorkspacePath(query).toLowerCase()
    const root = this.currentRoot()
    const indexedFiles = root && this.workspaceFileIndexCache?.root === root ? this.workspaceFileIndexCache.value.files : []
    const indexedDirs = root && this.workspaceFileIndexCache?.root === root ? this.workspaceFileIndexCache.value.dirs || [] : []
    const candidates = new Map<string, { path: string; kind: 'file' | 'folder'; name: string; parent: string; score: number }>()
    const addCandidate = (path: string, kind: 'file' | 'folder', baseScore: number) => {
      const normalized = this.normalizeWorkspacePath(path)
      if (!normalized || normalized === '.') return
      const lower = normalized.toLowerCase()
      const name = basename(normalized)
      const nameLower = name.toLowerCase()
      if (normalizedQuery && !lower.includes(normalizedQuery) && !nameLower.includes(normalizedQuery)) return
      const exactName = normalizedQuery && nameLower === normalizedQuery ? 80 : 0
      const prefixName = normalizedQuery && nameLower.startsWith(normalizedQuery) ? 55 : 0
      const prefixPath = normalizedQuery && lower.startsWith(normalizedQuery) ? 40 : 0
      const shallow = Math.max(0, 18 - normalized.split('/').length * 3)
      const score = baseScore + exactName + prefixName + prefixPath + shallow
      const existing = candidates.get(lower)
      if (!existing || existing.score < score) {
        candidates.set(lower, { path: normalized, kind, name, parent: relativeParent(normalized), score })
      }
    }
    for (const item of indexedFiles) {
      addCandidate(item.path, 'file', 35)
      const parts = this.normalizeWorkspacePath(item.path).split('/')
      for (let index = 1; index < parts.length; index += 1) {
        addCandidate(parts.slice(0, index).join('/'), 'folder', 22)
      }
    }
    for (const item of indexedDirs) addCandidate(item.path, 'folder', 36)
    for (const item of flattenEntries(this.state.workspace.tree)) {
      addCandidate(item.path, item.kind === 'dir' ? 'folder' : 'file', item.kind === 'dir' ? 45 : 50)
    }
    for (const item of this.state.workspace.git?.files || []) addCandidate(item.path, 'file', 42)
    for (const tab of this.state.workspace.tabs) addCandidate(tab.path, 'file', 60)
    return [...candidates.values()]
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 16)
      .map(item => ({
        label: item.path,
        value: `@:${item.kind}:${item.path}`,
        kind: item.kind,
        description: item.kind === 'folder'
          ? `${item.parent || '.'} · 引用文件夹`
          : `${item.parent || '.'} · 引用文件`,
      }))
  }

  private mcpComposerSuggestions(query: string) {
    if (query && !'mcp'.includes(query) && !query.includes('mcp')) return []
    const mcpTools = Array.isArray(this.state.agentRuntime.mcpTools) ? this.state.agentRuntime.mcpTools as any[] : []
    return mcpTools.slice(0, 10).map(item => {
      const name = String(item?.name || item?.id || 'mcp')
      const server = item?.server || {}
      const enabled = server?.enabled === false ? '已禁用' : '已启用'
      const command = [server?.command, ...(Array.isArray(server?.args) ? server.args : [])].filter(Boolean).join(' ')
      return {
        label: `/MCP ${name}`,
        value: `/:mcp:${name}`,
        kind: 'mcp' as const,
        description: `${enabled} · ${command || '通过 mcp_call 调用'}`,
      }
    })
  }

  private renderComposerSuggestions() {
    const panel = this.$('#composer-suggestions')
    if (!panel) return
    if (!this.composerSuggestions.length) { panel.setAttribute('hidden', ''); panel.innerHTML = ''; return }
    panel.innerHTML = this.composerSuggestions.map((item, index) => `
      <button class="composer-suggestion ${index === this.composerSuggestionIndex ? 'active' : ''}" data-composer-suggestion="${escapeHtml(encodeURIComponent(item.value))}">
        <strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.description)}</span>
      </button>
    `).join('')
    panel.removeAttribute('hidden')
  }

  private applyComposerSuggestion(encodedValue: string) {
    if (!encodedValue) return
    const value = decodeURIComponent(encodedValue)
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (!input) return
    const cursor = input.selectionStart ?? input.value.length
    const before = input.value.slice(0, cursor)
    const match = before.match(/(?:^|\s)([@/])([^\s@]*)$/)
    if (!match) return
    const tokenStart = cursor - match[0].trimStart().length
    let replacement = ''
    if (value.startsWith('@:')) {
      const raw = value.slice(2)
      const typed = raw.match(/^(file|folder):(.*)$/)
      const path = typed ? typed[2] : raw
      const suggestedKind = typed?.[1] === 'file' ? 'file' : typed?.[1] === 'folder' ? 'folder' : ''
      const entry = findEntry(this.state.workspace.tree, path)
      replacement = `@${path} `
      const isFile = suggestedKind === 'file' || entry?.kind === 'file'
      const kind = isFile ? 'file' : 'workspace'
      this.state.contextChips = [...this.state.contextChips.filter(chip => chip.label !== path), { id: `quick-ref-${Date.now()}`, label: path, value: `@${isFile ? '文件' : '文件夹'} ${path}`, kind }]
    } else {
      const id = value.slice(2)
      if (id === 'mcp' || id.startsWith('mcp:')) {
        replacement = `${this.mcpComposerPrompt(id)} `
      } else {
        const prompts: Record<string, string> = {
          test: '运行并分析当前项目测试，失败时定位并修复。',
          build: '运行当前项目构建，定位并修复构建错误。',
          review: '审查当前 Git diff，按严重程度指出问题并给出修复。',
          fix: '根据当前错误、终端输出和项目上下文直接修复问题。',
          plan: '先确认需求并制定可执行计划，再按计划推进。',
          git: '@Git diff',
          terminal: '@终端输出',
        }
        replacement = `${prompts[id] || value} `
      }
      if (id === 'git') this.addContextChip('git')
      if (id === 'terminal') this.addContextChip('terminal')
    }
    input.value = `${input.value.slice(0, tokenStart)}${replacement}${input.value.slice(cursor)}`
    const nextCursor = tokenStart + replacement.length
    input.selectionStart = nextCursor
    input.selectionEnd = nextCursor
    this.composerDraft = input.value
    this.composerSuggestions = []
    this.renderComposerSuggestions()
    input.focus()
    this.scheduleSessionPersist()
  }
  private mcpComposerPrompt(id: string) {
    const serverName = id.startsWith('mcp:') ? id.slice(4).trim() : ''
    const mcpTools = Array.isArray(this.state.agentRuntime.mcpTools) ? this.state.agentRuntime.mcpTools as any[] : []
    const names = mcpTools.map(item => String(item?.name || '')).filter(Boolean)
    if (serverName) {
      return `请显式使用 MCP 服务「${serverName}」处理下面的需求。先调用 mcp_call 列出该服务可用工具；确认合适工具后再调用，并把结果和使用的 MCP 工具说明清楚：`
    }
    const list = names.length ? `当前已配置 MCP 服务：${names.join('、')}。` : '当前未检测到已启用的 MCP 服务；请先检查项目 .autocode/settings.json 或设置中的 MCP 配置。'
    return `请显式使用 MCP。${list}先调用 mcp_call 查看可用 MCP 服务/工具，再根据我的需求选择合适工具处理：`
  }
  private renderComposer() {
    this.root.querySelectorAll<HTMLButtonElement>('[data-composer-mode]').forEach(button => {
      button.classList.toggle('active', button.dataset.composerMode === this.state.composerMode)
    })
    const modeActions = this.$('#composer-mode-actions')
    if (modeActions) modeActions.innerHTML = this.renderComposerControls()
    const body = this.$('#composer-body')
    if (!body) return
    const attachments = this.state.attachments.length
      ? `<div class="attachment-list">${this.state.attachments.map((item, index) => `
        <article class="attachment-card" ${(item.preview || item.dataUrl || item.text) ? `data-attachment-preview-src="${escapeHtml(item.preview || item.dataUrl || '')}" data-attachment-preview-title="${escapeHtml(item.name)}" data-attachment-preview-text="${escapeHtml(item.text || '')}" data-attachment-preview-note="${escapeHtml(item.note || '')}"` : ''}>
          ${item.preview ? `<img src="${escapeHtml(item.preview)}" alt="" />` : '<div class="attachment-icon">FILE</div>'}
          <div>
            <strong>${escapeHtml(item.name)}</strong>
            <span>${escapeHtml(item.mime || item.kind)}${item.size ? ` · ${bytesLabel(item.size)}` : ''}${item.readable ? ' · 可读取' : ' · 仅记录'}</span>
            ${item.text ? `<small>${escapeHtml(item.text.slice(0, 160))}${item.text.length > 160 ? '...' : ''}</small>` : item.note ? `<small>${escapeHtml(item.note)}</small>` : ''}
          </div>
          <button class="icon-button" data-remove-attachment="${index}" title="移除附件">×</button>
        </article>
      `).join('')}</div>`
      : ''
    if (this.state.composerMode === 'text') {
      body.innerHTML = `<textarea id="task-prompt" placeholder="输入开发需求。Enter 发送，Ctrl+Enter 换行；输入 @ 引用文件，输入 / 使用快捷功能..." spellcheck="false"></textarea><div class="composer-suggestions" id="composer-suggestions" hidden></div>${attachments}`
    } else if (this.state.composerMode === 'image') {
      body.innerHTML = `<div class="mode-panel attachment-drop"><strong>图片上下文</strong><p>可选择图片，也可以直接在文本输入框粘贴截图。</p><button class="secondary-button" id="pick-image-attachments">选择图片</button></div>${attachments}`
    } else if (this.state.composerMode === 'file') {
      body.innerHTML = `<div class="mode-panel attachment-drop"><strong>文件上下文</strong><p>添加需求文档、日志、配置或参考文件。</p><button class="secondary-button" id="pick-file-attachments">选择文件</button></div>${attachments}`
    } else {
      const recording = Boolean(this.voiceSessionId || this.browserSpeech || this.state.voice.recording)
      body.innerHTML = this.renderVoicePanel(recording) + attachments
    }
    this.syncComposerDraftToDom()
    this.updateComposerSubmitButton()
  }

  private renderVoicePanel(recording: boolean) {
    const voice = this.state.voice
    const status = voice.offlineStt
    const activeModel = this.state.settings.offline_stt_model || 'zh-streaming-small'
    const models = status?.models || []
    const download = voice.offlineDownload
    const downloadPercent = Math.max(0, Math.min(100, Number(download?.percent ?? 0)))
    const downloadLabel = download
      ? `${download.message || '正在处理'}${download.totalBytes ? ` · ${bytesLabel(download.bytes || 0)} / ${bytesLabel(download.totalBytes)}` : download.bytes ? ` · ${bytesLabel(download.bytes)}` : ''}`
      : ''
    const modelCards = models.length
      ? `<div class="stt-model-grid">${models.map(model => `
        <article class="stt-model-card ${model.installed ? 'installed' : ''} ${model.id === activeModel ? 'active' : ''}">
          <div>
            <strong>${escapeHtml(model.name)}</strong>
            <span>${escapeHtml(model.sizeLabel)} · ${escapeHtml(model.accuracyLabel)} · ${escapeHtml(model.latencyLabel)}</span>
          </div>
          <p>${escapeHtml(model.description)}</p>
          <small class="stt-model-state">${model.installed ? '模型已安装' : '模型未安装'}${status?.binaryFound ? ' · 引擎可用' : ' · 缺少识别引擎'}</small>
          <div class="stt-model-actions">
            <button class="secondary-button" data-stt-use-model="${escapeHtml(model.id)}">${model.id === activeModel ? '正在使用' : '使用'}</button>
            <button class="secondary-button" data-stt-download-model="${escapeHtml(model.id)}" ${voice.offlineBusy || model.installed ? 'disabled' : ''}>${model.installed ? '已安装' : '下载'}</button>
          </div>
        </article>
      `).join('')}</div>`
      : '<div class="stt-empty">尚未检查离线模型状态。</div>'
    const engineLine = status
      ? `${status.binaryFound ? '识别引擎已找到' : '识别引擎未找到'} · ${status.binaryFound ? status.binaryPath : `需要 sherpa-onnx-offline-parallel.exe 和 DLL；通常应随安装包内置，或放入 ${status.dataDir}\\bin`}`
      : '点击检查后会显示 sherpa-onnx 引擎和模型状态。'
    const activeInstalled = models.find(model => model.id === activeModel)?.installed
    const readiness = status
      ? status.binaryFound && activeInstalled
        ? '离线转写可用'
        : activeInstalled
          ? '模型已安装，但缺少 sherpa-onnx 离线 ASR 引擎'
          : '请先下载一个离线模型；下载完成后会自动切换并立即可用'
      : ''
    return `<div class="mode-panel attachment-drop voice-panel">
      <div class="voice-panel-head">
        <div>
          <strong>语音转文字</strong>
          <p>${recording ? '正在录音，停止后会自动离线转文字并填入输入框。' : '优先使用桌面录音和本地离线转写；离线模型由你按需下载，安装后即可直接使用。'}</p>
        </div>
        <button class="secondary-button" id="refresh-offline-stt" ${voice.offlineBusy ? 'disabled' : ''}>检查离线模型</button>
      </div>
      <div class="voice-live" id="voice-live-text">${escapeHtml(voice.lastText || (recording ? '正在听...' : ''))}</div>
      <div class="voice-actions">
        <button class="secondary-button" id="pick-audio-attachment">添加音频文件</button>
        <button class="${recording ? 'primary-button' : 'secondary-button'}" id="${recording ? 'stop-voice' : 'start-voice'}">${recording ? '停止并填入文字' : '开始语音输入'}</button>
        ${voice.transcribing ? '<span class="voice-state">正在转文字...</span>' : ''}
        ${voice.offlineBusy ? '<span class="voice-state">正在处理离线模型...</span>' : ''}
      </div>
      <div class="stt-engine-status">${escapeHtml(engineLine)}</div>
      <label class="stt-proxy-row">
        <span>模型下载代理</span>
        <input id="offline-stt-proxy-url" value="${escapeHtml(this.offlineSttProxyUrl)}" placeholder="可选，例如 http://127.0.0.1:7890" spellcheck="false" />
      </label>
      ${readiness ? `<div class="stt-readiness ${status?.binaryFound && activeInstalled ? 'ok' : 'warn'}">${escapeHtml(readiness)}</div>` : ''}
      ${download ? `<div class="stt-progress ${escapeHtml(String(download.phase || ''))}">
        <div><strong>${escapeHtml(this.sttDownloadPhaseLabel(download.phase))}</strong><span>${escapeHtml(downloadLabel)}</span>${!['done', 'error', 'canceled', 'canceling'].includes(String(download.phase || '')) ? `<button class="stt-cancel-button" data-stt-cancel-download="${escapeHtml(download.modelId || activeModel)}">停止</button>` : ''}</div>
        <div class="stt-progress-track ${download.totalBytes ? '' : 'indeterminate'}"><span style="width:${download.totalBytes ? downloadPercent : 36}%"></span></div>
      </div>` : ''}
      ${modelCards}
      ${status?.message ? `<small class="voice-state">${escapeHtml(status.message)}</small>` : ''}
      ${voice.error ? `<small class="error-text">${escapeHtml(voice.error)}</small>` : ''}
    </div>`
  }

  private async refreshOfflineSttStatus(showToast = false) {
    if (this.state.voice.offlineBusy && !showToast) return
    this.state.voice.offlineBusy = true
    this.renderComposer()
    try {
      const status = await this.api.offlineSttStatus()
      this.state.voice.offlineStt = status
      this.state.voice.error = ''
      if (showToast) this.toast(status?.message || '离线语音模型状态已刷新', status?.binaryFound ? 'ok' : 'idle')
    } catch (error) {
      this.state.voice.error = `检查离线语音模型失败：${String(error)}`
      if (showToast) this.toast(this.state.voice.error, 'error')
    } finally {
      this.state.voice.offlineBusy = false
      this.renderComposer()
      this.scheduleSessionPersist()
    }
  }

  private async downloadOfflineSttModel(modelId: string) {
    this.state.voice.offlineBusy = true
    this.state.voice.error = ''
    this.state.voice.offlineDownload = {
      modelId,
      phase: 'starting',
      bytes: 0,
      totalBytes: null,
      percent: 0,
      message: '准备下载离线语音模型。',
      at: new Date().toISOString(),
    }
    this.renderComposer()
    this.toast('正在下载离线语音模型，文件较大，请稍候。', 'busy')
    try {
      const result = await this.api.offlineSttDownloadModel(modelId, this.offlineSttProxyUrl)
      if (result?.canceled) {
        this.state.voice.offlineBusy = false
        this.state.voice.offlineDownload = {
          ...(this.state.voice.offlineDownload || {
            modelId,
            bytes: 0,
            totalBytes: null,
            percent: 0,
            at: new Date().toISOString(),
          }),
          modelId,
          phase: 'canceled',
          message: result?.message || '已停止下载离线语音模型。',
          at: new Date().toISOString(),
        }
        this.toast(result?.message || '已停止下载离线语音模型。', 'idle')
        return
      }
      this.state.settings.offline_stt_model = modelId
      await this.persistSettingsFromState()
      await this.refreshOfflineSttStatus(false)
      this.toast(result?.message || '离线语音模型已下载', result?.ok ? 'ok' : 'idle')
    } catch (error) {
      this.state.voice.error = `下载离线语音模型失败：${String(error)}`
      this.toast(this.state.voice.error, 'error')
    } finally {
      this.state.voice.offlineBusy = false
      this.renderComposer()
      this.scheduleSessionPersist()
    }
  }

  private async cancelOfflineSttDownload(modelId: string) {
    this.state.voice.offlineBusy = true
    this.state.voice.offlineDownload = {
      ...(this.state.voice.offlineDownload || {
        modelId,
        bytes: 0,
        totalBytes: null,
        percent: 0,
        at: new Date().toISOString(),
      }),
      modelId,
      phase: 'canceling',
      message: '正在停止下载离线语音模型。',
      at: new Date().toISOString(),
    }
    this.renderComposer()
    try {
      const result = await this.api.offlineSttCancelDownload(modelId)
      this.toast(result?.message || '正在停止下载离线语音模型。', result?.ok ? 'busy' : 'idle')
      if (result?.canceled || !result?.ok) {
        this.state.voice.offlineBusy = false
        this.state.voice.offlineDownload = {
          ...(this.state.voice.offlineDownload || {
            modelId,
            bytes: 0,
            totalBytes: null,
            percent: 0,
            at: new Date().toISOString(),
          }),
          modelId,
          phase: 'canceled',
          message: result?.message || (result?.canceled ? '已停止下载离线语音模型。' : '当前没有正在下载的离线语音模型。'),
          at: new Date().toISOString(),
        }
        this.renderComposer()
      }
    } catch (error) {
      this.state.voice.offlineBusy = false
      this.toast(`停止下载失败：${String(error)}`, 'error')
      this.renderComposer()
    }
  }

  private async useOfflineSttModel(modelId: string) {
    this.state.settings.offline_stt_model = modelId
    await this.persistSettingsFromState()
    await this.refreshOfflineSttStatus(false)
    this.toast(`已切换离线语音模型：${modelId}`, 'ok')
  }

  private sttDownloadPhaseLabel(phase: string) {
    const labels: Record<string, string> = {
      starting: '准备下载',
      connecting: '连接下载源',
      downloading: '正在下载',
      extracting: '正在解压',
      canceling: '正在停止',
      canceled: '已停止',
      done: '下载完成',
      error: '下载失败',
    }
    return labels[phase] || '处理中'
  }

  private renderComposerControls() {
    this.repairStuckQueuedMessages()
    const mode = this.state.settings.reasoning_mode || 'auto'
    const queued = this.state.agentRuntime.queuedUserMessages.filter(item => item.status === 'queued').length
    const processing = this.state.agentRuntime.queuedUserMessages.filter(item => item.status === 'processing').length
    const nextQueued = this.state.agentRuntime.queuedUserMessages.find(item => item.status === 'queued')
    const queue = queued || processing
      ? `<span class="composer-queue-summary">${processing ? `处理中 ${processing}` : ''}${queued ? `${processing ? ' · ' : ''}排队 ${queued}` : ''}${nextQueued ? ` · 下一条：${escapeHtml(nextQueued.text.slice(0, 24))}` : ''}</span>`
      : ''
    return `${queue}<label class="composer-quickbar"><span>思考</span><select id="composer-reasoning-mode"><option value="auto" ${mode === 'auto' ? 'selected' : ''}>自动</option><option value="off" ${mode === 'off' ? 'selected' : ''}>关闭</option><option value="low" ${mode === 'low' ? 'selected' : ''}>低</option><option value="medium" ${mode === 'medium' ? 'selected' : ''}>中</option><option value="high" ${mode === 'high' ? 'selected' : ''}>高</option><option value="xhigh" ${mode === 'xhigh' ? 'selected' : ''}>极高</option></select></label>`
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
    this.state.voice.error = ''
    this.browserSpeechText = ''
    await this.startDesktopVoiceRecording()
  }

  private nextPaint() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
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
        this.state.voice.error = ''
        this.renderComposer()
      }
      this.toast(status?.message || '桌面录音状态已返回', status?.supported ? 'ok' : 'idle')
    } catch (error) {
      this.state.voice.error = `桌面录音启动失败：${String(error)}`
      this.state.voice.recording = false
      this.renderComposer()
      this.toast(this.state.voice.error, 'error')
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
      this.state.voice.transcribing = true
      this.state.voice.error = ''
      this.renderComposer()
      await this.nextPaint()
      try {
        let offlineMessage = ''
        const hasCloudTranscriptionModel = Boolean(this.state.settings.transcription_model?.trim())
        const shouldTryOfflineStt = this.state.settings.offline_stt_enabled !== false || !hasCloudTranscriptionModel
        if (shouldTryOfflineStt) {
          const result = await this.api.offlineSttTranscribe(item.path, this.state.settings.offline_stt_model || 'zh-streaming-small')
          if (result?.text) {
            this.state.voice.lastText = result.text
            this.insertComposer(result.text)
            this.toast(`语音已转文字：${result.model || result.engine || '离线 STT'}`, 'ok')
            return
          }
          offlineMessage = result?.message || '离线语音转文字未返回文本'
          this.state.voice.error = offlineMessage
          await this.refreshOfflineSttStatus(false)
        }
        if (hasCloudTranscriptionModel) {
          const result = await this.api.transcribeAudio(item.path, this.state.settings.transcription_model)
          if (result?.text) {
            this.state.voice.lastText = result.text
            this.insertComposer(result.text)
            this.toast(`语音已转文字：${result.model || result.provider || 'ASR'}`, 'ok')
          } else {
            throw new Error(result?.message || 'Provider 未返回转写文本')
          }
        } else {
          this.state.voice.error = offlineMessage
            ? `${offlineMessage}；录音临时文件：${item.path || '未知'}`
            : `未识别到文字；录音临时文件：${item.path || '未知'}。请在语音模块安装离线模型，或配置云端转写模型。`
          this.toast(this.state.voice.error, 'idle')
        }
      } catch (error) {
        const detail = String(error)
        this.state.voice.error = `${detail}；录音临时文件：${item.path || '未知'}`
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
      ['layout', '切换三栏布局', '侧栏 / 工作台 / AI 位置轮换'],
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
    const selected = this.selectedWorkspacePath()
    const systemPath = selected ? this.absolutePath(selected) : this.currentRoot()
    menu.innerHTML = `
      <button id="new-file"><span>＋</span><div><strong>新建文件</strong><small>在当前位置创建文件</small></div></button>
      <button id="new-folder"><span>▣</span><div><strong>新建文件夹</strong><small>在当前位置创建目录</small></div></button>
      <button id="rename-entry"><span>✎</span><div><strong>重命名</strong><small>修改相对路径或名称</small></div></button>
      <button id="delete-entry"><span>×</span><div><strong>删除</strong><small>从当前工作区移除</small></div></button>
      <button id="copy-relative-path"><span>↪</span><div><strong>复制相对路径</strong><small>适合发给 Agent</small></div></button>
      <button id="copy-absolute-path"><span>⛶</span><div><strong>复制绝对路径</strong><small>适合终端或外部工具</small></div></button>
      <button id="copy-file-name"><span>文</span><div><strong>复制文件名</strong><small>只复制名称</small></div></button>
      <button id="copy-parent-path"><span>⌂</span><div><strong>复制所在目录</strong><small>复制父目录路径</small></div></button>
      <button id="open-entry-explorer" data-open-system-path="${escapeHtml(systemPath)}"><span>↗</span><div><strong>在资源管理器中显示</strong><small>打开真实文件位置</small></div></button>
    `
    this.placeContextMenu(menu, x, y)
  }

  private showTabContextMenu(x: number, y: number, path: string) {
    const menu = this.$('#context-menu')
    if (!menu || !path) return
    menu.innerHTML = `
      <button data-editor-copy-path="relative"><span>↪</span><div><strong>复制相对路径</strong><small>${escapeHtml(path)}</small></div></button>
      <button data-editor-copy-path="absolute"><span>⛶</span><div><strong>复制绝对路径</strong><small>完整磁盘路径</small></div></button>
      <button data-editor-copy-path="name"><span>文</span><div><strong>复制文件名</strong><small>${escapeHtml(basename(path))}</small></div></button>
      <button data-editor-copy-path="parent"><span>⌂</span><div><strong>复制所在目录</strong><small>父目录</small></div></button>
      <button data-open-system-path="${escapeHtml(this.absolutePath(path))}"><span>↗</span><div><strong>在资源管理器中显示</strong><small>打开真实文件位置</small></div></button>
      <button data-close-tab="${escapeHtml(path)}"><span>×</span><div><strong>关闭</strong><small>关闭当前标签</small></div></button>
      <button data-close-other-tabs="${escapeHtml(path)}"><span>⇥</span><div><strong>关闭其他</strong><small>保留当前标签</small></div></button>
    `
    this.placeContextMenu(menu, x, y)
  }

  private placeContextMenu(menu: HTMLElement, x: number, y: number) {
    const margin = 8
    menu.style.left = '0px'
    menu.style.top = '0px'
    menu.removeAttribute('hidden')
    const rect = menu.getBoundingClientRect()
    const width = Math.min(rect.width || 260, window.innerWidth - margin * 2)
    const height = Math.min(rect.height || 220, window.innerHeight - margin * 2)
    const left = Math.max(margin, Math.min(x, window.innerWidth - width - margin))
    const top = Math.max(margin, Math.min(y, window.innerHeight - height - margin))
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  private hideContextMenu() {
    this.$('#context-menu')?.setAttribute('hidden', '')
  }

  private showFileReferenceCandidates(anchor: HTMLElement, encodedCandidates: string) {
    let candidates: WorkspaceFileReferenceCandidate[] = []
    try {
      candidates = JSON.parse(decodeURIComponent(encodedCandidates))
    } catch {
      candidates = []
    }
    if (!candidates.length) return
    const menu = this.$('#context-menu')
    if (!menu) return
    menu.innerHTML = `
      <div class="context-title">选择文件</div>
      ${candidates.slice(0, 12).map(item => `
        <button data-chat-file-path="${escapeHtml(item.path)}">
          <span>文</span>
          <div>
            <strong>${escapeHtml(item.name || basename(item.path))}</strong>
            <small>${escapeHtml(item.parent || '.')}</small>
          </div>
          ${item.badge ? `<em>${escapeHtml(item.badge)}</em>` : ''}
        </button>
      `).join('')}
    `
    const rect = anchor.getBoundingClientRect()
    this.placeContextMenu(menu, rect.left, rect.bottom + 6)
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
    setSelect('#connection-mode', this.state.settings.connection_mode === 'webConnector' ? 'aiProvider' : (this.state.settings.connection_mode || 'aiProvider'))
    setSelect('#provider-type', this.state.settings.provider_type || 'openai-responses')
    set('#provider-model', this.state.settings.model)
    set('#transcription-model', this.state.settings.transcription_model || '')
    const offlineEnabled = this.$<HTMLInputElement>('#offline-stt-enabled')
    if (offlineEnabled) offlineEnabled.checked = this.state.settings.offline_stt_enabled !== false
    setSelect('#offline-stt-model', this.state.settings.offline_stt_model || 'zh-streaming-small')
    this.ensureProviderChannels()
    set('#provider-channels', JSON.stringify(this.state.settings.channels || [], null, 2))
    set('#provider-default-routes', JSON.stringify(this.state.settings.default_routes || {}, null, 2))
    const codeCompletionEnabled = this.$<HTMLInputElement>('#code-completion-enabled')
    if (codeCompletionEnabled) codeCompletionEnabled.checked = this.state.settings.code_completion?.enabled !== false
    set('#code-completion-model', this.state.settings.code_completion?.model || '')
    set('#code-completion-channel', this.state.settings.code_completion?.channel_id || '')
    set('#code-completion-prompt', this.state.settings.code_completion?.prompt || '')
    setSelect('#reasoning-mode', this.state.settings.reasoning_mode || 'auto')
    set('#reasoning-effort', this.state.settings.reasoning_effort || 'medium')
    set('#reasoning-budget', String(this.state.settings.reasoning_budget_tokens || 8192))
    set('#settings-temperature', String(this.aiTemperature))
    set('#settings-context-budget', String(this.state.settings.context_budget || this.aiContextBudget))
    set('#settings-system-prompt', this.aiSystemPrompt)
    setSelect('#approval-mode', this.state.settings.approval_mode || 'autoEdit')
    set('#permission-policy', JSON.stringify(this.state.settings.permission_policy || {}, null, 2))
    set('#mcp-servers', JSON.stringify(this.state.settings.mcp_servers || [], null, 2))
    set('#memory-files', (this.state.settings.memory_files?.length ? this.state.settings.memory_files : ['.autocode/AGENTS.md', '.autocode/memory.md', '.autocode/settings.json']).join(','))
    set('#auto-compact-threshold', String(this.state.settings.auto_compact_threshold || 24000))
    setSelect('#checkpoint-policy', this.state.settings.checkpoint_policy || 'before_write')
    setSelect('#default-shell', this.state.settings.default_shell || 'auto')
    setSelect('#theme-select', this.state.theme)
    set('#ui-font-size', String(this.state.settings.ui_font_size || 14))
    set('#code-font-size', String(this.state.settings.code_font_size || 12))
    set('#ui-font-family', this.state.settings.ui_font_family || 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif')
    set('#code-font-family', this.state.settings.code_font_family || '"Cascadia Code", Consolas, monospace')
    set('#appearance-contrast', String(this.state.settings.ui_contrast || 100))
    setSelect('#appearance-density', this.state.settings.appearance_density || 'comfortable')
    setSelect('#reduced-motion', this.state.settings.reduced_motion || 'system')
    const setChecked = (selector: string, checked: boolean) => {
      const input = this.$<HTMLInputElement>(selector)
      if (input) input.checked = checked
    }
    setChecked('#desktop-notifications-enabled', this.state.settings.desktop_notifications_enabled !== false)
    setChecked('#desktop-notification-sound-enabled', this.state.settings.desktop_notification_sound_enabled !== false)
    setChecked('#notify-agent-waiting', this.state.settings.notify_on_agent_waiting !== false)
    setChecked('#notify-agent-done', this.state.settings.notify_on_agent_done !== false)
    setChecked('#notify-agent-failed', this.state.settings.notify_on_agent_failed !== false)
    setChecked('#auto-update-enabled', this.state.settings.auto_update_enabled !== false)
    setChecked('#update-check-on-startup', this.state.settings.update_check_on_startup !== false)
    set('#update-check-interval', String(this.state.settings.update_check_interval_hours || 12))
    this.renderUpdateSettingsStatus()
    set('#default-workspace-path', this.state.settings.default_workspace_path)
    set('#settings-preview-url', this.state.settings.preview_url)
    set('#preview-url', this.state.previewUrl || this.state.settings.preview_url)
  }

  private upsertRecent(project: RecentProject) {
    const normalized = this.normalizeRecentProject(project)
    if (!normalized) return
    this.state.settings.recent_projects = this.dedupeRecentProjects([normalized, ...this.state.settings.recent_projects])
    this.state.settings.last_workspace_path = normalized.path
    this.state.settings.default_workspace_path = normalized.path || this.state.settings.default_workspace_path
    void this.persistSettingsFromState()
  }

  private async removeRecentProject(path: string) {
    const normalizedPath = displayPath(path)
    const before = this.state.settings.recent_projects || []
    const next = before.filter(item => displayPath(item.path) !== normalizedPath)
    if (next.length === before.length) return
    this.state.settings.recent_projects = next
    const fallback = next[0]?.path || ''
    if (displayPath(this.state.settings.last_workspace_path || '') === normalizedPath) {
      this.state.settings.last_workspace_path = fallback
    }
    if (displayPath(this.state.settings.default_workspace_path || '') === normalizedPath) {
      this.state.settings.default_workspace_path = fallback
    }
    this.renderRecent()
    await this.persistSettingsFromState()
    this.renderRecent()
    this.toast('已从最近项目移除，不会删除本地文件', 'ok')
  }

  private updateEditorCompletions() {
    const paths = flattenEntries(this.state.workspace.tree).map(item => item.path)
    const symbols = this.activeTab()?.draft.match(/[A-Za-z_$][\w$]{2,}/g) || []
    this.editor.setCompletionWords([...paths, ...symbols])
  }

  private async requestInlineCompletion(context: AiCompletionContext) {
    if (!this.currentRoot()) return ''
    if (this.state.settings.code_completion?.enabled === false) return ''
    this.ensureProviderChannels()
    if (!this.state.settings.api_base_url.trim() && !this.state.settings.channels.some(channel => channel.enabled && channel.api_base_url.trim())) return ''
    if (this.state.settings.connection_mode === 'autocodePlatform') return ''
    const config = this.state.settings.code_completion
    const response = await this.api.codeCompletion({
      path: context.path,
      language: context.language,
      prefix: context.prefix.slice(-(config?.max_prefix_chars || 5000)),
      suffix: context.suffix.slice(0, config?.max_suffix_chars || 2000),
      linePrefix: context.linePrefix,
    })
    return this.cleanInlineCompletion(String(response?.text || ''), context)
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
    this.clearComposerOptimizationUndo(false)
    this.state.composerMode = 'text'
    this.renderComposer()
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (!input) return
    input.value = input.value ? `${input.value}\n${text}` : text
    this.composerDraft = input.value
    input.focus()
    this.scheduleSessionPersist()
  }

  private async optimizeComposerPrompt() {
    if (this.composerOptimizeBusy) return
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    const rawDraft = (input?.value || this.composerDraft || '').trim()
    if (this.lastComposerPromptBeforeOptimize && !rawDraft) {
      this.applyOptimizedComposerDraft(this.lastComposerPromptBeforeOptimize, false)
      this.toast('已撤销优化', 'idle')
      return
    }
    if (this.lastComposerPromptBeforeOptimize && rawDraft) {
      const previous = this.lastComposerPromptBeforeOptimize
      this.applyOptimizedComposerDraft(previous, false)
      this.toast('已撤销优化', 'idle')
      return
    }
    if (!rawDraft) return this.toast('请先输入需要优化的需求', 'idle')

    this.composerOptimizeBusy = true
    this.updateComposerSubmitButton()
    this.toast('正在优化输入内容...', 'busy')
    try {
      const request = this.buildComposerOptimizationPrompt(rawDraft)
      const response = await this.api.providerRequest(request)
      const optimized = this.normalizeOptimizedComposerDraft(response?.answer || '')
      if (!optimized) throw new Error('Provider 未返回可用的优化内容')
      this.lastComposerPromptBeforeOptimize = rawDraft
      this.applyOptimizedComposerDraft(optimized, true)
      this.toast('需求已优化，可继续编辑或直接发送', 'ok')
    } catch (error) {
      this.lastComposerPromptBeforeOptimize = ''
      this.toast(`优化失败：${String(error)}`, 'error')
    } finally {
      this.composerOptimizeBusy = false
      this.updateComposerSubmitButton()
    }
  }

  private buildComposerOptimizationPrompt(rawDraft: string) {
    const project = this.state.workspace.currentProject
    const root = this.currentRoot() || ''
    const tab = this.activeTab()
    const selected = this.editor.selectionText().trim()
    const attachmentLines = this.state.attachments.length
      ? this.state.attachments.map(item => `- ${item.name} (${item.mime || item.kind}${item.size ? `, ${bytesLabel(item.size)}` : ''})`).join('\n')
      : '无'
    const context = [
      `项目：${project?.name || projectName(root) || '未打开项目'}`,
      `工作区：${root || '未打开'}`,
      `当前文件：${tab?.path || '无'}`,
      `输入模式：${this.state.composerMode}`,
      `附件：\n${attachmentLines}`,
      selected ? `当前选区摘录：\n${selected.slice(0, 1200)}` : '当前选区摘录：无',
    ].join('\n')
    return {
      temperature: 0.1,
      maxTokens: 900,
      messages: [
        {
          role: 'system' as const,
          content: [
            '你是 AutoCode IDE 的“需求优化器”，只负责改写用户即将发送给 coding agent 的草稿。',
            '输出要求：',
            '1. 只输出优化后的请求正文，不解释优化过程，不加寒暄。',
            '2. 使用中文，表达专业、精炼、明确，适合 AI 直接执行。',
            '3. 保留用户原意、文件名、路径、命令、错误信息、约束和验收目标，不要凭空增加需求。',
            '4. 如果需求较长，整理为“目标 / 具体要求 / 约束 / 验证方式”；如果很短，保持简洁。',
            '5. 信息不足时，把关键不确定点写成简短的“需要确认”项，但不要扩大范围。',
            '6. 代码、命令、路径保持原样，必要时用 Markdown 代码格式包裹。',
          ].join('\n'),
        },
        {
          role: 'user' as const,
          content: [
            '请基于有限上下文优化下面这段用户需求。',
            '',
            '【有限上下文，仅用于本次改写，不代表正式会话上下文】',
            context,
            '',
            '【原始需求】',
            rawDraft,
          ].join('\n'),
        },
      ],
    }
  }

  private normalizeOptimizedComposerDraft(text: string) {
    let clean = text.trim()
    const fenced = clean.match(/^```(?:markdown|md|text)?\s*([\s\S]*?)\s*```$/i)
    if (fenced) clean = fenced[1].trim()
    clean = clean
      .replace(/^\s*(?:优化后的需求|优化后|改写后|结果)\s*[:：]\s*/i, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    return clean
  }

  private applyOptimizedComposerDraft(text: string, preserveUndo: boolean) {
    this.state.composerMode = 'text'
    this.renderComposer()
    const input = this.$<HTMLTextAreaElement>('#task-prompt')
    if (input) {
      input.value = text
      input.focus()
      input.selectionStart = input.value.length
      input.selectionEnd = input.value.length
    }
    this.composerDraft = text
    if (preserveUndo) this.scheduleComposerOptimizationUndoExpiry()
    else this.clearComposerOptimizationUndo(false)
    if (input) this.updateComposerSuggestions(input)
    this.scheduleSessionPersist()
    this.updateComposerSubmitButton()
  }

  private scheduleComposerOptimizationUndoExpiry() {
    this.clearComposerOptimizationUndoTimer()
    this.composerOptimizeUndoTimer = window.setTimeout(() => {
      this.composerOptimizeUndoTimer = 0
      if (!this.lastComposerPromptBeforeOptimize) return
      this.lastComposerPromptBeforeOptimize = ''
      this.updateComposerSubmitButton()
    }, 10000)
  }

  private clearComposerOptimizationUndo(updateButton = true) {
    this.clearComposerOptimizationUndoTimer()
    if (!this.lastComposerPromptBeforeOptimize) return
    this.lastComposerPromptBeforeOptimize = ''
    if (updateButton) this.updateComposerSubmitButton()
  }

  private clearComposerOptimizationUndoTimer() {
    if (!this.composerOptimizeUndoTimer) return
    window.clearTimeout(this.composerOptimizeUndoTimer)
    this.composerOptimizeUndoTimer = 0
  }

  private insertTextAtComposerCursor(text: string) {
    this.clearComposerOptimizationUndo(false)
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

  private attachmentContextRefs(attachments = this.state.attachments) {
    const visionSupported = this.currentProviderSupportsVision()
    return attachments.map((item, index) => {
      const lines = [
        `name=${item.name}`,
        `kind=${item.kind}`,
        `mime=${item.mime || ''}`,
        `size=${item.size || 0}`,
        item.path ? `path=${item.path}` : '',
        item.note ? `note=${item.note}` : '',
        item.text ? `text:\n${item.text.slice(0, 16000)}` : '',
        item.kind === 'image' && item.dataUrl && visionSupported ? `image_data_url=${item.dataUrl.slice(0, 120000)}` : '',
        item.kind === 'image' && item.dataUrl && !visionSupported ? 'vision_status=当前渠道未声明视觉能力，图片仅作为附件记录。' : '',
        item.preview && !item.preview.startsWith('data:') ? `preview=${item.preview}` : '',
      ].filter(Boolean)
      return {
        id: `attachment-${Date.now()}-${index}`,
        kind: item.kind === 'image' ? 'file' : 'workspace',
        label: `附件 ${item.name}`,
        value: `@附件\n${lines.join('\n')}`,
      }
    })
  }

  private currentProviderSupportsVision() {
    const provider = String(this.state.settings.provider_type || '').toLowerCase()
    const model = String(this.state.settings.model || '').toLowerCase()
    if (provider.includes('anthropic') || provider.includes('responses') || provider.includes('openai') || provider.includes('grok') || provider.includes('qwen') || provider.includes('kimi') || provider.includes('zhipu')) return true
    return /vision|vl|gpt-4o|gpt-5|claude|qwen-vl|glm-4v|glm-v|kimi|moonshot|gemini|grok/i.test(model)
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
      <button data-editor-copy-path="relative"><span>↪</span><div><strong>复制相对路径</strong><small>${escapeHtml(tab.path)}</small></div></button>
      <button data-editor-copy-path="absolute"><span>⛶</span><div><strong>复制绝对路径</strong><small>完整磁盘路径</small></div></button>
      <button data-editor-copy-path="name"><span>文</span><div><strong>复制文件名</strong><small>${escapeHtml(tab.name)}</small></div></button>
      <button data-editor-copy-path="parent"><span>⌂</span><div><strong>复制所在目录</strong><small>父目录</small></div></button>
      <button data-open-system-path="${escapeHtml(this.absolutePath(tab.path))}"><span>↗</span><div><strong>在资源管理器中显示</strong><small>打开真实文件位置</small></div></button>
    `
    const rect = anchor.getBoundingClientRect()
    menu.style.left = `${Math.max(8, rect.left)}px`
    menu.style.top = `${rect.bottom + 6}px`
    menu.removeAttribute('hidden')
  }

  private async copyEditorPath(kind: 'relative' | 'absolute' | 'name' | 'parent' = 'relative', button?: HTMLElement) {
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
    try {
      await navigator.clipboard.writeText(value)
      this.setInlineActionFeedback(button, 'ok', '已复制')
      this.hideContextMenu()
      this.toast('编辑器文件路径已复制', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '复制失败')
      this.toast(`复制路径失败：${String(error)}`, 'error')
    }
  }

  private async copyActivePath(kind: 'relative' | 'absolute' | 'name' | 'parent' = 'relative', button?: HTMLElement) {
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
    try {
      await navigator.clipboard.writeText(value)
      this.setInlineActionFeedback(button, 'ok', '已复制')
      this.hideContextMenu()
      this.toast('路径已复制', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '复制失败')
      this.toast(`复制路径失败：${String(error)}`, 'error')
    }
  }

  private async openSelectedPathInExplorer(button?: HTMLElement) {
    const path = this.selectedWorkspacePath()
    if (!path) return this.toast('请先在资源管理器中选择文件或目录', 'idle')
    await this.openSystemPath(this.absolutePath(path), button)
  }

  private async openSystemPath(path: string, button?: HTMLElement) {
    if (!path) return this.toast('没有可打开的路径', 'idle')
    try {
      this.setInlineActionFeedback(button, 'loading', '打开中...')
      await invoke<void>('ide_open_path', { path })
      this.setInlineActionFeedback(button, 'ok', '已打开')
      this.hideContextMenu()
      this.toast('已打开系统资源管理器', 'ok')
    } catch (error) {
      this.setInlineActionFeedback(button, 'error', '打开失败')
      this.toast(`打开资源管理器失败：${String(error)}`, 'error')
    }
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

