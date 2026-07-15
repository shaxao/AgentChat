import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { DEFAULT_BUILTIN_SERVICES } from '@/lib/mcp'
import { truncateToolResult, truncateToolArgs } from '@/lib/toolResultLimit'
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '@/config/defaultPrompt'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ThemeColor = 'blue' | 'green' | 'purple' | 'orange' | 'rose' | 'custom'

export interface User {
  id: string
  name: string
  email: string
  avatar?: string
  role: string  // RBAC 角色代码，如 admin/super_admin/editor/user
  plan: 'free' | 'pro' | 'enterprise'
  tokensUsed: number
  tokensLimit: number
  costUsed?: number
  costLimit?: number
  createdAt: string
  status: 'active' | 'suspended'
  modelLimit?: string  // 订阅限制的模型，逗号分隔，空表示不限
  permissions?: string[]  // RBAC 权限码列表
}

export interface ToolCallInfo {
  toolCallId: string
  toolName: string
  status: 'calling' | 'completed' | 'error'
  arguments?: string
  result?: string
}

export interface SearchResultImage {
  url: string
  alt?: string
  width?: number
  height?: number
}

export interface SearchResultDocument {
  rank: number
  title: string
  url: string
  snippet?: string
  images?: SearchResultImage[]
  host?: { hostname?: string; iconUrl?: string }
  publishTime?: string
  fileType?: string
}

export interface MessageSearchInfo {
  status: 'searching' | 'done' | 'error'
  query: string
  reason?: string
  provider?: string
  total?: number
  documents?: SearchResultDocument[]
  errorCode?: string
  errorMessage?: string
}

export interface Message {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  model?: string
  tokens?: number
  files?: FileAttachment[]
  isStreaming?: boolean
  /** 深度思考内容（前端渲染用） */
  thinkingContent?: string
  error?: string
  /** 被抢占中断标记（Phase 2 动态干预：新消息方向不同时抢占当前回复） */
  preempted?: boolean
  /** 输出可撤销标记 — 抢占时的分割点（valid_output 的字符长度） */
  splitPoint?: number
  /** 被废弃的内容（splitPoint 之后的内容，UI 以灰色/删除线显示） */
  discardedContent?: string
  /** 方向调整标记 — 抢占后继续在同一消息上生成时显示分隔线 */
  directionChanged?: boolean
  translated?: string
  audioUrl?: string
  /** Agent 工具调用记录 */
  toolCalls?: ToolCallInfo[]
  search?: MessageSearchInfo
  /** 嵌入式 AutoCode Agent 卡片 */
  autocode?: {
    taskId: string
    workspaceId: string
    title: string
    status: string
    previewUrl?: string
    /** AutoCode 前端地址（本地开发: http://localhost:3000，生产用实际域名） */
    frontendUrl: string
  }
}

export interface FileAttachment {
  id: string
  name: string
  type: string
  size: number
  url?: string
  content?: string
  /** 是否为二进制文件（如 xlsx/pdf），不可作为文本注入消息 */
  isBinary?: boolean
  /** OSS 上传 URL（上传成功后填充，发送消息时优先使用） */
  ossUrl?: string
  /** OSS 上传状态：uploading | success | error */
  ossUploadStatus?: 'uploading' | 'success' | 'error'
}

/** 当前激活的场景标识 */
export interface ScenarioWorkflowBinding {
  id: number
  name: string
  description?: string
  status?: string
}

export interface ActiveScenario {
  id: number
  name: string
  icon: string
  profession?: string
  description?: string
  systemPrompt?: string
  recommendedSkills?: string[]
  workflowTemplates?: ScenarioWorkflowBinding[]
  workflowCount?: number
}

export interface Conversation {
  id: string
  title: string
  messages: Message[]
  model: string
  createdAt: string
  updatedAt: string
  pinned?: boolean
  tags?: string[]
  // 🔧 每个对话独立的 Agent/Skill 状态（切换对话时自动保存/恢复）
  activeAgentId?: string
  activeSkillIds?: string[]
  activeScenario?: ActiveScenario | null
  scenarioSkillIds?: string[]
  scenarioWorkflowIds?: number[]
}

export interface Model {
  id: string
  name: string
  provider: string
  description: string
  contextLength: number
  inputPrice: number
  cachedInputPrice?: number
  outputPrice: number
  capabilities: ('text' | 'vision' | 'audio' | 'code' | 'reasoning' | 'tool' | 'think')[]
  enabled: boolean
}

export interface ModelChannel {
  id: string
  name: string
  provider: string
  apiKey: string
  baseUrl: string
  models: string[]
  channelType?: 'chat' | 'tts' | 'translate' | 'asr' | 'image' | 'search'  // 渠道类型：聊天/TTS/翻译/搜索，默认 chat
  tags?: string[]   // 渠道能力标签，如 ["tool","vision"]
  ttsVoices?: string  // TTS 音色配置 JSON 字符串
  translateLangs?: string  // 翻译语言配置 JSON 字符串
  status: 'active' | 'error' | 'disabled'
  priority: number
  rateLimit: number
  createdAt: string
}

export interface Plugin {
  id: string
  name: string
  description: string
  icon: string
  category: string
  installed: boolean
  version: string
  author: string
  rating: number
  downloads: number
}

export interface AgentToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface AgentManifest {
  specVersion: string
  agentId: string
  displayName: string
  description: string
  icon: string
  systemPrompt: string
  model: string
  temperature: number
  maxTokens: number
  tools: string[]
  toolDefinitions?: AgentToolDef[]
  hooks?: {
    onMessage?: string
    onFileUpload?: string
    onImageUpload?: string
  }
}

export interface AgentApp {
  id: string
  name: string
  description: string
  icon: string
  systemPrompt: string
  model: string
  tools: string[]
  temperature: number
  maxTokens: number
  agentType?: 'chat' | 'ban_biao' | 'custom'
  manifest?: AgentManifest
}

export interface MCPService {
  id: string
  name: string
  description: string
  endpoint: string
  enabled: boolean
  tools: MCPTool[]
}

export interface MCPTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LogEntry {
  id: string
  userId: string
  userName: string
  model: string
  sceneType?: string
  inputTokens: number
  cachedInputTokens?: number
  outputTokens: number
  cost: number
  latency: number
  status: 'success' | 'error'
  timestamp: string
  conversationId?: string
  requestIp?: string
  provider?: string
  channelId?: string
  channelName?: string
  errorMsg?: string
}

export interface Subscription {
  id: string
  userId: string
  userName: string
  plan: 'free' | 'pro' | 'enterprise' | 'custom'
  planName?: string
  status: 'active' | 'cancelled' | 'expired'
  startDate: string
  endDate: string
  price: number
  costLimit?: number
  costUsed?: number
  tokensLimit?: number
  modelLimit?: string
}

// ==================== Store Types ====================

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
  permissions: string[]
  login: (user: User, token?: string) => void
  logout: () => void
  updateUser: (updates: Partial<User>) => void
  setPermissions: (permissions: string[]) => void
}

interface ThemeState {
  mode: ThemeMode
  color: ThemeColor
  customCss: string
  setMode: (mode: ThemeMode) => void
  setColor: (color: ThemeColor) => void
  setCustomCss: (css: string) => void
}

interface ChatState {
  conversations: Conversation[]
  activeConversationId: string | null
  selectedModel: string
  modelSettings: {
    temperature: number
    maxTokens: number
    topP: number
    systemPrompt: string
  }
  activeAgent: AgentApp | null
  activeScenario: ActiveScenario | null
  activeSkillIds: string[]
  installedSkillIds: string[]
  /** 深度思考开关 */
  thinkEnabled: boolean
  /** 深度思考预算（tokens），默认 8192 */
  thinkingBudget: number
  mcpServices: MCPService[]
  setActiveConversation: (id: string | null) => void
  createConversation: (title?: string) => string
  updateConversation: (id: string, updates: Partial<Conversation>) => void
  deleteConversation: (id: string) => void
  truncateConversationContent: (conversationId: string, keepFull?: number, maxContent?: number) => void
  addMessage: (conversationId: string, message: Message) => void
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void
  setSelectedModel: (model: string) => void
  setModelSettings: (settings: Partial<ChatState['modelSettings']>) => void
  setActiveAgent: (agent: AgentApp | null) => void
  setActiveScenario: (scenario: ActiveScenario | null) => void
  setActiveSkillIds: (ids: string[]) => void
  setInstalledSkillIds: (ids: string[]) => void
  addInstalledSkill: (agentId: string) => void
  removeInstalledSkill: (agentId: string) => void
  toggleMCPService: (id: string) => void
  addMCPService: (service: MCPService) => void
  removeMCPService: (id: string) => void
  updateMCPService: (id: string, updates: Partial<MCPService>) => void
  setThinkEnabled: (enabled: boolean) => void
  setThinkingBudget: (budget: number) => void
}

interface AdminState {
  users: User[]
  channels: ModelChannel[]
  logs: LogEntry[]
  subscriptions: Subscription[]
  plugins: Plugin[]
  agents: AgentApp[]
  models: Model[]
  setUsers: (users: User[]) => void
  setChannels: (channels: ModelChannel[]) => void
  setLogs: (logs: LogEntry[]) => void
  setModels: (models: Model[]) => void
  setSubscriptions: (subs: Subscription[]) => void
  // User CRUD
  addUser: (user: User) => void
  updateUser: (id: string, updates: Partial<User>) => void
  deleteUser: (id: string) => void
  // Channel CRUD
  addChannel: (channel: ModelChannel) => void
  updateChannel: (id: string, updates: Partial<ModelChannel>) => void
  deleteChannel: (id: string) => void
  // Model CRUD
  addModel: (model: Model) => void
  updateModel: (id: string, updates: Partial<Model>) => void
  deleteModel: (id: string) => void
  // Subscription CRUD
  addSubscription: (sub: Subscription) => void
  updateSubscription: (id: string, updates: Partial<Subscription>) => void
  deleteSubscription: (id: string) => void
  // Plugin
  togglePlugin: (id: string) => void
  // Agent CRUD
  addAgent: (agent: AgentApp) => void
  updateAgent: (id: string, updates: Partial<AgentApp>) => void
  deleteAgent: (id: string) => void
}

// ==================== Auth Store ====================
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      permissions: [],
      login: (user, token) => set({ user, token: token || null, isAuthenticated: true }),
      logout: () => set({ user: null, token: null, isAuthenticated: false, permissions: [] }),
      updateUser: (updates) => set((state) => ({ user: state.user ? { ...state.user, ...updates } : null })),
      setPermissions: (permissions) => set({ permissions }),
    }),
    { name: 'auth-store' }
  )
)

// ==================== Theme Store ====================
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      mode: 'system',
      color: 'blue',
      customCss: '',
      setMode: (mode) => set({ mode }),
      setColor: (color) => set({ color }),
      setCustomCss: (customCss) => set({ customCss }),
    }),
    { name: 'theme-store' }
  )
)

// ==================== Chat Store ====================

const defaultMCPServices: MCPService[] = [
  ...DEFAULT_BUILTIN_SERVICES,
  {
    id: 'custom-mcp-example',
    name: '自建 MCP 服务（示例）',
    description: '填写你的 MCP Server 地址，支持标准 MCP over HTTP/SSE 协议',
    endpoint: 'http://localhost:3001/mcp',
    enabled: false,
    tools: [],
  },
]

export const useChatStore = create<ChatState>()((set, get) => {
    // --- 清理旧版 localStorage（曾因消息膨胀导致 OOM） ---
    try {
      const oldChatStore = localStorage.getItem('chat-store')
      if (oldChatStore && oldChatStore.length > 100000) {
        console.warn('[chat-store] 清理旧版 chat-store localStorage（' + (oldChatStore.length / 1024 / 1024).toFixed(1) + 'MB），已迁移到按需加载')
      }
      localStorage.removeItem('chat-store')
    } catch {}
    // --- 手动持久化：仅保存 UI 设置到 localStorage，消息完全不存 ---
    const UI_PREFS_KEY = 'chat-ui-prefs-v2'
    let _saveTimer: ReturnType<typeof setTimeout> | null = null
    let _lastSave = 0
    const saveUiPrefs = () => {
      const now = Date.now()
      // 节流：2 秒内最多保存一次
      if (now - _lastSave < 2000) {
        if (!_saveTimer) {
          _saveTimer = setTimeout(() => { _saveTimer = null; saveUiPrefs() }, 2000)
        }
        return
      }
      _lastSave = now
      const s = get()
      try {
        const prefs = {
          selectedModel: s.selectedModel,
          modelSettings: s.modelSettings,
          activeConversationId: s.activeConversationId,
          installedSkillIds: s.installedSkillIds,
          activeScenario: s.activeScenario,
          thinkEnabled: s.thinkEnabled,
          thinkingBudget: s.thinkingBudget,
          // ⚠️ 不再持久化 activeAgent：其 systemPrompt + manifest 可达 10K+ 字符
          // 且下次启动时从后端/本地重新加载，无需占用 localStorage
          mcpServices: s.mcpServices,
        }
        localStorage.setItem(UI_PREFS_KEY, JSON.stringify(prefs))
      } catch { /* quota exceeded, ignore */ }
    }
    const loadUiPrefs = (): Partial<ChatState> => {
      try {
        const raw = localStorage.getItem(UI_PREFS_KEY)
        if (raw) {
          const prefs = JSON.parse(raw)
          return {
            selectedModel: prefs.selectedModel || 'auto',
            modelSettings: prefs.modelSettings || {
              temperature: 0.7, maxTokens: 4096, topP: 1,
              systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
            },
            activeConversationId: prefs.activeConversationId || null,
            installedSkillIds: prefs.installedSkillIds || [],
            activeScenario: prefs.activeScenario || null,
            thinkEnabled: prefs.thinkEnabled ?? false,
            thinkingBudget: prefs.thinkingBudget || 8192,
            // activeAgent 不再从 localStorage 恢复（太大，下次启动从零开始）
            mcpServices: prefs.mcpServices || defaultMCPServices,
          }
        }
      } catch {}
      return {}
    }

    return {
      ...loadUiPrefs(),  // 恢复 UI 设置
      conversations: [],   // 消息从后端 API 按需加载
      activeSkillIds: [],
      // 确保默认值存在
      selectedModel: loadUiPrefs().selectedModel || 'auto',
      modelSettings: loadUiPrefs().modelSettings || {
        temperature: 0.7, maxTokens: 4096, topP: 1,
        systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
      },
      activeConversationId: loadUiPrefs().activeConversationId || null,
      installedSkillIds: loadUiPrefs().installedSkillIds || [],
      activeAgent: loadUiPrefs().activeAgent || null,
      activeScenario: loadUiPrefs().activeScenario || null,
      thinkEnabled: loadUiPrefs().thinkEnabled ?? false,
      thinkingBudget: loadUiPrefs().thinkingBudget || 8192,
      mcpServices: loadUiPrefs().mcpServices || defaultMCPServices,

      setActiveConversation: (id) => {
        const state = get()
        const oldConvId = state.activeConversationId

        // 🔧 保存当前对话的 Agent/Skill 状态
        if (oldConvId) {
          const oldConv = state.conversations.find(c => c.id === oldConvId)
          if (oldConv) {
            get().updateConversation(oldConvId, {
              activeAgentId: state.activeAgent?.id || undefined,
              activeSkillIds: state.activeSkillIds.length > 0 ? state.activeSkillIds : undefined,
              activeScenario: state.activeScenario,
              scenarioSkillIds: state.activeScenario && state.activeSkillIds.length > 0 ? state.activeSkillIds : undefined,
              scenarioWorkflowIds: state.activeScenario?.workflowTemplates?.map(w => w.id),
            })
          }
        }

        // 🔧 恢复目标对话的 Agent/Skill 状态
        const targetConv = state.conversations.find(c => c.id === id)
        let restoredAgent = null as typeof state.activeAgent
        let restoredSkillIds: string[] = []
        let restoredScenario: ActiveScenario | null = null

        if (targetConv) {
          // 从目标对话恢复 Agent（需要完整 Agent 对象，不只是 ID）
          if (targetConv.activeAgentId) {
            const allAgents = useAdminStore.getState().agents
            restoredAgent = allAgents.find(a =>
              a.id === targetConv.activeAgentId ||
              a.id === `server:${targetConv.activeAgentId}` ||
              a.agentType === targetConv.activeAgentId
            ) || null
          }
          restoredSkillIds = targetConv.activeSkillIds || []
          restoredScenario = targetConv.activeScenario || null
        }

        set({
          activeConversationId: id,
          activeAgent: restoredAgent,
          activeSkillIds: restoredSkillIds,
          activeScenario: restoredScenario,
        })
        saveUiPrefs()
      },
      createConversation: (title = '新对话') => {
        const id = `conv_${Date.now()}`
        const conv: Conversation = {
          id,
          title,
          messages: [],
          model: get().selectedModel,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        set((state) => {
          // 🔴 OOM 防御：限制对话数量上限（20 个），防止 store 无限增长
          const MAX_CONVERSATIONS = 20
          let conversations = [conv, ...state.conversations]
          if (conversations.length > MAX_CONVERSATIONS) {
            // 优先删除非置顶的最旧对话
            const sorted = [...conversations].sort((a, b) => {
              if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
              return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
            })
            conversations = sorted.slice(-MAX_CONVERSATIONS)
            console.warn(`[OOM-Monitor] 对话数超过 ${MAX_CONVERSATIONS}，已自动清理最旧对话（当前 ${conversations.length} 个）`)
          }
          return {
            conversations,
            activeConversationId: id,
            activeAgent: null,
            activeSkillIds: [],
            activeScenario: null,
          }
        })
        saveUiPrefs()
        return id
      },
      updateConversation: (id, updates) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === id ? { ...c, ...updates, updatedAt: new Date().toISOString() } : c
          ),
        })),
      deleteConversation: (id) =>
        set((state) => ({
          conversations: state.conversations.filter((c) => c.id !== id),
          activeConversationId:
            state.activeConversationId === id ? null : state.activeConversationId,
        })),
      /** 🔧 截断对话中旧消息的内容（保留最后 KEEP_FULL 条完整，其余截断到 MAX_CONTENT 字符） */
      truncateConversationContent: (conversationId: string, keepFull = 5, maxContent = 500) =>
        set((state) => ({
          conversations: state.conversations.map((c) => {
            if (c.id !== conversationId) return c
            const msgs = [...c.messages]
            const cutoff = Math.max(0, msgs.length - keepFull)
            let changed = false
            for (let i = 0; i < cutoff; i++) {
              if (msgs[i].content.length > maxContent) {
                msgs[i] = { ...msgs[i], content: msgs[i].content.slice(0, maxContent) + '…' }
                changed = true
              }
              // 🔧 分层截断旧消息的工具结果
              if (msgs[i].toolCalls?.some(tc => tc.result && tc.result.length > 5000)) {
                msgs[i] = {
                  ...msgs[i],
                  toolCalls: msgs[i].toolCalls!.map(tc => ({
                    ...tc,
                    arguments: truncateToolArgs(tc.arguments),  // OOM 防护
                    result: truncateToolResult(tc.toolName, tc.result),
                  }))
                }
                changed = true
              }
            }
            return changed ? { ...c, messages: msgs } : c
          }),
        })),
      addMessage: (conversationId, message) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? (() => {
                  // 内存限制：每对话最多保留 MAX_MESSAGES 条消息
                  const MAX_MESSAGES = 50  // 从 100 降到 50（极端 OOM 防御）
                  let newMessages = [...c.messages, message]
                  if (newMessages.length > MAX_MESSAGES) {
                    newMessages = newMessages.slice(newMessages.length - MAX_MESSAGES)
                  }
                  // 🔧 当消息超过 40 条时，截断旧消息内容到 500 字符
                  if (newMessages.length > 40) {
                    const MAX_CONTENT = 500
                    const cutPoint = newMessages.length - 10  // 保留最后 10 条完整
                    for (let i = 0; i < cutPoint; i++) {
                      const m = newMessages[i]
                      if (m.content.length > MAX_CONTENT) {
                        newMessages[i] = { ...m, content: m.content.slice(0, MAX_CONTENT) + '…' }
                      }
                    }
                  }
                  return {
                    ...c,
                    messages: newMessages,
                    updatedAt: new Date().toISOString(),
                    title:
                      c.messages.length === 0 && message.role === 'user'
                        ? message.content.slice(0, 30)
                        : c.title,
                  }
                })()
              : c
          ),
        })),
      updateMessage: (conversationId, messageId, updates) =>
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.id === conversationId
              ? {
                  ...c,
                  messages: (() => {
                    // 🔧 分层截断：代码 50KB / 数据 20KB / 其他 5KB
                    const updated = c.messages.map((m) => {
                      if (m.id !== messageId) return m
                      const merged = { ...m, ...updates }
                      if (merged.toolCalls) {
                        merged.toolCalls = merged.toolCalls.map(tc => ({
                          ...tc,
                          arguments: truncateToolArgs(tc.arguments),  // OOM 防护：截断超大参数
                          result: truncateToolResult(tc.toolName, tc.result),
                        }))
                      }
                      return merged
                    })
                    // 🔧 OOM 防御：流式完成时截断旧消息内容
                    // 只保留最后 5 条消息完整内容，其余截断到 500 字符
                    if (updates.isStreaming === false) {
                      const KEEP_FULL = 5
                      const MAX_CONTENT = 500
                      for (let i = 0; i < updated.length - KEEP_FULL; i++) {
                        const m = updated[i]
                        if (m.content.length > MAX_CONTENT) {
                          updated[i] = { ...m, content: m.content.slice(0, MAX_CONTENT) + '…' }
                        }
                        // 🔧 分层截断旧消息的工具结果和参数
                        if (m.toolCalls?.some(tc => (tc.result && tc.result.length > 5000) || (tc.arguments && tc.arguments.length > 2000))) {
                          updated[i] = {
                            ...updated[i],
                            toolCalls: updated[i].toolCalls!.map(tc => ({
                              ...tc,
                              arguments: truncateToolArgs(tc.arguments),
                              result: truncateToolResult(tc.toolName, tc.result),
                            }))
                          }
                        }
                      }
                    }
                    return updated
                  })(),
                }
              : c
          ),
        })),
      setSelectedModel: (model) => {
        set({ selectedModel: model })
        saveUiPrefs()
      },
      setModelSettings: (settings) =>
        set((state) => {
          const next = { modelSettings: { ...state.modelSettings, ...settings } }
          saveUiPrefs()
          return next
        }),
      setActiveAgent: (agent) => {
        const state = get()
        // 🔧 同步保存到当前对话
        if (state.activeConversationId) {
          get().updateConversation(state.activeConversationId, {
            activeAgentId: agent?.id || undefined,
          })
        }
        if (agent && agent.model) {
          const current = state.selectedModel
          if (current !== agent.model) {
            set({ activeAgent: agent, selectedModel: agent.model })
            saveUiPrefs()
            return
          }
        }
        // 取消 Agent 时同时清空技能列表，避免对话继续使用技能
        set({ activeAgent: agent, activeSkillIds: agent ? state.activeSkillIds : [] })
      },
      setActiveScenario: (scenario) => {
        const convId = get().activeConversationId
        if (convId) {
          get().updateConversation(convId, {
            activeScenario: scenario,
            scenarioWorkflowIds: scenario?.workflowTemplates?.map(w => w.id),
            scenarioSkillIds: scenario?.recommendedSkills,
          })
        }
        set({ activeScenario: scenario })
        saveUiPrefs()
      },
      setActiveSkillIds: (ids) => {
        const convId = get().activeConversationId
        // 🔧 同步保存到当前对话
        if (convId) {
          get().updateConversation(convId, {
            activeSkillIds: ids.length > 0 ? ids : undefined,
          })
        }
        set({ activeSkillIds: ids })
      },
      setInstalledSkillIds: (ids) => {
        set({ installedSkillIds: ids })
        saveUiPrefs()
      },
      addInstalledSkill: (agentId) => set((state) => {
        const next = {
          installedSkillIds: state.installedSkillIds.includes(agentId)
            ? state.installedSkillIds
            : [...state.installedSkillIds, agentId]
        }
        saveUiPrefs()
        return next
      }),
      removeInstalledSkill: (agentId) => set((state) => {
        const next = {
          installedSkillIds: state.installedSkillIds.filter(id => id !== agentId)
        }
        saveUiPrefs()
        return next
      }),
      toggleMCPService: (id) =>
        set((state) => ({
          mcpServices: state.mcpServices.map((s) =>
            s.id === id ? { ...s, enabled: !s.enabled } : s
          ),
        })),
      addMCPService: (service) =>
        set((state) => ({ mcpServices: [...state.mcpServices, service] })),
      removeMCPService: (id) =>
        set((state) => ({ mcpServices: state.mcpServices.filter(s => s.id !== id) })),
      updateMCPService: (id, updates) =>
        set((state) => ({
          mcpServices: state.mcpServices.map(s => s.id === id ? { ...s, ...updates } : s)
        })),
      setThinkEnabled: (enabled) => {
        set({ thinkEnabled: enabled })
        saveUiPrefs()
      },
      setThinkingBudget: (budget) => {
        set({ thinkingBudget: budget })
        saveUiPrefs()
      },
    }
  })

// ==================== Admin Store ====================

const generateMockUsers = (): User[] =>
  Array.from({ length: 20 }, (_, i) => ({
    id: `user_${i + 1}`,
    name: ['张三', '李四', '王五', '赵六', '陈七', '周八', '吴九', '郑十'][i % 8] + (i > 7 ? `_${Math.floor(i / 8)}` : ''),
    email: `user${i + 1}@example.com`,
    role: i === 0 ? 'admin' : 'user',
    plan: ['free', 'pro', 'enterprise'][i % 3] as User['plan'],
    tokensUsed: Math.floor(Math.random() * 100000),
    tokensLimit: [50000, 500000, 5000000][i % 3],
    createdAt: new Date(Date.now() - Math.random() * 86400000 * 365).toISOString(),
    status: i % 10 === 0 ? 'suspended' : 'active',
  }))

const generateMockChannels = (): ModelChannel[] => [
  {
    id: 'ch_1',
    name: 'OpenAI 官方',
    provider: 'OpenAI',
    apiKey: 'sk-****',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo'],
    tags: ['tool', 'vision'],
    status: 'active',
    priority: 1,
    rateLimit: 60,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'ch_2',
    name: 'Anthropic Claude',
    provider: 'Anthropic',
    apiKey: 'sk-ant-****',
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-3-5-sonnet', 'claude-3-opus', 'claude-3-haiku'],
    tags: ['tool', 'vision', 'reasoning'],
    status: 'active',
    priority: 2,
    rateLimit: 30,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'ch_3',
    name: 'Google Gemini',
    provider: 'Google',
    apiKey: 'AIza****',
    baseUrl: 'https://generativelanguage.googleapis.com',
    models: ['gemini-2.0-flash', 'gemini-1.5-pro'],
    tags: ['tool', 'vision', 'audio'],
    status: 'active',
    priority: 3,
    rateLimit: 60,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'ch_4',
    name: 'DeepSeek',
    provider: 'DeepSeek',
    apiKey: 'sk-****',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    tags: ['tool'],
    status: 'error',
    priority: 4,
    rateLimit: 30,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'ch_5',
    name: '通义千问',
    provider: 'Alibaba',
    apiKey: 'sk-****',
    baseUrl: 'https://dashscope.aliyuncs.com',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
    tags: ['tool'],
    status: 'active',
    priority: 5,
    rateLimit: 60,
    createdAt: new Date().toISOString(),
  },
]

const generateMockLogs = (): LogEntry[] =>
  Array.from({ length: 100 }, (_, i) => ({
    id: `log_${i}`,
    userId: `user_${(i % 10) + 1}`,
    userName: ['张三', '李四', '王五', '赵六', '陈七'][i % 5],
    model: ['gpt-4o', 'gpt-4o-mini', 'claude-3-5-sonnet', 'gemini-2.0-flash'][i % 4],
    inputTokens: Math.floor(Math.random() * 2000) + 100,
    outputTokens: Math.floor(Math.random() * 1000) + 50,
    cost: Math.random() * 0.05,
    latency: Math.floor(Math.random() * 3000) + 200,
    status: Math.random() > 0.05 ? 'success' : 'error',
    timestamp: new Date(Date.now() - Math.random() * 86400000 * 7).toISOString(),
  }))

const generateMockSubscriptions = (): Subscription[] =>
  Array.from({ length: 15 }, (_, i) => ({
    id: `sub_${i}`,
    userId: `user_${i + 1}`,
    userName: ['张三', '李四', '王五', '赵六', '陈七', '周八'][i % 6],
    plan: ['free', 'pro', 'enterprise'][i % 3] as Subscription['plan'],
    status: ['active', 'cancelled', 'expired'][Math.floor(Math.random() * 3)] as Subscription['status'],
    startDate: new Date(Date.now() - Math.random() * 86400000 * 60).toISOString(),
    endDate: new Date(Date.now() + Math.random() * 86400000 * 300).toISOString(),
    price: [0, 99, 299][i % 3],
  }))

const defaultModels: Model[] = [
  { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI', description: 'OpenAI最新多模态模型', contextLength: 128000, inputPrice: 5, outputPrice: 15, capabilities: ['text', 'vision', 'code', 'tool'], enabled: true },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI', description: '快速、经济的GPT-4o版本', contextLength: 128000, inputPrice: 0.15, outputPrice: 0.6, capabilities: ['text', 'vision', 'code', 'tool'], enabled: true },
  { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet', provider: 'Anthropic', description: 'Anthropic旗舰模型', contextLength: 200000, inputPrice: 3, outputPrice: 15, capabilities: ['text', 'vision', 'code', 'reasoning', 'tool'], enabled: true },
  { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'Google', description: 'Google最新快速模型', contextLength: 1000000, inputPrice: 0.1, outputPrice: 0.4, capabilities: ['text', 'vision', 'audio', 'code', 'tool'], enabled: true },
  { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'DeepSeek', description: '深度求索对话模型', contextLength: 64000, inputPrice: 0.14, outputPrice: 0.28, capabilities: ['text', 'code'], enabled: true },
  { id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'DeepSeek', description: '深度求索推理模型', contextLength: 64000, inputPrice: 0.55, outputPrice: 2.19, capabilities: ['text', 'code', 'reasoning'], enabled: true },
  { id: 'qwen-max', name: '通义千问 Max', provider: 'Alibaba', description: '阿里云旗舰大模型', contextLength: 32000, inputPrice: 0.04, outputPrice: 0.12, capabilities: ['text', 'code', 'tool'], enabled: true },
]

const defaultAgents: AgentApp[] = [
  { id: 'code-assistant', name: '代码助手', description: '专业的编程助手，帮助写代码、调试、优化', icon: '💻', systemPrompt: '你是一位专业的程序员...', model: 'gpt-4o', tools: ['code-exec'], temperature: 0.2, maxTokens: 8192 },
  { id: 'writer', name: '写作助手', description: '创意写作、文案润色、内容创作', icon: '✍️', systemPrompt: '你是一位专业的作家...', model: 'claude-3-5-sonnet', tools: [], temperature: 0.9, maxTokens: 4096 },
  { id: 'translator', name: '翻译专家', description: '精准的多语言互译助手', icon: '🌐', systemPrompt: '你是一位专业翻译...', model: 'gpt-4o-mini', tools: [], temperature: 0.3, maxTokens: 2048 },
  { id: 'data-analyst', name: '数据分析师', description: '数据分析、可视化建议、洞察提取', icon: '📊', systemPrompt: '你是一位专业的数据分析师...', model: 'gpt-4o', tools: ['code-exec'], temperature: 0.4, maxTokens: 4096 },
  { id: 'customer-service', name: '客服助手', description: '友善专业的客户服务助手', icon: '🎯', systemPrompt: '你是一位专业的客服...', model: 'gpt-4o-mini', tools: [], temperature: 0.5, maxTokens: 2048 },
  { id: 'research', name: '研究助手', description: '深度研究、文献综述、知识整合', icon: '🔬', systemPrompt: '你是一位专业研究员...', model: 'claude-3-5-sonnet', tools: ['search'], temperature: 0.6, maxTokens: 8192 },
  {
    id: 'ban-biao',
    name: '台账识别',
    description: '识别和提取文档中的台账/报表数据，支持图片和PDF输入',
    icon: '📋',
    systemPrompt: `你是一个专业的台账识别助手。你的任务是：
1. 识别用户上传的文档或图片中的表格/台账数据
2. 提取表格中的结构化数据（字段名、值、合计等）
3. 将识别结果转换为结构化的 JSON 格式输出
4. 如果识别不确定，标注置信度

输出格式：
- 表格数据用 JSON 数组表示
- 每行数据为一个对象，键名为表头
- 附加元数据：表名、单位、日期等`,
    model: 'gpt-4o',
    tools: [],
    temperature: 0.1,
    maxTokens: 8192,
    agentType: 'ban_biao',
    manifest: {
      specVersion: '1.0.0',
      agentId: 'ban-biao',
      displayName: '台账识别',
      description: '识别和提取文档中的台账/报表数据，支持图片和PDF输入',
      icon: '📋',
      systemPrompt: '',
      model: 'gpt-4o',
      temperature: 0.1,
      maxTokens: 8192,
      tools: [],
      toolDefinitions: [
        {
          name: 'extract_table',
          description: '从图片或文档中提取表格数据',
          parameters: {
            type: 'object',
            properties: {
              format: { type: 'string', enum: ['json', 'csv', 'markdown'], description: '输出格式' },
              include_metadata: { type: 'boolean', description: '是否包含元数据' },
            },
          },
        },
      ],
      hooks: {
        onImageUpload: `context.modifiedContent = '请识别此图片中的台账/表格数据，并按结构化格式输出。'; return { proceed: true, modifiedContent: context.modifiedContent };`,
        onFileUpload: `context.modifiedContent = '请识别此文件中的台账/表格数据，并按结构化格式输出。'; return { proceed: true, modifiedContent: context.modifiedContent };`,
      },
    },
  },
]

const defaultPlugins: Plugin[] = [
  { id: 'dalle', name: 'DALL·E 图像生成', description: '使用DALL·E生成高质量图像', icon: '🎨', category: '图像', installed: true, version: '1.0.0', author: 'OpenAI', rating: 4.8, downloads: 12500 },
  { id: 'stable-diffusion', name: 'Stable Diffusion', description: '本地Stable Diffusion图像生成', icon: '🖼️', category: '图像', installed: false, version: '2.1.0', author: 'Stability AI', rating: 4.6, downloads: 8900 },
  { id: 'web-search', name: '网络搜索', description: '实时搜索互联网信息', icon: '🔍', category: '工具', installed: true, version: '1.2.0', author: 'AI Platform', rating: 4.7, downloads: 23000 },
  { id: 'python-runner', name: 'Python Runner', description: '在线执行Python代码', icon: '🐍', category: '开发', installed: true, version: '1.0.5', author: 'DevTools', rating: 4.9, downloads: 15600 },
  { id: 'pdf-reader', name: 'PDF Reader', description: '解析和分析PDF文档', icon: '📄', category: '文档', installed: false, version: '1.1.0', author: 'DocTools', rating: 4.5, downloads: 7200 },
  { id: 'calculator', name: '高级计算器', description: '科学计算和数学运算', icon: '🧮', category: '工具', installed: false, version: '1.0.0', author: 'MathTools', rating: 4.3, downloads: 4500 },
]

export const useAdminStore = create<AdminState>()(
  persist(
    (set) => ({
      users: generateMockUsers(),
      channels: generateMockChannels(),
      logs: generateMockLogs(),
      subscriptions: generateMockSubscriptions(),
      plugins: defaultPlugins,
      agents: defaultAgents,
      models: defaultModels,
      setUsers: (users) => set({ users }),
      setChannels: (channels) => set({ channels }),
      setLogs: (logs) => set({ logs }),
      setModels: (models) => set({ models }),
      setSubscriptions: (subscriptions) => set({ subscriptions }),
      // User CRUD
      addUser: (user) => set((state) => ({ users: [user, ...state.users] })),
      updateUser: (id, updates) =>
        set((state) => ({ users: state.users.map((u) => (u.id === id ? { ...u, ...updates } : u)) })),
      deleteUser: (id) => set((state) => ({ users: state.users.filter((u) => u.id !== id) })),
      // Channel CRUD
      addChannel: (channel) => set((state) => ({ channels: [...state.channels, channel] })),
      updateChannel: (id, updates) =>
        set((state) => ({ channels: state.channels.map((c) => (c.id === id ? { ...c, ...updates } : c)) })),
      deleteChannel: (id) => set((state) => ({ channels: state.channels.filter((c) => c.id !== id) })),
      // Model CRUD
      addModel: (model) => set((state) => ({ models: [model, ...state.models] })),
      updateModel: (id, updates) =>
        set((state) => ({ models: state.models.map((m) => (m.id === id ? { ...m, ...updates } : m)) })),
      deleteModel: (id) => set((state) => ({ models: state.models.filter((m) => m.id !== id) })),
      // Subscription CRUD
      addSubscription: (sub) => set((state) => ({ subscriptions: [sub, ...state.subscriptions] })),
      updateSubscription: (id, updates) =>
        set((state) => ({ subscriptions: state.subscriptions.map((s) => (s.id === id ? { ...s, ...updates } : s)) })),
      deleteSubscription: (id) => set((state) => ({ subscriptions: state.subscriptions.filter((s) => s.id !== id) })),
      // Plugin
      togglePlugin: (id) =>
        set((state) => ({ plugins: state.plugins.map((p) => (p.id === id ? { ...p, installed: !p.installed } : p)) })),
      // Agent CRUD
      addAgent: (agent) => set((state) => ({ agents: [agent, ...state.agents] })),
      updateAgent: (id, updates) =>
        set((state) => ({ agents: state.agents.map((a) => (a.id === id ? { ...a, ...updates } : a)) })),
      deleteAgent: (id) => set((state) => ({ agents: state.agents.filter((a) => a.id !== id) })),
    }),
    { name: 'admin-store' }
  )
)
