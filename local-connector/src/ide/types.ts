export type RecentProject = {
  path: string
  name: string
  task_id: string
  preview_url: string
  last_opened_at: string
}

export type IdeSettings = {
  api_base_url: string
  api_key: string
  connection_mode: 'autocodePlatform' | 'aiProvider' | 'webConnector' | string
  provider_type:
    | 'openai-responses'
    | 'openai-chat'
    | 'anthropic-messages'
    | 'dashscope-qwen'
    | 'deepseek'
    | 'kimi'
    | 'xai-grok'
    | 'custom-openai-compatible'
    | string
  model: string
  reasoning_mode: 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'custom' | string
  reasoning_effort: string
  reasoning_budget_tokens: number
  reasoning_summary: boolean
  custom_headers: Record<string, string>
  transcription_model: string
  default_shell: string
  default_workspace_path: string
  last_workspace_path: string
  preview_url: string
  recent_projects: RecentProject[]
  updated_at: string
}

export type IdeBootstrap = {
  version: string
  default_api_base_url: string
  settings: IdeSettings
}

export type WorkspaceEntry = {
  name: string
  path: string
  kind: 'dir' | 'file' | string
  size: number
  modified_at: string
  hidden: boolean
  children: WorkspaceEntry[]
  loaded?: boolean
}

export type WorkspaceFileSnapshot = {
  path: string
  absolute_path: string
  content: string
  encoding: string
  line_ending: string
  size: number
  modified_at: string
}

export type WorkspaceFileStat = {
  path: string
  absolute_path: string
  kind: string
  size: number
  modified_at: string
  hash: string
  exists: boolean
}

export type WorkspaceSearchResult = {
  path: string
  name: string
  kind: string
  size: number
  modified_at: string
  line: number
  preview: string
}

export type WorkspaceCommandResult = {
  command: string
  cwd: string
  ok: boolean
  exit_code: number
  output: string
  truncated: boolean
}

export type WorkspaceGitStatus = {
  branch: string
  ahead: number
  behind: number
  staged_count: number
  unstaged_count: number
  untracked_count: number
  summary: string
  diff: string
}

export type ApiState = 'idle' | 'ok' | 'busy' | 'error'
export type DockTab = 'terminal' | 'preview' | 'git' | 'problems' | 'skills'
export type ActivityView = 'explorer' | 'search' | 'git' | 'skills' | 'settings'

export type EditorTab = {
  path: string
  name: string
  draft: string
  original: string
  encoding: string
  lineEnding: string
  modifiedAt: string
  size: number
  language: string
  loading?: boolean
  error?: string
}

export type LayoutState = {
  explorerWidth: number
  assistantWidth: number
  bottomHeight: number
  explorerCollapsed: boolean
  assistantCollapsed: boolean
  bottomCollapsed: boolean
}

export type AiTaskState = {
  current: any | null
  polling: number | null
  history: Array<{ role: 'user' | 'assistant' | 'system'; text: string; at: string }>
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system' | 'error'
  text: string
  at: string
  reasoning?: string
  usage?: string
  toolCalls?: ToolCallRecord[]
}

export type ChatRenderableBlock = {
  kind: 'markdown' | 'code' | 'diff' | 'tool' | 'file'
  language?: string
  content: string
  path?: string
  toolName?: string
}

export type ToolCallRecord = {
  id: string
  name: string
  status: 'pending' | 'running' | 'approval_required' | 'ok' | 'error'
  input: unknown
  output?: unknown
  error?: string
  startedAt: string
  finishedAt?: string
}

export type AgentEvent = {
  id?: number
  sessionId: string
  type:
    | 'message_part'
    | 'message_delta'
    | 'tool_call_start'
    | 'tool_call_delta'
    | 'tool_call_result'
    | 'tool_start'
    | 'tool_result'
    | 'reasoning_delta'
    | 'permission_request'
    | 'patch_preview'
    | 'usage'
    | 'error'
    | 'session_done'
    | 'done'
  payload: unknown
  at: string
}

export type AgentRuntimeState = {
  sessionId: string
  profileId: 'build' | 'plan' | string
  events: AgentEvent[]
  timeline: ToolCallRecord[]
  pendingPermissions: PermissionRequest[]
  patchPreviews: PatchPreview[]
  thinking: string
}

export type LocalServerState = {
  ok: boolean
  host: string
  port: number | null
  baseUrl: string
  latestEventId?: number
}

export type AgentSession = {
  id: string
  rootPath: string
  provider: string
  model: string
  messages: ChatMessage[]
  toolCalls: ToolCallRecord[]
  permissions: AgentPermissionGrant[]
  createdAt: string
  updatedAt: string
}

export type PermissionRequest = {
  id: string
  kind: 'read' | 'write' | 'command'
  target: string
  reason: string
  risk: 'low' | 'medium' | 'high'
}

export type PatchPreview = {
  id: string
  files: FileOperationPreview[]
  patch: string
  requiresApproval: boolean
}

export type AgentPermissionGrant = {
  kind: 'read' | 'write' | 'command'
  target?: string
  granted: boolean
  at: string
}

export type FileOperationPreview = {
  path: string
  operation: 'create' | 'update' | 'delete' | 'rename'
  diff: string
  risk: 'low' | 'medium' | 'high'
}

export type ContextChip = {
  id: string
  label: string
  value: string
  kind: 'file' | 'selection' | 'terminal' | 'git' | 'workspace'
}

export type SkillState = {
  items: any[]
  loading: boolean
  query: string
  error?: string
}

export type ProviderCatalogState = {
  models: string[]
  account: string
  loading: boolean
  accountLoading: boolean
  error: string
  updatedAt: string
}

export type RequestTimelineState = {
  state: 'idle' | 'busy' | 'ok' | 'error'
  title: string
  detail: string
  startedAt: number
  durationMs: number
  model: string
  usage: string
  reasoning: string
  error: string
}

export type TerminalState = {
  shell: string
  running: boolean
  cwd: string
  health: 'idle' | 'starting' | 'ready' | 'unresponsive' | 'error'
  lastOutput: string
}

export type TerminalSessionRecord = {
  id: string
  shell: string
  cwd: string
  label: string
  lastOutput: string
  createdAt: string
  health: TerminalState['health']
  localEcho?: boolean
  commandMode?: boolean
}

export type IdeSessionSaveResult = {
  ok: boolean
  savedAt: string
}

export type WorkspaceState = {
  currentProject: RecentProject | null
  tree: WorkspaceEntry[]
  expandedDirs: string[]
  selectedPath: string
  activePath: string
  tabs: EditorTab[]
  searchResults: WorkspaceSearchResult[]
}

export type ComposerMode = 'text' | 'image' | 'voice' | 'file'

export type Attachment = {
  kind: 'image' | 'file'
  name: string
  path?: string
  size?: number
  mime?: string
  preview?: string
  text?: string
}

export type VoiceTranscriptionState = {
  recording: boolean
  transcribing: boolean
  error: string
  lastText: string
}

export type AiProviderMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type AiProviderRequest = {
  messages: AiProviderMessage[]
  temperature?: number
  maxTokens?: number
}

export type AiProviderResponse = {
  answer: string
  reasoningSummary: string
  reasoningRaw: string
  toolCalls: any[]
  usage: any | null
  finishReason: string
  provider: string
  model: string
}

export type AppState = {
  version: string
  settings: IdeSettings
  apiState: ApiState
  apiMessage: string
  activeActivity: ActivityView
  activeDock: DockTab
  commandOpen: boolean
  settingsOpen: boolean
  layout: LayoutState
  workspace: WorkspaceState
  ai: AiTaskState
  chat: ChatMessage[]
  contextChips: ContextChip[]
  skills: SkillState
  providerCatalog: ProviderCatalogState
  requestTimeline: RequestTimelineState
  agentRuntime: AgentRuntimeState
  localServer: LocalServerState
  terminal: TerminalState
  terminalSessions: TerminalSessionRecord[]
  voice: VoiceTranscriptionState
  previewUrl: string
  theme: 'auto-dark' | 'graphite' | 'light'
  composerMode: ComposerMode
  attachments: Attachment[]
  terminalSessionId: string
  terminalBusy: boolean
  problems: string[]
}
