import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { marked } from 'marked'
import { toast } from 'sonner'
import { useAuthStore, useChatStore, type FileAttachment } from '@/store'
import ChatInput from '@/components/chat/ChatInput'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Plus, MessageSquare, Code2, Bot, Settings, Shield, LogOut,
  ChevronLeft, ChevronRight, ChevronDown, Loader2, Send, Square, Trash2,
  Globe, Server, Smartphone, Wrench, MoreHorizontal, ExternalLink,
  Terminal, Eye, GitBranch, Rocket, X, Menu, Sparkles, RefreshCw, AlertTriangle,
  FolderIcon, FolderRoot, FileIcon, Download, Edit3, Save, Copy, FileDown, FileArchive,
  Image as ImageIcon, Paperclip, RotateCw, GitBranchPlus, Cpu, FileText,
  FilePen, TerminalSquare, FileSearch, GitCommitHorizontal, MessageCircleQuestion,
  CircleCheck, Hammer, MonitorPlay, CircleDot, Search, Package, ListOrdered, ListChecks, Layers, ArrowRight, CheckCircle2, Clock, AlertCircle, SkipForward, Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAvailableModels } from '@/hooks/useAvailableModels'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { AppPage } from '@/App'
import NewTaskDialog, { type NewTaskParams } from '@/components/autocode/NewTaskDialog'
import {
  createAutoCodeTask, getAutoCodeTask, getAutoCodeTaskStatus, getAutoCodeTaskEvents, resolveAutoCodeApproval, listAutoCodeTasks, deleteAutoCodeTask, renameAutoCodeTask, enableAutoCodeTaskPlanning, retryAutoCodeTask, stopAutoCodeTask, updateAutoCodeToolPolicy,
  setAutoCodeLocalRunnerMode, getAutoCodeLocalRunnerStatus, syncAutoCodeLocalRunnerSnapshot, getAutoCodeLocalRunnerDownloadUrl, createAutoCodeLocalRunnerSession, getAutoCodeLocalRunnerSessionStatus,
  registerLocalRunnerTask, listAutoCodeLocalProjectGrants,
  cloneProject, uploadProject, getProject, registerImportedProjectTask, generatePrototype, confirmPlan, confirmPrototype,
  listPrototypeRecords, getPrototypeRecord, updatePrototypeRecord, activatePrototypeRecord,
  listAutoCodeWorkspaceFiles, readAutoCodeWorkspaceFile, saveAutoCodeWorkspaceFile, runAutoCodeWorkspaceFile,
  listAutoCodeCommands, runAutoCodeCommand, runAutoCodePipeline,
  getAutoCodeGitStatus, getAutoCodeGitLog, getAutoCodeGitDiff, getAutoCodeWorkingDiff,
  getAutoCodeQueueStatus, listAutoCodeTools,
  type AutoCodeReviewIssue, type AutoCodeReviewResult, type PrototypeRecord,
  type AutoCodeWorkspaceFile, type AutoCodeGitStatus, type AutoCodeGitCommit, type AutoCodeCommandRecord,
  type AutoCodePipelineRun, type AutoCodeRuntimeEvent, type AutoCodeQueueStatus, type AutoCodeToolPolicy, type AutoCodeLocalRunnerStatus, type AutoCodeLocalProjectGrant,
} from '@/lib/api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import PrototypeEditor, { type ExcalidrawElement as PrototypeEditorElement } from '@/components/autocode/PrototypeEditor'

// ──────────────────────────────────────────
// AutoCode 认证辅助（read from localStorage）
// ──────────────────────────────────────────
function getAcAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return headers
    const store = JSON.parse(raw)
    const token = store?.state?.token
    const userId = store?.state?.user?.id
    if (token) headers['Authorization'] = `Bearer ${token}`
    if (userId) headers['X-User-Id'] = userId
  } catch { /* ignore */ }
  return headers
}

// ──────────────────────────────────────────
// 类型定义
// ──────────────────────────────────────────

type TaskStatus = 'pending' | 'running' | 'waiting_confirm' | 'waiting_plan_confirm' | 'waiting_prototype_confirm' | 'waiting_review_confirm' | 'reviewing' | 'completed' | 'failed' | 'stopped'
type WorkspaceTab = 'preview' | 'files' | 'workfiles' | 'terminal' | 'git' | 'prototype' | 'plan' | 'review' | 'events'

const TOOL_POLICY_OPTIONS: Array<{ value: AutoCodeToolPolicy; label: string; description: string }> = [
  { value: 'ask', label: '请求批准', description: '所有写入、命令和高风险动作都先询问。' },
  { value: 'full_access', label: '替我审批', description: '普通命令显示 5 秒倒计时后自动继续；删除、重置等高风险动作必须手动确认。' },
  { value: 'auto_safe', label: '安全自动', description: '直接自动批准非高风险操作，删除、重置等极高风险动作必须手动确认。' },
]

function normalizeToolPolicy(value?: string): AutoCodeToolPolicy {
  return value === 'ask' || value === 'auto_safe' ? value : 'full_access'
}

function getToolPolicyLabel(value?: string): string {
  const policy = normalizeToolPolicy(value)
  return TOOL_POLICY_OPTIONS.find(option => option.value === policy)?.label || '替我审批'
}

function mergeLocalRunnerStatus(
  current?: AutoCodeLocalRunnerStatus,
  incoming?: AutoCodeLocalRunnerStatus,
): AutoCodeLocalRunnerStatus | undefined {
  if (!incoming) return current
  return {
    ...current,
    ...incoming,
    command: incoming.command || current?.command,
    download_url: incoming.download_url || current?.download_url,
    install_url: incoming.install_url || current?.install_url,
    launch_url: incoming.launch_url || current?.launch_url,
    connector_update_required: incoming.connector_update_required ?? current?.connector_update_required,
    connector_min_version: incoming.connector_min_version || current?.connector_min_version,
    connector_protocol: incoming.connector_protocol || current?.connector_protocol,
    connector_available: incoming.connector_available ?? current?.connector_available,
    ws_url: incoming.ws_url || current?.ws_url,
    token: incoming.token || current?.token,
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function getApprovalMeta(event?: AutoCodeRuntimeEvent | null) {
  const payload = event?.payload || {}
  const nested = (payload.payload && typeof payload.payload === 'object' ? payload.payload : {}) as Record<string, unknown>
  const autoApproveAfter = Math.max(0, toNumber(payload.auto_approve_after_seconds ?? nested.auto_approve_after_seconds, 0))
  const manualRequired = Boolean(payload.manual_required || nested.manual_required)
  const highRisk = Boolean(payload.high_risk || nested.high_risk || nested.destructive || payload.destructive)
  const command = toDisplayText(payload.command || nested.command)
  return {
    autoApproveAfter: highRisk ? 0 : autoApproveAfter,
    highRisk,
    manualRequired,
    command,
  }
}

function getApprovalModeLabel(meta: ReturnType<typeof getApprovalMeta>, compact = false): string {
  if (meta.highRisk) return compact ? '高风险操作需要人工确认' : '高风险操作需要手动确认'
  if (meta.autoApproveAfter) return compact ? '倒计时后自动批准' : `普通操作将在 ${meta.autoApproveAfter}s 内无人处理时自动批准`
  return compact ? '需要人工确认' : 'Agent 正在等待你的确认'
}

function shouldNotifyApprovalEvent(event: AutoCodeRuntimeEvent, taskPolicy?: AutoCodeToolPolicy): boolean {
  const meta = getApprovalMeta(event)
  const eventPolicy = normalizeToolPolicy(toDisplayText(event.payload?.task_tool_policy || event.payload?.tool_policy, taskPolicy))
  if (eventPolicy === 'ask') return true
  return meta.highRisk
}

function buildApprovalResolvedEvent(task: AutoCodeTask, event: AutoCodeRuntimeEvent, approved: boolean, note?: string): AutoCodeRuntimeEvent {
  return {
    id: `local-resolved-${event.id}-${approved ? 'approved' : 'rejected'}`,
    type: 'approval_resolved',
    task_id: task.backendTaskId || task.id,
    source: 'user',
    created_at: new Date().toISOString(),
    payload: {
      approval_id: toDisplayText(event.payload?.approval_id, event.id),
      event_id: event.id,
      approved,
      note,
      local: true,
    },
  }
}

function pendingConfirmationToEvent(task: AutoCodeTask): AutoCodeRuntimeEvent | null {
  if (task.status !== 'waiting_confirm') return null
  const pending = task.pendingConfirmation
  if (!pending || typeof pending !== 'object') return null
  const pendingPayload = pending && typeof pending === 'object' ? pending : {}
  const fallbackId = `fallback-confirm-${task.backendTaskId || task.id}`
  const eventId = toDisplayText(pendingPayload.event_id, toDisplayText(pendingPayload.approval_id, fallbackId))
  const payload = (pendingPayload.payload && typeof pendingPayload.payload === 'object' ? pendingPayload.payload : {}) as Record<string, unknown>
  const reason = toDisplayText(
    pendingPayload.reason || task.currentStep,
    '任务正在等待人工确认，确认后将继续执行。',
  )
  return {
    id: eventId,
    type: 'approval_requested',
    task_id: task.backendTaskId || task.id,
    source: 'permission',
    created_at: toDisplayText(pendingPayload.created_at, new Date().toISOString()),
    payload: {
      approval_id: pendingPayload.approval_id || eventId,
      tool: pendingPayload.action || 'continue_task',
      action: pendingPayload.action || 'continue_task',
      args: pendingPayload.args,
      reason,
      message: reason,
      payload,
      auto_approve_after_seconds: pendingPayload.auto_approve_after_seconds ?? payload.auto_approve_after_seconds ?? 0,
      manual_required: pendingPayload.manual_required ?? payload.manual_required ?? true,
      high_risk: pendingPayload.high_risk ?? payload.high_risk ?? payload.destructive ?? false,
    },
  }
}

interface ChatMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: string
  files?: FileAttachment[]
  toolName?: string  // for system messages: which tool was executed
  toolDescription?: string  // for system messages: human-readable description
  toolResult?: string  // for system messages: tool result summary
}

interface SubTask {
  id: string
  title: string
  description: string
  agent_type?: string
  estimated_files?: string[]
  dependencies?: string[]
  status?: string
  progress?: number
}

interface TaskPlan {
  overall_approach?: string
  architecture?: string
  tech_stack?: Record<string, string>
  subtasks?: SubTask[]
  execution_groups?: string[][]
}

type ReviewIssue = AutoCodeReviewIssue
type ReviewResult = AutoCodeReviewResult

/** Excalidraw 元素类型 */
interface ExcalidrawElement {
  id?: string
  type?: 'rectangle' | 'text' | 'arrow' | 'ellipse' | 'line' | 'diamond'
  x?: number
  y?: number
  width?: number
  height?: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  roughness?: number
  text?: string
  fontSize?: number
  fontFamily?: string
  groupIds?: string[]
  roundness?: unknown
  boundElements?: unknown[]
  link?: string | null
  locked?: boolean
}

interface AutoCodeTask {
  id: string
  title: string
  description: string
  projectType: string
  techStack: string
  status: TaskStatus
  progress: number
  currentStep: string
  workspaceId?: string
  previewUrl?: string
  model?: string
  toolPolicy?: AutoCodeToolPolicy
  pendingConfirmation?: Record<string, unknown> | null
  localExecutionEnabled?: boolean
  localRunner?: AutoCodeLocalRunnerStatus
  localImportMode?: boolean
  cloudSnapshotEnabled?: boolean
  cloudSnapshotStatus?: string
  cloudSnapshotError?: string
  backendTaskId?: string // AutoCode 后端返回的真实任务 ID
  createdAt: string
  messages: ChatMsg[]
  logs: string[]
  commandHistory?: AutoCodeCommandRecord[]
  pipelineRuns?: AutoCodePipelineRun[]
  events?: AutoCodeRuntimeEvent[]
  plan?: TaskPlan
  review?: ReviewResult   // 代码审查结果
  phase_reviews?: ReviewResult[]
  plan_confirmed?: boolean
  prototype_confirmed?: boolean
  review_confirmed?: boolean
  executionActive?: boolean
  runtimeState?: string
  runtimeNote?: string
  projectRecon?: Record<string, unknown>
  complexity?: string
  recommendedFlow?: string
  prototypeRequired?: boolean
  pipelineStatus?: string
  previewStatus?: string
  previewError?: string
  /** 原型数据（后端返回的完整结果，包含 excalidraw 子对象） */
  prototype?: {
    id?: string
    prototype_id?: string
    title?: string
    description?: string
    kind?: 'html' | 'excalidraw'
    html?: string
    preview_url?: string
    excalidraw?: {
      type?: string
      version?: number
      elements?: ExcalidrawElement[]
      appState?: Record<string, unknown>
    }
    features?: string[]
  }
}

const TYPE_ICON: Record<string, React.ElementType> = {
  website: Globe,
  api: Server,
  miniapp: Smartphone,
  tool: Wrench,
}

const TYPE_COLOR: Record<string, string> = {
  website: 'text-blue-500',
  api: 'text-green-500',
  miniapp: 'text-purple-500',
  tool: 'text-orange-500',
}

function getAgentTypesForProject(projectType: string): string[] {
  switch (projectType) {
    case 'api':
    case 'tool':
      return ['backend']
    case 'miniapp':
      return ['frontend']
    case 'website':
    default:
      return ['frontend', 'backend']
  }
}

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; dot: string }> = {
  pending:   { label: '等待中', color: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  running:   { label: '开发中', color: 'text-blue-500', dot: 'bg-blue-500 animate-pulse' },
  waiting_confirm: { label: '待确认操作', color: 'text-amber-500', dot: 'bg-amber-500 animate-pulse' },
  waiting_plan_confirm: { label: '待确认计划', color: 'text-amber-500', dot: 'bg-amber-500 animate-pulse' },
  waiting_prototype_confirm: { label: '待确认原型', color: 'text-violet-500', dot: 'bg-violet-500 animate-pulse' },
  waiting_review_confirm: { label: '待确认审查', color: 'text-purple-500', dot: 'bg-purple-500 animate-pulse' },
  reviewing: { label: '代码审查', color: 'text-purple-500', dot: 'bg-purple-500 animate-pulse' },
  completed: { label: '已完成', color: 'text-green-500', dot: 'bg-green-500' },
  failed:    { label: '失败', color: 'text-destructive', dot: 'bg-destructive' },
  stopped:   { label: '已停止', color: 'text-orange-500', dot: 'bg-orange-500' },
}

// 后端状态 → 前端状态映射
function mapBackendStatus(status: string): TaskStatus {
  switch (status) {
    case 'cancelled': return 'stopped'
    case 'waiting_plan_confirm': return 'waiting_plan_confirm'
    case 'waiting_prototype_confirm': return 'waiting_prototype_confirm'
    case 'waiting_review_confirm': return 'waiting_review_confirm'
    case 'waiting_confirm': return 'waiting_confirm'
    case 'reviewing': return 'reviewing'
    default: return (status as TaskStatus) || 'pending'
  }
}

function normalizeMojibakeText(text: string): string {
  if (!text) return text
  const replacements: Array<[RegExp, string]> = [
    [new RegExp("\u6924\u572d\u6d30\u6e1a\ufe40\u7642", 'g'), '项目侦察'],
    [new RegExp("\u6924\u572d\u6d30", 'g'), '项目'],
    [new RegExp("\u599e\u3085\u6e71\u5a32\u7248\u7b1f\u9515\u20ac\u9427\\?", 'g'), '项目侦察'],
    [new RegExp("\u6d60\u8bf2\u59df\u95c3\u71b7\u57aa\u6d93\\.\\.\\.", 'g'), '任务队列中...'],
    [new RegExp("\u6d60\u8bf2\u59df", 'g'), '任务'],
    [new RegExp("\u5bb8\u30e4\u7d94\u7ecc\u6d2a\u68ff", 'g'), '工作空间'],
    [new RegExp("\u7481\u677f\u7e42\u93c2\u56e6\u6b22", 'g'), '记忆文件'],
    [new RegExp("\u5bb8\u63d2\u57b5\u6fee\u5b2a\u5bf2", 'g'), '已初始化'],
    [new RegExp("Git \u6d60\u64b3\u7c31", 'g'), 'Git 仓库'],
    [new RegExp("\u5bee\u20ac\u9359\u6223\ue749\u947c\\?", 'g'), '开发规范'],
    [new RegExp("\u5bee\u20ac\u9359\u6223\ue749\u947c", 'g'), '开发规范'],
    [new RegExp("\u6769\ue15d\u552c\u6d93\u5a47\u6aba", 'g'), '迭代上限'],
    [new RegExp("\u59dd\uff45\u6e6a\u93b5\u0446\ue511\u935b\u6212\u62a4", 'g'), '正在执行命令'],
    [new RegExp("\u935b\u6212\u62a4", 'g'), '命令'],
    [new RegExp("\u7f01\u5822\ue06c", 'g'), '终端'],
    [new RegExp("\u9304\u5c71", 'g'), '终端'],
    [new RegExp("\u93b5\u0446\ue511", 'g'), '执行'],
    [new RegExp("\u93c2\u56e6\u6b22", 'g'), '文件'],
    [new RegExp("\u93b5\ue0a3\u5f3f", 'g'), '扫描'],
    [new RegExp("\u7487\u8bf2\u5f47", 'g'), '读取'],
    [new RegExp("\u6dc7\ue1bd\u657c", 'g'), '修改'],
    [new RegExp("\u6960\u5c83\u7609", 'g'), '验证'],
    [new RegExp("\u93cb\u52eb\u7f13", 'g'), '构建'],
    [new RegExp("\u93ba\u3128\u5d18\u5a34\u4f7a\u25bc", 'g'), '推荐流程'],
    [new RegExp("\u6fb6\u5d86\u6f45\u6434", 'g'), '复杂度'],
    [new RegExp("\u93b6\u20ac\u93c8\ue21b\u7224", 'g'), '技术栈'],
    [new RegExp("\u934f\u30e5\u5f5b\u93c2\u56e6\u6b22", 'g'), '入口文件'],
    [new RegExp("\u7459\u52eb\u579d\u5be4\u9e3f\ue185", 'g'), '规划建议'],
    [new RegExp("\u93c8\ue045\ue5c5\u5a34\u5b2a\u57cc", 'g'), '未检测到'],
    [new RegExp("\u93c3\\?", 'g'), '无'],
    [new RegExp("\u7487\u5cf0\u539b\u9427\u8bf2\u7d8d", 'g'), '请先登录'],
    [new RegExp("\u5bb8\u30e5\u53ff\u93c9\u51ae\u6aba\u7edb\u682b\u6690\u5bb8\u63d2\u578f\u93b9\ue76d\u8d1f", 'g'), '工具权限策略已切换为'],
    [new RegExp("\u5bb8\u30e5\u53ff\u93c9\u51ae\u6aba\u7edb\u682b\u6690", 'g'), '工具权限策略'],
    [new RegExp("\u5bb8\u63d2\u578f\u93b9\ue76d\u8d1f", 'g'), '已切换为'],
    [new RegExp("\u7459\u6395\u58ca", 'g'), '角色'],
    [new RegExp("\u6748\u572d\u666b", 'g'), '边界'],
    [new RegExp("\u95c3\u7ed8\ue11b", 'g'), '阻止'],
    [new RegExp("\u9350\u6b0f\u53c6", 'g'), '写入'],
    [new RegExp("\u6fb6\u8fab\u89e6", 'g'), '失败'],
    [new RegExp("\u93b4\u612c\u59db", 'g'), '成功'],
    [new RegExp("\u7edb\u590a\u7ddf", 'g'), '等待'],
    [new RegExp("\u7ead\ue1bf\ue17b", 'g'), '确认'],
  ]
  let normalized = replacements.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text)
  if (/[æèéåçäöü]/i.test(normalized)) {
    try {
      const latin1Fixed = decodeURIComponent(escape(normalized))
      if (mojibakeScore(latin1Fixed) < mojibakeScore(normalized)) {
        normalized = latin1Fixed
      }
    } catch {
      // Best-effort repair only.
    }
  }
  return normalized.replace(new RegExp("[\ufffd]+", 'g'), '').trim()
}

function toDisplayText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return normalizeMojibakeText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return normalizeMojibakeText(JSON.stringify(value))
  } catch {
    return fallback
  }
}

function toTextArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map(item => toDisplayText(item)).filter(Boolean)
}

function compactText(value: unknown, maxLength = 220): string {
  const text = toDisplayText(value).replace(/\s+/g, ' ').trim()
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

function normalizeLocalProjectPath(value: unknown): string {
  return toDisplayText(value)
    .replace(/^\\\\\?\\/, '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

type ToolDisplayMap = Record<string, { label: string; action: string; purpose: string }>

const TOOL_DISPLAY: ToolDisplayMap = {
  bash: { label: '终端命令', action: '执行命令', purpose: '在工作区运行验证、构建、文件查看或脚本命令。' },
  read_file: { label: '读取文件', action: '查看文件', purpose: '读取相关源码、配置或记忆文件，帮助 Agent 定位问题。' },
  write_file: { label: '写入文件', action: '创建/修改文件', purpose: '把 Agent 的代码、文档或配置改动写入工作区。' },
  apply_patch: { label: '精准修改', action: '应用补丁', purpose: '对已有文件做小范围精确修改。' },
  glob: { label: '查找文件', action: '扫描文件结构', purpose: '按文件名或模式寻找候选文件。' },
  search_code: { label: '搜索代码', action: '检索代码内容', purpose: '按函数、属性、错误文本或关键词定位相关代码。' },
  git_commit: { label: '保存快照', action: '创建 Git 快照', purpose: '保存一组可审查、可回退的自动变更。' },
  request_confirmation: { label: '请求确认', action: '等待人工确认', purpose: '高风险操作执行前暂停，等待用户批准或拒绝。' },
  rollback: { label: '回退快照', action: '回退修改', purpose: '将工作区恢复到指定快照或提交。' },
}

const EVENT_TYPE_DISPLAY: Record<string, string> = {
  permission_checked: '权限判断',
  tool_call: '工具调用',
  tool_result: '工具结果',
  approval_requested: '等待确认',
  approval_resolved: '确认结果',
  pre_edit_checkpoint: '编辑检查点',
  checkpoint_created: '自动快照',
  ci_finished: 'CI / 验证',
  task_completed_summary: '任务总结',
  context_compaction_started: '上下文压缩',
  context_compaction_finished: '压缩完成',
  system_context_indexed: '上下文索引',
  system_context_changed: '上下文变化',
  system_context_reconciled: '上下文对齐',
  agent_observation: '观察上下文',
  agent_action_selected: '选择动作',
  agentic_loop_start: 'Agentic Loop',
  agentic_loop_no_change_retryable: '自动续跑',
  agentic_loop_checkpoint: '执行检查点',
  agentic_loop_finished: '执行完成',
  agentic_plan_hint_ready: '规划提示',
  guardrail_review_started: '护栏审查',
  guardrail_review_finished: '护栏审查结果',
  phase_review_started: '阶段审查',
  phase_review_finished: '阶段审查结果',
  role_write_blocked: '权限拦截',
  local_runner_enabled: '本地执行开启',
  local_runner_disabled: '本地执行关闭',
  local_runner_connected: '本地已连接',
  local_runner_disconnected: '本地已断开',
  local_runner_tool_result: '本地工具结果',
  local_runner_tool_failed: '本地工具失败',
  tool_cache_hit: '复用缓存',
  tool_duplicate_suppressed: '跳过重复操作',
  agent_efficiency_guard: '效率保护',
  retrieval_guard_accounted: '读取预算',
  retrieval_guard_blocked: '读取拦截',
  command_started: '命令开始',
  command_finished: '命令完成',
  command_blocked: '命令拦截',
  ci_repair_started: '自动修复开始',
  ci_repair_skipped: '自动修复跳过',
  ci_repair_finished: '自动修复结束',
  session_input_admitted: '对话输入入队',
  session_input_merged: '重复输入合并',
  session_input_promoted: '对话输入注入',
  session_wake_scheduled: '会话续跑安排',
  chat_continuation_queued: '对话续跑入队',
}

const EVENT_SOURCE_DISPLAY: Record<string, string> = {
  backend: '后端 Agent',
  frontend: '前端 Agent',
  devops: '运维 Agent',
  reviewer: '代码审查',
  orchestrator: '任务编排',
  permission_engine: '权限引擎',
  git: 'Git 快照',
  ci: '验证流程',
  context: '上下文管理',
  queue: '后台队列',
  local_runner: '本地 Runner',
  system: '系统',
}

function getToolDisplay(tool?: unknown, registry: ToolDisplayMap = TOOL_DISPLAY) {
  const name = toDisplayText(tool, 'unknown')
  return registry[name] || TOOL_DISPLAY[name] || {
    label: name || '未知工具',
    action: name || '执行工具',
    purpose: '执行 Agent 选择的工作区操作。',
  }
}

function formatToolTarget(tool: string, args: unknown): string {
  const data = args && typeof args === 'object' ? args as Record<string, unknown> : {}
  if (tool === 'bash') return compactText(data.command)
  return compactText(data.path || data.pattern || data.target || data.message || data.action)
}

function nestedRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = toDisplayText(value).trim()
    if (text) return text
  }
  return ''
}

function getEventDiagnostic(payload: Record<string, unknown>, summaryTone?: string) {
  const report = nestedRecord(payload.report)
  const failure = Object.keys(nestedRecord(payload.failure)).length
    ? nestedRecord(payload.failure)
    : nestedRecord(report.failure)
  const nestedPayload = nestedRecord(payload.payload)
  const exitCodeValue = payload.exit_code ?? report.exit_code ?? failure.exit_code ?? nestedPayload.exit_code
  const exitCode = exitCodeValue === undefined || exitCodeValue === null || exitCodeValue === ''
    ? ''
    : String(exitCodeValue)
  const errorText = firstText(
    payload.real_error,
    payload.error_detail,
    payload.error,
    payload.stderr,
    payload.failure_summary,
    failure.summary,
    failure.message,
    failure.error,
    report.error_detail,
    report.error,
    nestedPayload.error,
  )
  const outputText = firstText(
    payload.result,
    payload.output,
    report.output,
    payload.stdout,
    nestedPayload.result,
  )
  const outputPath = firstText(
    payload.output_path,
    payload.full_output_path,
    payload.full_path,
    report.output_path,
    nestedPayload.output_path,
  )
  const outputSha = firstText(payload.output_sha256, payload.sha256, report.output_sha256, nestedPayload.output_sha256)
  const outputChars = firstText(payload.output_chars, payload.chars, report.output_chars, nestedPayload.output_chars)
  const outputLines = firstText(payload.output_lines, payload.lines, report.output_lines, nestedPayload.output_lines)
  const failed = summaryTone === 'destructive'
    || Boolean(errorText)
    || (exitCode !== '' && exitCode !== '0')
    || toDisplayText(payload.status, toDisplayText(report.status)).toLowerCase() === 'failed'
    || payload.ok === false
  return {
    failed,
    exitCode,
    errorText: compactText(errorText, 1400),
    outputText: compactText(outputText, 1400),
    outputPath,
    outputSha,
    outputChars,
    outputLines,
    truncated: Boolean(payload.output_truncated || report.output_truncated || nestedPayload.output_truncated || outputPath),
  }
}

function notifyAutoCodeUser(key: string, title: string, body: string, variant: 'success' | 'error' | 'warning' | 'info' = 'info', notifyType: 'taskComplete' | 'operationApproval' = 'taskComplete') {
  // 读取用户通知偏好设置
  let notifPrefs: Partial<Record<'taskComplete' | 'operationApproval', boolean>> = {}
  try { notifPrefs = JSON.parse(localStorage.getItem('user-notifications') || '{}') } catch {}
  // 根据类型判断是否开启通知
  const enabled = notifyType === 'operationApproval' 
    ? (notifPrefs.operationApproval ?? true) 
    : (notifPrefs.taskComplete ?? true)
  if (!enabled) return // 对应开关关闭，不发通知
  if (!title) return
  const toastBody = body || '请回到 AutoCode 查看详情。'
  if (variant === 'success') toast.success(title, { description: toastBody })
  else if (variant === 'error') toast.error(title, { description: toastBody })
  else if (variant === 'warning') toast.warning(title, { description: toastBody })
  else toast.info(title, { description: toastBody })

  if (typeof window === 'undefined' || !('Notification' in window)) return
  const showNotification = () => {
    try {
      const notification = new Notification(title, {
        body: toastBody,
        tag: `autocode-${key}`,
      })
      notification.onclick = () => {
        window.focus()
        notification.close()
      }
    } catch { /* browser notification may be blocked */ }
  }
  if (Notification.permission === 'granted') {
    showNotification()
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') showNotification()
    }).catch(() => undefined)
  }
}

function hasMojibake(text: string): boolean {
  return mojibakeScore(text) >= 3
}

function mojibakeScore(text: string): number {
  if (!text) return 0
  const suspicious = text.match(new RegExp("[\ufffd]|[\u93b4\u5bb8\u93c2\u9422\u93c4\u6769\u5bee\u7035\u5a34\u93cb\u9365\u93be\u6d16\u6434\u7f01\u6960\u935b\u599e\u6e1a\u7642\u7481\u7e42\u7ecc\u68ff\u53ff\u6aba\u7edb\u6690]", 'g'))?.length || 0
  const cjk = text.match(/[\u4e00-\u9fff]/g)?.length || 0
  if (!cjk) return suspicious
  return suspicious / Math.max(1, cjk) > 0.18 ? suspicious : 0
}

function fallbackReadableLog(text: string, fallback = '系统事件已记录，原始文本存在编码异常。'): string {
  const normalized = normalizeMojibakeText(text)
  if (!hasMojibake(normalized)) return normalized
  if (/npm|pnpm|yarn|build|install|test|python|mvn|gradle|ls |cat |write_file|read_file|glob|bash/i.test(normalized)) {
    return normalized
      .replace(new RegExp("[\u93b4\u5bb8\u93c2\u9422\u93c4\u6769\u5bee\u7035\u5a34\u93cb\u9365\u93be\u6d16\u6434\u7f01\u6960\u935b\u599e\u6e1a\u7642\u7481\u7e42\u7ecc\u68ff\u53ff\u6aba\u7edb\u6690]{2,}", 'g'), '')
      .replace(/\s{2,}/g, ' ')
      .trim() || fallback
  }
  return fallback
}

function normalizeReviewTextByRule(rule: string, text: string, kind: 'summary' | 'message'): string {
  if (rule === 'review/no-phase-changes') {
    return kind === 'summary'
      ? '阶段没有产生任何工作区文件变更，拒绝通过代码审查。'
      : '该执行组没有产生工作区文件变更，也没有找到可复用的阶段产物，不能通过审查。'
  }
  if (rule === 'ci/failed' && hasMojibake(text)) {
    return kind === 'summary'
      ? '阶段 CI/验证未通过，已阻止进入代码审查通过状态。'
      : '验证命令执行失败，请查看 .autocode/CI_REPORT.md 中的命令、退出码和输出。'
  }
  return hasMojibake(text) && !text.trim() ? '' : text
}

function summarizeRuntimeEvent(event: AutoCodeRuntimeEvent, toolRegistry: ToolDisplayMap = TOOL_DISPLAY): { label: string; title: string; description: string; tone: 'default' | 'warning' | 'success' | 'destructive' } {
  const payload = event.payload || {}
  const report = (payload.report && typeof payload.report === 'object') ? payload.report as Record<string, unknown> : {}
  const eventStatus = toDisplayText(payload.status, toDisplayText(report.status))
  const eventCommand = toDisplayText(payload.command, toDisplayText(report.command))
  const failure = (payload.failure && typeof payload.failure === 'object')
    ? payload.failure as Record<string, unknown>
    : ((report.failure && typeof report.failure === 'object') ? report.failure as Record<string, unknown> : {})
  const failureSummary = toDisplayText(payload.failure_summary, toDisplayText(failure.summary))
  const fallbackTitle = toDisplayText(payload.tool || payload.command || payload.phase || payload.message || event.type, event.type)
  const tool = toDisplayText(payload.tool)
  const toolDisplay = getToolDisplay(tool, toolRegistry)
  const toolTarget = formatToolTarget(tool, payload.args || payload.approval_payload)
  const outputNote = payload.output_truncated && payload.output_path
    ? ` 完整输出已保存：/workspace/${toDisplayText(payload.output_path)}`
    : ''
  switch (event.type) {
    case 'permission_checked': {
      const decision = toDisplayText(payload.decision)
      const policy = toDisplayText(payload.task_tool_policy)
      const decisionText = decision === 'allow' ? '已允许' : decision === 'ask' ? '需要确认' : decision === 'deny' ? '已拦截' : decision
      return {
        label: '权限判断',
        title: `${toolDisplay.label}权限：${decisionText}`,
        description: compactText(`${toolDisplay.purpose}${payload.reason ? ` 原因：${payload.reason}` : ''}${policy ? ` 策略：${policy}` : ''}`),
        tone: decision === 'deny' ? 'destructive' : decision === 'ask' ? 'warning' : 'default',
      }
    }
    case 'tool_call':
      return {
        label: '工具调用',
        title: `${toolDisplay.action}${toolTarget ? `：${toolTarget}` : ''}`,
        description: toolDisplay.purpose,
        tone: 'default',
      }
    case 'tool_result': {
      const ok = payload.ok !== false
      const result = compactText(payload.result)
      return {
        label: ok ? '工具完成' : '工具失败',
        title: `${toolDisplay.label}${ok ? '执行完成' : '执行失败'}${toolTarget ? `：${toolTarget}` : ''}`,
        description: `${result || toolDisplay.purpose}${outputNote}`,
        tone: ok ? 'success' : 'destructive',
      }
    }
    case 'tool_cache_hit':
      return {
        label: '复用缓存',
        title: `${toolDisplay.label}结果已复用${toolTarget ? `：${toolTarget}` : ''}`,
        description: '相同工作区状态下已经执行过该读取类操作，AI 直接复用结果以减少重复扫描。',
        tone: 'default',
      }
    case 'tool_duplicate_suppressed':
      return {
        label: '跳过重复',
        title: `${toolDisplay.label}被效率保护跳过${toolTarget ? `：${toolTarget}` : ''}`,
        description: toDisplayText(payload.reason, '该操作与近期上下文重复，系统要求 Agent 继续修改或验证。'),
        tone: 'warning',
      }
    case 'retrieval_guard_accounted':
      return {
        label: '读取计数',
        title: `源码读取 ${toDisplayText(payload.read_count, '0')}/${toDisplayText(payload.read_budget, '0')}：${toDisplayText(payload.path, '未知文件')}`,
        description: payload.candidate ? '候选文件读取已计入预算。' : '非候选文件读取已计入预算。',
        tone: payload.candidate ? 'default' : 'warning',
      }
    case 'retrieval_guard_blocked':
      return {
        label: '读取拦截',
        title: `读取预算已用完：${toDisplayText(payload.path, '未知文件')}`,
        description: `已读取 ${toDisplayText(payload.read_count, '0')}/${toDisplayText(payload.read_budget, '0')} 个源码文件，请优先基于候选文件收敛修改。`,
        tone: 'destructive',
      }
    case 'local_runner_enabled':
      return {
        label: '本地执行',
        title: '已开启本地执行模式',
        description: '请下载并启动 AutoCode Local Runner。连接后，AI 会优先在用户本地项目中执行读写和测试。',
        tone: 'warning',
      }
    case 'local_runner_disabled':
      return {
        label: '云端执行',
        title: '已关闭本地执行模式',
        description: '后续工具调用会回到服务器工作区执行。',
        tone: 'default',
      }
    case 'local_runner_connected':
    case 'local_runner_hello':
      return {
        label: '本地已连接',
        title: `本地 Runner 已连接${payload.project_root ? `：${toDisplayText(payload.project_root)}` : ''}`,
        description: toDisplayText(payload.version, '本地执行通道已就绪。'),
        tone: 'success',
      }
    case 'local_runner_disconnected':
      return {
        label: '本地断开',
        title: '本地 Runner 已断开',
        description: '如果任务仍需本地环境，请重新启动本地 Runner。',
        tone: 'warning',
      }
    case 'local_runner_tool_result':
    case 'local_runner_tool_failed': {
      const ok = event.type === 'local_runner_tool_result' && payload.ok !== false
      return {
        label: ok ? '本地完成' : '本地失败',
        title: `${toolDisplay.label}${ok ? '已在本地执行' : '本地执行失败'}${toolTarget ? `：${toolTarget}` : ''}`,
        description: `${compactText(payload.result || payload.error || toolDisplay.purpose)}${outputNote}`,
        tone: ok ? 'success' : 'destructive',
      }
    }
    case 'command_started':
      return {
        label: '命令开始',
        title: `开始执行：${compactText(payload.command)}`,
        description: toDisplayText(payload.kind || payload.source, '工作区命令已开始运行。'),
        tone: 'default',
      }
    case 'command_finished': {
      const ok = toDisplayText(payload.status) === 'success' || Number(payload.exit_code) === 0
      return {
        label: ok ? '命令通过' : '命令失败',
        title: `命令结束：${compactText(payload.command)}`,
        description: `${compactText(payload.output || payload.status || payload.exit_code)}${outputNote}`,
        tone: ok ? 'success' : 'destructive',
      }
    }
    case 'session_input_admitted':
      return {
        label: '输入入队',
        title: payload.active ? '已把新消息加入当前 Agent 会话' : '已保存新消息，等待唤醒 Agent',
        description: compactText(payload.message || payload.message_preview || payload.status),
        tone: payload.active ? 'default' : 'warning',
      }
    case 'session_input_merged':
      return {
        label: '输入合并',
        title: `重复指令已合并，累计 ${toDisplayText(payload.merged_count, '2')} 次`,
        description: compactText(payload.message || payload.message_preview || payload.status),
        tone: 'default',
      }
    case 'session_input_promoted':
      return {
        label: '输入注入',
        title: `已向 Agent 注入 ${toDisplayText(payload.count, '0')} 条新消息`,
        description: toDisplayText(payload.input_ids),
        tone: 'default',
      }
    case 'session_wake_scheduled':
    case 'chat_continuation_queued':
      return {
        label: '已安排续跑',
        title: '新的对话输入已合并到同一 Agent 会话',
        description: compactText(payload.message_preview || payload.message || payload.reason),
        tone: 'warning',
      }
    case 'approval_requested':
      return {
        label: '等待确认',
        title: toDisplayText(payload.tool || payload.action, '高风险操作需要确认'),
        description: toDisplayText(payload.reason || payload.message, '该操作可能影响工作区，需要确认后继续。'),
        tone: 'warning',
      }
    case 'approval_resolved':
      return {
        label: payload.approved ? '已批准' : '已拒绝',
        title: payload.approved ? '用户批准了操作' : '用户拒绝了操作',
        description: toDisplayText(payload.reason || payload.message || payload.approval_id),
        tone: payload.approved ? 'success' : 'destructive',
      }
    case 'role_write_blocked':
      return {
        label: '越权拦截',
        title: `${toDisplayText(payload.agent, 'Agent')} 不能写入 ${toDisplayText(payload.path, '该文件')}`,
        description: toDisplayText(payload.reason, '文件不在当前角色所有权范围内，可调整 .autocode/ROLE_OWNERSHIP.md 后重试。'),
        tone: 'destructive',
      }
    case 'agent_observation':
      return {
        label: '观察上下文',
        title: `Agent 正在观察当前任务状态：${toDisplayText(payload.status, 'unknown')}`,
        description: toDisplayText(payload.current_step || payload.message_preview, '已读取任务、工作区和最近上下文。'),
        tone: 'default',
      }
    case 'agent_action_selected':
      return {
        label: '选择动作',
        title: `AI 选择：${toDisplayText(payload.action, 'answer')}`,
        description: toDisplayText(payload.command || payload.path || payload.answer_preview || payload.target),
        tone: payload.action === 'continue_development' ? 'warning' : 'default',
      }
    case 'agentic_loop_start':
      return {
        label: 'Agentic Loop',
        title: payload.source === 'chat_continuation' ? 'AI 已进入增量自主执行' : 'AI 已进入自主开发执行',
        description: `模式：${toDisplayText(payload.mode, 'agentic')}；阶段计划仅作为护栏，不再固定驱动流程。`,
        tone: 'warning',
      }
    case 'agentic_loop_no_change_retryable':
      return {
        label: '自动续跑',
        title: '本轮尚未产生变更，已保留上下文继续',
        description: compactText(payload.message || payload.retrieval_plan),
        tone: 'warning',
      }
    case 'agentic_loop_checkpoint':
      return {
        label: payload.retryable ? '自动续跑' : '执行检查点',
        title: payload.retryable ? 'Agent 已保存检查点，准备继续' : 'Agent 已保存执行检查点',
        description: compactText(payload.message || payload.reason || payload.changed_files),
        tone: payload.blocked ? 'destructive' : 'warning',
      }
    case 'agentic_loop_finished':
      return {
        label: '执行完成',
        title: payload.status === 'completed' ? 'Agentic Loop 本轮已完成' : `Agentic Loop 状态：${toDisplayText(payload.status, '已结束')}`,
        description: compactText(payload.message || payload.reason || payload.changed_files),
        tone: payload.status === 'completed' ? 'success' : 'default',
      }
    case 'agentic_plan_hint_ready':
      return {
        label: '规划提示',
        title: `规划已作为上下文提示生成：${toDisplayText(payload.subtask_count, '0')} 项`,
        description: toDisplayText(payload.message, 'Agentic Loop 会自主决定执行顺序，不再等待计划确认。'),
        tone: 'default',
      }
    case 'guardrail_review_started':
      return {
        label: '护栏审查',
        title: `开始护栏审查：${toDisplayText(payload.label, 'Agentic Loop')}`,
        description: `检查 ${toDisplayText(payload.changed_count, '0')} 个变更文件，审查只作为质量护栏，不驱动开发流程。`,
        tone: 'warning',
      }
    case 'guardrail_review_finished':
      return {
        label: '护栏审查结果',
        title: payload.passed ? '护栏审查通过' : '护栏审查未通过',
        description: compactText(payload.reason || payload.changed_files || payload.label),
        tone: payload.passed ? 'success' : 'destructive',
      }
    case 'phase_review_started':
      return {
        label: '阶段审查',
        title: `开始阶段审查：${toDisplayText(payload.label, '执行组')}`,
        description: `检查 ${toDisplayText(payload.changed_count, '0')} 个变更文件。`,
        tone: 'warning',
      }
    case 'phase_review_finished':
      return {
        label: '阶段审查结果',
        title: payload.passed ? '阶段审查通过' : '阶段审查未通过',
        description: compactText(payload.reason || payload.changed_files || payload.label),
        tone: payload.passed ? 'success' : 'destructive',
      }
    case 'task_completed_summary':
      return {
        label: '任务总结',
        title: '任务完成总结已同步',
        description: toDisplayText(payload.content, '已生成完成总结，可在 AI 助手对话中查看。'),
        tone: 'success',
      }
    case 'pre_edit_checkpoint':
      return {
        label: '编辑前检查点',
        title: `准备修改 ${toDisplayText(payload.path, '工作区文件')}`,
        description: toDisplayText(payload.head, '已记录修改前状态。'),
        tone: 'default',
      }
    case 'checkpoint_created':
      return {
        label: '快照',
        title: '已创建自动快照',
        description: toDisplayText(payload.summary || payload.message || payload.files),
        tone: 'success',
      }
    case 'context_compaction_started':
      return {
        label: '上下文压缩',
        title: '开始压缩上下文',
        description: toDisplayText(payload.reason || payload.message, '任务上下文较长，正在整理记忆以便继续执行。'),
        tone: 'warning',
      }
    case 'context_compaction_finished':
      return {
        label: '上下文已压缩',
        title: '上下文压缩完成',
        description: toDisplayText(payload.summary || payload.message),
        tone: 'success',
      }
    case 'system_context_indexed':
      return {
        label: '上下文索引',
        title: `上下文已索引，Epoch ${toDisplayText(payload.epoch, '0')}`,
        description: `已记录 ${toDisplayText(payload.source_count, '0')} 个上下文源：${toDisplayText(payload.manifest_path, '.autocode/SYSTEM_CONTEXT.json')}`,
        tone: 'default',
      }
    case 'system_context_changed':
      return {
        label: '上下文变化',
        title: `上下文源已变化：${toDisplayText(payload.changed_count, '0')} 项`,
        description: compactText(payload.changed_paths || payload.manifest_path),
        tone: 'warning',
      }
    case 'system_context_reconciled':
      return {
        label: '上下文对齐',
        title: `Agent 已对齐上下文 Epoch ${toDisplayText(payload.epoch, '0')}`,
        description: Number(payload.changed_count || 0) > 0 ? compactText(payload.changed_paths) : '上下文无新增变化，继续基于当前状态执行。',
        tone: 'success',
      }
    case 'ci_repair_started':
      return {
        label: '自动修复',
        title: 'CI 未通过，开始分析并修复',
        description: failureSummary || toDisplayText(payload.summary || payload.command),
        tone: 'warning',
      }
    case 'ci_repair_skipped':
      return {
        label: '跳过修复',
        title: 'CI 失败不适合自动修复',
        description: toDisplayText(payload.reason) || failureSummary || eventCommand,
        tone: 'warning',
      }
    case 'ci_repair_finished':
      return {
        label: eventStatus === 'passed' ? '修复通过' : '修复结束',
        title: eventStatus === 'passed' ? '自动修复后 CI 已通过' : 'CI 修复流程已结束',
        description: toDisplayText(payload.summary || payload.message || payload.command),
        tone: eventStatus === 'failed' ? 'destructive' : 'success',
      }
    case 'ci_finished':
      return {
        label: eventStatus === 'passed' ? 'CI 通过' : eventStatus === 'skipped' ? 'CI 跳过' : 'CI 失败',
        title: eventCommand || toDisplayText(payload.phase || report.phase, '阶段验证完成'),
        description: failureSummary || toDisplayText(payload.summary || report.output || eventStatus),
        tone: eventStatus === 'passed' ? 'success' : eventStatus === 'skipped' ? 'warning' : 'destructive',
      }
    case 'rollback_started':
      return {
        label: '开始回退',
        title: `正在回退到 ${toDisplayText(payload.target || payload.commit, '指定快照')}`,
        description: toDisplayText(payload.message),
        tone: 'warning',
      }
    case 'rollback_finished':
      return {
        label: '回退完成',
        title: `已回退到 ${toDisplayText(payload.target || payload.commit, '指定快照')}`,
        description: toDisplayText(payload.message),
        tone: 'success',
      }
    default:
      return {
        label: event.type,
        title: fallbackTitle,
        description: toDisplayText(payload.reason || payload.summary || payload.message),
        tone: 'default',
      }
  }
}

function toNumberValue(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function mergeRuntimeEvents(existing: AutoCodeRuntimeEvent[] | undefined, incoming: AutoCodeRuntimeEvent[] | undefined): AutoCodeRuntimeEvent[] {
  const merged = [...(Array.isArray(existing) ? existing : [])]
  const seen = new Set(merged.map(event => event.id).filter(Boolean))
  for (const event of Array.isArray(incoming) ? incoming : []) {
    if (!event?.id || seen.has(event.id)) continue
    merged.push(event)
    seen.add(event.id)
  }
  return merged.slice(-1000)
}

function runtimeEventToChatMessage(event: AutoCodeRuntimeEvent): ChatMsg | null {
  if (event.type !== 'assistant_message' && event.type !== 'task_completed_summary') return null
  const content = toDisplayText(event.payload?.content)
  if (!content.trim()) return null
  return {
    id: `runtime_${event.id || `${event.type}_${event.created_at}`}`,
    role: 'assistant',
    content,
    timestamp: toDisplayText(event.created_at, new Date().toISOString()),
  }
}

function mergeRuntimeMessages(messages: ChatMsg[], events: AutoCodeRuntimeEvent[] | undefined): ChatMsg[] {
  const next = [...messages]
  const seen = new Set(next.map(msg => msg.id))
  const seenKeys = new Set(next.map(messageKey))
  for (const event of Array.isArray(events) ? events : []) {
    const msg = runtimeEventToChatMessage(event)
    if (!msg || seen.has(msg.id) || seenKeys.has(messageKey(msg))) continue
    next.push(msg)
    seen.add(msg.id)
    seenKeys.add(messageKey(msg))
  }
  return next
}

function normalizePlan(plan?: TaskPlan | null): TaskPlan | undefined {
  if (!plan || typeof plan !== 'object') return undefined
  const rawSubtasks = Array.isArray(plan.subtasks) ? plan.subtasks : []
  const subtasks = rawSubtasks.map((st, index) => ({
    id: toDisplayText(st?.id, `st-${index}`),
    title: toDisplayText(st?.title, `子任务 ${index + 1}`),
    description: toDisplayText(st?.description),
    agent_type: toDisplayText(st?.agent_type),
    estimated_files: toTextArray(st?.estimated_files),
    dependencies: toTextArray(st?.dependencies),
    status: toDisplayText(st?.status, 'pending'),
    progress: toNumberValue(st?.progress, 0),
  }))
  const validIds = new Set(subtasks.map(st => st.id))
  const executionGroups = Array.isArray(plan.execution_groups)
    ? plan.execution_groups
        .filter(Array.isArray)
        .map(group => group.map(id => toDisplayText(id)).filter(id => id && validIds.has(id)))
        .filter(group => group.length > 0)
    : []
  const techStack = plan.tech_stack && typeof plan.tech_stack === 'object'
    ? Object.fromEntries(Object.entries(plan.tech_stack).map(([key, value]) => [toDisplayText(key), toDisplayText(value)]))
    : undefined

  return {
    overall_approach: toDisplayText(plan.overall_approach),
    architecture: toDisplayText(plan.architecture),
    tech_stack: techStack,
    subtasks,
    execution_groups: executionGroups,
  }
}

function normalizeReviewIssue(issue: AutoCodeReviewIssue): AutoCodeReviewIssue {
  const rule = toDisplayText(issue?.rule)
  const message = toDisplayText(issue?.message)
  return {
    level: (['error', 'warn', 'info'].includes(toDisplayText(issue?.level)) ? toDisplayText(issue?.level) : 'info') as AutoCodeReviewIssue['level'],
    rule,
    file: toDisplayText(issue?.file),
    message: normalizeReviewTextByRule(rule, message, 'message'),
  }
}

function normalizeReview(review?: ReviewResult | null): ReviewResult | undefined {
  if (!review || typeof review !== 'object') return undefined
  const rawIssues = Array.isArray(review.issues) ? review.issues.map(normalizeReviewIssue) : []
  const primaryRule = rawIssues.find(issue => issue.rule)?.rule || ''
  const rawSummary = toDisplayText(review.summary)
  return {
    ...review,
    passed: Boolean(review.passed),
    score: toNumberValue(review.score, 0),
    summary: normalizeReviewTextByRule(primaryRule, rawSummary, 'summary'),
    issues: rawIssues,
    phase: toDisplayText(review.phase),
    reviewed_at: toDisplayText(review.reviewed_at),
    subtasks: Array.isArray(review.subtasks)
      ? review.subtasks.map((st, index) => ({
          id: toDisplayText(st?.id, `review-st-${index}`),
          title: toDisplayText(st?.title, `子任务 ${index + 1}`),
          agent_type: toDisplayText(st?.agent_type),
        }))
      : undefined,
  }
}

function normalizePrototype<T extends AutoCodeTask['prototype'] | PrototypeRecord>(prototype?: T | null): T | undefined {
  if (!prototype || typeof prototype !== 'object') return undefined
  const elements = Array.isArray(prototype.excalidraw?.elements)
    ? prototype.excalidraw.elements.map((el, index) => ({
        ...el,
        id: toDisplayText(el.id, `el-${index}`),
        type: toDisplayText(el.type, 'rectangle') as ExcalidrawElement['type'],
        text: toDisplayText(el.text),
        strokeColor: toDisplayText(el.strokeColor, '#1e293b'),
        backgroundColor: toDisplayText(el.backgroundColor),
        strokeStyle: toDisplayText(el.strokeStyle),
        x: toNumberValue(el.x, 0),
        y: toNumberValue(el.y, 0),
        width: toNumberValue(el.width, 100),
        height: toNumberValue(el.height, 50),
        fontSize: el.fontSize === undefined ? undefined : toNumberValue(el.fontSize, 14),
        strokeWidth: el.strokeWidth === undefined ? undefined : toNumberValue(el.strokeWidth, 1),
      }))
    : []
  return {
    ...prototype,
    id: toDisplayText(prototype.id),
    prototype_id: toDisplayText(prototype.prototype_id),
    title: toDisplayText(prototype.title),
    description: toDisplayText(prototype.description),
    kind: prototype.kind === 'html' ? 'html' : 'excalidraw',
    html: toDisplayText(prototype.html),
    preview_url: toDisplayText(prototype.preview_url),
    features: toTextArray(prototype.features),
    excalidraw: {
      ...(prototype.excalidraw || {}),
      type: toDisplayText(prototype.excalidraw?.type, 'excalidraw'),
      version: toNumberValue(prototype.excalidraw?.version, 2),
      elements,
      appState: prototype.excalidraw?.appState,
    },
  } as T
}

function normalizeCommandRecord(cmd: AutoCodeCommandRecord): AutoCodeCommandRecord {
  const status = toDisplayText(cmd?.status, 'failed')
  return {
    id: toDisplayText(cmd?.id, `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`),
    command: toDisplayText(cmd?.command),
    label: toDisplayText(cmd?.label),
    status: (status === 'running' || status === 'success' || status === 'failed' ? status : 'failed') as AutoCodeCommandRecord['status'],
    source: toDisplayText(cmd?.source),
    output: toDisplayText(cmd?.output),
    exit_code: cmd?.exit_code === null || cmd?.exit_code === undefined ? null : toNumberValue(cmd.exit_code, 1),
    started_at: toDisplayText(cmd?.started_at),
    finished_at: cmd?.finished_at === null ? null : toDisplayText(cmd?.finished_at),
  }
}

function formatCommandSource(source?: string): string {
  const key = toDisplayText(source)
  if (key === 'manual') return '手动终端'
  if (key === 'chat') return 'AI 助手'
  if (key === 'pipeline') return '项目流水线'
  if (key === 'phase_ci') return '阶段 CI'
  if (key === 'agent') return 'Agent'
  return key || '系统'
}

function normalizePipelineRun(run: AutoCodePipelineRun): AutoCodePipelineRun {
  return {
    status: toDisplayText(run?.status),
    steps: Array.isArray(run?.steps) ? run.steps.map(normalizeCommandRecord) : [],
    created_at: toDisplayText(run?.created_at),
    preview_status: toDisplayText(run?.preview_status),
    preview_url: toDisplayText(run?.preview_url),
    preview_error: toDisplayText(run?.preview_error),
  }
}

function normalizeWorkspaceFile(file: AutoCodeWorkspaceFile): AutoCodeWorkspaceFile {
  const rawType = toDisplayText(file?.type).toLowerCase()
  const type = rawType === 'dir' || rawType === 'directory' ? 'dir' : 'file'
  return {
    name: toDisplayText(file?.name),
    path: toDisplayText(file?.path),
    type,
    size: toNumberValue(file?.size, 0),
    modified: toDisplayText(file?.modified),
  }
}

function normalizeGitStatus(status: AutoCodeGitStatus): AutoCodeGitStatus {
  return {
    available: Boolean(status?.available),
    branch: toDisplayText(status?.branch),
    head: toDisplayText(status?.head),
    dirty: Boolean(status?.dirty),
    error: toDisplayText(status?.error),
    changes: Array.isArray(status?.changes)
      ? status.changes.map(change => ({
          status: toDisplayText(change?.status),
          path: toDisplayText(change?.path),
          old_path: change?.old_path === null ? null : toDisplayText(change?.old_path),
          staged: Boolean(change?.staged),
          working_tree: Boolean(change?.working_tree),
        }))
      : [],
  }
}

function normalizeGitCommit(commit: AutoCodeGitCommit): AutoCodeGitCommit {
  return {
    hash: toDisplayText(commit?.hash),
    message: toDisplayText(commit?.message),
    author: toDisplayText(commit?.author),
    date: toDisplayText(commit?.date),
    files_changed: toTextArray(commit?.files_changed),
    metadata: commit?.metadata ? {
      autocode_snapshot: Boolean(commit.metadata.autocode_snapshot),
      task_id: toDisplayText(commit.metadata.task_id),
      task_title: toDisplayText(commit.metadata.task_title),
      agent: toDisplayText(commit.metadata.agent),
      phase: toDisplayText(commit.metadata.phase),
      iteration: commit.metadata.iteration === undefined ? undefined : toNumberValue(commit.metadata.iteration, 0),
      trigger_prompt: toDisplayText(commit.metadata.trigger_prompt),
      changed_files: toTextArray(commit.metadata.changed_files),
      created_at: toDisplayText(commit.metadata.created_at),
    } : null,
  }
}

type BackendAutoCodeTask = Awaited<ReturnType<typeof listAutoCodeTasks>>[number]

function backendTaskToUiTask(bt: BackendAutoCodeTask): AutoCodeTask {
  const status = mapBackendStatus(bt.status || 'pending')
  const isRunning = status === 'running' || status === 'pending'
  const historyMsgs = logsToMessages(bt.logs || [])
  const hasLocalRunnerBinding = Boolean(
    bt.local_runner?.session_id
    || bt.local_runner_session_id
    || bt.local_runner?.connected,
  )
  const isLocalImportReady = Boolean(bt.local_execution_enabled && hasLocalRunnerBinding && bt.project_type === 'imported')
  const statusHeader: ChatMsg | null = isLocalImportReady && status === 'completed'
    ? null
    : status === 'completed'
      ? { id: `sys_${bt.id}_done`, role: 'assistant', content: `✅ 任务 **${bt.title}** 已完成`, timestamp: new Date().toISOString() }
    : status === 'failed'
      ? { id: `sys_${bt.id}_failed`, role: 'assistant', content: `❌ 任务 **${bt.title}** 执行失败`, timestamp: new Date().toISOString() }
      : status === 'stopped'
        ? { id: `sys_${bt.id}_stopped`, role: 'assistant', content: `⏹ 任务 **${bt.title}** 已停止`, timestamp: new Date().toISOString() }
        : { id: `sys_${bt.id}_running`, role: 'assistant', content: `🔄 任务 **${bt.title}** 正在运行中，已自动恢复连接...`, timestamp: new Date().toISOString() }

  return {
    id: `remote_${bt.id}`,
    title: toDisplayText(bt.title, '未命名任务'),
    description: toDisplayText(bt.description),
    projectType: toDisplayText(bt.project_type, 'website'),
    techStack: '',
    status,
    progress: bt.progress ?? 0,
    currentStep: toDisplayText(bt.current_step, isRunning ? '同步恢复中...' : ''),
    workspaceId: toDisplayText(bt.workspace_id),
    previewUrl: toDisplayText(bt.preview_url),
    model: toDisplayText(bt.model),
    toolPolicy: normalizeToolPolicy(bt.tool_policy),
    pendingConfirmation: bt.pending_confirmation ?? null,
    localExecutionEnabled: Boolean(bt.local_execution_enabled),
    localRunner: mergeLocalRunnerStatus(bt.local_runner, {
      enabled: Boolean(bt.local_execution_enabled || bt.local_runner?.enabled),
      connected: Boolean(bt.local_runner?.connected),
      connection_state: bt.local_runner?.connected ? 'connected' : bt.local_runner?.connection_state,
      session_id: bt.local_runner?.session_id || bt.local_runner_session_id,
    }),
    localImportMode: Boolean(bt.local_import_mode),
    cloudSnapshotEnabled: Boolean(bt.cloud_snapshot_enabled),
    cloudSnapshotStatus: toDisplayText(bt.cloud_snapshot_status),
    cloudSnapshotError: toDisplayText(bt.cloud_snapshot_error),
    backendTaskId: toDisplayText(bt.id),
    plan: normalizePlan(bt.plan),
    review: normalizeReview(bt.review),
    phase_reviews: Array.isArray(bt.phase_reviews) ? bt.phase_reviews.map(normalizeReview).filter(Boolean) as ReviewResult[] : [],
    prototype: normalizePrototype(bt.prototype),
    plan_confirmed: bt.plan_confirmed,
    prototype_confirmed: bt.prototype_confirmed,
    review_confirmed: bt.review_confirmed,
    executionActive: bt.execution_active,
    runtimeState: toDisplayText(bt.runtime_state),
    runtimeNote: toDisplayText(bt.runtime_note),
    projectRecon: bt.project_recon,
    complexity: toDisplayText(bt.complexity),
    recommendedFlow: toDisplayText(bt.recommended_flow),
    prototypeRequired: bt.prototype_required,
    pipelineStatus: toDisplayText(bt.pipeline_status),
    previewStatus: toDisplayText(bt.preview_status),
    previewError: toDisplayText(bt.preview_error),
    commandHistory: Array.isArray(bt.command_history) ? bt.command_history.map(normalizeCommandRecord) : [],
    pipelineRuns: Array.isArray(bt.pipeline_runs) ? bt.pipeline_runs.map(normalizePipelineRun) : [],
    events: Array.isArray(bt.events) ? bt.events : [],
    createdAt: toDisplayText(bt.created_at, new Date().toISOString()),
    messages: statusHeader
      ? (historyMsgs.length > 0 ? [...historyMsgs, statusHeader] : [statusHeader])
      : historyMsgs,
    logs: [],
  }
}

function messageKey(msg: ChatMsg): string {
  return [
    msg.role,
    msg.content.trim(),
    msg.toolName || '',
    msg.toolDescription || '',
  ].join('|')
}

function mergeChatMessages(existing: ChatMsg[], incoming: ChatMsg[]): ChatMsg[] {
  const merged = [...existing]
  const seenIds = new Set(existing.map(m => m.id).filter(Boolean))
  const seenKeys = new Set(existing.map(messageKey))

  for (const msg of incoming) {
    const id = msg.id || ''
    const key = messageKey(msg)
    if ((id && seenIds.has(id)) || seenKeys.has(key)) continue
    merged.push(msg)
    if (id) seenIds.add(id)
    seenKeys.add(key)
  }

  return merged
}

function collectReviewChangedFiles(task: AutoCodeTask): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const reviews = [...(task.phase_reviews || []), task.review].filter(Boolean) as ReviewResult[]

  for (const review of reviews) {
    const artifacts = (review.dimensions?.phase_artifacts ?? {}) as { changed_files?: unknown }
    for (const file of toTextArray(artifacts.changed_files)) {
      if (seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
  }

  return files
}

function buildTaskCompletionSummary(task: AutoCodeTask): ChatMsg | null {
  if (!['completed', 'failed', 'stopped'].includes(task.status)) return null

  const isCompleted = task.status === 'completed'
  const isFailed = task.status === 'failed'
  const reviews = task.phase_reviews || []
  const passedReviews = reviews.filter(r => r.passed).length
  const latestReview = reviews[reviews.length - 1] || task.review
  const ci = (latestReview?.dimensions?.ci ?? {}) as {
    status?: string
    command?: string
    exit_code?: number | null
  }
  const changedFiles = collectReviewChangedFiles(task)
  const statusLabel = isCompleted ? '已完成' : isFailed ? '失败' : '已停止'

  const lines = [
    `### 任务${statusLabel}`,
    '',
    `任务：${task.title}`,
    `当前状态：${statusLabel}${task.currentStep ? `，${task.currentStep}` : ''}`,
  ]

  if (reviews.length > 0) {
    lines.push(`阶段审查：${passedReviews}/${reviews.length} 组通过`)
  } else if (task.review) {
    lines.push(`代码审查：${task.review.passed ? '通过' : '未通过'}，评分 ${task.review.score ?? 0}/100`)
  }

  if (ci.status) {
    lines.push(`CI / 验证：${ci.status}${typeof ci.exit_code === 'number' ? `，退出码 ${ci.exit_code}` : ''}`)
    if (ci.command) lines.push(`验证命令：\`${ci.command}\``)
  }

  if (changedFiles.length > 0) {
    lines.push('', '主要变更文件：')
    changedFiles.slice(0, 12).forEach(file => lines.push(`- \`${file}\``))
    if (changedFiles.length > 12) lines.push(`- 另有 ${changedFiles.length - 12} 个文件`)
  }

  if (task.previewUrl) {
    lines.push('', `预览地址：${task.previewUrl}`)
  }

  if (latestReview?.summary) {
    lines.push('', `审查结论：${latestReview.summary}`)
  }

  if (!isCompleted) {
    lines.push('', '可以直接在这里继续说明要修复的问题，我会基于当前工作区继续处理。')
  } else {
    lines.push('', '后续你直接描述目标、问题或体验反馈即可，AI 会判断是否需要继续修改、运行验证并生成新快照。')
  }

  return {
    id: `completion_${task.backendTaskId || task.id}_${task.status}`,
    role: 'assistant',
    content: lines.join('\n'),
    timestamp: new Date().toISOString(),
  }
}

function isTerminalTaskStatus(status: AutoCodeTask['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped'
}

function mergeBackendTaskIntoUiTask(current: AutoCodeTask, backendTask: BackendAutoCodeTask): AutoCodeTask {
  const refreshed = backendTaskToUiTask(backendTask)
  const mergedEvents = mergeRuntimeEvents(current.events, refreshed.events)
  const wasTerminal = isTerminalTaskStatus(current.status)
  const isNowTerminal = isTerminalTaskStatus(refreshed.status)
  const merged: AutoCodeTask = {
    ...current,
    ...refreshed,
    id: current.id,
    messages: mergeRuntimeMessages(mergeChatMessages(current.messages, refreshed.messages), mergedEvents),
    logs: current.logs,
    events: mergedEvents,
  }
  const shouldAppendCompletionSummary = !wasTerminal && isNowTerminal
  const completionSummary = shouldAppendCompletionSummary ? buildTaskCompletionSummary(merged) : null
  return completionSummary
    ? { ...merged, messages: mergeChatMessages(merged.messages, [completionSummary]) }
    : merged
}

function normalizeAutoCodeLogText(value: unknown): string {
  const raw = toDisplayText(value)
  if (!raw) return ''
  let text = fallbackReadableLog(raw)
    .replace(/\[frontend\]\s*validation gate:\s*remind Agent to run validation/gi, '[frontend] 验证提醒：Agent 需要运行验证命令')
    .replace(/validation gate:\s*remind Agent to run validation/gi, '验证提醒：Agent 需要运行验证命令')
    .replace(new RegExp("\u5bb8\u30e5\u53ff\u93c9\u51ae\u6aba\u7edb\u682b\u6690\u5bb8\u63d2\u578f\u93b9\ue76d\u8d1f", 'g'), '工具权限策略已切换为')
    .replace(new RegExp("\u5bb8\u30e5\u53ff\u93c9\u51ae\u6aba\u7edb\u682b\u6690", 'g'), '工具权限策略')
    .replace(new RegExp("\u5bb8\u63d2\u578f\u93b9\ue76d\u8d1f", 'g'), '已切换为')
  if (!hasMojibake(text)) return text
  if (/tool policy|auto_safe|full_access|request_approval|ask/i.test(text)) {
    return text
      .replace(new RegExp("[\ufffd]+", 'g'), '')
      .replace(new RegExp("\u5bb8\u30e5\u53ff", 'g'), '工具')
      .replace(new RegExp("\u93c9\u51ae\u6aba", 'g'), '权限')
      .replace(new RegExp("\u7edb\u682b\u6690", 'g'), '策略')
  }
  return '系统事件已记录，原始文本存在编码异常。'
}

// 将后端 logs（工具调用+Agent响应）转换为前端 ChatMsg 对话历史
function logsToMessages(logs: Record<string, unknown>[]): ChatMsg[] {
  if (!logs || logs.length === 0) return []

  const msgs: ChatMsg[] = []
  const hasChatAssistantLogs = logs.some(l => (l.level as string) === 'chat_assistant')
  let lastRole: string = ''
  let batchContent = ''
  let batchStart = ''

  const flushBatch = () => {
    if (batchContent) {
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: lastRole as 'user' | 'assistant' | 'system',
        content: batchContent,
        timestamp: batchStart,
      })
      batchContent = ''
    }
  }

  for (const l of logs) {
    const msg = normalizeAutoCodeLogText(l.message)
    const level = toDisplayText(l.level, 'info')
    const agent = toDisplayText(l.agent)
    const ts = toDisplayText(l.timestamp)
    const detail = normalizeAutoCodeLogText(l.detail)
    const toolName = toDisplayText(l.tool_name)
    const phase = normalizeAutoCodeLogText(l.phase)

    // 计费上报属于后台诊断，不应该混进 AI 助手聊天流。
    if (agent === 'billing') continue

    // 跳过迭代计数噪声
    if (/Agent\s*\[.*\]\s*第\s*\d+\s*次迭代/.test(msg)) continue
    if (msg.startsWith('📨 收到')) continue  // 内部消息注入通知

    if (level === 'chat_user') {
      flushBatch()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content: msg,
        timestamp: ts,
      })
      continue
    }

    if (level === 'chat_assistant') {
      flushBatch()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content: msg,
        timestamp: ts,
      })
      continue
    }

    if (level === 'tool_progress') {
      flushBatch()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'system',
        content: msg,
        timestamp: ts,
        toolName: toolName || msg.split(':')[0].trim(),
        toolDescription: msg,
        toolResult: detail ? detail.slice(0, 160) : undefined,
      })
      continue
    }

    if (level === 'phase_progress') {
      flushBatch()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'system',
        content: msg || phase,
        timestamp: ts,
        toolDescription: detail || phase,
      })
      continue
    }

    // 工具调用 → 系统消息
    if (msg.startsWith('执行工具:') || msg.startsWith('Executing:')) {
      const toolName = msg.replace('执行工具:', '').replace('Executing:', '').split('(')[0].trim()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'system',
        content: msg,
        timestamp: ts,
        toolName: toolName,
        toolDescription: msg,
      })
      continue
    }

    // 工具结果 → 系统消息（附加到上一个工具调用）
    if (msg.startsWith('已写入:') || msg.startsWith('命令退出码') || msg.startsWith('✅') && detail) {
      const lastSys = [...msgs].reverse().find(m => m.role === 'system' && m.toolName)
      if (lastSys && lastSys.toolResult === undefined) {
        lastSys.toolResult = msg.slice(0, 120)
      } else {
        msgs.push({
          id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'system',
          content: msg,
          timestamp: ts,
          toolName: msg.split(':')[0].trim(),
          toolResult: msg.slice(0, 120),
        })
      }
      continue
    }

    // error/warn → 系统消息
    if (level === 'error' || level === 'warn') {
      flushBatch()
      msgs.push({
        id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'system',
        content: `⚠️ ${msg}`,
        timestamp: ts,
      })
      continue
    }

    // success/info → AI 回复（可能是多个段落）
    if (level === 'success' || level === 'info') {
      if (hasChatAssistantLogs && level === 'success' && agent !== 'system' && agent !== 'orchestrator') {
        continue
      }
      const role = level === 'success' ? 'assistant' : 'system'
      if (role !== lastRole && batchContent) {
        flushBatch()
      }
      if (!batchContent) {
        batchStart = ts
        lastRole = role
      }
      batchContent += (batchContent ? '\n\n' : '') + msg
      continue
    }
  }

  flushBatch()
  return msgs
}

const AUTOCODE_API = import.meta.env.VITE_AUTOCODE_API_URL || '/autocode-api'
const AUTOCODE_URL = import.meta.env.VITE_AUTOCODE_URL || 'http://localhost:3000'

function getPublicAutoCodeApiBase(): string {
  const fallbackPath = '/autocode-api'
  try {
    const configured = String(AUTOCODE_API || fallbackPath)
    const parsed = new URL(configured, window.location.origin)
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : fallbackPath
    return `${window.location.origin}${path}`.replace(/\/$/, '')
  } catch {
    return `${window.location.origin}${fallbackPath}`.replace(/\/$/, '')
  }
}

function formatBeijingDateTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getCurrentAuthUserId(): string {
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return ''
    const store = JSON.parse(raw)
    return store?.state?.user?.id || ''
  } catch {
    return ''
  }
}

function appendWorkspaceAccess(url: string, userId = getCurrentAuthUserId()): string {
  if (!url || !userId || !url.includes('/workspaces/')) return url
  try {
    const parsed = new URL(url, window.location.origin)
    if (!parsed.searchParams.get('user_id') && !parsed.searchParams.get('userId')) {
      parsed.searchParams.set('user_id', userId)
    }
    return parsed.toString()
  } catch {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}user_id=${encodeURIComponent(userId)}`
  }
}

// ──────────────────────────────────────────
// AutoCodePage
// ──────────────────────────────────────────

export default function AutoCodePage({ onNavigate }: { onNavigate?: (page: AppPage) => void }) {
  const { user, logout } = useAuthStore()
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [tasks, setTasks] = useState<AutoCodeTask[]>([])
  const [tasksLoading, setTasksLoading] = useState(true) // 初始加载标记，显示骨架屏
  const [tasksError, setTasksError] = useState('') // 加载失败提示
  const [queueStatus, setQueueStatus] = useState<AutoCodeQueueStatus | null>(null)
  const [queueStatusError, setQueueStatusError] = useState('')
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [newTaskOpen, setNewTaskOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [planningDialogTaskId, setPlanningDialogTaskId] = useState<string | null>(null)
  const [planningObjective, setPlanningObjective] = useState('')
  const [planningContext, setPlanningContext] = useState('')
  const [planningSubmitting, setPlanningSubmitting] = useState(false)
  const [importGitUrl, setImportGitUrl] = useState('')
  const [importName, setImportName] = useState('')
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('preview')

  // AI 对话
  const [chatLoading, setChatLoading] = useState(false)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const chatAbortRef = useRef<AbortController | null>(null) // 对话 SSE 中止控制器
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'mock'>('disconnected')
  const activeTaskRef = useRef<AutoCodeTask | null>(null) // 保持最新 activeTask 引用
  const notifiedKeysRef = useRef<Set<string>>(new Set())
  const autoConnectGrantRef = useRef('')
  const autoConnectNoMatchWarnedRef = useRef('')
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0) // 预览自动刷新
  const [chatPanelWidth, setChatPanelWidth] = useState(360) // 对话面板宽度（可拖拽调整）
  const [workspaceOpenFileRequest, setWorkspaceOpenFileRequest] = useState<{ path: string; line?: number } | null>(null)
  const [gitFocusTarget, setGitFocusTarget] = useState<string | null>(null)
  const [toolDisplayRegistry, setToolDisplayRegistry] = useState<ToolDisplayMap>(TOOL_DISPLAY)
  const toolDisplayRegistryRef = useRef<ToolDisplayMap>(TOOL_DISPLAY)

  useEffect(() => {
    toolDisplayRegistryRef.current = toolDisplayRegistry
  }, [toolDisplayRegistry])

  useEffect(() => {
    let cancelled = false
    listAutoCodeTools()
      .then(data => {
        if (cancelled) return
        const next: ToolDisplayMap = { ...TOOL_DISPLAY }
        for (const spec of data.tools || []) {
          if (!spec?.name) continue
          next[spec.name] = {
            label: spec.label || spec.name,
            action: spec.action || spec.name,
            purpose: spec.purpose || spec.description || '执行 Agent 选择的工作区操作。',
          }
        }
        setToolDisplayRegistry(next)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  // UI 原型

  // 导入弹窗
  const [importTab, setImportTab] = useState<'git' | 'upload' | 'local'>('git')
  const [importUploadFile, setImportUploadFile] = useState<File | null>(null)
  const [importEnableSmartPlanning, setImportEnableSmartPlanning] = useState(false)
  const [localRunnerConnected, setLocalRunnerConnected] = useState(false)
  const [localRunnerProjectRoot, setLocalRunnerProjectRoot] = useState('')
  const [localImportProjectPath, setLocalImportProjectPath] = useState('')
  const [localImportRunner, setLocalImportRunner] = useState<AutoCodeLocalRunnerStatus | null>(null)
  const [localImportSessionLoading, setLocalImportSessionLoading] = useState(false)
  const [syncLocalSnapshots, setSyncLocalSnapshots] = useState(false)
  const [importRunnerCommandCopied, setImportRunnerCommandCopied] = useState(false)
  const [localProjectGrants, setLocalProjectGrants] = useState<AutoCodeLocalProjectGrant[]>([])
  const [selectedLocalGrantId, setSelectedLocalGrantId] = useState('')
  const localImportRunnerCommand = localImportRunner?.command || `正在生成连接命令...`
  const localImportRunnerUpdateRequired = Boolean(localImportRunner?.connector_update_required)

  const copyImportRunnerCommand = useCallback(async () => {
    if (!localImportRunner?.command) {
      toast.warning('连接命令还在生成，请稍后再复制')
      return
    }
    try {
      await navigator.clipboard.writeText(localImportRunner.command)
      setImportRunnerCommandCopied(true)
      toast.success('启动命令已复制')
      window.setTimeout(() => setImportRunnerCommandCopied(false), 1600)
    } catch {
      toast.error('复制失败，请手动选择命令复制')
    }
  }, [localImportRunner?.command])
  const handleLaunchLocalImportConnector = useCallback(() => {
    if (!localImportRunner?.launch_url) {
      toast.warning('请先生成本地连接会话')
      return
    }
    window.location.href = localImportRunner.launch_url
    toast.info('正在唤起本地连接器', { description: '如果没有安装，会提示你先安装连接器。' })
  }, [localImportRunner?.launch_url])

  const createLocalImportRunner = useCallback(async (force = false) => {
    if (!force && localImportRunner?.session_id) return
    setLocalImportSessionLoading(true)
    setImportError('')
    try {
      const selectedGrant = localProjectGrants.find(item => item.grant_id === selectedLocalGrantId)
      const status = await createAutoCodeLocalRunnerSession(
        selectedGrant ? '' : localImportProjectPath.trim(),
        getPublicAutoCodeApiBase(),
        selectedGrant?.grant_id || '',
      )
      setLocalImportRunner(status)
      setLocalRunnerConnected(Boolean(status.connected))
      setLocalRunnerProjectRoot(status.project_root || selectedGrant?.project_root || '')
      if (selectedGrant?.project_root) setLocalImportProjectPath(selectedGrant.project_root)
      toast.success('本地连接命令已生成')
    } catch (err) {
      setImportError((err as Error).message || '生成本地连接命令失败')
    } finally {
      setLocalImportSessionLoading(false)
    }
  }, [localImportProjectPath, localImportRunner?.session_id, localProjectGrants, selectedLocalGrantId])

  const handleUseLocalGrant = useCallback(async (grant: AutoCodeLocalProjectGrant) => {
    setSelectedLocalGrantId(grant.grant_id)
    setLocalImportProjectPath(grant.project_root || '')
    setLocalImportRunner(null)
    setLocalRunnerConnected(false)
    setLocalRunnerProjectRoot('')
    setLocalImportSessionLoading(true)
    setImportError('')
    try {
      const status = await createAutoCodeLocalRunnerSession('', getPublicAutoCodeApiBase(), grant.grant_id)
      setLocalImportRunner(status)
      setLocalRunnerConnected(Boolean(status.connected))
      setLocalRunnerProjectRoot(status.project_root || grant.project_root || '')
      toast.success('已使用授权项目生成连接会话')
      if (status.launch_url) {
        window.setTimeout(() => {
          window.location.href = status.launch_url || ''
        }, 50)
      }
    } catch (err) {
      setImportError((err as Error).message || '使用授权项目失败')
    } finally {
      setLocalImportSessionLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!importOpen || importTab !== 'local') return
    void createLocalImportRunner(false)
  }, [createLocalImportRunner, importOpen, importTab])

  useEffect(() => {
    if (!importOpen || importTab !== 'local') return
    let cancelled = false
    listAutoCodeLocalProjectGrants()
      .then(items => {
        if (!cancelled) setLocalProjectGrants(items)
      })
      .catch(() => {
        if (!cancelled) setLocalProjectGrants([])
      })
    return () => { cancelled = true }
  }, [importOpen, importTab])

  useEffect(() => {
    if (!importOpen || importTab !== 'local' || !localImportRunner?.session_id) return
    let cancelled = false
    const refresh = async () => {
      try {
        const status = await getAutoCodeLocalRunnerSessionStatus(localImportRunner.session_id!)
        if (cancelled) return
        setLocalImportRunner(prev => mergeLocalRunnerStatus(prev || undefined, status) || prev)
        setLocalRunnerConnected(Boolean(status.connected))
        setLocalRunnerProjectRoot(status.project_root || '')
      } catch {
        if (!cancelled) setLocalRunnerConnected(false)
      }
    }
    void refresh()
    const timer = window.setInterval(refresh, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [importOpen, importTab, localImportRunner?.session_id])

  const activeTask = tasks.find(t => t.id === activeTaskId) ?? null
  activeTaskRef.current = activeTask

  useEffect(() => {
    const requestedTaskId = new URLSearchParams(window.location.search).get('task_id') || ''
    if (!requestedTaskId || tasks.length === 0) return
    const matched = tasks.find(t => t.backendTaskId === requestedTaskId || t.id === requestedTaskId || t.id === `remote_${requestedTaskId}`)
    if (!matched || activeTaskId === matched.id) return
    setActiveTaskId(matched.id)
    setActiveTab('events')
  }, [activeTaskId, tasks])

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedTaskId = params.get('task_id') || ''
    const grantId = params.get('local_grant_id') || ''
    const projectPath = params.get('local_project_path') || ''
    if ((!requestedTaskId && !grantId && !projectPath) || tasks.length === 0) return
    const dedupeKey = `${requestedTaskId}:${grantId}:${projectPath}`
    if (autoConnectGrantRef.current === dedupeKey) return
    let cancelled = false
    void (async () => {
      let targetTaskId = requestedTaskId
      let targetGrantId = grantId
      let targetProjectPath = projectPath
      if (grantId) {
        try {
          const grants = await listAutoCodeLocalProjectGrants()
          const grant = grants.find(item => item.grant_id === grantId)
          targetTaskId = targetTaskId || grant?.task_id || ''
          targetProjectPath = targetProjectPath || grant?.project_root || ''
          targetGrantId = targetGrantId || grant?.grant_id || ''
        } catch {
          // Falling back to URL parameters is enough here.
        }
      }
      if (cancelled) return
      const normalizedTargetPath = normalizeLocalProjectPath(targetProjectPath)
      const matched = tasks.find(t => (
        (targetTaskId && (t.backendTaskId === targetTaskId || t.id === targetTaskId || t.id === `remote_${targetTaskId}`))
        || (normalizedTargetPath && normalizeLocalProjectPath(t.localRunner?.project_root) === normalizedTargetPath)
        || (normalizedTargetPath && normalizeLocalProjectPath(t.title) === normalizedTargetPath.split('/').pop())
      ))
      if (!matched) {
        // 任务列表可能分批到达：此处不落 dedupe，允许 tasks 更新后重试，
        // 仅对同一组参数提示一次，避免刷屏。
        if (autoConnectNoMatchWarnedRef.current !== dedupeKey) {
          autoConnectNoMatchWarnedRef.current = dedupeKey
          toast.info('已进入代码开发', { description: '正在等待任务加载，如未自动打开请从左侧任务列表选择一次。' })
        }
        return
      }
      autoConnectGrantRef.current = dedupeKey
      setActiveTaskId(matched.id)
      setActiveTab('events')
      if (!matched.backendTaskId || !targetGrantId) return
      try {
        const status = await setAutoCodeLocalRunnerMode(matched.backendTaskId, true, {
          public_api_base: getPublicAutoCodeApiBase(),
          grant_id: targetGrantId,
        })
        if (cancelled) return
        setTasks(prev => prev.map(t =>
          t.id === matched.id
            ? { ...t, localExecutionEnabled: Boolean(status.enabled), localRunner: mergeLocalRunnerStatus(t.localRunner, status) }
            : t
        ))
        if (status.launch_url) {
          window.setTimeout(() => {
            window.location.href = status.launch_url || ''
          }, 80)
        }
      } catch (err) {
        if (!cancelled) toast.error('本地项目快速连接失败', { description: (err as Error).message || '请手动点击本地执行连接。' })
      }
    })()
    return () => { cancelled = true }
  }, [tasks])

  const notifyTaskSignal = useCallback((
  key: string,
  title: string,
  body: string,
  variant: 'success' | 'error' | 'warning' | 'info' = 'info',
  notifyType: 'taskComplete' | 'operationApproval' = 'taskComplete',
) => {
    if (notifiedKeysRef.current.has(key)) return
    notifiedKeysRef.current.add(key)
    notifyAutoCodeUser(key, title, body, variant, notifyType)
  }, [])

  const notifyStatusChange = useCallback((task: AutoCodeTask | null, rawStatus?: unknown, currentStep?: unknown) => {
    if (!task) return
    const status = mapBackendStatus(toDisplayText(rawStatus)) || task.status
    const body = compactText(currentStep || task.currentStep || '请回到 AutoCode 查看详情。', 180)
    if (status === 'completed') {
      notifyTaskSignal(`${task.backendTaskId || task.id}:completed`, `AutoCode 任务已完成：${task.title}`, body, 'success')
    } else if (status === 'failed') {
      notifyTaskSignal(`${task.backendTaskId || task.id}:failed`, `AutoCode 任务失败：${task.title}`, body, 'error')
    } else if (status === 'stopped') {
      notifyTaskSignal(`${task.backendTaskId || task.id}:stopped`, `AutoCode 任务已停止：${task.title}`, body, 'warning')
    }
  }, [notifyTaskSignal])

  const refreshQueueStatus = useCallback(async () => {
    try {
      const status = await Promise.race([
        getAutoCodeQueueStatus(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('队列状态响应超时')), 10000)
        ),
      ])
      setQueueStatus(status)
      setQueueStatusError('')
    } catch (e) {
      const err = e as Error
      setQueueStatusError(err?.message || '队列状态不可用')
    }
  }, [])

  const refreshTaskDetail = useCallback(async (backendTaskId: string, uiTaskId?: string) => {
    if (!backendTaskId) return
    const detail = await getAutoCodeTask(backendTaskId)
    setTasks(prev => prev.map(t => {
      const matches = t.backendTaskId === backendTaskId || (uiTaskId ? t.id === uiTaskId : false)
      return matches ? mergeBackendTaskIntoUiTask(t, detail) : t
    }))
  }, [])

  const refreshFinishedTaskDetail = useCallback((backendTaskId: string, uiTaskId?: string) => {
    const refreshAndScroll = () => refreshTaskDetail(backendTaskId, uiTaskId)
      .then(() => {
        setPreviewRefreshKey(k => k + 1)
        setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 80)
      })
      .catch(() => { /* ignore final detail refresh errors */ })

    void refreshAndScroll()
    window.setTimeout(() => { void refreshAndScroll() }, 1200)
  }, [refreshTaskDetail])

  // ── 页面加载时从后端恢复历史任务 ──────────────────────────────
  useEffect(() => {
    let cancelled = false
    setTasksLoading(true)
    setTasksError('')
    ;(async () => {
      try {
        // 慢启动/任务恢复时后端可能需要读取持久化状态，给恢复链路更充足的时间。
        const backendTasks = await Promise.race([
          listAutoCodeTasks(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('加载超时，后端响应超过 30 秒')), 30000)
          ),
        ])
        if (cancelled) return
        void refreshQueueStatus()
        // 将后端任务映射为前端格式，只保留不在本地的（避免重复）
        setTasks(prev => {
          const localIds = new Set(prev.map(t => t.backendTaskId).filter(Boolean))
          const newTasks = backendTasks
            .filter(bt => !localIds.has(bt.id))
            .map(backendTaskToUiTask)
          return [...newTasks, ...prev]
        })
        // 自动激活最近的一个运行中任务
        const runningTask = backendTasks.find(bt => {
          const s = mapBackendStatus(bt.status || 'pending')
          return s === 'running' || s === 'pending'
        })
        if (runningTask) {
          setActiveTaskId(`remote_${runningTask.id}`)
          setActiveTab('preview')
        }
      } catch (e) {
        if (cancelled) return
        const err = e as Error
        setTasksError(err?.message || '后端连接失败')
      } finally {
        if (!cancelled) setTasksLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [refreshQueueStatus])

  useEffect(() => {
    void refreshQueueStatus()
    const timer = window.setInterval(() => { void refreshQueueStatus() }, 15000)
    return () => window.clearInterval(timer)
  }, [refreshQueueStatus])

  useEffect(() => {
    if (!activeTask?.backendTaskId || !activeTask.localExecutionEnabled) return
    let cancelled = false
    const refreshLocalRunner = async () => {
      try {
        const status = await getAutoCodeLocalRunnerStatus(activeTask.backendTaskId!)
        if (cancelled) return
        setTasks(prev => prev.map(t =>
          t.id === activeTask.id
            ? { ...t, localExecutionEnabled: Boolean(status.enabled), localRunner: mergeLocalRunnerStatus(t.localRunner, status) }
            : t
        ))
      } catch { /* ignore local runner status polling errors */ }
    }
    void refreshLocalRunner()
    const timer = window.setInterval(refreshLocalRunner, 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeTask?.backendTaskId, activeTask?.id, activeTask?.localExecutionEnabled])

  // 滚动到底部
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [activeTask?.messages])

  // ── SSE 实时连接（主要）+ 轮询保底 ────────────────────────────────
  useEffect(() => {
    if (!activeTask?.backendTaskId || activeTask.status === 'completed' || activeTask.status === 'failed' || activeTask.status === 'stopped') {
      // 清理 SSE
      if (esRef.current) { esRef.current.close(); esRef.current = null }
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
      return
    }

    const taskId = activeTask.backendTaskId
    // EventSource 不支持自定义请求头，通过查询参数传递 userId
    const userId = getCurrentAuthUserId()
    const es = new EventSource(`${AUTOCODE_API}/api/tasks/${taskId}/stream?userId=${encodeURIComponent(userId)}`)
    esRef.current = es
    setConnectionStatus('connecting')

    es.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data)
        const nextStatus = mapBackendStatus(data.status)
        notifyStatusChange(activeTaskRef.current, data.status, data.current_step)
        setTasks(prev => prev.map(t =>
          t.id === activeTaskId
            ? {
                ...t,
                status: nextStatus || t.status,
                progress: data.progress ?? t.progress,
                currentStep: toDisplayText(data.current_step, t.currentStep),
                previewUrl: toDisplayText(data.preview_url, t.previewUrl),
                pendingConfirmation: nextStatus === 'waiting_confirm'
                  ? (data.pending_confirmation !== undefined ? data.pending_confirmation : t.pendingConfirmation)
                  : null,
                workspaceId: toDisplayText(data.workspace_id, t.workspaceId),
                model: toDisplayText(data.model, t.model),
                toolPolicy: normalizeToolPolicy(data.tool_policy || t.toolPolicy),
                localExecutionEnabled: data.local_execution_enabled ?? t.localExecutionEnabled,
                localRunner: mergeLocalRunnerStatus(t.localRunner, data.local_runner),
                plan: normalizePlan(data.plan) || t.plan,
                review: normalizeReview(data.review) || t.review,
                phase_reviews: Array.isArray(data.phase_reviews) ? data.phase_reviews.map(normalizeReview).filter(Boolean) as ReviewResult[] : t.phase_reviews,
                plan_confirmed: data.plan_confirmed ?? t.plan_confirmed,
                prototype_confirmed: data.prototype_confirmed ?? t.prototype_confirmed,
                review_confirmed: data.review_confirmed ?? t.review_confirmed,
                prototype: normalizePrototype(data.prototype) || t.prototype,
                executionActive: data.execution_active ?? t.executionActive,
                runtimeState: toDisplayText(data.runtime_state, t.runtimeState),
                runtimeNote: toDisplayText(data.runtime_note, t.runtimeNote),
                projectRecon: data.project_recon || t.projectRecon,
                complexity: toDisplayText(data.complexity, t.complexity),
                recommendedFlow: toDisplayText(data.recommended_flow, t.recommendedFlow),
                prototypeRequired: data.prototype_required ?? t.prototypeRequired,
                pipelineStatus: toDisplayText(data.pipeline_status, t.pipelineStatus),
                previewStatus: toDisplayText(data.preview_status, t.previewStatus),
                previewError: data.preview_error !== undefined ? toDisplayText(data.preview_error) : t.previewError,
              }
            : t
        ))
        // 自动切换到预览 Tab
        if (data.status === 'completed' && data.preview_url) {
          setActiveTab('preview')
        }
        // 计划确认等待时切换到计划 Tab
        if (data.status === 'waiting_plan_confirm') {
          setActiveTab('plan')
        }
        // 原型确认等待时切换到原型 Tab
        if (data.status === 'waiting_prototype_confirm') {
          setActiveTab('prototype')
        }
        if (data.status === 'waiting_review_confirm' || data.status === 'reviewing') {
          setActiveTab('review')
        }
        setConnectionStatus('connected')
      } catch { /* ignore parse errors */ }
    })

    es.addEventListener('log', (e) => {
      try {
        const log = JSON.parse(e.data)
        const logLine = log.detail
          ? `[${log.agent}] ${log.message}\n    └ ${log.detail}`
          : `[${log.agent}] ${log.message}`
        const logMessages = logsToMessages([log])
        setTasks(prev => prev.map(t =>
          t.id === activeTaskId
            ? { ...t, logs: [...t.logs, logLine], messages: mergeChatMessages(t.messages, logMessages) }
            : t
        ))
      } catch { /* ignore parse errors */ }
    })

    es.addEventListener('command_history', (e) => {
      try {
        const data = JSON.parse(e.data)
        setTasks(prev => prev.map(t =>
          t.id === activeTaskId
            ? { ...t, commandHistory: Array.isArray(data.commands) ? data.commands.map(normalizeCommandRecord) : [] }
            : t
        ))
      } catch { /* ignore parse errors */ }
    })

    es.addEventListener('runtime_event', (e) => {
      try {
        const event = JSON.parse(e.data) as AutoCodeRuntimeEvent
        if (event.type === 'approval_requested' && shouldNotifyApprovalEvent(event, activeTaskRef.current?.toolPolicy)) {
          const summary = summarizeRuntimeEvent(event, toolDisplayRegistryRef.current)
          notifyTaskSignal(
            `${taskId}:${event.id || event.created_at}:approval_requested`,
            `AutoCode 需要批准：${activeTaskRef.current?.title || '当前任务'}`,
            summary.description || summary.title,
            'warning',
            'operationApproval',
          )
        }
        setTasks(prev => prev.map(t =>
          t.id === activeTaskId
            ? {
                ...t,
                events: mergeRuntimeEvents(t.events, [event]),
                messages: mergeRuntimeMessages(t.messages, [event]),
              }
            : t
        ))
        if (event.type === 'approval_requested') {
          setActiveTab('events')
        }
      } catch { /* ignore parse errors */ }
    })

    es.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data)
        const nextStatus = mapBackendStatus(data.status)
        setTasks(prev => prev.map(t =>
          t.id === activeTaskId
            ? {
                ...t,
                status: nextStatus || t.status,
                previewUrl: data.preview_url || t.previewUrl,
                pendingConfirmation: nextStatus === 'waiting_confirm' ? t.pendingConfirmation : null,
              }
            : t
        ))
        setActiveTab('preview')
      } catch { /* ignore */ }
      refreshFinishedTaskDetail(taskId, activeTaskId || undefined)
      es.close()
      esRef.current = null
    })

    es.onerror = () => {
      // SSE 断开，降级到轮询
      es.close()
      esRef.current = null
      setConnectionStatus('disconnected')
      if (pollRef.current) clearInterval(pollRef.current)

      pollRef.current = setInterval(async () => {
        // 用 backendTaskId（后端真实 ID）查询状态，不能用前端本地 ID
        const btId = activeTaskRef.current?.backendTaskId
        if (!btId) return
        try {
          const s = await getAutoCodeTaskStatus(btId)
          const nextStatus = mapBackendStatus(s.status)
          notifyStatusChange(activeTaskRef.current, s.status, s.current_step)
          setTasks(prev => prev.map(t =>
            t.id === activeTaskId
              ? {
                  ...t,
                  status: nextStatus || t.status,
                  progress: s.progress ?? t.progress,
                  currentStep: toDisplayText(s.current_step, t.currentStep),
                  previewUrl: toDisplayText(s.preview_url, t.previewUrl),
                  model: toDisplayText(s.model, t.model),
                  toolPolicy: normalizeToolPolicy(s.tool_policy || t.toolPolicy),
                  pendingConfirmation: nextStatus === 'waiting_confirm'
                    ? (s.pending_confirmation !== undefined ? s.pending_confirmation : t.pendingConfirmation)
                    : null,
                  localExecutionEnabled: s.local_execution_enabled ?? t.localExecutionEnabled,
                  localRunner: mergeLocalRunnerStatus(t.localRunner, s.local_runner),
                  plan: normalizePlan(s.plan) || t.plan,
                  review: normalizeReview(s.review) || t.review,
                  phase_reviews: Array.isArray(s.phase_reviews) ? s.phase_reviews.map(normalizeReview).filter(Boolean) as ReviewResult[] : t.phase_reviews,
                  review_confirmed: s.review_confirmed ?? t.review_confirmed,
                  executionActive: s.execution_active ?? t.executionActive,
                  runtimeState: toDisplayText(s.runtime_state, t.runtimeState),
                  runtimeNote: toDisplayText(s.runtime_note, t.runtimeNote),
                  projectRecon: s.project_recon || t.projectRecon,
                  complexity: toDisplayText(s.complexity, t.complexity),
                  recommendedFlow: toDisplayText(s.recommended_flow, t.recommendedFlow),
                  prototypeRequired: s.prototype_required ?? t.prototypeRequired,
                  pipelineStatus: toDisplayText(s.pipeline_status, t.pipelineStatus),
                  previewStatus: toDisplayText(s.preview_status, t.previewStatus),
                  previewError: s.preview_error !== undefined ? toDisplayText(s.preview_error) : t.previewError,
                }
              : t
          ))
          try {
            const eventData = await getAutoCodeTaskEvents(btId)
            for (const event of eventData.events || []) {
              if (event.type !== 'approval_requested' || !shouldNotifyApprovalEvent(event, activeTaskRef.current?.toolPolicy)) continue
              const summary = summarizeRuntimeEvent(event, toolDisplayRegistryRef.current)
              notifyTaskSignal(
                `${btId}:${event.id || event.created_at}:approval_requested`,
                `AutoCode 需要批准：${activeTaskRef.current?.title || '当前任务'}`,
                summary.description || summary.title,
                'warning',
                'operationApproval',
              )
            }
            setTasks(prev => prev.map(t =>
              t.id === activeTaskId
                ? {
                    ...t,
                    events: mergeRuntimeEvents(t.events, eventData.events),
                    messages: mergeRuntimeMessages(t.messages, eventData.events),
                  }
                : t
            ))
          } catch { /* 忽略事件轮询错误 */ }
          if (mapBackendStatus(s.status) === 'completed' || mapBackendStatus(s.status) === 'failed' || mapBackendStatus(s.status) === 'stopped') {
            if (pollRef.current) clearInterval(pollRef.current)
            if (s.preview_url) setActiveTab('preview')
            refreshFinishedTaskDetail(btId, activeTaskId || undefined)
          }
        } catch { /* 忽略轮询错误 */ }
      }, 3000)
    }

    return () => { es.close(); esRef.current = null }
  }, [activeTaskId, activeTask?.status, activeTask?.backendTaskId, refreshFinishedTaskDetail, notifyStatusChange, notifyTaskSignal])

  // 创建任务
  const handleCreateTask = useCallback(async (params: NewTaskParams) => {
    const localId = `task_${Date.now()}`
    const newTask: AutoCodeTask = {
      id: localId,
      title: params.title,
      description: params.description,
      projectType: params.projectType,
      techStack: params.techStack,
      model: params.model,
      toolPolicy: 'full_access',
      localExecutionEnabled: false,
      status: 'pending',
      progress: 0,
      currentStep: '准备中...',
      createdAt: new Date().toISOString(),
      messages: [
        {
          id: `sys_${Date.now()}`,
          role: 'assistant',
          content: `✅ 任务已创建！正在为你开发 **${params.title}**\n\n**技术栈**: ${params.techStack}\n**类型**: ${params.projectType === 'website' ? '网站开发' : params.projectType === 'api' ? 'API 服务' : params.projectType === 'miniapp' ? '小程序' : '工具脚本'}\n\n你可以随时在下方对话来指导开发方向、调整功能需求或查询进度。`,
          timestamp: new Date().toISOString(),
        }
      ],
      logs: ['[INFO] 任务队列中...'],
    }
    setTasks(prev => [newTask, ...prev])
    setActiveTaskId(localId)
    setActiveTab('preview')

    // 调用 AutoCode 后端
    try {
      const result = await createAutoCodeTask({
        title: params.title,
        description: `[${params.techStack}] ${params.description}`,
        project_type: params.projectType === 'website' ? 'nextjs' : params.projectType,
        agent_types: getAgentTypesForProject(params.projectType),
        model: params.model,
        spec: params.spec,
        tool_policy: 'full_access',
        enable_smart_planning: Boolean(params.enableSmartPlanning),
      })
      setTasks(prev => prev.map(t =>
        t.id === localId
          ? {
              ...t,
              backendTaskId: result.id,
              workspaceId: toDisplayText(result.workspace_id),
              model: toDisplayText(result.model, params.model),
              toolPolicy: normalizeToolPolicy(result.tool_policy),
              status: mapBackendStatus(result.status) || 'running',
              currentStep: toDisplayText(result.current_step, '开始分析需求...'),
              executionActive: result.execution_active,
              runtimeState: toDisplayText(result.runtime_state),
              runtimeNote: toDisplayText(result.runtime_note),
              projectRecon: result.project_recon,
              complexity: toDisplayText(result.complexity),
              recommendedFlow: toDisplayText(result.recommended_flow),
              prototypeRequired: result.prototype_required,
              plan: normalizePlan(result.plan),
              review: normalizeReview(result.review),
              phase_reviews: Array.isArray(result.phase_reviews) ? result.phase_reviews.map(normalizeReview).filter(Boolean) as ReviewResult[] : [],
              prototype: normalizePrototype(result.prototype),
              commandHistory: Array.isArray(result.command_history) ? result.command_history.map(normalizeCommandRecord) : [],
              pipelineRuns: Array.isArray(result.pipeline_runs) ? result.pipeline_runs.map(normalizePipelineRun) : [],
            }
          : t
      ))
    } catch (e: unknown) {
      // API 失败时诊断错误原因，不要假装开发
      const err = e as Error
      let diagnosis = '❌ AutoCode 后端连接失败'
      let hint = ''
      if (err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError')) {
        diagnosis = '🔌 无法连接到 AutoCode 后端服务'
        hint = `请确认 AutoCode Backend 已启动（当前: ${AUTOCODE_API}）`
      } else if (err?.message?.includes('401') || err?.message?.includes('403') || err?.message?.includes('auth')) {
        diagnosis = '🔑 后端认证失败'
        hint = '请检查 backend 的数据库连接配置（model_channel 表 API Key）'
      } else if (err?.message?.includes('405') || err?.message?.includes('Method Not Allowed')) {
        diagnosis = '后端任务接口方法不匹配'
        hint = '请确认 AutoCode Backend 已部署最新版本，并检查 POST /api/tasks 路由是否注册'
      } else {
        diagnosis = `🔴 后端错误: ${err?.message || '未知错误'}`
        hint = '请查看 AutoCode Backend 控制台日志'
      }

      setTasks(prev => prev.map(t =>
        t.id === localId
          ? {
              ...t,
              status: 'failed',
              currentStep: diagnosis,
              messages: [
                ...t.messages,
                {
                  id: `diag_${Date.now()}`,
                  role: 'assistant',
                  content: `⚠️ **配置诊断**\n\n${diagnosis}\n\n${hint}\n\n---\n**排查步骤：**\n1. 确认 backend 已在运行：uvicorn main:app --port 8000\n2. 检查 backend 日志中是否有 "Channel Service" 相关输出\n3. 确认 muhugochat_db_* 环境变量指向正确的 MySQL\n4. 确认 model_channel 表中有活跃且匹配模型 ID 的渠道`,
                  timestamp: new Date().toISOString(),
                }
              ],
            }
          : t
      ))
    } finally {
      void refreshQueueStatus()
    }
  }, [refreshQueueStatus])

  const handleUpdateToolPolicy = useCallback(async (policy: AutoCodeToolPolicy) => {
    const task = activeTaskRef.current
    if (!task?.backendTaskId) return
    const previousPolicy = task.toolPolicy || 'full_access'
    setTasks(prev => prev.map(t =>
      t.id === task.id ? { ...t, toolPolicy: policy } : t
    ))
    try {
      const updated = await updateAutoCodeToolPolicy(task.backendTaskId, policy)
      setTasks(prev => prev.map(t =>
        t.id === task.id ? mergeBackendTaskIntoUiTask(t, updated) : t
      ))
    } catch (err) {
      const message = (err as Error).message || '工具权限策略更新失败'
      setTasks(prev => prev.map(t =>
        t.id === task.id
          ? {
              ...t,
              toolPolicy: previousPolicy,
              messages: mergeChatMessages(t.messages, [{
                id: `tool_policy_error_${Date.now()}`,
                role: 'system',
                content: `⚠️ 工具权限策略更新失败：${message}`,
                timestamp: new Date().toISOString(),
              }]),
            }
          : t
      ))
      await refreshTaskDetail(task.backendTaskId, task.id).catch(() => undefined)
    }
  }, [refreshTaskDetail])

  const handleSetLocalRunnerMode = useCallback(async (enabled: boolean, options?: { grant_id?: string; device_id?: string }) => {
    const task = activeTaskRef.current
    if (!task?.backendTaskId) return
    try {
      const status = await setAutoCodeLocalRunnerMode(task.backendTaskId, enabled, {
        public_api_base: getPublicAutoCodeApiBase(),
        grant_id: options?.grant_id,
        device_id: options?.device_id,
      })
      setTasks(prev => prev.map(t =>
        t.id === task.id
          ? {
              ...t,
              localExecutionEnabled: Boolean(status.enabled),
              localRunner: mergeLocalRunnerStatus(t.localRunner, status),
              messages: mergeChatMessages(t.messages, [{
                id: `local_runner_${Date.now()}`,
                role: 'system',
                content: enabled
                  ? '已开启本地执行模式。请点击“一键连接本地项目”唤起 AutoCode Local Connector；连接成功后 AI 会优先在你的本地项目中读取、写入和运行测试。'
                  : '已关闭本地执行模式，后续工具调用将回到服务器工作区执行。',
                timestamp: new Date().toISOString(),
              }]),
            }
          : t
      ))
      if (enabled) {
        setActiveTab('events')
        if (status.launch_url) {
          window.setTimeout(() => {
            window.location.href = status.launch_url || ''
          }, 50)
        }
        toast.info('本地执行模式已开启', { description: '正在唤起 AutoCode Local Connector；如果没有反应，请先安装本地连接器。' })
      } else {
        toast.success('已关闭本地执行模式')
      }
    } catch (err) {
      const message = (err as Error).message || '切换本地执行模式失败'
      toast.error(message.includes('未同步云端') ? '不能切换到云端执行' : '切换本地执行模式失败', {
        description: message.includes('未同步云端') ? '请在本地执行菜单里先点击“同步云端副本”，同步完成后再关闭本地执行。' : message,
      })
    }
  }, [])

  const handleSyncLocalSnapshot = useCallback(async () => {
    const task = activeTaskRef.current
    if (!task?.backendTaskId) return
    const updated = await syncAutoCodeLocalRunnerSnapshot(task.backendTaskId)
    setTasks(prev => prev.map(t =>
      t.id === task.id ? mergeBackendTaskIntoUiTask(t, updated) : t
    ))
    toast.success('云端副本已同步', { description: '现在可以关闭本地执行并切换到云端工作区。' })
  }, [])

  // ── Dev Server 管理（主组件版本，供本地指令路由使用） ──
  const handleStopDevServer = useCallback(async () => {
    const task = activeTaskRef.current
    if (!task?.backendTaskId) return
    try {
      await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/dev-server/stop`, {
        method: 'POST',
        headers: getAcAuthHeaders(),
      })
      setPreviewRefreshKey(k => k + 1)
    } catch { /* ignore */ }
  }, [])

  const handleRestartDevServer = useCallback(async () => {
    const task = activeTaskRef.current
    if (!task?.backendTaskId) return
    try {
      await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/dev-server/restart`, {
        method: 'POST',
        headers: getAcAuthHeaders(),
      })
      setPreviewRefreshKey(k => k + 1)
    } catch { /* ignore */ }
  }, [])

  // 发送对话消息控制开发（签名对齐 ChatInput.onSend）
  const handleSendMessage = useCallback(async (content: string, files?: FileAttachment[]) => {
    if (!content.trim() && (!files || files.length === 0)) return
    if (!activeTask) return

    // ── 本地指令路由：拦截常见操作指令，直接执行本地操作 ──
    const cmd = content.trim()

    // 导航类：切换到计划视图
    if (/^(修改计划|调整计划|查看计划|显示计划|看计划)/.test(cmd)) {
      setActiveTab('plan')
      setTasks(prev => prev.map(t =>
        t.id === activeTask.id
          ? { ...t, messages: [...t.messages, {
            id: `msg_${Date.now()}`,
            role: 'system' as const,
            content: '📋 已切换到计划视图',
            timestamp: new Date().toISOString(),
          }]}
          : t
      ))
      return
    }

    // 停止 Dev Server
    if (/^(停止预览|关闭预览|停掉预览|结束预览)/.test(cmd)) {
      await handleStopDevServer()
      setTasks(prev => prev.map(t =>
        t.id === activeTask.id
          ? { ...t, messages: [...t.messages, {
            id: `msg_${Date.now()}`,
            role: 'system' as const,
            content: '🛑 Dev Server 已停止',
            timestamp: new Date().toISOString(),
          }]}
          : t
      ))
      return
    }

    // 启动/重启 Dev Server
    if (/^(开始预览|启动预览|重启预览|重新预览)/.test(cmd)) {
      await handleRestartDevServer()
      setTasks(prev => prev.map(t =>
        t.id === activeTask.id
          ? { ...t, messages: [...t.messages, {
            id: `msg_${Date.now()}`,
            role: 'system' as const,
            content: '🔄 正在重启 Dev Server...',
            timestamp: new Date().toISOString(),
          }]}
          : t
      ))
      return
    }

    // 导航类：切换到文件视图
    if (/^(查看文件|打开文件|浏览文件)/.test(cmd)) {
      const match = cmd.match(/(?:查看文件|打开文件|浏览文件)\s*([A-Za-z0-9_.@()+\-/\\]+\.[A-Za-z0-9]+)?/)
      if (match?.[1]) setWorkspaceOpenFileRequest({ path: match[1].replace(/\\/g, '/').replace(/^\/+/, '') })
      setActiveTab('files')
      return
    }

    if (/^(运行测试|跑测试|执行测试|运行单测|跑一遍测试|运行构建|执行构建|跑构建)/.test(cmd)) {
      if (!activeTask.backendTaskId) return
      setActiveTab('terminal')
      const kind = /构建|build/i.test(cmd) ? 'build' : 'test'
      const pendingMsg: ChatMsg = {
        id: `msg_${Date.now()}`,
        role: 'system',
        content: `正在${kind === 'build' ? '运行构建' : '运行测试'}...`,
        timestamp: new Date().toISOString(),
        toolName: 'bash',
      }
      setTasks(prev => prev.map(t => t.id === activeTask.id ? { ...t, messages: [...t.messages, pendingMsg] } : t))
      runAutoCodeCommand(activeTask.backendTaskId, { kind }).then(record => {
        const doneMsg: ChatMsg = {
          id: `msg_${Date.now()}_cmd`,
          role: 'system',
          content: `${record.status === 'success' ? '命令通过' : '命令失败'}: ${record.command}`,
          timestamp: record.finished_at || new Date().toISOString(),
          toolName: 'bash',
          toolResult: record.output || '(无输出)',
        }
        setTasks(prev => prev.map(t => t.id === activeTask.id ? { ...t, messages: [...t.messages, doneMsg] } : t))
      }).catch(err => {
        const errMsg: ChatMsg = {
          id: `msg_${Date.now()}_cmd_err`,
          role: 'system',
          content: `命令执行失败: ${err?.message || '未知错误'}`,
          timestamp: new Date().toISOString(),
        }
        setTasks(prev => prev.map(t => t.id === activeTask.id ? { ...t, messages: [...t.messages, errMsg] } : t))
      })
      return
    }

    if (/^(查看变更|查看改动|查看diff|打开git|查看Git)/i.test(cmd)) {
      setActiveTab('git')
      return
    }

    // 导航类：切换到日志/终端视图
    if (/^(查看日志|看日志|查看终端|看终端)/.test(cmd)) {
      setActiveTab('terminal')
      return
    }

    // 导航类：切换到原型视图
    if (/^(查看原型|看原型|原型)/.test(cmd)) {
      setActiveTab('prototype')
      return
    }

    // 导航类：切换到代码审查视图
    if (/^(代码审查|查看审查|审查代码)/.test(cmd)) {
      setActiveTab('review')
      return
    }

    // ── 未被拦截的指令 → 转发给后端 AI Agent ──
    setChatLoading(true)

    const currentFiles = files || []
    const userMsg: ChatMsg = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: content.trim() || '(已发送文件)',
      timestamp: new Date().toISOString(),
      files: currentFiles.length > 0 ? currentFiles : undefined,
    }

    const wasTerminalTask = activeTask.status === 'completed' || activeTask.status === 'failed' || activeTask.status === 'stopped'
    setTasks(prev => prev.map(t =>
      t.id === activeTask.id
        ? {
            ...t,
            status: wasTerminalTask ? 'pending' : t.status,
            runtimeState: wasTerminalTask ? 'waiting' : t.runtimeState,
            runtimeNote: wasTerminalTask ? '已收到新指令，正在从已完成任务继续迭代...' : t.runtimeNote,
            messages: [...t.messages, userMsg],
          }
        : t
    ))

    try {
      if (activeTask.backendTaskId) {
        // 构建请求体
        const body: Record<string, unknown> = { message: content || '请查看我上传的文件' }
        // 传递当前选中的模型
        const currentModel = useChatStore.getState().selectedModel
        if (currentModel && currentModel !== 'auto') {
          body.model = currentModel
        }
        // 传递已激活的技能
        const currentSkillIds = useChatStore.getState().activeSkillIds
        if (currentSkillIds.length > 0) {
          body.agent_ids = currentSkillIds
        }
        if (currentFiles.length > 0) {
          body.files = currentFiles.map(f => ({
            name: f.name,
            url: f.url,
            type: f.type,
            size: f.size,
            content: f.content || '',
          }))
        }

        // 调用 AutoCode 后端对话接口（SSE 流式）
        const abortCtrl = new AbortController()
        chatAbortRef.current = abortCtrl
        const headers = { 'Content-Type': 'application/json', ...getAcAuthHeaders() }
        const res = await fetch(`${AUTOCODE_API}/api/tasks/${activeTask.backendTaskId}/chat`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: abortCtrl.signal,
        })

        if (!res.ok) {
          let detail = ''
          try {
            const data = await res.clone().json()
            detail = String(data?.detail || data?.message || '')
          } catch {
            try { detail = await res.clone().text() } catch { detail = '' }
          }
          const fallbackMsg: ChatMsg = {
            id: `msg_${Date.now() + 1}`,
            role: 'assistant',
            content: `⚠️ 继续迭代请求失败：${detail || `HTTP ${res.status}`}`,
            timestamp: new Date().toISOString(),
          }
          setTasks(prev => prev.map(t =>
            t.id === activeTask.id
              ? { ...t, status: activeTask.status, messages: [...t.messages, fallbackMsg] }
              : t
          ))
          setChatLoading(false)
          return
        }

        // SSE 流式读取
        const reader = res.body?.getReader()
        if (!reader) {
          setChatLoading(false)
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let currentEvent = ''
          let currentData = ''

          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim()
            } else if (line.startsWith('data: ')) {
              currentData = line.slice(6)
            } else if (line === '' && currentEvent && currentData) {
              try {
                const data = JSON.parse(currentData)
                if (currentEvent === 'confirm') {
                  const confirmMsg: ChatMsg = {
                    id: `msg_${Date.now()}_confirm`,
                    role: 'assistant',
                    content: toDisplayText(data.content, '✅ 已收到指令，Agent 正在处理...'),
                    timestamp: toDisplayText(data.timestamp, new Date().toISOString()),
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, confirmMsg] }
                      : t
                  ))
                } else if (currentEvent === 'message') {
                  const agentMsg: ChatMsg = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'assistant',
                    content: toDisplayText(data.content),
                    timestamp: toDisplayText(data.timestamp, new Date().toISOString()),
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, agentMsg] }
                      : t
                  ))
                } else if (currentEvent === 'action') {
                  const actionMsg: ChatMsg = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'system',
                    content: toDisplayText(data.message, '操作已执行'),
                    timestamp: toDisplayText(data.timestamp, new Date().toISOString()),
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, actionMsg] }
                      : t
                  ))
                  if (data.type === 'open_file' && data.path) {
                    setWorkspaceOpenFileRequest({ path: String(data.path), line: Number(data.line) || undefined })
                    setActiveTab('files')
                  } else if (data.type === 'show_git') {
                    setGitFocusTarget(data.target ? String(data.target) : 'working')
                    setActiveTab('git')
                  } else if (data.type === 'show_terminal') {
                    setActiveTab('terminal')
                  } else if (data.type === 'approval_requested') {
                    setActiveTab('events')
                  }
                } else if (currentEvent === 'command') {
                  const command = toDisplayText(data.command, '未知命令')
                  const status = toDisplayText(data.status)
                  const commandMsg: ChatMsg = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'system',
                    content: status === 'running'
                      ? `执行命令: ${command}`
                      : `${status === 'success' ? '命令通过' : '命令失败'}: ${command}`,
                    timestamp: toDisplayText(data.finished_at || data.started_at, new Date().toISOString()),
                    toolName: 'bash',
                    toolResult: toDisplayText(data.output),
                  }
                  setActiveTab('terminal')
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, commandMsg] }
                      : t
                  ))
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? {
                          ...t,
                          commandHistory: [
                            ...(t.commandHistory || []).filter(item => item.id !== data.id),
                            normalizeCommandRecord(data as AutoCodeCommandRecord),
                          ],
                        }
                      : t
                  ))
                } else if (currentEvent === 'runtime_event') {
                  const event = data as AutoCodeRuntimeEvent
                  if (event.type === 'approval_requested' && shouldNotifyApprovalEvent(event, activeTaskRef.current?.toolPolicy)) {
                    const summary = summarizeRuntimeEvent(event, toolDisplayRegistryRef.current)
                    notifyTaskSignal(
                      `${activeTask.backendTaskId || activeTask.id}:${event.id || event.created_at}:approval_requested`,
                      `AutoCode 需要批准：${activeTask.title}`,
                      summary.description || summary.title,
                      'warning',
                      'operationApproval',
                    )
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? {
                          ...t,
                          events: mergeRuntimeEvents(t.events, [event]),
                          messages: mergeRuntimeMessages(t.messages, [event]),
                        }
                      : t
                  ))
                  if (event.type === 'approval_requested') {
                    setActiveTab('events')
                  }
                } else if (currentEvent === 'tool_progress') {
                  // 工具执行进度 → 系统消息
                  const toolName = toDisplayText(data.tool_name)
                  const toolMsg: ChatMsg = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'system',
                    content: toDisplayText(data.description, `执行工具: ${toolName || '未知工具'}`),
                    timestamp: toDisplayText(data.timestamp, new Date().toISOString()),
                    toolName,
                    toolDescription: toDisplayText(data.description),
                    toolResult: toDisplayText(data.result_summary),
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, toolMsg] }
                      : t
                  ))
                  // write_file 操作 → 触发预览刷新
                  if (toolName === 'write_file') {
                    setPreviewRefreshKey(k => k + 1)
                  }
                } else if (currentEvent === 'phase_progress') {
                  const phase = toDisplayText(data.phase)
                  const detail = toDisplayText(data.detail, phase)
                  const phaseMsg: ChatMsg = {
                    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    role: 'system',
                    content: phase === 'install' ? `📦 ${detail}` :
                             phase === 'install_done' ? `✅ ${detail}` :
                             phase === 'build' ? `🔨 ${detail}` :
                             phase === 'preview' ? `🌐 ${detail}` :
                             detail,
                    timestamp: toDisplayText(data.timestamp, new Date().toISOString()),
                    toolDescription: detail,
                  }
                  setTasks(prev => prev.map(t =>
                    t.id === activeTask.id
                      ? { ...t, messages: [...t.messages, phaseMsg] }
                      : t
                  ))
                  // 预览就绪 → 刷新
                  if (phase === 'preview') {
                    setPreviewRefreshKey(k => k + 1)
                  }
                } else if (currentEvent === 'done') {
                  // 任务结束 → 更新预览 URL 并刷新
                  if (data.preview_url) {
                    setTasks(prev => prev.map(t =>
                      t.id === activeTask.id
                        ? { ...t, previewUrl: data.preview_url, status: 'completed' as TaskStatus }
                        : t
                    ))
                  }
                  if (activeTask.backendTaskId) {
                    refreshFinishedTaskDetail(activeTask.backendTaskId, activeTask.id)
                  }
                  setPreviewRefreshKey(k => k + 1)
                }
              } catch {}
              currentEvent = ''
              currentData = ''
            }
          }
        }
      } else {
        // 本地演示模式
        await new Promise(r => setTimeout(r, 800))
        const demoReplies: Record<string, string> = {
          '添加': '✅ 好的，我会为你添加该功能，稍等片刻...',
          '修改': '✅ 了解，正在修改相关代码...',
          '删除': '✅ 已标记删除，正在处理...',
          '样式': '✅ 正在优化 UI 样式，使界面更精美...',
          '颜色': '✅ 正在调整配色方案...',
          '部署': '✅ 准备一键部署，请稍等...',
          '预览': '✅ 正在启动预览服务...',
        }
        const reply = Object.entries(demoReplies).find(([k]) => content.includes(k))?.[1]
          || `✅ 已收到你的需求："${content.slice(0, 30)}..."，Agent 正在分析并实现...`

        const aiMsg: ChatMsg = {
          id: `msg_${Date.now() + 1}`,
          role: 'assistant',
          content: reply,
          timestamp: new Date().toISOString(),
        }
        setTasks(prev => prev.map(t =>
          t.id === activeTask.id
            ? { ...t, messages: [...t.messages, aiMsg] }
            : t
        ))
      }
    } catch (e: unknown) {
      // AbortError 是用户主动终止，不需要报错
      if (e instanceof DOMException && e.name === 'AbortError') return
      // 其他错误显示给用户
      if (activeTask) {
        const err = e as Error
        const errMsg: ChatMsg = {
          id: `msg_${Date.now()}_err`,
          role: 'assistant',
          content: `⚠️ 对话出错: ${err?.message || '未知错误'}`,
          timestamp: new Date().toISOString(),
        }
        setTasks(prev => prev.map(t =>
          t.id === activeTask.id
            ? { ...t, messages: [...t.messages, errMsg] }
            : t
        ))
      }
    } finally {
      chatAbortRef.current = null
      setChatLoading(false)
    }
  }, [activeTask, handleStopDevServer, handleRestartDevServer, refreshFinishedTaskDetail])

  // 终止对话 SSE 流
  const handleStopChat = useCallback(() => {
    if (chatAbortRef.current) {
      chatAbortRef.current.abort()
      chatAbortRef.current = null
    }
    setChatLoading(false)
  }, [])

  const handleDeleteTask = (id: string) => {
    const task = tasks.find(t => t.id === id)
    // 如果有后端任务 ID，同时删除后端记录
    if (task?.backendTaskId) {
      deleteAutoCodeTask(task.backendTaskId).catch(() => {})
    }
    setTasks(prev => prev.filter(t => t.id !== id))
    if (activeTaskId === id) setActiveTaskId(null)
  }

  const handleRenameTask = async (id: string, title: string) => {
    const nextTitle = title.trim()
    if (!nextTitle) return
    const task = tasks.find(t => t.id === id)
    const previousTitle = task?.title
    setTasks(prev => prev.map(t => t.id === id ? { ...t, title: nextTitle } : t))
    if (!task?.backendTaskId) return
    try {
      const updated = await renameAutoCodeTask(task.backendTaskId, nextTitle)
      setTasks(prev => prev.map(t => t.id === id ? { ...t, title: updated.title || nextTitle } : t))
      toast.success('任务已重命名')
    } catch (err) {
      if (previousTitle) {
        setTasks(prev => prev.map(t => t.id === id ? { ...t, title: previousTitle } : t))
      }
      toast.error('重命名失败', { description: (err as Error).message || '请稍后重试' })
    }
  }

  const handleRetryTask = async (id: string) => {
    const task = tasks.find(t => t.id === id)
    const backendId = task?.backendTaskId
    if (!backendId) return

    // 更新前端状态为 pending
    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, status: 'pending' as TaskStatus, progress: 0, currentStep: '重新执行中...' } : t
    ))

    try {
      const result = await retryAutoCodeTask(backendId)
      setTasks(prev => prev.map(t =>
        t.id === id ? {
          ...t,
          status: 'running' as TaskStatus,
          progress: 0,
          currentStep: result.status || 'running',
          backendTaskId: result.id,
        } : t
      ))
      // SSE useEffect 会自动检测到 status 变化并重连
    } catch (err) {
      setTasks(prev => prev.map(t =>
        t.id === id ? { ...t, status: 'failed' as TaskStatus, currentStep: '重试失败' } : t
      ))
    }
  }

  const openPlanningDialog = (id: string) => {
    const target = tasks.find(t => t.id === id)
    if (!target) return
    setPlanningDialogTaskId(id)
    setPlanningObjective(target.description || target.title || '')
    const recentUserMessages = [...(target.messages || [])]
      .filter(msg => msg.role === 'user')
      .slice(-3)
      .map(msg => `- ${msg.content}`)
      .join('\n')
    setPlanningContext(recentUserMessages ? `最近用户补充：\n${recentUserMessages}` : '')
    setActiveTaskId(id)
    setActiveTab('plan')
  }

  const handleEnablePlanning = async (id: string, objective?: string, context?: string) => {
    const target = tasks.find(t => t.id === id)
    const taskId = target?.backendTaskId || id
    const finalObjective = (objective || target?.description || target?.title || '').trim()
    setActiveTaskId(id)
    setActiveTab('plan')
    setTasks(prev => prev.map(t =>
      t.id === id
        ? { ...t, currentStep: '正在生成智能计划...', messages: [...t.messages, {
          id: `sys_plan_${Date.now()}`,
          role: 'system' as const,
          content: `📋 正在按最新目标生成智能计划...\n\n${finalObjective}`,
          timestamp: new Date().toISOString(),
        }]}
        : t
    ))
    try {
      const updated = await enableAutoCodeTaskPlanning(taskId, {
        objective: finalObjective,
        context: context?.trim(),
      })
      const normalized = backendTaskToUiTask(updated)
      setTasks(prev => prev.map(t => t.id === id ? { ...normalized, id: t.id } : t))
      setActiveTab('plan')
      toast.success('智能计划已生成')
    } catch (err) {
      toast.error((err as Error).message || '开启计划失败')
    }
  }

  const handleStopTask = async (id: string) => {
    const task = tasks.find(t => t.id === id)
    const backendId = task?.backendTaskId
    if (!backendId) return

    setTasks(prev => prev.map(t =>
      t.id === id ? { ...t, status: 'stopped' as TaskStatus, currentStep: '已停止' } : t
    ))

    try {
      await stopAutoCodeTask(backendId)
    } catch {
      // 即使后端调用失败也保持前端停止状态
    }
  }

  // Git Clone 导入处理
  const handleImportClone = useCallback(async () => {
    if (!importGitUrl.trim()) { setImportError('请输入 Git 仓库地址'); return }
    setImportLoading(true)
    setImportError('')
    try {
      const result = await cloneProject(importGitUrl.trim(), importName.trim() || undefined)
      const tempTaskId = `import_git_${result.project_id}`
      const tempTask: AutoCodeTask = {
        id: tempTaskId,
        title: result.name,
        description: `从 Git 导入的项目：${result.name}`,
        projectType: 'website',
        techStack: '',
        status: 'running',
        progress: 15,
        currentStep: 'Git 仓库克隆中...',
        createdAt: new Date().toISOString(),
        workspaceId: `pj-${result.project_id}`,
        backendTaskId: undefined,
        messages: [{
          id: `import_sys_${Date.now()}`,
          role: 'assistant' as const,
          content: `正在导入项目 **${result.name}**，完成后会自动出现在代码开发任务中。`,
          timestamp: new Date().toISOString(),
        }],
        logs: [],
      }
      setTasks(prev => [tempTask, ...prev])
      setActiveTaskId(tempTaskId)
      setImportGitUrl('')
      setImportName('')
      // 轮询等待克隆完成，然后刷新任务列表
      let attempts = 0
      const pollClone = setInterval(async () => {
        attempts++
        try {
          const pj = await getProject(result.project_id)
          if (pj.status === 'ready') {
            clearInterval(pollClone)
            const registered = await registerImportedProjectTask(result.project_id, {
              enable_smart_planning: importEnableSmartPlanning,
            })
            const newTask = backendTaskToUiTask(registered)
            setTasks(prev => prev.map(t => t.id === tempTaskId ? newTask : t))
            setActiveTaskId(newTask.id)
            setActiveTab('preview')
            setImportOpen(false)
            setImportLoading(false)
          } else if (pj.status === 'failed') {
            clearInterval(pollClone)
            setImportError('克隆失败：' + (pj.clone_output || '未知错误'))
            setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: 'Git 克隆失败' } : t))
            setImportLoading(false)
          }
        } catch {
          clearInterval(pollClone)
          setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: '导入状态查询失败' } : t))
          setImportLoading(false)
        }
        if (attempts > 60) { // 3 minutes max
          clearInterval(pollClone)
          setImportError('克隆超时，请检查 Git 地址是否正确')
          setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: 'Git 克隆超时' } : t))
          setImportLoading(false)
        }
      }, 3000)
    } catch (e: unknown) {
      const err = e as Error
      setImportError(err?.message || '克隆失败')
      setImportLoading(false)
    }
  }, [importGitUrl, importName, importEnableSmartPlanning])

  // 本地上传导入处理
  const handleImportUpload = useCallback(async () => {
    if (!importUploadFile) { setImportError('请选择项目文件'); return }
    setImportLoading(true)
    setImportError('')
    const uploadFileName = importUploadFile.name
    try {
      const result = await uploadProject(importUploadFile, importName.trim() || importUploadFile.name.replace(/\.[^.]+$/, ''))
      const tempTaskId = `import_upload_${result.project_id}`
      const tempTask: AutoCodeTask = {
        id: tempTaskId,
        title: result.name,
        description: `从本地上传的文件导入：${uploadFileName}`,
        projectType: 'website',
        techStack: '',
        status: 'running',
        progress: result.status === 'ready' ? 80 : 30,
        currentStep: result.status === 'ready' ? '上传完成，正在注册任务...' : '项目上传处理中...',
        createdAt: new Date().toISOString(),
        workspaceId: `pj-${result.project_id}`,
        backendTaskId: undefined,
        messages: [{
          id: `import_sys_${Date.now()}`,
          role: 'assistant' as const,
          content: `正在导入本地项目 **${uploadFileName}**，完成后会自动出现在代码开发任务中。`,
          timestamp: new Date().toISOString(),
        }],
        logs: [],
      }
      setTasks(prev => [tempTask, ...prev])
      setActiveTaskId(tempTaskId)
      setImportUploadFile(null)
      setImportName('')
      // 轮询等待上传完成，然后刷新任务列表
      let attempts = 0
      const pollUpload = setInterval(async () => {
        attempts++
        try {
          const pj = await getProject(result.project_id)
          if (pj.status === 'ready') {
            clearInterval(pollUpload)
            const registered = await registerImportedProjectTask(result.project_id, {
              enable_smart_planning: importEnableSmartPlanning,
            })
            const newTask = backendTaskToUiTask(registered)
            setTasks(prev => prev.map(t => t.id === tempTaskId ? newTask : t))
            setActiveTaskId(newTask.id)
            setActiveTab('preview')
            setImportOpen(false)
            setImportLoading(false)
          } else if (pj.status === 'failed') {
            clearInterval(pollUpload)
            setImportError('上传失败：' + (pj.clone_output || '未知错误'))
            setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: '上传处理失败' } : t))
            setImportLoading(false)
          }
        } catch {
          clearInterval(pollUpload)
          setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: '上传状态查询失败' } : t))
          setImportLoading(false)
        }
        if (attempts > 60) { // 3 minutes max
          clearInterval(pollUpload)
          setImportError('上传处理超时，请检查文件格式是否正确')
          setTasks(prev => prev.map(t => t.id === tempTaskId ? { ...t, status: 'failed', progress: 100, currentStep: '上传处理超时' } : t))
          setImportLoading(false)
        }
      }, 3000)
    } catch (e: unknown) {
      const err = e as Error
      setImportError(err?.message || '上传失败')
      setImportLoading(false)
    }
  }, [importUploadFile, importName, importEnableSmartPlanning])

  const handleImportLocal = useCallback(async () => {
    if (!localImportRunner?.session_id) {
      setImportError('请先生成本地连接会话并启动连接器')
      return
    }
    if (!localRunnerConnected) {
      setImportError('本地连接器尚未连接，请点击“一键连接本地项目”或先安装连接器')
      return
    }
    setImportLoading(true)
    setImportError('')
    try {
      const projectPath = localImportProjectPath.trim() || localRunnerProjectRoot || localImportRunner.project_root || ''
      const registered = await registerLocalRunnerTask(localImportRunner.session_id, {
        title: importName.trim() || (projectPath ? projectPath.split(/[\\/]/).filter(Boolean).pop() : undefined),
        project_path: projectPath,
        enable_smart_planning: importEnableSmartPlanning,
        sync_to_cloud: syncLocalSnapshots,
      })
      const newTask = backendTaskToUiTask(registered)
      setTasks(prev => [newTask, ...prev])
      setActiveTaskId(newTask.id)
      setActiveTab('events')
      setImportOpen(false)
      setImportName('')
      setLocalImportProjectPath('')
      setLocalImportRunner(registered.local_runner || localImportRunner)
      setLocalRunnerConnected(Boolean(registered.local_runner?.connected || localImportRunner?.connected))
      setLocalRunnerProjectRoot(registered.local_runner?.project_root || localRunnerProjectRoot)
      setImportEnableSmartPlanning(false)
      setSyncLocalSnapshots(false)
      toast.success('本地项目已导入', { description: '现在可以直接在 AI 助手中描述要修改的需求。' })
    } catch (err) {
      setImportError((err as Error).message || '本地项目导入失败')
    } finally {
      setImportLoading(false)
    }
  }, [
    importEnableSmartPlanning,
    importName,
    localImportProjectPath,
    localImportRunner,
    localRunnerConnected,
    localRunnerProjectRoot,
    syncLocalSnapshots,
  ])

  // 用于"继续/修改需求"按钮：点击后切到对应任务，状态横幅会引导用户在下方输入框发消息
  return (
    <div className="autocode-mobile-shell flex min-h-0 bg-background overflow-hidden lg:h-full">
      {/* ── 左侧导航栏 ── */}
      <AutoCodeSidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(p => !p)}
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={setActiveTaskId}
        onNewTask={() => setNewTaskOpen(true)}
        onImport={() => setImportOpen(true)}
        onDeleteTask={handleDeleteTask}
        onRenameTask={handleRenameTask}
        onEnablePlanning={openPlanningDialog}
        onStopTask={handleStopTask}
        onContinueTask={(id) => { setActiveTaskId(id); setTimeout(() => { const el = document.getElementById('autocode-chat-input'); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); (el as HTMLTextAreaElement | null)?.focus?.() }, 100) }}
        onNavigate={onNavigate}
        user={user}
        logout={logout}
        tasksLoading={tasksLoading}
        tasksError={tasksError}
        queueStatus={queueStatus}
        queueStatusError={queueStatusError}
      />

      {/* ── 移动端：汉堡菜单按钮 ── */}
      <div className="md:hidden fixed top-3 left-3 z-30">
        <Button size="icon" variant="outline" className="h-9 w-9 rounded-lg shadow-sm bg-background" onClick={() => setMobileSidebarOpen(true)}>
          <Menu className="w-4 h-4" />
        </Button>
      </div>

      {/* ── 移动端遮罩 ── */}
      {mobileSidebarOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setMobileSidebarOpen(false)} />
      )}

      {/* ── 移动端抽屉侧边栏 ── */}
      <div className={cn(
        'fixed inset-y-0 left-0 z-50 w-64 bg-sidebar border-r border-sidebar-border flex flex-col transition-transform duration-300 md:hidden',
        mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
      )}>
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
              <Code2 className="w-4 h-4 text-primary-foreground" />
            </div>
            <span className="font-semibold text-sidebar-foreground text-sm">代码开发</span>
          </div>
          <button onClick={() => setMobileSidebarOpen(false)} className="p-1.5 rounded-md hover:bg-sidebar-accent transition-colors">
            <X className="w-4 h-4 text-sidebar-foreground" />
          </button>
        </div>

        {/* New Task Button */}
        <div className="p-3 space-y-2">
          <Button
            onClick={() => { setNewTaskOpen(true); setMobileSidebarOpen(false) }}
            className="w-full gap-2 justify-start"
            size="sm"
          >
            <Plus className="w-4 h-4" />
            新建开发任务
          </Button>
          <Button
            variant="outline"
            onClick={() => { setImportOpen(true); setMobileSidebarOpen(false) }}
            className="w-full gap-2 justify-start"
            size="sm"
          >
            <GitBranchPlus className="w-4 h-4" />
            导入项目
          </Button>
        </div>

        <QueueStatusStrip status={queueStatus} error={queueStatusError} compact />

        {/* Task List */}
        <ScrollArea className="flex-1 overflow-x-auto px-2 py-1">
          {tasksLoading ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-center px-3">
              <Loader2 className="w-6 h-6 text-muted-foreground/40 animate-spin" />
              <p className="text-xs text-muted-foreground">正在加载任务列表...</p>
            </div>
          ) : tasksError ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2 text-center px-3">
              <AlertTriangle className="w-6 h-6 text-destructive/60" />
              <p className="text-xs text-destructive">加载失败</p>
              <p className="text-[10px] text-muted-foreground">{tasksError}</p>
              <button onClick={() => window.location.reload()} className="text-[10px] text-primary underline">点击重试</button>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center px-3">
              <Sparkles className="w-7 h-7 text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground">还没有开发任务</p>
              <p className="text-xs text-muted-foreground">点击"新建开发任务"开始</p>
            </div>
          ) : (
            <>
              <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide px-2 mb-1.5">任务列表</p>
              {tasks.map(t => (
                <TaskItem
                  key={t.id}
                  task={t}
                  active={activeTaskId === t.id}
                  onSelect={() => { setActiveTaskId(t.id); setMobileSidebarOpen(false) }}
                  onDelete={() => handleDeleteTask(t.id)}
                onRename={(title) => handleRenameTask(t.id, title)}
                onEnablePlanning={() => openPlanningDialog(t.id)}
                onStop={() => handleStopTask(t.id)}
                  onContinue={() => { setActiveTaskId(t.id); setMobileSidebarOpen(false); setTimeout(() => { const el = document.getElementById('autocode-chat-input'); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); (el as HTMLTextAreaElement | null)?.focus?.() }, 100) }}
                />
              ))}
            </>
          )}
        </ScrollArea>

        {/* Bottom nav */}
        <div className="p-3 border-t border-sidebar-border space-y-1">
          <button
            onClick={() => { onNavigate?.('chat'); setMobileSidebarOpen(false) }}
            className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent transition-colors"
          >
            <MessageSquare className="w-4 h-4 shrink-0" />
            <span>返回对话</span>
          </button>
          <div className="flex items-center gap-2 p-2">
            <Avatar className="w-7 h-7 shrink-0">
              <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
                {user?.name?.[0] || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.name}</p>
              <p className="text-xs text-sidebar-foreground/60 truncate">AutoCode Agent</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── 主内容区 ── */}
      {activeTask ? (
        <>
          <WorkspaceArea
            task={activeTask}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            chatLoading={chatLoading}
            onSend={handleSendMessage}
            onStopChat={handleStopChat}
            chatEndRef={chatEndRef}
            connectionStatus={connectionStatus}
            onRetry={() => activeTask && handleRetryTask(activeTask.id)}
            onStop={() => activeTask && handleStopTask(activeTask.id)}
            onEnablePlanning={() => activeTask && openPlanningDialog(activeTask.id)}
            onUpdateToolPolicy={handleUpdateToolPolicy}
            onSetLocalRunnerMode={handleSetLocalRunnerMode}
            onSyncLocalSnapshot={handleSyncLocalSnapshot}
            onResolveApproval={async (event, approved) => {
              if (!activeTask.backendTaskId || !event.id) return
              await resolveAutoCodeApproval(activeTask.backendTaskId, event.id, approved)
              const action = toDisplayText(event.payload?.action || event.payload?.tool)
              const nextStatus: TaskStatus = approved
                ? (action === 'continue_task' ? 'pending' : 'running')
                : 'stopped'
              const resolvedEvent = buildApprovalResolvedEvent(activeTask, event, approved)
              setTasks(prev => prev.map(t =>
                t.id === activeTask.id
                  ? {
                      ...t,
                      status: t.status === 'waiting_confirm' ? nextStatus : t.status,
                      currentStep: approved ? '已批准操作，继续执行...' : '用户拒绝了待确认操作',
                      pendingConfirmation: null,
                      events: mergeRuntimeEvents(t.events, [resolvedEvent]),
                      messages: mergeRuntimeMessages(t.messages, [resolvedEvent]),
                    }
                  : t
              ))
              void refreshTaskDetail(activeTask.backendTaskId, activeTask.id)
            }}
            previewRefreshKey={previewRefreshKey}
            setPreviewRefreshKey={setPreviewRefreshKey}
            chatPanelWidth={chatPanelWidth}
            setChatPanelWidth={setChatPanelWidth}
            requestedFileRequest={workspaceOpenFileRequest}
            onRequestedFilePathHandled={() => setWorkspaceOpenFileRequest(null)}
            gitFocusTarget={gitFocusTarget}
            onGitFocusHandled={() => setGitFocusTarget(null)}
            toolDisplayRegistry={toolDisplayRegistry}
          />

          {/* 计划确认对话框 */}
          {activeTask.status === 'waiting_plan_confirm' && (
            <PlanConfirmDialog
              task={activeTask}
              onConfirm={async (confirmed, modifiedPlan) => {
                if (!activeTask.backendTaskId) return
                try {
                  await confirmPlan(activeTask.backendTaskId, confirmed, modifiedPlan)
                  // 确认后状态由 SSE 推送更新
                } catch (err) {
                  console.error('确认计划失败:', err)
                }
              }}
            />
          )}

          {/* 原型确认面板 */}
          {activeTask.status === 'waiting_prototype_confirm' && (
            <PrototypeConfirmPanel
              task={activeTask}
              onConfirm={async (confirmed, modifiedPrototype) => {
                if (!activeTask.backendTaskId) return
                try {
                  await confirmPrototype(activeTask.backendTaskId, confirmed, modifiedPrototype)
                  // 确认后状态由 SSE 推送更新
                } catch (err) {
                  console.error('确认原型失败:', err)
                }
              }}
            />
          )}
        </>
      ) : (
        <EmptyState onNewTask={() => setNewTaskOpen(true)} queueStatus={queueStatus} queueStatusError={queueStatusError} />
      )}

      {/* 新建任务弹窗 */}
      <NewTaskDialog
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
        onSubmit={handleCreateTask}
      />

      <Dialog open={Boolean(planningDialogTaskId)} onOpenChange={(open) => {
        if (!open && !planningSubmitting) setPlanningDialogTaskId(null)
      }}>
        <DialogContent className="max-w-[95vw] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ListOrdered className="h-5 w-5" />
              生成 / 更新智能计划
            </DialogTitle>
            <DialogDescription>
              请确认本次要按什么目标规划。运行中任务、已完成任务和已有计划任务都会以这里的目标重新生成计划护栏。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>本次规划目标</Label>
              <Textarea
                value={planningObjective}
                onChange={e => setPlanningObjective(e.target.value)}
                className="min-h-28 text-sm"
                placeholder="例如：把当前官网改成面向企业客户的科技风首页，并补齐产品、关于我们、联系我们页面。"
              />
            </div>
            <div className="space-y-1.5">
              <Label>补充上下文（可选）</Label>
              <Textarea
                value={planningContext}
                onChange={e => setPlanningContext(e.target.value)}
                className="min-h-20 text-xs"
                placeholder="例如：保留现有技术栈、参考当前 UI 原型、优先修复构建失败。"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setPlanningDialogTaskId(null)} disabled={planningSubmitting}>
                取消
              </Button>
              <Button
                disabled={!planningObjective.trim() || planningSubmitting}
                onClick={async () => {
                  if (!planningDialogTaskId) return
                  setPlanningSubmitting(true)
                  try {
                    await handleEnablePlanning(planningDialogTaskId, planningObjective, planningContext)
                    setPlanningDialogTaskId(null)
                  } finally {
                    setPlanningSubmitting(false)
                  }
                }}
              >
                {planningSubmitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ListOrdered className="mr-1.5 h-4 w-4" />}
                生成计划
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* 导入项目弹窗（Git + 本地上传） */}
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="flex max-h-[90dvh] max-w-[95vw] flex-col overflow-hidden sm:max-w-md">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base">
              <GitBranchPlus className="w-5 h-5" />
              导入项目
            </DialogTitle>
            <DialogDescription>
              从 Git 仓库、压缩包或本地目录导入项目。本地导入模式直接操作你电脑上的文件，不需要上传到服务器。
            </DialogDescription>
          </DialogHeader>
          {/* Tab 切换 */}
          <div className="flex shrink-0 items-center gap-1 border-b pb-0">
            {[
              { id: 'git' as const, label: 'Git 仓库', icon: GitBranchPlus },
              { id: 'upload' as const, label: '本地上传', icon: FileArchive },{ id: 'local' as const, label: '本地导入', icon: FolderRoot },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => { setImportTab(id); setImportError('') }}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors rounded-t-md',
                  importTab === id ? 'bg-primary/10 text-primary border-b-2 border-primary' : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 pt-2">
            {/* 公共：项目名称 */}
            <div className="space-y-2">
              <Label htmlFor="projName">项目名称（可选，默认自动提取）</Label>
              <Input
                id="projName"
                placeholder="my-project"
                value={importName}
                onChange={e => setImportName(e.target.value)}
                disabled={importLoading}
              />
            </div>
            <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 p-3">
              <div className="min-w-0">
                <Label htmlFor="import-smart-planning" className="text-sm">启用智能规划</Label>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  默认关闭，导入后可直接在 AI 助手里描述需求。开启后先生成计划作为可审查提示。
                </p>
              </div>
              <Switch
                id="import-smart-planning"
                checked={importEnableSmartPlanning}
                onCheckedChange={setImportEnableSmartPlanning}
                disabled={importLoading}
              />
            </div>
            {/* Git 导入 */}
            {importTab === 'git' && (
              <div className="space-y-2">
                <Label htmlFor="gitUrl">Git 仓库地址</Label>
                <Input
                  id="gitUrl"
                  placeholder="https://github.com/user/repo.git"
                  value={importGitUrl}
                  onChange={e => { setImportGitUrl(e.target.value); setImportError('') }}
                  disabled={importLoading}
                />
              </div>
            )}
            {/* 本地上传 */}
            {importTab === 'upload' && (
                <div className="space-y-2">
                  <Label>项目文件（ZIP / TAR / TAR.GZ）</Label>
                  <div className="border-2 border-dashed border-border rounded-lg p-4 text-center hover:bg-accent/50 transition-colors cursor-pointer">
                    <input
                      type="file"
                      accept=".zip,.tar,.tar.gz,.tgz"
                      className="hidden"
                      id="upload-file"
                      onChange={e => { setImportUploadFile(e.target.files?.[0] || null); setImportError('') }}
                      disabled={importLoading}
                    />
                    <label htmlFor="upload-file" className="cursor-pointer block">
                      {importUploadFile ? (
                        <div className="flex items-center gap-2 justify-center min-w-0">
                          <FileArchive className="w-5 h-5 text-primary" />
                          <span className="text-sm font-medium min-w-0 max-w-[220px] truncate" title={importUploadFile.name}>{importUploadFile.name}</span>
                          <span className="text-xs text-muted-foreground shrink-0">{(importUploadFile.size / 1024 / 1024).toFixed(2)} MB</span>
                        </div>
                      ) : (
                        <>
                          <FileArchive className="w-8 h-8 text-muted-foreground/50 mx-auto mb-2" />
                          <p className="text-sm text-muted-foreground">点击选择或拖拽文件到此处</p>
                          <p className="text-xs text-muted-foreground/60 mt-1">支持 ZIP、TAR 格式，最大 100MB</p>
                        </>
                      )}
                    </label>
                  </div>
                </div>
              )}
              {importTab === 'local' && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">本地导入模式会直接操作你电脑上的项目文件，不需要上传到服务器，也不需要安装 Python。首次使用只需安装一次 AutoCode Local Connector。</p>
                    <div className="p-3 bg-muted/50 rounded-lg space-y-2">
                      <p className="text-sm font-medium">步骤 1：连接本地项目</p>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor="local-project-path" className="text-xs text-muted-foreground">本地项目目录（可选，连接器也可以选择目录）</Label>
                        <div className="flex items-center gap-2">
                          <Input
                            id="local-project-path"
                            value={localImportProjectPath}
                            onChange={event => setLocalImportProjectPath(event.target.value)}
                            placeholder="例如：D:\\Github\\excel"
                            disabled={localImportSessionLoading}
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => window.open(localImportRunner?.install_url || `${getPublicAutoCodeApiBase()}/api/local-runner/connector/windows/latest`, '_blank')}
                            disabled={localImportSessionLoading}
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            {localImportRunnerUpdateRequired ? '更新连接器' : '安装连接器'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="shrink-0"
                            onClick={() => void createLocalImportRunner(true)}
                            disabled={localImportSessionLoading}
                          >
                            {localImportSessionLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
                            刷新会话
                          </Button>
                          <Button
                            size="sm"
                            className="shrink-0"
                            onClick={handleLaunchLocalImportConnector}
                            disabled={localImportSessionLoading || !localImportRunner?.launch_url}
                          >
                            <MonitorPlay className="mr-1.5 h-3.5 w-3.5" />
                            一键连接
                          </Button>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">点击“一键连接”会唤起已安装的本地连接器；如果浏览器没有反应，请先安装连接器。</p>
                      {localProjectGrants.length > 0 && (
                        <div className="rounded-md border bg-background/70 p-2">
                          <div className="mb-2 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium">最近授权项目</span>
                            <span className="text-[11px] text-muted-foreground">30 天内可快速连接</span>
                          </div>
                          <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                            {localProjectGrants.map(grant => (
                              <button
                                key={grant.grant_id}
                                type="button"
                                className={cn(
                                  'flex w-full items-center justify-between gap-3 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/70',
                                  selectedLocalGrantId === grant.grant_id && 'border-primary/60 bg-primary/5'
                                )}
                                onClick={() => void handleUseLocalGrant(grant)}
                                disabled={localImportSessionLoading}
                              >
                                <span className="min-w-0">
                                  <span className="block truncate font-medium">{grant.project_name || grant.project_root || '本地项目'}</span>
                                  <span className="block truncate text-[11px] text-muted-foreground">{grant.project_root}</span>
                                </span>
                                <span className="shrink-0 text-[11px] text-muted-foreground">
                                  {grant.expires_at ? `至 ${formatBeijingDateTime(grant.expires_at)}` : '30 天'}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {localImportRunnerUpdateRequired && (
                        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-xs text-red-700 dark:text-red-300">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            当前连接器版本 {localImportRunner?.runner_version || '未知'}，最低需要 {localImportRunner?.connector_min_version || '最新版'}，请更新后重新连接。
                          </span>
                        </div>
                      )}
                      <details className="rounded-md border bg-background/70 px-2 py-1.5">
                        <summary className="cursor-pointer text-xs font-medium">高级：脚本方式启动</summary>
                        <div className="mt-2 flex items-center gap-2">
                          <Input readOnly value={localImportRunnerCommand} className={cn(importRunnerCommandCopied && 'border-green-500/60 ring-1 ring-green-500/30')} />
                          <Button
                            size="sm"
                            variant="outline"
                            className={cn('min-w-[74px] transition-colors', importRunnerCommandCopied && 'border-green-500/60 text-green-700 dark:text-green-300')}
                            onClick={() => void copyImportRunnerCommand()}
                            disabled={localImportSessionLoading || !localImportRunner?.command}
                          >
                            {localImportSessionLoading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : importRunnerCommandCopied ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                            {importRunnerCommandCopied ? '已复制' : '复制'}
                          </Button>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">仅排障时使用：需要本机已有 Python 和 websockets 依赖。</p>
                      </details>
                    </div>
                    <div className="p-3 border rounded-lg space-y-2">
                      <p className="text-sm font-medium flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full', localImportRunnerUpdateRequired ? 'bg-red-500' : localRunnerConnected ? 'bg-green-500' : 'bg-gray-300 animate-pulse')} />
                        {localImportRunnerUpdateRequired ? '连接器需要更新' : localRunnerConnected ? '已连接本地连接器' : '等待本地连接器连接...'}
                      </p>
                      {localRunnerConnected && localRunnerProjectRoot && (
                        <div className="text-sm">
                          <p>已检测到本地项目目录：<code className="bg-muted px-1 rounded">{localRunnerProjectRoot}</code></p>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id="sync-snapshots" checked={syncLocalSnapshots} onCheckedChange={setSyncLocalSnapshots} />
                      <Label htmlFor="sync-snapshots" className="text-sm">同步项目快照到云端（用于云端执行、代码审查、版本回溯，可选）</Label>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      未同步云端时，任务只能通过本地 Runner 执行；关闭本地执行会被拦截，避免云端工作区没有项目文件。
                    </p>
                  </div>
                </div>
              )}
            {importError && (
              <div className="flex items-start gap-2 p-3 bg-destructive/10 rounded-lg border border-destructive/20 text-sm text-destructive">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{importError}</span>
              </div>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => { setImportOpen(false); setImportError(''); setImportGitUrl(''); setImportName(''); setImportUploadFile(null); setImportEnableSmartPlanning(false); setImportTab('git') }} disabled={importLoading}>取消</Button>
              <Button
                onClick={importTab === 'git' ? handleImportClone : importTab === 'upload' ? handleImportUpload : handleImportLocal}
                disabled={importLoading}
              >
                {importLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : importTab === 'git' ? <GitBranchPlus className="w-4 h-4 mr-2" /> : importTab === 'upload' ? <FileArchive className="w-4 h-4 mr-2" /> : <FolderRoot className="w-4 h-4 mr-2" />}
                {importLoading
                  ? (importTab === 'git' ? '克隆中...' : '处理中...')
                  : (importTab === 'git' ? '开始克隆' : importTab === 'upload' ? '开始上传' : '导入本地项目')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ──────────────────────────────────────────
// 左侧任务导航
// ──────────────────────────────────────────

function QueueStatusStrip({
  status,
  error,
  compact = false,
}: {
  status: AutoCodeQueueStatus | null
  error?: string
  compact?: boolean
}) {
  const running = status?.runnable ?? 0
  const queued = status?.queued_count ?? status?.queue_size ?? 0
  const waiting = status?.waiting ?? 0
  const workers = status?.workers ?? 0
  const hasActivity = running > 0 || queued > 0 || waiting > 0

  return (
    <div className={cn('px-3', compact ? 'pb-2' : 'py-2')}>
      <div className="rounded-lg border border-sidebar-border bg-sidebar-accent/35 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className={cn(
              'inline-flex h-2 w-2 rounded-full',
              hasActivity ? 'bg-blue-500 animate-pulse' : error ? 'bg-amber-500' : 'bg-green-500'
            )} />
            <span className="text-[11px] font-medium text-sidebar-foreground truncate">后台队列</span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex items-center gap-1 text-[10px] text-sidebar-foreground/65">
                <Activity className="w-3 h-3" />
                {workers} worker
              </span>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>后台任务刷新/离开页面后仍应继续执行</p>
            </TooltipContent>
          </Tooltip>
        </div>

        {error && !status ? (
          <p className="mt-1.5 truncate text-[10px] text-amber-600">{error}</p>
        ) : (
          <div className="mt-2 grid grid-cols-3 gap-1">
            {[
              { label: '运行', value: running },
              { label: '排队', value: queued },
              { label: '待确认', value: waiting },
            ].map(item => (
              <div key={item.label} className="rounded-md bg-background/70 px-1.5 py-1 text-center">
                <div className="text-[11px] font-semibold leading-none text-sidebar-foreground">{item.value}</div>
                <div className="mt-0.5 text-[9px] leading-none text-sidebar-foreground/55">{item.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function AutoCodeSidebar({
  collapsed, onToggle, tasks, activeTaskId, onSelectTask, onNewTask,
  onImport, onDeleteTask, onRenameTask, onEnablePlanning, onStopTask, onContinueTask, onNavigate, user, logout,
  tasksLoading, tasksError, queueStatus, queueStatusError,
}: {
  collapsed: boolean
  onToggle: () => void
  tasks: AutoCodeTask[]
  activeTaskId: string | null
  onSelectTask: (id: string) => void
  onNewTask: () => void
  onImport: () => void
  onDeleteTask: (id: string) => void
  onRenameTask: (id: string, title: string) => void
  onEnablePlanning: (id: string) => void
  onStopTask: (id: string) => void
  onContinueTask: (id: string) => void
  onNavigate?: (page: AppPage) => void
  user: ReturnType<typeof useAuthStore.getState>['user']
  logout: () => void
  tasksLoading?: boolean
  tasksError?: string
  queueStatus?: AutoCodeQueueStatus | null
  queueStatusError?: string
}) {
  if (collapsed) {
    return (
      <div className="hidden md:flex flex-col h-full w-14 bg-sidebar border-r border-sidebar-border items-center py-3 gap-2">
        <button onClick={onToggle} className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors">
          <ChevronRight className="w-4 h-4 text-sidebar-foreground" />
        </button>
        <Button size="icon" variant="ghost" className="h-9 w-9" onClick={onNewTask}>
          <Plus className="w-4 h-4" />
        </Button>
        <Separator className="w-8 bg-sidebar-border" />
        {tasks.slice(0, 6).map(t => {
          const Icon = TYPE_ICON[t.projectType] || Globe
          return (
            <button
              key={t.id}
              onClick={() => onSelectTask(t.id)}
              title={t.title}
              className={cn(
                'w-9 h-9 rounded-lg flex items-center justify-center transition-colors',
                activeTaskId === t.id ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'hover:bg-sidebar-accent text-sidebar-foreground'
              )}
            >
              <Icon className={cn('w-4 h-4', TYPE_COLOR[t.projectType])} />
            </button>
          )
        })}
        <div className="flex-1" />
        <button
          onClick={() => onNavigate?.('chat')}
          title="返回对话"
          className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-sidebar-accent text-sidebar-foreground transition-colors"
        >
          <MessageSquare className="w-4 h-4" />
        </button>
        <Avatar className="w-8 h-8 cursor-pointer">
          <AvatarFallback className="bg-primary text-primary-foreground text-xs">
            {user?.name?.[0] || 'U'}
          </AvatarFallback>
        </Avatar>
      </div>
    )
  }

  return (
    <div
      className="hidden md:flex h-full w-80 min-w-64 max-w-[40rem] resize-x flex-col overflow-hidden bg-sidebar border-r border-sidebar-border shrink-0"
      title="可拖动右下角调整任务列表宽度"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-sidebar-border">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center">
            <Code2 className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-semibold text-sidebar-foreground text-sm">代码开发</span>
        </div>
        <button onClick={onToggle} className="p-1.5 rounded-md hover:bg-sidebar-accent transition-colors">
          <ChevronLeft className="w-4 h-4 text-sidebar-foreground" />
        </button>
      </div>

      {/* New Task Button */}
      <div className="p-3 space-y-2">
        <Button onClick={onNewTask} className="w-full gap-2 justify-start" size="sm">
          <Plus className="w-4 h-4" />
          新建开发任务
        </Button>
        <Button variant="outline" onClick={onImport} className="w-full gap-2 justify-start" size="sm">
          <GitBranchPlus className="w-4 h-4" />
          导入项目
        </Button>
      </div>

      <QueueStatusStrip status={queueStatus ?? null} error={queueStatusError} compact />

      {/* Task List */}
      <ScrollArea className="flex-1 overflow-x-auto px-2 py-1">
        {tasksLoading ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-center px-3">
            <Loader2 className="w-6 h-6 text-muted-foreground/40 animate-spin" />
            <p className="text-xs text-muted-foreground">正在加载任务列表...</p>
          </div>
        ) : tasksError ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-center px-3">
            <AlertTriangle className="w-6 h-6 text-destructive/60" />
            <p className="text-xs text-destructive">加载失败</p>
            <p className="text-[10px] text-muted-foreground">{tasksError}</p>
            <button onClick={() => window.location.reload()} className="text-[10px] text-primary underline">点击重试</button>
          </div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center px-3">
            <Sparkles className="w-7 h-7 text-muted-foreground/40 mb-2" />
            <p className="text-xs text-muted-foreground">还没有开发任务</p>
            <p className="text-xs text-muted-foreground">点击"新建开发任务"开始</p>
          </div>
        ) : (
          <>
            <p className="text-[11px] font-semibold text-sidebar-foreground/60 uppercase tracking-wide px-2 mb-1.5">任务列表</p>
            {tasks.map(t => (
              <TaskItem
                key={t.id}
                task={t}
                active={activeTaskId === t.id}
                onSelect={() => onSelectTask(t.id)}
                onDelete={() => onDeleteTask(t.id)}
                onRename={(title) => onRenameTask(t.id, title)}
                onEnablePlanning={() => onEnablePlanning(t.id)}
                onStop={() => onStopTask(t.id)}
                onContinue={() => onContinueTask(t.id)}
              />
            ))}
          </>
        )}
      </ScrollArea>

      {/* Bottom nav */}
      <div className="p-3 border-t border-sidebar-border space-y-1">
        <button
          onClick={() => onNavigate?.('chat')}
          className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent transition-colors"
        >
          <MessageSquare className="w-4 h-4 shrink-0" />
          <span>返回对话</span>
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center gap-2 w-full p-2 rounded-lg hover:bg-sidebar-accent transition-colors text-left">
              <Avatar className="w-7 h-7 shrink-0">
                <AvatarFallback className="bg-primary text-primary-foreground text-xs font-medium">
                  {user?.name?.[0] || 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-sidebar-foreground truncate">{user?.name}</p>
                <p className="text-xs text-sidebar-foreground/60 truncate">AutoCode Agent</p>
              </div>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-48">
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout} className="text-destructive">
              <LogOut className="w-4 h-4" />退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// 任务列表项
// ──────────────────────────────────────────

function TaskItem({ task, active, onSelect, onDelete, onRename, onEnablePlanning, onStop, onContinue }: {
  task: AutoCodeTask
  active: boolean
  onSelect: () => void
  onDelete: () => void
  onRename: (title: string) => void
  onEnablePlanning: () => void
  onStop: () => void
  onContinue: () => void
}) {
  const Icon = TYPE_ICON[task.projectType] || Globe
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG['pending']
  const canContinue = task.status === 'failed' || task.status === 'stopped' || task.status === 'completed'
  const [editing, setEditing] = useState(false)
  const [draftTitle, setDraftTitle] = useState(task.title)

  useEffect(() => {
    if (!editing) setDraftTitle(task.title)
  }, [editing, task.title])

  const commitRename = () => {
    const nextTitle = draftTitle.trim()
    if (nextTitle && nextTitle !== task.title) {
      onRename(nextTitle)
    }
    setEditing(false)
  }

  return (
    <div
      onClick={editing ? undefined : onSelect}
      className={cn(
        'group relative flex min-w-full max-w-full items-start gap-2 px-2 py-2.5 rounded-lg cursor-pointer transition-colors mb-0.5',
        active ? 'bg-sidebar-accent text-sidebar-foreground' : 'hover:bg-sidebar-accent/60 text-sidebar-foreground/80'
      )}
    >
      <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', TYPE_COLOR[task.projectType])} />
      <div className="min-w-0 flex-1 overflow-hidden">
        {editing ? (
          <Input
            value={draftTitle}
            autoFocus
            className="h-7 w-full min-w-0 max-w-full px-2 text-xs"
            onClick={e => e.stopPropagation()}
            onChange={e => setDraftTitle(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setDraftTitle(task.title)
                setEditing(false)
              }
            }}
          />
        ) : (
          <p className="max-w-full break-words text-xs font-medium leading-snug" title={task.title}>{task.title}</p>
        )}
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', sc.dot)} />
          <span className={cn('text-[10px]', sc.color)}>{sc.label}</span>
          {task.status === 'running' && (
            <span className="text-[10px] text-muted-foreground">{task.progress}%</span>
          )}
        </div>
        {!editing && (
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-sidebar-foreground/70">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDraftTitle(task.title); setEditing(true) }}
              className="shrink-0 rounded px-1.5 py-0.5 hover:bg-sidebar-accent hover:text-sidebar-foreground"
            >
              重命名
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
              className="shrink-0 rounded px-1.5 py-0.5 hover:bg-destructive/10 hover:text-destructive"
            >
              删除
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={e => e.stopPropagation()}>
                <button
                  type="button"
                  className="shrink-0 rounded px-1.5 py-0.5 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                >
                  更多
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEnablePlanning() }}>
                  <ListOrdered className="w-4 h-4" />{task.plan ? '重新规划' : '开启计划'}
                </DropdownMenuItem>
                {task.status === 'running' && (
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onStop() }} className="text-orange-500">
                    <Square className="w-4 h-4" />停止任务
                  </DropdownMenuItem>
                )}
                {canContinue && (
                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onContinue() }} className="text-blue-500">
                    <RotateCw className="w-4 h-4" />继续 / 修改需求
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// 模型选择器（AI 助手对话头部）
// ──────────────────────────────────────────

function ModelSelector({ taskModel }: { taskModel?: string }) {
  const { selectedModel, setSelectedModel } = useChatStore()
  const { models: frontendModels } = useAvailableModels()
  const effectiveModel = selectedModel !== 'auto' ? selectedModel : (taskModel || selectedModel)
  const currentModel = frontendModels.find(m => m.id === effectiveModel)
  const displayName = effectiveModel === 'auto' ? 'Auto' : (currentModel?.name || effectiveModel)
  const hasTaskModelInList = !!taskModel && frontendModels.some(m => m.id === taskModel)

  useEffect(() => {
    if (!taskModel && selectedModel !== 'auto' && frontendModels.length > 0 && !currentModel) {
      setSelectedModel('auto')
    }
  }, [currentModel, frontendModels, selectedModel, setSelectedModel, taskModel])

  return (
    <Select value={effectiveModel} onValueChange={setSelectedModel}>
      <SelectTrigger className="h-7 w-auto min-w-[80px] max-w-[140px] text-[11px] gap-1 px-2 border-none bg-muted/60 hover:bg-muted">
        <Cpu className="w-3 h-3 text-primary shrink-0" />
        <SelectValue className="truncate">{displayName}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="auto" className="text-xs">
          <span className="flex items-center gap-1.5">
            <Cpu className="w-3 h-3 text-primary" />
            Auto（智能路由）
          </span>
        </SelectItem>
        {taskModel && !hasTaskModelInList && (
          <SelectItem value={taskModel} className="text-xs">
            <span className="truncate">任务模型：{taskModel}</span>
          </SelectItem>
        )}
        {frontendModels.map(m => (
          <SelectItem key={m.id} value={m.id} className="text-xs">
            <span className="truncate">{m.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// ──────────────────────────────────────────
// 主工作区
// ──────────────────────────────────────────

function WorkspaceArea({
  task, activeTab, onTabChange,
  chatLoading,
  onSend, onStopChat, chatEndRef, connectionStatus,
  onRetry, onStop,
  onEnablePlanning,
  onUpdateToolPolicy,
  onSetLocalRunnerMode,
  onSyncLocalSnapshot,
  onResolveApproval,
  previewRefreshKey, setPreviewRefreshKey,
  chatPanelWidth, setChatPanelWidth,
  requestedFileRequest, onRequestedFilePathHandled,
  gitFocusTarget, onGitFocusHandled,
  toolDisplayRegistry,
}: {
  task: AutoCodeTask
  activeTab: WorkspaceTab
  onTabChange: (tab: WorkspaceTab) => void
  chatLoading: boolean
  onSend: (content: string, files?: FileAttachment[]) => void
  onStopChat: () => void
  chatEndRef: React.RefObject<HTMLDivElement>
  connectionStatus: 'connecting' | 'connected' | 'disconnected' | 'mock'
  onRetry: () => void
  onStop: () => void
  onEnablePlanning: () => void
  onUpdateToolPolicy: (policy: AutoCodeToolPolicy) => Promise<void>
  onSetLocalRunnerMode: (enabled: boolean, options?: { grant_id?: string; device_id?: string }) => Promise<void>
  onSyncLocalSnapshot: () => Promise<void>
  onResolveApproval: (event: AutoCodeRuntimeEvent, approved: boolean) => Promise<void>
  previewRefreshKey: number
  setPreviewRefreshKey: React.Dispatch<React.SetStateAction<number>>
  chatPanelWidth: number
  setChatPanelWidth: React.Dispatch<React.SetStateAction<number>>
  requestedFileRequest?: { path: string; line?: number } | null
  onRequestedFilePathHandled?: () => void
  gitFocusTarget?: string | null
  onGitFocusHandled?: () => void
  toolDisplayRegistry: ToolDisplayMap
}) {
  const sc = STATUS_CONFIG[task.status] || STATUS_CONFIG['pending']
  const Icon = TYPE_ICON[task.projectType] || Globe
  // 预览 URL 构造：
  // 1. previewUrl 直接使用（后端已处理代理路径）
  // 2. previewUrl 为 /api/proxy/* → 拼接 AUTOCODE_API
  // 3. previewUrl 为 /workspaces/* → 拼接 AUTOCODE_API
  // 4. 后端未连接时降级为 mock 模式（显示模拟进度动画）
  const getPreviewUrl = () => {
    if (!task.previewUrl) return null
    let url = task.previewUrl
    // 修复后端返回的 localhost URL → 使用当前代理地址
    if (url.includes('localhost') || url.includes('127.0.0.1')) {
      try {
        const u = new URL(url)
        const apiBase = new URL(AUTOCODE_API, window.location.href)
        u.hostname = apiBase.hostname
        u.port = apiBase.port || (apiBase.protocol === 'https:' ? '443' : '80')
        u.protocol = apiBase.protocol
        url = u.toString()
      } catch {
        // 如果 URL 解析失败，直接替换字符串
        url = url.replace(/https?:\/\/localhost:\d+/, AUTOCODE_API).replace(/https?:\/\/127\.0\.0\.1:\d+/, AUTOCODE_API)
      }
    }
    if (url.startsWith('/api/proxy/') || url.startsWith('/workspaces/')) {
      return appendWorkspaceAccess(`${AUTOCODE_API}${url}`)
    }
    return appendWorkspaceAccess(url)
  }
  const previewSrc = getPreviewUrl()
  const pendingApprovalEvent = useMemo(() => {
    const events = Array.isArray(task.events) ? task.events : []
    const resolved = new Set<string>()
    for (const event of events) {
      if (event.type !== 'approval_resolved') continue
      const payload = event.payload || {}
      const approvalId = toDisplayText(payload.approval_id)
      const eventId = toDisplayText(payload.event_id)
      if (approvalId) resolved.add(approvalId)
      if (eventId) resolved.add(eventId)
    }
    const eventFromLog = [...events].reverse().find(event => {
      if (event.type !== 'approval_requested') return false
      const approvalId = toDisplayText(event.payload?.approval_id, event.id)
      return !resolved.has(approvalId) && !resolved.has(event.id)
    })
    return eventFromLog || pendingConfirmationToEvent(task)
  }, [task])
  const [approvingEventId, setApprovingEventId] = useState<string | null>(null)
  const [approvalError, setApprovalError] = useState('')
  const [updatingToolPolicy, setUpdatingToolPolicy] = useState(false)
  const [updatingLocalRunner, setUpdatingLocalRunner] = useState(false)
  const [syncingLocalSnapshot, setSyncingLocalSnapshot] = useState(false)
  const [localRunnerCommandCopied, setLocalRunnerCommandCopied] = useState(false)
  const [localRunnerLaunchCopied, setLocalRunnerLaunchCopied] = useState(false)
  const [localDeviceGrants, setLocalDeviceGrants] = useState<AutoCodeLocalProjectGrant[]>([])
  const currentToolPolicy = normalizeToolPolicy(task.toolPolicy)
  const localRunner = task.localRunner
  const localRunnerEnabled = Boolean(task.localExecutionEnabled || localRunner?.enabled)
  const localRunnerConnected = Boolean(localRunner?.connected)
  const localRunnerUpdateRequired = Boolean(localRunner?.connector_update_required)
  const localRunnerLaunchUrl = localRunner?.launch_url || ''
  const localRunnerInstallUrl = localRunner?.install_url || getAutoCodeLocalRunnerDownloadUrl()
  const needsCloudSnapshot = Boolean(task.localImportMode && task.cloudSnapshotStatus !== 'synced')
  const pendingApprovalPayload = pendingApprovalEvent?.payload || {}
  const pendingApprovalCommand = toDisplayText(
    pendingApprovalPayload.command || (pendingApprovalPayload.payload as Record<string, unknown> | undefined)?.command
  )
  const pendingApprovalTitle = toDisplayText(
    pendingApprovalPayload.reason || pendingApprovalPayload.message || pendingApprovalPayload.tool,
    '有一个操作需要审批'
  )
  const pendingApprovalMeta = useMemo(() => getApprovalMeta(pendingApprovalEvent), [pendingApprovalEvent])
  const refreshLocalDeviceGrants = useCallback(async () => {
    try {
      setLocalDeviceGrants(await listAutoCodeLocalProjectGrants())
    } catch {
      setLocalDeviceGrants([])
    }
  }, [])
  useEffect(() => {
    if (task.backendTaskId) {
      void refreshLocalDeviceGrants()
    }
  }, [refreshLocalDeviceGrants, task.backendTaskId])

  const handleInlineApproval = useCallback(async (approved: boolean) => {
    if (!pendingApprovalEvent) return
    setApprovingEventId(pendingApprovalEvent.id)
    setApprovalError('')
    try {
      await onResolveApproval(pendingApprovalEvent, approved)
      if (approved) onTabChange('terminal')
    } catch (err) {
      setApprovalError((err as Error).message || '确认操作失败')
    } finally {
      setApprovingEventId(null)
    }
  }, [onResolveApproval, onTabChange, pendingApprovalEvent])
  const handleInlineApprovalEvent = useCallback((event: AutoCodeRuntimeEvent, approved: boolean) => {
    if (!pendingApprovalEvent || event.id !== pendingApprovalEvent.id) return
    void handleInlineApproval(approved)
  }, [handleInlineApproval, pendingApprovalEvent])
  const handleToolPolicyChange = useCallback(async (policy: AutoCodeToolPolicy) => {
    if (policy === currentToolPolicy || updatingToolPolicy) return
    setUpdatingToolPolicy(true)
    try {
      await onUpdateToolPolicy(policy)
    } finally {
      setUpdatingToolPolicy(false)
    }
  }, [currentToolPolicy, onUpdateToolPolicy, updatingToolPolicy])
  const handleLocalRunnerToggle = useCallback(async (enabled: boolean) => {
    if (updatingLocalRunner) return
    setUpdatingLocalRunner(true)
    try {
      await onSetLocalRunnerMode(enabled)
    } finally {
      setUpdatingLocalRunner(false)
    }
  }, [onSetLocalRunnerMode, updatingLocalRunner])
  const handleConnectLocalDevice = useCallback(async (grant: AutoCodeLocalProjectGrant) => {
    if (updatingLocalRunner) return
    if (!grant.device_online) {
      toast.warning('目标设备不在线', { description: '请先在该电脑打开 AutoCode Local Connector。' })
      return
    }
    setUpdatingLocalRunner(true)
    try {
      await onSetLocalRunnerMode(true, { grant_id: grant.grant_id, device_id: grant.device_id })
      toast.success('已向目标设备发送连接请求', { description: grant.device_name || grant.project_root })
      await refreshLocalDeviceGrants()
    } finally {
      setUpdatingLocalRunner(false)
    }
  }, [onSetLocalRunnerMode, refreshLocalDeviceGrants, updatingLocalRunner])
  const handleSyncLocalSnapshot = useCallback(async () => {
    if (syncingLocalSnapshot) return
    setSyncingLocalSnapshot(true)
    try {
      await onSyncLocalSnapshot()
    } catch (err) {
      toast.error('同步云端副本失败', { description: (err as Error).message || '请确认本地连接器在线后重试。' })
    } finally {
      setSyncingLocalSnapshot(false)
    }
  }, [onSyncLocalSnapshot, syncingLocalSnapshot])
  const handleCopyLocalRunnerCommand = useCallback(async () => {
    const command = localRunner?.command || ''
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      setLocalRunnerCommandCopied(true)
      toast.success('本地 Runner 启动命令已复制')
      window.setTimeout(() => setLocalRunnerCommandCopied(false), 1600)
    } catch {
      toast.error('复制失败，请手动选择命令复制')
    }
  }, [localRunner?.command])
  const handleCopyLocalRunnerLaunchUrl = useCallback(async () => {
    const launchUrl = localRunner?.launch_url || ''
    if (!launchUrl) return
    try {
      await navigator.clipboard.writeText(launchUrl)
      setLocalRunnerLaunchCopied(true)
      toast.success('已复制一键唤起链接')
      window.setTimeout(() => setLocalRunnerLaunchCopied(false), 1600)
    } catch {
      toast.error('复制失败，请手动复制链接')
    }
  }, [localRunner?.launch_url])
  const handleLaunchLocalConnector = useCallback(() => {
    if (!localRunner?.launch_url) {
      toast.warning('请先开启本地执行模式生成连接会话')
      return
    }
    window.location.href = localRunner.launch_url
    toast.info('正在唤起 AutoCode Local Connector', {
      description: '如果浏览器没有反应，请先安装本地连接器，或使用高级脚本方式。',
    })
  }, [localRunner?.launch_url])
  const [localRequestedFilePath, setLocalRequestedFilePath] = useState<string | null>(null)

  // ── 可拖拽调整对话面板宽度 ──
  const isResizing = useRef(false)
  const minChatWidth = 260
  const maxChatWidth = 600

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    isResizing.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing.current) return
      // 获取 WorkspaceArea 容器的宽度（flex-1 部分）
      const container = document.getElementById('autocode-workspace')
      if (!container) return
      const rect = container.getBoundingClientRect()
      const newWidth = rect.right - e.clientX
      setChatPanelWidth(Math.min(maxChatWidth, Math.max(minChatWidth, newWidth)))
    }
    const handleMouseUp = () => {
      if (isResizing.current) {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [setChatPanelWidth])

  // 移动端检测
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])
  const [mobilePanel, setMobilePanel] = useState<'workspace' | 'assistant'>('workspace')

  const openWorkspaceFile = useCallback((path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
    if (!normalized) return
    setLocalRequestedFilePath(normalized)
    onTabChange('files')
    if (isMobile) setMobilePanel('workspace')
  }, [isMobile, onTabChange])

  return (
    <div id="autocode-workspace" className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden min-w-0">
      <div className="lg:hidden shrink-0 border-b bg-background/95 px-3 py-2">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            onClick={() => setMobilePanel('workspace')}
            className={cn(
              'h-8 rounded-md text-xs font-medium transition-colors',
              mobilePanel === 'workspace' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            工作区
          </button>
          <button
            type="button"
            onClick={() => setMobilePanel('assistant')}
            className={cn(
              'h-8 rounded-md text-xs font-medium transition-colors',
              mobilePanel === 'assistant' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
            )}
          >
            AI 助手
            <span className="ml-1 text-[10px] text-muted-foreground">{task.messages.length}</span>
          </button>
        </div>
      </div>
      {/* ── 左：预览/终端/Git 区域 ── */}
      <div className={cn(
        'flex-1 min-h-0 flex-col overflow-hidden min-w-0',
        mobilePanel === 'assistant' ? 'hidden lg:flex' : 'flex'
      )}>
        {/* 顶部任务信息栏 */}
        <div className="flex items-center justify-between min-h-12 pl-12 pr-3 md:px-4 border-b bg-background/95 backdrop-blur shrink-0 gap-2 py-2 md:py-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon className={cn('w-4 h-4 shrink-0', TYPE_COLOR[task.projectType])} />
            <h2 className="text-sm font-semibold truncate">{task.title}</h2>
            <Badge variant="outline" className="text-[10px] hidden sm:flex gap-1 shrink-0">
              <span className={cn('w-1.5 h-1.5 rounded-full', sc.dot)} />
              <span className={sc.color}>{sc.label}</span>
            </Badge>

            {/* 连接状态指示 */}
            {task.backendTaskId && task.status !== 'completed' && task.status !== 'failed' && (
              <Badge
                variant="outline"
                className={cn(
                  'text-[10px] hidden md:flex gap-1 shrink-0',
                  connectionStatus === 'connected' && 'border-green-500/50 text-green-600 dark:text-green-400',
                  connectionStatus === 'connecting' && 'border-yellow-500/50 text-yellow-600 dark:text-yellow-400',
                  connectionStatus === 'disconnected' && 'border-red-500/50 text-red-600 dark:text-red-400',
                )}
              >
                <span className={cn(
                  'w-1.5 h-1.5 rounded-full',
                  connectionStatus === 'connected' && 'bg-green-500',
                  connectionStatus === 'connecting' && 'bg-yellow-500 animate-pulse',
                  connectionStatus === 'disconnected' && 'bg-red-500',
                )} />
                {connectionStatus === 'connected' ? '实时' : connectionStatus === 'connecting' ? '连接中' : '轮询'}
              </Badge>
            )}

          </div>

          {/* 进度条（运行中时显示） */}
          {task.status === 'running' && (
            <div className="hidden sm:flex items-center gap-2 shrink-0">
              <div className="w-24 sm:w-36 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-500"
                  style={{ width: `${task.progress}%` }}
                />
              </div>
              <span className="text-xs text-muted-foreground shrink-0">{task.progress}%</span>
            </div>
          )}

          {/* 停止按钮（运行中时显示） */}
          {task.status === 'running' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0 text-destructive hover:text-destructive"
                  onClick={onStop}
                >
                  <Square className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>停止任务</TooltipContent>
            </Tooltip>
          )}

          {task.backendTaskId && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 shrink-0 gap-1.5 px-2 text-xs"
                      disabled={updatingToolPolicy}
                    >
                      {updatingToolPolicy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Shield className="h-3.5 w-3.5" />}
                      <span className="hidden xl:inline">{getToolPolicyLabel(currentToolPolicy)}</span>
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>工具权限策略</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-64">
                {TOOL_POLICY_OPTIONS.map(option => (
                  <DropdownMenuItem
                    key={option.value}
                    className="flex cursor-pointer items-start gap-2"
                    onClick={() => void handleToolPolicyChange(option.value)}
                  >
                    <Shield className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      option.value === currentToolPolicy ? 'text-primary' : 'text-muted-foreground'
                    )} />
                    <span className="min-w-0">
                      <span className="block text-xs font-medium">{option.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{option.description}</span>
                    </span>
                    {option.value === currentToolPolicy && <CheckCircle2 className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <div className="px-2 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  越权路径、工作区外访问和禁用命令始终会被拦截。
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {task.backendTaskId && (
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className={cn(
                        'h-8 shrink-0 gap-1.5 px-2 text-xs',
                        localRunnerConnected && 'border-green-500/50 text-green-600 dark:text-green-400',
                        localRunnerUpdateRequired && 'border-red-500/50 text-red-600 dark:text-red-400',
                        localRunnerEnabled && !localRunnerConnected && !localRunnerUpdateRequired && 'border-amber-500/50 text-amber-600 dark:text-amber-400',
                      )}
                      disabled={updatingLocalRunner}
                    >
                      {updatingLocalRunner ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <MonitorPlay className="h-3.5 w-3.5" />}
                      <span className="hidden xl:inline">
                        {localRunnerUpdateRequired ? '需更新' : localRunnerConnected ? '本地已连接' : localRunnerEnabled ? '等待本地' : '云端执行'}
                      </span>
                      <ChevronDown className="h-3 w-3 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>本地执行模式</TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="w-96 max-w-[calc(100vw-1rem)]">
                <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium">本地执行模式</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        让 AI 在你的电脑项目目录中读写文件、运行测试，再把变更镜像回云端审查。
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={(localRunnerEnabled || localRunnerConnected) ? 'outline' : 'default'}
                      className="h-7 shrink-0 text-xs"
                      onClick={() => void handleLocalRunnerToggle(!(localRunnerEnabled || localRunnerConnected))}
                    >
                      {(localRunnerEnabled || localRunnerConnected) ? '关闭' : '开启'}
                    </Button>
                  </div>
                </div>
                <DropdownMenuSeparator />
                <div className="space-y-2 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
                  <div className={cn('font-medium', localRunnerUpdateRequired ? 'text-red-600 dark:text-red-400' : localRunnerConnected ? 'text-green-600 dark:text-green-400' : localRunnerEnabled ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                    {localRunnerUpdateRequired ? '本地连接器版本过低，请安装最新版' : localRunnerConnected ? `已连接：${localRunner?.project_root || '本地项目'}` : localRunnerEnabled ? '已开启，等待本地 Runner 连接' : '当前使用服务器工作区执行'}
                  </div>
                  {(localRunnerEnabled || localRunnerConnected || localDeviceGrants.length > 0) && (
                    <>
                      {localRunnerUpdateRequired && (
                        <div className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-red-700 dark:text-red-300">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            当前版本 {localRunner?.runner_version || '未知'}，最低需要 {localRunner?.connector_min_version || '最新版'}。更新后重新点击“一键连接本地项目”。
                          </span>
                        </div>
                      )}
                      {task.localImportMode && (
                        <div className={cn(
                          'flex items-start gap-2 rounded-md border px-2 py-1.5',
                          task.cloudSnapshotStatus === 'synced'
                            ? 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'
                            : task.cloudSnapshotStatus === 'failed'
                              ? 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'
                              : 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                        )}>
                          {task.cloudSnapshotStatus === 'synced'
                            ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                          <div className="min-w-0 flex-1">
                            <div className="font-medium">
                              {task.cloudSnapshotStatus === 'synced' ? '云端副本已同步' : '本地导入项目尚未同步云端副本'}
                            </div>
                            <div className="mt-0.5">
                              {task.cloudSnapshotStatus === 'synced'
                                ? '关闭本地执行后，AI 可以使用云端工作区继续操作。'
                                : task.cloudSnapshotError || '关闭本地执行前需要先同步云端副本，否则云端没有项目文件。'}
                            </div>
                          </div>
                          {needsCloudSnapshot && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 shrink-0 text-xs"
                              onClick={() => void handleSyncLocalSnapshot()}
                              disabled={syncingLocalSnapshot || !localRunnerConnected}
                            >
                              {syncingLocalSnapshot ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <FileDown className="mr-1.5 h-3.5 w-3.5" />}
                              同步云端副本
                            </Button>
                          )}
                        </div>
                      )}
                      {localDeviceGrants.length > 0 && (
                        <div className="rounded-md border bg-muted/30 px-2 py-1.5">
                          <div className="mb-1.5 flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-foreground">选择已授权设备</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-[11px]"
                              onClick={() => void refreshLocalDeviceGrants()}
                            >
                              <RefreshCw className="mr-1 h-3 w-3" />
                              刷新
                            </Button>
                          </div>
                          <div className="max-h-44 space-y-1 overflow-y-auto pr-1">
                            {localDeviceGrants.slice(0, 12).map(grant => {
                              const online = Boolean(grant.device_online)
                              return (
                                <button
                                  key={`${grant.grant_id}-${grant.device_id || 'device'}`}
                                  type="button"
                                  className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors',
                                    online ? 'hover:bg-background' : 'opacity-70'
                                  )}
                                  onClick={() => void handleConnectLocalDevice(grant)}
                                  disabled={!online || updatingLocalRunner}
                                >
                                  <span className="min-w-0">
                                    <span className="block truncate text-[11px] font-medium text-foreground">
                                      {grant.device_name || grant.device_id || '本地设备'} · {grant.project_name || '本地项目'}
                                    </span>
                                    <span className="block truncate text-[10px] text-muted-foreground">
                                      {grant.project_root}
                                    </span>
                                    <span className="block truncate text-[10px] text-muted-foreground">
                                      {grant.device_os || 'unknown'} · {grant.device_last_seen_at ? formatBeijingDateTime(grant.device_last_seen_at) : '未上报'}
                                    </span>
                                  </span>
                                  <Badge variant={online ? 'default' : 'outline'} className="shrink-0 text-[10px]">
                                    {online ? '在线' : '离线'}
                                  </Badge>
                                </button>
                              )
                            })}
                          </div>
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-7 text-xs"
                          onClick={handleLaunchLocalConnector}
                          disabled={!localRunnerLaunchUrl}
                        >
                          <MonitorPlay className="mr-1.5 h-3.5 w-3.5" />
                          一键连接本地项目
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs"
                          onClick={() => window.open(localRunnerInstallUrl, '_blank')}
                        >
                          <Download className="mr-1.5 h-3.5 w-3.5" />
                          {localRunnerUpdateRequired ? '更新连接器' : '安装连接器'}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className={cn(
                            'h-7 text-xs transition-colors',
                            localRunnerLaunchCopied && 'border-green-500/60 bg-green-500/10 text-green-700 dark:text-green-300'
                          )}
                          onClick={() => void handleCopyLocalRunnerLaunchUrl()}
                          disabled={!localRunnerLaunchUrl}
                        >
                          {localRunnerLaunchCopied ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                          {localRunnerLaunchCopied ? '已复制' : '复制唤起链接'}
                        </Button>
                      </div>
                      <details className="rounded-md border bg-muted/40 px-2 py-1.5">
                        <summary className="cursor-pointer text-[11px] font-medium text-foreground">高级：脚本方式启动</summary>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => window.open(getAutoCodeLocalRunnerDownloadUrl(), '_blank')}
                          >
                            <Download className="mr-1.5 h-3.5 w-3.5" />
                            下载脚本
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className={cn('h-7 text-xs transition-colors', localRunnerCommandCopied && 'border-green-500/60 bg-green-500/10 text-green-700 dark:text-green-300')}
                            onClick={() => void handleCopyLocalRunnerCommand()}
                            disabled={!localRunner?.command}
                          >
                            {localRunnerCommandCopied ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                            {localRunnerCommandCopied ? '已复制' : '复制命令'}
                          </Button>
                        </div>
                        <pre className={cn(
                          'mt-2 max-h-32 overflow-auto rounded-md bg-background/80 p-2 font-mono text-[10px] text-foreground transition-colors',
                          localRunnerCommandCopied && 'ring-1 ring-green-500/40'
                        )}>
                          {localRunner?.command || '开启后会生成启动命令'}
                        </pre>
                      </details>
                      <div>
                        在项目根目录创建 <code className="rounded bg-muted px-1">.autocodeignore</code> 可排除无需同步的文件，默认忽略 .git、node_modules、dist、build、.env、日志和缓存。
                      </div>
                    </>
                  )}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* 外部链接 */}
          {task.backendTaskId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={() => window.open(`${window.location.origin}/autocode/tasks/${task.backendTaskId}`, '_blank')}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>在 AutoCode 中打开</TooltipContent>
            </Tooltip>
          )}
        </div>

        {pendingApprovalEvent && (
          <div className={cn(
            'shrink-0 border-b px-3 py-2 text-xs',
            pendingApprovalMeta.highRisk
              ? 'border-destructive/40 bg-destructive/10'
              : 'border-amber-500/30 bg-amber-500/10'
          )}>
            <div className="flex flex-wrap items-center gap-2">
              <AlertTriangle className={cn('h-4 w-4 shrink-0', pendingApprovalMeta.highRisk ? 'text-destructive' : 'text-amber-600')} />
              <div className={cn('min-w-0 flex-1', pendingApprovalMeta.highRisk ? 'text-destructive' : 'text-amber-950 dark:text-amber-50')}>
                <div className="font-medium">
                  {getApprovalModeLabel(pendingApprovalMeta)}
                </div>
                <div className={cn(
                  'mt-0.5 truncate',
                  pendingApprovalMeta.highRisk ? 'text-destructive/80' : 'text-amber-900/80 dark:text-amber-100/80'
                )}>{pendingApprovalTitle}</div>
                {pendingApprovalCommand && (
                  <code className="mt-1 block max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded bg-background/80 px-2 py-1 font-mono text-[11px] text-foreground">
                    {pendingApprovalCommand}
                  </code>
                )}
                {approvalError && <div className="mt-1 text-destructive">{approvalError}</div>}
              </div>
              <ApprovalCountdownActions
                event={pendingApprovalEvent}
                approving={approvingEventId === pendingApprovalEvent.id}
                onApproval={handleInlineApprovalEvent}
              />
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                onClick={() => onTabChange('events')}
              >
                查看详情
              </Button>
            </div>
          </div>
        )}

        {task.projectRecon && (
          <div className="flex shrink-0 items-center gap-2 border-b bg-blue-500/5 px-3 py-1.5 text-[11px] text-muted-foreground">
            <FileSearch className="h-3.5 w-3.5 shrink-0 text-blue-500" />
            <span className="min-w-0 flex-1 truncate">
              项目侦察：{String(task.projectRecon.project_kind || 'unknown')} · {task.complexity || String(task.projectRecon.complexity || '-')} · {task.recommendedFlow || String(task.projectRecon.recommended_flow || '-')}
              {task.prototypeRequired === false ? ' · 已跳过原型' : ''}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-[11px]"
              onClick={() => {
                setLocalRequestedFilePath('.autocode/PROJECT_PROFILE.md')
                onTabChange('files')
              }}
            >
              查看画像
            </Button>
          </div>
        )}

        {/* Tab 切换 */}
        <div className="flex items-center gap-0.5 px-3 h-10 md:h-9 border-b bg-muted/30 shrink-0 overflow-x-auto overscroll-x-contain">
          {[
            { id: 'preview' as const, icon: Eye, label: '预览' },
            { id: 'files' as const, icon: FolderIcon, label: '文件' },
            { id: 'workfiles' as const, icon: FileText, label: '工作文件' },
            { id: 'plan' as const, icon: CircleDot, label: '计划' },
            { id: 'terminal' as const, icon: Terminal, label: '终端' },
            { id: 'git' as const, icon: GitBranch, label: 'Git' },
            { id: 'events' as const, icon: Activity, label: '活动', badge: pendingApprovalEvent ? '!' : undefined },
            { id: 'prototype' as const, icon: Sparkles, label: 'UI原型' },
            { id: 'review' as const, icon: Shield, label: '代码审查', badge: task.review ? (task.review.passed ? '✓' : '!') : undefined },
          ].map(({ id, icon: TabIcon, label, badge }: { id: string; icon: React.ElementType; label: string; badge?: string }) => (
            <button
              key={id}
              onClick={() => onTabChange(id as WorkspaceTab)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 px-3 py-1.5 md:py-1 rounded-md text-xs font-medium transition-colors relative whitespace-nowrap',
                activeTab === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground hover:bg-background/50'
              )}
            >
              <TabIcon className="w-3.5 h-3.5" />
              {label}
              {badge && (
                <span className={cn(
                  'ml-0.5 text-[10px] font-bold px-1 rounded-full leading-none',
                  badge === '✓' ? 'bg-green-500/20 text-green-600' : 'bg-red-500/20 text-red-600'
                )}>{badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* 内容区 */}
        <div className="flex-1 overflow-hidden bg-muted/20 pb-[var(--mobile-bottom-nav-space)] lg:pb-0">
          {activeTab === 'preview' && (
            <PreviewPanel task={task} previewSrc={previewSrc} onRetry={onRetry} previewRefreshKey={previewRefreshKey} setPreviewRefreshKey={setPreviewRefreshKey} />
          )}
          {activeTab === 'files' && (
            <WorkspaceFilesPanel
              task={task}
              requestedPath={requestedFileRequest?.path || localRequestedFilePath}
              requestedLine={requestedFileRequest?.line}
              onRequestedPathHandled={() => {
                setLocalRequestedFilePath(null)
                onRequestedFilePathHandled?.()
              }}
            />
          )}
          {activeTab === 'workfiles' && (
            <WorkFilesPanel
              task={task}
              onOpenFile={(path) => {
                setLocalRequestedFilePath(path)
                onTabChange('files')
              }}
            />
          )}
          {activeTab === 'terminal' && (
            <TerminalPanel task={task} />
          )}
          {activeTab === 'git' && (
            <GitPanel task={task} focusTarget={gitFocusTarget} onFocusHandled={onGitFocusHandled} />
          )}
          {activeTab === 'events' && (
            <RuntimeEventsPanel task={task} toolRegistry={toolDisplayRegistry} />
          )}
          {activeTab === 'plan' && (
            <PlanPanel task={task} onEnablePlanning={onEnablePlanning} />
          )}
          {activeTab === 'prototype' && (
            <PrototypePanel task={task} />
          )}
          {activeTab === 'review' && (
            <ReviewPanel task={task} />
          )}
        </div>
      </div>

      {/* 拖拽调整宽度的把手 */}
      <div
        className="hidden lg:block w-1.5 cursor-col-resize hover:bg-primary/50 active:bg-primary/70 transition-colors shrink-0 group relative"
        onMouseDown={handleMouseDown}
      >
        <div className="absolute inset-y-0 -left-1 -right-1" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-1 h-8 rounded-full bg-muted-foreground/20 group-hover:bg-primary/60 transition-colors" />
      </div>

      {/* ── 右：AI 对话控制区 ── */}
      <div
        className={cn(
          'flex-1 min-h-0 lg:flex-initial lg:shrink-0 flex-col border-t lg:border-l lg:border-t-0 bg-background min-w-0',
          mobilePanel === 'workspace' ? 'hidden lg:flex' : 'flex'
        )}
        style={isMobile ? undefined : { width: chatPanelWidth }}
      >
        {/* 对话标题 + 模型选择 */}
        <div className="flex items-center gap-2 px-3 md:px-4 h-12 border-b shrink-0">
          <Bot className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">AI 开发助手</span>
          {/* 模型选择器 */}
          <ModelSelector taskModel={task.model} />
          <span className="ml-auto text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
            {task.messages.length} 条消息
          </span>
        </div>

        {/* 当前步骤提示 */}
        {task.status === 'running' && (
          <div className="mx-3 mt-3 px-3 py-2 bg-blue-500/10 rounded-lg border border-blue-500/20">
            <div className="flex items-center gap-1.5">
              <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin shrink-0" />
              <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">{task.currentStep}</p>
            </div>
          </div>
        )}

        {task.runtimeNote && task.runtimeState !== 'terminal' && (
          <div className={cn(
            'mx-3 mt-2 px-3 py-2 rounded-lg border text-xs',
            task.runtimeState === 'active'
              ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-400'
              : task.runtimeState === 'waiting'
                ? 'bg-amber-500/10 border-amber-500/25 text-amber-700 dark:text-amber-400'
                : 'bg-muted/60 border-border text-muted-foreground'
          )}>
            <div className="flex items-center gap-1.5">
              {task.runtimeState === 'active' ? <CircleDot className="w-3.5 h-3.5 shrink-0" /> : <Clock className="w-3.5 h-3.5 shrink-0" />}
              <span className="leading-relaxed">{task.runtimeNote}</span>
            </div>
          </div>
        )}

        {/* 停止/失败/完成后的"继续"提示横幅 */}
        {(task.status === 'stopped' || task.status === 'failed' || task.status === 'completed') && (
          <div className="mx-3 mt-3 px-3 py-2.5 bg-blue-500/10 rounded-lg border border-blue-500/30">
            <div className="flex items-start gap-2">
              <RotateCw className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-xs text-blue-600 dark:text-blue-400 font-medium">
                  {task.status === 'completed' ? '✅ 任务已完成，可继续迭代' : task.status === 'failed' ? '❌ 任务已停止/失败，可继续' : '⏹ 任务已停止，可继续'}
                </p>
                <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">
                  在下方输入新指令，AI 会从之前的位置继续。可修改需求，AI 会判断如何调整。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 消息列表 */}
        <ScrollArea className="flex-1 px-3 py-2 min-w-0">
          <div className="space-y-3 min-w-0 pb-4">
            {task.messages.map(msg => (
              <ChatBubble key={msg.id} msg={msg} onOpenFile={openWorkspaceFile} />
            ))}
            {chatLoading && (
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                  <Bot className="w-3.5 h-3.5 text-primary" />
                </div>
                <div className="bg-muted rounded-xl px-3 py-2">
                  <div className="flex gap-1 items-center h-4">
                    {[0, 1, 2].map(i => (
                      <div key={i} className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
        </ScrollArea>

        {/* AI 对话输入 — 复用 ChatInput 组件 */}
        <ChatInput
          conversationId={task.id}
          onSend={onSend}
          onStop={onStopChat}
          isGenerating={chatLoading}
          placeholder={
            task.status === 'running'
              ? '告诉 AI 你想要的功能，或上传图片/文件...'
              : task.status === 'completed' || task.status === 'failed' || task.status === 'stopped'
                ? '输入新指令让 AI 继续开发，可修改需求...'
                : '告诉 AI 你想要的功能...'
          }
          hintText="Enter 发送 · Shift+Enter 换行 · 支持粘贴截图和文件"
          aboveSlot={
            <div className="flex gap-1 mb-2 overflow-x-auto px-2 sm:px-0 pb-1">
              {['添加登录功能', '优化样式', '添加深色模式', '一键部署'].map(q => (
                <button
                  key={q}
                  onClick={() => onSend(q)}
                  className="shrink-0 text-[10px] px-2 py-1 rounded-full border border-border hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                >
                  {q}
                </button>
              ))}
            </div>
          }
        />
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// 简易 Markdown 渲染（复用 chat-prose 样式）
// ──────────────────────────────────────────

marked.setOptions({ gfm: true, breaks: true })

function SimpleMarkdown({ content }: { content: string }) {
  const html = useMemo(() => {
    if (!content) return ''
    try {
      return marked.parse(content, { breaks: true, gfm: true }) as string
    } catch {
      return content.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  }, [content])

  return (
    <div
      className="chat-prose text-xs break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

const WORKSPACE_FILE_PATTERN = /(?:^|[\s([`"'，。；：])((?:(?:\.?\/)?(?:src|app|components|pages|lib|utils|hooks|store|stores|backend|frontend|agent-platform|public|api|core|services|schemas|tests|test|deploy|scripts|\.autocode)\/|[A-Za-z0-9_.-]+\/)[A-Za-z0-9_./@()+-]+\.(?:tsx|ts|jsx|js|mjs|cjs|vue|svelte|css|scss|less|html|md|json|py|java|kt|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|env|txt))(?:[:#][0-9]+)?/g

function extractFileReferences(content: string): string[] {
  const refs: string[] = []
  const seen = new Set<string>()
  for (const match of content.matchAll(WORKSPACE_FILE_PATTERN)) {
    const path = (match[1] || '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/[:#]\d+$/, '')
    if (!path || seen.has(path)) continue
    seen.add(path)
    refs.push(path)
    if (refs.length >= 8) break
  }
  return refs
}

// ──────────────────────────────────────────
// 对话气泡
// ──────────────────────────────────────────

function ChatBubble({ msg, onOpenFile }: { msg: ChatMsg; onOpenFile?: (path: string) => void }) {
  const isUser = msg.role === 'user'
  const isSystem = msg.role === 'system'
  const files = msg.files || []
  const fileRefs = useMemo(() => extractFileReferences(`${msg.content}\n${msg.toolResult || ''}`), [msg.content, msg.toolResult])

  // 系统消息（工具进度、阶段进度）→ 科技感紧凑设计
  if (isSystem) {
    // 工具/阶段图标映射
    const getToolIcon = () => {
      const name = msg.toolName || ''
      const content = msg.content || ''
      if (name === 'write_file') return { icon: FilePen, color: 'text-sky-500', bg: 'bg-sky-500/10', border: 'border-l-sky-500/50' }
      if (name === 'bash') return { icon: TerminalSquare, color: 'text-amber-500', bg: 'bg-amber-500/10', border: 'border-l-amber-500/50' }
      if (name === 'read_file') return { icon: FileSearch, color: 'text-violet-500', bg: 'bg-violet-500/10', border: 'border-l-violet-500/50' }
      if (name === 'glob') return { icon: Search, color: 'text-cyan-500', bg: 'bg-cyan-500/10', border: 'border-l-cyan-500/50' }
      if (name === 'git_commit') return { icon: GitCommitHorizontal, color: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-l-orange-500/50' }
      if (name === 'request_confirmation') return { icon: MessageCircleQuestion, color: 'text-yellow-500', bg: 'bg-yellow-500/10', border: 'border-l-yellow-500/50' }
      if (content.startsWith('📦')) return { icon: Package, color: 'text-blue-500', bg: 'bg-blue-500/10', border: 'border-l-blue-500/50' }
      if (content.startsWith('✅')) return { icon: CircleCheck, color: 'text-green-500', bg: 'bg-green-500/10', border: 'border-l-green-500/50' }
      if (content.startsWith('🔨')) return { icon: Hammer, color: 'text-orange-500', bg: 'bg-orange-500/10', border: 'border-l-orange-500/50' }
      if (content.startsWith('🌐')) return { icon: MonitorPlay, color: 'text-teal-500', bg: 'bg-teal-500/10', border: 'border-l-teal-500/50' }
      return { icon: CircleDot, color: 'text-muted-foreground', bg: 'bg-muted/30', border: 'border-l-muted-foreground/30' }
    }
    const { icon: Icon, color, border } = getToolIcon()
    // 清理内容中的 emoji 前缀（已由图标替代）
    const cleanContent = msg.content
      .replace(/^[📦✅🔨🌐⏳📝⚡📖🔍💾]+\s*/, '')
      .trim()

    const hasLongResult = !!msg.toolResult && msg.toolResult !== '(无输出)' && msg.toolResult.length > 40

    return (
      <div className="flex justify-center py-0.5">
        <div className={cn(
          'rounded-md border border-border/40 border-l-2 max-w-[95%]',
          'bg-muted/30 backdrop-blur-sm',
          border
        )}>
          <div className="flex items-center gap-2 px-2.5 py-1">
            <Icon className={cn('w-3 h-3 shrink-0', color)} />
            <span className="break-all leading-relaxed text-[11px] text-muted-foreground font-mono">
              {cleanContent}
            </span>
            {fileRefs.length > 0 && onOpenFile && (
              <button
                type="button"
                onClick={() => onOpenFile(fileRefs[0])}
                className="hidden sm:inline-flex items-center gap-1 text-[10px] text-primary hover:underline font-mono max-w-[160px] truncate"
                title={`打开 ${fileRefs[0]}`}
              >
                <FileSearch className="w-3 h-3 shrink-0" />
                {fileRefs[0]}
              </button>
            )}
            {msg.toolResult && msg.toolResult !== '(无输出)' && (
              <span className="text-[10px] text-muted-foreground/40 break-all max-w-[120px] truncate font-mono shrink-0 hidden sm:inline">
                {msg.toolResult.startsWith('[OK]') ? 'ok' : msg.toolResult.slice(0, 40)}
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/25 shrink-0 whitespace-nowrap font-mono">
              {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          {hasLongResult && (
            <details className="border-t border-border/40 px-2.5 py-1">
              <summary className="cursor-pointer text-[10px] text-muted-foreground hover:text-foreground">查看命令详情</summary>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background/80 p-2 font-mono text-[10px] text-muted-foreground">
                {msg.toolResult}
              </pre>
            </details>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={cn('flex items-start gap-2', isUser && 'flex-row-reverse')}>
      <div className={cn(
        'w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold',
        isUser ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
      )}>
        {isUser ? 'U' : <Bot className="w-3.5 h-3.5" />}
      </div>
      <div className={cn(
        'max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed',
        isUser ? 'bg-primary text-primary-foreground rounded-tr-sm' : 'bg-muted rounded-tl-sm'
      )}>
        {/* 文字内容 — Markdown 渲染 */}
        <SimpleMarkdown content={msg.content} />

        {fileRefs.length > 0 && onOpenFile && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {fileRefs.map(ref => (
              <button
                key={ref}
                type="button"
                onClick={() => onOpenFile(ref)}
                className={cn(
                  'inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[10px] font-mono transition-colors',
                  isUser
                    ? 'border-primary-foreground/20 bg-primary-foreground/10 text-primary-foreground hover:bg-primary-foreground/15'
                    : 'border-border bg-background/70 text-primary hover:bg-background'
                )}
                title={`在文件面板中打开 ${ref}`}
              >
                <FileSearch className="w-3 h-3 shrink-0" />
                <span className="truncate">{ref}</span>
              </button>
            ))}
          </div>
        )}

        {/* 文件附件 */}
        {files.length > 0 && (
          <div className={cn('mt-1.5 flex flex-wrap gap-1')}>
            {files.map(f => (
              <a
                key={f.id}
                href={f.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded text-[10px] underline underline-offset-2',
                  isUser ? 'bg-primary-foreground/10 text-primary-foreground' : 'bg-background text-foreground border'
                )}
              >
                {f.type.startsWith('image/') ? (
                  <ImageIcon className="w-3 h-3 shrink-0" />
                ) : (
                  <Paperclip className="w-3 h-3 shrink-0" />
                )}
                <span className="truncate max-w-[120px]">{f.name}</span>
              </a>
            ))}
          </div>
        )}

        <p className={cn('text-[10px] mt-1 opacity-60', isUser ? 'text-right' : '')}>
          {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// 预览面板
// ──────────────────────────────────────────

function PreviewPanel({ task, previewSrc, onRetry, previewRefreshKey, setPreviewRefreshKey }: {
  task: AutoCodeTask
  previewSrc: string | null
  onRetry: () => void
  previewRefreshKey: number
  setPreviewRefreshKey: React.Dispatch<React.SetStateAction<number>>
}) {
  const [showLog, setShowLog] = useState(false)
  const [logContent, setLogContent] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [activePanel, setActivePanel] = useState<'preview' | 'files' | 'devserver'>('preview')
  const [fileTree, setFileTree] = useState<AutoCodeWorkspaceFile[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [filesLoading, setFilesLoading] = useState(false)
  const [stuckWarning, setStuckWarning] = useState(false) // 0% 超时警告
  const [stuckLogContent, setStuckLogContent] = useState('') // 卡住时拉取的日志

  // ── 文件查看/编辑状态 ──
  const [fileViewerOpen, setFileViewerOpen] = useState(false)
  const [viewingFile, setViewingFile] = useState<{path: string; name: string; content: string; size: number} | null>(null)
  const [editingFile, setEditingFile] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [savingFile, setSavingFile] = useState(false)
  const [fileLoading, setFileLoading] = useState(false)
  const [copiedFile, setCopiedFile] = useState(false)
  const [runningFile, setRunningFile] = useState(false)
  const [runOutput, setRunOutput] = useState('')

  // 0% 超时检测（必须在条件分支之前）
  useEffect(() => {
    if (task.status !== 'running' || task.progress > 0) {
      setStuckWarning(false)
      return
    }
    const timer = setTimeout(() => {
      setStuckWarning(true)
      // 自动拉取后端日志帮助诊断
      if (task.backendTaskId) {
        fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/logs`, {
          headers: getAcAuthHeaders()
        })
          .then(r => r.ok ? r.json() : null)
          .then(data => {
            if (data?.logs?.length) {
              setStuckLogContent(data.logs.map((l: {message: string; level: string; detail?: string}) =>
                l.detail
                  ? `[${l.level?.toUpperCase() || 'INFO'}] ${l.message}\n    └ ${l.detail}`
                  : `[${l.level?.toUpperCase() || 'INFO'}] ${l.message}`
              ).join('\n'))
            }
          })
          .catch(() => {})
      }
    }, 15000) // 15 秒后检查
    return () => clearTimeout(timer)
  }, [task.status, task.progress, task.backendTaskId])

  // 获取 Dev Server 日志
  const fetchLogs = useCallback(async () => {
    if (!task.backendTaskId) return
    setLogLoading(true)
    try {
      const res = await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/dev-server`, {
        headers: getAcAuthHeaders()
      })
      if (res.ok) {
        const data = await res.json()
        setLogContent(data.error_detail || data.output || '无日志')
        if (data.status === 'running' && data.url) {
          setShowLog(false)
          setPreviewRefreshKey(k => k + 1)
        }
      }
    } catch { /* ignore */ }
    setLogLoading(false)
  }, [task.backendTaskId])

  // 手动重启 Dev Server
  const restartDevServer = useCallback(async () => {
    if (!task.backendTaskId) return
    setRestarting(true)
    try {
      const res = await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/dev-server/restart`, { method: 'POST', headers: getAcAuthHeaders() })
      if (res.ok) {
        const data = await res.json()
        if (data.ok) {
          setPreviewRefreshKey(k => k + 1)
        }
      }
    } catch { /* ignore */ }
    setRestarting(false)
  }, [task.backendTaskId])

  // 获取文件列表
  const fetchFiles = useCallback(async (path: string) => {
    if (!task.backendTaskId) return
    setFilesLoading(true)
    try {
      const res = await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files?path=${encodeURIComponent(path)}`, {
        headers: getAcAuthHeaders()
      })
      if (res.ok) {
        const data = await res.json()
        setFileTree(Array.isArray(data.files) ? data.files.map((f: AutoCodeWorkspaceFile) => normalizeWorkspaceFile(f)) : [])
        setCurrentPath(data.path || path)
      }
    } catch { /* ignore */ }
    setFilesLoading(false)
  }, [task.backendTaskId])

  // ── 查看文件 ──
  const handleViewFile = useCallback(async (filePath: string, fileName: string) => {
    if (!task.backendTaskId) return
    setFileLoading(true)
    setFileViewerOpen(true)
    setViewingFile(null)
    setEditingFile(false)
    setRunOutput('')
    try {
      const res = await fetch(
        `${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files/content?path=${encodeURIComponent(filePath)}`,
        { headers: getAcAuthHeaders() }
      )
      if (res.ok) {
        const data = await res.json()
        const fileContent = toDisplayText(data.content)
        setViewingFile({
          path: filePath,
          name: toDisplayText(data.name, fileName),
          content: fileContent,
          size: data.size,
        })
        setEditContent(fileContent)
      } else {
        const err = await res.json()
        setViewingFile({
          path: filePath,
          name: fileName,
          content: `[无法预览此文件] ${toDisplayText(err.detail, '请使用下载功能')}`,
          size: 0,
        })
      }
    } catch {
      setViewingFile({
        path: filePath,
        name: fileName,
        content: '[加载文件失败，请检查后端服务是否正常]',
        size: 0,
      })
    }
    setFileLoading(false)
  }, [task.backendTaskId])

  // ── 保存文件 ──
  const handleSaveFile = useCallback(async () => {
    if (!task.backendTaskId || !viewingFile) return
    setSavingFile(true)
    try {
      const res = await fetch(
        `${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files/content`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', ...getAcAuthHeaders() },
          body: JSON.stringify({ path: viewingFile.path, content: editContent }),
        }
      )
      if (res.ok) {
        setViewingFile({ ...viewingFile, content: editContent })
        setEditingFile(false)
      } else {
        const err = await res.json()
        alert(`保存失败: ${err.detail || '未知错误'}`)
      }
    } catch {
      alert('保存失败，请检查后端服务')
    }
    setSavingFile(false)
  }, [task.backendTaskId, viewingFile, editContent])

  // ── 下载单个文件 ──
  const downloadWithAuth = useCallback(async (url: string, fallbackName: string) => {
    const res = await fetch(url, { headers: getAcAuthHeaders() })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `下载失败: ${res.status}`)
    }
    const blob = await res.blob()
    const disposition = res.headers.get('Content-Disposition') || ''
    const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^"]+)"?/i)
    const filename = match ? decodeURIComponent(match[1] || match[2] || fallbackName) : fallbackName
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  }, [])

  const handleDownloadFile = useCallback((filePath: string) => {
    if (!task.backendTaskId) return
    downloadWithAuth(
      `${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files/download?path=${encodeURIComponent(filePath)}`,
      filePath.split('/').pop() || 'download'
    ).catch(err => alert(err?.message || '下载失败'))
  }, [downloadWithAuth, task.backendTaskId])

  // ── 下载整个项目 ──
  const handleDownloadProject = useCallback(() => {
    if (!task.backendTaskId) return
    downloadWithAuth(
      `${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files/download-project`,
      `${task.title || 'project'}.zip`
    ).catch(err => alert(err?.message || '下载失败'))
  }, [downloadWithAuth, task.backendTaskId, task.title])

  // ── 复制文件内容 ──
  const handleCopyContent = useCallback(async () => {
    if (!viewingFile) return
    try {
      await navigator.clipboard.writeText(viewingFile.content)
      setCopiedFile(true)
      setTimeout(() => setCopiedFile(false), 2000)
    } catch { /* ignore */ }
  }, [viewingFile])

  const canRunFile = (path?: string) => /\.(py|js|mjs|cjs|sh|ps1)$/i.test(path || '')

  const handleRunFile = useCallback(async () => {
    if (!task.backendTaskId || !viewingFile || !canRunFile(viewingFile.path)) return
    setRunningFile(true)
    setRunOutput('')
    try {
      const res = await fetch(`${AUTOCODE_API}/api/tasks/${task.backendTaskId}/files/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAcAuthHeaders() },
        body: JSON.stringify({ path: viewingFile.path }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || data.message || '运行失败')
      setRunOutput([
        `$ ${data.command || viewingFile.path}`,
        data.stdout || '',
        data.stderr ? `\n[stderr]\n${data.stderr}` : '',
        `\n退出码: ${data.exit_code}`,
      ].filter(Boolean).join('\n'))
    } catch (err) {
      const e = err as Error
      setRunOutput(e.message || '运行失败')
    } finally {
      setRunningFile(false)
    }
  }, [task.backendTaskId, viewingFile])

  // 初始加载文件树
  useEffect(() => {
    if (activePanel === 'files' && task.status === 'completed') {
      fetchFiles('/')
    }
  }, [activePanel, task.status, fetchFiles])

  if (task.status === 'pending') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
        <Loader2 className="w-8 h-8 text-muted-foreground/40 animate-spin" />
        <p className="text-sm text-muted-foreground">等待任务开始...</p>
      </div>
    )
  }

  if (task.status === 'running' && task.progress < 80) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
            <Code2 className="w-8 h-8 text-primary" />
          </div>
          <Loader2 className="w-5 h-5 text-primary animate-spin absolute -bottom-1 -right-1" />
        </div>
        <div>
          <p className="text-sm font-medium">Agent 正在开发中...</p>
          <p className="text-xs text-muted-foreground mt-1">{task.currentStep}</p>
        </div>
        <div className="w-48 h-2 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-primary to-primary/60 rounded-full transition-all duration-500"
            style={{ width: `${Math.max(task.progress, 2)}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{task.progress}% 完成</p>

        {/* 0% 超时警告 */}
        {stuckWarning && task.progress === 0 && (
          <div className="mt-2 max-w-sm w-full bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 text-left">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
              <span className="text-xs font-medium text-yellow-700 dark:text-yellow-300">
                Agent 启动缓慢，可能遇到问题
              </span>
            </div>
            <div className="text-[11px] text-muted-foreground space-y-1">
              <p>可能原因：数据库连接超时、API Key 无效、Docker 镜像缺失</p>
              <p>请查看 AutoCode Backend 日志：</p>
              <code className="block bg-muted px-2 py-1 rounded text-[10px] break-all">
                docker logs autocode-backend --tail 50
              </code>
            </div>
            {stuckLogContent && (
              <pre className="mt-2 text-[10px] bg-muted p-2 rounded max-h-24 overflow-auto whitespace-pre-wrap">
                {stuckLogContent}
              </pre>
            )}
          </div>
        )}
      </div>
    )
  }

  if (!previewSrc && task.status !== 'completed' && task.status !== 'failed') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
        <Eye className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">预览即将可用</p>
        <p className="text-xs text-muted-foreground">Agent 完成构建后自动开启预览</p>
        {task.workspaceId && (
          <div className="text-[10px] text-muted-foreground/60 font-mono bg-muted px-2 py-1 rounded">
            {task.workspaceId}
          </div>
        )}
      </div>
    )
  }

  // ── 任务完成/失败时的综合面板 ──
  const showIframe = !!previewSrc

  return (
    <div className="flex flex-col h-full">
      {/* 子 Tab 切换（完成后才显示） */}
      {task.status === 'completed' && (
        <div className="flex items-center gap-0.5 px-3 py-1 bg-muted/20 border-b shrink-0">
          {[
            { id: 'preview' as const, icon: Eye, label: '预览' },
            { id: 'files' as const, icon: GitBranch, label: '文件' },
            { id: 'devserver' as const, icon: Terminal, label: 'Dev Server' },
          ].map(({ id, icon: TabIcon, label }) => (
            <button
              key={id}
              onClick={() => {
                setActivePanel(id)
                if (id === 'files') fetchFiles('/')
                if (id === 'devserver') fetchLogs()
              }}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] font-medium transition-colors',
                activePanel === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <TabIcon className="w-3 h-3" />
              {label}
            </button>
          ))}
          {!showIframe && (
            <div className="ml-auto">
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] gap-1"
                onClick={restartDevServer}
                disabled={restarting || !task.backendTaskId}
              >
                {restarting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                重启 Dev Server
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {/* 预览失败 - 显示诊断信息 */}
        {task.status === 'completed' && !previewSrc && activePanel === 'preview' && (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
            <div className="w-14 h-14 rounded-2xl bg-green-500/10 flex items-center justify-center">
              <Rocket className="w-7 h-7 text-green-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-green-600 dark:text-green-400">开发已完成！</p>
              <p className="text-xs text-muted-foreground mt-1">Dev Server 未成功启动</p>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={restartDevServer}
                disabled={restarting || !task.backendTaskId}
              >
                {restarting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                重启 Dev Server
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => setActivePanel('files')}
              >
                <GitBranch className="w-3.5 h-3.5" />
                查看文件
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => { setActivePanel('devserver'); fetchLogs() }}
                disabled={logLoading}
              >
                <Terminal className="w-3.5 h-3.5" />
                {logLoading ? '加载中...' : '查看日志'}
              </Button>
            </div>

            {task.workspaceId && (
              <div className="text-[10px] text-muted-foreground bg-muted px-3 py-1.5 rounded-lg font-mono">
                Workspace: {task.workspaceId}
              </div>
            )}
          </div>
        )}

        {/* 任务失败 */}
        {task.status === 'failed' && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
            <div className="w-14 h-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
              <X className="w-7 h-7 text-destructive" />
            </div>
            <p className="text-sm font-medium text-destructive">开发失败</p>
            <p className="text-xs text-muted-foreground">请查看终端日志排查问题</p>
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
              重试
            </Button>
          </div>
        )}

        {/* iframe 预览 */}
        {showIframe && activePanel === 'preview' && (
          <div className="flex flex-col h-full">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/30 border-b text-[11px] text-muted-foreground">
              <div className="flex gap-1">
                <div className="w-3 h-3 rounded-full bg-red-400" />
                <div className="w-3 h-3 rounded-full bg-yellow-400" />
                <div className="w-3 h-3 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 bg-background/80 rounded px-2 py-0.5 truncate">{previewSrc}</div>
              <button onClick={() => setPreviewRefreshKey(k => k + 1)} className="hover:text-foreground transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
              <button onClick={() => window.open(previewSrc, '_blank')} className="hover:text-foreground transition-colors">
                <ExternalLink className="w-3.5 h-3.5" />
              </button>
            </div>
            <iframe
              key={previewRefreshKey}
              src={previewSrc}
              className="flex-1 w-full border-0"
              title="Project Preview"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            />
          </div>
        )}

        {/* 文件浏览器 */}
        {activePanel === 'files' && (
          <div className="h-full overflow-auto p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] lg:pb-3">
            {/* 项目下载按钮 */}
            {fileTree.length > 0 && (
              <div className="mb-3">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1.5 w-full"
                  onClick={handleDownloadProject}
                >
                  <FileArchive className="w-3.5 h-3.5" />
                  下载整个项目 (ZIP)
                </Button>
              </div>
            )}
            {filesLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                加载中...
              </div>
            ) : fileTree.length === 0 ? (
              <div className="flex items-center justify-center h-full text-xs text-muted-foreground">
                {task.backendTaskId ? '工作空间为空' : '暂无文件（请连接 AutoCode 服务）'}
              </div>
            ) : (
              <div className="space-y-0.5">
                <div className="text-[10px] text-muted-foreground font-mono mb-2 flex items-center gap-2">
                  <span className="flex-1 truncate">{currentPath}</span>
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">
                    {fileTree.length} 项
                  </span>
                </div>
                {fileTree.map(f => {
                  const relativePath = toDisplayText(f.path) || (currentPath === '/' ? f.name : `${currentPath.replace(/^\/+/, '')}/${f.name}`)
                  const itemPath = `/${relativePath.replace(/^\/+/, '')}`
                  return (
                    <div key={f.name} className="group flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-muted/50">
                      {/* 点击展开目录 / 查看文件 */}
                      <div
                        className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                        onClick={() => {
                          if (f.type === 'dir') {
                            fetchFiles(itemPath)
                          } else {
                            handleViewFile(relativePath, f.name)
                          }
                        }}
                      >
                        {f.type === 'dir' ? (
                          <FolderIcon className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
                        ) : (
                          <FileIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        )}
                        <span className="flex-1 truncate">{f.name}</span>
                        {f.type === 'file' && (
                          <span className="text-[10px] text-muted-foreground/60 shrink-0">
                            {f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`}
                          </span>
                        )}
                      </div>
                      {/* 文件操作按钮 */}
                      {f.type === 'file' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => handleDownloadFile(relativePath)}
                          title="下载文件"
                        >
                          <Download className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  )
                })}
                {currentPath !== '/' && (
                  <button
                    className="flex items-center gap-2 px-2 py-1 rounded text-xs text-muted-foreground hover:bg-muted/50 mt-1"
                    onClick={() => fetchFiles(currentPath.split('/').slice(0, -1).join('/') || '/')}
                  >
                    <ChevronLeft className="w-3 h-3" />
                    上级目录
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Dev Server 状态/日志 */}
        {activePanel === 'devserver' && (
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] gap-1"
                onClick={fetchLogs}
                disabled={logLoading || !task.backendTaskId}
              >
                {logLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                刷新
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] gap-1"
                onClick={restartDevServer}
                disabled={restarting || !task.backendTaskId}
              >
                {restarting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                重启
              </Button>
            </div>
            <div className="flex-1 overflow-auto bg-[#1e1e1e] font-mono text-xs text-green-400 p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] lg:pb-3">
              {logLoading ? (
                <div className="flex items-center gap-2">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span className="text-gray-400">加载日志...</span>
                </div>
              ) : logContent ? (
                <pre className="whitespace-pre-wrap break-all text-xs leading-relaxed">{logContent}</pre>
              ) : (
                <span className="text-gray-500">点击"刷新"获取 Dev Server 日志</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── 文件查看/编辑对话框 ── */}
      <Dialog open={fileViewerOpen} onOpenChange={setFileViewerOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-3xl h-[80vh] flex flex-col p-0 gap-0">
          <DialogHeader className="px-4 py-3 border-b shrink-0">
            <DialogDescription className="sr-only">
              查看、编辑、运行或下载当前任务工作区中的文件。
            </DialogDescription>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-sm font-mono truncate">
                {viewingFile?.name || '加载中...'}
              </DialogTitle>
              <div className="flex items-center gap-1">
                {viewingFile?.content && viewingFile.content !== `[无法预览此文件]` && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={handleCopyContent}
                    >
                      {copiedFile ? (
                        <>
                          <span className="text-green-500 text-[10px]">已复制</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3 h-3" />
                          复制
                        </>
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => {
                        if (editingFile) {
                          handleSaveFile()
                        } else {
                          setEditingFile(true)
                          setEditContent(viewingFile.content)
                        }
                      }}
                      disabled={savingFile}
                    >
                      {editingFile ? (
                        <>
                          {savingFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                          保存
                        </>
                      ) : (
                        <>
                          <Edit3 className="w-3 h-3" />
                          编辑
                        </>
                      )}
                    </Button>
                  </>
                )}
                {viewingFile && canRunFile(viewingFile.path) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={handleRunFile}
                    disabled={runningFile}
                  >
                    {runningFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <MonitorPlay className="w-3 h-3" />}
                    运行
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => viewingFile && handleDownloadFile(viewingFile.path)}
                >
                  <Download className="w-3 h-3" />
                  下载
                </Button>
              </div>
            </div>
          </DialogHeader>

          {/* 文件内容 */}
          <div className="flex-1 overflow-auto">
            {fileLoading ? (
              <div className="flex items-center justify-center h-full gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                加载文件...
              </div>
            ) : !viewingFile ? (
              <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                文件加载失败
              </div>
            ) : editingFile ? (
              <Textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full h-full min-h-full rounded-none border-0 resize-none font-mono text-xs leading-relaxed p-4 focus-visible:ring-0"
                placeholder="编辑文件内容..."
              />
            ) : (
              <div>
                <pre className="font-mono text-xs leading-relaxed p-4 whitespace-pre-wrap break-all text-foreground/90">
                  {viewingFile.content}
                </pre>
                {runOutput && (
                  <div className="border-t bg-[#111827] text-green-300">
                    <div className="px-4 py-2 text-[11px] text-green-100/80 border-b border-white/10">运行输出</div>
                    <pre className="font-mono text-xs leading-relaxed p-4 whitespace-pre-wrap break-all">
                      {runOutput}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 底部信息栏 */}
          {viewingFile && (
            <div className="flex items-center justify-between px-4 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground shrink-0">
              <span className="font-mono">{viewingFile.path}</span>
              {viewingFile.size > 0 && (
                <span>{viewingFile.size > 1024 ? `${(viewingFile.size / 1024).toFixed(1)} KB` : `${viewingFile.size} B`}</span>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function WorkspaceFilesPanel({
  task,
  requestedPath,
  requestedLine,
  onRequestedPathHandled,
}: {
  task: AutoCodeTask
  requestedPath?: string | null
  requestedLine?: number
  onRequestedPathHandled?: () => void
}) {
  const [fileTree, setFileTree] = useState<AutoCodeWorkspaceFile[]>([])
  const [currentPath, setCurrentPath] = useState('/')
  const [filesLoading, setFilesLoading] = useState(false)
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewingFile, setViewingFile] = useState<{path: string; name: string; content: string; size: number} | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [runOutput, setRunOutput] = useState('')
  const [error, setError] = useState('')
  const lineRefs = useRef<Record<number, HTMLDivElement | null>>({})

  const taskId = task.backendTaskId

  const fetchFiles = useCallback(async (path: string) => {
    if (!taskId) return
    setFilesLoading(true)
    setError('')
    try {
      const data = await listAutoCodeWorkspaceFiles(taskId, path)
      setFileTree(Array.isArray(data.files) ? data.files.map(normalizeWorkspaceFile) : [])
      setCurrentPath(data.path || path)
    } catch (err) {
      setError((err as Error).message || '文件列表加载失败')
    } finally {
      setFilesLoading(false)
    }
  }, [taskId])

  const openFile = useCallback(async (path: string) => {
    if (!taskId) return
    const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '')
    setFileLoading(true)
    setViewerOpen(true)
    setViewingFile(null)
    setEditing(false)
    setRunOutput('')
    try {
      const data = await readAutoCodeWorkspaceFile(taskId, normalized)
      const fileContent = toDisplayText(data.content)
      setViewingFile({
        path: normalized,
        name: toDisplayText(data.name, normalized.split('/').pop() || normalized),
        content: fileContent,
        size: data.size || 0,
      })
      setEditContent(fileContent)
    } catch (err) {
      setViewingFile({
        path: normalized,
        name: normalized.split('/').pop() || normalized,
        content: `[无法预览此文件]\n${(err as Error).message || '请确认路径是否存在'}`,
        size: 0,
      })
    } finally {
      setFileLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    fetchFiles('/')
  }, [fetchFiles])

  useEffect(() => {
    if (!requestedPath) return
    openFile(requestedPath)
    const dir = requestedPath.includes('/') ? `/${requestedPath.split('/').slice(0, -1).join('/')}` : '/'
    fetchFiles(dir)
    onRequestedPathHandled?.()
  }, [fetchFiles, onRequestedPathHandled, openFile, requestedPath])

  useEffect(() => {
    if (!viewerOpen || !requestedLine || fileLoading || editing) return
    const timer = window.setTimeout(() => {
      lineRefs.current[requestedLine]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [editing, fileLoading, requestedLine, viewerOpen, viewingFile?.path])

  const saveFile = useCallback(async () => {
    if (!taskId || !viewingFile) return
    setSaving(true)
    try {
      await saveAutoCodeWorkspaceFile(taskId, viewingFile.path, editContent)
      setViewingFile({ ...viewingFile, content: editContent })
      setEditing(false)
      fetchFiles(currentPath)
    } catch (err) {
      alert((err as Error).message || '保存失败')
    } finally {
      setSaving(false)
    }
  }, [currentPath, editContent, fetchFiles, taskId, viewingFile])

  const runFile = useCallback(async () => {
    if (!taskId || !viewingFile) return
    setRunning(true)
    setRunOutput('')
    try {
      const data = await runAutoCodeWorkspaceFile(taskId, viewingFile.path)
      setRunOutput([
        `$ ${data.command || viewingFile.path}`,
        data.stdout || '',
        data.stderr ? `\n[stderr]\n${data.stderr}` : '',
        `\n退出码: ${data.exit_code ?? 0}`,
      ].filter(Boolean).join('\n'))
    } catch (err) {
      setRunOutput((err as Error).message || '运行失败')
    } finally {
      setRunning(false)
    }
  }, [taskId, viewingFile])

  const downloadWithAuth = useCallback(async (url: string, fallbackName: string) => {
    const res = await fetch(url, { headers: getAcAuthHeaders() })
    if (!res.ok) throw new Error(await res.text().catch(() => '下载失败'))
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = fallbackName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  }, [])

  const downloadFile = useCallback((path: string) => {
    if (!taskId) return
    downloadWithAuth(
      `${AUTOCODE_API}/api/tasks/${taskId}/files/download?path=${encodeURIComponent(path)}`,
      path.split('/').pop() || 'download'
    ).catch(err => alert(err.message || '下载失败'))
  }, [downloadWithAuth, taskId])

  const downloadProject = useCallback(() => {
    if (!taskId) return
    downloadWithAuth(`${AUTOCODE_API}/api/tasks/${taskId}/files/download-project`, `${task.title || 'project'}.zip`)
      .catch(err => alert(err.message || '下载失败'))
  }, [downloadWithAuth, task.title, taskId])

  const canRun = /\.(py|js|mjs|cjs|sh|ps1)$/i.test(viewingFile?.path || '')
  const parentPath = currentPath === '/' ? '/' : (currentPath.split('/').slice(0, -1).join('/') || '/')

  if (!taskId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground">
        <FolderIcon className="w-10 h-10 text-muted-foreground/40" />
        <p>当前任务还没有连接到 AutoCode 工作空间</p>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex items-center gap-2 border-b px-3 py-2 shrink-0">
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={() => fetchFiles(currentPath)} disabled={filesLoading}>
          {filesLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          刷新
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-xs gap-1.5" onClick={downloadProject}>
          <FileArchive className="w-3.5 h-3.5" />
          下载项目
        </Button>
        <div className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground">
          /{currentPath.replace(/^\/+/, '')}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] lg:pb-3">
        {currentPath !== '/' && (
          <button
            className="mb-2 flex items-center gap-2 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
            onClick={() => fetchFiles(parentPath)}
          >
            <ChevronLeft className="w-3 h-3" />
            返回上级
          </button>
        )}
        {error && (
          <div className="mb-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        {filesLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            加载文件...
          </div>
        ) : fileTree.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">当前目录为空</div>
        ) : (
          <div className="divide-y rounded-lg border bg-card">
            {fileTree.map(f => {
              const itemPath = toDisplayText(f.path) || (currentPath === '/' ? f.name : `${currentPath.replace(/^\/+/, '')}/${f.name}`)
              return (
                <div key={`${f.type}-${itemPath}`} className="group flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/50">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => f.type === 'dir' ? fetchFiles(`/${itemPath}`) : openFile(itemPath)}
                  >
                    {f.type === 'dir' ? (
                      <FolderIcon className="w-4 h-4 shrink-0 text-yellow-500" />
                    ) : (
                      <FileIcon className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate font-medium">{f.name}</span>
                    {f.type === 'file' && (
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                        {f.size > 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${f.size} B`}
                      </span>
                    )}
                  </button>
                  {f.type === 'file' && (
                    <Button variant="ghost" size="icon" className="h-7 w-7 opacity-100 sm:opacity-0 sm:group-hover:opacity-100" onClick={() => downloadFile(itemPath)}>
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <Dialog open={viewerOpen} onOpenChange={setViewerOpen}>
        <DialogContent className="max-w-[96vw] sm:max-w-5xl h-[84vh] flex flex-col p-0 gap-0">
          <DialogHeader className="border-b px-4 py-3 shrink-0">
            <DialogDescription className="sr-only">
              查看、编辑、运行或下载当前任务工作区中的文件。
            </DialogDescription>
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="min-w-0 truncate font-mono text-sm">
                {viewingFile?.path || '加载中...'}
              </DialogTitle>
              <div className="flex shrink-0 items-center gap-1">
                {viewingFile && (
                  <>
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => navigator.clipboard?.writeText(viewingFile.content)}>
                      <Copy className="w-3 h-3" />
                      复制
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => editing ? saveFile() : (setEditing(true), setEditContent(viewingFile.content))} disabled={saving}>
                      {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : editing ? <Save className="w-3 h-3" /> : <Edit3 className="w-3 h-3" />}
                      {editing ? '保存' : '编辑'}
                    </Button>
                    {canRun && (
                      <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={runFile} disabled={running}>
                        {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <MonitorPlay className="w-3 h-3" />}
                        运行
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => downloadFile(viewingFile.path)}>
                      <Download className="w-3 h-3" />
                      下载
                    </Button>
                  </>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-auto">
            {fileLoading ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                加载文件...
              </div>
            ) : editing ? (
              <Textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="h-full min-h-full w-full resize-none rounded-none border-0 p-4 font-mono text-xs leading-relaxed focus-visible:ring-0"
              />
            ) : (
              <div>
                <div className="p-4 font-mono text-xs leading-relaxed text-foreground/90">
                  {(viewingFile?.content || '').split('\n').map((line, idx) => {
                    const lineNo = idx + 1
                    const active = requestedLine === lineNo
                    return (
                      <div
                        key={lineNo}
                        ref={el => { lineRefs.current[lineNo] = el }}
                        className={cn('grid grid-cols-[3.5rem_minmax(0,1fr)] rounded-sm', active && 'bg-primary/15 ring-1 ring-primary/30')}
                      >
                        <span className="select-none pr-3 text-right text-muted-foreground/60">{lineNo}</span>
                        <span className="whitespace-pre-wrap break-all">{line || ' '}</span>
                      </div>
                    )
                  })}
                </div>
                {runOutput && (
                  <div className="border-t bg-[#111827] text-green-300">
                    <div className="border-b border-white/10 px-4 py-2 text-[11px] text-green-100/80">运行输出</div>
                    <pre className="whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed">{runOutput}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
          {viewingFile && (
            <div className="flex items-center justify-between border-t bg-muted/30 px-4 py-2 text-[10px] text-muted-foreground shrink-0">
              <span className="truncate font-mono">{viewingFile.path}</span>
              <span className="shrink-0">{viewingFile.size > 1024 ? `${(viewingFile.size / 1024).toFixed(1)} KB` : `${viewingFile.size} B`}</span>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function WorkFilesPanel({ task, onOpenFile }: { task: AutoCodeTask; onOpenFile: (path: string) => void }) {
  const groups = [
    {
      title: '项目侦察',
      desc: '自动扫描项目类型、入口、命令和风险，计划阶段会优先引用。',
      files: [
        ['.autocode/PROJECT_PROFILE.md', '项目画像'],
        ['.autocode/PROJECT_MAP.md', '项目地图'],
        ['.autocode/COMMANDS.md', '命令清单'],
        ['.autocode/RISK_REPORT.md', '风险报告'],
      ],
    },
    {
      title: '规格文件',
      desc: '开发前的边界与契约，复杂项目会逐步补全。',
      files: [
        ['.autocode/PRD.md', '产品需求'],
        ['.autocode/ARCHITECTURE.md', '架构设计'],
        ['.autocode/API_SPEC.md', '接口契约'],
        ['.autocode/DB_SCHEMA.md', '数据库设计'],
        ['.autocode/UI_SPEC.md', 'UI 规范'],
        ['.autocode/ROLE_OWNERSHIP.md', '角色分工'],
      ],
    },
    {
      title: '执行记录',
      desc: '任务运行过程中的记忆、上下文、CI 和审查产物。',
      files: [
        ['.autocode/PLAN.md', '执行计划'],
        ['.autocode/MEMORY.md', '执行记忆'],
        ['.autocode/CONTEXT_SUMMARY.md', '上下文摘要'],
        ['.autocode/PIPELINE.md', '流水线'],
        ['.autocode/CI_REPORT.md', 'CI 报告'],
        ['.autocode/REVIEW.md', '审查汇总'],
        ['.autocode/CHAT.md', '对话记录'],
      ],
    },
  ] as const

  if (!task.backendTaskId) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
        当前任务还没有工作区，创建后会自动生成工作文件。
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] sm:p-4">
        <div className="rounded-lg border bg-card p-3">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">工作文件</h3>
            {task.complexity && <Badge variant="outline" className="ml-auto text-[10px]">{task.complexity}</Badge>}
          </div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            这些文件是 AutoCode 的工程约束和执行记忆。你可以随时打开修改，后续 Agent 会优先读取。
          </p>
        </div>

        {groups.map(group => (
          <section key={group.title} className="space-y-2">
            <div>
              <h4 className="text-xs font-semibold text-foreground">{group.title}</h4>
              <p className="text-[11px] text-muted-foreground">{group.desc}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.files.map(([path, label]) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => onOpenFile(path)}
                  className="flex min-w-0 items-center gap-2 rounded-lg border bg-card px-3 py-2 text-left text-xs transition-colors hover:border-primary/40 hover:bg-primary/5"
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{label}</span>
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">{path}</span>
                  </span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </ScrollArea>
  )
}

function ApprovalCountdownActions({
  event,
  resolution,
  approving,
  disabled,
  onApproval,
}: {
  event: AutoCodeRuntimeEvent
  resolution?: AutoCodeRuntimeEvent
  approving?: boolean
  disabled?: boolean
  onApproval: (event: AutoCodeRuntimeEvent, approved: boolean) => void
}) {
  const meta = useMemo(() => getApprovalMeta(event), [event])
  const approved = resolution ? Boolean(resolution.payload?.approved) : null
  const [remaining, setRemaining] = useState(meta.autoApproveAfter)

  useEffect(() => {
    if (resolution || disabled || meta.highRisk || !meta.autoApproveAfter) {
      setRemaining(meta.autoApproveAfter)
      return
    }
    const startedAt = event.created_at ? new Date(event.created_at).getTime() : Date.now()
    const update = () => {
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
      const next = Math.max(0, meta.autoApproveAfter - elapsed)
      setRemaining(next)
    }
    update()
    const timer = window.setInterval(update, 500)
    return () => window.clearInterval(timer)
  }, [disabled, event, meta.autoApproveAfter, meta.highRisk, resolution])

  if (resolution) {
    return (
      <Badge variant={approved ? 'default' : 'destructive'} className="text-[10px]">
        {approved ? (resolution.payload?.auto_approved ? '已自动批准' : '已批准') : '已拒绝'}
      </Badge>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {meta.highRisk ? (
        <Badge variant="destructive" className="h-8 rounded-md px-2 text-[10px]">
          高风险操作，必须手动确认
        </Badge>
      ) : meta.autoApproveAfter ? (
        <Badge variant="outline" className="h-8 rounded-md border-green-500/40 bg-green-500/5 px-2 text-[10px] text-green-700 dark:text-green-300">
          {remaining > 0 ? `${remaining}s 后自动批准` : '等待后端自动继续...'}
        </Badge>
      ) : null}
      <Button
        size="sm"
        onClick={() => onApproval(event, true)}
        disabled={approving || disabled}
      >
        {approving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />}
        批准执行
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => onApproval(event, false)}
        disabled={approving || disabled}
      >
        拒绝
      </Button>
    </div>
  )
}

function RuntimeEventsPanel({ task, toolRegistry }: { task: AutoCodeTask; toolRegistry: ToolDisplayMap }) {
  const [events, setEvents] = useState<AutoCodeRuntimeEvent[]>(Array.isArray(task.events) ? task.events : [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loadingOutputPath, setLoadingOutputPath] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [matchIndex, setMatchIndex] = useState(0)
  const eventRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const loadEvents = useCallback(async () => {
    if (!task.backendTaskId) return
    setLoading(true)
    setError('')
    try {
      const data = await getAutoCodeTaskEvents(task.backendTaskId)
      setEvents(Array.isArray(data.events) ? data.events : [])
    } catch (err) {
      setError((err as Error).message || '活动加载失败')
    } finally {
      setLoading(false)
    }
  }, [task.backendTaskId])

  useEffect(() => {
    const fallbackApproval = pendingConfirmationToEvent(task)
    setEvents(prev => mergeRuntimeEvents(prev, fallbackApproval ? [...(task.events || []), fallbackApproval] : task.events))
  }, [task.backendTaskId, task.currentStep, task.events, task.id, task.pendingConfirmation, task.status])

  useEffect(() => {
    loadEvents()
  }, [loadEvents])

  const getApprovalResolution = useCallback((event: AutoCodeRuntimeEvent) => {
    const approvalId = toDisplayText(event.payload?.approval_id, event.id)
    return events.find(item => {
      if (item.type !== 'approval_resolved') return false
      const payload = item.payload || {}
      return toDisplayText(payload.approval_id) === approvalId || toDisplayText(payload.event_id) === event.id
    })
  }, [events])

  const handleApproval = useCallback(async (event: AutoCodeRuntimeEvent, approved: boolean) => {
    if (!task.backendTaskId || !event.id) return
    setApprovingId(event.id)
    setError('')
    try {
      await resolveAutoCodeApproval(task.backendTaskId, event.id, approved)
      setEvents(prev => mergeRuntimeEvents(prev, [buildApprovalResolvedEvent(task, event, approved)]))
      void loadEvents()
    } catch (err) {
      setError((err as Error).message || '审批操作失败')
    } finally {
      setApprovingId(null)
    }
  }, [loadEvents, task.backendTaskId])

  const openOutputFile = useCallback(async (path: string) => {
    if (!task.backendTaskId || !path) return
    const normalized = path.replace(/^\/?workspace\//, '').replace(/^\/+/, '')
    setLoadingOutputPath(normalized)
    setError('')
    try {
      const data = await readAutoCodeWorkspaceFile(task.backendTaskId, normalized)
      const eventId = `output-${normalized}`
      setEvents(prev => mergeRuntimeEvents(prev, [{
        id: eventId,
        type: 'tool_result',
        task_id: task.backendTaskId || task.id,
        source: 'system',
        created_at: new Date().toISOString(),
        payload: {
          tool: 'read_file',
          args: { path: normalized },
          result: data.content,
          output_path: normalized,
          output_chars: data.content.length,
        },
      }]))
      setExpandedIds(prev => new Set(prev).add(eventId))
      window.requestAnimationFrame(() => {
        eventRefs.current[eventId]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
    } catch (err) {
      setError((err as Error).message || '读取完整输出失败')
    } finally {
      setLoadingOutputPath(null)
    }
  }, [task.backendTaskId, task.id])

  const activityItems = useMemo(() => {
    return [...events].reverse().map(event => {
      const payload = event.payload || {}
      const summary = summarizeRuntimeEvent(event, toolRegistry)
      const diagnostic = getEventDiagnostic(payload, summary.tone)
      const detail = JSON.stringify(payload, null, 2)
      const sourceLabel = EVENT_SOURCE_DISPLAY[toDisplayText(event.source)] || toDisplayText(event.source, '系统')
      const searchable = [
        event.type,
        EVENT_TYPE_DISPLAY[event.type],
        event.source,
        sourceLabel,
        summary.label,
        summary.title,
        summary.description,
        detail,
      ].filter(Boolean).join('\n').toLowerCase()
      return { event, payload, summary, detail, sourceLabel, searchable, diagnostic }
    })
  }, [events, toolRegistry])

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    if (!keyword) return activityItems
    return activityItems.filter(item => item.searchable.includes(keyword))
  }, [activityItems, query])

  const visible = filteredItems.slice(0, 160)

  useEffect(() => {
    setMatchIndex(0)
  }, [query])

  const toggleExpanded = useCallback((eventId: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(eventId)) next.delete(eventId)
      else next.add(eventId)
      return next
    })
  }, [])

  const jumpMatch = useCallback((direction: 1 | -1) => {
    if (!visible.length) return
    const nextIndex = (matchIndex + direction + visible.length) % visible.length
    setMatchIndex(nextIndex)
    const id = visible[nextIndex].event.id
    window.requestAnimationFrame(() => {
      eventRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    })
  }, [matchIndex, visible])

  return (
    <ScrollArea className="h-full">
      <div className="space-y-3 p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] sm:p-4">
        <div className="rounded-lg border bg-card p-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-semibold">Agent 活动</h3>
              <Badge variant="outline" className="text-[10px]">{events.length}</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              记录对话、工具调用、权限判断、CI、checkpoint 和审查过程。
            </p>
          </div>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索活动、工具、文件、命令、错误..."
                className="h-8 pl-8 text-xs"
              />
            </div>
            {query.trim() && (
              <div className="flex items-center gap-2">
                <Badge variant="outline" className="h-8 rounded-md px-2 text-[10px]">
                  {filteredItems.length} 条匹配
                </Badge>
                <Button variant="outline" size="sm" onClick={() => jumpMatch(-1)} disabled={!visible.length}>
                  上一条
                </Button>
                <Button variant="outline" size="sm" onClick={() => jumpMatch(1)} disabled={!visible.length}>
                  下一条
                </Button>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={loadEvents} disabled={loading || !task.backendTaskId}>
              {loading ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />}
              刷新
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </div>
        )}

        {visible.length === 0 ? (
          <div className="flex h-52 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
            {query.trim() ? '没有匹配的活动内容' : '暂无活动事件'}
          </div>
        ) : (
          <div className="space-y-2">
            {visible.map((item, index) => {
              const { event, payload, summary, detail, sourceLabel, diagnostic } = item
              const resolution = event.type === 'approval_requested' ? getApprovalResolution(event) : undefined
              const approved = resolution ? Boolean(resolution.payload?.approved) : null
              const approvalMeta = event.type === 'approval_requested' ? getApprovalMeta(event) : null
              const expanded = expandedIds.has(event.id)
              const selected = query.trim() && index === matchIndex
              return (
                <div
                  key={event.id}
                  ref={(node) => { eventRefs.current[event.id] = node }}
                  className={cn(
                    'rounded-lg border bg-card p-3 transition-colors',
                    selected && 'border-primary/60 bg-primary/5',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={summary.tone === 'destructive' ? 'destructive' : summary.tone === 'success' ? 'default' : 'secondary'}
                      className="text-[10px]"
                    >
                      {summary.label}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground">{sourceLabel}</span>
                    <span className="text-[11px] text-muted-foreground">{EVENT_TYPE_DISPLAY[event.type] || event.type}</span>
                    <span className="ml-auto text-[11px] text-muted-foreground">{event.created_at ? new Date(event.created_at).toLocaleString() : ''}</span>
                  </div>
                  <div className="mt-2 text-xs font-medium leading-relaxed">{summary.title}</div>
                  {summary.description && (
                    <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">{summary.description}</div>
                  )}
                  {event.snapshot_hash && (
                    <div className="mt-1 font-mono text-[11px] text-muted-foreground">snapshot: {event.snapshot_hash}</div>
                  )}
                  {(diagnostic.failed || diagnostic.truncated || diagnostic.outputPath) && (
                    <div className={cn(
                      'mt-3 rounded-md border p-3 text-xs',
                      diagnostic.failed
                        ? 'border-destructive/40 bg-destructive/5'
                        : 'border-blue-500/30 bg-blue-500/5'
                    )}>
                      <div className="flex flex-wrap items-center gap-2">
                        {diagnostic.failed ? (
                          <AlertCircle className="h-4 w-4 text-destructive" />
                        ) : (
                          <FileText className="h-4 w-4 text-blue-500" />
                        )}
                        <span className={cn('font-medium', diagnostic.failed ? 'text-destructive' : 'text-blue-700 dark:text-blue-300')}>
                          {diagnostic.failed ? '真实错误 / 失败输出' : '工具输出摘要'}
                        </span>
                        {diagnostic.exitCode && (
                          <Badge variant={diagnostic.exitCode === '0' ? 'outline' : 'destructive'} className="text-[10px]">
                            exit {diagnostic.exitCode}
                          </Badge>
                        )}
                        {diagnostic.outputChars && (
                          <Badge variant="outline" className="text-[10px]">{diagnostic.outputChars} chars</Badge>
                        )}
                        {diagnostic.outputLines && (
                          <Badge variant="outline" className="text-[10px]">{diagnostic.outputLines} lines</Badge>
                        )}
                      </div>
                      {diagnostic.errorText && (
                        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-destructive">
                          {diagnostic.errorText}
                        </pre>
                      )}
                      {!diagnostic.errorText && diagnostic.outputText && (
                        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-background/80 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                          {diagnostic.outputText}
                        </pre>
                      )}
                      {diagnostic.outputPath && (
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <code className="min-w-0 max-w-full truncate rounded bg-background/80 px-2 py-1 font-mono text-[11px]">
                            {diagnostic.outputPath}
                          </code>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            disabled={loadingOutputPath === diagnostic.outputPath}
                            onClick={() => void openOutputFile(diagnostic.outputPath)}
                          >
                            {loadingOutputPath === diagnostic.outputPath ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-1 h-3.5 w-3.5" />}
                            查看完整输出
                          </Button>
                          {diagnostic.outputSha && (
                            <span className="text-[11px] text-muted-foreground">sha256 {diagnostic.outputSha.slice(0, 12)}</span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {event.type === 'approval_requested' && (
                    <div className={cn(
                      'mt-3 rounded-md border p-3',
                      approvalMeta?.highRisk
                        ? 'border-destructive/40 bg-destructive/5'
                        : 'border-amber-500/30 bg-amber-500/5'
                    )}>
                      <div className="flex flex-wrap items-center gap-2">
                        <AlertTriangle className={cn('h-4 w-4', approvalMeta?.highRisk ? 'text-destructive' : 'text-amber-500')} />
                        <span className="text-xs font-medium">
                          {approvalMeta ? getApprovalModeLabel(approvalMeta, true) : '需要人工确认'}
                        </span>
                        {resolution && (
                          <Badge variant={approved ? 'default' : 'destructive'} className="text-[10px]">
                            {approved ? '已批准' : '已拒绝'}
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {toDisplayText(payload.reason || payload.message || payload.tool, '该操作可能影响工作区，需要确认后继续。')}
                      </p>
                      <div className="mt-3">
                        <ApprovalCountdownActions
                          event={event}
                          resolution={resolution}
                          approving={approvingId === event.id}
                          disabled={!task.backendTaskId}
                          onApproval={handleApproval}
                        />
                      </div>
                    </div>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => toggleExpanded(event.id)}>
                      <ChevronDown className={cn('mr-1 h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} />
                      {expanded ? '收起详情' : '展开详情'}
                    </Button>
                    {detail.length > 4000 && <span className="text-[11px] text-muted-foreground">详情较长，已截断展示</span>}
                  </div>
                  {expanded && (
                    <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] leading-relaxed text-muted-foreground">
                      {detail.length > 4000 ? `${detail.slice(0, 4000)}\n...` : detail}
                    </pre>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

// ── 简易图标组件 ──
// ──────────────────────────────────────────
// 终端面板
// ──────────────────────────────────────────

function TerminalPanel({ task }: { task: AutoCodeTask }) {
  const [commands, setCommands] = useState<AutoCodeCommandRecord[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [runningKind, setRunningKind] = useState<'test' | 'build' | null>(null)
  const [pipelineRunning, setPipelineRunning] = useState(false)
  const [pipelineGate, setPipelineGate] = useState<{
    status?: string
    previewStatus?: string
    previewError?: string
    stepCount?: number
    createdAt?: string
  } | null>(null)
  const [customCommand, setCustomCommand] = useState('')
  const [customRunning, setCustomRunning] = useState(false)
  const [mobileView, setMobileView] = useState<'commands' | 'output'>('commands')

  const loadCommands = useCallback(async () => {
    if (!task.backendTaskId) return
    setLoading(true)
    try {
      const data = await listAutoCodeCommands(task.backendTaskId)
      setCommands(Array.isArray(data.commands) ? data.commands.map(normalizeCommandRecord) : [])
      setSelectedId(prev => prev || data.commands?.[data.commands.length - 1]?.id || null)
    } catch {
      // Keep log fallback visible.
    } finally {
      setLoading(false)
    }
  }, [task.backendTaskId])

  useEffect(() => {
    loadCommands()
  }, [loadCommands])

  useEffect(() => {
    if (task.commandHistory) {
      setCommands(task.commandHistory.map(normalizeCommandRecord))
      setSelectedId(prev => prev || task.commandHistory?.[task.commandHistory.length - 1]?.id || null)
    }
  }, [task.commandHistory])

  useEffect(() => {
    const latest = task.pipelineRuns?.[task.pipelineRuns.length - 1]
    setPipelineGate(latest ? {
      status: toDisplayText(latest.status),
      previewStatus: toDisplayText(latest.preview_status, task.previewStatus),
      previewError: toDisplayText(latest.preview_error, task.previewError),
      stepCount: latest.steps?.length || 0,
      createdAt: toDisplayText(latest.created_at),
    } : (task.pipelineStatus || task.previewStatus ? {
      status: toDisplayText(task.pipelineStatus),
      previewStatus: toDisplayText(task.previewStatus),
      previewError: toDisplayText(task.previewError),
    } : null))
  }, [task.pipelineRuns, task.pipelineStatus, task.previewError, task.previewStatus])

  const runKind = useCallback(async (kind: 'test' | 'build') => {
    if (!task.backendTaskId) return
    setRunningKind(kind)
    try {
      const record = await runAutoCodeCommand(task.backendTaskId, { kind })
      const normalized = normalizeCommandRecord(record)
      setCommands(prev => [...prev.filter(c => c.id !== normalized.id), normalized])
      setSelectedId(normalized.id)
      setMobileView('output')
    } finally {
      setRunningKind(null)
      loadCommands()
    }
  }, [loadCommands, task.backendTaskId])

  const runCustom = useCallback(async () => {
    const command = customCommand.trim()
    if (!task.backendTaskId || !command) return
    setCustomRunning(true)
    try {
      const record = await runAutoCodeCommand(task.backendTaskId, { kind: 'custom', command })
      const normalized = normalizeCommandRecord(record)
      setCommands(prev => [...prev.filter(c => c.id !== normalized.id), normalized])
      setSelectedId(normalized.id)
      setMobileView('output')
      setCustomCommand('')
    } finally {
      setCustomRunning(false)
      loadCommands()
    }
  }, [customCommand, loadCommands, task.backendTaskId])

  const runPipeline = useCallback(async () => {
    if (!task.backendTaskId) return
    setPipelineRunning(true)
    try {
      const result = await runAutoCodePipeline(task.backendTaskId)
      setPipelineGate({
        status: toDisplayText(result.status),
        previewStatus: toDisplayText(result.preview_status),
        previewError: toDisplayText(result.preview_error),
        stepCount: result.steps?.length || 0,
        createdAt: new Date().toISOString(),
      })
      setMobileView('output')
    } finally {
      setPipelineRunning(false)
      loadCommands()
    }
  }, [loadCommands, task.backendTaskId])

  const selectedCommand = commands.find(c => c.id === selectedId) || commands[commands.length - 1]
  const logs = task.logs.length > 0 ? task.logs : [
    '[INFO] AutoCode Agent Terminal',
    '[INFO] 等待任务启动...',
  ]

  if (task.backendTaskId) {
    return (
      <div className="h-full min-h-0 flex flex-col bg-[#111827] text-slate-100 lg:grid lg:grid-cols-[340px_minmax(0,1fr)]">
        <div className="shrink-0 border-b border-white/10 p-2 lg:hidden">
          <div className="grid grid-cols-2 rounded-lg border border-white/10 bg-white/5 p-1">
            <button
              type="button"
              onClick={() => setMobileView('commands')}
              className={cn(
                'h-8 rounded-md text-xs transition-colors',
                mobileView === 'commands' ? 'bg-white/15 text-white' : 'text-slate-400'
              )}
            >
              命令
            </button>
            <button
              type="button"
              onClick={() => setMobileView('output')}
              className={cn(
                'h-8 rounded-md text-xs transition-colors',
                mobileView === 'output' ? 'bg-white/15 text-white' : 'text-slate-400'
              )}
            >
              输出
            </button>
          </div>
        </div>
        <div className={cn(
          'min-h-0 flex-1 flex-col border-b border-white/10 lg:flex lg:border-b-0 lg:border-r',
          mobileView === 'commands' ? 'flex' : 'hidden'
        )}>
          <div className="shrink-0 border-b border-white/10 p-3">
            <div className="mb-3 flex items-center gap-2">
              <Terminal className="w-4 h-4 text-green-300" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">命令任务</p>
                <p className="truncate text-[11px] text-slate-400">{task.workspaceId}</p>
              </div>
              <Button variant="outline" size="icon" className="h-7 w-7 bg-white/5 border-white/10 hover:bg-white/10" onClick={loadCommands} disabled={loading}>
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              </Button>
            </div>
            {pipelineGate && (
              <div className={cn(
                'mb-3 rounded-lg border px-3 py-2 text-xs',
                pipelineGate.status === 'passed'
                  ? 'border-green-400/30 bg-green-400/10 text-green-100'
                  : 'border-red-400/30 bg-red-400/10 text-red-100'
              )}>
                <div className="flex items-center gap-2">
                  {pipelineGate.status === 'passed' ? (
                    <CircleCheck className="h-3.5 w-3.5 shrink-0 text-green-300" />
                  ) : (
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-300" />
                  )}
                  <span className="font-medium">
                    流水线：{pipelineGate.status === 'passed' ? '通过' : '未通过'}
                  </span>
                  {pipelineGate.stepCount !== undefined && (
                    <span className="ml-auto text-[10px] opacity-80">{pipelineGate.stepCount} 步</span>
                  )}
                </div>
                <p className="mt-1 text-[10px] opacity-80">
                  预览：{pipelineGate.previewStatus === 'running' ? '已启动' : pipelineGate.previewStatus || '未启动'}
                  {pipelineGate.previewError ? ` · ${pipelineGate.previewError}` : ''}
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button size="sm" variant="outline" className="h-8 bg-white/5 border-white/10 text-xs hover:bg-white/10" onClick={() => runKind('test')} disabled={!!runningKind}>
                {runningKind === 'test' ? <Loader2 className="mr-1.5 w-3 h-3 animate-spin" /> : <MonitorPlay className="mr-1.5 w-3 h-3" />}
                运行测试
              </Button>
              <Button size="sm" variant="outline" className="h-8 bg-white/5 border-white/10 text-xs hover:bg-white/10" onClick={() => runKind('build')} disabled={!!runningKind}>
                {runningKind === 'build' ? <Loader2 className="mr-1.5 w-3 h-3 animate-spin" /> : <Hammer className="mr-1.5 w-3 h-3" />}
                运行构建
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 h-8 w-full bg-white/5 border-white/10 text-xs hover:bg-white/10"
              onClick={runPipeline}
              disabled={pipelineRunning || !!runningKind || customRunning}
            >
              {pipelineRunning ? <Loader2 className="mr-1.5 w-3 h-3 animate-spin" /> : <ListChecks className="mr-1.5 w-3 h-3" />}
              运行项目流水线
            </Button>
            <div className="mt-2 flex items-center gap-2">
              <Input
                value={customCommand}
                onChange={e => setCustomCommand(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    runCustom()
                  }
                }}
                placeholder="输入工作区命令，例如 npm test"
                className="h-8 border-white/10 bg-white/5 text-xs text-slate-100 placeholder:text-slate-500"
                disabled={customRunning || !!runningKind}
              />
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8 shrink-0 bg-white/5 border-white/10 hover:bg-white/10"
                onClick={runCustom}
                disabled={!customCommand.trim() || customRunning || !!runningKind}
                title="运行命令"
              >
                {customRunning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
              </Button>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
              命令只在当前任务工作区执行，后端会拦截越权路径和危险访问。
            </p>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-2 p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] lg:pb-3">
              {commands.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/5 px-3 py-8 text-center text-xs text-slate-400">
                  暂无命令记录，可从这里运行测试，也可以在 AI 助手里说“运行测试”。
                </div>
              ) : commands.slice().reverse().map(cmd => (
                <button
                  key={cmd.id}
                  type="button"
                  onClick={() => { setSelectedId(cmd.id); setMobileView('output') }}
                  className={cn(
                    'w-full rounded-lg border p-2 text-left text-xs transition-colors',
                    selectedCommand?.id === cmd.id ? 'border-green-400/50 bg-green-400/10' : 'border-white/10 bg-white/5 hover:bg-white/10'
                  )}
                >
                  <div className="flex items-center gap-2">
                    {cmd.status === 'running' ? (
                      <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-sky-300" />
                    ) : cmd.status === 'success' ? (
                      <CircleCheck className="w-3.5 h-3.5 shrink-0 text-green-300" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-300" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">{cmd.label || cmd.command}</span>
                    {cmd.exit_code !== null && cmd.exit_code !== undefined && (
                      <span className="font-mono text-[10px] text-slate-400">#{cmd.exit_code}</span>
                    )}
                  </div>
                  <p className="mt-1 truncate pl-5 font-mono text-[10px] text-slate-400">{cmd.command}</p>
                  {cmd.source && (
                    <p className="mt-1 pl-5 text-[10px] text-slate-500">
                      来源：{formatCommandSource(cmd.source)}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </ScrollArea>
        </div>

        <div className={cn(
          'min-h-0 flex-1 flex-col lg:flex',
          mobileView === 'output' ? 'flex' : 'hidden'
        )}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-medium">{selectedCommand?.command || '终端输出'}</p>
              <p className="text-[10px] text-slate-400">
                {selectedCommand ? `${selectedCommand.status} · ${selectedCommand.started_at || ''}` : '结构化命令输出'}
              </p>
            </div>
            {selectedCommand?.output && (
              <Button variant="outline" size="sm" className="h-7 bg-white/5 border-white/10 text-xs hover:bg-white/10" onClick={() => navigator.clipboard?.writeText(selectedCommand.output || '')}>
                <Copy className="mr-1 w-3 h-3" />
                复制
              </Button>
            )}
          </div>
          <ScrollArea className="flex-1 min-h-0">
            <pre className="min-h-full whitespace-pre-wrap break-all p-4 pb-[calc(var(--mobile-bottom-nav-space)+1rem)] font-mono text-xs leading-relaxed text-green-300 lg:pb-4">
              {selectedCommand?.output || logs.join('\n') || '暂无输出'}
            </pre>
          </ScrollArea>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full bg-[#1e1e1e] font-mono text-xs text-green-400 p-4 pb-[calc(var(--mobile-bottom-nav-space)+1rem)] overflow-auto lg:pb-4">
      {logs.map((log, i) => {
        const lines = log.split('\n')
        return (
          <div key={i} className="leading-relaxed whitespace-pre">
            {lines.map((line, j) => (
              <div key={j} className={j === 0 ? '' : 'pl-4 text-[10px] opacity-60'}>
                {line}
              </div>
            ))}
          </div>
        )
      })}
      {task.status === 'running' && (
        <div className="flex items-center gap-1 mt-1">
          <span className="text-green-400">▶</span>
          <span className="animate-pulse">_</span>
        </div>
      )}
    </div>
  )
}

// ──────────────────────────────────────────
// Git 面板
// ──────────────────────────────────────────

function GitPanel({
  task,
  focusTarget,
  onFocusHandled,
}: {
  task: AutoCodeTask
  focusTarget?: string | null
  onFocusHandled?: () => void
}) {
  const [status, setStatus] = useState<AutoCodeGitStatus | null>(null)
  const [commits, setCommits] = useState<AutoCodeGitCommit[]>([])
  const [diff, setDiff] = useState('')
  const [selected, setSelected] = useState<'working' | string>('working')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mobileView, setMobileView] = useState<'history' | 'diff'>('history')
  const workspaceId = task.workspaceId
  const selectedCommit = selected === 'working' ? null : commits.find(c => c.hash === selected)

  const loadGit = useCallback(async () => {
    if (!workspaceId) return
    setLoading(true)
    setError('')
    try {
      const [nextStatus, nextCommits, working] = await Promise.all([
        getAutoCodeGitStatus(workspaceId),
        getAutoCodeGitLog(workspaceId, 30),
        getAutoCodeWorkingDiff(workspaceId).catch(() => ({ diff: '' })),
      ])
      setStatus(normalizeGitStatus(nextStatus))
      setCommits(Array.isArray(nextCommits) ? nextCommits.map(normalizeGitCommit) : [])
      setDiff(toDisplayText(working.diff))
      setSelected('working')
    } catch (err) {
      setError((err as Error).message || 'Git 状态加载失败')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    loadGit()
  }, [loadGit])

  const loadCommitDiff = useCallback(async (hash: string) => {
    if (!workspaceId) return
    setLoading(true)
    setError('')
    try {
      const data = await getAutoCodeGitDiff(workspaceId, hash)
      setDiff(toDisplayText(data.diff))
      setSelected(hash)
      setMobileView('diff')
    } catch (err) {
      setError((err as Error).message || 'Diff 加载失败')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!focusTarget || !workspaceId || loading) return
    if (focusTarget === 'working') {
      setSelected('working')
      setMobileView('diff')
      onFocusHandled?.()
      return
    }
    const target = focusTarget === 'previous'
      ? commits[1]?.hash
      : commits.find(c => c.hash.startsWith(focusTarget))?.hash || focusTarget
    if (!target) return
    loadCommitDiff(target).finally(() => onFocusHandled?.())
  }, [commits, focusTarget, loadCommitDiff, loading, onFocusHandled, workspaceId])

  const checkoutCommit = useCallback(async (hash: string) => {
    if (!workspaceId) return
    if (!window.confirm(`确认回退/切换到提交 ${hash} 吗？当前未提交改动可能受到影响。`)) return
    setLoading(true)
    setError('')
    try {
      const rollbackUrl = task.backendTaskId
        ? `${AUTOCODE_API}/api/tasks/${task.backendTaskId}/rollback?commit_hash=${encodeURIComponent(hash)}`
        : `${AUTOCODE_API}/api/git/workspaces/${workspaceId}/checkout/${encodeURIComponent(hash)}`
      const res = await fetch(rollbackUrl, {
        method: 'POST',
        headers: getAcAuthHeaders(),
      })
      if (!res.ok) throw new Error(await res.text())
      await loadGit()
      setSelected(hash)
      setMobileView('diff')
    } catch (err) {
      setError((err as Error).message || '回退失败')
    } finally {
      setLoading(false)
    }
  }, [loadGit, task.backendTaskId, workspaceId])

  if (!workspaceId) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
        <GitBranch className="w-8 h-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">当前任务尚未创建 Git 工作区</p>
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-background lg:grid lg:grid-cols-[360px_minmax(0,1fr)]">
      <div className="shrink-0 border-b p-2 lg:hidden">
        <div className="grid grid-cols-2 rounded-lg border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => setMobileView('history')}
            className={cn(
              'h-8 rounded-md text-xs transition-colors',
              mobileView === 'history' ? 'bg-background shadow-sm' : 'text-muted-foreground'
            )}
          >
            历史
          </button>
          <button
            type="button"
            onClick={() => setMobileView('diff')}
            className={cn(
              'h-8 rounded-md text-xs transition-colors',
              mobileView === 'diff' ? 'bg-background shadow-sm' : 'text-muted-foreground'
            )}
          >
            Diff
          </button>
        </div>
      </div>
      <div className={cn(
        'min-h-0 flex-1 border-b flex-col lg:flex lg:border-b-0 lg:border-r',
        mobileView === 'history' ? 'flex' : 'hidden'
      )}>
        <div className="shrink-0 border-b p-3 space-y-3">
          <div className="flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">版本控制</p>
              <p className="truncate text-[11px] text-muted-foreground font-mono">{workspaceId}</p>
            </div>
            <Button variant="outline" size="icon" className="h-7 w-7" onClick={loadGit} disabled={loading}>
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </Button>
          </div>

          {status && (
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] text-muted-foreground">分支</p>
                <p className="truncate font-mono text-xs">{status.branch || '-'}</p>
              </div>
              <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
                <p className="text-[10px] text-muted-foreground">HEAD</p>
                <p className="truncate font-mono text-xs">{status.head || '-'}</p>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <ScrollArea className="flex-1 min-h-0">
          <div className="p-3 space-y-4 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] lg:pb-3">
            <section className="space-y-2">
              <button
                type="button"
                onClick={async () => {
                  if (!workspaceId) return
                  setLoading(true)
                  try {
                    const data = await getAutoCodeWorkingDiff(workspaceId)
                    setDiff(toDisplayText(data.diff))
                    setSelected('working')
                    setMobileView('diff')
                  } finally {
                    setLoading(false)
                  }
                }}
                className={cn(
                  'flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                  selected === 'working' ? 'border-primary/50 bg-primary/5' : 'bg-card hover:bg-muted/50'
                )}
              >
                <span className="font-medium">未提交变更</span>
                <Badge variant={status?.dirty ? 'default' : 'outline'} className="text-[10px]">
                  {status?.changes?.length || 0}
                </Badge>
              </button>

              {(status?.changes || []).length > 0 && (
                <div className="space-y-1">
                  {status!.changes.map(change => (
                    <div key={`${change.status}-${change.path}`} className="flex items-center gap-2 rounded px-2 py-1 text-[11px] hover:bg-muted/50">
                      <span className="w-7 shrink-0 rounded bg-muted px-1 py-0.5 text-center font-mono text-[10px] text-muted-foreground">
                        {change.status}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono">{change.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold text-muted-foreground">提交历史</h3>
                <span className="text-[10px] text-muted-foreground">{commits.length} 条</span>
              </div>
              {commits.length === 0 ? (
                <div className="rounded-lg border bg-muted/30 px-3 py-6 text-center text-xs text-muted-foreground">暂无提交记录</div>
              ) : (
                <div className="space-y-1.5">
                  {commits.map(commit => (
                    <div
                      key={commit.hash}
                      className={cn(
                        'rounded-lg border bg-card p-2 text-xs transition-colors',
                        selected === commit.hash ? 'border-primary/50 bg-primary/5' : 'hover:bg-muted/50'
                      )}
                    >
                      <button type="button" className="w-full text-left" onClick={() => loadCommitDiff(commit.hash)}>
                        <div className="flex items-center gap-2">
                          <GitCommitHorizontal className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-medium">{commit.message || commit.hash}</span>
                          {commit.metadata?.autocode_snapshot && (
                            <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[9px]">Auto</Badge>
                          )}
                        </div>
                        <div className="mt-1 flex items-center gap-2 pl-5 text-[10px] text-muted-foreground">
                          <span className="font-mono">{commit.hash}</span>
                          <span className="truncate">{commit.author}</span>
                        </div>
                        {commit.metadata?.autocode_snapshot && (
                          <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-[10px] text-muted-foreground">
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span>Agent: <span className="font-mono text-foreground/80">{commit.metadata.agent || '-'}</span></span>
                              <span>轮次: <span className="font-mono text-foreground/80">{commit.metadata.iteration ?? '-'}</span></span>
                              <span>文件: <span className="font-mono text-foreground/80">{commit.metadata.changed_files?.length || commit.files_changed?.length || 0}</span></span>
                            </div>
                            {commit.metadata.trigger_prompt && (
                              <p className="line-clamp-2 leading-relaxed">
                                触发对话：{commit.metadata.trigger_prompt}
                              </p>
                            )}
                          </div>
                        )}
                      </button>
                      <div className="mt-2 flex items-center justify-between pl-5">
                        <span className="text-[10px] text-muted-foreground">
                          {commit.files_changed?.length || 0} 文件
                        </span>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={() => checkoutCommit(commit.hash)}>
                          回退到此处
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </ScrollArea>
      </div>

      <div className={cn(
        'min-h-0 flex-1 flex-col lg:flex',
        mobileView === 'diff' ? 'flex' : 'hidden'
      )}>
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2 shrink-0">
          <div className="min-w-0">
            <p className="truncate text-xs font-medium">{selected === 'working' ? 'Working Tree Diff' : `Commit ${selected}`}</p>
            <p className="truncate text-[10px] text-muted-foreground">
              {selectedCommit?.metadata?.trigger_prompt
                ? `触发对话：${selectedCommit.metadata.trigger_prompt}`
                : '每次变更都应能被查看、审查和回退'}
            </p>
          </div>
          {diff && (
            <Button variant="outline" size="sm" className="h-7 text-xs gap-1" onClick={() => navigator.clipboard?.writeText(diff)}>
              <Copy className="w-3 h-3" />
              复制 Diff
            </Button>
          )}
        </div>
        <DiffViewer diff={diff} loading={loading} />
      </div>
    </div>
  )
}

function DiffViewer({ diff, loading }: { diff: string; loading?: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        加载 Diff...
      </div>
    )
  }
  if (!diff) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center text-sm text-muted-foreground">
        <FileSearch className="w-10 h-10 text-muted-foreground/40" />
        <p>暂无可显示的 Diff</p>
      </div>
    )
  }
  return (
    <ScrollArea className="flex-1 min-h-0 bg-[#0f172a]">
      <pre className="min-w-max p-4 pb-[calc(var(--mobile-bottom-nav-space)+1rem)] font-mono text-xs leading-relaxed lg:pb-4">
        {diff.split('\n').map((line, idx) => {
          const cls = line.startsWith('+') && !line.startsWith('+++')
            ? 'text-emerald-300 bg-emerald-500/10'
            : line.startsWith('-') && !line.startsWith('---')
              ? 'text-red-300 bg-red-500/10'
              : line.startsWith('@@')
                ? 'text-sky-300 bg-sky-500/10'
                : line.startsWith('diff --git')
                  ? 'text-violet-300'
                  : 'text-slate-300'
          return (
            <div key={idx} className={cn('min-h-[1.25rem] whitespace-pre px-2', cls)}>
              {line || ' '}
            </div>
          )
        })}
      </pre>
    </ScrollArea>
  )
}

// ─── 计划面板 ──────────────────────────────────────────

function PlanPanel({ task, onEnablePlanning }: { task: AutoCodeTask; onEnablePlanning?: () => void }) {
  const plan = task.plan

  if (!plan) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-sm text-muted-foreground gap-3">
        <ListOrdered className="w-10 h-10 text-muted-foreground/40" />
        <p>暂无任务计划</p>
        <p className="text-xs text-muted-foreground/60">可为已创建任务补充生成智能计划</p>
        {onEnablePlanning && (
          <Button size="sm" className="gap-2" onClick={onEnablePlanning}>
            <ListOrdered className="w-4 h-4" />
            开启计划
          </Button>
        )}
      </div>
    )
  }

  const subtaskMap = new Map((plan.subtasks ?? []).map(st => [st.id, st]))

  // 按执行组分组渲染
  const groups = (plan.execution_groups ?? []).length > 0
    ? (plan.execution_groups ?? []).map((groupIds, idx) => ({
        idx,
        parallel: groupIds.length > 1,
        subtasks: groupIds.map(id => subtaskMap.get(id)).filter(Boolean) as SubTask[],
      }))
    : [{ idx: 0, parallel: false, subtasks: (plan.subtasks ?? []) }]

  const statusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CircleCheck className="w-4 h-4 text-green-500" />
      case 'running': return <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
      case 'failed': return <AlertCircle className="w-4 h-4 text-red-500" />
      case 'skipped': return <SkipForward className="w-4 h-4 text-muted-foreground" />
      default: return <Clock className="w-4 h-4 text-muted-foreground" />
    }
  }

  const statusLabel = (status: string) => {
    switch (status) {
      case 'completed': return '已完成'
      case 'running': return '执行中'
      case 'failed': return '失败'
      case 'skipped': return '跳过'
      default: return '待执行'
    }
  }

  const statusClass = (status: string) => {
    switch (status) {
      case 'completed': return 'bg-green-500/10 text-green-600 border-green-500/20'
      case 'running': return 'bg-blue-500/10 text-blue-600 border-blue-500/20'
      case 'failed': return 'bg-red-500/10 text-red-600 border-red-500/20'
      case 'skipped': return 'bg-muted text-muted-foreground border-border'
      default: return 'bg-muted text-muted-foreground border-border'
    }
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-3 pb-[calc(var(--mobile-bottom-nav-space)+0.75rem)] sm:p-4 space-y-4 sm:space-y-5">
        {onEnablePlanning && (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" className="gap-2" onClick={onEnablePlanning}>
              <ListOrdered className="w-4 h-4" />
              重新规划
            </Button>
          </div>
        )}

        {/* 总体方案 */}
        {plan.overall_approach && (
          <div className="space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Layers className="w-4 h-4 text-primary" />
              总体方案
            </h3>
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {plan.overall_approach}
            </p>
          </div>
        )}

        {/* 执行组 */}
        <div className="space-y-3">
          <h3 className="text-sm font-semibold flex items-center gap-1.5">
            <ListChecks className="w-4 h-4 text-primary" />
            执行计划
            <span className="hidden sm:inline text-[10px] text-muted-foreground font-normal ml-auto">
              {(plan.subtasks ?? []).length} 个子任务 · {(plan.execution_groups ?? []).length} 个执行组
            </span>
          </h3>

          {groups.map((group, gIdx) => (
            <div key={gIdx} className="space-y-2">
              {/* 组标签 */}
              <div className="flex items-center gap-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  第 {gIdx + 1} 组{group.parallel ? '（并行）' : '（串行）'}
                </span>
                <div className="h-px flex-1 bg-border" />
              </div>

              <div className={`grid gap-2 ${group.parallel ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                {group.subtasks.map((st) => (
                  <div
                    key={st.id}
                    className={cn(
                      'border rounded-lg p-2.5 sm:p-3 space-y-2 transition-colors',
                      st.status === 'running' ? 'border-blue-500/30 bg-blue-500/5' : 'bg-card'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {statusIcon(st.status ?? 'pending')}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium truncate">{st.title}</span>
                          <span className={cn('text-[10px] px-1.5 py-0.5 rounded border shrink-0', statusClass(st.status ?? 'pending'))}>
                            {statusLabel(st.status ?? 'pending')}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed line-clamp-3 sm:line-clamp-2">
                          {st.description}
                        </p>
                      </div>
                    </div>

                    {/* 进度条 */}
                    {(st.status ?? 'pending') !== 'pending' && (st.status ?? 'pending') !== 'skipped' && (
                      <div className="w-full bg-muted rounded-full h-1.5">
                        <div
                          className={cn(
                            'h-1.5 rounded-full transition-all',
                            (st.status ?? 'pending') === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                          )}
                          style={{ width: `${st.progress ?? 0}%` }}
                        />
                      </div>
                    )}

                    {/* 依赖 / 文件 */}
                    <div className="flex flex-wrap gap-1">
                      {(st.dependencies ?? []).length > 0 && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          依赖: {(st.dependencies ?? []).join(', ')}
                        </span>
                      )}
                      {(st.estimated_files ?? []).length > 0 && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          预计文件: {(st.estimated_files ?? []).length} 个
                        </span>
                      )}
                      <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                        {st.agent_type ?? 'frontend'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ScrollArea>
  )
}

// ─── 原型面板 ──────────────────────────────────────────

function isUiPrototypeTask(projectType?: string) {
  const normalized = (projectType || '').toLowerCase()
  return ['website', 'nextjs', 'react', 'vue', 'nuxt', 'vite', 'svelte', 'astro', 'frontend', 'miniapp', 'uniapp', 'taro'].includes(normalized)
}

function getPrototypeId(item?: PrototypeRecord | AutoCodeTask['prototype'] | null) {
  return item?.id || item?.prototype_id || ''
}

function normalizePrototypeElements(elements?: Array<Record<string, unknown>> | ExcalidrawElement[]): PrototypeEditorElement[] {
  return (elements ?? []).map((el, i) => ({
    id: (el as ExcalidrawElement).id ?? `el-${i}`,
    type: (el as ExcalidrawElement).type ?? 'rectangle',
    x: (el as ExcalidrawElement).x ?? 0,
    y: (el as ExcalidrawElement).y ?? 0,
    width: (el as ExcalidrawElement).width ?? 100,
    height: (el as ExcalidrawElement).height ?? 50,
    ...el,
  })) as PrototypeEditorElement[]
}

function PrototypePanel({ task }: { task: AutoCodeTask }) {
  const [items, setItems] = useState<PrototypeRecord[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [selected, setSelected] = useState<PrototypeRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [generateDialogOpen, setGenerateDialogOpen] = useState(false)
  const [prototypeObjective, setPrototypeObjective] = useState('')

  const isUiTask = isUiPrototypeTask(task.projectType)
  const taskPrototypeId = getPrototypeId(task.prototype)

  const refreshList = useCallback(async (preferredId?: string) => {
    if (!task.workspaceId) return
    setLoading(true)
    setError('')
    try {
      const list = await listPrototypeRecords(task.workspaceId)
      const normalizedList = list.map(item => normalizePrototype(item)).filter(Boolean) as PrototypeRecord[]
      setItems(normalizedList)
      const nextId = preferredId || selectedId || taskPrototypeId || getPrototypeId(normalizedList[0])
      setSelectedId(nextId || '')
    } catch (e: unknown) {
      setError((e as Error)?.message || '加载原型失败')
    } finally {
      setLoading(false)
    }
  }, [selectedId, task.workspaceId, taskPrototypeId])

  useEffect(() => { refreshList() }, [refreshList])

  useEffect(() => {
    if (!task.workspaceId || !selectedId) {
      setSelected(null)
      return
    }
    let cancelled = false
    ;(async () => {
      setError('')
      try {
        const item = await getPrototypeRecord(task.workspaceId!, selectedId)
        if (!cancelled) setSelected(normalizePrototype(item) || null)
      } catch (e: unknown) {
        if (!cancelled) setError((e as Error)?.message || '加载原型详情失败')
      }
    })()
    return () => { cancelled = true }
  }, [task.workspaceId, selectedId])

  const openGenerateDialog = useCallback(() => {
    const recentUserMessages = [...(task.messages || [])]
      .filter(msg => msg.role === 'user')
      .slice(-3)
      .map(msg => `- ${msg.content}`)
      .join('\n')
    setPrototypeObjective([
      task.description || task.title || '生成 UI 原型',
      recentUserMessages ? `\n最近用户补充：\n${recentUserMessages}` : '',
      selected ? `\n参考当前选中原型：${selected.title || 'UI 原型'}\n${selected.description || ''}` : '',
    ].filter(Boolean).join('\n'))
    setGenerateDialogOpen(true)
  }, [selected, task.description, task.messages, task.title])

  const handleGenerate = useCallback(async () => {
    if (!task.workspaceId || !isUiTask) return
    const description = prototypeObjective.trim()
    if (!description) return
    setGenerating(true)
    setError('')
    try {
      const result = await generatePrototype(task.workspaceId, {
        title: task.title,
        description,
      })
      await refreshList(result.prototype_id)
      setGenerateDialogOpen(false)
    } catch (e: unknown) {
      setError((e as Error)?.message || '生成失败')
    } finally {
      setGenerating(false)
    }
  }, [isUiTask, prototypeObjective, refreshList, task.title, task.workspaceId])

  const handleSaveElements = useCallback(async (elements: PrototypeEditorElement[]) => {
    if (!task.workspaceId || !selected) return
    const id = getPrototypeId(selected)
    if (!id) return
    setSaving(true)
    setError('')
    try {
      const updated = await updatePrototypeRecord(task.workspaceId, id, {
        ...selected,
        kind: 'excalidraw',
        excalidraw: {
          ...(selected.excalidraw || { type: 'excalidraw', version: 2 }),
          elements: elements as unknown as Array<Record<string, unknown>>,
        },
      })
      const normalizedUpdated = normalizePrototype(updated)
      setSelected(normalizedUpdated || null)
      setItems(prev => prev.map(item => getPrototypeId(item) === id ? { ...item, ...(normalizedUpdated || updated) } : item))
      setIsEditing(false)
    } catch (e: unknown) {
      setError((e as Error)?.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }, [selected, task.workspaceId])

  const handleActivatePrototype = useCallback(async () => {
    if (!task.workspaceId || !selected) return
    const id = getPrototypeId(selected)
    if (!id) return
    setActivating(true)
    setError('')
    try {
      const updated = await activatePrototypeRecord(task.workspaceId, id)
      const normalizedUpdated = normalizePrototype(updated)
      setSelected(normalizedUpdated || null)
      setItems(prev => prev.map(item => ({ ...item, active: getPrototypeId(item) === id })))
      toast.success('已设为设计参考', { description: '后续 Agent 开发会从原型 manifest 中读取该参考。' })
    } catch (e: unknown) {
      setError((e as Error)?.message || '设置参考原型失败')
    } finally {
      setActivating(false)
    }
  }, [selected, task.workspaceId])

  if (!isUiTask) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div className="max-w-md space-y-3">
          <Wrench className="w-9 h-9 mx-auto text-muted-foreground/40" />
          <div className="text-sm font-medium">此任务不需要 UI 原型</div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            API、脚本、工具和纯后端任务会直接进入计划与开发流程，不再强制生成原型图或等待原型确认。
          </p>
        </div>
      </div>
    )
  }

  if (isEditing && selected?.kind !== 'html') {
    return (
      <PrototypeEditor
        initialElements={normalizePrototypeElements(selected?.excalidraw?.elements)}
        title={selected?.title}
        description={selected?.description}
        features={selected?.features ?? []}
        onSave={handleSaveElements}
        onCancel={() => setIsEditing(false)}
      />
    )
  }

  const selectedElements = normalizePrototypeElements(selected?.excalidraw?.elements)
  const selectedPreviewUrl = selected?.preview_url
    ? appendWorkspaceAccess(selected.preview_url.startsWith('/workspaces/') ? `${AUTOCODE_API}${selected.preview_url}` : selected.preview_url)
    : ''

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <div className="shrink-0 flex flex-col gap-2 border-b px-3 py-3 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold">工作区 UI 原型</div>
          <div className="text-xs text-muted-foreground">已保存 {items.length} 个原型，后续新增页面会继续加入这里</div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => refreshList()} disabled={loading || generating}>
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', loading && 'animate-spin')} />
            刷新
          </Button>
          <Button size="sm" onClick={openGenerateDialog} disabled={!task.workspaceId || generating}>
            {generating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
            生成原型
          </Button>
        </div>
      </div>

      <Dialog open={generateDialogOpen} onOpenChange={(open) => {
        if (!open && !generating) setGenerateDialogOpen(false)
      }}>
        <DialogContent className="max-w-[95vw] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5" />
              生成 UI 原型
            </DialogTitle>
            <DialogDescription>
              原型会按这里的最新目标生成，并保存到工作区原型库；最新原型会进入上下文，供后续开发参考。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>原型目标</Label>
              <Textarea
                value={prototypeObjective}
                onChange={e => setPrototypeObjective(e.target.value)}
                className="min-h-36 text-sm"
                placeholder="描述页面结构、品牌风格、核心组件、交互状态和需要重点参考的现有原型。"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setGenerateDialogOpen(false)} disabled={generating}>
                取消
              </Button>
              <Button onClick={handleGenerate} disabled={!prototypeObjective.trim() || generating}>
                {generating ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                生成原型
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {error && (
        <div className="mx-3 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden">
        <div className="md:w-72 shrink-0 border-b md:border-b-0 md:border-r bg-muted/20 min-h-0 flex flex-col">
          <div className="px-3 py-2 text-[11px] text-muted-foreground border-b shrink-0">原型列表</div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-1">
              {loading && items.length === 0 && (
                <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
                </div>
              )}
              {!loading && items.length === 0 && (
                <div className="px-3 py-8 text-center text-xs text-muted-foreground">暂无原型</div>
              )}
              {items.map((item, index) => {
                const id = getPrototypeId(item)
                const active = id === selectedId
                return (
                  <button
                    key={id || index}
                    type="button"
                    onClick={() => setSelectedId(id)}
                    className={cn(
                      'w-full text-left rounded-md border px-3 py-2 transition-colors',
                      active ? 'bg-background border-primary/50 shadow-sm' : 'bg-background/60 border-transparent hover:border-border hover:bg-background'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {item.kind === 'html' ? <MonitorPlay className="w-3.5 h-3.5 text-blue-500 shrink-0" /> : <Sparkles className="w-3.5 h-3.5 text-violet-500 shrink-0" />}
                      <span className="text-xs font-medium truncate">{item.title || `原型 ${index + 1}`}</span>
                      {item.active && <Badge variant="default" className="ml-auto text-[9px]">参考</Badge>}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                      <span>{item.kind === 'html' ? 'HTML' : '线框图'}</span>
                      {item.updated_at && <span className="truncate">{new Date(item.updated_at).toLocaleString()}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          </ScrollArea>
        </div>

        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {!selected ? (
            <div className="h-full flex items-center justify-center p-8 text-center">
              <div className="max-w-md space-y-3">
                <Sparkles className="w-8 h-8 mx-auto text-muted-foreground/40" />
                <div className="text-sm font-medium">选择或生成一个 UI 原型</div>
                <p className="text-xs text-muted-foreground leading-relaxed">原型会保存到当前工作区，刷新页面后仍可继续查看和编辑。</p>
              </div>
            </div>
          ) : (
            <>
              <div className="shrink-0 flex items-start justify-between gap-3 border-b px-3 py-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold truncate">{selected.title || 'UI 原型'}</div>
                  {selected.description && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{selected.description}</p>}
                </div>
                <div className="flex gap-2 shrink-0">
                  {selected.kind !== 'html' && (
                    <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} disabled={saving}>
                      <Edit3 className="w-3.5 h-3.5 mr-1.5" /> 编辑
                    </Button>
                  )}
                  <Button variant={selected.active ? 'default' : 'outline'} size="sm" onClick={handleActivatePrototype} disabled={activating}>
                    {activating ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                    {selected.active ? '当前参考' : '设为参考'}
                  </Button>
                  {selectedPreviewUrl && (
                    <Button variant="outline" size="sm" onClick={() => window.open(selectedPreviewUrl, '_blank')}>
                      <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> 打开
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex-1 min-h-0 bg-muted/20 p-3 overflow-hidden">
                <div className="h-full bg-card border rounded-lg overflow-hidden flex items-center justify-center">
                  {selected.kind === 'html' ? (
                    <iframe
                      srcDoc={selected.html || ''}
                      src={selected.html ? undefined : selectedPreviewUrl}
                      className="w-full h-full border-0"
                      title={selected.title || 'UI Prototype'}
                      sandbox="allow-scripts allow-same-origin"
                    />
                  ) : (
                    <ExcalidrawPreview elements={selectedElements} />
                  )}
                </div>
              </div>

              {(selected.features ?? []).length > 0 && (
                <div className="shrink-0 border-t px-3 py-2 flex flex-wrap gap-1.5">
                  {(selected.features ?? []).map((feature, index) => (
                    <Badge key={`${feature}-${index}`} variant="secondary" className="text-[10px]">{feature}</Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
interface PlanConfirmDialogProps {
  task: AutoCodeTask
  onConfirm: (confirmed: boolean, modifiedPlan?: TaskPlan) => void
}

function PlanConfirmDialog({ task, onConfirm }: PlanConfirmDialogProps) {
  const plan = task.plan
  const [editMode, setEditMode] = useState(false)
  const [editedPlan, setEditedPlan] = useState<TaskPlan | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!plan) return null

  const handleEdit = () => {
    setEditedPlan(JSON.parse(JSON.stringify(plan)))
    setEditMode(true)
  }

  const handleConfirm = async (confirmed: boolean) => {
    setSubmitting(true)
    try {
      // 确认时传 editedPlan（如果有修改），拒绝时不传
      await onConfirm(confirmed, confirmed ? (editedPlan ?? undefined) : undefined)
    } finally {
      setSubmitting(false)
    }
  }

  const subtaskMap = new Map((plan.subtasks ?? []).map(st => [st.id, st]))
  const groups = (plan.execution_groups ?? []).length > 0
    ? (plan.execution_groups ?? []).map((groupIds, idx) => ({
        idx,
        parallel: groupIds.length > 1,
        subtasks: groupIds.map(id => subtaskMap.get(id)).filter(Boolean) as SubTask[],
      }))
    : [{ idx: 0, parallel: false, subtasks: (plan.subtasks ?? []) }]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-xl shadow-2xl w-full max-w-[95vw] sm:max-w-3xl max-h-[85vh] flex flex-col mx-auto overflow-hidden border border-border/50">
        {/* 头部 */}
        <div className="px-5 py-4 border-b bg-gradient-to-r from-amber-500/10 to-orange-500/5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-500/10 flex items-center justify-center">
              <Layers className="w-5 h-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-semibold">确认任务计划</h2>
              <p className="text-xs text-muted-foreground">AI 已生成任务执行计划，请确认后继续</p>
            </div>
          </div>
        </div>

        {/* 内容 */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="space-y-5">
            {/* 总体方案 */}
            {plan.overall_approach && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Layers className="w-4 h-4 text-primary" />
                  总体方案
                </h3>
                {editMode && editedPlan ? (
                  <Textarea
                    className="text-xs min-h-[80px]"
                    value={editedPlan.overall_approach || ''}
                    onChange={(e) => setEditedPlan({ ...editedPlan, overall_approach: e.target.value })}
                  />
                ) : (
                  <div className="bg-muted/30 rounded-lg p-3">
                    <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
                      {plan.overall_approach}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* 技术栈 */}
            {plan.tech_stack && Object.keys(plan.tech_stack).length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <Code2 className="w-4 h-4 text-primary" />
                  技术栈
                </h3>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(plan.tech_stack).map(([key, value]) => (
                    <Badge key={key} variant="outline" className="text-xs">
                      {key}: <span className="text-primary ml-1">{value}</span>
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* 执行计划 */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-1.5">
                <ListChecks className="w-4 h-4 text-primary" />
                执行计划
                <span className="text-[10px] text-muted-foreground font-normal ml-auto">
                  {(plan.subtasks ?? []).length} 个子任务 · {(plan.execution_groups ?? []).length} 个执行组
                </span>
              </h3>

              {groups.map((group, gIdx) => (
                <div key={gIdx} className="space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="h-px flex-1 bg-border" />
                    <span className="text-[10px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                      第 {gIdx + 1} 组{group.parallel ? '（并行）' : '（串行）'}
                    </span>
                    <div className="h-px flex-1 bg-border" />
                  </div>

                  <div className={`grid gap-2 ${group.parallel ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                    {group.subtasks.map((st) => (
                      <div key={st.id} className="border rounded-lg p-3 space-y-2 bg-card">
                        <div className="flex items-start gap-2">
                          <Clock className="w-4 h-4 text-muted-foreground shrink-0 mt-0.5" />
                          <div className="flex-1 min-w-0">
                            {editMode && editedPlan ? (
                              <>
                                <Input
                                  className="text-xs h-7 mb-1"
                                  value={editedPlan.subtasks?.find(s => s.id === st.id)?.title || st.title}
                                  onChange={(e) => {
                                    const newSubtasks = (editedPlan.subtasks ?? []).map(s =>
                                      s.id === st.id ? { ...s, title: e.target.value } : s
                                    )
                                    setEditedPlan({ ...editedPlan, subtasks: newSubtasks })
                                  }}
                                />
                                <Textarea
                                  className="text-xs min-h-[50px]"
                                  value={editedPlan.subtasks?.find(s => s.id === st.id)?.description || st.description}
                                  onChange={(e) => {
                                    const newSubtasks = (editedPlan.subtasks ?? []).map(s =>
                                      s.id === st.id ? { ...s, description: e.target.value } : s
                                    )
                                    setEditedPlan({ ...editedPlan, subtasks: newSubtasks })
                                  }}
                                />
                              </>
                            ) : (
                              <>
                                <div className="text-xs font-medium">{st.title}</div>
                                <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed line-clamp-2">
                                  {st.description}
                                </p>
                              </>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {(st.dependencies ?? []).length > 0 && (
                            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                              依赖: {(st.dependencies ?? []).join(', ')}
                            </span>
                          )}
                          <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                            {st.agent_type ?? 'frontend'}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 底部操作 */}
        <div className="px-5 py-4 border-t bg-muted/20 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              {!editMode && (
                <Button variant="outline" size="sm" onClick={handleEdit}>
                  <Edit3 className="w-3.5 h-3.5 mr-1.5" />
                  修改计划
                </Button>
              )}
              {editMode && (
                <Button variant="ghost" size="sm" onClick={() => { setEditMode(false); setEditedPlan(null) }}>
                  取消修改
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" onClick={() => handleConfirm(false)} disabled={submitting}>
                <X className="w-3.5 h-3.5 mr-1.5" />
                拒绝
              </Button>
              <Button size="sm" onClick={() => handleConfirm(true)} disabled={submitting}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                确认执行
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── 原型确认面板 ──────────────────────────────────────────
interface PrototypeConfirmPanelProps {
  task: AutoCodeTask
  onConfirm: (confirmed: boolean, modifiedPrototype?: Record<string, unknown>) => void
}

/** 将 Excalidraw 元素渲染为 SVG 预览 */
function ExcalidrawPreview({ elements }: { elements: ExcalidrawElement[] }) {
  if (!elements || elements.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">原型中没有元素</p>
      </div>
    )
  }

  // 计算边界框
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const el of elements) {
    const x = el.x ?? 0
    const y = el.y ?? 0
    const w = el.width ?? (el.type === 'text' ? 200 : 0)
    const h = el.height ?? (el.type === 'text' ? (el.fontSize ?? 14) * 1.5 : 0)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + w)
    maxY = Math.max(maxY, y + h)
  }
  // 加 padding
  const pad = 40
  minX -= pad; minY -= pad
  maxX += pad; maxY += pad
  const svgWidth = Math.max(maxX - minX, 400)
  const svgHeight = Math.max(maxY - minY, 300)

  return (
    <svg
      viewBox={`${minX} ${minY} ${svgWidth} ${svgHeight}`}
      style={{ width: '100%', height: '100%', maxHeight: '100%' }}
      preserveAspectRatio="xMidYMid meet"
    >
      <rect x={minX} y={minY} width={svgWidth} height={svgHeight} fill="#f8fafc" />
      {elements.map((el, i) => {
        const x = el.x ?? 0
        const y = el.y ?? 0
        const w = el.width ?? 0
        const h = el.height ?? 0
        const fill = el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : 'none'
        const stroke = el.strokeColor ?? '#1e293b'
        const sw = el.strokeWidth ?? 1

        if (el.type === 'rectangle') {
          return (
            <rect key={i} x={x} y={y} width={w} height={h}
              fill={fill} stroke={stroke} strokeWidth={sw}
              strokeDasharray={el.strokeStyle === 'dashed' ? '8 4' : undefined}
              rx={el.roundness ? 8 : 0}
            />
          )
        }
        if (el.type === 'diamond') {
          const cx = x + w / 2, cy = y + h / 2
          return (
            <polygon key={i}
              points={`${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}`}
              fill={fill} stroke={stroke} strokeWidth={sw}
            />
          )
        }
        if (el.type === 'ellipse') {
          return (
            <ellipse key={i} cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2}
              fill={fill} stroke={stroke} strokeWidth={sw}
            />
          )
        }
        if (el.type === 'text' && el.text) {
          const lines = el.text.split('\n')
          const fs = el.fontSize ?? 14
          return (
            <text key={i} x={x} y={y + fs}
              fontSize={fs} fill={stroke}
              fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
            >
              {lines.map((line, li) => (
                <tspan key={li} x={x} dy={li === 0 ? 0 : fs * 1.3}>{line}</tspan>
              ))}
            </text>
          )
        }
        if (el.type === 'arrow' || el.type === 'line') {
          return (
            <g key={i}>
              <line x1={x} y1={y} x2={x + w} y2={y + h}
                stroke={stroke} strokeWidth={sw}
                strokeDasharray={el.strokeStyle === 'dashed' ? '8 4' : undefined}
              />
              {el.type === 'arrow' && (
                <polygon
                  points={`${x + w},${y + h} ${x + w - 10},${y + h - 5} ${x + w - 10},${y + h + 5}`}
                  fill={stroke}
                />
              )}
            </g>
          )
        }
        return null
      })}
    </svg>
  )
}

function PrototypeConfirmPanel({ task, onConfirm }: PrototypeConfirmPanelProps) {
  const [submitting, setSubmitting] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editedElements, setEditedElements] = useState<ExcalidrawElement[] | null>(null)

  const prototype = task.prototype
  const excalidrawData = prototype?.excalidraw
  const displayElements = editedElements ?? excalidrawData?.elements ?? []
  const features = prototype?.features ?? []

  // 确保传给编辑器的元素都有必要的字段
  const editorReadyElements = useMemo(() => {
    return (excalidrawData?.elements ?? []).map((el, i) => ({
      id: el.id ?? `el-${i}`,
      type: el.type ?? 'rectangle',
      x: el.x ?? 0,
      y: el.y ?? 0,
      width: el.width ?? 100,
      height: el.height ?? 50,
      ...el,
    }))
  }, [excalidrawData?.elements])

  const handleConfirm = async (confirmed: boolean) => {
    setSubmitting(true)
    try {
      let modifiedPrototype: Record<string, unknown> | undefined
      if (confirmed && editedElements && prototype) {
        modifiedPrototype = {
          ...prototype,
          excalidraw: {
            ...prototype.excalidraw,
            elements: editedElements,
          },
        } as Record<string, unknown>
      }
      await onConfirm(confirmed, modifiedPrototype)
    } finally {
      setSubmitting(false)
    }
  }

  // 编辑模式：全屏打开 PrototypeEditor
  if (isEditing) {
    return (
      <PrototypeEditor
        initialElements={editorReadyElements as any}
        title={prototype?.title}
        description={prototype?.description}
        features={features}
        onSave={(elements) => {
          setEditedElements(elements as ExcalidrawElement[])
          setIsEditing(false)
        }}
        onCancel={() => setIsEditing(false)}
      />
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-background rounded-xl shadow-2xl w-full max-w-[95vw] sm:max-w-5xl max-h-[90vh] flex flex-col mx-auto overflow-hidden border border-border/50">
        {/* 头部 */}
        <div className="px-5 py-4 border-b bg-gradient-to-r from-violet-500/10 to-purple-500/5 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-violet-500" />
            </div>
            <div className="flex-1">
              <h2 className="text-base font-semibold">
                {prototype?.title ? `确认 UI 原型：${prototype.title}` : '确认 UI 原型'}
              </h2>
              <p className="text-xs text-muted-foreground">
                {prototype?.description || 'AI 已生成 UI 原型设计，请确认后开始代码生成'}
              </p>
            </div>
            <div className="text-right shrink-0">
              <span className="text-lg font-bold text-violet-500">{displayElements.length}</span>
              <span className="text-xs text-muted-foreground ml-1">个元素</span>
              {editedElements && (
                <span className="text-[10px] text-violet-500 ml-2 px-1.5 py-0.5 bg-violet-500/10 rounded-full">已编辑</span>
              )}
            </div>
          </div>
        </div>

        {/* 原型预览 — SVG 渲染 */}
        <div className="flex-1 overflow-hidden p-4 bg-muted/20 min-h-[300px]">
          {prototype ? (
            <div className="h-full bg-card rounded-lg border overflow-hidden flex items-center justify-center">
              <ExcalidrawPreview elements={displayElements} />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground/40" />
              <span className="ml-2 text-sm text-muted-foreground">加载原型中...</span>
            </div>
          )}
        </div>

        {/* 特性列表 */}
        {features.length > 0 && (
          <div className="px-5 py-3 border-t bg-muted/10 shrink-0">
            <div className="flex flex-wrap gap-1.5">
              {features.map((f, i) => (
                <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 border border-violet-500/20">
                  {f}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* 底部操作 */}
        <div className="px-5 py-4 border-t bg-muted/20 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                <Edit3 className="w-3.5 h-3.5 mr-1.5" />
                编辑原型
              </Button>
            </div>
            <div className="flex gap-2">
              <Button variant="destructive" size="sm" onClick={() => handleConfirm(false)} disabled={submitting}>
                <X className="w-3.5 h-3.5 mr-1.5" />
                重新生成
              </Button>
              <Button size="sm" onClick={() => handleConfirm(true)} disabled={submitting || !prototype}>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                确认并生成代码
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// 空状态
// ──────────────────────────────────────────

// ── 代码审查面板 ──────────────────────────
function ReviewPanel({ task }: { task: AutoCodeTask }) {
  const review = task.review
  const phaseReviews = task.phase_reviews ?? []
  const hasAnyReview = !!review || phaseReviews.length > 0
  const agenticGuardrailCount = phaseReviews.filter(r => r.guardrail_kind === 'agentic').length
  const reviewGroupLabel = agenticGuardrailCount > 0 && agenticGuardrailCount === phaseReviews.length
    ? 'Agentic 护栏审查'
    : agenticGuardrailCount > 0
      ? '审查与护栏'
      : '分阶段审查'

  // 任务尚未完成任何审查
  if (task.status === 'reviewing' && !hasAnyReview) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <div className="w-14 h-14 rounded-2xl bg-purple-500/10 flex items-center justify-center animate-pulse">
          <Shield className="w-7 h-7 text-purple-500" />
        </div>
        <div>
          <p className="font-medium text-sm">代码审查中...</p>
          <p className="text-xs text-muted-foreground mt-1">正在检查代码规范、安全和性能</p>
        </div>
      </div>
    )
  }

  if (!hasAnyReview) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-8">
        <Shield className="w-10 h-10 text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">每完成一个执行组后会显示代码审查报告</p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 pb-[calc(var(--mobile-bottom-nav-space)+1rem)] space-y-4 lg:pb-4">
        {task.status === 'reviewing' && (
          <div className="rounded-lg border border-purple-500/20 bg-purple-500/10 px-3 py-2 text-xs text-purple-700 dark:text-purple-300 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            正在进行当前阶段代码审查，已完成的阶段报告会保留在下方。
          </div>
        )}

        {phaseReviews.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ListChecks className="w-4 h-4 text-primary" />
              {reviewGroupLabel}
              <span className="text-xs text-muted-foreground font-normal">{phaseReviews.length} 组</span>
            </div>
            {phaseReviews.map((phaseReview, index) => (
              <ReviewResultCard
                key={`${phaseReview.phase || 'phase'}-${phaseReview.reviewed_at || index}`}
                review={phaseReview}
                title={phaseReview.guardrail_kind === 'agentic'
                  ? `${phaseReview.phase || `第 ${index + 1} 组`} · 护栏`
                  : phaseReview.phase || `第 ${index + 1} 组`}
                compact={index < phaseReviews.length - 1}
              />
            ))}
          </div>
        )}

        {review && (
          <div className="space-y-3">
            {phaseReviews.length > 0 && (
              <div className="flex items-center gap-2 text-sm font-semibold pt-2">
                <Shield className="w-4 h-4 text-primary" />
                最终审查
              </div>
            )}
            <ReviewResultCard review={review} title="最终代码审查" />
          </div>
        )}
      </div>
    </ScrollArea>
  )
}

function ReviewResultCard({ review, title, compact = false }: { review: ReviewResult; title: string; compact?: boolean }) {
  const errors = (review.issues ?? []).filter(i => i.level === 'error')
  const warns = (review.issues ?? []).filter(i => i.level === 'warn')
  const infos = (review.issues ?? []).filter(i => i.level === 'info')

  const score = review.score ?? 0
  const scoreColor = score >= 80 ? 'text-green-600' : score >= 60 ? 'text-yellow-600' : 'text-red-600'
  const scoreBg = score >= 80 ? 'bg-green-500/10' : score >= 60 ? 'bg-yellow-500/10' : 'bg-red-500/10'
  const phaseArtifacts = (review.dimensions?.phase_artifacts ?? {}) as {
    changed_count?: number
    changed_files?: string[]
  }
  const ci = (review.dimensions?.ci ?? {}) as {
    status?: string
    command?: string
    exit_code?: number | null
    failure?: {
      category?: string
      severity?: string
      summary?: string
      suggestion?: string
    }
  }
  const changedFiles = Array.isArray(phaseArtifacts.changed_files) ? phaseArtifacts.changed_files : []
  const artifactLabel = review.guardrail_kind === 'agentic' ? '护栏对象' : '阶段产物'

  return (
    <div className="rounded-xl border bg-card overflow-hidden">
      <div className={cn('p-4 flex items-center gap-4', scoreBg)}>
        <div className={cn('text-3xl font-bold tabular-nums', scoreColor)}>{score}</div>
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{title}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{review.summary || '审查完成'}</div>
          {review.reviewed_at && (
            <div className="text-[10px] text-muted-foreground mt-1">{new Date(review.reviewed_at).toLocaleString()}</div>
          )}
        </div>
        <div className="ml-auto shrink-0">
          {review.passed
            ? <div className="flex items-center gap-1.5 text-green-600 font-medium text-sm"><CheckCircle2 className="w-4 h-4" /> 通过</div>
            : <div className="flex items-center gap-1.5 text-yellow-600 font-medium text-sm"><AlertTriangle className="w-4 h-4" /> 有问题</div>
          }
        </div>
      </div>

      {review.subtasks && review.subtasks.length > 0 && (
        <div className="px-4 py-2 border-t flex flex-wrap gap-1.5">
          {review.subtasks.map(st => (
            <Badge key={st.id} variant="secondary" className="text-[10px]">
              {st.title}
            </Badge>
          ))}
        </div>
      )}

      {typeof phaseArtifacts.changed_count === 'number' && (
        <div className="px-4 py-2 border-t bg-muted/30">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{artifactLabel}</span>
            <Badge variant={phaseArtifacts.changed_count > 0 ? 'secondary' : 'destructive'} className="text-[10px]">
              {phaseArtifacts.changed_count} 个变更文件
            </Badge>
            {changedFiles.slice(0, 12).map(file => (
              <code key={file} className="max-w-[220px] truncate rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {file}
              </code>
            ))}
            {changedFiles.length > 12 && (
              <span className="text-[10px] text-muted-foreground">+{changedFiles.length - 12}</span>
            )}
          </div>
        </div>
      )}

      {ci.status && (
        <div className="px-4 py-2 border-t bg-muted/20">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">CI / 验证</span>
            <Badge variant={ci.status === 'passed' ? 'secondary' : ci.status === 'failed' ? 'destructive' : 'outline'} className="text-[10px]">
              {ci.status}
            </Badge>
            {ci.failure?.category && (
              <Badge variant="outline" className="text-[10px]">
                {ci.failure.category}
              </Badge>
            )}
            {ci.command && (
              <code className="max-w-full truncate rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {ci.command}
              </code>
            )}
            {ci.exit_code !== undefined && ci.exit_code !== null && (
              <span className="text-[10px] text-muted-foreground">exit {ci.exit_code}</span>
            )}
          </div>
          {(ci.failure?.summary || ci.failure?.suggestion) && (
            <div className="mt-2 rounded-md border bg-background/70 px-3 py-2 text-[11px] text-muted-foreground">
              {ci.failure.summary && <div>{ci.failure.summary}</div>}
              {ci.failure.suggestion && <div className="mt-1">建议：{ci.failure.suggestion}</div>}
            </div>
          )}
        </div>
      )}

      <div className={cn('p-4 space-y-4', compact && 'pb-3')}>

        {/* 错误 */}
        {errors.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive mb-2">
              <AlertCircle className="w-3.5 h-3.5" /> 错误 ({errors.length})
            </div>
            <div className="space-y-1.5">
              {errors.map((issue, i) => (
                <div key={i} className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-destructive mb-0.5">
                    <code className="text-[10px] bg-destructive/10 px-1 rounded">{issue.rule}</code>
                    <span className="text-muted-foreground">{issue.file}</span>
                  </div>
                  <div className="text-foreground/80">{issue.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 警告 */}
        {warns.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-yellow-600 mb-2">
              <AlertTriangle className="w-3.5 h-3.5" /> 警告 ({warns.length})
            </div>
            <div className="space-y-1.5">
              {warns.map((issue, i) => (
                <div key={i} className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-yellow-700 mb-0.5">
                    <code className="text-[10px] bg-yellow-500/10 px-1 rounded">{issue.rule}</code>
                    <span className="text-muted-foreground">{issue.file}</span>
                  </div>
                  <div className="text-foreground/80">{issue.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 提示 */}
        {infos.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 mb-2">
              <AlertCircle className="w-3.5 h-3.5" /> 提示 ({infos.length})
            </div>
            <div className="space-y-1.5">
              {infos.map((issue, i) => (
                <div key={i} className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs">
                  <div className="flex items-center gap-1.5 font-medium text-blue-700 mb-0.5">
                    <code className="text-[10px] bg-blue-500/10 px-1 rounded">{issue.rule}</code>
                    <span className="text-muted-foreground">{issue.file}</span>
                  </div>
                  <div className="text-foreground/80">{issue.message}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI 评审 */}
        {(review.dimensions?.ai_review as Record<string, unknown>)?.status === 'done' && (() => {
          const ai = (review.dimensions?.ai_review ?? {}) as {
            score: number; verdict: string;
            strengths: string[]; suggestions: string[];
          }
          return (
            <div className="rounded-xl border p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Cpu className="w-4 h-4 text-purple-500" />
                AI 综合评审
                <span className="ml-auto text-xs text-muted-foreground">{ai.score}/100</span>
              </div>
              {ai.strengths?.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">代码优点</div>
                  <ul className="space-y-0.5">
                    {ai.strengths.map((s: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-green-700">
                        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {ai.suggestions?.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">改进建议</div>
                  <ul className="space-y-0.5">
                    {ai.suggestions.map((s: string, i: number) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs text-blue-700">
                        <ArrowRight className="w-3 h-3 mt-0.5 shrink-0" />{s}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )
        })()}

        {/* 无问题提示 */}
        {(review.issues ?? []).length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 gap-3 text-center">
            <div className="w-12 h-12 rounded-2xl bg-green-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-6 h-6 text-green-500" />
            </div>
            <p className="text-sm font-medium text-green-700">代码质量良好，无问题</p>
          </div>
        )}
      </div>
    </div>
  )
}

function EmptyState({
  onNewTask,
  queueStatus,
  queueStatusError,
}: {
  onNewTask: () => void
  queueStatus?: AutoCodeQueueStatus | null
  queueStatusError?: string
}) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-lg">
        <Code2 className="w-9 h-9 text-primary-foreground" />
      </div>
      <div>
        <h2 className="text-2xl font-bold mb-2">AI 代码开发助手</h2>
        <p className="text-muted-foreground text-sm max-w-md">
          描述你想要开发的项目，AI Agent 会自动完成整个开发流程。
          支持网站、API、小程序和工具脚本。
        </p>
      </div>
      <Button size="lg" className="gap-2" onClick={onNewTask}>
        <Sparkles className="w-5 h-5" />
        新建开发任务
      </Button>
      <div className="w-full max-w-md">
        <QueueStatusStrip status={queueStatus ?? null} error={queueStatusError} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-2xl w-full">
        {[
          { icon: Globe, label: '网站开发', color: 'text-blue-500', bg: 'bg-blue-500/10' },
          { icon: Server, label: 'API 服务', color: 'text-green-500', bg: 'bg-green-500/10' },
          { icon: Smartphone, label: '小程序', color: 'text-purple-500', bg: 'bg-purple-500/10' },
          { icon: Wrench, label: '工具脚本', color: 'text-orange-500', bg: 'bg-orange-500/10' },
        ].map(({ icon: Icon, label, color, bg }) => (
          <div key={label} className={cn('flex flex-col items-center gap-2 p-4 rounded-xl', bg)}>
            <Icon className={cn('w-6 h-6', color)} />
            <span className="text-xs font-medium">{label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}






