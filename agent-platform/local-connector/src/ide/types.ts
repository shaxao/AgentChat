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
    | 'qwen-responses'
    | 'deepseek'
    | 'kimi'
    | 'zhipu'
    | 'xai-grok'
    | 'local-openai-compatible'
    | 'custom-openai-compatible'
    | string
  api_protocol: 'auto' | 'responses' | 'chat_completions' | string
  model: string
  reasoning_mode: 'off' | 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'custom' | string
  reasoning_effort: string
  reasoning_budget_tokens: number
  reasoning_summary: boolean
  custom_headers: Record<string, string>
  channels: ProviderChannel[]
  default_routes: ProviderDefaultRoutes
  code_completion: CodeCompletionSettings
  transcription_model: string
  offline_stt_enabled: boolean
  offline_stt_engine: string
  offline_stt_model: string
  default_shell: string
  default_workspace_path: string
  last_workspace_path: string
  preview_url: string
  ui_font_size: number
  code_font_size: number
  ui_font_family: string
  code_font_family: string
  appearance_density: 'comfortable' | 'compact' | string
  ui_contrast: number
  reduced_motion: 'system' | 'on' | 'off' | string
  desktop_notifications_enabled: boolean
  desktop_notification_sound_enabled: boolean
  notify_on_agent_waiting: boolean
  notify_on_agent_done: boolean
  notify_on_agent_failed: boolean
  auto_update_enabled: boolean
  update_manifest_url: string
  update_public_key: string
  update_check_on_startup: boolean
  update_check_interval_hours: number
  last_update_check_at: string
  skipped_update_version: string
  recent_projects: RecentProject[]
  approval_mode: 'suggest' | 'autoEdit' | 'fullAuto' | 'custom' | string
  permission_policy: unknown
  agent_profiles: unknown
  subagents: unknown
  hooks: unknown
  mcp_servers: unknown
  memory_files: string[]
  context_budget: number
  auto_compact_threshold: number
  checkpoint_policy: string
  updated_at: string
}

export type ProviderPurpose =
  | 'chat'
  | 'agent'
  | 'reasoning'
  | 'codeCompletion'
  | 'vision'
  | 'audioTranscription'
  | 'embedding'
  | string

export type ProviderChannel = {
  id: string
  name: string
  provider_type: string
  api_protocol?: 'auto' | 'responses' | 'chat_completions' | string
  api_base_url: string
  api_key: string
  custom_headers: Record<string, string>
  enabled: boolean
  priority: number
  weight: number
  purposes: ProviderPurpose[]
  models: string[]
  enabled_models: string[]
  model_filter_configured: boolean
  default_model: string
  code_completion_model: string
  account_status: string
  last_error: string
  capabilities: Record<string, unknown>
  updated_at: string
}

export type ProviderDefaultRoutes = Record<string, string>

export type CodeCompletionSettings = {
  enabled: boolean
  trigger: 'idle' | 'manual' | string
  debounce_ms: number
  max_prefix_chars: number
  max_suffix_chars: number
  model: string
  channel_id: string
  prompt: string
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

export type WorkspaceFileIndexItem = {
  path: string
  name: string
  parent: string
  size: number
  modified_at: string
}

export type WorkspaceFileIndex = {
  files: WorkspaceFileIndexItem[]
  dirs?: WorkspaceFileIndexItem[]
  generated_at: string
  truncated: boolean
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
  repository: boolean
  staged_count: number
  unstaged_count: number
  untracked_count: number
  summary: string
  repository_message?: string
  diff: string
  staged_diff?: string
  unstaged_diff?: string
  status_short?: string
  files?: WorkspaceGitFile[]
  grouped_files?: WorkspaceGitGroups
  recent_commits?: WorkspaceGitCommit[]
  untracked_files?: string[]
  skipped_paths?: string[]
}

export type WorkspaceGitFile = {
  path: string
  index_status: string
  worktree_status: string
  kind: 'staged' | 'unstaged' | 'staged+unstaged' | 'untracked' | string
  parent?: string
  name?: string
  staged?: boolean
  unstaged?: boolean
  untracked?: boolean
}

export type WorkspaceGitGroups = {
  staged: WorkspaceGitFile[]
  unstaged: WorkspaceGitFile[]
  untracked: WorkspaceGitFile[]
}

export type WorkspaceGitCommit = {
  hash: string
  short_hash: string
  subject: string
  author: string
  relative_time: string
  timestamp: string
}

export type ApiState = 'idle' | 'ok' | 'busy' | 'error'
export type DockTab = 'terminal' | 'preview' | 'git' | 'problems' | 'skills'
export type ActivityView = 'explorer' | 'search' | 'git' | 'skills' | 'channels' | 'recent' | 'settings'

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

export type MainRegion = 'side' | 'workbench' | 'assistant'

export type LayoutState = {
  explorerWidth: number
  assistantWidth: number
  workbenchSideWidth: number
  bottomHeight: number
  explorerCollapsed: boolean
  assistantCollapsed: boolean
  bottomCollapsed: boolean
  regionOrder: MainRegion[]
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
  attachments?: Attachment[]
  queued?: { id: string; status: QueuedUserMessage['status'] }
  reasoning?: string
  usage?: string
  toolCalls?: ToolCallRecord[]
  pendingPermissions?: PermissionRequest[]
  patchPreviews?: PatchPreview[]
  compactedSummary?: unknown
  checkpointIds?: string[]
  plan?: AgentApprovedPlan
}

export type AgentPlanTodo = {
  text: string
  status: 'pending' | 'running' | 'completed' | 'failed' | string
  source?: 'plan' | 'test' | 'manual' | string
}

export type AgentApprovedPlan = {
  id: string
  title: string
  content: string
  todos: AgentPlanTodo[]
  answers: string[]
  createdAt: string
  planFilePath?: string
  executionReady?: boolean
  planKind?: 'development' | 'analysis' | 'documentation' | string
}

export type PlanningConfirmationState = {
  status:
    | 'idle'
    | 'collecting_requirements'
    | 'waiting_user_confirmation'
    | 'answering_user_followup'
    | 'ready_to_plan'
    | 'plan_generated'
    | string
  answers: string[]
  openQuestions: string[]
  confirmedRequirements: string[]
}

export type PlanDevelopmentState = {
  status:
    | 'idle'
    | 'executing_plan'
    | 'waiting_permission'
    | 'waiting_question'
    | 'blocked'
    | 'completed'
    | 'cancelled'
    | 'reverted'
    | string
  planId: string
  planFilePath: string
  activeTodoId?: string
  todoItems: AgentPlanTodo[]
  completedTodoIds: string[]
  blockedReason?: string
  validationStatus?: string
  checkpointIds: string[]
  continuationCount?: number
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
  textAnchor?: number
  subagent?: boolean
  subagentId?: string
  internal?: boolean
  patchDiagnostics?: unknown
}

export type AgentPhaseRecord = {
  phase: string
  status: 'running' | 'done' | 'error' | string
  label: string
  detail: string
  startedAt?: string
  durationMs?: number
  at?: string
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
    | 'agent_phase'
    | 'reasoning_delta'
    | 'permission_request'
    | 'patch_preview'
    | 'step_limit_reached'
    | 'context_compaction_start'
    | 'context_compaction_result'
    | 'context_compaction_error'
    | 'checkpoint_created'
    | 'checkpoint_reverted'
    | 'cancellation_requested'
    | 'agent_injected_message'
    | 'memory_read'
    | 'memory_update_preview'
    | 'memory_update_applied'
    | 'subagent_start'
    | 'subagent_result'
    | 'hook_start'
    | 'hook_result'
    | 'process_start'
    | 'process_output'
    | 'process_exit'
    | 'lsp_diagnostics'
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
  activeTurnId?: string
  activeRequestId?: string
  queuedUserMessages: QueuedUserMessage[]
  phase?: AgentPhaseRecord
  phaseHistory: AgentPhaseRecord[]
  events: AgentEvent[]
  timeline: ToolCallRecord[]
  pendingPermissions: PermissionRequest[]
  patchPreviews: PatchPreview[]
  thinking: string
  status: 'idle' | 'running' | 'waiting_permission' | 'waiting_question' | 'compacting' | 'cancelling' | 'paused' | 'paused_step_limit' | 'completed' | 'failed' | 'cancelled' | string
  resumeReason?: string
  stepCount: number
  compactionCount: number
  compactedSummary: unknown | null
  checkpoints: unknown[]
  memoryRefs: unknown[]
  sessions: unknown[]
  subagents: unknown[]
  processes: unknown[]
  profiles: unknown[]
  hooks: unknown[]
  smokeChecks: unknown[]
  tools: unknown[]
  mcpTools: unknown[]
  diagnostics: unknown[]
  approvedPlan?: AgentApprovedPlan | null
  planTodos?: AgentPlanTodo[]
  planningAnswers?: string[]
  planningConfirmation?: PlanningConfirmationState
  planDevelopment?: PlanDevelopmentState
}

export type QueuedUserMessage = {
  id: string
  text: string
  attachments: Attachment[]
  contextRefs: unknown[]
  createdAt: string
  status: 'queued' | 'processing' | 'consumed' | 'failed' | 'injected'
  priority?: number
  error?: string
}

export type LocalServerState = {
  ok: boolean
  host: string
  port: number | null
  baseUrl: string
  latestEventId?: number
  name?: string
  version?: string
  capabilities: string[]
  checkedAt?: string
  error?: string
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
  kind: 'read' | 'write' | 'command' | 'tool'
  target: string
  reason: string
  risk: 'low' | 'medium' | 'high'
}

export type PatchPreview = {
  id: string
  files: FileOperationPreview[]
  patch: string
  requiresApproval: boolean
  kind?: 'patch' | 'memory' | string
  patchKind?: 'codex' | 'unified' | string
  summary?: string
  diagnostics?: unknown[]
}

export type AgentPermissionGrant = {
  kind: 'read' | 'write' | 'command' | 'tool'
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
  git: WorkspaceGitStatus | null
}

export type ComposerMode = 'text' | 'image' | 'voice' | 'file'

export type Attachment = {
  kind: 'image' | 'file'
  name: string
  path?: string
  size?: number
  mime?: string
  preview?: string
  dataUrl?: string
  text?: string
  readable?: boolean
  note?: string
  transient?: boolean
  source?: 'user' | 'voice-recording' | string
}

export type VoiceTranscriptionState = {
  recording: boolean
  transcribing: boolean
  error: string
  lastText: string
  offlineStt: OfflineSttStatus | null
  offlineBusy: boolean
  offlineDownload: OfflineSttDownloadProgress | null
}

export type OfflineSttDownloadProgress = {
  modelId: string
  phase: 'starting' | 'downloading' | 'extracting' | 'done' | 'error' | string
  bytes: number
  totalBytes?: number | null
  percent?: number | null
  message: string
  at: string
}

export type OfflineSttModel = {
  id: string
  name: string
  description: string
  sizeLabel: string
  accuracyLabel: string
  latencyLabel: string
  kind: string
  installed: boolean
  path: string
  downloadUrl: string
  modelKind: string
  active: boolean
}

export type OfflineSttStatus = {
  enabled: boolean
  engine: string
  activeModel: string
  binaryFound: boolean
  binaryPath: string
  dataDir: string
  models: OfflineSttModel[]
  message: string
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
