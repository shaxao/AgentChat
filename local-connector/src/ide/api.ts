import { invoke } from '@tauri-apps/api/core'
import type { AiProviderRequest, AiProviderResponse, IdeSessionSaveResult, IdeSettings } from './types'
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
    if (settings.connection_mode === 'aiProvider') {
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
    if (this.getSettings().connection_mode !== 'autocodePlatform') {
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

  agentRun(request: AiProviderRequest, workspaceContext: Record<string, unknown>) {
    return invoke<any>('ide_agent_run', {
      settings: this.getSettings(),
      request,
      workspaceContext,
    })
  }

  agentSessionStart(rootPath: string) {
    return invoke<any>('ide_agent_session_create', {
      rootPath,
      profileId: 'build',
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

  agentApprove(sessionId: string, approvalId: string, granted: boolean) {
    return invoke<any>('ide_agent_tool_approve', {
      sessionId,
      toolCallId: approvalId,
      decision: { granted },
    })
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

  windowsSpeechTranscribe(audioPath: string, language = 'zh-CN') {
    return invoke<any>('ide_windows_speech_transcribe', { audioPath, language })
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
