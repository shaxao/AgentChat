/**
 *
 * 自动识别 VITE_DEMO_MODE。
 *
 */
import { useChatStore, useAuthStore, type ActiveScenario, type Model } from '@/store'
import { burstMonitor } from './useMemoryMonitor'
import { toast } from 'sonner'

export const BASE_URL = import.meta.env.VITE_API_URL || '/api'
const DEMO_MODE = import.meta.env.VITE_DEMO_MODE !== 'false' // 默认 true

function normalizeMojibakeMessage(message: unknown, fallback = '请求失败'): string {
  const raw = typeof message === 'string' ? message : ''
  const text = raw || fallback
  const replacements: Array<[RegExp, string]> = [
    [new RegExp("\u7487\u950b\u7730\u6fb6\u8fab\u89e6", 'g'), '请求失败'],
    [new RegExp("\u93c9\u51ae\u6aba\u6d93\u5d88\u51bb", 'g'), '权限不足'],
    [new RegExp("\u7f08\u660f\u7627\u6fb6\u8fab\u89e6", 'g'), '翻译失败'],
    [new RegExp("\u6d93\u5b2d\u6d47\u6fb6\u8fab\u89e6", 'g'), '下载失败'],
    [new RegExp("\u9422\u71b8\u579a\u6fb6\u8fab\u89e6\u951b\u5c83\ue1ec\u95b2\u5d88\u762f", 'g'), '生成失败，请重试'],
    [new RegExp("\u9352\u6d98\u7f13\u7035\u7845\u763d\u6fb6\u8fab\u89e6", 'g'), '创建对话失败'],
    [new RegExp("\u7035\u7845\u763d ID \u5bee\u509a\u7236\u951b\u5c83\ue1ec\u9352\u950b\u67ca\u6924\u7538\u6f70\u95b2\u5d88\u762f", 'g'), '对话 ID 异常，请刷新页面重试'],
    [new RegExp("\u93c2\u56e6\u6b22\u6d93\u5a41\u7d36\u6fb6\u8fab\u89e6", 'g'), '文件上传失败'],
    [new RegExp("OSS \u6d93\u5a41\u7d36\u6fb6\u8fab\u89e6", 'g'), 'OSS 上传失败'],
    [new RegExp("\u7487\ue162\u7176\u7487\u55d7\u57c6\u6fb6\u8fab\u89e6", 'g'), '语音识别失败'],
    [new RegExp("\u6d93\u5a41\u7d36\u6fb6\u8fab\u89e6", 'g'), '上传失败'],
    [new RegExp("\u6d93\u5a41\u7d36\u9352\u55d9\u5896", 'g'), '上传分片'],
    [new RegExp("\u7039\u5c7e\u579a\u9352\u55d9\u5896\u6d93\u5a41\u7d36\u6fb6\u8fab\u89e6", 'g'), '完成分片上传失败'],
    [new RegExp("\u5a34\u5fda\ue74d\u9363\u3124\u7b09\u93c0\ue21b\u5bd4\u5a34\u4f78\u7d21\u7487\u8bf2\u5f47", 'g'), '浏览器不支持流式读取'],
    [new RegExp("\u7f03\u6220\u7cb6\u95bf\u6b12\ue1e4", 'g'), '网络错误'],
    [new RegExp("\u947e\u5cf0\u5f47\u59af\u2033\u7037\u9352\u6944\u3003\u6fb6\u8fab\u89e6", 'g'), '获取模型列表失败'],
    [new RegExp("\u947e\u5cf0\u5f47\u5a13\u72bb\u4ebe\u59af\u2033\u7037\u9352\u6944\u3003\u6fb6\u8fab\u89e6", 'g'), '获取渠道模型列表失败'],
    [new RegExp("API \u6769\u65bf\u6d16\u95bf\u6b12\ue1e4", 'g'), 'API 返回错误'],
    [new RegExp("\u5a13\u72bb\u4ebe\u93c8\ue048\u53a4\u7f03", 'g'), '渠道未配置'],
    [new RegExp("\u7f01\u621d\u757e\u9428\u52ee\ue757\u9479\u8e6d\u7b09\u701b\u6a3a\u6e6a", 'g'), '绑定的角色不存在'],
  ]
  return replacements.reduce((acc, [pattern, value]) => acc.replace(pattern, value), text).replace(new RegExp("[\ufffd]+", 'g'), '').trim()
}

export function getToken(): string | null {
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return null
    const store = JSON.parse(raw)
    return store?.state?.token || null
  } catch {
    return null
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { noAuth?: boolean; signal?: AbortSignal }
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!opts?.noAuth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: opts?.signal })

  if (res.status === 401) {
    useAuthStore.getState().logout()
    throw new Error('登录已过期，请重新登录')
  }

  // HTTP 403: 权限不足
  if (res.status === 403) {
    const data = await res.json()
    const msg = normalizeMojibakeMessage(data.message, '权限不足')
    throw new Error(msg)
  }

  const data = await res.json()
  if (data.code !== 200) {
    const msg = normalizeMojibakeMessage(data.message, '请求失败')
    toast.error(msg)
    throw new Error(msg)
  }
  return data.data as T
}

// ==================== 数据类型 ====================
export interface UserVO {
  id: string; name: string; email: string; avatar?: string
  role: string; plan: 'free' | 'pro' | 'enterprise'
  tokensUsed: number; tokensLimit: number; costUsed?: number; costLimit?: number; createdAt: string
  status: 'active' | 'suspended'
}
export interface LoginResponse { token: string; user: UserVO }

export interface UserApiKeyVO {
  id: string
  name: string
  keyPrefix: string
  status: string
  createdAt?: string | null
  lastUsedAt?: string | null
  expiresAt?: string | null
}

export interface GenerateApiKeyResponse {
  apiKey: UserApiKeyVO
  key: string
}

export interface ConversationVO {
  id: string; title: string; model: string; pinned: boolean
  tags?: string[]; createdAt: string; updatedAt: string; messages?: MessageVO[]
  hasMore?: boolean
}
export interface MessageVO {
  id: string; role: 'user' | 'assistant' | 'system'
  content: string; model?: string; tokens?: number; timestamp: string
}

const SCENARIO_TAG_PREFIX = 'scenario:'
const SCENARIO_WORKFLOW_TAG_PREFIX = 'scenario-workflow:'

function scenarioTag(id: number) {
  return `${SCENARIO_TAG_PREFIX}${id}`
}

function parseScenarioId(tags?: string[]) {
  const tag = tags?.find(t => t.startsWith(SCENARIO_TAG_PREFIX))
  if (!tag) return null
  const id = Number(tag.slice(SCENARIO_TAG_PREFIX.length))
  return Number.isFinite(id) && id > 0 ? id : null
}

function scenarioWorkflowTag(id: number) {
  return `${SCENARIO_WORKFLOW_TAG_PREFIX}${id}`
}

export function buildScenarioWorkflowTag(id: number) {
  return scenarioWorkflowTag(id)
}

function parseScenarioWorkflowIds(tags?: string[]) {
  return (tags || [])
    .filter(t => t.startsWith(SCENARIO_WORKFLOW_TAG_PREFIX))
    .map(t => Number(t.slice(SCENARIO_WORKFLOW_TAG_PREFIX.length)))
    .filter(id => Number.isFinite(id) && id > 0)
}

function mergeWorkflowBindings(base: NonNullable<ActiveScenario['workflowTemplates']> = [], extra: NonNullable<ActiveScenario['workflowTemplates']> = []) {
  const map = new Map<number, NonNullable<ActiveScenario['workflowTemplates']>[number]>()
  ;[...base, ...extra].forEach(w => map.set(w.id, w))
  return Array.from(map.values())
}

function scenarioToActiveScenario(scenario: ScenarioDetail): ActiveScenario {
  return {
    id: scenario.id,
    name: scenario.name,
    icon: scenario.icon || 'S',
    profession: scenario.profession,
    description: scenario.description,
    systemPrompt: scenario.systemPrompt,
    recommendedSkills: scenario.recommendedSkills || [],
    workflowTemplates: scenario.workflowTemplates || [],
    workflowCount: scenario.workflowCount ?? (scenario.workflowTemplates?.length || 0),
  }
}

function fallbackScenarioFromConversation(conv: ConversationVO, scenarioId: number): ActiveScenario {
  const workflowTemplates = parseScenarioWorkflowIds(conv.tags).map(id => ({ id, name: `工作流 #${id}` }))
  const title = conv.title || '场景对话'
  return {
    id: scenarioId,
    name: title.replace(/\s*场景对话\s*$/, '') || '场景',
    icon: 'S',
    recommendedSkills: [],
    workflowTemplates,
    workflowCount: workflowTemplates.length,
  }
}

async function hydrateConversationScenario(conversationId: string, scenarioId: number) {
  try {
    const store = useChatStore.getState()
    const current = store.conversations.find(c => c.id === conversationId)
    const detail = await scenarioApi.detail(scenarioId)
    const activeScenario = scenarioToActiveScenario(detail)
    const extraWorkflows = current?.activeScenario?.workflowTemplates || []
    activeScenario.workflowTemplates = mergeWorkflowBindings(activeScenario.workflowTemplates || [], extraWorkflows)
    activeScenario.workflowCount = activeScenario.workflowTemplates.length
    store.updateConversation(conversationId, {
      activeScenario,
      scenarioSkillIds: activeScenario.recommendedSkills || [],
      scenarioWorkflowIds: activeScenario.workflowTemplates?.map(w => w.id) || [],
    })
    if (store.activeConversationId === conversationId) {
      store.setActiveScenario(activeScenario)
      if (activeScenario.systemPrompt) {
        store.setModelSettings({ systemPrompt: activeScenario.systemPrompt })
      }
      if (activeScenario.recommendedSkills?.length) {
        store.setActiveSkillIds(activeScenario.recommendedSkills)
      }
    }
  } catch (e) {
    console.warn('恢复场景详情失败:', e)
  }
}

export const authApi = {
  sendCode: (email: string, scene: 'register' | 'reset' | 'login') =>
    request<string>('POST', '/auth/send-code', { email, scene }, { noAuth: true }),
  register: (data: { username: string; email: string; password: string; verifyCode: string }) =>
    request<LoginResponse>('POST', '/auth/register', data, { noAuth: true }),
  login: (email: string, password: string, verifyCode?: string) =>
    request<LoginResponse>('POST', '/auth/login', { email, password, verifyCode }, { noAuth: true }),
  linuxDoAuthorizeUrl: () => `${BASE_URL}/auth/oauth/linuxdo/authorize`,
  getMeWithToken: async (token: string) => {
    const res = await fetch(`${BASE_URL}/auth/me`, { headers: { Authorization: `Bearer ${token}` } })
    const data = await res.json()
    if (data.code !== 200) throw new Error(data.message || 'OAuth 登录失败')
    return data.data as UserVO
  },
  resetPassword: (data: { email: string; verifyCode: string; newPassword: string }) =>
    request<string>('POST', '/auth/reset-password', data, { noAuth: true }),
  getMe: () => request<UserVO>('GET', '/auth/me'),
  updateProfile: (name: string) => request<UserVO>('PUT', '/auth/profile', { name }),
}

export const userApiKeyApi = {
  current: () => request<UserApiKeyVO | null>('GET', '/user/api-key'),
  regenerate: (name = 'Default API Key') =>
    request<GenerateApiKeyResponse>('POST', '/user/api-key/regenerate', { name }),
  revoke: () => request<void>('DELETE', '/user/api-key'),
}

export async function aiTranslate(text: string, targetLang: string): Promise<string> {
  return request<string>('POST', '/util/translate', { text, targetLang })
}

/** AI TTS，返回 base64 MP3。channelId 可选，传入后使用指定 TTS 渠道。
 */
export async function aiTTS(text: string, voice = 'alloy', channelId?: string | number): Promise<string> {
  return request<string>('POST', '/util/tts', {
    text, voice, ...(channelId != null ? { channelId: String(channelId) } : {}),
  })
}

// ==================== TTS 音色 API ====================
export interface TtsVoice { id: string; label: string }
export interface TtsChannelVoices {
  channelId: string
  name: string
  provider: string
  voices: TtsVoice[]
}
export interface TtsVoicesResponse {
  channels: TtsChannelVoices[]
  voices: TtsVoice[]
  channelId: string
}
export const ttsApi = {
  getVoices: () => request<TtsVoicesResponse>('GET', '/util/tts/voices'),
  preview: (voice: string, text = '你好，这是语音预览。', channelId?: string | number) =>
    request<string>('POST', '/util/tts/preview', { voice, text, ...(channelId != null ? { channelId: String(channelId) } : {}) }),
}

// ==================== 翻译语言 API ====================
export interface TranslateLang { code: string; label: string }
export const translateApi = {
  getLangs: () => request<TranslateLang[]>('GET', '/util/translate/langs'),
}

/** 免费翻译 API（MyMemory，无需 key，每日有调用限制）。 */
export async function translateText(text: string, targetLang = 'en'): Promise<string> {
  try {
    const q = encodeURIComponent(text.slice(0, 500))
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${q}&langpair=zh|${targetLang}`)
    const data = await res.json()
    if (data.responseStatus === 200) return data.responseData.translatedText
    throw new Error(normalizeMojibakeMessage(data.responseDetails, '翻译失败'))
  } catch (e) {
    throw new Error('翻译服务暂时不可用')
  }
}

export const chatApi = {
  listConversations: (): Promise<ConversationVO[]> =>
    request<ConversationVO[]>('GET', '/chat/conversations'),
  listModels: (): Promise<Model[]> =>
    request<Model[]>('GET', '/chat/models'),
  getConversation: (uuid: string, limit = 50, before?: string, signal?: AbortSignal): Promise<ConversationVO> => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (before) params.set('before', before)
    return request<ConversationVO>('GET', `/chat/conversations/${uuid}?${params}`, undefined, { signal })
  },
  createConversation: (data: { title?: string; model?: string; systemPrompt?: string; agentId?: string; tags?: string[] }): Promise<ConversationVO> =>
    request<ConversationVO>('POST', '/chat/conversations', data),
  updateConversation: (uuid: string, data: { title?: string; model?: string; systemPrompt?: string; tags?: string[] }): Promise<ConversationVO> =>
    request<ConversationVO>('PUT', `/chat/conversations/${uuid}`, data),
  togglePin: (uuid: string): Promise<string> =>
    request<string>('POST', `/chat/conversations/${uuid}/pin`),
  deleteConversation: (uuid: string): Promise<string> =>
    request<string>('DELETE', `/chat/conversations/${uuid}`),
  clearMessages: (uuid: string): Promise<string> =>
    request<string>('DELETE', `/chat/conversations/${uuid}/messages`),
  sendMessage: (uuid: string, data: { content: string; model?: string; temperature?: number; maxTokens?: number; topP?: number; systemPrompt?: string }) =>
    request<{ userMessage: MessageVO; assistantMessage: MessageVO }>('POST', `/chat/conversations/${uuid}/messages`, data),
}

// ==================== 管理 API ====================
export const adminApi = {
  getStats: () => request<Record<string, number>>('GET', '/admin/stats'),
  listUsers: (params: { page?: number; size?: number; keyword?: string; role?: string; status?: string }) => {
    const q = new URLSearchParams()
    Object.entries(params).forEach(([k, v]) => v != null && q.set(k, String(v)))
    return request<{ list: UserVO[]; total: number }>('GET', `/admin/users?${q}`)
  },
  createUser: (data: Partial<UserVO> & { password?: string }) => request<UserVO>('POST', '/admin/users', data),
  updateUser: (uuid: string, data: Partial<UserVO>) => request<UserVO>('PUT', `/admin/users/${uuid}`, data),
  deleteUser: (uuid: string) => request<string>('DELETE', `/admin/users/${uuid}`),
  listChannels: () => request<unknown[]>('GET', '/admin/channels'),
  createChannel: (data: unknown) => request<unknown>('POST', '/admin/channels', data),
  updateChannel: (uuid: string, data: unknown) => request<unknown>('PUT', `/admin/channels/${uuid}`, data),
  deleteChannel: (uuid: string) => request<string>('DELETE', `/admin/channels/${uuid}`),
  fetchChannelModels: (uuid: string) => request<string[]>('GET', `/admin/channels/${uuid}/models`),
  testChannel: (uuid: string) => request<{ ok: boolean; latency: number; message?: string }>('POST', `/admin/channels/${uuid}/test`),
  updateChannelModels: (uuid: string, models: string[]) => request<unknown>('PUT', `/admin/channels/${uuid}/models`, { models }),
  listModels: () => request<unknown[]>('GET', '/admin/models'),
  createModel: (data: unknown) => request<unknown>('POST', '/admin/models', data),
  updateModel: (modelId: string, data: unknown) =>
    request<unknown>('PUT', `/admin/models?modelId=${encodeURIComponent(modelId)}`, data),
  deleteModel: (modelId: string) =>
    request<string>('DELETE', `/admin/models?modelId=${encodeURIComponent(modelId)}`),
  listSubscriptions: (page = 1, size = 20) =>
    request<{ list: unknown[]; total: number }>('GET', `/admin/subscriptions?page=${page}&size=${size}`),
  createSubscription: (data: { userId: number; plan: string; planName?: string; price?: number; costLimit?: number; tokensLimit?: number; modelLimit?: string; startDate?: string; endDate?: string }) =>
    request<string>('POST', '/admin/subscriptions', data),
  updateSubscription: (uuid: string, data: { planName?: string; price?: number; costLimit?: number; tokensLimit?: number; modelLimit?: string; status?: string; endDate?: string }) =>
    request<string>('PUT', `/admin/subscriptions/${uuid}`, data),
  cancelSubscription: (uuid: string) =>
    request<string>('DELETE', `/admin/subscriptions/${uuid}`),
  listLogs: (page = 1, size = 20, model?: string, sceneType?: string) => {
    const q = new URLSearchParams({ page: String(page), size: String(size) })
    if (model) q.set('model', model)
    if (sceneType) q.set('sceneType', sceneType)
    return request<{ list: unknown[]; total: number }>('GET', `/admin/logs?${q}`)
  },
}

// ==================== 套餐 API ====================
// ==================== Harness Evolution API ====================
export interface HarnessTraceVO {
  id: number
  traceUuid?: string
  surface: string
  userId?: number
  conversationUuid?: string
  taskId?: string
  model?: string
  provider?: string
  channelId?: string
  harnessVersion?: string
  status: string
  inputSummary?: string
  outputSummary?: string
  failureType?: string
  errorMsg?: string
  latencyMs?: number
  inputTokens?: number
  outputTokens?: number
  eventsJson?: string
  metricsJson?: string
  qualityJson?: string
  createdAt?: string
  completedAt?: string
}

export interface HarnessFailureVO {
  id: number
  traceId?: number
  surface: string
  failureType: string
  severity: string
  summary?: string
  evidenceJson?: string
  status: string
  createdAt?: string
  resolvedAt?: string
}

export interface HarnessPatchVO {
  id: number
  patchUuid?: string
  surface: string
  targetType: string
  targetId?: string
  title: string
  rationale?: string
  patchJson?: string
  status: string
  createdByTraceId?: number
  reviewedBy?: number
  createdAt?: string
  reviewedAt?: string
}

export interface HarnessVersionVO {
  id: number
  surface: string
  version: string
  name?: string
  configJson?: string
  status: 'active' | 'candidate' | 'retired' | string
  description?: string
  createdAt?: string
  updatedAt?: string
}

export interface HarnessRegressionRunVO {
  id: number
  runUuid?: string
  surface: string
  versionId?: number
  version?: string
  status: 'pending' | 'running' | 'passed' | 'failed' | 'blocked' | 'cancelled' | string
  totalCases: number
  passedCases: number
  failedCases: number
  blockedCases: number
  summary?: string
  resultJson?: string
  createdBy?: number
  createdAt?: string
  completedAt?: string
}

export interface HarnessOverviewVO {
  summary: {
    totalTraces: number
    successCount: number
    failedCount: number
    runningCount: number
    avgLatencyMs: number
    openFailures: number
    draftPatches: number
    versions?: number
    activeVersions?: number
    regressionRuns?: number
  }
  bySurface: Record<string, number>
  byFailureType: Record<string, number>
  byPatchStatus: Record<string, number>
  topFailures: { type: string; count: number }[]
  versions?: HarnessVersionVO[]
  regressionRuns?: HarnessRegressionRunVO[]
  traces: HarnessTraceVO[]
  failures: HarnessFailureVO[]
  patches: HarnessPatchVO[]
}

export interface HarnessRegressionCaseVO {
  id: number
  surface: string
  failureType: string
  severity: string
  input: string
  expected: string
  avoid?: string
  model?: string
  taskId?: string
  conversationUuid?: string
  events?: { type?: string; name?: string; ts?: string }[]
  createdAt?: string
}

export interface HarnessRecurringFailureVO {
  surface: string
  failureType: string
  count: number
  openCount: number
  regressionCount: number
  highSeverityCount: number
  score: number
  latestAt?: string
  hasPatch?: boolean
  samples?: Array<{ id?: number; traceId?: number; severity?: string; summary?: string }>
}

export interface PageResult<T> {
  list: T[]
  total: number
  page: number
  size: number
}

export interface HarnessRegressionPreviewVO {
  version?: HarnessVersionVO
  surface: string
  caseCount: number
  byFailureType: Record<string, number>
  bySeverity: Record<string, number>
  checklist: Array<{
    caseId: number
    surface: string
    failureType: string
    input?: string
    expected?: string
    status: string
  }>
}

export const harnessApi = {
  overview: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessOverviewVO>('GET', `/harness/overview?${q}`)
  },
  traces: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessTraceVO[]>('GET', `/harness/traces?${q}`)
  },
  tracePage: (surface?: string, page = 1, size = 30) => {
    const q = new URLSearchParams({ page: String(page), size: String(size) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<PageResult<HarnessTraceVO>>('GET', `/harness/traces/page?${q}`)
  },
  trace: (id: number) => request<HarnessTraceVO>('GET', `/harness/traces/${id}`),
  failures: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessFailureVO[]>('GET', `/harness/failures?${q}`)
  },
  failurePage: (surface?: string, page = 1, size = 30) => {
    const q = new URLSearchParams({ page: String(page), size: String(size) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<PageResult<HarnessFailureVO>>('GET', `/harness/failures/page?${q}`)
  },
  regressionCases: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessRegressionCaseVO[]>('GET', `/harness/regression-cases?${q}`)
  },
  recurringFailures: (params: { surface?: string; minCount?: number; limit?: number }) => {
    const q = new URLSearchParams({
      minCount: String(params.minCount ?? 2),
      limit: String(params.limit ?? 20),
    })
    if (params.surface && params.surface !== 'all') q.set('surface', params.surface)
    return request<HarnessRecurringFailureVO[]>('GET', `/harness/failures/recurring?${q}`)
  },
  promoteRecurringFailures: (data: { surface?: string; minCount?: number }) =>
    request<HarnessPatchVO[]>('POST', '/harness/failures/recurring/promote', data),
  autoGeneratePatches: (data: { surface?: string; minCount?: number; limit?: number }) =>
    request<HarnessPatchVO[]>('POST', '/harness/patches/auto-generate', data),
  regressionPreview: (params: { surface?: string; versionId?: number; limit?: number }) => {
    const q = new URLSearchParams({ limit: String(params.limit ?? 100) })
    if (params.surface && params.surface !== 'all') q.set('surface', params.surface)
    if (params.versionId) q.set('versionId', String(params.versionId))
    return request<HarnessRegressionPreviewVO>('GET', `/harness/regression-preview?${q}`)
  },
  regressionRuns: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessRegressionRunVO[]>('GET', `/harness/regression-runs?${q}`)
  },
  regressionRun: (id: number) =>
    request<HarnessRegressionRunVO>('GET', `/harness/regression-runs/${id}`),
  regressionRunBundle: (id: number) =>
    request<Record<string, unknown>>('GET', `/harness/regression-runs/${id}/bundle`),
  createRegressionRun: (data: { surface?: string; versionId?: number }) =>
    request<HarnessRegressionRunVO>('POST', '/harness/regression-runs', data),
  startRegressionRun: (id: number) =>
    request<HarnessRegressionRunVO>('PUT', `/harness/regression-runs/${id}/start`),
  runRegressionPreflight: (id: number) =>
    request<HarnessRegressionRunVO>('POST', `/harness/regression-runs/${id}/preflight`),
  completeRegressionRun: (id: number, data: {
    status: 'passed' | 'failed' | 'blocked' | 'cancelled'
    totalCases?: number
    passedCases?: number
    failedCases?: number
    blockedCases?: number
    summary?: string
    runMode?: string
    caseResults?: unknown
    result?: unknown
  }) => request<HarnessRegressionRunVO>('PUT', `/harness/regression-runs/${id}/complete`, data),
  failure: (id: number) => request<HarnessFailureVO>('GET', `/harness/failures/${id}`),
  updateFailureStatus: (id: number, status: 'open' | 'resolved' | 'ignored' | 'regression') =>
    request<HarnessFailureVO>('PUT', `/harness/failures/${id}/status`, { status }),
  patches: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessPatchVO[]>('GET', `/harness/patches?${q}`)
  },
  patchPage: (surface?: string, page = 1, size = 30) => {
    const q = new URLSearchParams({ page: String(page), size: String(size) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<PageResult<HarnessPatchVO>>('GET', `/harness/patches/page?${q}`)
  },
  generatePatch: (data: { surface?: string; failureType?: string }) =>
    request<HarnessPatchVO>('POST', '/harness/patches/generate', data),
  updatePatchStatus: (id: number, status: 'draft' | 'approved' | 'rejected' | 'applied') =>
    request<HarnessPatchVO>('PUT', `/harness/patches/${id}/status`, { status }),
  versions: (surface?: string, limit = 100) => {
    const q = new URLSearchParams({ limit: String(limit) })
    if (surface && surface !== 'all') q.set('surface', surface)
    return request<HarnessVersionVO[]>('GET', `/harness/versions?${q}`)
  },
  createVersionFromPatch: (patchId: number) =>
    request<HarnessVersionVO>('POST', `/harness/versions/from-patch/${patchId}`),
  activateVersion: (id: number) =>
    request<HarnessVersionVO>('PUT', `/harness/versions/${id}/activate`),
}

export interface SubscriptionPlanVO {
  id?: number
  uuid: string
  name: string
  code: string
  description: string
  price: number
  costLimit?: number
  tokensLimit: number
  modelLimit: string
  features: string[]
  roleId: number | null
  roleName: string
  sortOrder: number
  isPopular: boolean
  enabled: boolean
}

export const planApi = {
  listPublic: () => request<SubscriptionPlanVO[]>('GET', '/plans', undefined, { noAuth: true }),
  subscribe: (planUuid: string, paymentMethod = 'mock') =>
    request<string>('POST', '/plans/subscribe', { planUuid, paymentMethod }),
  adminList: () => request<SubscriptionPlanVO[]>('GET', '/admin/plans'),
  adminCreate: (data: Partial<SubscriptionPlanVO> & { features?: string[] }) =>
    request<SubscriptionPlanVO>('POST', '/admin/plans', { ...data, features: JSON.stringify(data.features || []) }),
  adminUpdate: (uuid: string, data: Partial<SubscriptionPlanVO> & { features?: string[] }) =>
    request<SubscriptionPlanVO>('PUT', `/admin/plans/${uuid}`, { ...data, features: JSON.stringify(data.features || []) }),
  adminDelete: (uuid: string) => request<string>('DELETE', `/admin/plans/${uuid}`),
}

export interface AgentRegistryItem {
  id: number
  agentId: string
  name: string
  version: string
  description: string
  categories: string[]
  model: string
  icon: string
  author: string
  status: string
  isBuiltin: boolean
  toolCount: number
  totalUsage: number
  revenueRatio: number
  reviewComment: string
  reviewedAt: string
  createdAt: string
  installed?: boolean
  /** 平均评分 (1-5) */
  avgRating: number
  /** 评分人数 */
  ratingCount: number
}

export interface AgentRegistryDetail extends AgentRegistryItem {
  temperature: number
  maxTokens: number
  systemPrompt: string
  tools: { name: string; description: string; parameters?: Record<string, unknown>; endpoint?: string; executionMode?: string }[]
  hooks?: { onStart?: string; onToolCall?: string; onDone?: string }
  sortOrder: number
  screenshots: string[]
  usageGuide: string
  totalRevenue: number
  reviewedBy: number
  createdBy: number
  updatedAt: string
}

export interface AgentFileNode {
  name: string
  path: string
  type?: string
  isDirectory: boolean
  children?: AgentFileNode[]
}

export interface AgentPageResult {
  content?: AgentRegistryItem[]
  list?: AgentRegistryItem[]
  page: number
  size: number
  total: number
  totalElements: number
  totalPages: number
}

export interface AgentStoreStats {
  totalAgents: number
  totalCategories: number
  totalUsage: number
  newThisWeek: number
}

export interface SkillMatchResult {
  agentId: string
  name: string
  description: string
  score: number
}

export interface AutoSkillMatchResult {
  useSkill: boolean
  complex: boolean
  source?: string
  cacheHit?: boolean
  bestMatch: SkillMatchResult | null
  matches: SkillMatchResult[]
}

export interface WalletTransaction {
  id: number
  userId: number
  type: 'deposit' | 'withdraw' | 'consume' | 'earn' | 'refund'
  amount: number
  balanceBefore: number
  balanceAfter: number
  description: string
  refType: string
  refId: string
  status: string
  createdAt: string
}

export const agentRegistryApi: {
  list: (params?: { page?: number; size?: number; category?: string }) => Promise<AgentPageResult>
  search: (query: string, page?: number, size?: number) => Promise<AgentPageResult>
  getCategories: () => Promise<string[]>
  getDetail: (agentId: string) => Promise<AgentRegistryDetail>
  register: (data: {
    agentId: string; name: string; description?: string; version?: string
    categories?: string[]; model?: string; temperature?: number; maxTokens?: number
    systemPrompt: string; tools?: { name: string; description: string; parameters?: Record<string, unknown>; endpoint?: string; executionMode?: string }[]
    hooks?: { onStart?: string; onToolCall?: string; onDone?: string }
    icon?: string; author?: string; status?: string
    screenshots?: string[]; usageGuide?: string
  }) => Promise<AgentRegistryDetail>
  update: (agentId: string, data: Partial<Parameters<typeof agentRegistryApi.register>[0]>) =>
    Promise<AgentRegistryDetail>
  submitReview: (agentId: string) => Promise<AgentRegistryDetail>
  delete: (agentId: string) => Promise<void>
  pending: () => Promise<AgentRegistryItem[]>
  adminAll: (params?: { page?: number; size?: number; status?: string; category?: string; q?: string }) => Promise<AgentPageResult>
  approve: (agentId: string, comment?: string) => Promise<AgentRegistryDetail>
  reject: (agentId: string, comment: string) => Promise<AgentRegistryDetail>
  toggleStatus: (agentId: string, status: 'active' | 'disabled') => Promise<AgentRegistryDetail>
  adminDelete: (agentId: string) => Promise<void>
  setRevenueRatio: (agentId: string, ratio: number) => Promise<void>
  getStats: () => Promise<AgentStoreStats>
  install: (agentId: string) => Promise<{ success: boolean; message: string; agentId: string; name?: string; alreadyInstalled?: boolean }>
  uninstall: (agentId: string) => Promise<{ success: boolean; message: string }>
  listMy: () => Promise<AgentRegistryItem[]>
  listInstalled: () => Promise<AgentRegistryItem[]>
  downloadUrl: (agentId: string) => string
  download: (agentId: string, filename?: string) => Promise<void>
  rate: (agentId: string, rating: number, comment?: string) => Promise<{ avgRating: number; ratingCount: number }>
  getUserRating: (agentId: string) => Promise<{ id: number; rating: number; comment: string; createdAt: string } | null>
  deleteRating: (agentId: string, ratingId: number) => Promise<void>
  listRatings: (agentId: string, page?: number, size?: number) => Promise<{
    list: Array<{ id: number; userId: number; username: string; avatar: string; rating: number; comment: string; createdAt: string }>
    total: number; page: number; size: number
  }>
  getFileTree: (agentId: string) => Promise<AgentFileNode[]>
  readFile: (agentId: string, path: string) => Promise<string>
  updateFile: (agentId: string, path: string, content: string) => Promise<void>
  createFile: (agentId: string, path: string, content?: string, isDirectory?: boolean) => Promise<void>
  deleteFile: (agentId: string, path: string) => Promise<void>
  processConversation: (agentId: string, message: string, history?: any[]) => Promise<any>
  applyModifications: (agentId: string, modifications: any) => Promise<any>
  /** 根据输入匹配技能 */
  matchSkill: (input: string) => Promise<any[]>
  autoMatchSkill: (input: string, convUuid?: string) => Promise<AutoSkillMatchResult>
} = {
  list: (params) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.size) qs.set('size', String(params.size))
    if (params?.category) qs.set('category', params.category)
    const query = qs.toString()
    return request<AgentPageResult>('GET', `/v1/agent-registry${query ? '?' + query : ''}`)
  },
  search: (query, page = 1, size = 20) =>
    request<AgentPageResult>('GET', `/v1/agent-registry/search?q=${encodeURIComponent(query)}&page=${page}&size=${size}`),
  getCategories: () => request<string[]>('GET', '/v1/agent-registry/categories'),
  getDetail: (agentId) => request<AgentRegistryDetail>('GET', `/v1/agent-registry/${agentId}`),
  register: (data) => request<AgentRegistryDetail>('POST', '/v1/agent-registry/register', data),
  update: (agentId, data) => request<AgentRegistryDetail>('PUT', `/v1/agent-registry/${agentId}`, data),
  submitReview: (agentId: string) => request<AgentRegistryDetail>('POST', `/v1/agent-registry/${agentId}/submit-review`),
  delete: (agentId) => request<void>('DELETE', `/v1/agent-registry/${agentId}`),
  pending: () => request<AgentRegistryItem[]>('GET', '/v1/agent-registry/admin/pending'),
  adminAll: (params) => {
    const qs = new URLSearchParams()
    if (params?.page) qs.set('page', String(params.page))
    if (params?.size) qs.set('size', String(params.size))
    if (params?.status) qs.set('status', params.status)
    if (params?.category) qs.set('category', params.category)
    if (params?.q) qs.set('q', params.q)
    return request<AgentPageResult>('GET', `/v1/agent-registry/admin/all?${qs}`)
  },
  approve: (agentId, comment) => request<AgentRegistryDetail>('POST', `/v1/agent-registry/admin/${agentId}/approve`, { comment: comment || '' }),
  reject: (agentId, comment) => request<AgentRegistryDetail>('POST', `/v1/agent-registry/admin/${agentId}/reject`, { comment }),
  toggleStatus: (agentId, status) => request<AgentRegistryDetail>('PUT', `/v1/agent-registry/admin/${agentId}/status`, { status }),
  adminDelete: (agentId) => request<void>('DELETE', `/v1/agent-registry/admin/${agentId}`),
  setRevenueRatio: (agentId, ratio) => request<void>('PUT', `/v1/agent-registry/admin/${agentId}/revenue-ratio`, { ratio }),
  getStats: () => request<AgentStoreStats>('GET', '/v1/agent-registry/stats'),
  install: (agentId) => request<any>('POST', `/v1/agent-registry/${agentId}/install`),
  uninstall: (agentId) => request<any>('DELETE', `/v1/agent-registry/${agentId}/install`),
  listMy: () => request<AgentRegistryItem[]>('GET', '/v1/agent-registry/my'),
  listInstalled: () => request<AgentRegistryItem[]>('GET', '/v1/agent-registry/installed'),
  downloadUrl: (agentId) => `${BASE_URL}/skills/${agentId}/download`,
  download: async (agentId: string, filename?: string) => {
    const url = `${BASE_URL}/skills/${agentId}/download`
    const token = getToken()
    const headers: Record<string, string> = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(url, { headers })
    if (!res.ok) {
      if (res.status === 401) { useAuthStore.getState().logout(); throw new Error('登录已过期') }
      throw new Error(`下载失败: ${res.status}`)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/)
    const dlName = filename || (match ? match[1].replace(/['"]/g, '') : `${agentId}.zip`)
    const dlUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = dlUrl
    a.download = dlName
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(dlUrl)
  },
  rate: (agentId, rating, comment) =>
    request<{ avgRating: number; ratingCount: number }>('POST', `/v1/agent-registry/${agentId}/ratings`, { rating, comment }),
  getUserRating: (agentId) =>
    request<{ id: number; rating: number; comment: string; createdAt: string } | null>('GET', `/v1/agent-registry/${agentId}/ratings/mine`),
  deleteRating: (agentId, ratingId) =>
    request<void>('DELETE', `/v1/agent-registry/${agentId}/ratings/${ratingId}`),
  listRatings: (agentId, page = 1, size = 10) =>
    request<any>('GET', `/v1/agent-registry/${agentId}/ratings?page=${page}&size=${size}`),
  getFileTree: (agentId) =>
    request<any>('GET', `/v1/agent-registry/${agentId}/files`),
  readFile: (agentId, path) =>
    request<any>('GET', `/v1/agent-registry/${agentId}/files/content?path=${encodeURIComponent(path)}`),
  updateFile: (agentId, path, content) =>
    request<any>('PUT', `/v1/agent-registry/${agentId}/files/content?path=${encodeURIComponent(path)}`, content),
  createFile: (agentId, path, content?, isDirectory = false) => {
    const params = new URLSearchParams()
    params.set('path', path)
    if (content) params.set('content', content)
    params.set('isDirectory', String(isDirectory))
    return request<any>('POST', `/v1/agent-registry/${agentId}/files?${params}`)
  },
  deleteFile: (agentId, path) =>
    request<any>('DELETE', `/v1/agent-registry/${agentId}/files?path=${encodeURIComponent(path)}`),
  processConversation: (agentId, message, history = []) =>
    request<any>('POST', `/v1/agent-registry/${agentId}/conversation`, { message, history }),
  applyModifications: (agentId, modifications) =>
    request<any>('POST', `/v1/agent-registry/${agentId}/conversation/apply`, { modifications }),
  matchSkill: (input: string) =>
    request<any>('GET', `/v1/agent-registry/match?input=${encodeURIComponent(input)}`),
  autoMatchSkill: (input: string, convUuid?: string) => {
    const qs = new URLSearchParams()
    qs.set('input', input)
    if (convUuid && !convUuid.startsWith('conv_')) qs.set('convUuid', convUuid)
    return request<AutoSkillMatchResult>('GET', `/v1/agent-registry/auto-match?${qs}`)
  },
}

// Mock AI 回复
const MOCK_RESPONSES = [
  `好的，我来帮你分析这个问题。

这里有几个关键点：

1. 先明确目标和输入输出。
2. 再拆解实现路径和风险点。
3. 最后给出可验证的结果。

\`\`\`javascript
function example() {
  const data = { message: "Hello, World!", timestamp: new Date().toISOString() };
  console.log(JSON.stringify(data, null, 2));
  return data;
}
example();
\`\`\`

如果你需要，我可以继续补充更具体的代码示例。`,
  `这个问题可以从理论基础、实践应用和注意事项三个角度分析。建议先确定约束条件，再选择实现方案。`,
  `下面是一个简单示例：

\`\`\`html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>示例页面</title>
</head>
<body>
  <h1>Hello World!</h1>
</body>
</html>
\`\`\``,
]

async function* mockAIStream(content: string): AsyncGenerator<string> {
  const response = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)]
  for (const char of response) {
    yield char
    await new Promise(r => setTimeout(r, 12 + Math.random() * 8))
  }
}

export async function* sendMessage(
  uuid: string,
  content: string,
  model: string,
  systemPrompt?: string,
  files?: { name: string; type: string; content: string; isBinary?: boolean; url?: string; ossUrl?: string; size?: number }[],
  agentId?: string,
  uploadedFilePaths?: string[],
  displayContent?: string,
  abortSignal?: AbortSignal,
  fileUrls?: string[],
  onUpdate?: (msgId: string, updates: Record<string, unknown>) => void,
  thinking?: boolean,
  thinkingBudget?: number,
  continueMessageId?: string,
  skipUserMessage?: boolean,
): AsyncGenerator<{
  type: 'user' | 'assistant' | 'thinking' | 'error' | 'done' | 'tool_call' | 'tool_result' | 'search_start' | 'search_result'
  content: string
  msgId?: string
  tokens?: number
  toolCallId?: string
  toolName?: string
  toolArgs?: string
  toolResult?: string
  thinkingContent?: string
  query?: string
  reason?: string
  search?: unknown
}> {

  const msgContent = displayContent !== undefined ? displayContent : content

  if (DEMO_MODE) {
    const chatStore = useChatStore.getState()

    if (continueMessageId) {
      const aiMsgId = continueMessageId
      const conv = chatStore.conversations.find(c => c.id === uuid)
      const existingMsg = conv?.messages?.find(m => m.id === aiMsgId)
      let fullContent = existingMsg?.content || ''
      chatStore.updateMessage(uuid, aiMsgId, { isStreaming: true, preempted: false })
      try {
        for await (const chunk of mockAIStream(content)) {
          fullContent += chunk
          chatStore.updateMessage(uuid, aiMsgId, { content: fullContent, isStreaming: true, tokens: Math.floor(fullContent.length / 4) })
          yield { type: 'assistant', content: chunk, msgId: aiMsgId }
        }
        chatStore.updateMessage(uuid, aiMsgId, { content: fullContent, isStreaming: false, tokens: Math.floor(fullContent.length / 4) })
        yield { type: 'done', content: fullContent, msgId: aiMsgId }
      } catch {
        chatStore.updateMessage(uuid, aiMsgId, { error: '生成失败，请重试', isStreaming: false })
        yield { type: 'error', content: '生成失败，请重试' }
      }
      return
    }

    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`
    if (!skipUserMessage) {
      chatStore.addMessage(uuid, {
        id: userMsgId, role: 'user', content: msgContent, timestamp: new Date().toISOString(),
        files: files?.map((f, i) => ({
          id: `file-${i}-${Date.now()}`,
          name: f.name, type: f.type, size: f.size || 0,
          content: (f.isBinary || f.type?.startsWith('image/')) ? undefined : f.content,
          isBinary: f.isBinary,
          url: f.ossUrl || f.url,
          ossUrl: f.ossUrl,
        })),
      })
    }
    const aiMsgId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
    chatStore.addMessage(uuid, { id: aiMsgId, role: 'assistant', content: '', isStreaming: true, model, timestamp: new Date().toISOString() })
    if (!skipUserMessage) yield { type: 'user', content, msgId: userMsgId }
    let fullContent = ''
    try {
      for await (const chunk of mockAIStream(content)) {
        fullContent += chunk
        chatStore.updateMessage(uuid, aiMsgId, { content: fullContent, isStreaming: true, tokens: Math.floor(fullContent.length / 4) })
        yield { type: 'assistant', content: chunk, msgId: aiMsgId }
      }
      chatStore.updateMessage(uuid, aiMsgId, { content: fullContent, isStreaming: false, tokens: Math.floor(fullContent.length / 4) })
      yield { type: 'done', content: fullContent, msgId: aiMsgId }
    } catch {
      chatStore.updateMessage(uuid, aiMsgId, { error: '生成失败，请重试', isStreaming: false })
      yield { type: 'error', content: '生成失败，请重试' }
    }
    return
  }


  let convId = uuid
  if (uuid.startsWith('conv_')) {
    try {
      const { conversations } = useChatStore.getState()
      const conv = conversations.find(c => c.id === uuid)
      const tags = conv?.activeScenario
        ? [...(conv.tags || []).filter(t => !t.startsWith(SCENARIO_TAG_PREFIX)), scenarioTag(conv.activeScenario.id)]
        : conv?.tags
      const created = await chatApi.createConversation({
        title: conv?.title || '新对话',
        model,
        systemPrompt: systemPrompt || conv?.activeScenario?.systemPrompt,
        tags,
      })
      convId = created.id
      const updated = useChatStore.getState().conversations.map(c =>
        c.id === uuid ? { ...c, id: convId, tags: created.tags || tags } : c
      )
      useChatStore.setState({ conversations: updated, activeConversationId: convId })
    } catch (err) {
      console.error('[sendMessage] failed to create conversation for temp id:', err)
      yield { type: 'error', content: err instanceof Error ? normalizeMojibakeMessage(err.message, '创建对话失败') : '创建对话失败' }
      return
    }
  }

  if (!convId) {
    console.error('[sendMessage] convId is empty!')
    yield { type: 'error', content: '对话 ID 异常，请刷新页面重试' }
    return
  }

  // 2. 本地添加占位消息。内联继续模式会复用现有 AI 消息。
  let aiMsgId: string
  let accumulated = ''

  if (continueMessageId) {
    aiMsgId = continueMessageId
    const conv = useChatStore.getState().conversations.find(c => c.id === convId)
    const existingMsg = conv?.messages?.find(m => m.id === continueMessageId)
    accumulated = existingMsg?.content || ''
    useChatStore.getState().updateMessage(convId, continueMessageId, { isStreaming: true, preempted: false, error: undefined })
  } else {
    const userMsgId = `user-${Date.now()}-${Math.random().toString(36).slice(2)}`
    if (!skipUserMessage) {
      useChatStore.getState().addMessage(convId, {
        id: userMsgId, role: 'user', content: msgContent, timestamp: new Date().toISOString(),
        files: files?.map((f, i) => ({
          id: `file-${i}-${Date.now()}`,
          name: f.name, type: f.type, size: f.size || 0,
          content: (f.isBinary || f.type?.startsWith('image/')) ? undefined : f.content,
          isBinary: f.isBinary,
          url: f.ossUrl || f.url,
          ossUrl: f.ossUrl,
        })),
      })
    }
    aiMsgId = `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`
    useChatStore.getState().addMessage(convId, { id: aiMsgId, role: 'assistant', content: '', isStreaming: true, model, timestamp: new Date().toISOString() })
    if (!skipUserMessage) yield { type: 'user', content, msgId: userMsgId }
  }

  const token = getToken()
  const MAX_ACCUMULATED_CHARS = 200000

  const imageBase64List = files
    ?.filter(f => f.type.startsWith('image/') && f.content)
    .map(f => f.content!)

  const requestBody: Record<string, unknown> = { content, model, systemPrompt }
  if (agentId) requestBody.agentId = agentId
  if (fileUrls && fileUrls.length > 0) requestBody.fileUrls = fileUrls
  else if (imageBase64List && imageBase64List.length > 0) requestBody.imageBase64List = imageBase64List
  if (uploadedFilePaths && uploadedFilePaths.length > 0) requestBody.uploadedFilePaths = uploadedFilePaths
  if (thinking !== undefined) requestBody.thinking = thinking
  if (thinkingBudget !== undefined && thinkingBudget > 0) requestBody.thinkingBudget = thinkingBudget
  if (continueMessageId) {
    requestBody.continueMessageId = continueMessageId
    if (accumulated) requestBody.existingContent = accumulated
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  try {
    const url = `${BASE_URL}/chat/conversations/${convId}/messages/stream`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: abortSignal,
    })

    if (!res.ok || !res.body) {
      const errText = await res.text()
      let errMsg = `请求失败 (${res.status})`
      try { errMsg = normalizeMojibakeMessage(JSON.parse(errText)?.message, errMsg) } catch {}
      useChatStore.getState().updateMessage(convId, aiMsgId, { error: errMsg, isStreaming: false })
      yield { type: 'error', content: errMsg }
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''

    // 流式更新节流：避免高频 state 更新。
    let pendingContent = accumulated
    let lastFlush = 0
    let lastFlushedLen = 0
    const FLUSH_MIN_INTERVAL = 16
    const FLUSH_MIN_CHARS = 20

    const doFlush = (force = false) => {
      const now = Date.now()
      const timeSinceFlush = now - lastFlush
      const charsSinceFlush = pendingContent.length - lastFlushedLen
      if (!force && timeSinceFlush < FLUSH_MIN_INTERVAL && charsSinceFlush < FLUSH_MIN_CHARS) {
        return
      }
      lastFlush = now
      lastFlushedLen = pendingContent.length
      const safe = pendingContent.length > MAX_ACCUMULATED_CHARS
        ? '[前段内容已自动截断以节省内存...]\n\n' + pendingContent.slice(pendingContent.length - MAX_ACCUMULATED_CHARS + 1000)
        : pendingContent
      // Prefer onUpdate so callers can schedule streaming UI updates.
      if (onUpdate) {
        onUpdate(aiMsgId, { content: safe, isStreaming: true })
      } else {
        useChatStore.getState().updateMessage(convId, aiMsgId, { content: safe, isStreaming: true })
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔。
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const part of parts) {
        if (!part.trim()) continue
        const lines = part.split('\n')
        let eventName = currentEvent
        let dataLine = ''

        for (const line of lines) {
          // 兼容 "event: token" 和 "event:token" 两种格式。
          if (line.startsWith('event:')) {
            eventName = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLine = line.slice(5).trim()
          }
        }

        if (!dataLine) continue
        try {
          const parsed = JSON.parse(dataLine)

          if (eventName === 'token') {
            accumulated += parsed.token
            if (accumulated.length > MAX_ACCUMULATED_CHARS) {
              const truncateAt = accumulated.length - MAX_ACCUMULATED_CHARS + 1000
              accumulated = '[前段内容已自动截断以节省内存...]\n\n' + accumulated.slice(truncateAt)
              if (!((window as any).__oom_acc_warned)) {
                console.warn(`[OOM-WARN] SSE accumulated ${accumulated.length} chars, truncated`)
                ;(window as any).__oom_acc_warned = true
              }
            }
            pendingContent = accumulated
            doFlush()
            yield { type: 'assistant', content: parsed.token, msgId: aiMsgId }

          } else if (eventName === 'thinking') {
            const delta = parsed.token || ''
            if (delta) {
              const conv = useChatStore.getState().conversations.find(c => c.id === convId)
              const current = conv?.messages.find(m => m.id === aiMsgId)
              const nextThinking = `${current?.thinkingContent || ''}${delta}`
              if (onUpdate) {
                onUpdate(aiMsgId, { thinkingContent: nextThinking, isStreaming: true })
              } else {
                useChatStore.getState().updateMessage(convId, aiMsgId, {
                  thinkingContent: nextThinking,
                  isStreaming: true,
                })
              }
              yield { type: 'thinking', content: delta, msgId: aiMsgId, thinkingContent: nextThinking }
            }

          } else if (eventName === 'done') {
            pendingContent = accumulated
            doFlush(true)

            const contentKB = (accumulated.length / 1024).toFixed(1)
            const domNodes = document.querySelectorAll('*').length
            const perfMem = (performance as any).memory
            const heapMB = perfMem ? (perfMem.usedJSHeapSize / 1024 / 1024).toFixed(1) : 'N/A'
            console.log(
              `[OOM-DONE] stream done | content: ${contentKB}KB | DOM: ${domNodes} | JS: ${heapMB}MB | ` +
              `toolCalls: ${parsed.toolCalls?.length || 0}`
            )

            if (accumulated.length > 15000) {
              console.warn(`[OOM-DONE] Large content ${contentKB}KB, starting burst monitor`)
              burstMonitor()
            }

            const NEED_DEFER = accumulated.length > 10000
            if (NEED_DEFER) {
              useChatStore.getState().updateMessage(convId, aiMsgId, {
                content: accumulated,
                isStreaming: true,
                tokens: parsed.tokens,
                model: parsed.model,
                thinkingContent: parsed.thinkingContent,
              })
              console.log(`[OOM-DEFER] Large content ${contentKB}KB, defer Markdown render`)
              await new Promise<void>(resolve => {
                if (typeof requestIdleCallback !== 'undefined') {
                  requestIdleCallback(() => resolve(), { timeout: 200 })
                } else {
                  setTimeout(resolve, 200)
                }
              })
            }

            if (onUpdate) {
              onUpdate(aiMsgId, {
                content: accumulated,
                isStreaming: false,
                thinkingContent: parsed.thinkingContent,
                ...(NEED_DEFER ? {} : { tokens: parsed.tokens, model: parsed.model }),
              })
            } else {
              useChatStore.getState().updateMessage(convId, aiMsgId, {
                content: accumulated,
                isStreaming: false,
                thinkingContent: parsed.thinkingContent,
                ...(NEED_DEFER ? {} : { tokens: parsed.tokens, model: parsed.model }),
              })
            }
            if (parsed.inputTokens && parsed.inputTokens > 0) {
              const authStore = useAuthStore.getState()
              if (authStore.user) {
                const newUsed = (authStore.user.tokensUsed || 0) + parsed.inputTokens + (parsed.tokens || 0)
                const costDelta = Number(parsed.cost || 0)
                authStore.updateUser({
                  tokensUsed: newUsed,
                  ...(costDelta > 0 ? { costUsed: Number(authStore.user.costUsed || 0) + costDelta } : {}),
                })
              }
            }
            yield { type: 'done', content: accumulated, msgId: parsed.msgId || aiMsgId, tokens: parsed.tokens, thinkingContent: parsed.thinkingContent }

          } else if (eventName === 'tool_call') {
            useChatStore.getState().updateMessage(convId, aiMsgId, { content: accumulated, isStreaming: true })
            yield {
              type: 'tool_call',
              content: `正在调用工具: ${parsed.toolName}`,
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              toolArgs: parsed.arguments,
            }

          } else if (eventName === 'tool_result') {
            const resultSize = parsed.result ? String(parsed.result).length : 0
            if (resultSize > 10000) {
              console.warn(`[OOM-WARN] SSE tool_result: ${parsed.toolName} result ${resultSize} chars (${(resultSize / 1024).toFixed(1)}KB)`)
            }
            yield {
              type: 'tool_result',
              content: `工具执行完成: ${parsed.toolName}`,
              toolCallId: parsed.toolCallId,
              toolName: parsed.toolName,
              toolResult: parsed.result,
            }

          } else if (eventName === 'search_start') {
            useChatStore.getState().updateMessage(convId, aiMsgId, {
              search: {
                status: 'searching',
                query: parsed.query || '',
                reason: parsed.reason,
              },
              isStreaming: true,
            })
            yield {
              type: 'search_start',
              content: parsed.query || '',
              query: parsed.query,
              reason: parsed.reason,
              msgId: aiMsgId,
            }

          } else if (eventName === 'search_result') {
            const hasError = parsed.errorCode && parsed.errorCode !== '0'
            useChatStore.getState().updateMessage(convId, aiMsgId, {
              search: {
                status: hasError ? 'error' : 'done',
                query: parsed.query || '',
                provider: parsed.provider,
                total: parsed.total,
                documents: parsed.documents || [],
                errorCode: parsed.errorCode,
                errorMessage: parsed.errorMessage,
              },
              isStreaming: true,
            })
            yield {
              type: 'search_result',
              content: parsed.query || '',
              search: parsed,
              msgId: aiMsgId,
            }

          } else if (eventName === 'error') {
            useChatStore.getState().updateMessage(convId, aiMsgId, { error: parsed.message, isStreaming: false })
            yield { type: 'error', content: parsed.message }
            return
          }
        } catch {
        }
        currentEvent = ''
      }
    }

    if (accumulated) {
      useChatStore.getState().updateMessage(convId, aiMsgId, { content: accumulated, isStreaming: false })
    }

  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return
    }
    const msg = err instanceof Error ? err.message : '连接失败，请检查网络'
    useChatStore.getState().updateMessage(convId, aiMsgId, { error: msg, isStreaming: false })
    yield { type: 'error', content: msg }
  }
}

export async function loadConversations() {
  if (DEMO_MODE) return
  try {
    const list = await chatApi.listConversations()
    const chatStore = useChatStore.getState()
    const oldConvs = chatStore.conversations
    const conversations = list.map(conv => {
      const old = oldConvs.find(c => c.id === conv.id)
      const scenarioId = parseScenarioId(conv.tags)
      const activeScenario = old?.activeScenario || (scenarioId ? fallbackScenarioFromConversation(conv, scenarioId) : null)
      return {
        id: conv.id,
        title: conv.title,
        model: conv.model || 'gpt-4o',
        messages: old?.messages || [],
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        pinned: conv.pinned,
        tags: conv.tags,
        activeScenario,
        scenarioSkillIds: activeScenario?.recommendedSkills || [],
        scenarioWorkflowIds: activeScenario?.workflowTemplates?.map(w => w.id) || [],
      }
    })

    const currentActiveId = chatStore.activeConversationId
    const isValid = currentActiveId && conversations.some(c => c.id === currentActiveId)
    const update: Partial<typeof chatStore> = { conversations }
    if (!isValid) {
      update.activeConversationId = null
    }

    useChatStore.setState(update)
    list.forEach(conv => {
      const scenarioId = parseScenarioId(conv.tags)
      if (scenarioId) hydrateConversationScenario(conv.id, scenarioId)
    })
  } catch (e) {
    console.warn('加载对话列表失败，使用本地数据', e)
  }
}

export async function loadConversationMessages(uuid: string, limit = 50, signal?: AbortSignal) {
  if (DEMO_MODE) return
  if (!uuid) return
  try {
    const chatStore = useChatStore.getState()
    const existing = chatStore.conversations.find(c => c.id === uuid)
    if (existing && existing.messages.length > 0) return

    const conv = await chatApi.getConversation(uuid, limit, undefined, signal)
    const scenarioId = parseScenarioId(conv.tags)
    const activeScenario = scenarioId
      ? (existing?.activeScenario || fallbackScenarioFromConversation(conv, scenarioId))
      : null
    const messages = (conv.messages || []).map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      model: m.model,
      tokens: m.tokens,
    }))
    const recheck = useChatStore.getState().conversations.find(c => c.id === uuid)
    if (recheck && recheck.messages.length > 0) return

    if (!recheck) {
      const tempId = useChatStore.getState().createConversation(conv.title || '对话')
      const { conversations } = useChatStore.getState()
      useChatStore.setState({
        conversations: conversations.map(c =>
          c.id === tempId ? {
            ...c,
            id: uuid,
            title: conv.title || '对话',
            model: conv.model || 'gpt-4o',
            tags: conv.tags,
            activeScenario,
            scenarioSkillIds: activeScenario?.recommendedSkills || [],
            scenarioWorkflowIds: activeScenario?.workflowTemplates?.map(w => w.id) || [],
          } : c
        ),
        activeConversationId: uuid,
      })
    }
    useChatStore.getState().updateConversation(uuid, {
      messages,
      model: conv.model || 'gpt-4o',
      tags: conv.tags,
      activeScenario,
      scenarioSkillIds: activeScenario?.recommendedSkills || [],
      scenarioWorkflowIds: activeScenario?.workflowTemplates?.map(w => w.id) || [],
      _hasMore: conv.hasMore ?? false,
    } as any)
    if (scenarioId) hydrateConversationScenario(uuid, scenarioId)
    useChatStore.getState().truncateConversationContent(uuid, 5, 500)
  } catch (e: any) {
    // AbortError is an expected cancellation when switching conversations.
    if (e?.name === 'AbortError') return
  }
}

/**
 *
 *
 */
export async function loadOlderMessages(uuid: string, beforeId: string, signal?: AbortSignal) {
  if (DEMO_MODE) return { hasMore: false }
  try {
    const conv = await chatApi.getConversation(uuid, 50, beforeId, signal)
    const olderMessages = (conv.messages || []).map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
      model: m.model,
      tokens: m.tokens,
    }))
    if (olderMessages.length > 0) {
      const chatStore = useChatStore.getState()
      const existing = chatStore.conversations.find(c => c.id === uuid)
      if (existing) {
        const merged = [...olderMessages, ...existing.messages]
        useChatStore.getState().updateConversation(uuid, {
          messages: merged,
          _hasMore: conv.hasMore ?? false,
        } as any)
      }
    }
    return { hasMore: conv.hasMore ?? false }
  } catch (e: any) {
    if (e?.name === 'AbortError') return { hasMore: false }
    console.warn('加载更早消息失败:', e)
    return { hasMore: false }
  }
}

export async function apiDeleteConversation(uuid: string) {
  if (DEMO_MODE) return
  await chatApi.deleteConversation(uuid)
}

export async function apiClearMessages(uuid: string) {
  if (DEMO_MODE) return
  await chatApi.clearMessages(uuid)
}

export async function apiTogglePin(uuid: string) {
  if (DEMO_MODE) return
  await chatApi.togglePin(uuid)
}

export function getApiBaseUrl() { return BASE_URL }
export function isDemoMode() { return DEMO_MODE }

/** ============================================================
 *
 *
 * ============================================================ */
export async function uploadLedgerFile(
  file: File,
  fileType: 'image' | 'excel' | 'other' = 'other'
): Promise<{ file_path: string; file_name: string; file_type: string; size: string }> {
  const token = getToken()
  const formData = new FormData()
  formData.append('file', file)
  formData.append('type', fileType)

  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}/v1/ledger/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  const data = await res.json()
  if (data.code !== 200) throw new Error(normalizeMojibakeMessage(data.message, '文件上传失败'))
  return data.data
}

/**
 *
 *
 *
 */
export async function uploadFileToOss(
  file: File,
  convUuid?: string,
): Promise<{
  url: string;
  objectKey: string;
  fileName: string;
  size: number;
  contentType: string;
  workFileId?: number;
}> {
  const token = getToken()
  const formData = new FormData()
  formData.append('file', file)
  if (convUuid) formData.append('convUuid', convUuid)

  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}/files/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  const data = await res.json()
  if (data.code !== 200) throw new Error(normalizeMojibakeMessage(data.message, 'OSS 上传失败'))
  return data.data
}

/**
 *
 *
 */
export async function transcribeAudio(audioUrl: string): Promise<string> {
  const data = await request<{ text: string }>('POST', '/util/transcribe', { fileUrl: audioUrl })
  return data.text || ''
}

/**
 *
 * POST /api/util/transcribe/upload
 */
export async function transcribeAudioFile(file: File): Promise<string> {
  const formData = new FormData()
  formData.append('audio', file, file.name || 'audio.mp3')

  let token: string | null = null
  try {
    const raw = localStorage.getItem('auth-store')
    if (raw) {
      const store = JSON.parse(raw)
      token = store?.state?.token || null
    }
  } catch { /* ignore */ }

  const res = await fetch('/api/util/transcribe/upload', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`语音识别失败: HTTP ${res.status} ${normalizeMojibakeMessage(errText, '')}`)
  }
  const data = await res.json()
  return data.data?.text || ''
}

/** ============================================================
 * AutoCode Agent Platform API
 *
 * ============================================================ */
const AUTOCODE_API = import.meta.env.VITE_AUTOCODE_API_URL || '/autocode-api'

function getUserId(): string | null {
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return null
    const store = JSON.parse(raw)
    return store?.state?.user?.id || null
  } catch {
    return null
  }
}

async function acRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = getToken()
  const userId = getUserId()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  if (userId) {
    headers['X-User-Id'] = userId
  }
  const res = await fetch(`${AUTOCODE_API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`AutoCode API error ${res.status}: ${await res.text()}`)
  return res.json()
}

/** Register an imported project as a persistent AutoCode task. */
export async function registerImportedProjectTask(
  projectId: string,
  options?: { enable_smart_planning?: boolean },
): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', `/api/projects/${projectId}/register-task`, {
    enable_smart_planning: Boolean(options?.enable_smart_planning),
  })
}

export interface AutoCodeReviewIssue {
  level: 'error' | 'warn' | 'info'
  rule: string
  file: string
  message: string
}

export interface AutoCodeReviewResult {
  passed: boolean
  score: number
  summary: string
  issues: AutoCodeReviewIssue[]
  dimensions?: Record<string, unknown>
  phase?: string
  guardrail_kind?: 'phase' | 'agentic' | string
  subtasks?: Array<{ id: string; title: string; agent_type?: string }>
  reviewed_at?: string
}

export interface PrototypeRecord {
  id?: string
  prototype_id?: string
  title?: string
  description?: string
  kind?: 'html' | 'excalidraw'
  source?: string
  file?: string
  preview_url?: string
  html?: string
  html_preview?: string
  excalidraw?: {
    type?: string
    version?: number
    elements?: Array<Record<string, unknown>>
    appState?: Record<string, unknown>
  }
  features?: string[]
  tech_notes?: string
  active?: boolean
  created_at?: string
  updated_at?: string
}

export type AutoCodeToolPolicy = 'ask' | 'auto_safe' | 'full_access'

export interface AutoCodeLocalRunnerStatus {
  task_id?: string
  session_id?: string
  enabled: boolean
  connected: boolean
  connection_state?: 'disabled' | 'disconnected' | 'stale' | 'connected'
  project_root?: string
  runner_version?: string
  created_at?: string
  connected_at?: string
  disconnected_at?: string
  last_seen_at?: string
  disconnect_reason?: string
  reconnect_count?: number
  pending_count?: number
  active_tool?: string
  token?: string
  local_project_grant_id?: string
  device_id?: string
  device_name?: string
  device_os?: string
  download_url?: string
  install_url?: string
  launch_url?: string
  connector_update_required?: boolean
  connector_min_version?: string
  connector_protocol?: string
  connector_available?: boolean
  ws_url?: string
  command?: string
}

export interface AutoCodeLocalProjectGrant {
  grant_id: string
  server_base?: string
  project_root: string
  project_name?: string
  task_id?: string
  workspace_id?: string
  device_id?: string
  device_name?: string
  device_os?: string
  device_status?: string
  device_online?: boolean
  device_last_seen_at?: string
  expires_at?: string
  last_used_at?: string
  open_url?: string
}

interface AutoCodeTaskResponse {
  id: string
  title: string
  description?: string
  project_type: string
  workspace_id: string
  status: string
  agents: string[]
  preview_url?: string
  model?: string
  tool_policy?: AutoCodeToolPolicy
  pending_confirmation?: Record<string, unknown> | null
  local_execution_enabled?: boolean
  local_runner_session_id?: string
  local_import_mode?: boolean
  cloud_snapshot_enabled?: boolean
  cloud_snapshot_status?: string
  cloud_snapshot_error?: string
  local_runner?: AutoCodeLocalRunnerStatus
  created_at?: string
  progress?: number
  current_step?: string
  logs?: Record<string, unknown>[]
  plan?: {
    overall_approach?: string
    architecture?: string
    tech_stack?: Record<string, string>
    subtasks?: Array<{
      id: string
      title: string
      description: string
      agent_type?: string
      estimated_files?: string[]
      dependencies?: string[]
      status?: string
      progress?: number
    }>
    execution_groups?: string[][]
  }
  review?: AutoCodeReviewResult
  phase_reviews?: AutoCodeReviewResult[]
  prototype?: PrototypeRecord
  plan_confirmed?: boolean
  prototype_confirmed?: boolean
  review_confirmed?: boolean
  execution_active?: boolean
  runtime_state?: string
  runtime_note?: string
  queued_at?: string
  command_history?: AutoCodeCommandRecord[]
  pipeline_runs?: AutoCodePipelineRun[]
  pipeline_status?: string
  preview_status?: string
  preview_error?: string
  project_recon?: Record<string, unknown>
  complexity?: string
  recommended_flow?: string
  prototype_required?: boolean
  events?: AutoCodeRuntimeEvent[]
}

export interface AutoCodeRuntimeEvent {
  id: string
  type: string
  task_id: string
  source?: string
  created_at?: string
  workspace_id?: string
  conversation_message_id?: string
  snapshot_hash?: string
  payload?: Record<string, unknown>
}

export interface AutoCodeToolSpec {
  name: string
  description?: string
  label?: string
  action?: string
  purpose?: string
  side_effect?: string
  permission_default?: string
  risk_level?: number
  timeout_seconds?: number
  allowed_roles?: string[]
  cost_tag?: string
  cacheable?: boolean
  mutates_workspace?: boolean
  requires_confirmation?: boolean
  local_runner_enabled?: boolean
  output_mode?: string
  max_model_chars?: number
  max_preview_chars?: number
  metadata?: Record<string, unknown>
}

export async function createAutoCodeTask(params: {
  title: string
  description: string
  project_type?: string
  agent_types?: string[]
  model?: string
  spec?: string
  tool_policy?: AutoCodeToolPolicy
  enable_smart_planning?: boolean
}): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', '/api/tasks', {
    title: params.title,
    description: params.description,
    project_type: params.project_type || 'nextjs',
    agent_types: params.agent_types || ['frontend'],
    ...(params.model ? { model: params.model } : {}),
    ...(params.spec ? { spec: params.spec } : {}),
    ...(params.tool_policy ? { tool_policy: params.tool_policy } : {}),
    ...(params.enable_smart_planning !== undefined ? { enable_smart_planning: params.enable_smart_planning } : {}),
  })
}

/** 查询 AutoCode 任务状态 */
export async function getAutoCodeTaskStatus(taskId: string): Promise<{
  status: string
  progress: number
  current_step: string
  preview_url?: string
  workspace_id?: string
  model?: string
  tool_policy?: AutoCodeToolPolicy
  pending_confirmation?: Record<string, unknown> | null
  local_execution_enabled?: boolean
  local_runner?: AutoCodeLocalRunnerStatus
  plan?: AutoCodeTaskResponse['plan']
  review?: AutoCodeReviewResult
  phase_reviews?: AutoCodeReviewResult[]
  prototype?: PrototypeRecord
  plan_confirmed?: boolean
  prototype_confirmed?: boolean
  review_confirmed?: boolean
  execution_active?: boolean
  runtime_state?: string
  runtime_note?: string
  queued_at?: string
  command_history?: AutoCodeCommandRecord[]
  pipeline_runs?: AutoCodePipelineRun[]
  pipeline_status?: string
  preview_status?: string
  preview_error?: string
  project_recon?: Record<string, unknown>
  complexity?: string
  recommended_flow?: string
  prototype_required?: boolean
}> {
  return acRequest<{
    status: string; progress: number; current_step: string
    preview_url?: string; workspace_id?: string
    model?: string
    tool_policy?: AutoCodeToolPolicy
    pending_confirmation?: Record<string, unknown> | null
    local_execution_enabled?: boolean
    local_runner?: AutoCodeLocalRunnerStatus
    plan?: AutoCodeTaskResponse['plan']
    review?: AutoCodeReviewResult
    phase_reviews?: AutoCodeReviewResult[]
    prototype?: PrototypeRecord
    plan_confirmed?: boolean
    prototype_confirmed?: boolean
    review_confirmed?: boolean
    execution_active?: boolean
    runtime_state?: string
    runtime_note?: string
    queued_at?: string
    command_history?: AutoCodeCommandRecord[]
    pipeline_runs?: AutoCodePipelineRun[]
    pipeline_status?: string
    preview_status?: string
    preview_error?: string
  }>('GET', `/api/tasks/${taskId}/status`)
}

export async function getAutoCodeTask(taskId: string): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('GET', `/api/tasks/${taskId}`)
}

export async function updateAutoCodeToolPolicy(
  taskId: string,
  toolPolicy: AutoCodeToolPolicy,
): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('PATCH', `/api/tasks/${taskId}/tool-policy`, {
    tool_policy: toolPolicy,
  })
}

export async function setAutoCodeLocalRunnerMode(
  taskId: string,
  enabled: boolean,
  options?: { project_path?: string; public_api_base?: string; grant_id?: string; device_id?: string },
): Promise<AutoCodeLocalRunnerStatus> {
  return acRequest<AutoCodeLocalRunnerStatus>('POST', `/api/local-runner/${taskId}/mode`, {
    enabled,
    project_path: options?.project_path || '',
    public_api_base: options?.public_api_base || '',
    grant_id: options?.grant_id || '',
    device_id: options?.device_id || '',
  })
}

export async function getAutoCodeLocalRunnerStatus(taskId: string): Promise<AutoCodeLocalRunnerStatus> {
  return acRequest<AutoCodeLocalRunnerStatus>('GET', `/api/local-runner/${taskId}/status`)
}

export async function syncAutoCodeLocalRunnerSnapshot(taskId: string): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', `/api/local-runner/${taskId}/sync-snapshot`)
}

export async function createAutoCodeLocalRunnerSession(
  projectPath?: string,
  publicApiBase?: string,
  grantId?: string,
): Promise<AutoCodeLocalRunnerStatus> {
  return acRequest<AutoCodeLocalRunnerStatus>('POST', '/api/local-runner/session', {
    project_path: projectPath || '',
    public_api_base: publicApiBase || '',
    grant_id: grantId || '',
  })
}

export async function listAutoCodeLocalProjectGrants(): Promise<AutoCodeLocalProjectGrant[]> {
  const data = await acRequest<{ items?: AutoCodeLocalProjectGrant[] }>('GET', '/api/local-runner/grants')
  return Array.isArray(data.items) ? data.items : []
}

export async function getAutoCodeLocalRunnerSessionStatus(sessionId: string): Promise<AutoCodeLocalRunnerStatus> {
  return acRequest<AutoCodeLocalRunnerStatus>('GET', `/api/local-runner/session/${sessionId}/status`)
}

export async function registerLocalRunnerTask(
  sessionId: string,
  params: { title?: string; project_path?: string; enable_smart_planning?: boolean; sync_to_cloud?: boolean },
): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', `/api/local-runner/session/${sessionId}/register-task`, {
    title: params.title,
    project_path: params.project_path,
    enable_smart_planning: Boolean(params.enable_smart_planning),
    sync_to_cloud: Boolean(params.sync_to_cloud),
  })
}

export function getAutoCodeLocalRunnerDownloadUrl(): string {
  return `${AUTOCODE_API}/api/local-runner/download`
}

export async function getAutoCodeTaskEvents(taskId: string, after?: string): Promise<{ events: AutoCodeRuntimeEvent[]; total: number }> {
  const qs = after ? `?after=${encodeURIComponent(after)}` : ''
  return acRequest<{ events: AutoCodeRuntimeEvent[]; total: number }>('GET', `/api/tasks/${taskId}/events${qs}`)
}

export async function listAutoCodeTools(): Promise<{ tools: AutoCodeToolSpec[] }> {
  return acRequest<{ tools: AutoCodeToolSpec[] }>('GET', '/api/tasks/tools')
}

export async function resolveAutoCodeApproval(
  taskId: string,
  eventId: string,
  approved: boolean,
  note?: string,
): Promise<{ ok: boolean; approved: boolean; already_resolved?: boolean }> {
  return acRequest<{ ok: boolean; approved: boolean; already_resolved?: boolean }>('POST', `/api/tasks/${taskId}/approvals/${eventId}`, {
    approved,
    note,
  })
}

export async function listAutoCodeTasks(): Promise<AutoCodeTaskResponse[]> {
  return acRequest<AutoCodeTaskResponse[]>('GET', '/api/tasks')
}

export interface AutoCodeQueueStatus {
  total: number
  runnable: number
  waiting: number
  workers: number
  queue_size: number
  queued_count: number
  queued_task_ids: string[]
  active_task_ids: string[]
  tasks?: Array<{
    id?: string
    title?: string
    status?: string
    current_step?: string
    progress?: number
    queued_at?: string
    execution_active?: boolean
    runtime?: Record<string, unknown>
  }>
}

export async function getAutoCodeQueueStatus(): Promise<AutoCodeQueueStatus> {
  return acRequest<AutoCodeQueueStatus>('GET', '/api/tasks/queue/status')
}

export async function deleteAutoCodeTask(taskId: string): Promise<void> {
  await acRequest<void>('DELETE', `/api/tasks/${taskId}`)
}

/** 重命名 AutoCode 任务 */
export async function renameAutoCodeTask(taskId: string, title: string): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('PATCH', `/api/tasks/${taskId}`, { title })
}

/** 为已创建的 AutoCode 任务开启/生成智能计划 */
export async function enableAutoCodeTaskPlanning(
  taskId: string,
  params?: { objective?: string; context?: string },
): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', `/api/tasks/${taskId}/smart-planning`, params || {})
}

export async function stopAutoCodeTask(taskId: string): Promise<void> {
  await acRequest<void>('POST', `/api/tasks/${taskId}/stop`)
}

export async function retryAutoCodeTask(taskId: string): Promise<AutoCodeTaskResponse> {
  return acRequest<AutoCodeTaskResponse>('POST', `/api/tasks/${taskId}/retry`)
}

export async function confirmPlan(
  taskId: string,
  confirmed: boolean,
  modifiedPlan?: {
    overall_approach?: string
    architecture?: string
    tech_stack?: Record<string, string>
    subtasks?: Array<{
      id: string
      title: string
      description: string
      agent_type?: string
      estimated_files?: string[]
      dependencies?: string[]
    }>
    execution_groups?: string[][]
  }
): Promise<{ success: boolean }> {
  return acRequest<{ success: boolean }>('POST', `/api/tasks/${taskId}/confirm-plan`, {
    confirmed,
    ...(modifiedPlan ? { modified_plan: modifiedPlan } : {}),
  })
}

export async function confirmPrototype(
  taskId: string,
  confirmed: boolean,
  modifiedPrototype?: Record<string, unknown>
): Promise<{ success: boolean }> {
  return acRequest<{ success: boolean }>('POST', `/api/tasks/${taskId}/confirm-prototype`, {
    confirmed,
    ...(modifiedPrototype ? { modified_prototype: modifiedPrototype } : {}),
  })
}

// ==================== 项目管理 ====================

interface ProjectResponse {
  id: string
  name: string
  source: string
  source_url?: string
  path: string
  status: string
  created_at: string
  file_count: number
  clone_output?: string
}

export async function cloneProject(gitUrl: string, projectName?: string): Promise<{ project_id: string; name: string; status: string }> {
  return acRequest('POST', '/api/projects/clone', { git_url: gitUrl, project_name: projectName })
}

/** 本地上传项目（ZIP/TAR）。 */
export async function uploadProject(file: File, projectName?: string): Promise<{ project_id: string; name: string; status: string }> {
  const formData = new FormData()
  formData.append('file', file)
  if (projectName) formData.append('project_name', projectName)
  const token = getToken()
  const userId = getUserId()
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (userId) headers['X-User-Id'] = userId
  const res = await fetch(`${AUTOCODE_API}/api/projects/upload`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) throw new Error(`上传失败: ${normalizeMojibakeMessage(await res.text(), '')}`)
  return res.json()
}

// ==================== UI 原型 API ====================

export async function listPrototypeRecords(workspaceId: string): Promise<PrototypeRecord[]> {
  const res = await acRequest<{ ok: boolean; items: PrototypeRecord[] }>('GET', `/api/prototype/workspace/${workspaceId}/items`)
  return res.items || []
}

export async function getPrototypeRecord(workspaceId: string, prototypeId: string): Promise<PrototypeRecord> {
  const res = await acRequest<{ ok: boolean; item: PrototypeRecord }>('GET', `/api/prototype/workspace/${workspaceId}/items/${prototypeId}`)
  return res.item
}

export async function updatePrototypeRecord(workspaceId: string, prototypeId: string, item: PrototypeRecord): Promise<PrototypeRecord> {
  const res = await acRequest<{ ok: boolean; item: PrototypeRecord }>('PUT', `/api/prototype/workspace/${workspaceId}/items/${prototypeId}`, item)
  return res.item
}

export async function activatePrototypeRecord(workspaceId: string, prototypeId: string): Promise<PrototypeRecord> {
  const res = await acRequest<{ ok: boolean; item: PrototypeRecord }>('POST', `/api/prototype/workspace/${workspaceId}/items/${prototypeId}/activate`)
  return res.item
}

export async function generatePrototype(workspaceId: string, params: { title: string; description: string; theme?: string }): Promise<{ prototype_id: string; status?: string }> {
  return acRequest('POST', '/api/prototype/generate', { workspace_id: workspaceId, description: params.description })
}

export async function getPrototype(workspaceId: string): Promise<{ html: string | null; status: string; updated_at: string }> {
  return acRequest('GET', `/api/prototype/${workspaceId}`)
}

export async function iteratePrototype(taskId: string, feedback: string): Promise<{ prototype_id: string; status: string }> {
  return acRequest('POST', `/api/prototype/${taskId}/iterate`, { feedback })
}

export async function listProjects(): Promise<ProjectResponse[]> {
  return acRequest('GET', '/api/projects')
}

export async function getProject(projectId: string): Promise<ProjectResponse> {
  return acRequest('GET', `/api/projects/${projectId}`)
}

export async function deleteProject(projectId: string): Promise<void> {
  await acRequest('DELETE', `/api/projects/${projectId}`)
}

export async function listProjectFiles(projectId: string, subdir?: string): Promise<{ files: { name: string; is_dir: boolean; size: number; modified: string }[]; total: number }> {
  const p = subdir ? `?subdir=${encodeURIComponent(subdir)}` : ''
  return acRequest('GET', `/api/projects/${projectId}/files${p}`)
}


/** 读取 SPEC.md */
export async function getSpec(workspaceId: string): Promise<{ content: string | null; has_spec: boolean }> {
  return acRequest('GET', `/api/workspaces/${workspaceId}/spec`)
}

export async function getSpecTemplate(workspaceId: string, projectName?: string): Promise<{ content: string }> {
  const p = projectName ? `?project_name=${encodeURIComponent(projectName)}` : ''
  return acRequest('GET', `/api/workspaces/${workspaceId}/spec/template${p}`)
}

/** 保存 SPEC.md */
export async function updateSpec(workspaceId: string, content: string): Promise<void> {
  await acRequest('PUT', `/api/workspaces/${workspaceId}/spec`, { content })
}

// ==================== AutoCode Workspace Files / Git ====================

export interface AutoCodeWorkspaceFile {
  name: string
  path?: string
  type: 'file' | 'dir'
  size: number
  modified?: string
}

export interface AutoCodeFileContent {
  path: string
  name: string
  content: string
  size: number
}

export interface AutoCodeGitChange {
  status: string
  path: string
  old_path?: string | null
  staged?: boolean
  working_tree?: boolean
}

export interface AutoCodeGitStatus {
  available: boolean
  branch: string
  head: string
  dirty: boolean
  changes: AutoCodeGitChange[]
  error?: string
}

export interface AutoCodeGitCommit {
  hash: string
  message: string
  author: string
  date: string
  files_changed: string[]
  metadata?: {
    autocode_snapshot?: boolean
    task_id?: string
    task_title?: string
    agent?: string
    phase?: string
    iteration?: number
    trigger_prompt?: string
    changed_files?: string[]
    created_at?: string
  } | null
}

export interface AutoCodeCommandRecord {
  id: string
  command: string
  label?: string
  status: 'running' | 'success' | 'failed'
  source?: string
  output?: string
  exit_code?: number | null
  started_at?: string
  finished_at?: string | null
}

export interface AutoCodePipelineRun {
  status: 'passed' | 'failed' | string
  steps?: AutoCodeCommandRecord[]
  created_at?: string
  preview_status?: string
  preview_url?: string
  preview_error?: string
}

export async function listAutoCodeWorkspaceFiles(taskId: string, path = '/'): Promise<{ path: string; files: AutoCodeWorkspaceFile[] }> {
  const data = await acRequest<{ path?: string; files?: AutoCodeWorkspaceFile[] } | null>('GET', `/api/tasks/${taskId}/files?path=${encodeURIComponent(path)}`)
  return {
    path: data?.path || path,
    files: Array.isArray(data?.files) ? data.files : [],
  }
}

export async function readAutoCodeWorkspaceFile(taskId: string, path: string): Promise<AutoCodeFileContent> {
  return acRequest('GET', `/api/tasks/${taskId}/files/content?path=${encodeURIComponent(path)}`)
}

export async function saveAutoCodeWorkspaceFile(taskId: string, path: string, content: string): Promise<void> {
  await acRequest('PUT', `/api/tasks/${taskId}/files/content`, { path, content })
}

export async function runAutoCodeWorkspaceFile(taskId: string, path: string): Promise<{ command?: string; stdout?: string; stderr?: string; exit_code?: number }> {
  return acRequest('POST', `/api/tasks/${taskId}/files/run`, { path })
}

export async function listAutoCodeCommands(taskId: string): Promise<{ commands: AutoCodeCommandRecord[] }> {
  return acRequest('GET', `/api/tasks/${taskId}/commands`)
}

export async function runAutoCodeCommand(taskId: string, params: { kind?: 'test' | 'build' | 'custom'; command?: string }): Promise<AutoCodeCommandRecord> {
  return acRequest('POST', `/api/tasks/${taskId}/commands/run`, params)
}

export async function runAutoCodePipeline(taskId: string): Promise<{
  status: string
  steps: AutoCodeCommandRecord[]
  preview_status?: string
  preview_url?: string
  preview_error?: string
}> {
  return acRequest('POST', `/api/tasks/${taskId}/commands/pipeline`, {})
}

export async function getAutoCodeGitStatus(workspaceId: string): Promise<AutoCodeGitStatus> {
  return acRequest('GET', `/api/git/workspaces/${workspaceId}/status`)
}

export async function getAutoCodeGitLog(workspaceId: string, limit = 30): Promise<AutoCodeGitCommit[]> {
  return acRequest('GET', `/api/git/workspaces/${workspaceId}/log?limit=${limit}`)
}

export async function getAutoCodeGitDiff(workspaceId: string, commitHash: string): Promise<{ diff: string }> {
  return acRequest('GET', `/api/git/workspaces/${workspaceId}/diff/${encodeURIComponent(commitHash)}`)
}

export async function getAutoCodeWorkingDiff(workspaceId: string, staged = false): Promise<{ diff: string }> {
  return acRequest('GET', `/api/git/workspaces/${workspaceId}/diff-working?staged=${staged ? 'true' : 'false'}`)
}


export interface OssConfigVO {
  uuid: string
  name: string
  provider: 'aliyun' | 'tencent' | 'minio'
  endpoint: string
  region: string
  bucket: string
  accessKey: string
  secretKey: string
  basePath: string
  isDefault: boolean
  status: 'active' | 'disabled' | 'error'
  lastTestAt: string
  testResult: string
  createdAt: string
  updatedAt: string
}

export const ossApi = {
  list: () => request<OssConfigVO[]>('GET', '/admin/oss'),
  get: (uuid: string) => request<OssConfigVO>('GET', `/admin/oss/${uuid}`),
  create: (data: Partial<OssConfigVO>) => request<OssConfigVO>('POST', '/admin/oss', data),
  update: (uuid: string, data: Partial<OssConfigVO>) => request<OssConfigVO>('PUT', `/admin/oss/${uuid}`, data),
  delete: (uuid: string) => request<void>('DELETE', `/admin/oss/${uuid}`),
  toggle: (uuid: string, status: string) => request<OssConfigVO>('POST', `/admin/oss/${uuid}/toggle`, { status }),
  setDefault: (uuid: string) => request<OssConfigVO>('POST', `/admin/oss/${uuid}/default`),
  test: (uuid: string) => request<string>('POST', `/admin/oss/${uuid}/test`),
}


export const walletApi: {
  getBalance: () => Promise<number>
  getTransactions: () => Promise<WalletTransaction[]>
  recharge: (amount: number, description?: string, paymentMethod?: string) => Promise<PaymentCreateResponse>
  withdraw: (amount: number, description?: string) => Promise<WalletTransaction>
  adminTransactions: (limit?: number) => Promise<WalletTransaction[]>
  adminRecharge: (userId: number, amount: number, description?: string) => Promise<WalletTransaction>
  adminApproveWithdraw: (txId: number) => Promise<WalletTransaction>
  adminRejectWithdraw: (txId: number, reason?: string) => Promise<WalletTransaction>
} = {
  getBalance: () => request<number>('GET', '/wallet/balance'),
  getTransactions: () => request<WalletTransaction[]>('GET', '/wallet/transactions'),
  recharge: (amount, description, paymentMethod = 'alipay') => request<PaymentCreateResponse>('POST', '/wallet/recharge', { amount, description, paymentMethod }),
  withdraw: (amount, description) => request<WalletTransaction>('POST', '/wallet/withdraw', { amount, description }),
  adminTransactions: (limit = 100) => request<WalletTransaction[]>('GET', `/wallet/admin/transactions?limit=${limit}`),
  adminRecharge: (userId, amount, description) => request<WalletTransaction>('POST', '/wallet/admin/recharge', { userId, amount, description }),
  adminApproveWithdraw: (txId) => request<WalletTransaction>('POST', '/wallet/admin/withdraw/approve', { txId }),
  adminRejectWithdraw: (txId, reason) => request<WalletTransaction>('POST', '/wallet/admin/withdraw/reject', { txId, reason }),
}


export interface MemorySettingVO {
  id: number
  settingKey: string
  settingName: string
  content: string
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export interface MemoryDocumentVO {
  id: number
  uuid: string
  docType: string
  title: string
  content: string
  category: string
  tags: string[]
  importance: number
  status: string
  sourceConvUuid: string
  expiresAt: string | null
  fileSize: number
  fileType: string
  ossUrl: string
  createdAt: string
  updatedAt: string
  indexSummary?: string
  virtualPath?: string
}

export interface MemoryIndexVO {
  id: number
  docId: number
  category: string
  summary: string
  tags: string[]
  importance: number
  expiresAt: string | null
  createdAt: string
  updatedAt: string
  docUuid?: string
  docType?: string
  layer?: string
  virtualPath?: string
}

export interface MemoryWorkFileVO {
  id: number
  uuid: string
  fileName: string
  fileType: string
  fileSize: number
  mimeType: string
  ossUrl: string
  thumbUrl: string
  description: string
  tags: string[]
  createdAt: string
  hasDoc: boolean
  docUuid?: string
}

export interface MemoryFileTreeNode {
  key: string
  title: string
  type: 'folder' | 'file'
  fileType?: string
  docType?: string
  docId?: string
  icon?: string
  children?: MemoryFileTreeNode[]
  isLeaf?: boolean
  layer?: string
  virtualPath?: string
}

export interface MemoryContext {
  soul: string
  tools: string
  rules: string
  conversationMemory: string
  userProfile: string
  conversationFiles: string[]
  relevantSkills: Array<{ title: string; summary: string; content: string; tags: string[] }>
  injectedSystemPrompt: string
}

export interface MemoryStatsVO {
  totalDocs: number
  preferences: number
  projectMemories: number
  conversationMemories: number
  skillMemories: number
  workFiles: number
  indexes: number
  lastUpdated: string
  byCategory: Record<string, number>
}

export const memoryApi = {
  listSettings: () => request<MemorySettingVO[]>('GET', '/memory/settings'),
  getSetting: (key: string) => request<MemorySettingVO>('GET', `/memory/settings/${key}`),
  saveSetting: (data: Partial<MemorySettingVO> & { settingKey: string; content: string }) =>
    request<MemorySettingVO>('PUT', '/memory/settings', data),
  deleteSetting: (key: string) => request<string>('DELETE', `/memory/settings/${key}`),

  listDocuments: (params?: { docType?: string; category?: string; conversationId?: number }) => {
    const qs = new URLSearchParams()
    if (params?.docType) qs.set('docType', params.docType)
    if (params?.category) qs.set('category', params.category)
    if (params?.conversationId) qs.set('conversationId', String(params.conversationId))
    const q = qs.toString()
    return request<MemoryDocumentVO[]>('GET', `/memory/documents${q ? '?' + q : ''}`)
  },
  getDocument: (uuid: string) => request<MemoryDocumentVO>('GET', `/memory/documents/${uuid}`),
  saveDocument: (data: Partial<MemoryDocumentVO> & { docType: string; title: string; content: string }) =>
    request<MemoryDocumentVO>('POST', '/memory/documents', data),
  updateDocument: (uuid: string, data: Partial<MemoryDocumentVO>) =>
    request<MemoryDocumentVO>('PUT', `/memory/documents/${uuid}`, data),
  deleteDocument: (uuid: string) => request<string>('DELETE', `/memory/documents/${uuid}`),
  getUserProfile: () => request<MemoryDocumentVO>('GET', '/memory/user-profile'),
  saveUserProfile: (content: string) =>
    request<MemoryDocumentVO>('PUT', '/memory/user-profile', { content }),
  getUserSystemPrompt: () => request<MemoryDocumentVO>('GET', '/memory/user-system-prompt'),
  saveUserSystemPrompt: (content: string) =>
    request<MemoryDocumentVO>('PUT', '/memory/user-system-prompt', { content }),
  forgetUserProfile: () => request<string>('DELETE', '/memory/user-profile'),

  listIndexes: (category?: string) =>
    request<MemoryIndexVO[]>('GET', `/memory/indexes${category ? '?category=' + encodeURIComponent(category) : ''}`),

  listWorkFiles: (params?: { conversationId?: number; fileType?: string }) => {
    const qs = new URLSearchParams()
    if (params?.conversationId) qs.set('conversationId', String(params.conversationId))
    if (params?.fileType) qs.set('fileType', params.fileType)
    const q = qs.toString()
    return request<MemoryWorkFileVO[]>('GET', `/memory/work-files${q ? '?' + q : ''}`)
  },
  deleteWorkFile: (fileId: number) => request<string>('DELETE', `/memory/work-files/${fileId}`),

  // File tree
  getFileTree: (convUuid?: string) =>
    request<MemoryFileTreeNode[]>('GET', `/memory/file-tree${convUuid ? '?convUuid=' + encodeURIComponent(convUuid) : ''}`),

  // Search
  search: (params: { keyword?: string; docType?: string; category?: string; tags?: string[]; page?: number; size?: number }) =>
    request<{ documents: MemoryDocumentVO[]; indexes: MemoryIndexVO[]; total: number; page: number; size: number }>(
      'POST', '/memory/search', params),

  // Injected context
  getContext: (params?: { conversationId?: number; convUuid?: string }) => {
    const qs = new URLSearchParams()
    if (params?.conversationId) qs.set('conversationId', String(params.conversationId))
    if (params?.convUuid) qs.set('convUuid', params.convUuid)
    const q = qs.toString()
    return request<MemoryContext>('GET', `/memory/context${q ? '?' + q : ''}`)
  },

  // Memory stats
  getStats: () =>
    request<MemoryStatsVO>('GET', '/memory/stats'),

  // Memory timeline
  getTimeline: (limit?: number) =>
    request<MemoryDocumentVO[]>('GET', `/memory/timeline${limit ? '?limit=' + limit : ''}`),

  // 轻量级语义搜索
  semanticSearch: (params: { keyword?: string; docType?: string; category?: string; tags?: string[]; page?: number; size?: number }) =>
    request<MemoryDocumentVO[]>('POST', '/memory/search/semantic', params),

  // 分层统计
  getTierStats: () =>
    request<Record<string, number>>('GET', '/memory/tier/stats'),

  triggerTierAudit: () =>
    request<{ archived: number; demotedFromL1: number }>('POST', '/memory/tier/audit'),
}

export interface RoutingRule {
  id: number
  userId?: number | null
  user_id?: number | null
  name?: string
  description?: string
  sceneType?: string
  scene_type?: string
  agentType?: string
  agent_type?: string
  complexity?: string
  requiredCapabilities?: string
  preferredProviders?: string
  minContextLength?: number
  maxInputPrice?: number
  maxOutputPrice?: number
  priority: number
  enabled: number | boolean
  created_at: string
  updated_at: string
}

export interface RoutingModelOption {
  id: number
  model_id: string
  modelId?: string
  name?: string
  provider: string
  capabilities: string[]
  strengths: string[]
  task_types?: string[]
  context_length: number
  input_price: number
  output_price: number
  code_quality: number
  routing_priority?: number
  status?: {
    available: boolean
    failures: number
  }
}

export interface RoutingCandidate {
  id: number
  model_id: string
  name: string
  provider: string
  channel_name: string
  capabilities: string[]
  strengths: string[]
  code_quality: number
  input_price: number
  output_price: number
  context_length: number
  status: {
    available: boolean
    failures: number
  }
}

export interface RoutingStats {
  rules: {
    total: number
    by_agent_type: Record<string, number>
    by_model: Record<string, number>
  }
  circuit_breaker: {
    broken: Record<string, number>
    failure_counts: Record<string, number>
  }
  cache: {
    entries: number
  }
}

export interface RouteTestRequest {
  sceneType?: string
  agentType?: string
  complexity?: string
  requiredCapabilities?: string[]
  preferredProviders?: string[]
  minContextLength?: number
  maxInputPrice?: number
  maxOutputPrice?: number
}

export interface RouteTestResult {
  modelId?: string
  model_id: string
  channelId?: string
  provider: string
  score: number
  reason?: string
}

async function routingRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    let message = text
    try {
      const parsed = JSON.parse(text)
      message = parsed?.error || parsed?.message || text
    } catch {
      // Keep raw text for non-JSON errors.
    }
    throw new Error(message || `Routing API error ${res.status}`)
  }
  const data = await res.json()
  return data?.code === 200 && data.data !== undefined ? data.data as T : data as T
}

export const routingApi = {
  listModels: () =>
    routingRequest<{ success: boolean; data: RoutingModelOption[]; total: number }>('GET', '/routing/models'),

  // 路由规则 CRUD
  listRules: (params?: {
    agent_type?: string; task_phase?: string; content_type?: string
    complexity?: string; model_id?: string; enabled?: boolean
    scope?: 'effective' | 'mine' | 'global' | 'all'
    page?: number; page_size?: number
  }) => {
    const qs = new URLSearchParams()
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== '') qs.set(k, String(v))
      })
    }
    const q = qs.toString()
    return routingRequest<{
      success: boolean; data: RoutingRule[]
      pagination: { page: number; page_size: number; total: number; total_pages: number }
    }>('GET', `/routing/rules${q ? '?' + q : ''}`)
  },

  createRule: (rule: Record<string, unknown>, scope: 'mine' | 'global' = 'mine') =>
    routingRequest<{ success: boolean; data: any; message: string }>('POST', `/routing/rules?scope=${scope}`, rule),

  updateRule: (id: number, updates: Record<string, unknown>) =>
    routingRequest<{ success: boolean; message: string }>('PUT', `/routing/rules/${id}`, updates),

  deleteRule: (id: number) =>
    routingRequest<{ success: boolean; message: string }>('DELETE', `/routing/rules/${id}`),

  getStats: () =>
    routingRequest<{ success: boolean; data: RoutingStats }>('GET', '/routing/stats'),

  getCandidates: () =>
    routingRequest<{ success: boolean; data: RoutingCandidate[]; total: number }>('GET', '/routing/models'),

  testRoute: (req: RouteTestRequest) =>
    routingRequest<{ success: boolean; data: { selected?: any; candidates: RouteTestResult[]; total: number } }>(
      'POST', '/routing/test', req),

  // 熔断重置
  resetCircuitBreaker: (modelId?: string) =>
    routingRequest<{ success: boolean; message: string }>(
      'POST', `/routing/stats/reset-circuit-breaker${modelId ? '?model_id=' + modelId : ''}`),
}


export interface ScenarioBrief {
  id: number
  name: string
  icon: string
  profession: string
  description: string
  isOfficial: boolean
  isPublic: boolean
  usageCount: number
}

export interface ScenarioDetail extends ScenarioBrief {
  systemPrompt: string
  recommendedSkills: string[]
  creatorId: number
  sortOrder: number
  createdAt: string
  updatedAt: string
  workflowCount: number
  workflowTemplates: WorkflowTemplateBrief[]
}

export interface ProfessionGroup {
  profession: string
  label: string
  count: number
}

export interface ScenarioActivateResponse {
  scenarioId: number
  scenarioName: string
  systemPrompt: string
  recommendedSkills: string[]
  profession: string
  workflowCount: number
  workflowTemplates: WorkflowTemplateBrief[]
}

export interface ScenarioCreateRequest {
  name: string
  icon?: string
  profession?: string
  description?: string
  systemPrompt?: string
  recommendedSkills?: string[]
  workflowIds?: number[]
  isOfficial?: boolean
  isPublic?: boolean
}

export interface ScenarioUpdateRequest {
  name?: string
  icon?: string
  profession?: string
  description?: string
  systemPrompt?: string
  recommendedSkills?: string[]
  workflowIds?: number[]
  isOfficial?: boolean
  isPublic?: boolean
}

export const scenarioApi = {
  listProfessions: () =>
    request<ProfessionGroup[]>('GET', '/scenarios/professions'),

  /** 按职业列出场景（不传则全部）。 */
  list: (profession?: string) =>
    request<ScenarioBrief[]>('GET', `/scenarios${profession ? `?profession=${encodeURIComponent(profession)}` : ''}`),

  search: (keyword: string) =>
    request<ScenarioBrief[]>('GET', `/scenarios/search?keyword=${encodeURIComponent(keyword)}`),

  listOfficial: () =>
    request<ScenarioBrief[]>('GET', '/scenarios/official'),

  listAll: () =>
    request<ScenarioBrief[]>('GET', '/scenarios/admin/all'),

  detail: (id: number) =>
    request<ScenarioDetail>('GET', `/scenarios/${id}`),

  create: (data: ScenarioCreateRequest) =>
    request<ScenarioDetail>('POST', '/scenarios', data),

  update: (id: number, data: ScenarioUpdateRequest) =>
    request<ScenarioDetail>('PUT', `/scenarios/${id}`, data),

  delete: (id: number) =>
    request<void>('DELETE', `/scenarios/${id}`),

  activate: (id: number) =>
    request<ScenarioActivateResponse>('POST', `/scenarios/${id}/activate`),

  listCommunity: () =>
    request<ScenarioBrief[]>('GET', '/scenarios/community'),

  listMy: () =>
    request<ScenarioBrief[]>('GET', '/scenarios/my'),

  togglePublic: (id: number) =>
    request<{ isPublic: boolean }>('POST', `/scenarios/${id}/toggle-public`),
}


export interface WorkflowTemplateBrief {
  id: number
  name: string
  description: string
  status: string
}

export interface WorkflowBriefVO {
  id: number
  name: string
  description: string
  status: 'paused' | 'active' | 'error'
  cronExpr: string
  lastRunAt: string
  scenarioId: number
}

export interface WorkflowVO {
  id: number
  userId: number
  name: string
  description: string
  dsl: string
  cronExpr: string
  status: 'paused' | 'active' | 'error'
  lastRunAt: string
  createdAt: string
  updatedAt: string
}

export interface WorkflowCreateRequest {
  name: string
  description?: string
  dsl?: string
  cronExpr?: string
}

export interface WorkflowUpdateRequest {
  name?: string
  description?: string
  dsl?: string
  cronExpr?: string
}

export interface ExecutionBriefVO {
  id: number
  workflowId: number
  status: 'running' | 'success' | 'failed' | 'cancelled'
  triggerType: 'manual' | 'cron' | 'resume'
  startedAt: string
  finishedAt: string
  durationMs: number
}

export interface ExecutionVO {
  id: number
  workflowId: number
  userId: number
  status: 'running' | 'success' | 'failed' | 'cancelled'
  triggerType: 'manual' | 'cron' | 'resume'
  inputJson: string
  outputJson: string
  stepResults: string
  errorMsg: string
  startedAt: string
  finishedAt: string
  durationMs: number
  steps?: ExecutionStepVO[]
  events?: ExecutionEventVO[]
}

export interface ExecutionStepVO {
  id: number
  executionId: number
  workflowId: number
  stepId: string
  stepName: string
  toolName: string
  status: 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled'
  inputJson: string
  outputJson: string
  errorMsg: string
  startedAt: string
  finishedAt: string
  durationMs: number
  createdAt: string
}

export interface ExecutionEventVO {
  id: number
  executionId: number
  stepId?: string
  eventType: string
  message: string
  payloadJson: string
  createdAt: string
}

export interface WorkflowArtifactVO {
  id: number
  uuid: string
  userId: number
  conversationId?: number | null
  workflowId?: number | null
  executionId?: number | null
  stepId?: string | null
  sourceType: string
  fileName: string
  fileType: string
  mimeType: string
  fileSize: number
  ossUrl: string
  objectKey: string
  contentText?: string | null
  metadataJson?: string | null
  status: string
  workFileId?: number | null
  createdAt: string
}

export interface WorkflowArtifactChunkSessionVO {
  uploadId: string
  fileName: string
  totalSize: number
  chunkSize: number
  totalParts: number
  uploadedParts: number[]
  completed: boolean
  status?: string
  errorMsg?: string
}

export interface DslValidationResult {
  valid: boolean
  triggerType?: string
  cronExpr?: string
  stepCount?: number
  error?: string
}

export const workflowApi = {
  list: () =>
    request<WorkflowBriefVO[]>('GET', '/workflows'),

  detail: (id: number) =>
    request<WorkflowVO>('GET', `/workflows/${id}`),

  create: (data: WorkflowCreateRequest) =>
    request<WorkflowVO>('POST', '/workflows', data),

  update: (id: number, data: WorkflowUpdateRequest) =>
    request<WorkflowVO>('PUT', `/workflows/${id}`, data),

  updateStatus: (id: number, status: 'active' | 'paused') =>
    request<void>('PATCH', `/workflows/${id}/status`, { status }),

  delete: (id: number) =>
    request<void>('DELETE', `/workflows/${id}`),

  execute: (id: number, input?: Record<string, unknown>) =>
    request<ExecutionVO>('POST', `/workflows/${id}/execute`, input || {}),

  stopExecution: (executionId: number) =>
    request<void>('POST', `/workflows/executions/${executionId}/stop`),

  resumeExecution: (executionId: number, fromStepId?: string) =>
    request<ExecutionVO>('POST', `/workflows/executions/${executionId}/resume`, fromStepId ? { fromStepId } : {}),

  listExecutions: (workflowId: number, limit = 20) =>
    request<ExecutionBriefVO[]>('GET', `/workflows/${workflowId}/executions?limit=${Math.min(limit, 100)}`),

  executionDetail: (executionId: number) =>
    request<ExecutionVO>('GET', `/workflows/executions/${executionId}`),

  listRunningExecutions: () =>
    request<ExecutionBriefVO[]>('GET', '/workflows/executions/running'),

  streamExecution: (
    executionId: number,
    onSnapshot: (execution: ExecutionVO) => void,
    onEvent: (event: ExecutionEventVO) => void,
    onDone: (execution: ExecutionVO) => void,
    onError: (error: string) => void,
  ): AbortController => {
    const controller = new AbortController()
    const token = getToken()

    fetch(`${BASE_URL}/workflows/executions/${executionId}/stream`, {
      method: 'GET',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: '请求失败' }))
        onError(normalizeMojibakeMessage(data.message, `HTTP ${res.status}`))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) {
        onError('浏览器不支持流式读取')
        return
      }
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n')
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)

          if (line === '') {
            currentEvent = ''
            continue
          }
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            try {
              const data = JSON.parse(raw)
              if (currentEvent === 'snapshot') {
                onSnapshot(data as ExecutionVO)
              } else if (currentEvent === 'execution_event') {
                onEvent(data as ExecutionEventVO)
              } else if (currentEvent === 'done') {
                onDone(data as ExecutionVO)
                return
              } else if (currentEvent === 'error') {
                onError(data.message || '执行流异常')
                return
              }
            } catch {
              // Ignore non-JSON SSE lines.
            }
          }
        }
      }
    }).catch((e) => {
      if (e.name === 'AbortError') return
      onError(e.message || '执行流连接失败')
    })

    return controller
  },

  validateDsl: (dsl: string) =>
    request<DslValidationResult>('POST', '/workflows/validate-dsl', { dsl }),

  /**
 *
   */
  generateDsl: (
    naturalLanguage: string,
    onToken: (token: string) => void,
    onDone: (dsl: string) => void,
    onError: (error: string) => void,
  ): AbortController => {
    const controller = new AbortController()
    const token = getToken()

    fetch(`${BASE_URL}/workflows/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ naturalLanguage }),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: '请求失败' }))
        onError(normalizeMojibakeMessage(data.message, `HTTP ${res.status}`))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) { onError('浏览器不支持流式读取'); return }
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n')
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)

          if (line === '') { currentEvent = ''; continue }
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            try {
              const data = JSON.parse(raw)
              if (currentEvent === 'token') {
                onToken(data.message || '')
              } else if (currentEvent === 'done') {
                onDone(data.message || '')
                return
              } else if (currentEvent === 'error') {
                onError(normalizeMojibakeMessage(data.message, '生成失败'))
                return
              }
            } catch {
            }
          }
        }
      }
    }).catch((e) => {
      if (e.name === 'AbortError') return
      onError(normalizeMojibakeMessage(e.message, '网络错误'))
    })

    return controller
  },
}

const WORKFLOW_ARTIFACT_CHUNK_THRESHOLD = 100 * 1024 * 1024
const WORKFLOW_ARTIFACT_CHUNK_SIZE = 32 * 1024 * 1024

type WorkflowArtifactUploadOptions = {
  workflowId?: number
  executionId?: number
  stepId?: string
  sourceType?: string
  convUuid?: string
  syncToWorkFile?: boolean
  metadataJson?: string
  onProgress?: (progress: { uploadedBytes: number; totalBytes: number; partNumber?: number; totalParts?: number }) => void
  onSession?: (session: WorkflowArtifactChunkSessionVO) => void
  uploadId?: string
  signal?: AbortSignal
}

function appendWorkflowArtifactOptions(formData: FormData, opts?: WorkflowArtifactUploadOptions) {
  if (opts?.workflowId != null) formData.append('workflowId', String(opts.workflowId))
  if (opts?.executionId != null) formData.append('executionId', String(opts.executionId))
  if (opts?.stepId) formData.append('stepId', opts.stepId)
  if (opts?.sourceType) formData.append('sourceType', opts.sourceType)
  if (opts?.convUuid) formData.append('convUuid', opts.convUuid)
  if (opts?.syncToWorkFile != null) formData.append('syncToWorkFile', String(opts.syncToWorkFile))
  if (opts?.metadataJson) formData.append('metadataJson', opts.metadataJson)
}

async function workflowArtifactFormRequest<T>(path: string, formData?: FormData, fallback = '工作流文件上传失败', signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: formData,
    signal,
  })
  const data = await res.json().catch(() => ({ code: res.status, message: fallback }))
  if (data.code !== 200) {
    const msg = data.message || fallback
    toast.error(msg)
    throw new Error(msg)
  }
  return data.data
}

async function workflowArtifactGetRequest<T>(path: string, fallback = '工作流文件请求失败', signal?: AbortSignal): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {}
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'GET',
    headers,
    signal,
  })
  const data = await res.json().catch(() => ({ code: res.status, message: fallback }))
  if (data.code !== 200) {
    const msg = data.message || fallback
    toast.error(msg)
    throw new Error(msg)
  }
  return data.data
}

async function uploadWorkflowArtifactInChunks(
  file: File,
  opts?: WorkflowArtifactUploadOptions,
): Promise<WorkflowArtifactVO> {
  let session: WorkflowArtifactChunkSessionVO
  if (opts?.uploadId) {
    session = await workflowArtifactGetRequest<WorkflowArtifactChunkSessionVO>(
      `/workflow-artifacts/chunk/${opts.uploadId}`,
      '获取分片上传状态失败',
      opts.signal,
    )
  } else {
    const initForm = new FormData()
    initForm.append('fileName', file.name || 'unknown')
    initForm.append('totalSize', String(file.size))
    initForm.append('chunkSize', String(WORKFLOW_ARTIFACT_CHUNK_SIZE))
    initForm.append('contentType', file.type || 'application/octet-stream')
    appendWorkflowArtifactOptions(initForm, opts)

    session = await workflowArtifactFormRequest<WorkflowArtifactChunkSessionVO>(
      '/workflow-artifacts/chunk/init',
      initForm,
      '初始化分片上传失败',
      opts?.signal,
    )
  }
  opts?.onSession?.(session)
  const uploaded = new Set(session.uploadedParts || [])
  if (uploaded.size > 0) {
    opts?.onProgress?.({
      uploadedBytes: Math.min(file.size, uploaded.size * session.chunkSize),
      totalBytes: file.size,
      totalParts: session.totalParts,
    })
  }

  for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
    if (opts?.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
    if (uploaded.has(partNumber)) continue
    const start = (partNumber - 1) * session.chunkSize
    const end = Math.min(start + session.chunkSize, file.size)
    const partForm = new FormData()
    partForm.append('partNumber', String(partNumber))
    partForm.append('chunk', file.slice(start, end), file.name || `part-${partNumber}`)
    session = await workflowArtifactFormRequest<WorkflowArtifactChunkSessionVO>(
      `/workflow-artifacts/chunk/${session.uploadId}/part`,
      partForm,
      `上传分片 ${partNumber} 失败`,
      opts?.signal,
    )
    opts?.onSession?.(session)
    uploaded.add(partNumber)
    const uploadedBytes = Math.min(end, file.size)
    opts?.onProgress?.({ uploadedBytes, totalBytes: file.size, partNumber, totalParts: session.totalParts })
  }

  return workflowArtifactFormRequest<WorkflowArtifactVO>(
    `/workflow-artifacts/chunk/${session.uploadId}/complete`,
    undefined,
    '完成分片上传失败',
    opts?.signal,
  )
}

export const workflowArtifactApi = {
  upload: async (
    file: File,
    opts?: WorkflowArtifactUploadOptions,
  ): Promise<WorkflowArtifactVO> => {
    if (file.size > WORKFLOW_ARTIFACT_CHUNK_THRESHOLD) {
      return uploadWorkflowArtifactInChunks(file, opts)
    }

    const formData = new FormData()
    formData.append('file', file)
    appendWorkflowArtifactOptions(formData, opts)
    return workflowArtifactFormRequest<WorkflowArtifactVO>(
      '/workflow-artifacts/upload',
      formData,
      '工作流文件上传失败',
      opts?.signal,
    )
  },

  detail: (uuid: string) =>
    request<WorkflowArtifactVO>('GET', `/workflow-artifacts/${uuid}`),

  list: (params?: { workflowId?: number; executionId?: number; fileType?: string }) => {
    const query = new URLSearchParams()
    if (params?.workflowId != null) query.set('workflowId', String(params.workflowId))
    if (params?.executionId != null) query.set('executionId', String(params.executionId))
    if (params?.fileType) query.set('fileType', params.fileType)
    const suffix = query.toString() ? `?${query.toString()}` : ''
    return request<WorkflowArtifactVO[]>('GET', `/workflow-artifacts${suffix}`)
  },
}


export interface WorkflowTemplateBriefVO {
  id: number
  uuid: string
  name: string
  description: string
  category: string
  icon: string
  isOfficial: boolean
  authorName: string
  useCount: number
  rating: number
  ratingCount: number
  isCertified: boolean
  stepCount: number
  createdAt: string
}

export interface WorkflowTemplateVO {
  id: number
  uuid: string
  name: string
  description: string
  category: string
  icon: string
  dsl: string
  paramsSchema: string
  isOfficial: boolean
  authorId: number
  authorName: string
  useCount: number
  rating: number
  ratingCount: number
  isPublished: boolean
  isCertified: boolean
  sourceWorkflowId: number
  createdAt: string
  updatedAt: string
}

export interface TemplateSearchRequest {
  keyword?: string
  category?: string
  official?: boolean
  certified?: boolean
  sort?: 'hot' | 'newest' | 'rating'
  page?: number
  pageSize?: number
}

export interface TemplatePageResult {
  items: WorkflowTemplateBriefVO[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface TemplatePublishRequest {
  workflowId: number
  name: string
  description?: string
  category?: string
  icon?: string
  paramsSchema?: string
}

export interface TemplateCloneRequest {
  name?: string
  params?: string  // JSON string
}

export interface TemplateCategory {
  key: string
  label: string
  icon: string
  count: number
}

export const workflowTemplateApi = {
  search: (req?: TemplateSearchRequest) =>
    request<TemplatePageResult>('POST', '/workflow-templates/search', req || {}),

  detail: (uuid: string) =>
    request<WorkflowTemplateVO>('GET', `/workflow-templates/${uuid}`),

  categories: () =>
    request<TemplateCategory[]>('GET', '/workflow-templates/categories'),

  publish: (data: TemplatePublishRequest) =>
    request<WorkflowTemplateVO>('POST', '/workflow-templates/publish', data),

  unpublish: (uuid: string) =>
    request<void>('DELETE', `/workflow-templates/${uuid}`),

  clone: (uuid: string, data?: TemplateCloneRequest) =>
    request<WorkflowVO>('POST', `/workflow-templates/${uuid}/clone`, data || {}),

  /** 评分 */
  rate: (uuid: string, rating: number) =>
    request<void>('POST', `/workflow-templates/${uuid}/rate`, { rating }),
}

// ==================== 创作者排行榜（P3-4） ====================

export interface CreatorRankVO {
  rank: number
  userId: number
  username: string
  avatar: string
  agentId: string
  agentName: string
  agentIcon: string
  totalRevenue: number
  useCount: number
  certified: boolean
}

export interface CreatorLeaderboardResponse {
  rankings: CreatorRankVO[]
  period: 'week' | 'month' | 'all'
  updatedAt: string
}

export const creatorApi = {
  leaderboard: (period: 'week' | 'month' | 'all' = 'all', limit = 20) =>
    request<CreatorLeaderboardResponse>('GET', `/skills/leaderboard?period=${period}&limit=${Math.min(limit, 100)}`),
}


export const toolCodeApi = {
  generateCode: (
    toolName: string,
    description: string,
    language: 'python' | 'javascript',
    onToken: (code: string) => void,
    onDone: (code: string) => void,
    onError: (error: string) => void,
    existingCode?: string,
    refineInstruction?: string,
  ): AbortController => {
    const controller = new AbortController()
    const token = getToken()

    const body: Record<string, unknown> = { toolName, description, language }
    if (existingCode?.trim()) body.existingCode = existingCode
    if (refineInstruction?.trim()) body.refineInstruction = refineInstruction

    fetch(`${BASE_URL}/tools/generate-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const data = await res.json().catch(() => ({ message: '请求失败' }))
        onError(normalizeMojibakeMessage(data.message, `HTTP ${res.status}`))
        return
      }
      const reader = res.body?.getReader()
      if (!reader) { onError('浏览器不支持流式读取'); return }
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        while (buffer.includes('\n')) {
          const idx = buffer.indexOf('\n')
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)

          if (line === '') { currentEvent = ''; continue }
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
            continue
          }
          if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            try {
              const data = JSON.parse(raw)
              if (currentEvent === 'token') {
                onToken(data.message || '')
              } else if (currentEvent === 'done') {
                onDone(data.code || data.message || '')
                return
              } else if (currentEvent === 'error') {
                onError(normalizeMojibakeMessage(data.message, '生成失败'))
                return
              }
            } catch { /* non-JSON line */ }
          }
        }
      }
    }).catch((e) => {
      if (e.name === 'AbortError') return
      onError(normalizeMojibakeMessage(e.message, '网络错误'))
    })

    return controller
  },

  testCode: (
    code: string,
    language: string,
    input?: Record<string, unknown>,
    options?: { timeoutSeconds?: number; permissions?: string[] },
  ) =>
    request<{
      success: boolean
      output?: unknown
      error?: string
      elapsedMs?: number
    }>('POST', '/tools/test-code', {
      code,
      language,
      input: input || {},
      timeoutSeconds: options?.timeoutSeconds,
      permissions: options?.permissions,
    }),
}


export interface UserModelPreference {
  id: number
  userId: number
  modelId: string
  sceneType: string // 'chat' | 'vision' | 'code' | 'image' | 'agent'
  preferenceWeight: number // -1.0 ~ 1.0
  usageCount: number
  likeCount: number
  dislikeCount: number
  avgResponseTime: number
  lastUsedAt: string
  source: 'auto' | 'manual'
}

export interface ModelFeedbackRequest {
  conversationId?: string
  modelId: string
  sceneType?: string
  rating?: number      // 1-5
  liked?: boolean
  disliked?: boolean
  feedbackText?: string
  responseTimeMs?: number
}

export interface UserModelUsageDaily {
  id: number
  userId: number
  modelId: string
  sceneType: string
  statDate: string
  callCount: number
  successCount: number
  totalTokens: number
  totalCost: number
  avgResponseTime: number
}

export const userPreferenceApi = {
  listPreferences: (sceneType?: string) =>
    request<UserModelPreference[]>('GET', `/user/preferences${sceneType ? `?sceneType=${sceneType}` : ''}`),

  setManualPreference: (modelId: string, sceneType: string, weight: number) =>
    request<void>('POST', '/user/preferences/manual', { modelId, sceneType, weight }),

  resetPreferences: (sceneType?: string) =>
    request<void>('DELETE', '/user/preferences', sceneType ? { sceneType } : {}),

  submitFeedback: (feedback: ModelFeedbackRequest) =>
    request<void>('POST', '/user/model-feedback', feedback),

  getUsageStats: (days: number = 30) =>
    request<UserModelUsageDaily[]>('GET', `/user/model-usage-stats?days=${Math.min(days, 90)}`),
}


/** 角色 VO */
export interface SysRoleVO {
  id: number
  uuid: string
  roleName: string
  roleCode: string
  description: string
  status: string
  sortOrder: number
  isSystem: number
  createdAt: string
  updatedAt: string
}

export interface SysPermissionVO {
  id: number
  uuid: string
  permissionName: string
  permissionCode: string
  parentId: number | null
  resourceType: string
  action: string
  description: string
  sortOrder: number
  children?: SysPermissionVO[]
  createdAt: string
  updatedAt: string
}

export const rbacApi = {
  // ==================== 角色 CRUD ====================
  listRoles: () => request<SysRoleVO[]>('GET', '/admin/rbac/roles'),

  /** 创建角色 */
  createRole: (data: { roleName: string; roleCode: string; description?: string; status?: string; sortOrder?: number }) =>
    request<SysRoleVO>('POST', '/admin/rbac/roles', data),

  updateRole: (uuid: string, data: { roleName?: string; roleCode?: string; description?: string; status?: string; sortOrder?: number }) =>
    request<SysRoleVO>('PUT', `/admin/rbac/roles/${uuid}`, data),

  deleteRole: (uuid: string) => request<string>('DELETE', `/admin/rbac/roles/${uuid}`),

  getPermissionTree: () => request<SysPermissionVO[]>('GET', '/admin/rbac/permissions'),

  listPermissionsFlat: () => request<SysPermissionVO[]>('GET', '/admin/rbac/permissions/flat'),

  createPermission: (data: {
    permissionName: string; permissionCode: string; parentId?: number | null;
    resourceType?: string; action?: string; description?: string; sortOrder?: number
  }) => request<SysPermissionVO>('POST', '/admin/rbac/permissions', data),

  updatePermission: (uuid: string, data: {
    permissionName?: string; permissionCode?: string; parentId?: number | null;
    resourceType?: string; action?: string; description?: string; sortOrder?: number
  }) => request<SysPermissionVO>('PUT', `/admin/rbac/permissions/${uuid}`, data),

  deletePermission: (uuid: string) => request<string>('DELETE', `/admin/rbac/permissions/${uuid}`),

  getRolePermissionIds: (roleId: number) => request<number[]>('GET', `/admin/rbac/roles/${roleId}/permissions`),

  getRolePermissionCodes: (roleId: number) => request<string[]>('GET', `/admin/rbac/roles/${roleId}/permission-codes`),

  /** 为角色分配权限 */
  assignPermissionsToRole: (roleId: number, permissionIds: number[]) =>
    request<string>('PUT', `/admin/rbac/roles/${roleId}/permissions`, { permissionIds }),

  getUserRoles: (userId: number | string) => request<SysRoleVO[]>('GET', `/admin/rbac/users/${userId}/roles`),

  assignRolesToUser: (userId: number | string, roleIds: number[]) =>
    request<string>('PUT', `/admin/rbac/users/${userId}/roles`, { roleIds }),

  getUserPermissions: (userId: number | string) => request<string[]>('GET', `/admin/rbac/users/${userId}/permissions`),

  getMyPermissions: () => request<string[]>('GET', '/rbac/me/permissions'),
}

// ==================== 通知系统 ====================
export interface UserNotificationVO {
  id: number
  notificationId: number
  title: string
  content: string
  type: string
  extraData: string | null
  isRead: boolean
  readAt: string | null
  createdAt: string
}

export interface UnreadCountVO {
  count: number
}

export interface UserNotificationPageVO {
  list: UserNotificationVO[]
  total: number
  page: number
  size: number
  hasMore: boolean
}

export interface NotificationAdminVO {
  id: number
  uuid: string
  title: string
  content: string
  type: string
  targetType: string
  targetUserIds: number[] | null
  extraData: string | null
  createdBy: number | null
  createdByName: string | null
  status: string
  createdAt: string
  updatedAt: string
  totalRecipients: number | null
  totalRead: number | null
}

export interface PrivacySettingVO {
  saveHistory: boolean
  dataImprovement: boolean
  twoFactorAuth: boolean
}

export interface NotificationPageResult {
  list: NotificationAdminVO[]
  total: number
  page: number
  size: number
}

export const notificationApi = {
  list: (limit = 20) => request<UserNotificationVO[]>('GET', `/notifications?limit=${limit}`),

  listPaged: (page = 1, size = 10, read?: boolean) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    if (read !== undefined) params.set('read', String(read))
    return request<UserNotificationPageVO>('GET', `/notifications?${params}`)
  },

  getUnreadCount: () => request<UnreadCountVO>('GET', '/notifications/unread'),

  markAsRead: (notificationId: number) => request<void>('PUT', `/notifications/${notificationId}/read`),

  markAllAsRead: () => request<void>('PUT', '/notifications/read-all'),

  getPrivacySettings: () => request<PrivacySettingVO>('GET', '/notifications/privacy'),

  updatePrivacySettings: (data: Partial<PrivacySettingVO>) =>
    request<PrivacySettingVO>('PUT', '/notifications/privacy', data),

  /** 分页查询通知列表 */
  adminList: (page = 1, size = 20, type?: string, status?: string) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    if (type) params.set('type', type)
    if (status) params.set('status', status)
    return request<NotificationPageResult>('GET', `/notifications/admin?${params}`)
  },

  /** 创建通知 */
  adminCreate: (data: {
    title: string
    content: string
    type: string
    targetType: string
    targetUserIds?: number[]
    extraData?: string
  }) => request<NotificationAdminVO>('POST', '/notifications/admin', data),

  adminUpdate: (id: number, data: {
    title?: string
    content?: string
    type?: string
    targetType?: string
    targetUserIds?: number[]
    extraData?: string
    status?: string
  }) => request<NotificationAdminVO>('PUT', `/notifications/admin/${id}`, data),

  adminDelete: (id: number) => request<void>('DELETE', `/notifications/admin/${id}`),
}


export interface PayConfigVO {
  id: number
  uuid: string
  provider: string
  name: string
  appId: string
  hasPrivateKey: boolean
  hasPublicKey: boolean
  hasEncryptKey: boolean
  notifyUrl: string
  returnUrl: string
  sandbox: number
  enabled: number
  isDefault: number
  extraConfig: string
  createdBy: number
  createdAt: string
  updatedAt: string
  creatorName: string
}

export interface PayConfigCreateRequest {
  provider: string
  name: string
  appId: string
  privateKey: string
  publicKey: string
  encryptKey: string
  notifyUrl: string
  returnUrl: string
  sandbox: number
  enabled: number
  isDefault: number
  extraConfig?: string
}

export interface PayConfigUpdateRequest {
  name?: string
  appId?: string
  privateKey?: string
  publicKey?: string
  encryptKey?: string
  notifyUrl?: string
  returnUrl?: string
  sandbox?: number
  enabled?: number
  isDefault?: number
  extraConfig?: string
}

export interface OrderVO {
  id: number
  uuid: string
  orderNo: string
  userId: number
  username: string
  nickname: string
  planId: number
  planName: string
  amount: number
  discountAmount: number
  actualAmount: number
  paymentMethod: string
  paymentProvider: string
  tradeNo: string
  status: string
  paidAt: string
  refundedAt: string
  cancelledAt: string
  expiredAt: string
  clientIp: string
  remark: string
  extraData: string
  createdAt: string
  updatedAt: string
}

export interface OrderBriefVO {
  id: number
  orderNo: string
  userId: number
  username: string
  planName: string
  actualAmount: number
  paymentMethod: string
  tradeNo: string
  status: string
  paidAt: string
  createdAt: string
}

export interface OrderQueryParams {
  orderNo?: string
  tradeNo?: string
  userId?: number
  username?: string
  status?: string
  paymentMethod?: string
  planId?: number
  minAmount?: number
  maxAmount?: number
  startTime?: string
  endTime?: string
  sortBy?: string
  sortDir?: string
  page?: number
  size?: number
}

export interface OrderPageResult {
  list: OrderBriefVO[]
  total: number
  page: number
  size: number
}

export interface PaymentCreateResponse {
  orderNo: string
  orderId: number
  actualAmount: number
  paymentMethod: string
  payForm: string
  qrCodeUrl: string
  payUrl: string
}

export interface PaymentRecordVO {
  id: number
  uuid: string
  orderId: number
  orderNo: string
  tradeNo: string
  amount: number
  paymentStatus: string
  verifyStatus: string
  verifyMsg: string
  callbackContent: string
  callbackAt: string
  requestContent: string
  responseContent: string
  errorCode: string
  errorMsg: string
  createdAt: string
}

export interface PaymentRecordPageResult {
  list: PaymentRecordVO[]
  total: number
  page: number
  size: number
}

export interface RefundRequest {
  orderId: number
  refundAmount?: number
  reason: string
}

export interface RefundRecordVO {
  id: number
  uuid: string
  refundNo: string
  orderId: number
  orderNo: string
  tradeNo: string
  refundAmount: number
  totalAmount: number
  refundStatus: string
  reason: string
  operatorId: number
  operatorName: string
  tradeRefundNo: string
  callbackContent: string
  callbackAt: string
  errorCode: string
  errorMsg: string
  completedAt: string
  createdAt: string
}

export interface RefundPageResult {
  list: RefundRecordVO[]
  total: number
  page: number
  size: number
}

export interface PayAuditLogVO {
  id: number
  uuid: string
  operatorId: number
  operatorName: string
  operatorIp: string
  action: string
  targetType: string
  targetId: string
  description: string
  beforeData: string
  afterData: string
  result: string
  errorMsg: string
  createdAt: string
}

export interface AuditLogQueryParams {
  action?: string
  targetType?: string
  targetId?: string
  operatorId?: number
  result?: string
  startTime?: string
  endTime?: string
  page?: number
  size?: number
}

export interface AuditLogPageResult {
  list: PayAuditLogVO[]
  total: number
  page: number
  size: number
}

export interface PaymentMethodStat {
  paymentMethod: string
  orderCount: number
  totalAmount: number
}

export interface PaymentStatsVO {
  todayOrderCount: number
  todayPayAmount: number
  totalOrderCount: number
  totalPayAmount: number
  pendingRefundCount: number
  totalRefundAmount: number
  methodStats: PaymentMethodStat[]
}

export const paymentApi: {
  // 支付配置管理
  getConfigs: () => Promise<PayConfigVO[]>
  getConfig: (id: number) => Promise<PayConfigVO>
  createConfig: (data: PayConfigCreateRequest) => Promise<PayConfigVO>
  updateConfig: (id: number, data: PayConfigUpdateRequest) => Promise<PayConfigVO>
  deleteConfig: (id: number) => Promise<string>
  getRecords: (page?: number, size?: number, orderNo?: string) => Promise<PaymentRecordPageResult>
  refund: (data: RefundRequest) => Promise<RefundRecordVO>
  getRefunds: (page?: number, size?: number, status?: string) => Promise<RefundPageResult>
  getAuditLogs: (params: AuditLogQueryParams) => Promise<AuditLogPageResult>
  getStats: () => Promise<PaymentStatsVO>
  createOrder: (data: { planId: number; paymentMethod: string; couponCode?: string; remark?: string }) => Promise<PaymentCreateResponse>
  pay: (orderNo: string) => Promise<PaymentCreateResponse>
  getOrderStatus: (orderNo: string) => Promise<OrderVO>
} = {
  getConfigs: () => request<PayConfigVO[]>('GET', '/payment/configs'),
  getConfig: (id: number) => request<PayConfigVO>('GET', `/payment/configs/${id}`),
  createConfig: (data: PayConfigCreateRequest) => request<PayConfigVO>('POST', '/payment/configs', data),
  updateConfig: (id: number, data: PayConfigUpdateRequest) => request<PayConfigVO>('PUT', `/payment/configs/${id}`, data),
  deleteConfig: (id: number) => request<string>('DELETE', `/payment/configs/${id}`),
  getRecords: (page = 1, size = 20, orderNo?: string) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    if (orderNo) params.set('orderNo', orderNo)
    return request<PaymentRecordPageResult>('GET', `/payment/records?${params}`)
  },
  refund: (data: RefundRequest) => request<RefundRecordVO>('POST', '/payment/refund', data),
  getRefunds: (page = 1, size = 20, status?: string) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    if (status) params.set('status', status)
    return request<RefundPageResult>('GET', `/payment/refunds?${params}`)
  },
  getAuditLogs: (params: AuditLogQueryParams) => {
    const qs = new URLSearchParams()
    if (params.action) qs.set('action', params.action)
    if (params.targetType) qs.set('targetType', params.targetType)
    if (params.targetId) qs.set('targetId', params.targetId)
    if (params.operatorId) qs.set('operatorId', String(params.operatorId))
    if (params.result) qs.set('result', params.result)
    if (params.startTime) qs.set('startTime', params.startTime)
    if (params.endTime) qs.set('endTime', params.endTime)
    qs.set('page', String(params.page ?? 1))
    qs.set('size', String(params.size ?? 20))
    return request<AuditLogPageResult>('GET', `/payment/audit-logs?${qs}`)
  },
  getStats: () => request<PaymentStatsVO>('GET', '/payment/stats'),
  createOrder: (data: { planId: number; paymentMethod: string; couponCode?: string; remark?: string }) =>
    request<PaymentCreateResponse>('POST', '/payment/orders', data),
  pay: (orderNo: string) => request<PaymentCreateResponse>('POST', `/payment/pay/${orderNo}`),
  getOrderStatus: (orderNo: string) => request<OrderVO>('GET', `/payment/status/${orderNo}`),
}

export const orderApi: {
  list: (params: OrderQueryParams) => Promise<OrderPageResult>
  getDetail: (id: number) => Promise<OrderVO>
  export: (params: OrderQueryParams) => Promise<Blob>
  getStats: () => Promise<PaymentStatsVO>
  getOrderPayments: (id: number) => Promise<PaymentRecordVO[]>
  getOrderRefunds: (id: number) => Promise<RefundRecordVO[]>
  myOrders: (page?: number, size?: number, status?: string) => Promise<OrderPageResult>
} = {
  list: (params: OrderQueryParams) => {
    const qs = new URLSearchParams()
    if (params.orderNo) qs.set('orderNo', params.orderNo)
    if (params.tradeNo) qs.set('tradeNo', params.tradeNo)
    if (params.userId) qs.set('userId', String(params.userId))
    if (params.username) qs.set('username', params.username)
    if (params.status) qs.set('status', params.status)
    if (params.paymentMethod) qs.set('paymentMethod', params.paymentMethod)
    if (params.planId) qs.set('planId', String(params.planId))
    if (params.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
    if (params.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
    if (params.startTime) qs.set('startTime', params.startTime)
    if (params.endTime) qs.set('endTime', params.endTime)
    if (params.sortBy) qs.set('sortBy', params.sortBy)
    if (params.sortDir) qs.set('sortDir', params.sortDir)
    qs.set('page', String(params.page ?? 1))
    qs.set('size', String(params.size ?? 20))
    return request<OrderPageResult>('GET', `/orders?${qs}`)
  },
  getDetail: (id: number) => request<OrderVO>('GET', `/orders/${id}`),
  export: async (params: OrderQueryParams) => {
    const qs = new URLSearchParams()
    if (params.orderNo) qs.set('orderNo', params.orderNo)
    if (params.tradeNo) qs.set('tradeNo', params.tradeNo)
    if (params.userId) qs.set('userId', String(params.userId))
    if (params.username) qs.set('username', params.username)
    if (params.status) qs.set('status', params.status)
    if (params.paymentMethod) qs.set('paymentMethod', params.paymentMethod)
    if (params.planId) qs.set('planId', String(params.planId))
    if (params.minAmount !== undefined) qs.set('minAmount', String(params.minAmount))
    if (params.maxAmount !== undefined) qs.set('maxAmount', String(params.maxAmount))
    if (params.startTime) qs.set('startTime', params.startTime)
    if (params.endTime) qs.set('endTime', params.endTime)
    const headers: Record<string, string> = {}
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${BASE_URL}/orders/export?${qs}`, { headers })
    return res.blob()
  },
  getStats: () => request<PaymentStatsVO>('GET', '/orders/stats'),
  getOrderPayments: (id: number) => request<PaymentRecordVO[]>('GET', `/orders/${id}/payments`),
  getOrderRefunds: (id: number) => request<RefundRecordVO[]>('GET', `/orders/${id}/refunds`),
  myOrders: (page = 1, size = 20, status?: string) => {
    const params = new URLSearchParams({ page: String(page), size: String(size) })
    if (status) params.set('status', status)
    return request<OrderPageResult>('GET', `/orders/my?${params}`)
  },
}
