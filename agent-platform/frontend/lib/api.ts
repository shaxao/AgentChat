export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/autocode-api'

function getAuthMeta(): { token?: string; userId?: string } {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem('auth-store')
    if (!raw) return {}
    const store = JSON.parse(raw)
    const state = store?.state || store
    return {
      token: state?.token || undefined,
      userId: state?.user?.id ? String(state.user.id) : undefined,
    }
  } catch {
    return {}
  }
}

function buildHeaders(options?: RequestInit): HeadersInit {
  const meta = getAuthMeta()
  const body = options?.body
  const headers: Record<string, string> = {}
  if (!(body instanceof FormData)) headers['Content-Type'] = 'application/json'
  if (meta.token) headers.Authorization = `Bearer ${meta.token}`
  if (meta.userId) headers['X-User-Id'] = meta.userId
  return { ...headers, ...(options?.headers as Record<string, string> | undefined) }
}

export function withAuthQuery(url: string | null | undefined): string | null {
  if (!url) return null
  const userId = getAuthMeta().userId
  if (!userId || /[?&]user_?id=/.test(url)) return url
  const hashIndex = url.indexOf('#')
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : ''
  const sep = beforeHash.includes('?') ? '&' : '?'
  return `${beforeHash}${sep}user_id=${encodeURIComponent(userId)}${hash}`
}

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: buildHeaders(options),
  })
  if (!res.ok) throw new Error(`API Error ${res.status}: ${await res.text()}`)
  return res.json()
}

// ─── Tasks ────────────────────────────────────────────────────────
export const tasksApi = {
  list: () => api<import('@/types').Task[]>('/api/tasks'),

  create: (payload: import('@/types').TaskCreate) =>
    api<import('@/types').Task>('/api/tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  get: (id: string) => api<import('@/types').Task>(`/api/tasks/${id}`),

  getStatus: (id: string) =>
    api<{ status: string; progress: number; current_step: string; preview_url?: string }>(
      `/api/tasks/${id}/status`
    ),

  getLogs: (id: string, since = 0) =>
    api<{ logs: import('@/types').AgentLogEntry[]; total: number }>(
      `/api/tasks/${id}/logs?since=${since}`
    ),

  confirmDestructive: (id: string, path: string) =>
    api<{ ok: boolean }>(`/api/tasks/${id}/confirm-destructive`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  stop: (id: string) => api<{ ok: boolean }>(`/api/tasks/${id}/stop`, { method: 'POST' }),

  confirmPlan: (id: string, confirmed: boolean, modifiedPlan?: Record<string, any>) =>
    api<{ ok: boolean; message: string }>(`/api/tasks/${id}/confirm-plan`, {
      method: 'POST',
      body: JSON.stringify({ confirmed, modified_plan: modifiedPlan }),
    }),

  confirmPrototype: (id: string, confirmed: boolean, modifiedPrototype?: Record<string, any>) =>
    api<{ ok: boolean; message: string }>(`/api/tasks/${id}/confirm-prototype`, {
      method: 'POST',
      body: JSON.stringify({ confirmed, modified_prototype: modifiedPrototype }),
    }),

  confirmReview: (id: string, confirmed: boolean) =>
    api<{ ok: boolean; message: string }>(`/api/tasks/${id}/confirm-review`, {
      method: 'POST',
      body: JSON.stringify({ confirmed }),
    }),

  getSpec: (id: string) =>
    api<{ spec: string | null; exists: boolean }>(`/api/tasks/${id}/spec`),

  getMemory: (id: string) =>
    api<{
      task_id: string
      workspace_id: string
      plan: string | null
      memory: string | null
      chat: string | null
      session_summary: string | null
    }>(`/api/tasks/${id}/memory`),

  updateSpec: (id: string, spec: string) =>
    api<{ ok: boolean; spec: string }>(`/api/tasks/${id}/spec`, {
      method: 'PUT',
      body: JSON.stringify({ spec }),
    }),

  rollback: (id: string, commitHash: string) =>
    api<{ ok: boolean }>(`/api/tasks/${id}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ commit_hash: commitHash }),
    }),

  /** 获取支持指定能力的模型列表 */
  models: async (capability?: string): Promise<import('@/types').ModelInfo[]> => {
    const q = capability ? `?capability=${encodeURIComponent(capability)}` : ''
    const res = await api<import('@/types').ModelInfo[] | { models: import('@/types').ModelInfo[] }>(`/api/tasks/models${q}`)
    // 后端返回 { models: [...] } 或直接返回 [...]
    return Array.isArray(res) ? res : (res as { models: import('@/types').ModelInfo[] }).models ?? []
  },
}

// ─── Agents ────────────────────────────────────────────────────────
export const agentsApi = {
  list: () => api<import('@/types').AgentInfo[]>('/api/agents'),
  get: (name: string) => api<import('@/types').AgentInfo>(`/api/agents/${name}`),
}

// ─── Dev Server ────────────────────────────────────────────────────
export const devServerApi = {
  start: (workspaceId: string, projectType?: string) =>
    api<{ workspace_id: string; port: number; url: string | null; status: string }>(
      `/api/workspaces/${workspaceId}/dev-server/start`,
      { method: 'POST', body: JSON.stringify({ project_type: projectType }) }
    ),
  stop: (workspaceId: string) =>
    api<{ ok: boolean }>(`/api/workspaces/${workspaceId}/dev-server/stop`, { method: 'POST' }),
  get: (workspaceId: string) =>
    api<{ workspace_id: string; port: number; url: string | null; status: string } | null>(
      `/api/workspaces/${workspaceId}/dev-server`
    ),
}

// ─── Git ────────────────────────────────────────────────────────────
export const gitApi = {
  log: (workspaceId: string, limit = 20) =>
    api<import('@/types').GitCommit[]>(`/api/git/workspaces/${workspaceId}/log?limit=${limit}`),
  diff: (workspaceId: string, commitHash: string) =>
    api<{ diff: string }>(`/api/git/workspaces/${workspaceId}/diff/${commitHash}`),
  checkout: (workspaceId: string, commitHash: string) =>
    api<{ ok: boolean }>(`/api/git/workspaces/${workspaceId}/checkout/${commitHash}`, { method: 'POST' }),
  rollback: (taskId: string, commitHash: string) =>
    tasksApi.rollback(taskId, commitHash),
}

// ─── Deploy ────────────────────────────────────────────────────────
export const deployApi = {
  toVercel: (workspaceId: string, token: string, projectName?: string) =>
    api<{ ok: boolean; url?: string; deploy_id?: string; status?: string; error?: string }>(
      `/api/workspaces/${workspaceId}/deploy/vercel`,
      { method: 'POST', body: JSON.stringify({ vercel_token: token, project_name: projectName }) }
    ),
  toDocker: (workspaceId: string, registry?: string, imageTag?: string) =>
    api<{ ok: boolean; image?: string; status?: string; error?: string }>(
      `/api/workspaces/${workspaceId}/deploy/docker`,
      { method: 'POST', body: JSON.stringify({ registry_url: registry, image_tag: imageTag }) }
    ),
  list: (workspaceId: string) =>
    api<{ ok: boolean; url?: string; image?: string; deploy_id?: string; status?: string; error?: string }[]>(
      `/api/workspaces/${workspaceId}/deployments`
    ),
}

// ─── WebSocket Terminal ─────────────────────────────────────────────
export function createTerminalWS(workspaceId: string): WebSocket {
  const wsProtocol = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsHost = typeof window !== 'undefined' ? window.location.host : 'localhost:8000'
  const WS_BASE = process.env.NEXT_PUBLIC_WS_URL || `${wsProtocol}//${wsHost}/autocode-api`
  const userId = getAuthMeta().userId
  const query = userId ? `?user_id=${encodeURIComponent(userId)}` : ''
  return new WebSocket(`${WS_BASE}/ws/terminal/${workspaceId}${query}`)
}

// ─── Projects ────────────────────────────────────────────────────────
export interface ImportedProject {
  id: string
  name: string
  source: string
  source_url: string
  path: string
  status: string
  created_at: string
  file_count?: number
}

export const projectsApi = {
  list: () => api<ImportedProject[]>('/api/projects'),

  clone: (gitUrl: string, projectName?: string) =>
    api<{ project_id: string; name: string; status: string }>('/api/projects/clone', {
      method: 'POST',
      body: JSON.stringify({ git_url: gitUrl, project_name: projectName }),
    }),

  get: (projectId: string) => api<ImportedProject>(`/api/projects/${projectId}`),

  files: (projectId: string) =>
    api<{ files: { name: string; type: string; size: number }[] }>(`/api/projects/${projectId}/files`),

  delete: (projectId: string) =>
    api<{ ok: boolean }>(`/api/projects/${projectId}`, { method: 'DELETE' }),

  /** 上传本地项目 ZIP */
  upload: (file: File, projectName?: string) => {
    const formData = new FormData()
    formData.append('file', file)
    if (projectName) formData.append('project_name', projectName)
    return api<{ project_id: string; name: string; status: string; file_count: number }>(
      '/api/projects/upload',
      { method: 'POST', body: formData }
    )
  },
}

// ─── Prototype ─────────────────────────────────────────────────────────
export const prototypeApi = {
  /** 根据描述生成 UI 原型 */
  generate: (workspaceId: string, description: string) =>
    api<{
      ok: boolean
      title: string
      description: string
      features: string[]
      tech_notes: string
      preview_url: string
      html_preview: string
      generated_at: string
    }>('/api/prototype/generate', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, description }),
    }),

  /** 迭代修改已有原型 */
  refine: (workspaceId: string, modification: string) =>
    api<{
      ok: boolean
      title: string
      description: string
      features: string[]
      tech_notes: string
      preview_url: string
      html_preview: string
      generated_at: string
    }>('/api/prototype/refine', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, modification }),
    }),

  /** 获取当前原型 */
  get: (workspaceId: string) =>
    api<{
      ok: boolean
      exists: boolean
      title?: string
      html_preview?: string
      preview_url?: string
      generated_at?: string
    }>(`/api/prototype/${workspaceId}`),
}
