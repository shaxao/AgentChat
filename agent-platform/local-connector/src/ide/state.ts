import type {
  AgentRuntimeState,
  AppState,
  Attachment,
  ChatMessage,
  ContextChip,
  EditorTab,
  IdeSettings,
  LayoutState,
  MainRegion,
  RecentProject,
  TerminalSessionRecord,
} from './types'

const layoutKey = 'autocode.ide.layout.v2'
const themeKey = 'autocode.ide.theme.v1'
const sessionKey = 'autocode.ide.session.v1'
const defaultRegionOrder: MainRegion[] = ['side', 'workbench', 'assistant']

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
    api_protocol: '',
    model: '',
    reasoning_mode: 'auto',
    reasoning_effort: 'medium',
    reasoning_budget_tokens: 8192,
    reasoning_summary: true,
    custom_headers: {},
    channels: [],
    default_routes: {
      chat: 'default',
      agent: 'default',
      reasoning: 'default',
      codeCompletion: 'default',
      audioTranscription: 'default',
    },
    code_completion: {
      enabled: true,
      trigger: 'idle',
      debounce_ms: 750,
      max_prefix_chars: 5000,
      max_suffix_chars: 2000,
      model: '',
      channel_id: '',
      prompt: '只返回应该插入到光标位置的代码，不要解释，不要 Markdown，不要代码围栏，不要重复已有前缀。',
    },
    transcription_model: '',
    offline_stt_enabled: true,
    offline_stt_engine: 'sherpa-onnx',
    offline_stt_model: 'zh-streaming-small',
    default_shell: 'auto',
    default_workspace_path: '',
    last_workspace_path: '',
    preview_url: '',
    ui_font_size: 14,
    code_font_size: 12,
    ui_font_family: 'Inter, "Segoe UI", "Microsoft YaHei", Arial, sans-serif',
    code_font_family: '"Cascadia Code", Consolas, monospace',
    appearance_density: 'comfortable',
    ui_contrast: 100,
    reduced_motion: 'system',
    desktop_notifications_enabled: true,
    desktop_notification_sound_enabled: true,
    notify_on_agent_waiting: true,
    notify_on_agent_done: true,
    notify_on_agent_failed: true,
    auto_update_enabled: true,
    update_manifest_url: '',
    update_public_key: '',
    update_check_on_startup: true,
    update_check_interval_hours: 12,
    last_update_check_at: '',
    skipped_update_version: '',
    recent_projects: [],
    approval_mode: 'autoEdit',
    permission_policy: {},
    agent_profiles: [],
    subagents: [],
    hooks: [],
    mcp_servers: [],
    memory_files: ['.autocode/AGENTS.md', '.autocode/memory.md', '.autocode/settings.json'],
    context_budget: 18000,
    auto_compact_threshold: 24000,
    checkpoint_policy: 'before_write',
    updated_at: '',
  }
}

export function defaultLayout(): LayoutState {
  return {
    explorerWidth: 300,
    assistantWidth: 380,
    workbenchSideWidth: 560,
    bottomHeight: 260,
    explorerCollapsed: false,
    assistantCollapsed: false,
    bottomCollapsed: false,
    regionOrder: [...defaultRegionOrder],
  }
}

function normalizeRegionOrder(value: unknown): MainRegion[] {
  if (!Array.isArray(value)) return [...defaultRegionOrder]
  const allowed = new Set<MainRegion>(defaultRegionOrder)
  const next = value.filter((item): item is MainRegion => allowed.has(item as MainRegion))
  return next.length === 3 && new Set(next).size === 3 ? next : [...defaultRegionOrder]
}

export function loadLayout(): LayoutState {
  try {
    const raw = localStorage.getItem(layoutKey)
    if (!raw) return defaultLayout()
    const parsed = JSON.parse(raw)
    return { ...defaultLayout(), ...parsed, regionOrder: normalizeRegionOrder(parsed?.regionOrder) }
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
      git: null,
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
      profiles: [],
      hooks: [],
      smokeChecks: [],
      tools: [],
      mcpTools: [],
      diagnostics: [],
      approvedPlan: null,
      planTodos: [],
      planningAnswers: [],
      planningConfirmation: {
        status: 'idle',
        answers: [],
        openQuestions: [],
        confirmedRequirements: [],
      },
      planDevelopment: {
        status: 'idle',
        planId: '',
        planFilePath: '',
        todoItems: [],
        completedTodoIds: [],
        checkpointIds: [],
        continuationCount: 0,
      },
    },
    localServer: {
      ok: false,
      host: '127.0.0.1',
      port: null,
      baseUrl: '',
      latestEventId: 0,
      capabilities: [],
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
      offlineStt: null,
      offlineBusy: false,
      offlineDownload: null,
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
