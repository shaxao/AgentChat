import { useState, useRef, useEffect, useCallback, useMemo, useTransition } from 'react'
import { useChatStore, useAdminStore, useAuthStore, Message, FileAttachment, ToolCallInfo } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { MessageBubble, TypingIndicator, clearMessageCaches } from '@/components/chat/MessageBubble'
import { UIActionPayload } from '@/components/chat/UIBlockRenderer'
import ChatInput from '@/components/chat/ChatInput'
import SkillChips from '@/components/chat/SkillChips'
import Sidebar from '@/components/chat/Sidebar'
import ModelPanel from '@/components/chat/ModelPanel'
import MemoryPanel from '@/components/chat/MemoryPanel'
import MemoryContextDialog from '@/components/chat/MemoryContextDialog'
import MemorySummaryCard from '@/components/chat/MemorySummaryCard'
import {
  Bot, Settings2, PanelRightOpen, PanelRightClose, Share2,
  Trash2, MoreHorizontal, Sparkles, Cpu, Eraser, Pin, PinOff, Download,
  AlertTriangle, Menu, ChevronDown, Star, FolderOpen, Brain,
  LayoutGrid, ArrowRight, X, Zap,
  Workflow, Info, Play, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { MainView } from '@/components/layout/IconNavBar'
import { truncateToolResult, truncateToolArgs } from '@/lib/toolResultLimit'
import { useMemoryMonitor } from '@/lib/useMemoryMonitor'
import { useAvailableModels } from '@/hooks/useAvailableModels'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { sendMessage, apiDeleteConversation, apiClearMessages, apiTogglePin, loadConversations, loadConversationMessages, isDemoMode, aiTranslate, aiTTS, createAutoCodeTask, uploadLedgerFile, chatApi, agentRegistryApi, workflowApi, workflowArtifactApi, buildScenarioWorkflowTag, authApi, memoryApi, type WorkflowBriefVO, type ExecutionVO, type WorkflowArtifactVO } from '@/lib/api'
import { buildToolsSystemPrompt, parseToolCalls, mcpCallTool } from '@/lib/mcp'
import { runPluginPreprocess } from '@/lib/plugins'
import { getFileFromSource } from '@/lib/fileUtils'
import { decideIntervention, findSplitPoint, type InterventionDecision } from '@/lib/directionConsistency'
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '@/config/defaultPrompt'

const DEMO_MODE = isDemoMode()

const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T | null> => {
  return Promise.race([
    promise,
    new Promise<null>(resolve => window.setTimeout(() => resolve(null), ms)),
  ])
}

const VISUAL_RESPONSE_SYSTEM_PROMPT = `## 回复视觉排版要求

- 优先输出可直接阅读的 Markdown，不要把 HTML 源码当作普通文本展示给用户。
- 当答案包含流程、对比、指标、步骤、清单、时间线、知识卡片时，可以使用安全的内联 HTML 视觉块增强排版。
- HTML 视觉块只能用于静态展示：允许 div、section、h2/h3、p、ul/li、table、span、strong、code、pre 等基础元素和内联 style；禁止 script、iframe、外链追踪、自动执行代码。
- 移动端优先：内容不要依赖超宽布局；长代码使用 Markdown 代码块，长流程可用 Mermaid。
- 代码类回答应先说明核心思路，再给完整代码块；代码块必须标明语言。`

type ScenarioWorkspaceBandProps = {
  scenario: NonNullable<ReturnType<typeof useChatStore.getState>['activeScenario']>
  selectedSkillCount: number
  availableWorkflows: WorkflowBriefVO[]
  executingWorkflowId?: number | null
  disabled?: boolean
  collapsed: boolean
  onToggleCollapsed: () => void
  onExecuteWorkflow: (workflow: { id: number; name: string; description?: string; status?: string }, autoBind?: boolean) => void
  onOpenSkillStore: () => void
  onOpenWorkflow: () => void
  onExit: () => void
}

function ScenarioWorkspaceBand({
  scenario,
  selectedSkillCount,
  availableWorkflows,
  executingWorkflowId,
  disabled,
  collapsed,
  onToggleCollapsed,
  onExecuteWorkflow,
  onOpenSkillStore,
  onOpenWorkflow,
  onExit,
}: ScenarioWorkspaceBandProps) {
  const workflows = scenario.workflowTemplates || []
  const workflowCount = scenario.workflowCount ?? workflows.length
  const unboundWorkflows = availableWorkflows.filter(w => !workflows.some(bound => bound.id === w.id))

  if (collapsed) {
    return (
      <div className="border-b bg-primary/[0.035] px-3 py-2 sm:px-4 shrink-0">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-2">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggleCollapsed}>
            <Badge className="shrink-0 rounded-md">场景</Badge>
            <span className="truncate text-sm font-medium">{scenario.name}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">技能 {selectedSkillCount} · 工作流 {workflowCount}</span>
          </button>
          <div className="flex shrink-0 items-center gap-1">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onToggleCollapsed} title="展开场景工作区">
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onExit} title="退出场景">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="border-b bg-primary/[0.035] px-3 py-3 sm:px-4 shrink-0">
      <div className="mx-auto max-w-4xl space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-background text-xl">
              {scenario.icon && (scenario.icon.startsWith('http') || scenario.icon.startsWith('/api/'))
                ? <img src={scenario.icon} alt="" className="h-full w-full rounded-lg object-cover" />
                : <span>{scenario.icon || 'S'}</span>}
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-md">场景工作模式</Badge>
                {scenario.profession && <Badge variant="outline" className="rounded-md">{scenario.profession}</Badge>}
              </div>
              <h3 className="mt-1 truncate text-sm font-semibold">{scenario.name}</h3>
              {scenario.description && (
                <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{scenario.description}</p>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onToggleCollapsed}>
              <ChevronDown className="h-3.5 w-3.5 rotate-180" /> 收起
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onOpenSkillStore} disabled={disabled}>
              <Zap className="h-3.5 w-3.5" /> 技能
            </Button>
            <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={onOpenWorkflow}>
              <Workflow className="h-3.5 w-3.5" /> 工作流
            </Button>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5" onClick={onExit}>
              <X className="h-3.5 w-3.5" /> 退出
            </Button>
          </div>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border bg-background/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">当前对话技能</span>
              <span className="text-muted-foreground">{selectedSkillCount} 个已启用</span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              可为这个场景对话单独增减技能，不会改动市场场景或我的场景模板。
            </p>
          </div>
          <div className="rounded-md border bg-background/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">关联工作流</span>
              <span className="text-muted-foreground">{workflowCount} 个</span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
              工作流会作为该场景的执行参考；需要自动化时可进入工作流页查看、克隆或手动运行。
            </p>
            {workflows.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {workflows.slice(0, 3).map(w => (
                  <Badge key={w.id} variant="secondary" className="max-w-full rounded-md text-[11px] gap-1">
                    <span className="truncate">{w.name}</span>
                    <button
                      type="button"
                      className="ml-1 rounded-sm hover:text-primary"
                      disabled={disabled || executingWorkflowId === w.id}
                      onClick={() => onExecuteWorkflow(w, false)}
                      title="执行工作流"
                    >
                      {executingWorkflowId === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                    </button>
                  </Badge>
                ))}
                {workflows.length > 3 && <Badge variant="outline" className="rounded-md text-[11px]">+{workflows.length - 3}</Badge>}
              </div>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {unboundWorkflows.slice(0, 4).map(w => (
                <Button
                  key={w.id}
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1 rounded-md px-2 text-[11px]"
                  disabled={disabled || executingWorkflowId === w.id}
                  onClick={() => onExecuteWorkflow(w, true)}
                  title="执行并加入本对话场景"
                >
                  {executingWorkflowId === w.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  <span className="max-w-[120px] truncate">{w.name}</span>
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-start gap-2 text-[11px] leading-4 text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>场景激活后会复制为当前对话的独立工作模式；你在这里调整技能和工作流，只影响这个对话。</span>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════
// UI 块系统提示 — 教会 AI 何时输出交互式 UI 组件
// ═══════════════════════════════════════════════════════════════════
// 🔴 强制指令 — 放在 systemPrompt 最前面，确保 LLM 不会忽略
const UI_IMPERATIVE = `【必须遵守】当回复需要用户做选择/确认/上传文件时，必须使用 ui 代码块：
- 需要选择 → \`\`\`ui:choices {"options":[{"label":"选项","value":"动作"}]}\`\`\`
- 需要上传文件 → \`\`\`ui:upload {"slots":[{"label":"备注","accept":"image/*"}]}\`\`\`
- 提供快捷操作 → \`\`\`ui:quick-replies {"replies":[{"label":"继续","value":"继续"}]}\`\`\`
禁止使用纯 Markdown 列表（1. 2. 3.）来让用户选择。`;

const UI_BLOCKS_SYSTEM_PROMPT = `## 交互式 UI 组件详细参考

你可以在回复中使用特殊的代码块来创建交互式 UI 组件，提升用户体验。

### 快捷选项（choices）
当你想让用户从几个选项中选择时，使用 \`\`\`ui:choices 块。
适用于：询问偏好、提供下一步操作选项、需要用户确认的场景。

\`\`\`ui:choices
{
  "question": "你想分析哪个维度的数据？",
  "options": [
    {"label": "销售额趋势", "value": "分析销售额趋势"},
    {"label": "库存周转率", "value": "分析库存周转率"},
    {"label": "客户留存", "value": "分析客户留存率"}
  ]
}
\`\`\`

- question: 可选，显示在选项上方的提示文字
- options: 必填，每个选项包含 label（显示文字）和 value（用户选择后自动发送的消息）
- 如需多选，添加 "multiSelect": true

### 文件上传（upload）⭐ 重要
当需要用户上传文件才能继续时，使用 \`\`\`ui:upload 块。
用户点击上传区域选择文件后，文件会自动上传到云端存储，然后自动提交给你进行分析。
适用于：要求用户提供送货单图片、Excel报表、PDF合同等需要文件后才能处理的场景。

\`\`\`ui:upload
{
  "question": "请上传以下文件，我将自动验证是否合格",
  "slots": [
    {"label": "送货单图片", "accept": "image/*", "hint": "支持JPG/PNG"},
    {"label": "台账模板", "accept": ".xlsx,.xls", "hint": "Excel格式"}
  ],
  "autoPrompt": "请分析这些上传的文件，验证送货单和台账模板是否合格"
}
\`\`\`

字段说明：
- question: 可选，显示在上传区域上方的提示
- slots: 必填，需要上传的文件槽位列表
  - label: 文件槽位名称
  - accept: 接受的文件类型（如 "image/*"、".xlsx,.xls"、".pdf"）
  - required: 是否必填（默认 true）
  - hint: 辅助提示文字（如 "支持JPG/PNG"）
- autoPrompt: 可选，上传完成后自动发送给 AI 的分析指令（不填则默认"请分析这些文件"）

使用规则：
- 仅在确实需要用户上传文件时使用！不要为纯文本问答场景创建上传组件
- 用户点击上传区选择文件即可，系统会自动处理上传和提交
- 不要让用户自行通过对话窗口上传，直接用 ui:upload 组件

### 快捷回复（quick-replies）
在回答末尾提供后续操作按钮，让用户可以一键继续对话。每个消息最多使用一次。

\`\`\`ui:quick-replies
{
  "replies": [
    {"label": "详细分析", "value": "请详细分析以上数据"},
    {"label": "导出报表", "value": "帮我导出以上数据为Excel"},
    {"label": "换一个角度", "value": "换个角度分析"}
  ]
}
\`\`\`

### 使用原则
1. 仅在有明确需求时使用，不要滥用
2. 需要文件处理时用 ui:upload，比让用户自行上传体验更好
3. choices 适用于需要用户选择的场景，quick-replies 适用于提供后续操作建议
4. 简洁明了，options/replies 不超过 5 个，slots 不超过 4 个
5. 先给出分析或说明文字，再放 UI 组件
6. quick-replies 应放在回复的最末尾`

interface ChatPageProps {
  onOpenAdmin: () => void
  onOpenSettings: () => void
  onOpenSubscription: () => void
  onOpenSkillStore: () => void
  onNavigate?: (view: MainView) => void
  onViewTimeline?: () => void
}

const WORKFLOW_EXECUTION_POLL_INTERVAL_MS = 1600
const WORKFLOW_EXECUTION_POLL_LIMIT = 45

const sleep = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))

function safeJsonPreview(raw?: string, maxLength = 1200) {
  if (!raw || !raw.trim()) return ''
  let text = raw.trim()
  try {
    text = JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    // Keep non-JSON workflow output readable as-is.
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}\n...` : text
}

function formatWorkflowArtifactSize(size?: number | null) {
  if (size == null || Number.isNaN(size)) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

async function waitForWorkflowExecution(executionId: number, initial?: ExecutionVO) {
  let latest = initial
  for (let i = 0; i < WORKFLOW_EXECUTION_POLL_LIMIT; i += 1) {
    if (latest && latest.status !== 'running') return latest
    await sleep(WORKFLOW_EXECUTION_POLL_INTERVAL_MS)
    latest = await workflowApi.executionDetail(executionId)
  }
  return latest
}

function buildWorkflowExecutionMessage(workflowName: string, exec?: ExecutionVO, artifacts: WorkflowArtifactVO[] = []) {
  if (!exec) {
    return `工作流「${workflowName}」仍在执行中，稍后可在工作流执行记录中查看结果。`
  }

  const statusText: Record<ExecutionVO['status'], string> = {
    running: '仍在执行',
    success: '执行成功',
    failed: '执行失败',
    cancelled: '已取消',
  }
  const lines = [
    `工作流「${workflowName}」${statusText[exec.status] || exec.status}。`,
  ]

  if (typeof exec.durationMs === 'number' && exec.durationMs >= 0) {
    lines.push(`耗时：${exec.durationMs}ms`)
  }
  if (exec.errorMsg) {
    lines.push(`错误：${exec.errorMsg}`)
  }

  const output = safeJsonPreview(exec.outputJson)
  const steps = safeJsonPreview(exec.stepResults, 1600)
  if (output) {
    lines.push(`输出：\n\`\`\`json\n${output}\n\`\`\``)
  } else if (steps) {
    lines.push(`步骤结果：\n\`\`\`json\n${steps}\n\`\`\``)
  }

  lines.push('结果已写入本对话记忆和工作文件，后续对话可引用。')
  if (artifacts.length > 0) {
    const artifactLines = artifacts.slice(0, 8).map((artifact) => {
      const name = artifact.fileName || artifact.uuid || `artifact-${artifact.id}`
      const meta = [artifact.fileType, formatWorkflowArtifactSize(artifact.fileSize), artifact.stepId ? `step:${artifact.stepId}` : '']
        .filter(Boolean)
        .join(' / ')
      const ref = artifact.ossUrl || (artifact.uuid ? `artifactUuid: ${artifact.uuid}` : '')
      return `- ${name}${meta ? ` (${meta})` : ''}${ref ? `\n  ${ref}` : ''}`
    })
    if (artifacts.length > 8) {
      artifactLines.push(`- 其余 ${artifacts.length - 8} 个产物可在工作流执行详情中查看`)
    }
    lines.push(`执行产物：\n${artifactLines.join('\n')}`)
  }

  return lines.join('\n\n')
}

export default function ChatPage({ onOpenAdmin, onOpenSettings, onOpenSubscription, onOpenSkillStore, onNavigate, onViewTimeline }: ChatPageProps) {
  const { user, updateUser } = useAuthStore()

  // ✅ 精准 selector：元数据和消息数组分离，避免高频变化触发全量重渲染
  const activeConversationId = useChatStore(s => s.activeConversationId)

  // 元数据 selector：仅在 title/model/pinned 等低频字段变化时重渲染
  type ActiveMeta = { id: string; title: string; model: string; pinned: boolean; createdAt: string } | null
  const activeMeta = useChatStore(useShallow((s) => {
    const c = s.conversations.find(c => c.id === s.activeConversationId)
    if (!c) return null
    return { id: c.id, title: c.title, model: c.model, pinned: !!c.pinned, createdAt: c.createdAt }
  }))

  // 🔧 messages 独立 selector：流式时高频变化，但只有真正依赖的组件订阅
  const EMPTY_MESSAGES: Message[] = []
  const activeMessages = useChatStore((s) => {
    const c = s.conversations.find(c => c.id === s.activeConversationId)
    return c ? c.messages : EMPTY_MESSAGES
  })

  const { createConversation, setActiveConversation,
    addMessage, updateMessage, deleteConversation, updateConversation,
    selectedModel, modelSettings, setModelSettings, activeAgent, setActiveAgent,
    activeScenario, setActiveScenario,
    activeSkillIds, setActiveSkillIds, thinkEnabled } = useChatStore()

  // 🔴 OOM 防御 — 浏览器端内存监控（每 10 秒检查一次，75%/85%/90% 阈值告警）
  useMemoryMonitor(true)
  useAvailableModels()

  const { models } = useAdminStore()
  // 当前选中模型的显示名（Auto 显示为 "Auto"，其他从 models 表找）
  const currentModelName = selectedModel === 'auto'
    ? 'Auto'
    : models.find(m => m.id === selectedModel)?.name || selectedModel

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [modelPanelOpen, setModelPanelOpen] = useState(false)
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false)
  const [memoryContextOpen, setMemoryContextOpen] = useState(false)
  const [scenarioWorkspaceCollapsed, setScenarioWorkspaceCollapsed] = useState(false)
  const [availableWorkflows, setAvailableWorkflows] = useState<WorkflowBriefVO[]>([])
  const [executingWorkflowId, setExecutingWorkflowId] = useState<number | null>(null)
  const [isGenerating, setIsGenerating] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [hasStartedChat, setHasStartedChat] = useState(false)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const isNearBottomRef = useRef(true)  // ref 版本避免 rAF 闭包过期
  const [clearConfirm, setClearConfirm] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // 🧠 Phase 1: 对话运行时动态干预 — 消息队列
  // 当 AI 正在生成时，用户新发送的消息进入队列，等当前回复完成后自动发送
  // 这是"输入框永远不锁定"理念的前端实现
  // continueMessageId: 如果设置，表示这是一条内联继续对话消息（通过 handleContinueInPlace 发送）
  const [pendingMessages, setPendingMessages] = useState<{ content: string; files?: FileAttachment[]; continueMessageId?: string }[]>([])
  // ref 版本：供 useCallback 内部读取最新队列（避免闭包陷阱）
  const pendingMessagesRef = useRef<{ content: string; files?: FileAttachment[]; continueMessageId?: string }[]>([])
  useEffect(() => { pendingMessagesRef.current = pendingMessages }, [pendingMessages])

  // 🧠 Phase 2: 智能抢占 — 当方向一致性 < 0.3 时自动抢占，0.3-0.7 需用户确认
  // preemptConfirmData 非空时显示确认对话框
  const [preemptConfirmData, setPreemptConfirmData] = useState<{
    content: string
    files?: FileAttachment[]
    decision: InterventionDecision
  } | null>(null)
  // 标记正在执行抢占（防止 finally 块的队列消费重复发送）
  const preemptingRef = useRef(false)

  // 简单滚动方案的滚动容器 ref
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)
  // 🧠 Phase 1: 动态干预 — isGenerating 的 ref 版本，供 useCallback 读取最新值
  const isGeneratingRef = useRef(false)
  // 虚拟滚动：是否还有更早的消息、是否正在加载
  const [hasOlderMessages, setHasOlderMessages] = useState(true)
  const [loadingOlder, setLoadingOlder] = useState(false)

  // 🔧 LobeChat 流式渲染优化：本地流式内容缓冲（避免频繁 store 更新）
  // 核心思路：流式期间内容存本地 state，只定期同步到 store
  // 这样 SSE 事件再快也不会触发 React 高频重渲染
  const [streamingBuffers, setStreamingBuffers] = useState<Record<string, string>>({})
  // 🔧 Ref 镜像：供 useCallback 读取最新值，避免将 streamingBuffers 放入依赖数组
  // （streamingBuffers 每个token都变化，放入依赖会导致 handleSend 高频重建）
  const streamingBuffersRef = useRef<Record<string, string>>({})
  const streamingSyncTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 🧠 内联继续对话：当前正在内联生成的 AI 消息 ID（控制 InlineInput ↔ InlineGeneratingIndicator 切换）
  const [inlineGeneratingMsgId, setInlineGeneratingMsgId] = useState<string | null>(null)
  // handleContinueInPlace 的 ref 镜像 — 供 handleSend 的 finally 块调用（避免循环依赖）
  const handleContinueInPlaceRef = useRef<((msgId: string, content: string) => Promise<void>) | null>(null)

  // 🔧 使用 startTransition 标记流式更新为非紧急（优先响应用户输入）
  const [isTransitionPending, startTransition] = useTransition()

  const clearStreamingBuffer = useCallback((msgId: string) => {
    streamingBuffersRef.current = (() => {
      const { [msgId]: _, ...rest } = streamingBuffersRef.current
      return rest
    })()
    setStreamingBuffers(prev => {
      const { [msgId]: _, ...rest } = prev
      return rest
    })
  }, [])

  const flushActiveStreamingMessage = useCallback((fallbackContent = '已停止生成。') => {
    const convId = activeConversationId
    if (!convId) return null
    const conv = useChatStore.getState().conversations.find(c => c.id === convId)
    const streamingMsg = conv?.messages.find(m => m.isStreaming)
    if (!streamingMsg) return null

    const bufferedContent = streamingBuffersRef.current[streamingMsg.id] ?? streamingMsg.content ?? ''
    const finalContent = bufferedContent.trim() ? bufferedContent : fallbackContent
    startTransition(() => {
      useChatStore.getState().updateMessage(convId, streamingMsg.id, {
        content: finalContent,
        isStreaming: false,
        preempted: false,
      } as Partial<Message>)
    })
    clearStreamingBuffer(streamingMsg.id)
    if (streamingSyncTimerRef.current) {
      clearInterval(streamingSyncTimerRef.current)
      streamingSyncTimerRef.current = null
    }
    return streamingMsg.id
  }, [activeConversationId, clearStreamingBuffer])

  useEffect(() => {
    if (!activeScenario || DEMO_MODE) return
    workflowApi.list()
      .then(setAvailableWorkflows)
      .catch(e => console.warn('[ScenarioWorkflow] 加载工作流失败:', e))
  }, [activeScenario?.id])

  // 🔧 LobeChat 优化：流式更新回调（接入 startTransition）
  // 优化策略：内容更新先缓冲到 streamingBuffers（避免频繁 store 更新），流式结束再同步
  const streamingUpdate = useCallback((msgId: string, updates: Record<string, unknown>) => {
    // 内容更新 → 缓冲到本地 state + ref（不触发 store 更新）
    if (updates.content && typeof updates.content === 'string') {
      const newContent = updates.content as string
      // 同步更新 ref（供 handleSend 的抢占决策读取最新值）
      streamingBuffersRef.current = { ...streamingBuffersRef.current, [msgId]: newContent }
      // 节流更新 state：只在内容变化超过 5 字符或距上次更新超过 30ms 时才 setState
      // 避免每个 token 都触发 React re-render
      setStreamingBuffers(prev => {
        const prevContent = prev[msgId] || ''
        // 内容相同则跳过
        if (prevContent === newContent) return prev
        return { ...prev, [msgId]: newContent }
      })
    }
    // 流式结束 → 立即同步缓冲区到 store（确保最终一致性）
    if (updates.isStreaming === false) {
      const buffered = streamingBuffersRef.current[msgId]
      if (buffered) {
        // 用缓冲区内容更新 store
        startTransition(() => {
          useChatStore.getState().updateMessage(activeConversationId!, msgId, { ...updates, content: buffered } as Partial<Message>)
        })
        // 清除该消息的缓冲区（state + ref）
        streamingBuffersRef.current = (() => {
          const { [msgId]: _, ...rest } = streamingBuffersRef.current
          return rest
        })()
        setStreamingBuffers(prev => {
          const { [msgId]: _, ...rest } = prev
          return rest
        })
      } else {
        // 无缓冲区，直接同步 updates
        startTransition(() => {
          useChatStore.getState().updateMessage(activeConversationId!, msgId, updates as Partial<Message>)
        })
      }
      // 🛡️ 兜底：清除同步定时器
      if (streamingSyncTimerRef.current) {
        clearInterval(streamingSyncTimerRef.current)
        streamingSyncTimerRef.current = null
      }
    }
    // 其他更新（tool_calls、tokens 等）→ 立即同步到 store
    if (!updates.content && updates.isStreaming !== false) {
      startTransition(() => {
        useChatStore.getState().updateMessage(activeConversationId!, msgId, updates as Partial<Message>)
      })
    }
  }, [activeConversationId])

  // 🔧 LobeChat 优化：切换对话时清除流式缓冲区（避免旧缓冲区干扰新对话）
  useEffect(() => {
    setStreamingBuffers({})
    streamingBuffersRef.current = {}
    // 🛡️ 清除兜底同步定时器
    if (streamingSyncTimerRef.current) {
      clearInterval(streamingSyncTimerRef.current)
      streamingSyncTimerRef.current = null
    }
  }, [activeConversationId])

  // activeMeta / activeMessages 已通过 zustand selector 获取（见上方），无需再次 find
  const currentModel = models.find((m) => m.id === selectedModel)

  // ✅ 顶层计算：避免在条件 JSX 中调用 hook
  const allMessages: Message[] = activeMessages
  const showMessagesArea = allMessages.length > 0 || isGenerating || hasStartedChat

  // 消息计数：用于滚动依赖，避免每次内容变化都触发重渲染
  const messageCount = allMessages.length

  // 只渲染最后 N 条消息，超出部分丢弃（内存控制）
  // 🔴 OOM 防御 — 第35轮：降到15，配合三级渲染策略（仅5条完整渲染）
  const MAX_RENDER = 15
  const displayMessages = useMemo(() => allMessages.slice(-MAX_RENDER), [allMessages])

  const loadAbortRef = useRef<AbortController | null>(null)

  // 切换对话时重置 hasStartedChat、hasOlderMessages 并清理缓存
  useEffect(() => {
    setHasStartedChat(false)
    setHasOlderMessages(true)
    clearMessageCaches()  // 清理截断缓存和 marked 解析缓存
  }, [activeConversationId])

  // 从后端加载当前对话消息（消息不再存 localStorage）
  useEffect(() => {
    if (DEMO_MODE || !activeConversationId) return
    // 跳过临时本地 ID（以 conv_ 开头的尚未同步到后端）
    if (activeConversationId.startsWith('conv_')) return
    // 只有消息为空时才加载（避免重复请求）
    if (activeMessages.length > 0) return
    // 检查是否是"旧对话被重新打开"
    if (activeMeta?.createdAt) {
      const createdAgo = Date.now() - new Date(activeMeta.createdAt).getTime()
      if (createdAgo < 3000) return
    }
    // 🔧 取消上一次 in-flight 请求
    loadAbortRef.current?.abort()
    const ac = new AbortController()
    loadAbortRef.current = ac
    loadConversationMessages(activeConversationId, 50, ac.signal).catch((e: any) => {
      if (e?.name !== 'AbortError') console.warn('[loadConversationMessages] failed:', e)
    })
    return () => ac.abort()
  }, [activeConversationId, activeMeta?.createdAt, activeMessages.length])

  // 组件卸载时清理 AbortController 防止 SSE 连接泄漏 + load 请求
  useEffect(() => {
    return () => {
      abortRef.current = true
      abortControllerRef.current?.abort()
      loadAbortRef.current?.abort()
      // 🛡️ 清除兜底同步定时器
      if (streamingSyncTimerRef.current) {
        clearInterval(streamingSyncTimerRef.current)
        streamingSyncTimerRef.current = null
      }
    }
  }, [])

  // 挂载时刷新用户信息（同步 modelLimit 等订阅数据）
  useEffect(() => {
    if (DEMO_MODE) return
    authApi.getMe().then(u => {
      updateUser({
        tokensUsed: u.tokensUsed,
        tokensLimit: u.tokensLimit,
        plan: u.plan,
        modelLimit: (u as any).modelLimit,
      })
    }).catch(() => {})
  }, [])

  const handleScenarioWorkflowExecute = useCallback(async (
    workflow: { id: number; name: string; description?: string; status?: string },
    autoBind = false,
  ) => {
    const conversationId = activeConversationId
    if (!activeScenario || !conversationId) {
      toast.error('请先进入场景对话后再执行工作流')
      return
    }
    setExecutingWorkflowId(workflow.id)
    try {
      const exec = await workflowApi.execute(workflow.id, {
        _scenarioContext: {
          conversationUuid: activeConversationId,
          scenarioId: activeScenario.id,
          scenarioName: activeScenario.name,
          autoBindToConversation: autoBind,
        },
      })
      const current = useChatStore.getState().conversations.find(c => c.id === conversationId)
      const existingWorkflows = activeScenario.workflowTemplates || []
      const nextWorkflows = existingWorkflows.some(w => w.id === workflow.id)
        ? existingWorkflows
        : [...existingWorkflows, {
            id: workflow.id,
            name: workflow.name,
            description: workflow.description,
            status: workflow.status,
          }]
      const nextScenario = {
        ...activeScenario,
        workflowTemplates: nextWorkflows,
        workflowCount: nextWorkflows.length,
      }
      const nextTags = [...new Set([...(current?.tags || []), buildScenarioWorkflowTag(workflow.id)])]
      updateConversation(conversationId, {
        tags: nextTags,
        activeScenario: nextScenario,
        scenarioWorkflowIds: nextWorkflows.map(w => w.id),
      })
      setActiveScenario(nextScenario)
      try {
        await chatApi.updateConversation(conversationId, { tags: nextTags })
      } catch (e) {
        console.warn('[ScenarioWorkflow] 保存对话工作流标签失败:', e)
      }
      addMessage(conversationId, {
        id: `workflow-${exec.id}-${Date.now()}`,
        role: 'system',
        content: `工作流「${workflow.name}」已开始执行，结果会写入本对话记忆和工作文件。`,
        timestamp: new Date().toISOString(),
      })
      toast.success(`已开始执行工作流：${workflow.name}`)

      const finalExec = await waitForWorkflowExecution(exec.id, exec)
      const artifacts = finalExec
        ? await workflowArtifactApi.list({ executionId: finalExec.id }).catch(() => [])
        : []
      addMessage(conversationId, {
        id: `workflow-result-${exec.id}-${Date.now()}`,
        role: 'system',
        content: buildWorkflowExecutionMessage(workflow.name, finalExec, artifacts),
        timestamp: new Date().toISOString(),
      })
      if (finalExec?.status === 'success') {
        toast.success(`工作流执行完成：${workflow.name}`)
      } else if (finalExec?.status === 'failed') {
        toast.error(`工作流执行失败：${workflow.name}`)
      }
    } catch (e: any) {
      toast.error(e?.message || '工作流执行失败')
    } finally {
      setExecutingWorkflowId(null)
    }
  }, [activeScenario, activeConversationId, updateConversation, setActiveScenario, addMessage])

  const handleSend = useCallback(async (content: string, files?: FileAttachment[]) => {
    // 🧠 Phase 2: 智能抢占 — 如果正在生成，根据方向一致性决策排队/抢占/确认
    if (isGeneratingRef.current) {
      // 获取当前流式输出的内容（从 ref 中提取，避免依赖 streamingBuffers state）
      const buffers = streamingBuffersRef.current
      const currentStreamingText = Object.values(buffers).join('') || ''

      // 方向一致性分析
      const decision = decideIntervention(content, currentStreamingText)

      if (decision.strategy === 'queue') {
        // 方向一致 → 排队等待（同 Phase 1）
        setPendingMessages(prev => {
          const updated = [...prev, { content, files }]
          pendingMessagesRef.current = updated  // 直接同步 ref
          return updated
        })
        return
      }

      if (decision.strategy === 'preempt') {
        // 🧠 方向不同 → 抢占当前回复，但通过 continueMessageId 在同一消息上继续
        // 1. 找到当前正在流式的 AI 消息
        const convId = activeConversationId
        let streamingMsgId: string | null = null
        if (convId) {
          const conv = useChatStore.getState().conversations.find(c => c.id === convId)
          const streamingMsg = conv?.messages.find(m => m.isStreaming)
          if (streamingMsg) {
            streamingMsgId = streamingMsg.id
            // 获取缓冲区中的最终内容
            const bufferedContent = streamingBuffersRef.current[streamingMsg.id] || streamingMsg.content
            // 🧠 自然断点分割：计算 splitPoint（优先段落分隔 → 句子结束 → 换行 → 兜底）
            const splitPoint = findSplitPoint(bufferedContent)
            const validOutput = bufferedContent.slice(0, splitPoint)
            const discardedContent = bufferedContent.slice(splitPoint)
            // 标记被中断的 AI 消息 — 保留有效输出，废弃内容以灰色显示
            startTransition(() => {
              useChatStore.getState().updateMessage(convId, streamingMsg.id, {
                isStreaming: false,
                preempted: true,
                directionChanged: true,
                content: validOutput,
                splitPoint,
                discardedContent: discardedContent || undefined,
              } as Partial<Message>)
            })
            // 清除该消息的缓冲区（state + ref）
            streamingBuffersRef.current = (() => {
              const { [streamingMsg.id]: _, ...rest } = streamingBuffersRef.current
              return rest
            })()
            setStreamingBuffers(prev => {
              const { [streamingMsg.id]: _, ...rest } = prev
              return rest
            })
          }
        }
        // 2. 将新消息插入队列头部 — 使用 continueMessageId 让 finally 块走 handleContinueInPlace
        //    这样新内容会追加到当前 AI 消息元素上，而非创建全新的消息对
        pendingMessagesRef.current = [{ content, files, continueMessageId: streamingMsgId || undefined }, ...pendingMessagesRef.current]
        setPendingMessages(pendingMessagesRef.current)
        // 3. 标记正在抢占（防止 finally 块跳过队列消费）
        preemptingRef.current = true
        // 4. 中止当前请求
        abortRef.current = true
        abortControllerRef.current?.abort()
        // finally 块会处理队列消费，走 handleContinueInPlace（因有 continueMessageId）
        return
      }

      if (decision.strategy === 'speculative_parallel') {
        // 🧠 投机双轨策略：进度 > 80%，让当前生成完成，排队新方向
        // 不抢占当前生成 — finally 块会在当前生成完成后自动发送排队消息
        setPendingMessages(prev => {
          const updated = [...prev, { content, files }]
          pendingMessagesRef.current = updated
          return updated
        })
        return
      }

      // strategy === 'confirm' → 弹出确认对话框
      setPreemptConfirmData({ content, files, decision })
      return
    }

    // ── 提前计算 currentAgentId（创建对话时需要传入）──
    const state = useChatStore.getState()
    const skillAgentId = state.activeSkillIds.length > 0 ? state.activeSkillIds[0] : undefined
    let currentAgentId = state.activeAgent?.id?.startsWith('server:') ? state.activeAgent.id.replace('server:', '') :
                           state.activeAgent?.agentType === 'ban_biao' ? 'ban-biao' :
                           state.activeAgent?.id === 'ban-biao' ? 'ban-biao' :
                           skillAgentId

    // Agent 模式下自动启用深度思考（后端会在 Agent 分支自动传入 thinking 参数）
    let autoMatchedSkill: { agentId: string; name: string } | null = null
    if (!currentAgentId && !DEMO_MODE) {
      try {
        const matchTimeoutMs = activeConversationId ? 800 : 350
        const decision = await withTimeout(
          agentRegistryApi.autoMatchSkill(content, activeConversationId || undefined),
          matchTimeoutMs,
        )
        if (decision?.useSkill && decision.bestMatch?.agentId) {
          autoMatchedSkill = {
            agentId: decision.bestMatch.agentId,
            name: decision.bestMatch.name || decision.bestMatch.agentId,
          }
          currentAgentId = autoMatchedSkill.agentId
          toast.info(`已自动选择技能：${autoMatchedSkill.name}`)
        }
      } catch (e) {
        console.warn('[SkillAutoMatch] 自动匹配失败:', e)
      }
    }
    const conversationSkillIds = autoMatchedSkill ? [autoMatchedSkill.agentId] : activeSkillIds

    const effectiveThinking = currentAgentId ? true : (thinkEnabled || undefined)

    let convId = activeConversationId
    if (!convId) {
      const title = content.slice(0, 40) || '新对话'
      if (DEMO_MODE) {
        // Demo 模式：本地创建对话
        convId = createConversation(title)
      } else {
        // 生产模式：先在后端创建对话，拿到真实 ID 后再继续
        try {
          const created = await chatApi.createConversation({
            title,
            model: selectedModel,
            agentId: currentAgentId || undefined,
            systemPrompt: activeScenario?.systemPrompt || undefined,
            tags: activeScenario ? [`scenario:${activeScenario.id}`] : undefined,
          })
          convId = created.id
        // 写入本地 store
        const { conversations: allConvs } = useChatStore.getState()
        useChatStore.setState({
          conversations: [{
            id: convId,
            title: created.title || title,
            model: selectedModel,
            messages: [],
            createdAt: created.createdAt || new Date().toISOString(),
            updatedAt: created.updatedAt || new Date().toISOString(),
            tags: created.tags || (activeScenario ? [`scenario:${activeScenario.id}`] : undefined),
            activeScenario,
            activeSkillIds: conversationSkillIds,
            scenarioSkillIds: activeScenario?.recommendedSkills || [],
            scenarioWorkflowIds: activeScenario?.workflowTemplates?.map(w => w.id) || [],
          }, ...allConvs],
            activeConversationId: convId,
          })
        } catch (e) {
          console.error('[handleSend] createConversation failed:', e)
          alert('创建对话失败：' + ((e as any).message || '未知错误'))
          return
        }
      }
    }

    if (!convId) {
      console.error('[handleSend] convId is still empty after creation!')
      alert('对话创建异常，请刷新页面重试')
      return
    }

    const optimisticFiles = files?.map(f => ({
      ...f,
      content: (f.isBinary || f.type?.startsWith('image/'))
        ? undefined
        : ((f.content?.length || 0) > 200 * 1024 ? '' : f.content),
    }))
    addMessage(convId, {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      role: 'user',
      content,
      timestamp: new Date().toISOString(),
      files: optimisticFiles,
    })

    setIsGenerating(true)
    isGeneratingRef.current = true
    setIsTyping(true)
    setHasStartedChat(true)
    abortRef.current = false
    // 创建新的 AbortController，用于中止本次流式请求
    abortControllerRef.current?.abort() // 先中止上一个（如果有）
    abortControllerRef.current = new AbortController()

    const model = useChatStore.getState().selectedModel
    // 🔧 使用 ?? 确保系统提示词不为 undefined（Agent 可能没有配置 systemPrompt）
    const modelSettingsPrompt = useChatStore.getState().modelSettings.systemPrompt || ''
    const baseSystemPrompt = activeAgent?.systemPrompt || modelSettingsPrompt

    // ── 1. 插件预处理（preprocessMessage 钩子） ────────────────
    const { plugins } = useAdminStore.getState()
    const installedPluginIds = plugins.filter(p => p.installed).map(p => p.id)
    const { processedContent, pluginExtras } = await runPluginPreprocess(
      content, installedPluginIds, convId!
    ).then(r => ({ processedContent: r.processedMessage, pluginExtras: r.extras }))

    // ── 2. 构建 systemPrompt（🔴 UI 强制指令置顶 + MCP 工具描述 + 插件提示 + UI 详细参考） ────
    const enabledMCPs = useChatStore.getState().mcpServices.filter(s => s.enabled)
    const mcpToolsPrompt = buildToolsSystemPrompt(enabledMCPs)
    const extras: string[] = []
    if (mcpToolsPrompt) extras.push(mcpToolsPrompt)
    if (pluginExtras.length > 0) extras.push(pluginExtras.join('\n\n'))
    extras.push(VISUAL_RESPONSE_SYSTEM_PROMPT)
    extras.push(UI_BLOCKS_SYSTEM_PROMPT)

    let systemPrompt = baseSystemPrompt
    if (extras.length > 0) {
      systemPrompt = baseSystemPrompt
        ? `${baseSystemPrompt}\n\n${extras.join('\n\n')}`
        : extras.join('\n\n')
    }
    // 🔴 把 UI 强制指令放在最前面（primacy bias：LLM 最关注开头内容）
    systemPrompt = UI_IMPERATIVE + '\n\n' + systemPrompt

    try {
      let finalContent = processedContent

      // ── 构建文件信息（将附件内容注入到发送内容中） ──
      // 🔧 OOM 修复：文件内容大小限制，防止 10MB 文本文件→500MB store 爆炸
      const MAX_INJECT_FILE_CHARS = 4000   // 单文件截断到 4KB
      const MAX_INJECT_TOTAL_CHARS = 12000  // 一条消息总注入上限 12KB
      function truncateHead(s: string, max: number): string {
        if (s.length <= max) return s
        return s.slice(0, max) + `\n\n[... 已截断，原文件共 ${s.length} 字符 ...]`
      }

      const uploadedLedgerPaths: { name: string; path: string }[] = []
      const fileUrls: string[] = []
      const fileInfoParts: string[] = []
      let injectedTotal = 0

      // ── 处理所有文件附件（含 content 的传统文件和仅 ossUrl 的 UI 上传文件）──
      const allFiles = files || []
      for (const f of allFiles) {
        // ── 图片文件 ──
        if (f.type.startsWith('image/')) {
          // OSS URL 收集（优先）
          if (f.ossUploadStatus === 'success' && f.ossUrl) {
            fileUrls.push(f.ossUrl)
          }
          // Agent 模式下额外上传到服务器，让工具可通过路径读取
          if (activeAgent) {
            let uploadedToLedger = false
            try {
              const uploadFile = await getFileFromSource(f)
              if (uploadFile) {
                const result = await uploadLedgerFile(uploadFile, 'image')
                uploadedLedgerPaths.push({ name: f.name, path: result.file_path })
                fileInfoParts.push(`\n\n[已上传图片: ${f.name}，服务器路径: ${result.file_path}]`)
                uploadedToLedger = true
              }
            } catch (e) {
              console.warn('上传图片到服务器失败:', f.name, e)
            }
            // 🔧 降级兜底：ledger 上传失败时，使用 OSS URL 作为备选
            if (!uploadedToLedger && f.ossUploadStatus === 'success' && f.ossUrl) {
              fileInfoParts.push(`\n\n[已上传图片: ${f.name}，图片URL: ${f.ossUrl}]`)
            }
          } else {
            // 普通模式：只告知已上传图片
            if (f.ossUploadStatus === 'success' && f.ossUrl) {
              fileInfoParts.push(`\n\n[用户已上传图片: ${f.name}]`)
            }
          }
        }
        // ── 二进制文件 ──
        else if (f.isBinary) {
          // OSS URL 收集
          if (f.ossUploadStatus === 'success' && f.ossUrl) {
            fileUrls.push(f.ossUrl)
          }
          if (activeAgent) {
            // Agent 模式：尝试上传到 ledger
            try {
              const uploadFile = await getFileFromSource(f)
              if (uploadFile) {
                const result = await uploadLedgerFile(uploadFile, f.name.match(/\.(xlsx|xls)$/i) ? 'excel' : 'other')
                uploadedLedgerPaths.push({ name: f.name, path: result.file_path })
                fileInfoParts.push(`\n\n[已上传文件: ${f.name}，服务器路径: ${result.file_path}]`)
              } else {
                // 无法获取文件内容：告知 OSS URL
                fileInfoParts.push(`\n\n[已上传文件: ${f.name}，文件URL: ${f.ossUrl || '(无)'}]`)
              }
            } catch (e) {
              console.warn('上传 ledger 文件失败:', f.name, e)
              fileInfoParts.push(`\n\n[已上传文件: ${f.name}，文件URL: ${f.ossUrl || '(无)'}]`)
            }
          } else {
            // 普通模式：告知文件信息
            fileInfoParts.push(`\n\n[用户已上传文件: ${f.name}${f.ossUrl ? '（已存储到云端）' : ''}]`)
          }
        }
        // ── 文本文件（仅处理有 content 的）──
        else if (f.content) {
          // OSS URL 收集
          if (f.ossUploadStatus === 'success' && f.ossUrl) {
            fileUrls.push(f.ossUrl)
          }
          const remaining = MAX_INJECT_TOTAL_CHARS - injectedTotal
          if (remaining <= 0) {
            fileInfoParts.push(`\n\n[文件: ${f.name} - 累计注入已达上限，已跳过]`)
            continue
          }
          const head = truncateHead(f.content, Math.min(MAX_INJECT_FILE_CHARS, remaining))
          fileInfoParts.push(`\n\n--- 文件: ${f.name} ---\n${head}`)
          injectedTotal += head.length
        }
      }

      if (fileInfoParts.length > 0) {
        finalContent += fileInfoParts.join('')
      }

      // 🔧 OOM 修复：构建文件参数，大文件 base64 不入 store
      // 图片 base64（1MB 图→1.3MB）累积 50 条 → 325MB 爆炸
      const MAX_STORED_FILE_CONTENT = 200 * 1024  // 200KB
      const fileParams = files?.map(f => {
        const isLargeContent = (f.content?.length || 0) > MAX_STORED_FILE_CONTENT
        // 图片已通过 fileUrls 传递 OSS URL 时，不再传 base64 content
        const hasOssUrl = f.type.startsWith('image/') && f.ossUploadStatus === 'success' && f.ossUrl
        return {
          name: f.name,
          type: f.type,
          content: hasOssUrl ? '' : (isLargeContent ? '' : (f.content || '')),
          isBinary: f.isBinary,
          url: f.ossUrl || f.url,     // 优先 OSS URL，降级 blob URL
          ossUrl: f.ossUrl,           // 保留 ossUrl 供消息预览使用
          size: f.size,
          ...(isLargeContent && !hasOssUrl ? { truncatedSize: MAX_STORED_FILE_CONTENT } : {}),
        }
      }) ?? []

      // ── Agent 模式：传递 agentId 给后端（已在函数开头计算）──

      // processedContent 是用户原始输入（不含注入的文件内容），用于气泡显示
      const signal = abortControllerRef.current?.signal

      // 🛡️ 兜底同步定时器：每 2 秒检查 streamingBuffersRef 是否有内容未同步到 store
      // 防止因 React 批处理或异常导致流式内容卡住不显示
      if (streamingSyncTimerRef.current) clearInterval(streamingSyncTimerRef.current)
      streamingSyncTimerRef.current = setInterval(() => {
        const buffers = streamingBuffersRef.current
        const msgIds = Object.keys(buffers)
        if (msgIds.length === 0) return
        // 检查 store 中对应消息的 isStreaming 状态
        const conv = useChatStore.getState().conversations.find(c => c.id === convId)
        if (!conv) return
        for (const msgId of msgIds) {
          const msg = conv.messages.find(m => m.id === msgId)
          // 如果消息已不在 streaming 状态但缓冲区还有内容 → 强制同步
          if (msg && !msg.isStreaming) {
            const buffered = buffers[msgId]
            if (buffered && buffered !== msg.content) {
              console.warn(`[FALLBACK-SYNC] 消息 ${msgId} 已停止流式但内容未同步，强制同步`)
              startTransition(() => {
                useChatStore.getState().updateMessage(convId!, msgId, { content: buffered })
              })
            }
            // 清除已同步的缓冲区
            streamingBuffersRef.current = (() => {
              const { [msgId]: _, ...rest } = streamingBuffersRef.current
              return rest
            })()
            setStreamingBuffers(prev => {
              if (!prev[msgId]) return prev
              const { [msgId]: _, ...rest } = prev
              return rest
            })
          }
        }
      }, 2000)

      for await (const event of sendMessage(convId!, finalContent, model, systemPrompt, fileParams, currentAgentId, uploadedLedgerPaths.map(u => u.path), processedContent, signal, fileUrls.length > 0 ? fileUrls : undefined, streamingUpdate, effectiveThinking, undefined, undefined, true)) {
        if (abortRef.current) break

        // ── Agent 工具调用事件处理 ──
        if (event.type === 'tool_call' && event.toolCallId) {
          const aiMsgId = `ai-msg-toolcall`
          // 找到当前正在流式输出的 assistant 消息，追加 toolCall 信息
          const conv = useChatStore.getState().conversations.find(c => c.id === convId)
          const currentAiMsg = conv?.messages.find(m => m.isStreaming)
          if (currentAiMsg) {
            const existing = currentAiMsg.toolCalls || []
            // 🔧 捕获值到局部变量（TypeScript 类型缩小需要在回调外捕获）
            const toolCallId = event.toolCallId
            const toolName = event.toolName || ''
            const toolArgs = event.toolArgs
            // 🔧 使用 startTransition 标记为非紧急更新
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, currentAiMsg!.id, {
                toolCalls: [...existing, {
                  toolCallId: toolCallId,
                  toolName: toolName,
                  status: 'calling' as const,
                  arguments: truncateToolArgs(toolArgs),  // OOM 防护：截断超大参数
                }]
              })
            })
          }
        }

        if (event.type === 'tool_result' && event.toolCallId) {
          // 🔧 捕获值到局部变量（TypeScript 类型缩小）
          const toolCallId = event.toolCallId
          const toolName = event.toolName || ''
          const toolResult = event.toolResult

          const conv = useChatStore.getState().conversations.find(c => c.id === convId)
          const currentAiMsg = conv?.messages.find(m => m.isStreaming)
          if (currentAiMsg) {
            // 🔧 分层截断：代码 50KB / 数据 20KB / 其他 5KB
            const truncated = truncateToolResult(toolName, toolResult)
            const updated = (currentAiMsg.toolCalls || []).map(tc =>
              tc.toolCallId === toolCallId
                ? { ...tc, status: 'completed' as const, result: truncated }
                : tc
            )
            // 🔧 使用 startTransition 标记为非紧急更新
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, currentAiMsg.id, {
                toolCalls: updated
              })
            })
          }
        }

        if (event.type === 'done') {
          setIsTyping(false)
          // ── 3. 解析 AI 回复中的工具调用请求 ────────────────────
          if (enabledMCPs.length > 0 && event.content) {
            const toolCalls = parseToolCalls(event.content)
            if (toolCalls.length > 0) {
              // 执行工具调用，结果追加到对话
              const toolResults: string[] = []
              for (const call of toolCalls) {
                const service = enabledMCPs.find(s =>
                  s.tools.some(t => t.name === call.tool)
                )
                if (service) {
                  const result = await mcpCallTool(service.endpoint, call.tool, call.params)
                  const resultText = result.content.map(c => c.text).join('\n')
                  toolResults.push(`**[${call.tool} 执行结果]**\n${resultText}`)
                }
              }
              // 如果有工具执行结果，将结果注入到下一轮对话（追加系统消息）
              if (toolResults.length > 0) {
                const toolContext = toolResults.join('\n\n')
                // 以工具结果作为新的上下文继续生成
                setIsTyping(true)
                for await (const ev2 of sendMessage(
                  convId!,
                  `基于以上工具执行结果，请整合信息给出完整回答。\n\n${toolContext}`,
                  model,
                  `${systemPrompt}\n\n以下是工具调用结果，请基于此回答用户问题：\n${toolContext}`,
                  undefined, undefined, undefined, undefined, signal, undefined, undefined, effectiveThinking
                )) {
                  if (abortRef.current) break
                  if (ev2.type === 'done' || ev2.type === 'error') setIsTyping(false)
                }
              }
            }
          }
        }
        if (event.type === 'error') {
          setIsTyping(false)
        }
      }
    } finally {
      setIsGenerating(false)
      isGeneratingRef.current = false
      setIsTyping(false)
      abortControllerRef.current = null
      // 🧠 Phase 2: 重置抢占标记
      preemptingRef.current = false
      // 🛡️ 清除兜底同步定时器
      if (streamingSyncTimerRef.current) {
        clearInterval(streamingSyncTimerRef.current)
        streamingSyncTimerRef.current = null
      }

      // 🧠 Phase 1: 动态干预 — 当前回复完成后，自动发送队列中的下一条消息
      const queue = pendingMessagesRef.current
      if (queue.length > 0) {
        const next = queue[0]
        // 移除已出队的消息（直接更新 ref 避免 useEffect 延迟）
        const rest = queue.slice(1)
        pendingMessagesRef.current = rest
        setPendingMessages(rest)
        // 异步发送，避免在 finally 块中阻塞
        // 如果有 continueMessageId，走内联继续对话；否则走正常发送
        if (next.continueMessageId && handleContinueInPlaceRef.current) {
          setTimeout(() => handleContinueInPlaceRef.current!(next.continueMessageId!, next.content), 100)
        } else {
          setTimeout(() => handleSend(next.content, next.files), 100)
        }
      }
    }
  }, [activeConversationId, createConversation, selectedModel, activeAgent, modelSettings.systemPrompt, thinkEnabled])

  // ── UI 块交互桥接函数 ──────────────────────────────────────────
  // 处理来自 UIBlockRenderer 的回调：纯文本直接发消息，带文件的构建 FileAttachment
  const handleUIAction = useCallback((payload: string | UIActionPayload) => {
    if (typeof payload === 'string') {
      handleSend(payload)
      return
    }

    // 带文件的上传结果
    const { message, files } = payload
    let fileAttachments: FileAttachment[] | undefined

    if (files && files.length > 0) {
      fileAttachments = files.map((f, i) => ({
        id: `ui-upload-${Date.now()}-${i}`,
        name: f.name,
        type: f.type,
        size: f.size,
        ossUrl: f.ossUrl,
        ossUploadStatus: 'success' as const,
        // 二进制文件标记（非图片且非文本 → isBinary）
        isBinary: !f.type.startsWith('image/') && !f.type.startsWith('text/'),
      }))
    }

    handleSend(message, fileAttachments)
  }, [handleSend])

  const handleStop = () => {
    abortRef.current = true
    abortControllerRef.current?.abort()
    flushActiveStreamingMessage()
    setIsGenerating(false)
    isGeneratingRef.current = false
    setIsTyping(false)
    // 🧠 Phase 1: 停止时清空消息队列（直接更新 ref 避免 useEffect 延迟）
    setPendingMessages([])
    pendingMessagesRef.current = []
    // 🧠 Phase 2: 清理抢占状态
    preemptingRef.current = false
    setPreemptConfirmData(null)
    // 🧠 清理内联生成状态
    setInlineGeneratingMsgId(null)
    // 🛡️ 清除兜底同步定时器
    if (streamingSyncTimerRef.current) {
      clearInterval(streamingSyncTimerRef.current)
      streamingSyncTimerRef.current = null
    }
  }

  // 🧠 Phase 2: 抢占确认 — 用户点击"抢占"按钮
  const handlePreemptConfirm = useCallback(() => {
    if (!preemptConfirmData) return
    const { content, files } = preemptConfirmData
    setPreemptConfirmData(null)

    // 🧠 自然断点分割 + continueMessageId 模式（同 handleSend preempt 分支）
    const convId = activeConversationId
    let streamingMsgId: string | null = null
    if (convId) {
      const conv = useChatStore.getState().conversations.find(c => c.id === convId)
      const streamingMsg = conv?.messages.find(m => m.isStreaming)
      if (streamingMsg) {
        streamingMsgId = streamingMsg.id
        const bufferedContent = streamingBuffersRef.current[streamingMsg.id] || streamingMsg.content
        const splitPoint = findSplitPoint(bufferedContent)
        const validOutput = bufferedContent.slice(0, splitPoint)
        const discardedContent = bufferedContent.slice(splitPoint)
        startTransition(() => {
          useChatStore.getState().updateMessage(convId, streamingMsg.id, {
            isStreaming: false,
            preempted: true,
            directionChanged: true,
            content: validOutput,
            splitPoint,
            discardedContent: discardedContent || undefined,
          } as Partial<Message>)
        })
        streamingBuffersRef.current = (() => {
          const { [streamingMsg.id]: _, ...rest } = streamingBuffersRef.current
          return rest
        })()
        setStreamingBuffers(prev => {
          const { [streamingMsg.id]: _, ...rest } = prev
          return rest
        })
      }
    }
    // 使用 continueMessageId 让 finally 块走 handleContinueInPlace
    pendingMessagesRef.current = [{ content, files, continueMessageId: streamingMsgId || undefined }, ...pendingMessagesRef.current]
    setPendingMessages(pendingMessagesRef.current)
    preemptingRef.current = true
    abortRef.current = true
    abortControllerRef.current?.abort()
    // finally 块会自动消费队列，走 handleContinueInPlace
  }, [preemptConfirmData, activeConversationId])

  // 🧠 Phase 2: 抢占取消 — 用户点击"排队"按钮，消息进入队列等待
  const handlePreemptCancel = useCallback(() => {
    if (!preemptConfirmData) return
    const { content, files } = preemptConfirmData
    setPreemptConfirmData(null)
    // 排队等待（同 Phase 1）
    setPendingMessages(prev => {
      const updated = [...prev, { content, files }]
      pendingMessagesRef.current = updated
      return updated
    })
  }, [preemptConfirmData])

  // 🧠 内联继续对话 — 用户在 AI 回复元素内的输入框中发送内容
  // 设计意图（参考研究文档 3.3 节）：
  // - 不创建新消息对，将回复内容追加到当前 AI 消息元素
  // - 携带当前上下文信息，无缝衔接对话
  // - api.ts 中 continueMessageId 模式：跳过创建新消息，预填充已有内容到 accumulated
  // - 🔥 运行时动态介入：生成中也可发送，自动抢占当前生成并排队继续
  const handleContinueInPlace = useCallback(async (currentMsgId: string, userContent: string) => {
    const convId = activeConversationId
    if (!convId) return

    // 🔥 运行时动态介入 — 如果正在生成，抢占当前生成并将内联继续加入队列
    if (isGeneratingRef.current) {
      // 将内联继续对话消息插入队列头部（finally 块会自动取出发送）
      pendingMessagesRef.current = [{ content: userContent, continueMessageId: currentMsgId }, ...pendingMessagesRef.current]
      setPendingMessages(pendingMessagesRef.current)
      // 标记正在抢占（防止 finally 块跳过队列消费）
      preemptingRef.current = true
      // 中止当前请求
      abortRef.current = true
      abortControllerRef.current?.abort()

      // 🧠 自然断点分割 — 标记被中断的 AI 消息
      const conv = useChatStore.getState().conversations.find(c => c.id === convId)
      const streamingMsg = conv?.messages.find(m => m.isStreaming)
      if (streamingMsg) {
        const bufferedContent = streamingBuffersRef.current[streamingMsg.id] || streamingMsg.content
        const splitPoint = findSplitPoint(bufferedContent)
        const validOutput = bufferedContent.slice(0, splitPoint)
        const discardedContent = bufferedContent.slice(splitPoint)
        const isSameMsg = streamingMsg.id === currentMsgId
        startTransition(() => {
          useChatStore.getState().updateMessage(convId, streamingMsg.id, {
            isStreaming: false,
            // 如果抢占的是同一个消息（用户在该消息的内联输入框中介入），不标记 preempted
            preempted: !isSameMsg,
            directionChanged: true,
            content: validOutput,
            splitPoint,
            discardedContent: discardedContent || undefined,
          } as Partial<Message>)
        })
        // 清除该消息的缓冲区（state + ref）
        streamingBuffersRef.current = (() => {
          const { [streamingMsg.id]: _, ...rest } = streamingBuffersRef.current
          return rest
        })()
        setStreamingBuffers(prev => {
          const { [streamingMsg.id]: _, ...rest } = prev
          return rest
        })
      }
      // finally 块会处理队列消费，无需手动调用 handleContinueInPlace
      return
    }

    // 设置生成状态
    setIsGenerating(true)
    isGeneratingRef.current = true
    setIsTyping(true)
    abortRef.current = false
    abortControllerRef.current = new AbortController()
    setInlineGeneratingMsgId(currentMsgId)
    const signal = abortControllerRef.current?.signal

    // 🛡️ 兜底同步定时器（同 handleSend 逻辑）
    if (streamingSyncTimerRef.current) clearInterval(streamingSyncTimerRef.current)
    streamingSyncTimerRef.current = setInterval(() => {
      const buffers = streamingBuffersRef.current
      const msgIds = Object.keys(buffers)
      if (msgIds.length === 0) return
      const conv = useChatStore.getState().conversations.find(c => c.id === convId)
      if (!conv) return
      for (const msgId of msgIds) {
        const msg = conv.messages.find(m => m.id === msgId)
        if (msg && !msg.isStreaming) {
          const buffered = buffers[msgId]
          if (buffered && buffered !== msg.content) {
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, msgId, { content: buffered })
            })
          }
          streamingBuffersRef.current = (() => {
            const { [msgId]: _, ...rest } = streamingBuffersRef.current
            return rest
          })()
          setStreamingBuffers(prev => {
            if (!prev[msgId]) return prev
            const { [msgId]: _, ...rest } = prev
            return rest
          })
        }
      }
    }, 2000)

    try {
      for await (const event of sendMessage(
        convId, userContent, selectedModel, modelSettings.systemPrompt,
        undefined, activeAgent?.id, undefined, undefined,
        signal, undefined, streamingUpdate,
        thinkEnabled, undefined, currentMsgId
      )) {
        if (abortRef.current) break

        // ── Agent 工具调用事件处理（同 handleSend） ──
        if (event.type === 'tool_call' && event.toolCallId) {
          const conv = useChatStore.getState().conversations.find(c => c.id === convId)
          const currentAiMsg = conv?.messages.find(m => m.id === currentMsgId)
          if (currentAiMsg) {
            const existing = currentAiMsg.toolCalls || []
            const toolCallId = event.toolCallId
            const toolName = event.toolName || ''
            const toolArgs = event.toolArgs
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, currentAiMsg!.id, {
                toolCalls: [...existing, {
                  toolCallId,
                  toolName,
                  status: 'calling' as const,
                  arguments: truncateToolArgs(toolArgs),
                }]
              })
            })
          }
        }

        if (event.type === 'tool_result' && event.toolCallId) {
          const toolCallId = event.toolCallId
          const toolName = event.toolName || ''
          const toolResult = event.toolResult
          const conv = useChatStore.getState().conversations.find(c => c.id === convId)
          const currentAiMsg = conv?.messages.find(m => m.id === currentMsgId)
          if (currentAiMsg) {
            const truncated = truncateToolResult(toolName, toolResult)
            const updated = (currentAiMsg.toolCalls || []).map(tc =>
              tc.toolCallId === toolCallId
                ? { ...tc, status: 'completed' as const, result: truncated }
                : tc
            )
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, currentAiMsg!.id, { toolCalls: updated })
            })
          }
        }

        if (event.type === 'error') {
          startTransition(() => {
            useChatStore.getState().updateMessage(convId!, currentMsgId, {
              error: event.content || '生成失败',
              isStreaming: false,
            } as Partial<Message>)
          })
          break
        }

        if (event.type === 'done') {
          // streamingUpdate 已处理最终内容同步（isStreaming: false → flush buffer to store）
          // 更新 thinkingContent（如果有）
          if (event.thinkingContent) {
            startTransition(() => {
              useChatStore.getState().updateMessage(convId!, currentMsgId, {
                thinkingContent: event.thinkingContent,
              } as Partial<Message>)
            })
          }
          break
        }
      }
    } catch (err) {
      startTransition(() => {
        useChatStore.getState().updateMessage(convId!, currentMsgId, {
          error: err instanceof Error ? err.message : '网络错误',
          isStreaming: false,
        } as Partial<Message>)
      })
    } finally {
      setIsGenerating(false)
      isGeneratingRef.current = false
      setIsTyping(false)
      abortControllerRef.current = null
      setInlineGeneratingMsgId(null)
      preemptingRef.current = false
      // 🛡️ 清除兜底同步定时器
      if (streamingSyncTimerRef.current) {
        clearInterval(streamingSyncTimerRef.current)
        streamingSyncTimerRef.current = null
      }
      // 消费消息队列（同 handleSend finally 块）
      const queue = pendingMessagesRef.current
      if (queue.length > 0) {
        const next = queue[0]
        const rest = queue.slice(1)
        pendingMessagesRef.current = rest
        setPendingMessages(rest)
        // 如果有 continueMessageId，走内联继续对话；否则走正常发送
        if (next.continueMessageId) {
          setTimeout(() => handleContinueInPlace(next.continueMessageId!, next.content), 100)
        } else {
          setTimeout(() => handleSend(next.content, next.files), 100)
        }
      }
    }
  }, [activeConversationId, selectedModel, activeAgent, modelSettings.systemPrompt, thinkEnabled, streamingUpdate, handleSend])

  // 🔥 同步 handleContinueInPlace 到 ref — 供 handleSend 的 finally 块调用（避免循环依赖）
  useEffect(() => {
    handleContinueInPlaceRef.current = handleContinueInPlace
  }, [handleContinueInPlace])

  const handleTranslate = useCallback(async (messageId: string, targetLang: string) => {
    const convId = useChatStore.getState().activeConversationId
    if (!convId) return
    const conv = useChatStore.getState().conversations.find(c => c.id === convId)
    const msg = conv?.messages.find(m => m.id === messageId)
    if (!msg?.content) return
    useChatStore.getState().updateMessage(convId, messageId, { translated: '翻译中...' })
    try {
      const result = await aiTranslate(msg.content, targetLang)
      useChatStore.getState().updateMessage(convId, messageId, { translated: result })
    } catch (e) {
      useChatStore.getState().updateMessage(convId, messageId, { translated: `翻译失败: ${(e as any).message}` })
    }
  }, [])

  const handleSpeak = useCallback(async (text: string, voice: string, messageId: string, channelId?: string | number) => {
    const currentSpeakingId = speakingId
    // 停止当前播放
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (currentSpeakingId === messageId) {
      setSpeakingId(null)
      return
    }
    setSpeakingId(messageId)
    try {
      const base64 = await aiTTS(text, voice, channelId || undefined)
      const audio = new Audio(`data:audio/mp3;base64,${base64}`)
      audioRef.current = audio
      audio.onended = () => { setSpeakingId(null); audioRef.current = null }
      audio.onerror = () => { setSpeakingId(null); audioRef.current = null }
      await audio.play()
    } catch (e) {
      setSpeakingId(null)
      const utterance = new SpeechSynthesisUtterance(text.replace(/[#*`]/g, '').slice(0, 500))
      utterance.lang = 'zh-CN'
      window.speechSynthesis.speak(utterance)
    }
  }, [speakingId])

  const handleStopSpeak = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
    window.speechSynthesis.cancel()
    setSpeakingId(null)
  }, [])

  /** AutoCode 嵌入卡片处理：创建任务并插入消息 */
  const handleAutoCode = async (description: string) => {
    let convId = activeConversationId
    if (!convId) {
      // 还没有对话 → 先建一个
      const title = `AutoCode: ${description.slice(0, 30)}`
      convId = createConversation(title)
    }

    const taskId = `task_${Date.now()}`
    const workspaceId = `ws_${Date.now().toString(36)}`

    // 插入 AI 消息（带 autocode 数据，渲染为卡片）
    addMessage(convId, {
      id: taskId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      model: 'AutoCode Agent',
      autocode: {
        taskId,
        workspaceId,
        title: description.slice(0, 60),
        status: 'pending',
        frontendUrl: (import.meta.env.VITE_AUTOCODE_URL as string | undefined) || 'http://localhost:3000',
      },
    })

    // 后台调用 AutoCode API（不影响 UI）
    try {
      const result = await createAutoCodeTask({
        title: description.slice(0, 60),
        description,
        project_type: 'nextjs',
        agent_types: ['frontend'],
      })
      // 更新消息中的 autocode 数据（任务 ID 和 workspace 来自真实 API）
      const msgIndex = activeMessages.findIndex(m => m.id === taskId)
      if (msgIndex !== -1 && convId) {
        updateMessage(convId, taskId, {
          autocode: {
            taskId: result.id,
            workspaceId: result.workspace_id,
            title: result.title,
            status: result.status,
            previewUrl: result.preview_url,
            frontendUrl: (import.meta.env.VITE_AUTOCODE_URL as string | undefined) || 'http://localhost:3000',
          },
        })
      }
      return {
        taskId: result.id,
        workspaceId: result.workspace_id,
        title: result.title,
        status: result.status,
        previewUrl: result.preview_url,
      }
    } catch (e) {
      // AutoCode 不可用，返回 null 降级
      console.warn('AutoCode 不可用:', e)
      return null
    }
  }

  const handleClearMessages = async () => {
    if (!activeConversationId) return
    await apiClearMessages(activeConversationId)
    updateConversation(activeConversationId, { messages: [] })
    setClearConfirm(false)
  }

  const handleDeleteConversation = async () => {
    if (activeConversationId) {
      await apiDeleteConversation(activeConversationId)
      deleteConversation(activeConversationId)
    }
    setDeleteConfirm(false)
  }

  const handleExportConversation = () => {
    if (!activeMeta) return
    const text = activeMessages
      .map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`)
      .join('\n\n---\n\n')
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${activeMeta.title}.txt`
    a.click(); URL.revokeObjectURL(url)
  }

  // ── 重试回调 ──
  const handleRetry = useCallback(() => {
    const conv = useChatStore.getState().conversations.find(c => c.id === activeConversationId)
    if (!conv) return
    const msgs = conv.messages
    for (let i = msgs.length - 1; i >= 1; i--) {
      if (msgs[i].role === 'assistant' && msgs[i - 1].role === 'user') {
        handleSend(msgs[i - 1].content, msgs[i - 1].files)
        return
      }
    }
  }, [activeConversationId, handleSend])

  // 新消息时自动滚动到底部（仅依赖数量，不依赖内容避免频繁触发）
  useEffect(() => {
    if (isGenerating || isNearBottom) {
      const el = scrollContainerRef.current
      if (el) {
        el.scrollTop = el.scrollHeight
      }
    }
  }, [messageCount, isGenerating, isNearBottom])

  // 流式输出期间持续跟随滚动（rAF 循环，不触发 React 重渲染）
  useEffect(() => {
    if (!isGenerating) return
    const el = scrollContainerRef.current
    if (!el) return
    let rafId: number
    const scroll = () => {
      // 用户上滑查看历史时停止跟随
      if (isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
      rafId = requestAnimationFrame(scroll)
    }
    rafId = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(rafId)
  }, [isGenerating])

  return (
    <div className="flex h-full bg-background overflow-hidden">
      {/* Sidebar - 桌面端直接渲染，移动端通过 mobileOpen 控制 */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
        onOpenSettings={onOpenSettings}
        onOpenAdmin={onOpenAdmin}
        mobileOpen={mobileSidebarOpen}
        onMobileClose={() => setMobileSidebarOpen(false)}
        onNavigate={(v: string) => onNavigate?.(v as MainView)}
      />

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Topbar */}
        <div className="flex items-center justify-between h-12 px-3 md:px-4 border-b bg-background/95 backdrop-blur shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* 移动端汉堡菜单 */}
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-8 md:hidden shrink-0"
              onClick={() => setMobileSidebarOpen(true)}
            >
              <Menu className="w-4 h-4" />
            </Button>

            {activeMeta ? (
              <>
                <h2 className="text-sm font-semibold truncate max-w-[160px] sm:max-w-[300px]">
                  {activeMeta.title}
                </h2>
                {activeAgent && (
                  <Badge variant="secondary" className="gap-1 shrink-0 hidden sm:flex">
                    <span>{activeAgent.icon}</span>
                    {activeAgent.name}
                  </Badge>
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm hidden sm:block">选择或新建对话</span>
                <span className="text-sm sm:hidden">AI Chat</span>
              </div>
            )}
            {/* 场景 Badge 独立于对话状态：即使无活跃对话也显示 */}
            {activeScenario && (
              <Badge variant="secondary" className="gap-1 shrink-0 hidden sm:flex">
                {activeScenario.icon && (activeScenario.icon.startsWith('http') || activeScenario.icon.startsWith('/api/'))
                  ? <img src={activeScenario.icon} alt="icon" className="w-4 h-4 rounded object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                  : <span>{activeScenario.icon || '🎯'}</span>
                }
                {activeScenario.name}
                <button
                  className="ml-0.5 hover:bg-muted rounded-full p-0.5"
                  onClick={(e) => {
                    e.stopPropagation()
                    setActiveScenario(null)
                    setModelSettings({
                      systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
                    })
                  }}
                  title="退出场景"
                >
                  <X className="w-3 h-3" />
                </button>
              </Badge>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Model indicator */}
            <button
              onClick={() => setModelPanelOpen(!modelPanelOpen)}
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-muted hover:bg-accent transition-colors"
            >
              <Cpu className="w-3.5 h-3.5 text-primary" />
              <span className="hidden sm:block max-w-[80px] truncate">{currentModelName}</span>
            </button>

            {/* 记忆状态按钮 */}
            <button
              onClick={() => setMemoryContextOpen(true)}
              className="relative flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-medium bg-muted hover:bg-accent transition-colors"
              title="查看记忆状态"
            >
              <Brain className="w-3.5 h-3.5 text-primary/70" />
            </button>

            {activeMeta && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon" variant="ghost" className="h-8 w-8">
                    <MoreHorizontal className="w-4 h-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => updateConversation(activeConversationId!, { pinned: !activeMeta.pinned })}>
                    {activeMeta.pinned ? <PinOff className="w-4 h-4 mr-2" /> : <Pin className="w-4 h-4 mr-2" />}
                    {activeMeta.pinned ? '取消置顶' : '置顶对话'}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportConversation}>
                    <Download className="w-4 h-4 mr-2" />导出对话
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => {
                    const text = activeMessages.map((m) => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content}`).join('\n\n')
                    navigator.clipboard.writeText(text)
                  }}>
                    <Share2 className="w-4 h-4 mr-2" />复制全文
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setClearConfirm(true)}>
                    <Eraser className="w-4 h-4 mr-2" />清空消息
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    className="text-destructive"
                    onClick={() => setDeleteConfirm(true)}
                  >
                    <Trash2 className="w-4 h-4 mr-2" />删除对话
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* 桌面端模型面板切换按钮 */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 hidden sm:flex"
                  onClick={() => {
                    setMemoryPanelOpen(!memoryPanelOpen)
                    if (memoryPanelOpen) setModelPanelOpen(false)
                  }}
                >
                  <FolderOpen className={cn('w-4 h-4', memoryPanelOpen && 'text-primary')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{memoryPanelOpen ? '关闭记忆' : '项目文件'}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 hidden sm:flex"
                  onClick={() => {
                    setModelPanelOpen(!modelPanelOpen)
                    if (modelPanelOpen) setMemoryPanelOpen(false)
                  }}
                >
                  {modelPanelOpen ? <PanelRightClose className="w-4 h-4" /> : <PanelRightOpen className="w-4 h-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{modelPanelOpen ? '关闭面板' : '模型设置'}</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon" variant="ghost" className="h-8 w-8" onClick={onOpenSettings}>
                  <Settings2 className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>设置</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Messages area — 简单滚动方案（移除 Virtuoso 以排查 OOM 根因） */}
        <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 flex flex-col overflow-hidden min-w-0">
            {showMessagesArea ? (
              <div className="relative flex-1 flex flex-col min-h-0">
                {/* 记忆摘要卡 - P1-4 */}
                <MemorySummaryCard onViewTimeline={onViewTimeline} />

                {activeScenario && (
                  <ScenarioWorkspaceBand
                    scenario={activeScenario}
                    selectedSkillCount={activeSkillIds.length}
                    availableWorkflows={availableWorkflows}
                    executingWorkflowId={executingWorkflowId}
                    disabled={isGenerating}
                    collapsed={scenarioWorkspaceCollapsed}
                    onToggleCollapsed={() => setScenarioWorkspaceCollapsed(v => !v)}
                    onExecuteWorkflow={handleScenarioWorkflowExecute}
                    onOpenSkillStore={onOpenSkillStore}
                    onOpenWorkflow={() => onNavigate?.('workflow')}
                    onExit={() => {
                      setActiveScenario(null)
                      setActiveSkillIds([])
                      setModelSettings({
                        systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT,
                      })
                    }}
                  />
                )}

                {/* 简单滚动容器 — 零依赖，渲染最后 100 条消息 */}
                <div
                  ref={scrollContainerRef}
                  data-chat-scroll-container="true"
                  className="chat-scroll-container mobile-scroll-bottom-safe flex-1 overflow-y-auto overflow-x-hidden px-0 sm:px-4"
                  onScroll={() => {
                    const el = scrollContainerRef.current
                    if (el) {
                      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100
                      setIsNearBottom(atBottom)
                      isNearBottomRef.current = atBottom
                    }
                  }}
                >
                  {loadingOlder && (
                    <div className="py-4 text-center text-xs text-muted-foreground animate-pulse">加载更早的消息…</div>
                  )}
                  {displayMessages.map((msg, i) => (
                    <MessageBubble
                      key={msg.id}
                      message={msg}
                      isRecent={i >= displayMessages.length - 5}
                      renderLevel={
                        i >= displayMessages.length - 5 ? 3
                        : i >= displayMessages.length - 10 ? 2
                        : 1
                      }
                      // 🔧 LobeChat 优化：传递本地流式缓冲内容（避免频繁 store 更新）
                      streamingContent={streamingBuffers[msg.id]}
                      onRetry={msg.role === 'assistant' ? handleRetry : undefined}
                      onTranslate={handleTranslate}
                      onSpeak={handleSpeak}
                      speakingId={speakingId}
                      onStopSpeak={handleStopSpeak}
                      onUIAction={handleUIAction}
                      convId={activeConversationId ?? undefined}
                      // 🧠 内联继续对话：AI 消息底部嵌入输入框
                      onContinueInPlace={msg.role === 'assistant' ? (content: string) => handleContinueInPlace(msg.id, content) : undefined}
                      inlineIsGenerating={inlineGeneratingMsgId === msg.id}
                    />
                  ))}
                  {isTyping && !displayMessages.some(m => m.isStreaming) && (
                    <TypingIndicator model={currentModelName} />
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* 回到底部按钮 */}
                {!isNearBottom && (
                  <div className="absolute bottom-24 md:bottom-2 left-1/2 -translate-x-1/2 z-10">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="rounded-full shadow-lg gap-1 px-4 py-1.5 text-xs font-medium"
                      onClick={() => {
                        const el = scrollContainerRef.current
                        if (el) {
                          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                          setIsNearBottom(true)
                        }
                      }}
                    >
                      <ChevronDown className="w-3.5 h-3.5" />
                      回到底部
                    </Button>
                  </div>
                )}
                <SkillChips
                  selectedSkillIds={activeSkillIds}
                  onSkillsChange={setActiveSkillIds}
                  disabled={isGenerating}
                  onQuickCreate={() => {
                    setActiveSkillIds(['agent-builder'])
                    handleSend('帮我创建一个新的技能')
                  }}
                  onOpenStore={onOpenSkillStore}
                />
                <ChatInput
                  conversationId={activeConversationId!}
                  onSend={handleSend}
                  isGenerating={isGenerating}
                  onStop={handleStop}
                  onAutoCode={handleAutoCode}
                  pendingCount={pendingMessages.length}
                  mobileBottomOffset="var(--mobile-nav-height)"
                />
              </div>
            ) : (
              <WelcomeScreen onSend={handleSend} onOpenSkillStore={onOpenSkillStore} onNavigate={onNavigate} />
            )}
          </div>

          {/* Model Panel - 桌面端侧边面板，移动端底部抽屉 */}
          {modelPanelOpen && (
            <ModelPanel onClose={() => setModelPanelOpen(false)} />
          )}

          {/* Memory Panel - 项目文件/记忆面板 */}
          {memoryPanelOpen && (
            <MemoryPanel onClose={() => setMemoryPanelOpen(false)} />
          )}

          {/* Memory Context Dialog - 记忆状态弹窗 */}
          <MemoryContextDialog
            open={memoryContextOpen}
            onOpenChange={setMemoryContextOpen}
            onOpenMemoryPanel={() => { setMemoryContextOpen(false); setMemoryPanelOpen(true) }}
          />
        </div>
      </div>

      {/* Clear messages confirm */}
      <Dialog open={clearConfirm} onOpenChange={setClearConfirm}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />清空消息
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">确认要清空此对话的所有消息吗？此操作无法撤销。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirm(false)}>取消</Button>
            <Button variant="destructive" onClick={handleClearMessages}>确认清空</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete conversation confirm */}
      <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <DialogContent className="max-w-sm mx-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="w-5 h-5" />删除对话
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">确认要删除"{activeMeta?.title}"吗？此操作无法撤销。</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(false)}>取消</Button>
            <Button variant="destructive" onClick={handleDeleteConversation}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 🧠 Phase 2: 抢占确认对话框 — 方向一致性模糊时让用户决策 */}
      <Dialog open={!!preemptConfirmData} onOpenChange={(open) => { if (!open) handlePreemptCancel() }}>
        <DialogContent className="max-w-md mx-4">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-500" />
              新消息与当前回复方向不完全一致
            </DialogTitle>
          </DialogHeader>
          {preemptConfirmData && (
            <div className="space-y-3">
              <div className="bg-muted/50 rounded-lg p-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">方向一致性分数</span>
                  <Badge variant="outline" className="font-mono">
                    {preemptConfirmData.decision.similarity.toFixed(2)}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {preemptConfirmData.decision.reason}
                </p>
              </div>
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800/30 rounded-lg p-3">
                <p className="text-xs text-amber-700 dark:text-amber-400 leading-relaxed">
                  <strong>抢占</strong>：立即中断当前回复，用新消息重新生成。已生成的内容会保留但标记为"已被抢占"。
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed mt-1.5">
                  <strong>排队</strong>：等当前回复完成后，自动发送新消息。
                </p>
              </div>
              <div className="rounded-lg p-3 border border-border/50">
                <p className="text-xs text-muted-foreground mb-1">新消息内容：</p>
                <p className="text-sm line-clamp-2">{preemptConfirmData.content}</p>
              </div>
            </div>
          )}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={handlePreemptCancel}>
              排队等待
            </Button>
            <Button
              variant="default"
              className="bg-amber-600 hover:bg-amber-700 text-white"
              onClick={handlePreemptConfirm}
            >
              <Zap className="w-4 h-4 mr-1" />
              抢占当前回复
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Welcome screen
function WelcomeScreen({ onSend, onOpenSkillStore, onNavigate }: { onSend: (content: string) => void; onOpenSkillStore: () => void; onNavigate?: (view: MainView) => void }) {
  const { installedSkillIds, setActiveSkillIds } = useChatStore()
  const { agents } = useAdminStore()
  const [installedSkills, setInstalledSkills] = useState<any[]>([])
  const [skillsLoading, setSkillsLoading] = useState(true)
  const [showAllSkills, setShowAllSkills] = useState(false)
  // 记忆数量
  const [memoryCount, setMemoryCount] = useState(0)

  useEffect(() => {
    agentRegistryApi.listInstalled()
      .then(skills => setInstalledSkills(skills || []))
      .catch(() => setInstalledSkills([]))
      .finally(() => setSkillsLoading(false))
  }, [installedSkillIds.length])

  // 加载记忆统计
  useEffect(() => {
    memoryApi.getContext({ convUuid: '' })
      .then((ctx) => {
        let count = 0
        if (ctx.conversationMemory) count++
        if (ctx.userProfile) count++
        setMemoryCount(count)
      })
      .catch(() => {})
  }, [])

  const handleSkillClick = (skill: any) => {
    setActiveSkillIds([skill.agentId])
    onSend(skill.description || `使用 ${skill.name} 技能`)
  }

  // 场景卡片 — 数据驱动，跳转到场景广场
  const handleOpenScenarios = () => {
    onNavigate?.('scenarios')
  }

  // 获取已经安装的特色Agent（排除通用 Agent，显示前3个）
  const featuredSkills = installedSkills.slice(0, 6)

  return (
    <div className="mobile-scroll-bottom-safe flex-1 flex flex-col items-center justify-center px-4 py-6 sm:p-8 overflow-y-auto">
      <div className="max-w-2xl w-full">

        {/* Hero */}
        <div className="text-center mb-6 sm:mb-8">
          <div className="inline-flex items-center gap-3 mb-3">
            <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg shadow-primary/20">
              <Bot className="w-8 h-8 sm:w-9 sm:h-9 text-primary-foreground" />
            </div>
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1.5">木火智能对话</h1>
          <p className="text-muted-foreground text-sm sm:text-base max-w-md mx-auto leading-relaxed">
            让 AI 成为你的专属智能工作伙伴<br />
            <span className="text-xs sm:text-sm text-muted-foreground/70">越用越懂你 · 越用越能干</span>
          </p>

          {/* Stats row */}
          <div className="flex items-center justify-center gap-3 sm:gap-6 mt-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              已装 {installedSkills.length} 个技能
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
              {memoryCount} 条记忆
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              {agents.length} 个 Agent
            </div>
          </div>
        </div>

        {/* 场景入口 — 跳转到场景广场 */}
        <div className="mb-6">
          <button
            onClick={handleOpenScenarios}
            className="w-full flex items-center justify-between p-4 sm:p-5 rounded-2xl border bg-gradient-to-br from-primary/5 via-primary/3 to-transparent border-primary/15 hover:border-primary/40 hover:shadow-md transition-all group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-sm shadow-primary/20">
                <LayoutGrid className="w-5 h-5 sm:w-6 sm:h-6 text-primary-foreground" />
              </div>
              <div className="text-left">
                <p className="text-sm sm:text-base font-semibold">场景广场</p>
                <p className="text-[11px] sm:text-xs text-muted-foreground mt-0.5">
                  选择工作场景，AI 自动配置专属助手
                </p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
          </button>
        </div>

        {/* 我的技能区域 */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              我的技能{installedSkills.length > 0 && ` (${installedSkills.length})`}
            </p>
            <div className="flex items-center gap-3">
              {installedSkills.length > 6 && (
                <button
                  onClick={() => setShowAllSkills(!showAllSkills)}
                  className="text-xs text-primary hover:underline transition-colors"
                >
                  {showAllSkills ? '收起' : `展开全部 (${installedSkills.length})`}
                </button>
              )}
              <button
                onClick={onOpenSkillStore}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                {installedSkills.length === 0 ? '探索技能商店 →' : '技能商店 →'}
              </button>
            </div>
          </div>
          {skillsLoading ? (
            <div className="flex items-center justify-center py-4">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          ) : installedSkills.length === 0 ? (
            <button
              className="w-full py-5 border-2 border-dashed border-border rounded-xl text-sm text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors group"
              onClick={onOpenSkillStore}
            >
              <Sparkles className="w-4 h-4 inline mr-1.5 group-hover:text-primary transition-colors" />
              去技能商店发现和安装你的第一个技能
            </button>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
              {(showAllSkills ? installedSkills : installedSkills.slice(0, 6)).map((skill) => (
                <button
                  key={skill.agentId}
                  onClick={() => handleSkillClick(skill)}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-all group"
                  title={skill.description}
                >
                  <span className="text-2xl leading-none">
                    {skill.icon && (skill.icon.startsWith('http://') || skill.icon.startsWith('https://') || skill.icon.startsWith('/api/'))
                      ? <img src={skill.icon} alt="" className="w-7 h-7 object-cover rounded" />
                      : (skill.icon || '🤖')
                    }
                  </span>
                  <span className="text-[10px] font-medium text-center truncate w-full">{skill.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Chat Input at bottom of welcome */}
        <ChatInput
          conversationId=""
          onSend={onSend}
          isGenerating={false}
          onStop={() => {}}
          onAutoCode={undefined}
          mobileBottomOffset="var(--mobile-nav-height)"
        />
      </div>
    </div>
  )
}
