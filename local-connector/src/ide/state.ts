import type {
  AgentRuntimeState,
  AppState,
  Attachment,
  ChatMessage,
  ContextChip,
  EditorTab,
  IdeSettings,
  LayoutState,
  RecentProject,
  TerminalSessionRecord,
} from './types'

const layoutKey = 'autocode.ide.layout.v2'
const themeKey = 'autocode.ide.theme.v1'
const sessionKey = 'autocode.ide.session.v1'

export type IdeSessionSnapshot = {
  version: 1
  savedAt: string
  settings?: IdeSettings
  theme?: AppState['theme']
  aiTemperature?: number
  aiContextBudget?: number
  aiSystemPrompt?: string
  currentProject: RecentProject | null
  activeActivity: AppState['activeActivity']
  activeDock: AppState['activeDock']
  composerMode: AppState['composerMode']
  composerDraft: string
  previewUrl: string
  workspace: {
    activePath: string
    selectedPath: string
    expandedDirs: string[]
    tabs: EditorTab[]
  }
  chat: ChatMessage[]
  contextChips: ContextChip[]
  attachments: Attachment[]
  agentRuntime: AgentRuntimeState
  terminal: AppState['terminal']
  terminalSessionId: string
  terminalSessions: TerminalSessionRecord[]
}

export function emptySettings(): IdeSettings {
  return {
    api_base_url: '',
    api_key: '',
    connection_mode: 'aiProvider',
    provider_type: 'openai-responses',
    model: '',
    reasoning_mode: 'auto',
    reasoning_effort: 'medium',
    reasoning_budget_tokens: 8192,
    reasoning_summary: true,
    custom_headers: {},
    transcription_model: '',
    default_shell: 'auto',
    default_workspace_path: '',
    last_workspace_path: '',
    preview_url: '',
    recent_projects: [],
    updated_at: '',
  }
}

export function defaultLayout(): LayoutState {
  return {
    explorerWidth: 300,
    assistantWidth: 380,
    bottomHeight: 260,
    explorerCollapsed: false,
    assistantCollapsed: false,
    bottomCollapsed: false,
  }
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(layoutKey)
    if (!raw) return defaultLayout()
    return { ...defaultLayout(), ...JSON.parse(raw) }
  } catch {
    return defaultLayout()
  }
}

export function saveLayout(layout: LayoutState) {
  localStorage.setItem(layoutKey, JSON.stringify(layout))
}

export function loadSessionSnapshot(): IdeSessionSnapshot | null {
  try {
    const raw = localStorage.getItem(sessionKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as IdeSessionSnapshot
    return parsed?.version === 1 ? parsed : null
  } catch {
    return null
  }
}

export function saveSessionSnapshot(snapshot: IdeSessionSnapshot) {
  try {
    localStorage.setItem(sessionKey, JSON.stringify(snapshot))
  } catch {
    // Ignore quota errors; local work is still saved on disk.
  }
}

export function createInitialState(): AppState {
  return {
    version: '',
    settings: emptySettings(),
    apiState: 'idle',
    apiMessage: '等待配置 API',
    activeActivity: 'explorer',
    activeDock: 'terminal',
    commandOpen: false,
    settingsOpen: false,
    layout: loadLayout(),
    workspace: {
      currentProject: null,
      tree: [],
      expandedDirs: [],
      selectedPath: '',
      activePath: '',
      tabs: [],
      searchResults: [],
    },
    ai: {
      current: null,
      polling: null,
      history: [
        {
          role: 'system',
          text: 'AI 工作台已就绪。打开项目后，我会基于本地文件、Git 状态和终端输出进行开发协作。',
          at: new Date().toISOString(),
        },
      ],
    },
    chat: [
      {
        id: 'welcome',
        role: 'system',
        text: '打开项目后直接在这里对话。Enter 发送，Ctrl+Enter 换行；可以引用当前文件、选区、终端输出或 Git diff。',
        at: new Date().toISOString(),
      },
    ],
    contextChips: [],
    skills: {
      items: [],
      loading: false,
      query: '',
    },
    providerCatalog: {
      models: [],
      account: '',
      loading: false,
      accountLoading: false,
      error: '',
      updatedAt: '',
    },
    requestTimeline: {
      state: 'idle',
      title: '等待请求',
      detail: 'AI 请求状态会显示在这里。',
      startedAt: 0,
      durationMs: 0,
      model: '',
      usage: '',
      reasoning: '',
      error: '',
    },
    agentRuntime: {
      sessionId: '',
      profileId: 'build',
      events: [],
      timeline: [],
      pendingPermissions: [],
      patchPreviews: [],
      thinking: '',
    },
    localServer: {
      ok: false,
      host: '127.0.0.1',
      port: null,
      baseUrl: '',
      latestEventId: 0,
    },
    terminal: {
      shell: '',
      running: false,
      cwd: '',
      health: 'idle',
      lastOutput: '',
    },
    terminalSessions: [],
    voice: {
      recording: false,
      transcribing: false,
      error: '',
      lastText: '',
    },
    previewUrl: '',
    theme: (localStorage.getItem(themeKey) as AppState['theme']) || 'auto-dark',
    composerMode: 'text',
    attachments: [],
    terminalSessionId: '',
    terminalBusy: false,
    problems: [],
  }
}

export function saveTheme(theme: AppState['theme']) {
  localStorage.setItem(themeKey, theme)
}
