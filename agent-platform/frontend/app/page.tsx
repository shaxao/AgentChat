'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ElementType } from 'react'
import { tasksApi, withAuthQuery } from '@/lib/api'
import type { ModelInfo, Task } from '@/types'
import { formatDate, cn } from '@/lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ImportProjectDialog } from '@/components/import-project-dialog'
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Clock,
  Code2,
  Eye,
  GitBranch,
  GitBranchPlus,
  Layers,
  Loader2,
  Play,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
  Zap,
} from 'lucide-react'

const STATUS_CONFIG: Record<string, { icon: ElementType; label: string; color: string; glow: string }> = {
  pending: { icon: Clock, label: '等待中', color: 'text-muted-foreground', glow: 'shadow-none' },
  running: { icon: Loader2, label: '执行中', color: 'text-blue-400', glow: 'shadow-[0_0_15px_hsl(217_91%_60%_/0.15)]' },
  waiting_confirm: { icon: AlertTriangle, label: '待确认', color: 'text-amber-400', glow: 'shadow-none' },
  waiting_plan_confirm: { icon: AlertTriangle, label: '计划确认中', color: 'text-yellow-500', glow: 'shadow-none' },
  waiting_prototype_confirm: { icon: AlertTriangle, label: '原型确认中', color: 'text-cyan-400', glow: 'shadow-none' },
  reviewing: { icon: ShieldCheck, label: '审查中', color: 'text-blue-400', glow: 'shadow-[0_0_15px_hsl(217_91%_60%_/0.15)]' },
  waiting_review_confirm: { icon: ShieldAlert, label: '审查确认中', color: 'text-orange-400', glow: 'shadow-none' },
  completed: { icon: CheckCircle2, label: '已完成', color: 'text-green-400', glow: 'shadow-none' },
  failed: { icon: XCircle, label: '失败', color: 'text-red-400', glow: 'shadow-none' },
  cancelled: { icon: XCircle, label: '已取消', color: 'text-muted-foreground', glow: 'shadow-none' },
}

const ACTIVE_STATUSES = [
  'pending',
  'running',
  'waiting_confirm',
  'waiting_plan_confirm',
  'waiting_prototype_confirm',
  'reviewing',
  'waiting_review_confirm',
]

function sortTasks(tasks: Task[]) {
  return [...tasks].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [showCreate, setShowCreate] = useState(false)
  const [showImport, setShowImport] = useState(false)

  const loadTasks = useCallback(async () => {
    try {
      const data = await tasksApi.list()
      setTasks(sortTasks(data))
    } catch (error) {
      console.error('Failed to load tasks', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadTasks()
  }, [loadTasks])

  useEffect(() => {
    const running = tasks.filter(task => ACTIVE_STATUSES.includes(task.status))
    if (!running.length) return

    const interval = window.setInterval(async () => {
      await Promise.all(running.map(async task => {
        try {
          const updated = await tasksApi.getStatus(task.id)
          setTasks(prev => prev.map(item =>
            item.id === task.id
              ? {
                  ...item,
                  status: updated.status as Task['status'],
                  progress: updated.progress,
                  current_step: updated.current_step,
                  preview_url: updated.preview_url ?? item.preview_url,
                }
              : item
          ))
        } catch {
          // Keep the last known state; the next poll can recover.
        }
      }))
    }, 3000)

    return () => window.clearInterval(interval)
  }, [tasks])

  const runningCount = tasks.filter(task => task.status === 'running').length

  const stats = [
    { label: '总任务', value: tasks.length, icon: Code2, color: 'text-blue-400' },
    { label: '已完成', value: tasks.filter(task => task.status === 'completed').length, icon: CheckCircle2, color: 'text-green-400' },
    { label: '进行中', value: tasks.filter(task => task.status === 'running').length, icon: Loader2, color: 'text-purple-400' },
    { label: '失败', value: tasks.filter(task => task.status === 'failed').length, icon: XCircle, color: 'text-red-400' },
  ]

  return (
    <div className="min-h-screen bg-background">
      <header className="tech-header sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 min-h-16 py-3 flex flex-col gap-3 sm:h-16 sm:py-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shadow-[0_0_15px_hsl(217_91%_60%_/0.3)]">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="font-semibold text-foreground tech-gradient-text">AutoCode Agent</h1>
              <p className="text-xs text-muted-foreground">自主式 AI 编程平台</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {runningCount > 0 && (
              <span className="flex items-center gap-1.5 text-sm text-blue-400 bg-blue-500/10 border border-blue-500/20 px-3 py-1 rounded-full">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {runningCount} 个任务运行中
              </span>
            )}
            <button onClick={() => setShowImport(true)} className="tech-btn-secondary flex items-center gap-2 shrink-0">
              <GitBranchPlus className="w-4 h-4" />
              导入项目
            </button>
            <button onClick={() => setShowCreate(true)} className="tech-btn-primary flex items-center gap-2 shrink-0">
              <Plus className="w-4 h-4" />
              新建任务
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-5 sm:py-8">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
          {stats.map(stat => (
            <div key={stat.label} className="tech-stat-card">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-muted-foreground">{stat.label}</span>
                <stat.icon className={cn('w-4 h-4', stat.color)} />
              </div>
              <div className="text-2xl font-semibold text-foreground">{stat.value}</div>
            </div>
          ))}
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold flex items-center gap-2 text-foreground">
            <Terminal className="w-5 h-5 text-blue-400" />
            任务列表
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin mr-2 text-blue-400" />
              加载中...
            </div>
          ) : tasks.length === 0 ? (
            <div className="text-center py-20 border-2 border-dashed border-border/50 rounded-xl bg-card/50">
              <Code2 className="w-12 h-12 mx-auto text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground mb-2">还没有任务</p>
              <p className="text-sm text-muted-foreground">点击右上角“新建任务”，用自然语言描述要做的项目。</p>
            </div>
          ) : (
            <div className="space-y-3">
              {tasks.map(task => <TaskCard key={task.id} task={task} />)}
            </div>
          )}
        </section>
      </main>

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={loadTasks} />}
      <ImportProjectDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => {
          setShowImport(false)
          loadTasks()
        }}
      />
    </div>
  )
}

function TaskCard({ task }: { task: Task }) {
  const cfg = STATUS_CONFIG[task.status] ?? STATUS_CONFIG.pending
  const Icon = cfg.icon
  const progress = task.progress ?? 0

  const openPreview = (event: React.MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    const previewUrl = withAuthQuery(task.preview_url) || task.preview_url
    if (previewUrl) window.open(previewUrl, '_blank')
  }

  return (
    <a href={`/autocode/tasks/${task.id}`} className="block group">
      <article className={cn('tech-card p-4', cfg.glow)}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              <h3 className="font-medium truncate group-hover:text-blue-400 transition">{task.title}</h3>
              <span className={cn('flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border', cfg.color, 'bg-secondary/50 border-border/50')}>
                <Icon className={cn('w-3 h-3', task.status === 'running' && 'animate-spin')} />
                {cfg.label}
              </span>
            </div>
            <p className="text-sm text-muted-foreground truncate mb-2">{task.description}</p>
            <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Code2 className="w-3 h-3" />
                {task.project_type}
              </span>
              <span className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" />
                {(task.commit_history || []).length} commits
              </span>
              <span>{formatDate(task.created_at)}</span>
              {(task.agents || []).map(agent => <span key={agent} className="tech-badge">{agent}</span>)}
            </div>
          </div>

          {task.status === 'completed' && task.preview_url && (
            <span
              onClick={openPreview}
              className="flex items-center gap-1 text-sm text-green-400 hover:text-green-300 sm:ml-4 cursor-pointer transition-colors"
              role="button"
              tabIndex={0}
            >
              <Eye className="w-4 h-4" />
              预览
            </span>
          )}
        </div>

        {['running', 'pending', 'reviewing'].includes(task.status) && (
          <div className="mt-3">
            <div className="h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-400 to-purple-400 rounded-full transition-all duration-500 shadow-[0_0_8px_hsl(217_91%_60%_/0.3)]"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground mt-1">{task.current_step || '初始化中...'}</p>
          </div>
        )}

        {task.plan && task.plan.subtasks.length > 0 && (
          <div className="mt-3 border-t border-border/50 pt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-1.5">
              <Brain className="w-3.5 h-3.5 text-purple-400" />
              <span>智能规划 · {task.plan.subtasks.length} 个子任务</span>
              <span className="text-purple-400">({task.plan.subtasks.filter(item => item.status === 'completed').length} 已完成)</span>
            </div>
            <div className="flex gap-1 flex-wrap">
              {task.plan.subtasks.map(subtask => {
                const colorMap: Record<string, string> = {
                  pending: 'bg-muted/50 text-muted-foreground border-border/50',
                  running: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
                  completed: 'bg-green-500/15 text-green-400 border-green-500/30',
                  failed: 'bg-red-500/15 text-red-400 border-red-500/30',
                  skipped: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
                }
                return (
                  <span
                    key={subtask.id}
                    className={cn('flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border max-w-[260px] truncate', colorMap[subtask.status] || colorMap.pending)}
                    title={subtask.description}
                  >
                    <Layers className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate">{subtask.title}</span>
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </article>
    </a>
  )
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [projectType, setProjectType] = useState('nextjs')
  const [selectedModel, setSelectedModel] = useState('')
  const [spec, setSpec] = useState(`# SPEC.md

## Global AI Rules
- Follow this file before implementing any task.
- Keep every phase boundary clear: objective, scope, files, acceptance criteria, and risks.
- After each execution phase, run a code review before moving on.
`)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [modelsLoading, setModelsLoading] = useState(true)
  const [enableSmartPlanning, setEnableSmartPlanning] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    tasksApi.models('tool')
      .then(setModels)
      .catch(() => setModels([]))
      .finally(() => setModelsLoading(false))
  }, [])

  const handleSubmit = async () => {
    if (!title.trim() || !description.trim()) {
      setError('请填写标题和需求描述')
      return
    }

    setSubmitting(true)
    setError('')
    try {
      await tasksApi.create({
        title: title.trim(),
        description: description.trim(),
        project_type: projectType,
        agent_types: ['frontend'],
        enable_smart_planning: enableSmartPlanning,
        ...(selectedModel && { model: selectedModel }),
        ...(spec.trim() && { spec: spec.trim() }),
      })
      await onCreated()
      onClose()
    } catch (err: any) {
      setError(err?.message || '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>新建 AI 编程任务</DialogTitle>
          <DialogDescription>用自然语言描述要做的项目，AI Agent 将按计划完成开发流程。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-2">
          <div>
            <label className="text-sm font-medium mb-1 block">任务标题</label>
            <input
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="例如：帮我做一个产品展示网站"
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">需求描述</label>
            <textarea
              value={description}
              onChange={event => setDescription(event.target.value)}
              placeholder="详细描述需求，包括功能、设计风格、技术要求等..."
              rows={4}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
            />
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">项目框架</label>
            <Select value={projectType} onValueChange={setProjectType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent className="z-[9999] bg-white dark:bg-gray-900 border shadow-lg">
                <SelectItem value="nextjs">Next.js (React)</SelectItem>
                <SelectItem value="react">React SPA</SelectItem>
                <SelectItem value="vue">Vue 3</SelectItem>
                <SelectItem value="python">Python (FastAPI)</SelectItem>
                <SelectItem value="go">Go (Gin)</SelectItem>
                <SelectItem value="java">Java (Spring Boot)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">AI 模型（可选）</label>
            <Select value={selectedModel || 'auto'} onValueChange={value => setSelectedModel(value === 'auto' ? '' : value)}>
              <SelectTrigger>
                <SelectValue placeholder={modelsLoading ? '加载模型中...' : '自动路由（默认）'} />
              </SelectTrigger>
              <SelectContent className="z-[9999] bg-white dark:bg-gray-900 border shadow-lg">
                <SelectItem value="auto">自动路由（默认）</SelectItem>
                {models.map(model => (
                  <SelectItem key={model.model_id} value={model.model_id}>
                    {model.name} <span className="text-xs text-muted-foreground ml-1">({model.provider})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">不选择则使用智能路由自动选择最佳模型。</p>
          </div>

          <div className="flex items-center justify-between border rounded-lg px-3 py-2.5">
            <div>
              <span className="text-sm font-medium">智能任务规划</span>
              <p className="text-xs text-muted-foreground">AI 自动拆分需求为子任务，并按依赖顺序执行。</p>
            </div>
            <button
              type="button"
              onClick={() => setEnableSmartPlanning(value => !value)}
              className={cn('relative w-10 h-6 rounded-full transition-colors', enableSmartPlanning ? 'bg-primary' : 'bg-muted')}
            >
              <span className={cn('absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform', enableSmartPlanning ? 'translate-x-4' : '')} />
            </button>
          </div>

          <div>
            <label className="text-sm font-medium mb-1 block">开发规范 SPEC.md（全局 AI 必须遵守）</label>
            <textarea
              value={spec}
              onChange={event => setSpec(event.target.value)}
              placeholder="描述开发规范、代码风格、架构约束、阶段边界、审查规则等..."
              rows={7}
              className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none font-mono"
            />
            <p className="text-xs text-muted-foreground mt-1">内容会写入工作空间根目录 SPEC.md，可在任务详情中随时修改。</p>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="tech-btn-secondary">取消</button>
            <button
              onClick={handleSubmit}
              disabled={submitting}
              className="tech-btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {submitting ? '启动中...' : '启动任务'}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
