import { invoke } from '@tauri-apps/api/core'
import type { AiProviderRequest, AiProviderResponse, IdeSessionSaveResult, IdeSettings, ProviderChannel, WorkspaceFileIndex } from './types'
import type { IdeSessionSnapshot } from './state'
import { normalizeBaseUrl } from './utils'

export class AutoCodeApi {
  constructor(private readonly getSettings: () => IdeSettings) {}

  async fetch<T>(path: string, init: RequestInit = {}): Promise<T> {
    const settings = this.getSettings()
    const base = normalizeBaseUrl(settings.api_base_url)
    if (!base) throw new Error('请先配置 API URL')

    const response = await invoke<any>('ide_api_request', {
      settings: { ...settings, api_base_url: base },
      method: init.method || 'GET',
      path,
      body: typeof init.body === 'string' ? init.body : init.body ? JSON.stringify(init.body) : null,
      timeoutSecs: 20,
    })

    if (response && typeof response === 'object' && 'code' in response && 'data' in response) {
      if (response.code !== 200 && response.code !== 0) throw new Error(response.message || 'API 请求失败')
      return response.data as T
    }
    return response as T
  }

  async test() {
    const settings = this.getSettings()
    const connectionMode = settings.connection_mode === 'webConnector' ? 'aiProvider' : settings.connection_mode
    if (connectionMode === 'aiProvider') {
      return await invoke<AiProviderResponse>('ide_test_provider', { settings })
    }
    try {
      return await this.fetch('/api/local-runner/connector/metadata', { method: 'GET' })
    } catch (firstError) {
      try {
        return await this.fetch('/api/tasks/tools', { method: 'GET' })
      } catch {
        throw firstError
      }
    }
  }

  createTask(body: Record<string, unknown>) {
    const connectionMode = this.getSettings().connection_mode === 'webConnector' ? 'aiProvider' : this.getSettings().connection_mode
    if (connectionMode !== 'autocodePlatform') {
      throw new Error('当前为本地 Provider 模式，不会请求 AutoCode 平台任务接口。')
    }
    return this.fetch<any>('/api/tasks', { method: 'POST', body: JSON.stringify(body) })
  }

  taskStatus(taskId: string) {
    return this.fetch<any>(`/api/tasks/${encodeURIComponent(taskId)}/status`, { method: 'GET' })
  }

  async listSkills() {
    const data = await this.fetch<any>('/api/v1/agent-registry?page=1&size=40', { method: 'GET' })
    return Array.isArray(data) ? data : data?.items || data?.records || data?.list || []
  }

  installSkill(agentId: string) {
    return this.fetch(`/api/v1/agent-registry/${encodeURIComponent(agentId)}/install`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }

  providerRequest(request: AiProviderRequest) {
    return invoke<AiProviderResponse>('ide_ai_request', {
      settings: this.getSettings(),
      request,
      stream: false,
    })
  }

  channelsList() {
    return invoke<ProviderChannel[]>('ide_channels_list')
  }

  channelSave(channel: ProviderChannel) {
    return invoke<ProviderChannel>('ide_channel_save', { channel })
  }

  channelDelete(channelId: string) {
    return invoke<any>('ide_channel_delete', { channelId })
  }

  channelTest(channelId: string, purpose = 'chat') {
    return invoke<AiProviderResponse>('ide_channel_test', { channelId, purpose })
  }

  channelRefreshModels(channelId: string) {
    return invoke<any>('ide_channel_refresh_models', { channelId })
  }

  channelAccountStatus(channelId: string) {
    return invoke<any>('ide_channel_account_status', { channelId })
  }

  providerRoute(purpose: string, modelHint?: string) {
    return invoke<any>('ide_provider_route', { purpose, modelHint: modelHint || null })
  }

  codeCompletion(request: Record<string, unknown>) {
    return invoke<any>('ide_code_completion', { request })
  }

  agentRun(request: AiProviderRequest, workspaceContext: Record<string, unknown>) {
    return invoke<any>('ide_agent_run', {
      settings: this.getSettings(),
      request,
      workspaceContext,
    })
  }

  formatWorkspaceContent(rootPath: string, path: string, content: string, lineEnding?: string) {
    return invoke<any>('ide_format_workspace_content', {
      rootPath,
      path,
      content,
      lineEnding: lineEnding || null,
    })
  }

  agentSessionStart(rootPath: string, profileId = 'build') {
    return invoke<any>('ide_agent_session_create', {
      rootPath,
      profileId,
      settings: this.getSettings(),
    })
  }

  agentSend(sessionId: string, message: string, contextRefs: unknown[] = []) {
    return invoke<any>('ide_agent_message_send', {
      sessionId,
      settings: this.getSettings(),
      message,
      contextRefs,
    })
  }

  agentApprove(sessionId: string, approvalId: string, granted: boolean, scope = granted ? 'once' : 'deny') {
    return invoke<any>('ide_agent_tool_approve', {
      sessionId,
      toolCallId: approvalId,
      decision: { granted, scope },
    })
  }

  agentContinue(sessionId: string) {
    return invoke<any>('ide_agent_continue', { sessionId })
  }

  agentCancel(sessionId: string) {
    return invoke<any>('ide_agent_cancel', { requestId: sessionId })
  }

  agentFork(sessionId: string, label = 'Forked session') {
    return invoke<any>('ide_agent_session_fork', { sessionId, label })
  }

  agentDeleteSession(sessionId: string) {
    return invoke<any>('ide_agent_session_delete', { sessionId })
  }

  agentCompactSession(sessionId: string, reason = 'manual') {
    return invoke<any>('ide_agent_compact_session', { sessionId, reason })
  }

  agentCheckpointCreate(sessionId: string, label = 'Manual checkpoint', paths?: string[]) {
    return invoke<any>('ide_agent_checkpoint_create', { sessionId, label, paths })
  }

  agentCheckpointRevert(sessionId: string, checkpointId: string) {
    return invoke<any>('ide_agent_checkpoint_revert', { sessionId, checkpointId })
  }

  agentMemoryRead(rootPath: string) {
    return invoke<any>('ide_agent_memory_read', { rootPath })
  }

  initializeAutocodeProject(rootPath: string) {
    return invoke<any>('ide_initialize_autocode_project_files', { rootPath })
  }

  agentMemoryUpdate(rootPath: string, patch: string) {
    return invoke<any>('ide_agent_memory_update', { rootPath, patch })
  }

  agentPlanSave(rootPath: string, plan: unknown) {
    return invoke<any>('ide_agent_plan_save', { rootPath, plan })
  }

  agentMemoryApply(rootPath: string, patch: string, approvals: unknown[] = []) {
    return invoke<any>('ide_agent_memory_apply', { rootPath, patch, approvals })
  }

  agentSubagentRun(sessionId: string, profileId: string, task: string, contextRefs: unknown[] = []) {
    return invoke<any>('ide_agent_subagent_run', { sessionId, profileId, task, contextRefs })
  }

  agentProcesses(rootPath?: string | null) {
    return invoke<any>('ide_agent_processes', { rootPath: rootPath || null })
  }

  agentProcessKill(processId: string) {
    return invoke<any>('ide_agent_process_kill', { processId })
  }

  gitInit(rootPath: string) {
    return invoke<any>('ide_git_init', { rootPath })
  }

  gitStage(rootPath: string, paths: string[] = []) {
    return invoke<any>('ide_git_stage', { rootPath, paths })
  }

  gitUnstage(rootPath: string, paths: string[] = []) {
    return invoke<any>('ide_git_unstage', { rootPath, paths })
  }

  gitCommit(rootPath: string, message: string) {
    return invoke<any>('ide_git_commit', { rootPath, message })
  }

  gitFileDiff(rootPath: string, path: string, staged = false) {
    return invoke<any>('ide_git_file_diff', { rootPath, path, staged })
  }

  gitCommitShow(rootPath: string, commitHash: string) {
    return invoke<any>('ide_git_commit_show', { rootPath, commitHash })
  }

  workspaceFileIndex(rootPath: string, maxFiles = 8000) {
    return invoke<WorkspaceFileIndex>('ide_workspace_file_index', { rootPath, maxFiles })
  }

  attachmentPreview(path: string) {
    return invoke<any>('ide_read_attachment_preview', { path })
  }

  agentTools(rootPath?: string | null, profileId = 'build') {
    return invoke<any>('ide_agent_tools', {
      rootPath: rootPath || null,
      profileId,
      settings: this.getSettings(),
    })
  }

  agentProfiles() {
    return invoke<any>('ide_agent_profiles', { settings: this.getSettings() })
  }

  agentSmokeCheck(rootPath?: string | null, previewUrl?: string | null) {
    return invoke<any>('ide_agent_smoke_check', {
      rootPath: rootPath || null,
      previewUrl: previewUrl || null,
    })
  }

  hookRun(event: string, payload: unknown) {
    return invoke<any>('ide_hook_run', { event, payload })
  }

  mcpServers(rootPath: string) {
    return invoke<any>('ide_mcp_servers', { rootPath })
  }

  lspRequest(rootPath: string, method: string, params: unknown = {}) {
    return invoke<any>('ide_lsp_request', { rootPath, method, params })
  }

  agentSessionSnapshot(sessionId: string) {
    return invoke<any>('ide_agent_session_snapshot', { sessionId })
  }

  agentSessions(rootPath?: string | null) {
    return invoke<any[]>('ide_agent_sessions', { rootPath: rootPath || null })
  }

  localServerStatus() {
    return invoke<any>('ide_local_server_status')
  }

  refreshModels() {
    return invoke<any>('ide_provider_model_refresh', { settings: this.getSettings() })
  }

  accountStatus() {
    return invoke<any>('ide_provider_account_status', { settings: this.getSettings() })
  }

  loadSession(rootPath?: string | null) {
    return invoke<IdeSessionSnapshot | null>('ide_session_load', { rootPath: rootPath || null })
  }

  saveSession(rootPath: string, snapshot: IdeSessionSnapshot) {
    return invoke<IdeSessionSaveResult>('ide_session_save', { rootPath, snapshot })
  }

  updateCheck(settings = this.getSettings()) {
    return invoke<any>('ide_update_check', { settings })
  }

  updateInstall(settings = this.getSettings()) {
    return invoke<any>('ide_update_install', { settings })
  }

  windowsSpeechTranscribe(audioPath: string, language = 'zh-CN') {
    return invoke<any>('ide_windows_speech_transcribe', { audioPath, language })
  }

  offlineSttStatus() {
    return invoke<any>('ide_offline_stt_status', { settings: this.getSettings() })
  }

  offlineSttDownloadModel(modelId: string, proxyUrl = '') {
    return invoke<any>('ide_offline_stt_download_model', { modelId, proxyUrl: proxyUrl || null })
  }

  offlineSttCancelDownload(modelId: string) {
    return invoke<any>('ide_offline_stt_cancel_download', { modelId })
  }

  offlineSttTranscribe(audioPath: string, modelId?: string) {
    return invoke<any>('ide_offline_stt_transcribe', {
      settings: this.getSettings(),
      audioPath,
      modelId: modelId || null,
    })
  }

  setDefaultShell(shell: string) {
    return invoke<IdeSettings>('ide_terminal_set_default_shell', { shell })
  }

  transcribeAudio(audioPath: string, model?: string) {
    return invoke<any>('ide_transcribe_audio', {
      settings: this.getSettings(),
      audioPath,
      model: model || null,
    })
  }
}
