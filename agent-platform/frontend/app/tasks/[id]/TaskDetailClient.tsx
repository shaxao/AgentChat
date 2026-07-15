'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { tasksApi } from '@/lib/api'
import type { Task, AgentLogEntry, GitCommit } from '@/types'
import { formatDate, cn } from '@/lib/utils'
import {
  ArrowLeft, Loader2, CheckCircle2, XCircle, Clock, AlertTriangle,
  Terminal, GitBranch, ChevronDown, ChevronRight, Code2, Zap, Rocket, Brain, Palette,
  RefreshCw, RotateCcw, Trash2, Play, Eye, EyeOff, FileText,
  ShieldCheck, ShieldAlert, AlertCircle
} from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Progress } from '@/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GitVisualizer } from '@/components/git-visualizer'
import { PreviewFrame } from '@/components/preview-frame'
import { DeployPanel } from '@/components/deploy-panel'
import { PrototypePreview } from '@/components/prototype-preview'

// ─── xterm.js 终端组件（动态导入，禁用 SSR）─────────────────────────
import dynamic from 'next/dynamic'

const TerminalPanel = dynamic(() => import('./terminal-panel'), { ssr: false })

type WorkspaceMemory = {
  task_id: string
  workspace_id: string
  plan: string | null
  memory: string | null
  chat: string | null
  session_summary: string | null
}

// ─── Git History Timeline (保留简洁版本) ─────────────────────────────
function GitTimeline({ commits }: { commits: GitCommit[] }) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (!commits.length) {
    return <p className="text-sm text-muted-foreground py-8 text-center">暂无 Git 记录</p>
  }

  return (
    <div className="space-y-1 py-2 git-timeline-line">
      {commits.map(commit => (
        <div key={commit.hash} className="relative pl-8">
          <div className={cn(
            'absolute left-3 top-3 w-2.5 h-2.5 rounded-full border-2 bg-background z-10',
            expanded === commit.hash ? 'border-green-500 bg-green-500' : 'border-muted-foreground'
          )} />
          <button
            onClick={() => setExpanded(expanded === commit.hash ? null : commit.hash)}
            className={cn(
              'w-full text-left p-2 rounded-lg hover:bg-secondary/50 transition',
              expanded === commit.hash && 'bg-secondary/50'
            )}
          >
            <div className="flex items-center justify-between gap-2">
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{commit.hash}</code>
              <span className="text-xs text-muted-foreground">{formatDate(commit.date)}</span>
              {expanded === commit.hash ? (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
              )}
            </div>
            <p className="text-sm mt-1">{commit.message}</p>
            <div className="flex items-center gap-2 mt-1">
              <span className="text-xs text-muted-foreground">{commit.author}</span>
              <span className="text-xs text-muted-foreground">{commit.files_changed.length} 文件</span>
            </div>
          </button>
          {expanded === commit.hash && (
            <div className="mt-2 border-l-2 border-border ml-4 pl-3 space-y-0.5">
              {commit.files_changed.map(f => (
                <div key={f} className="text-xs text-muted-foreground flex items-center gap-1">
                  <Code2 className="w-3 h-3" />
                  {f}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Log Stream ─────────────────────────────────────────────────────
function LogStream({ logs }: { logs: AgentLogEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs.length])

  const levelColor = { info: 'text-blue-600', warn: 'text-amber-600', error: 'text-red-600', success: 'text-green-600' }

  return (
    <ScrollArea ref={scrollRef} className="h-full">
      <div className="space-y-0.5 p-3 font-mono text-xs">
        {logs.length === 0 && <p className="text-muted-foreground italic">等待 Agent 输出...</p>}
        {logs.map((log, i) => (
          <div key={i} className={cn('flex gap-2', levelColor[log.level as keyof typeof levelColor] || 'text-foreground')}>
            <span className="text-muted-foreground shrink-0 opacity-60">{formatDate(log.timestamp).split(' ').pop()}</span>
            <span className="shrink-0 opacity-80">[{log.agent}]</span>
            <span>{log.message}</span>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}

// ─── 主页面 ─────────────────────────────────────────────────────────
function WorkspaceMemoryPanel({ memory }: { memory: WorkspaceMemory | null }) {
  const files = [
    { key: 'chat', title: 'CHAT.md', description: '对话介入记录', content: memory?.chat },
    { key: 'memory', title: 'MEMORY.md', description: '项目长期记忆', content: memory?.memory },
    { key: 'plan', title: 'PLAN.md', description: '阶段计划与边界', content: memory?.plan },
    { key: 'session_summary', title: 'SESSION_SUMMARY.md', description: '会话摘要', content: memory?.session_summary },
  ]
  const [active, setActive] = useState(files[0].key)
  const current = files.find(file => file.key === active) || files[0]

  return (
    <div className="border rounded-xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b bg-secondary/40 p-2">
        {files.map(file => (
          <button
            key={file.key}
            type="button"
            onClick={() => setActive(file.key)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs transition',
              active === file.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {file.title}
          </button>
        ))}
      </div>
      <div className="border-b px-4 py-2">
        <div className="text-sm font-medium">{current.title}</div>
        <div className="text-xs text-muted-foreground">{current.description}</div>
      </div>
      <ScrollArea className="h-[420px]">
        <pre className="whitespace-pre-wrap break-words p-4 text-xs leading-relaxed text-muted-foreground">
          {current.content?.trim() || '暂无内容'}
        </pre>
      </ScrollArea>
    </div>
  )
}

function PhaseReviewPanel({ reviews }: { reviews?: Record<string, any>[] }) {
  if (!reviews?.length) return null

  return (
    <div className="border rounded-xl p-4 bg-slate-50/60 dark:bg-slate-950/20">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <ShieldCheck className="w-4 h-4 text-slate-600" />
        阶段代码审查
        <span className="text-xs text-muted-foreground font-mono">{reviews.length}</span>
      </h3>
      <div className="space-y-3">
        {reviews.map((review, index) => {
          const artifacts = review?.dimensions?.phase_artifacts || {}
          const changedFiles: string[] = Array.isArray(artifacts.changed_files) ? artifacts.changed_files : []
          const issues: any[] = Array.isArray(review?.issues) ? review.issues : []
          return (
            <div key={`${review.phase || index}`} className="rounded-lg border bg-background p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold truncate">{review.phase || `阶段 ${index + 1}`}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    变更 {artifacts.changed_count ?? changedFiles.length ?? 0} 个文件，问题 {issues.length} 个
                  </div>
                </div>
                <span className={cn('text-[10px] px-2 py-0.5 rounded-full font-mono shrink-0', review.passed ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700')}>
                  {review.passed ? '通过' : '未通过'} {review.score ?? '?'}分
                </span>
              </div>
              {review.summary && <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{review.summary}</p>}
              {changedFiles.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {changedFiles.slice(0, 12).map(file => (
                    <code key={file} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px]">{file}</code>
                  ))}
                  {changedFiles.length > 12 && <span className="text-[10px] text-muted-foreground">+{changedFiles.length - 12}</span>}
                </div>
              )}
              {issues.length > 0 && (
                <div className="mt-2 space-y-1">
                  {issues.slice(0, 3).map((issue, i) => (
                    <div key={i} className="rounded border border-orange-200 bg-orange-50 px-2 py-1 text-[11px] text-orange-800">
                      <span className="font-medium">{issue.rule || issue.severity || issue.level || 'issue'}</span>
                      <span className="mx-1">·</span>
                      <span>{issue.message || issue.title || '需要检查'}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function TaskDetailClient({ params }: { params: Promise<{ id: string }> }) {
  // 静态导出下用 window.location 取真实 ID
  const [id, setId] = useState<string>('')

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const realId = window.location.pathname.replace(/^\/autocode\/tasks\//, '').replace(/^\/tasks\//, '').replace(/\/$/, '')
      setId(realId || 'index')
    }
  }, [])

  const [task, setTask] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [confirmDialog, setConfirmDialog] = useState<{ path: string; reason: string } | null>(null)
  const [tab, setTab] = useState('logs')
  const [reviewConfirming, setReviewConfirming] = useState(false)
  const [prototypeConfirming, setPrototypeConfirming] = useState(false)
  const [specDraft, setSpecDraft] = useState('')
  const [specSaving, setSpecSaving] = useState(false)
  const [workspaceMemory, setWorkspaceMemory] = useState<WorkspaceMemory | null>(null)
  const logCountRef = useRef(0)

  const loadWorkspaceMemory = useCallback(async () => {
    if (!id) return
    try {
      const memory = await tasksApi.getMemory(id)
      setWorkspaceMemory(memory)
    } catch (memoryError) {
      console.warn('Failed to load workspace memory', memoryError)
    }
  }, [id])

  const loadTask = useCallback(async () => {
    if (!id) return
    try {
      const data = await tasksApi.get(id)
      setTask(data)
      setSpecDraft(data.spec || '')
      if (data.status === 'waiting_confirm' && (data as any).pending_confirmation) {
        const pc = (data as any).pending_confirmation
        setConfirmDialog({ path: pc.path, reason: pc.reason })
      }
    } catch (e) {
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    if (!id) return
    loadTask()
    loadWorkspaceMemory()
  }, [id, loadTask, loadWorkspaceMemory])

  useEffect(() => {
    if (tab !== 'memory') return
    loadWorkspaceMemory()
    const interval = setInterval(loadWorkspaceMemory, 5000)
    return () => clearInterval(interval)
  }, [tab, loadWorkspaceMemory])

  useEffect(() => {
    logCountRef.current = task?.logs.length || 0
  }, [task?.logs.length])

  useEffect(() => {
    if (!task || !['pending', 'running', 'waiting_confirm', 'waiting_plan_confirm', 'waiting_prototype_confirm', 'reviewing', 'waiting_review_confirm'].includes(task.status)) return
    const interval = setInterval(loadTask, 2000)
    return () => clearInterval(interval)
  }, [task, loadTask])

  useEffect(() => {
    if (!task?.id || !id) return
    const interval = setInterval(async () => {
      try {
        const { logs, total } = await tasksApi.getLogs(id, logCountRef.current)
        if (logs.length) {
          logCountRef.current = total
          setTask(prev => prev ? { ...prev, logs: [...prev.logs, ...logs] } : prev)
        }
      } catch {}
    }, 1500)
    return () => clearInterval(interval)
  }, [id, task?.id])

  const handleConfirm = async () => {
    if (!confirmDialog) return
    await tasksApi.confirmDestructive(id, confirmDialog.path)
    setConfirmDialog(null)
    loadTask()
  }

  const handleReviewConfirm = async (confirmed: boolean) => {
    setReviewConfirming(true)
    try {
      await tasksApi.confirmReview(id, confirmed)
      loadTask()
    } catch (e) {
      console.error(e)
    } finally {
      setReviewConfirming(false)
    }
  }

  const handlePrototypeConfirm = async (confirmed: boolean) => {
    setPrototypeConfirming(true)
    try {
      await tasksApi.confirmPrototype(id, confirmed)
      loadTask()
    } catch (e) {
      console.error(e)
    } finally {
      setPrototypeConfirming(false)
    }
  }

  const handleSaveSpec = async () => {
    setSpecSaving(true)
    try {
      const res = await tasksApi.updateSpec(id, specDraft)
      setTask(prev => prev ? { ...prev, spec: res.spec } : prev)
    } finally {
      setSpecSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!task) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">任务不存在</p>
      </div>
    )
  }

  const STATUS_CONFIG: Record<string, { icon: React.ElementType; color: string; bg: string }> = {
    pending: { icon: Clock, color: 'text-muted-foreground', bg: 'bg-muted' },
    running: { icon: Loader2, color: 'text-blue-600', bg: 'bg-blue-50' },
    waiting_confirm: { icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50' },
    waiting_plan_confirm: { icon: AlertTriangle, color: 'text-yellow-600', bg: 'bg-yellow-50' },
    waiting_prototype_confirm: { icon: AlertTriangle, color: 'text-cyan-600', bg: 'bg-cyan-50' },
    reviewing: { icon: ShieldCheck, color: 'text-blue-600', bg: 'bg-blue-50' },
    waiting_review_confirm: { icon: ShieldAlert, color: 'text-orange-600', bg: 'bg-orange-50' },
    completed: { icon: CheckCircle2, color: 'text-green-600', bg: 'bg-green-50' },
    failed: { icon: XCircle, color: 'text-red-600', bg: 'bg-red-50' },
    cancelled: { icon: XCircle, color: 'text-muted-foreground', bg: 'bg-muted' },
  }
  const statusCfg = STATUS_CONFIG[task.status]
  const StatusIcon = statusCfg.icon
  const subtaskById = new Map((task.plan?.subtasks || []).map(st => [st.id, st]))
  const executionGroups = task.plan?.execution_groups?.length
    ? task.plan.execution_groups
    : (task.plan?.subtasks || []).map(st => [st.id])

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 min-h-14 py-2 flex flex-wrap items-center gap-3 sm:gap-4">
          <a href="/autocode/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition">
            <ArrowLeft className="w-4 h-4" />
            返回
          </a>
          <div className="h-5 w-px bg-border" />
          <div className="flex-1 flex items-center gap-3">
            <h1 className="font-semibold">{task.title}</h1>
            <span className={cn('flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full border', statusCfg.color, statusCfg.bg)}>
              <StatusIcon className={cn('w-3 h-3', task.status === 'running' && 'animate-spin')} />
              {task.status === 'waiting_confirm' ? '待确认' : task.status === 'waiting_plan_confirm' ? '计划确认中' : task.status === 'waiting_prototype_confirm' ? '原型确认中' : task.status === 'reviewing' ? '代码审查中' : task.status === 'waiting_review_confirm' ? '审查确认中' : task.status === 'running' ? '执行中' : task.status === 'completed' ? '已完成' : task.status}
            </span>
            {task.model && (
              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border border-purple-200 bg-purple-50 text-purple-700">
                <Zap className="w-3 h-3" />
                {task.model}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {task.status === 'running' && (
              <button onClick={() => tasksApi.stop(id)} className="text-sm text-red-500 hover:text-red-600 border border-red-200 px-3 py-1.5 rounded-lg hover:bg-red-50 transition">
                停止任务
              </button>
            )}
            {task.status === 'completed' && (
              <button onClick={loadTask} className="text-sm text-muted-foreground hover:text-foreground border px-3 py-1.5 rounded-lg hover:bg-secondary transition">
                <RefreshCw className="w-3.5 h-3.5 inline mr-1" />
                重新执行
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Progress */}
      {(task.status === 'running' || task.status === 'pending' || task.status === 'reviewing') && (
        <div className="border-b bg-blue-50/50 px-6 py-3">
          <div className="max-w-7xl mx-auto flex items-center gap-4">
            <Progress value={(task as any).progress || 0} className="flex-1 h-2" />
            <span className="text-sm text-blue-600 font-mono w-10 text-right">{(task as any).progress || 0}%</span>
            <span className="text-sm text-blue-600">{(task as any).current_step || '初始化中...'}</span>
          </div>
        </div>
      )}

      {task.runtime_note && (
        <div className="border-b bg-secondary/30 px-6 py-2">
          <div className="max-w-7xl mx-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span className={cn(
              'h-2 w-2 rounded-full',
              task.runtime_state === 'active' ? 'bg-green-500 animate-pulse' :
                task.runtime_state === 'waiting' ? 'bg-amber-500' :
                  task.runtime_state === 'terminal' ? 'bg-slate-400' : 'bg-muted-foreground'
            )} />
            <span>{task.runtime_note}</span>
          </div>
        </div>
      )}
      {/* ── 原型确认提示 ── */}
      {task.status === 'waiting_prototype_confirm' && (
        <div className="border-b bg-cyan-50/60 dark:bg-cyan-950/30 px-6 py-4">
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
              <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400">
                <Palette className="w-5 h-5" />
                <span className="font-semibold">UI 原型已生成，请确认</span>
              </div>
              <div className="flex-1" />
              <div className="text-xs text-cyan-600 dark:text-cyan-400 max-w-md">
                {task.current_step || '请在"UI 原型"标签页查看原型效果，确认后将继续构建项目代码。'}
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => setTab('prototype')}
                  className="flex items-center gap-1.5 border border-cyan-300 text-cyan-700 dark:text-cyan-300 px-3 py-2 rounded-lg text-sm bg-white dark:bg-slate-900 hover:bg-cyan-50 transition"
                >
                  <Eye className="w-3.5 h-3.5" />
                  查看原型
                </button>
                <button
                  onClick={() => handlePrototypeConfirm(true)}
                  disabled={prototypeConfirming}
                  className="flex items-center gap-1.5 bg-green-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-green-600 transition disabled:opacity-50"
                >
                  {prototypeConfirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  确认，开始编码
                </button>
                <button
                  onClick={() => handlePrototypeConfirm(false)}
                  disabled={prototypeConfirming}
                  className="flex items-center gap-1.5 border border-red-300 text-red-600 px-4 py-2 rounded-lg text-sm hover:bg-red-50 transition disabled:opacity-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  重新生成
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Main Layout */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4 sm:gap-6">
          {/* Left: Logs + Terminal */}
          <div className="lg:col-span-3 space-y-4 min-w-0">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="w-full overflow-x-auto justify-start">
                <TabsTrigger value="logs" className="gap-1.5">
                  <Terminal className="w-3.5 h-3.5" />
                  执行日志
                  {task.logs.length > 0 && (
                    <span className="bg-primary/20 text-primary-foreground text-xs px-1.5 rounded-full">{task.logs.length}</span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="terminal" className="gap-1.5">
                  <Terminal className="w-3.5 h-3.5" />
                  实时终端
                </TabsTrigger>
                <TabsTrigger value="prototype" className="gap-1.5">
                  <Palette className="w-3.5 h-3.5" />
                  UI 原型
                </TabsTrigger>
                <TabsTrigger value="memory" className="gap-1.5">
                  <Brain className="w-3.5 h-3.5" />
                  工作记忆
                </TabsTrigger>
                <>
                  <TabsTrigger value="spec" className="gap-1.5">
                    <FileText className="w-3.5 h-3.5" />
                    开发规范
                  </TabsTrigger>
                </>
              </TabsList>
              <TabsContent value="logs" className="mt-3">
                <div className="border rounded-xl overflow-hidden" style={{ height: '480px' }}>
                  <LogStream logs={task.logs} />
                </div>
              </TabsContent>
              <TabsContent value="terminal" className="mt-3">
                <div className="border rounded-xl overflow-hidden" style={{ height: '480px' }}>
                  <TerminalPanel workspaceId={task.workspace_id} />
                </div>
              </TabsContent>
              <TabsContent value="prototype" className="mt-3">
                <PrototypePreview
                  workspaceId={task.workspace_id}
                  className="h-full"
                />
              </TabsContent>
              <TabsContent value="memory" className="mt-3">
                <WorkspaceMemoryPanel memory={workspaceMemory} />
              </TabsContent>
              <>
                <TabsContent value="spec" className="mt-3">
                  <div className="border rounded-xl overflow-hidden">
                    <div className="flex items-center justify-between gap-2 px-3 py-2 border-b bg-secondary/40">
                      <div className="text-sm font-medium">SPEC.md</div>
                      <button
                        onClick={handleSaveSpec}
                        disabled={specSaving}
                        className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground disabled:opacity-50"
                      >
                        {specSaving ? '保存中...' : '保存'}
                      </button>
                    </div>
                    <textarea
                      value={specDraft}
                      onChange={e => setSpecDraft(e.target.value)}
                      className="h-[420px] w-full resize-none bg-background p-4 text-xs font-mono leading-relaxed outline-none"
                      placeholder="在这里编写全局 AI 开发规范，任务执行时会读取工作空间根目录 SPEC.md。"
                    />
                  </div>
                </TabsContent>
              </>
            </Tabs>
          </div>

          {/* Right: Plan + Agent + Git + Preview + Deploy */}
          <div className="lg:col-span-2 space-y-4 min-w-0">
            {task.plan && task.plan.subtasks.length > 0 && (
              <div className="border rounded-xl p-4 bg-purple-50/30 dark:bg-purple-950/20">
                <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
                  <Brain className="w-4 h-4 text-purple-600" />
                  智能任务规划
                  <span className="text-xs text-purple-600 font-mono">
                    {task.plan.subtasks.filter(s => s.status === 'completed').length}/{task.plan.subtasks.length}
                  </span>
                </h3>
                {task.plan.overall_approach && (
                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{task.plan.overall_approach}</p>
                )}
                <div className="space-y-3">
                  {executionGroups.map((group, groupIndex) => {
                    const review = (task.phase_reviews || []).find(r => String(r.phase || '').includes(String(groupIndex + 1)))
                    return (
                      <div key={groupIndex} className="rounded-lg border bg-background/60 p-2">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold">阶段 {groupIndex + 1}</span>
                          {review && (
                            <span className={cn('text-[10px] px-1.5 py-0.5 rounded-full', review.passed ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700')}>
                              审查 {review.score ?? '?'} 分
                            </span>
                          )}
                        </div>
                        <div className="space-y-1.5">
                          {group.map((sid) => {
                            const st = subtaskById.get(sid)
                            if (!st) return null
                    const colorMap: Record<string, string> = {
                      pending: 'border-muted bg-muted/30',
                      running: 'border-blue-300 bg-blue-50 dark:bg-blue-950',
                      completed: 'border-green-300 bg-green-50 dark:bg-green-950',
                      failed: 'border-red-300 bg-red-50 dark:bg-red-950',
                      skipped: 'border-amber-300 bg-amber-50',
                    }
                    const iconMap: Record<string, React.ElementType> = {
                      pending: Clock,
                      running: Loader2,
                      completed: CheckCircle2,
                      failed: XCircle,
                      skipped: AlertTriangle,
                    }
                    const Icon = iconMap[st.status] || Clock
                    return (
                      <div key={st.id} className={cn('border rounded-lg p-2.5 text-xs transition-all', colorMap[st.status] || '')}>
                        <div className="flex items-start gap-2">
                          <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', st.status === 'running' && 'animate-spin text-blue-600')} />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium">{st.title}</span>
                              <span className="text-[10px] bg-secondary px-1 rounded">{st.agent_type}</span>
                            </div>
                            {st.status === 'running' && (
                              <div className="mt-1.5">
                                <div className="h-1 bg-muted rounded-full overflow-hidden">
                                  <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${st.progress || 0}%` }} />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )
                          })}
                        </div>
                        {review?.summary && <p className="mt-2 text-[11px] text-muted-foreground line-clamp-2">{review.summary}</p>}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <PhaseReviewPanel reviews={task.phase_reviews} />

            <div className="border rounded-xl p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                Agent 状态
              </h3>
              <div className="space-y-2">
                {(task.agents || []).map(agent => {
                  const isActive = task.status === 'running'
                  return (
                    <div key={agent} className="flex items-center gap-2">
                      <div className={cn('w-2 h-2 rounded-full', isActive ? 'bg-green-500 animate-pulse' : 'bg-muted')} />
                      <span className="text-sm capitalize">{agent}</span>
                      <span className={cn('text-xs ml-auto', isActive ? 'text-green-600' : 'text-muted-foreground')}>
                        {isActive ? '运行中' : '空闲'}
                      </span>
                    </div>
                  )
                })}
                {(task as any).research_report && (
                  <div className="mt-3 pt-3 border-t">
                    <p className="text-xs text-muted-foreground mb-1">技术栈建议</p>
                    <p className="text-xs text-primary">
                      前端: {(task as any).research_report?.tech_stack?.frontend || 'N/A'}
                    </p>
                    <p className="text-xs text-primary">
                      后端: {(task as any).research_report?.tech_stack?.backend || 'N/A'}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* ── 代码审查结果面板 ── */}
            {task.review && (
              <div className={cn(
                'border rounded-xl p-4',
                task.review.passed ? 'bg-green-50/30 dark:bg-green-950/20 border-green-200' : 'bg-orange-50/30 dark:bg-orange-950/20 border-orange-200'
              )}>
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                  {task.review.passed ? (
                    <ShieldCheck className="w-4 h-4 text-green-600" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-orange-600" />
                  )}
                  代码审查
                  <span className={cn(
                    'text-xs px-1.5 py-0.5 rounded-full font-mono',
                    task.review.passed ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'
                  )}>
                    {task.review.score ?? '?'}分
                  </span>
                  <span className={cn(
                    'text-xs ml-auto',
                    task.review.passed ? 'text-green-600' : 'text-orange-600'
                  )}>
                    {task.review.passed ? '✓ 通过' : '✗ 未通过'}
                  </span>
                </h3>

                {/* 审查摘要 */}
                {task.review.summary && (
                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">{task.review.summary}</p>
                )}

                {/* 审查维度 */}
                {task.review.dimensions && Object.keys(task.review.dimensions).length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs text-muted-foreground mb-1.5">审查维度</p>
                    <div className="space-y-1">
                      {Object.entries(task.review.dimensions as Record<string, any>).map(([key, val]) => {
                        if (typeof val !== 'number') {
                          const text = typeof val === 'string' ? val : JSON.stringify(val)
                          return (
                            <div key={key} className="rounded border bg-background/60 p-2">
                              <div className="text-xs font-medium text-muted-foreground capitalize">{key}</div>
                              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">{text}</pre>
                            </div>
                          )
                        }
                        const pct = Math.min(100, Math.max(0, val))
                        const barColor = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-yellow-500' : 'bg-red-500'
                        return (
                          <div key={key} className="flex items-center gap-2">
                            <span className="text-xs w-20 shrink-0 text-muted-foreground capitalize">{key}</span>
                            <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                              <div className={cn('h-full rounded-full transition-all', barColor)} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="text-xs font-mono w-8 text-right">{val}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 问题列表 */}
                {task.review.issues && (task.review.issues as any[]).length > 0 && (
                  <div className="mb-3">
                    <p className="text-xs text-muted-foreground mb-1.5">
                      <AlertCircle className="w-3 h-3 inline mr-1" />
                      发现 {(task.review.issues as any[]).length} 个问题
                    </p>
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {(task.review.issues as any[]).map((issue, i) => {
                        const severityColor: Record<string, string> = {
                          critical: 'border-red-300 bg-red-50 text-red-800',
                          high: 'border-orange-300 bg-orange-50 text-orange-800',
                          medium: 'border-yellow-300 bg-yellow-50 text-yellow-800',
                          low: 'border-blue-300 bg-blue-50 text-blue-800',
                          info: 'border-gray-300 bg-gray-50 text-gray-800',
                        }
                        const sev = (issue.severity || 'info').toLowerCase()
                        return (
                          <div key={i} className={cn('border rounded p-2 text-xs', severityColor[sev] || severityColor.info)}>
                            <div className="flex items-start gap-1.5">
                              <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{issue.title || issue.message}</span>
                                  {issue.severity && (
                                    <span className="text-[10px] uppercase bg-background/50 px-1 rounded">{issue.severity}</span>
                                  )}
                                  {issue.file && (
                                    <code className="text-[10px] bg-background/50 px-1 rounded font-mono">{issue.file}</code>
                                  )}
                                </div>
                                {issue.suggestion && (
                                  <p className="text-[11px] mt-0.5 opacity-80">💡 {issue.suggestion}</p>
                                )}
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* 硬门控：审查不通过 → 确认/拒绝按钮 */}
                {task.status === 'waiting_review_confirm' && (
                  <div className="mt-3 pt-3 border-t border-orange-200">
                    <p className="text-xs text-orange-600 mb-2 flex items-center gap-1">
                      <AlertTriangle className="w-3 h-3" />
                      代码审查未通过，请确认是否继续完成任务
                    </p>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleReviewConfirm(true)}
                        disabled={reviewConfirming}
                        className="flex-1 flex items-center justify-center gap-1.5 bg-green-500 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-green-600 transition disabled:opacity-50"
                      >
                        {reviewConfirming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                        确认继续
                      </button>
                      <button
                        onClick={() => handleReviewConfirm(false)}
                        disabled={reviewConfirming}
                        className="flex-1 flex items-center justify-center gap-1.5 border border-red-300 text-red-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-red-50 transition disabled:opacity-50"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        拒绝（标记失败）
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            <GitVisualizer
              commits={task.commit_history}
              workspaceId={task.workspace_id}
              onRollback={async (hash: string) => {
                await tasksApi.rollback(task.id, hash)
              }}
            />

            <PreviewFrame
              workspaceId={task.workspace_id}
              initialUrl={task.preview_url}
              projectType={task.project_type}
            />

            {task.status === 'completed' && (
              <DeployPanel
                workspaceId={task.workspace_id}
                defaultProjectName={task.title.replace(/\s+/g, '-').toLowerCase()}
              />
            )}
          </div>
        </div>
      </div>

      <Dialog open={!!confirmDialog} onOpenChange={() => setConfirmDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              需要您的确认
            </DialogTitle>
            <DialogDescription>
              Agent 尝试执行以下可能具有破坏性的操作，请确认是否允许。
            </DialogDescription>
          </DialogHeader>
          {confirmDialog && (
            <div className="space-y-3 mt-2">
              <div className="bg-muted rounded-lg p-3 font-mono text-sm">
                <div className="text-xs text-muted-foreground mb-1">路径</div>
                <code className="text-red-600">{confirmDialog.path}</code>
              </div>
              <div className="bg-muted rounded-lg p-3 text-sm">
                <div className="text-xs text-muted-foreground mb-1">原因</div>
                <p>{confirmDialog.reason}</p>
              </div>
            </div>
          )}
          <DialogFooter className="mt-4">
            <button
              onClick={() => setConfirmDialog(null)}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-secondary transition"
            >
              拒绝
            </button>
            <button
              onClick={handleConfirm}
              className="flex items-center gap-2 bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-600 transition"
            >
              <CheckCircle2 className="w-4 h-4" />
              确认执行
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
