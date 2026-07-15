import { useState, useEffect, useCallback, useRef } from 'react'
import {
  workflowApi,
  workflowArtifactApi,
  type WorkflowBriefVO,
  type WorkflowVO,
  type ExecutionBriefVO,
  type ExecutionVO,
  type ExecutionEventVO,
  type WorkflowArtifactVO,
  type DslValidationResult,
} from '@/lib/api'
import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import {
  Card,
  CardContent,
} from '@/components/ui/card'
import {
  Workflow,
  Plus,
  Play,
  Pause,
  Trash2,
  Edit3,
  RefreshCw,
  Clock,
  Sparkles,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  History,
  ChevronRight,
  Timer,
  Zap,
  Info,
  Terminal,
  StopCircle,
  GitBranch,
  Save,
  FileUp,
  ImageIcon,
  Mic2,
  ExternalLink,
} from 'lucide-react'
import WorkflowCanvas from '@/components/workflow/WorkflowCanvas'

// ==================== 常量 ====================

type Tab = 'list' | 'generate' | 'visual' | 'history'

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  active:    { label: '运行中', color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', icon: <CheckCircle2 className="w-3 h-3" /> },
  paused:    { label: '已暂停', color: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400', icon: <Pause className="w-3 h-3" /> },
  error:     { label: '异常',   color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',     icon: <AlertCircle className="w-3 h-3" /> },
  running:   { label: '执行中', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',  icon: <Loader2 className="w-3 h-3 animate-spin" /> },
  success:   { label: '成功',   color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400', icon: <CheckCircle2 className="w-3 h-3" /> },
  failed:    { label: '失败',   color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',      icon: <XCircle className="w-3 h-3" /> },
  cancelled: { label: '已取消', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',     icon: <XCircle className="w-3 h-3" /> },
}

const TRIGGER_LABELS: Record<string, string> = { manual: '手动', cron: '定时', resume: '续执行' }

// ==================== 工具函数 ====================

function formatJson(raw: string): string {
  try { return JSON.stringify(JSON.parse(raw), null, 2) }
  catch { return raw }
}

function parseJsonValue(raw?: string | null): unknown {
  if (!raw) return null
  try {
    const first = JSON.parse(raw)
    if (typeof first === 'string') {
      const trimmed = first.trim()
      if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
        try { return JSON.parse(trimmed) } catch { return first }
      }
    }
    return first
  } catch {
    return raw
  }
}

function getNativeToolResult(raw?: string | null): Record<string, any> | null {
  const parsed = parseJsonValue(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, any>
  return obj.schemaVersion === 'workflow.native.v1' ? obj : null
}

function formatFileSize(size?: number | null): string {
  if (size == null || Number.isNaN(size)) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function isArtifactType(artifact: WorkflowArtifactVO, type: string, mimePrefix: string) {
  return artifact.fileType === type || !!artifact.mimeType?.startsWith(mimePrefix)
}

function WorkflowArtifactPreview({ artifact }: { artifact: WorkflowArtifactVO }) {
  if (!artifact.ossUrl) return null

  if (isArtifactType(artifact, 'image', 'image/')) {
    return (
      <a href={artifact.ossUrl} target="_blank" rel="noreferrer" className="mt-2 block">
        <img
          src={artifact.ossUrl}
          alt={artifact.fileName || 'workflow artifact'}
          loading="lazy"
          className="max-h-56 w-full rounded-md border bg-background object-contain"
        />
      </a>
    )
  }

  if (isArtifactType(artifact, 'audio', 'audio/')) {
    return (
      <audio
        className="mt-2 w-full"
        controls
        preload="metadata"
        src={artifact.ossUrl}
      />
    )
  }

  if (isArtifactType(artifact, 'video', 'video/')) {
    return (
      <video
        className="mt-2 max-h-64 w-full rounded-md border bg-black"
        controls
        preload="metadata"
        src={artifact.ossUrl}
      />
    )
  }

  return null
}

function appendUniqueExecutionEvent(events: ExecutionVO['events'] | undefined, event: ExecutionEventVO) {
  const current = events || []
  if (current.some(item => item.id === event.id)) return current
  return [...current, event]
}

function NativeToolResultView({ raw }: { raw?: string | null }) {
  const result = getNativeToolResult(raw)
  if (!result) return null

  const artifact = result.artifact && typeof result.artifact === 'object'
    ? result.artifact as Record<string, any>
    : null
  const derivedArtifact = result.derivedArtifact && typeof result.derivedArtifact === 'object'
    ? result.derivedArtifact as Record<string, any>
    : null
  const toolIcon =
    result.tool === 'image_recognition' ? <ImageIcon className="w-4 h-4 text-blue-500" /> :
    result.tool === 'audio_transcribe' ? <Mic2 className="w-4 h-4 text-emerald-500" /> :
    <FileUp className="w-4 h-4 text-slate-500" />
  const toolLabel =
    result.tool === 'image_recognition' ? '图片识别结果' :
    result.tool === 'audio_transcribe' ? '音频转写结果' :
    '文件资产'

  return (
    <div className="mt-3 rounded-md border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {toolIcon}
          {toolLabel}
        </div>
        {result.elapsedMs != null && (
          <Badge variant="outline" className="rounded-md">{result.elapsedMs}ms</Badge>
        )}
      </div>

      {artifact && (
        <div className="rounded bg-background p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{artifact.fileName || '未命名文件'}</span>
            {artifact.fileType && <Badge variant="outline" className="rounded-md text-[10px]">{artifact.fileType}</Badge>}
            {artifact.mimeType && <span className="text-muted-foreground">{artifact.mimeType}</span>}
          </div>
          {artifact.uuid && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground break-all">{artifact.uuid}</div>
          )}
          {artifact.url && (
            <a
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
            >
              打开文件 <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      )}

      {result.prompt && (
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">提示词</div>
          <div className="rounded bg-background p-2 whitespace-pre-wrap">{result.prompt}</div>
        </div>
      )}

      {result.text && (
        <div className="text-xs">
          <div className="text-muted-foreground mb-1">文本结果</div>
          <div className="rounded bg-background p-2 whitespace-pre-wrap leading-relaxed">{result.text}</div>
        </div>
      )}

      {derivedArtifact && (
        <div className="rounded border border-dashed bg-background p-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">已生成派生资产</span>
            {derivedArtifact.sourceType && (
              <Badge variant="outline" className="rounded-md text-[10px]">{derivedArtifact.sourceType}</Badge>
            )}
            {derivedArtifact.fileName && <span className="text-muted-foreground">{derivedArtifact.fileName}</span>}
          </div>
          {derivedArtifact.uuid && (
            <div className="mt-1 font-mono text-[10px] text-muted-foreground break-all">{derivedArtifact.uuid}</div>
          )}
        </div>
      )}
    </div>
  )
}

// ==================== 子组件 ====================

/** 工作流创建/编辑对话框 */
function WorkflowFormDialog({
  open,
  onClose,
  onSaved,
  initialData,
  initialDsl,
}: {
  open: boolean
  onClose: () => void
  onSaved: () => void
  initialData?: WorkflowVO | null
  initialDsl?: string  // AI 生成的 DSL，优先级高于 initialData.dsl
}) {
  const isEdit = !!initialData
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [dsl, setDsl] = useState('')
  const [cron, setCron] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [dslValid, setDslValid] = useState<DslValidationResult | null>(null)
  const [validating, setValidating] = useState(false)
  const [showGuide, setShowGuide] = useState(false)

  useEffect(() => {
    if (open) {
      setName(initialData?.name || '')
      setDesc(initialData?.description || '')
      // 优先使用 initialDsl（AI 生成），其次编辑时的已有 Dsl
      setDsl(initialDsl || initialData?.dsl || '')
      setCron(initialData?.cronExpr || '')
      setError('')
      setDslValid(null)
      setShowGuide(false)
    }
  }, [open, initialData, initialDsl])

  const validate = async () => {
    if (!dsl.trim()) return
    setValidating(true)
    try {
      setDslValid(await workflowApi.validateDsl(dsl))
    } catch (e: any) {
      setDslValid({ valid: false, error: e.message })
    }
    setValidating(false)
  }

  const save = async () => {
    if (!name.trim()) { setError('请输入名称'); return }
    setSaving(true)
    setError('')
    try {
      const dto = { name: name.trim(), description: desc, dsl, cronExpr: cron }
      if (isEdit && initialData) {
        await workflowApi.update(initialData.id, dto)
      } else {
        await workflowApi.create(dto)
      }
      onSaved()
      onClose()
    } catch (e: any) {
      setError(e.message || '保存失败')
    }
    setSaving(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Workflow className="w-5 h-5" />
            {isEdit ? '编辑工作流' : '新建工作流'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div>
            <label className="text-sm font-medium">名称 *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：每日报表生成" maxLength={128} className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">描述</label>
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="描述工作流的用途..." maxLength={500} rows={2} className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium flex items-center gap-1"><Clock className="w-3.5 h-3.5" />Cron 表达式</label>
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="例如：* * * * * (每分钟) 或 0 8 * * * (每天8点)" className="mt-1 font-mono text-sm" />
            <p className="text-xs text-muted-foreground mt-1">格式：分 时 日 月 周（5 段），留空则仅支持手动触发</p>
          </div>
          <div>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium flex items-center gap-1"><Terminal className="w-3.5 h-3.5" />DSL 定义</label>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="sm" onClick={() => setShowGuide(!showGuide)}>
                  <Info className="w-3.5 h-3.5 mr-1" />{showGuide ? '收起指南' : '编写指南'}
                </Button>
                <Button variant="outline" size="sm" onClick={validate} disabled={!dsl.trim() || validating}>
                  {validating && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />}
                  <Info className="w-3.5 h-3.5 mr-1" />验证
                </Button>
              </div>
            </div>

            {/* DSL 编写指南 */}
            {showGuide && (
              <div className="mt-2 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md text-xs space-y-3 max-h-60 overflow-y-auto">
                <div>
                  <p className="font-semibold text-blue-800 dark:text-blue-300 mb-2">DSL 是一个 JSON 对象，包含 trigger（触发器）和 steps（步骤列表）两部分：</p>
                  <pre className="bg-slate-900 text-green-300 p-3 rounded text-[11px] overflow-x-auto">
{`{
  "trigger": { "type": "cron", "value": "0 8 * * *" },
  "steps": [
    {
      "id": "step1",
      "tool": "web_search",
      "description": "搜索最新新闻",
      "args": { "keyword": "AI 领域" }
    },
    {
      "id": "step2",
      "tool": "generate_summary",
      "description": "生成摘要",
      "condition": "step1.success",
      "args": { "maxLength": 200 }
    }
  ]
}`}
                  </pre>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {/* trigger */}
                  <div>
                    <p className="font-semibold mb-1">🔔 trigger（触发器）</p>
                    <ul className="space-y-0.5 text-muted-foreground">
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">type</code>：<b>"cron"</b> 定时 | <b>"manual"</b> 手动</li>
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">value</code>：Cron 表达式，如 <code>0 8 * * *</code></li>
                      <li className="text-[10px] text-muted-foreground mt-1">Cron 格式：分 时 日 月 周（5 段），如 <code>* * * * *</code> 每分钟、<code>0 8 * * *</code> 每天 8:00</li>
                    </ul>
                  </div>
                  {/* steps */}
                  <div>
                    <p className="font-semibold mb-1">📋 steps（步骤）</p>
                    <ul className="space-y-0.5 text-muted-foreground">
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">id</code>：唯一标识</li>
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">tool</code>：调用的工具名称</li>
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">description</code>：步骤描述</li>
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">args</code>：工具参数，<code>&#123;&#125;</code> 对象</li>
                      <li><code className="bg-slate-100 dark:bg-slate-800 px-1 rounded">condition</code>：<span className="text-[10px]">可选，如 step1.success</span></li>
                    </ul>
                  </div>
                </div>
                <div>
                  <p className="font-semibold mb-1">💡 快速插入示例：</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="outline" size="sm" className="text-[11px] h-6"
                      onClick={() => {
                        const example = '{\n  "trigger": { "type": "manual" },\n  "steps": [\n    {\n      "id": "step1",\n      "tool": "web_search",\n      "description": "搜索信息",\n      "args": {}\n    }\n  ]\n}'
                        setDsl(example); setDslValid(null)
                      }}>
                      📝 基础模板
                    </Button>
                    <Button variant="outline" size="sm" className="text-[11px] h-6"
                      onClick={() => {
                        const example = '{\n  "trigger": { "type": "cron", "value": "0 8 * * *" },\n  "steps": [\n    {\n      "id": "step1",\n      "tool": "check_data",\n      "description": "检查新数据",\n      "args": { "source": "database" }\n    },\n    {\n      "id": "step2",\n      "tool": "generate_report",\n      "description": "生成日报",\n      "condition": "step1.success",\n      "args": { "format": "pdf" }\n    }\n  ]\n}'
                        setDsl(example); setDslValid(null)
                      }}>
                      ⏰ 定时报表
                    </Button>
                    <Button variant="outline" size="sm" className="text-[11px] h-6"
                      onClick={() => {
                        const example = '{\n  "trigger": { "type": "manual" },\n  "steps": [\n    {\n      "id": "monitor",\n      "tool": "http_check",\n      "description": "检查服务状态",\n      "args": { "url": "https://example.com/health" }\n    },\n    {\n      "id": "alert",\n      "tool": "send_wechat",\n      "description": "异常告警",\n      "condition": "monitor.failed",\n      "args": { "message": "服务异常！" }\n    }\n  ]\n}'
                        setDsl(example); setDslValid(null)
                      }}>
                      🔍 监控告警
                    </Button>
                    <Button variant="ghost" size="sm" className="text-[11px] h-6 text-muted-foreground"
                      onClick={() => { setDsl(''); setDslValid(null); setShowGuide(false) }}>
                      🗑 清空
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <Textarea value={dsl} onChange={(e) => { setDsl(e.target.value); setDslValid(null) }}
              placeholder='点击上方"编写指南"查看格式说明，或使用"AI 生成"Tab 自动生成'
              rows={10} className="mt-1 font-mono text-xs" />
            {dslValid && (
              <div className={cn('mt-2 p-2 rounded text-xs', dslValid.valid ? 'bg-green-50 text-green-700 dark:bg-green-900/20' : 'bg-red-50 text-red-700 dark:bg-red-900/20')}>
                {dslValid.valid
                  ? `✓ 有效 — 触发:${dslValid.triggerType || '?'} Cron:${dslValid.cronExpr || '无'} ${dslValid.stepCount || 0}步骤`
                  : `✗ ${dslValid.error || '验证失败'}`}
              </div>
            )}
            {!dsl.trim() && !showGuide && (
              <p className="text-xs text-muted-foreground mt-1">
                不知道怎么写？点击「编写指南」查看格式说明和示例模板，或切换到「AI 生成」Tab 用自然语言自动生成。
              </p>
            )}
          </div>
          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="w-4 h-4 animate-spin mr-1" />}{isEdit ? '保存' : '创建'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 执行详情对话框 */
function ExecutionDetailDialog({
  open,
  onClose,
  executionId,
  onTerminal,
  onResumeCreated,
}: {
  open: boolean
  onClose: () => void
  executionId: number | null
  onTerminal?: (execution: ExecutionVO) => void
  onResumeCreated?: (execution: ExecutionVO) => void
}) {
  const [detail, setDetail] = useState<ExecutionVO | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [resumingStepId, setResumingStepId] = useState<string | null>(null)
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'live' | 'closed' | 'error'>('idle')
  const [artifacts, setArtifacts] = useState<WorkflowArtifactVO[]>([])
  const [artifactsLoading, setArtifactsLoading] = useState(false)
  const [artifactsError, setArtifactsError] = useState('')
  const streamAbortRef = useRef<AbortController | null>(null)
  const onTerminalRef = useRef(onTerminal)

  useEffect(() => {
    onTerminalRef.current = onTerminal
  }, [onTerminal])

  const loadArtifacts = useCallback(async (id: number) => {
    setArtifactsLoading(true)
    setArtifactsError('')
    try {
      setArtifacts(await workflowArtifactApi.list({ executionId: id }))
    } catch (e: any) {
      setArtifactsError(e.message || '产物加载失败')
    } finally {
      setArtifactsLoading(false)
    }
  }, [])

  useEffect(() => {
    streamAbortRef.current?.abort()
    streamAbortRef.current = null

    if (open && executionId) {
      setLoading(true)
      setError('')
      setArtifacts([])
      setArtifactsError('')
      setStreamState('connecting')
      workflowApi.executionDetail(executionId).then(setDetail).catch((e) => setError(e.message || '加载失败')).finally(() => setLoading(false))
      loadArtifacts(executionId)
      streamAbortRef.current = workflowApi.streamExecution(
        executionId,
        (snapshot) => {
          setDetail(snapshot)
          setLoading(false)
          setStreamState(snapshot.status === 'running' ? 'live' : 'closed')
        },
        (event) => {
          setDetail((prev) => prev ? { ...prev, events: appendUniqueExecutionEvent(prev.events, event) } : prev)
        },
        (snapshot) => {
          setDetail(snapshot)
          setLoading(false)
          setStreamState('closed')
          loadArtifacts(executionId)
          onTerminalRef.current?.(snapshot)
        },
        (message) => {
          setLoading(false)
          setStreamState('error')
          setError((prev) => prev || message)
        },
      )
    }

    return () => {
      streamAbortRef.current?.abort()
      streamAbortRef.current = null
      setStreamState('idle')
    }
  }, [open, executionId, loadArtifacts])

  const cfg = detail ? STATUS_CONFIG[detail.status] : null
  const currentStep = detail?.steps?.find(step => step.status === 'running')
  const completedSteps = detail?.steps?.filter(step => step.status === 'completed').length || 0
  const totalSteps = detail?.steps?.length || 0
  const canResume = !!detail && ['failed', 'cancelled'].includes(detail.status)
  const firstFailedStep = detail?.steps?.find(step => step.status === 'failed' || step.status === 'cancelled')

  const handleResume = async (fromStepId?: string) => {
    if (!detail) return
    setResumingStepId(fromStepId || '__auto__')
    setError('')
    try {
      const next = await workflowApi.resumeExecution(detail.id, fromStepId)
      onResumeCreated?.(next)
    } catch (e: any) {
      setError(e.message || '续执行失败')
    } finally {
      setResumingStepId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-[95vw] sm:max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle className="flex items-center gap-2"><History className="w-5 h-5" />执行详情 #{executionId}</DialogTitle></DialogHeader>
        {loading && <div className="py-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {detail && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">状态：</span>
              {cfg && <Badge className={cn('gap-1', cfg.color)}>{cfg.icon}{cfg.label}</Badge>}
              <span className="text-xs text-muted-foreground">{TRIGGER_LABELS[detail.triggerType] || detail.triggerType}触发</span>
              {streamState === 'live' && (
                <Badge variant="outline" className="gap-1 rounded-md text-blue-600 border-blue-300">
                  <Loader2 className="w-3 h-3 animate-spin" />实时
                </Badge>
              )}
              {streamState === 'connecting' && (
                <Badge variant="outline" className="rounded-md text-muted-foreground">连接中</Badge>
              )}
            </div>
            {canResume && (
              <div className="rounded-md border bg-amber-50/60 dark:bg-amber-950/20 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-medium text-amber-700 dark:text-amber-300">可以从断点继续执行</div>
                    <div className="mt-0.5 text-xs text-amber-700/70 dark:text-amber-300/70">
                      {firstFailedStep ? `默认从 ${firstFailedStep.stepName || firstFailedStep.stepId} 开始` : '系统会自动定位失败步骤'}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-amber-300 text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
                    disabled={!!resumingStepId}
                    onClick={() => handleResume()}
                  >
                    {resumingStepId === '__auto__' ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Play className="w-3.5 h-3.5 mr-1" />}
                    从失败点继续
                  </Button>
                </div>
              </div>
            )}
            {detail.status === 'running' && (
              <div className="rounded-md border bg-blue-50/60 dark:bg-blue-950/20 p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 font-medium text-blue-700 dark:text-blue-300">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {currentStep ? `正在执行：${currentStep.stepName || currentStep.stepId}` : '工作流执行中'}
                  </div>
                  {totalSteps > 0 && (
                    <span className="text-xs text-blue-700/70 dark:text-blue-300/70">
                      {completedSteps}/{totalSteps} 已完成
                    </span>
                  )}
                </div>
                {currentStep?.toolName && (
                  <div className="mt-1 text-xs text-blue-700/70 dark:text-blue-300/70">
                    工具：{currentStep.toolName}
                  </div>
                )}
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              <div>开始：{detail.startedAt ? formatDate(detail.startedAt) : '-'}</div>
              <div>结束：{detail.finishedAt ? formatDate(detail.finishedAt) : '-'}</div>
              <div>耗时：{detail.durationMs != null ? `${detail.durationMs}ms` : '-'}</div>
            </div>
            {detail.errorMsg && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded text-sm text-red-700 dark:text-red-400"><pre className="whitespace-pre-wrap text-xs">{detail.errorMsg}</pre></div>}
            <div className="rounded-md border bg-background p-3 text-sm">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  <FileUp className="h-4 w-4 text-slate-500" />
                  执行产物
                  {!!artifacts.length && <Badge variant="outline" className="rounded-md">{artifacts.length}</Badge>}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={artifactsLoading || !executionId}
                  onClick={() => executionId && loadArtifacts(executionId)}
                >
                  <RefreshCw className={cn('mr-1 h-3 w-3', artifactsLoading && 'animate-spin')} />
                  刷新
                </Button>
              </div>
              {artifactsError && <div className="text-xs text-red-500">{artifactsError}</div>}
              {artifactsLoading && !artifacts.length && (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在加载产物
                </div>
              )}
              {!artifactsLoading && !artifactsError && artifacts.length === 0 && (
                <div className="text-xs text-muted-foreground">暂无产物</div>
              )}
              {!!artifacts.length && (
                <div className="space-y-2">
                  {artifacts.map((artifact) => (
                    <div key={artifact.uuid || artifact.id} className="rounded-md border bg-muted/20 p-2 text-xs">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate font-medium">{artifact.fileName || '未命名产物'}</div>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground">
                            {artifact.fileType && <Badge variant="outline" className="rounded-md text-[10px]">{artifact.fileType}</Badge>}
                            {artifact.sourceType && <span>{artifact.sourceType}</span>}
                            <span>{formatFileSize(artifact.fileSize)}</span>
                            {artifact.stepId && <span>step: {artifact.stepId}</span>}
                          </div>
                        </div>
                        {artifact.ossUrl && (
                          <a
                            className="inline-flex shrink-0 items-center gap-1 text-blue-600 hover:underline"
                            href={artifact.ossUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            打开 <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </div>
                      {artifact.uuid && (
                        <div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{artifact.uuid}</div>
                      )}
                      <WorkflowArtifactPreview artifact={artifact} />
                      {artifact.contentText && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">查看文本内容</summary>
                          <pre className="mt-2 max-h-48 overflow-auto rounded bg-background p-2 whitespace-pre-wrap">{artifact.contentText}</pre>
                        </details>
                      )}
                      {artifact.metadataJson && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">元数据</summary>
                          <pre className="mt-2 max-h-32 overflow-auto rounded bg-background p-2 whitespace-pre-wrap">{formatJson(artifact.metadataJson)}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            {!!detail.steps?.length && (
              <div className="space-y-2">
                <div className="text-sm font-medium">步骤轨迹</div>
                <div className="space-y-2">
                  {detail.steps.map(step => (
                    <div key={step.id} className="rounded-md border bg-background p-3 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{step.stepName || step.stepId}</div>
                          <div className="text-xs text-muted-foreground">{step.toolName || '未指定工具'} · {step.stepId}</div>
                        </div>
                        <Badge variant="outline" className="rounded-md">{step.status}</Badge>
                      </div>
                      {canResume && (
                        <div className="mt-2 flex justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 text-xs"
                            disabled={!!resumingStepId}
                            onClick={() => handleResume(step.stepId)}
                          >
                            {resumingStepId === step.stepId ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <RefreshCw className="w-3 h-3 mr-1" />}
                            从此步骤重跑
                          </Button>
                        </div>
                      )}
                      <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                        <span>开始：{step.startedAt ? formatDate(step.startedAt) : '-'}</span>
                        <span>结束：{step.finishedAt ? formatDate(step.finishedAt) : '-'}</span>
                        <span>耗时：{step.durationMs != null ? `${step.durationMs}ms` : '-'}</span>
                      </div>
                      {step.errorMsg && <pre className="mt-2 whitespace-pre-wrap rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-300">{step.errorMsg}</pre>}
                      <NativeToolResultView raw={step.outputJson} />
                      {step.outputJson && !getNativeToolResult(step.outputJson) && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">步骤输出</summary>
                          <pre className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{formatJson(step.outputJson)}</pre>
                        </details>
                      )}
                      {step.inputJson && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">步骤输入</summary>
                          <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 whitespace-pre-wrap">{formatJson(step.inputJson)}</pre>
                        </details>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!!detail.events?.length && (
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">执行事件</summary>
                <div className="mt-2 space-y-1">
                  {detail.events.map(event => (
                    <div key={event.id} className="rounded border bg-muted/40 px-2 py-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{event.eventType}</span>
                        {event.stepId && <span className="text-muted-foreground">{event.stepId}</span>}
                        <span className="text-muted-foreground">{event.createdAt ? formatDate(event.createdAt) : '-'}</span>
                      </div>
                      {event.message && <div className="mt-0.5 text-muted-foreground">{event.message}</div>}
                    </div>
                  ))}
                </div>
              </details>
            )}
            {detail.inputJson && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">输入参数</summary><pre className="mt-2 p-2 bg-muted rounded text-xs max-h-40 overflow-auto">{formatJson(detail.inputJson)}</pre></details>}
            {detail.stepResults && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">步骤结果</summary><pre className="mt-2 p-2 bg-muted rounded text-xs max-h-60 overflow-auto">{formatJson(detail.stepResults)}</pre></details>}
            {detail.outputJson && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">输出结果</summary><pre className="mt-2 p-2 bg-muted rounded text-xs max-h-40 overflow-auto">{formatJson(detail.outputJson)}</pre></details>}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>关闭</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ==================== 主页面 ====================

export default function WorkflowPage() {
  const [tab, setTab] = useState<Tab>('list')

  // === 工作流列表状态 ===
  const [workflows, setWorkflows] = useState<WorkflowBriefVO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // === 对话框状态 ===
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingWf, setEditingWf] = useState<WorkflowVO | null>(null)
  const [execDetailId, setExecDetailId] = useState<number | null>(null)
  const [executingIds, setExecutingIds] = useState<Set<number>>(new Set())
  const [runningExecutions, setRunningExecutions] = useState<Map<number, number>>(new Map()) // executionId → workflowId

  // === AI 生成状态 ===
  const [genInput, setGenInput] = useState('')
  const [genStreaming, setGenStreaming] = useState(false)
  const [genResult, setGenResult] = useState('')
  const [genError, setGenError] = useState('')
  const genAbortRef = useRef<AbortController | null>(null)
  const [genDslForDialog, setGenDslForDialog] = useState('')  // AI 生成的 DSL 传递给对话框

  // === 执行历史状态 ===
  const [histWfId, setHistWfId] = useState<number | null>(null)
  const [executions, setExecutions] = useState<ExecutionBriefVO[]>([])
  const [histLoading, setHistLoading] = useState(false)
  const [histError, setHistError] = useState('')

  // === 可视化编辑状态 ===
  const [visualWfId, setVisualWfId] = useState<number | null>(null)
  const [visualDsl, setVisualDsl] = useState('')
  const [visualSaving, setVisualSaving] = useState(false)

  // ========== 数据加载 ==========
  const loadWorkflows = useCallback(async () => {
    setLoading(true)
    setError('')
    try { setWorkflows(await workflowApi.list()) }
    catch (e: any) { setError(e.message || '加载失败') }
    setLoading(false)
  }, [])

  useEffect(() => { loadWorkflows() }, [loadWorkflows])

  const loadExecutions = useCallback(async (wfId?: number | null) => {
    const id = wfId ?? histWfId
    if (!id) { setExecutions([]); return }
    setHistLoading(true)
    setHistError('')
    try { setExecutions(await workflowApi.listExecutions(id)) }
    catch (e: any) { setHistError(e.message || '加载失败'); setExecutions([]) }
    setHistLoading(false)
  }, [histWfId])

  useEffect(() => { loadExecutions() }, [loadExecutions])

  // === 恢复离开页面时仍在执行的任务 ===
  // 页面挂载时查询当前用户所有 running 的执行记录，
  // 即使离开了页面、关闭浏览器再回来，也能看到这些任务在跑
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const running = await workflowApi.listRunningExecutions()
        if (cancelled) return
        if (running.length === 0) return
        // 把这些正在执行的任务记到 runningExecutions Map 里
        setRunningExecutions((prev) => {
          const next = new Map(prev)
          running.forEach((e) => next.set(e.id, e.workflowId))
          return next
        })
        // 自动切到第一个 running 任务对应的工作流历史
        setHistWfId(running[0].workflowId)
        setTab('history')
      } catch {
        // 忽略错误：用户可能没登录或 token 过期
      }
    })()
    return () => { cancelled = true }
  }, [])

  // === 全局轮询：监测所有正在执行的任务（不依赖当前选中的工作流）===
  // 即使用户切到其他 Tab（列表/可视化），只要有 running 任务就继续轮询。
  // 这样关闭再回来、跨页面切换都能看到实时进度。
  useEffect(() => {
    if (runningExecutions.size === 0) return
    const timer = setInterval(async () => {
      try {
        const running = await workflowApi.listRunningExecutions()
        if (running.length === 0) {
          // 全部跑完了，清空状态
          setRunningExecutions(new Map())
          // 刷新当前历史 Tab
          if (histWfId) loadExecutions()
          return
        }
        // 同步正在执行的任务（可能有新触发的）
        setRunningExecutions((prev) => {
          const next = new Map<number, number>()
          running.forEach((e) => next.set(e.id, e.workflowId))
          return next
        })
        // 刷新当前 Tab 的历史
        if (histWfId) loadExecutions()
      } catch {
        // 轮询失败忽略
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [runningExecutions, histWfId, loadExecutions])

  // ========== 操作处理 ==========
  const handleToggleStatus = async (wf: WorkflowBriefVO) => {
    try {
      await workflowApi.updateStatus(wf.id, wf.status === 'active' ? 'paused' : 'active')
      loadWorkflows()
    } catch (e: any) { alert(e.message) }
  }

  const handleDelete = async (wf: WorkflowBriefVO) => {
    if (!confirm(`确定删除「${wf.name}」？`)) return
    try { await workflowApi.delete(wf.id); loadWorkflows() }
    catch (e: any) { alert(e.message) }
  }

  const handleEdit = async (wf: WorkflowBriefVO) => {
    try {
      setEditingWf(await workflowApi.detail(wf.id))
      setDialogOpen(true)
    } catch (e: any) { alert(e.message) }
  }

  const handleExecute = async (wf: WorkflowBriefVO) => {
    setExecutingIds((prev) => new Set(prev).add(wf.id))
    try {
      const result = await workflowApi.execute(wf.id)
      // 记录正在执行的 execution
      setRunningExecutions((prev) => new Map(prev).set(result.id, wf.id))
      setHistWfId(wf.id)
      setTab('history')
      setExecDetailId(result.id)
    } catch (e: any) { alert(e.message) }
    setExecutingIds((prev) => { const n = new Set(prev); n.delete(wf.id); return n })
  }

  const handleStopExecution = async (executionId: number) => {
    try {
      await workflowApi.stopExecution(executionId)
      setRunningExecutions((prev) => { const n = new Map(prev); n.delete(executionId); return n })
      // 刷新执行历史
      if (histWfId) loadExecutions()
    } catch (e: any) { alert(e.message) }
  }

  // ========== AI 生成 ==========
  const handleGenerate = () => {
    if (!genInput.trim() || genStreaming) return
    setGenStreaming(true)
    setGenResult('')
    setGenError('')
    genAbortRef.current = workflowApi.generateDsl(
      genInput.trim(),
      (t) => setGenResult((p) => p + t),
      (dsl) => { setGenResult(dsl); setGenStreaming(false) },
      (err) => { setGenError(err); setGenStreaming(false) },
    )
  }

  const handleCancelGen = () => { genAbortRef.current?.abort(); setGenStreaming(false) }

  const handleUseGenDsl = () => {
    setEditingWf(null)
    setGenDslForDialog(genResult)
    setDialogOpen(true)
  }

  const switchToTab = (t: Tab) => {
    setTab(t)
    if (t === 'history' && histWfId) loadExecutions(histWfId)
  }

  // ========== 可视化编辑 ==========
  const openVisualEditor = async (wf: WorkflowBriefVO) => {
    try {
      const detail = await workflowApi.detail(wf.id)
      setVisualWfId(detail.id)
      setVisualDsl(detail.dsl || '')
      setTab('visual')
    } catch (e: any) {
      alert(e.message)
    }
  }

  const handleSaveVisual = async () => {
    if (!visualWfId || !visualDsl) return
    setVisualSaving(true)
    try {
      await workflowApi.update(visualWfId, { dsl: visualDsl })
      loadWorkflows()
      // 显示短暂成功提示
      setVisualSaving(false)
    } catch (e: any) {
      alert(e.message)
      setVisualSaving(false)
    }
  }

  // ========== 渲染 ==========
  return (
    <div className="flex flex-col h-full bg-background">
      {/* Header */}
      <div className="shrink-0 border-b px-4 sm:px-6 pt-3 sm:pt-4 pb-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-lg sm:text-xl font-bold">工作流引擎</h1>
            <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 hidden sm:block">用自然语言定义自动化工作流，支持定时触发与手动执行</p>
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 mt-4">
          {([
            { id: 'list' as Tab, label: '我的工作流', icon: <Workflow className="w-4 h-4" /> },
            { id: 'generate' as Tab, label: 'AI 生成', icon: <Sparkles className="w-4 h-4" /> },
            { id: 'visual' as Tab, label: '可视化编辑', icon: <GitBranch className="w-4 h-4" /> },
            { id: 'history' as Tab, label: '执行历史', icon: <History className="w-4 h-4" /> },
          ]).map((t) => (
            <button
              key={t.id}
              onClick={() => switchToTab(t.id)}
              className={cn(
                'flex items-center gap-1.5 px-2.5 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors',
                tab === t.id
                  ? 'bg-background text-foreground border border-b-background -mb-px relative z-10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
              )}
            >
              {t.icon}<span className="hidden sm:inline">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="mobile-scroll-bottom-safe flex-1 overflow-auto">
        {/* === 工作流列表 Tab === */}
        {tab === 'list' && (
          <div className="p-4 sm:p-6 space-y-4">
            {loading ? (
              <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>
            ) : error ? (
              <div className="flex flex-col items-center py-16 gap-2">
                <AlertCircle className="w-8 h-8 text-red-400" />
                <p className="text-red-500 text-sm">{error}</p>
                <Button variant="outline" size="sm" onClick={loadWorkflows}><RefreshCw className="w-3.5 h-3.5 mr-1" />重试</Button>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between">
                  <div><h2 className="text-lg font-semibold">工作流列表</h2><p className="text-sm text-muted-foreground">共 {workflows.length} 个</p></div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={loadWorkflows}><RefreshCw className="w-3.5 h-3.5 mr-1" />刷新</Button>
                    <Button size="sm" onClick={() => { setEditingWf(null); setDialogOpen(true) }}>
                      <Plus className="w-4 h-4 mr-1" />新建工作流
                    </Button>
                  </div>
                </div>

                {workflows.length === 0 ? (
                  <Card className="border-dashed">
                    <CardContent className="flex flex-col items-center py-16 gap-3">
                      <Workflow className="w-12 h-12 text-muted-foreground/40" />
                      <p className="text-muted-foreground">还没有工作流</p>
                      <div className="flex gap-2 mt-2">
                        <Button variant="outline" onClick={() => { setEditingWf(null); setDialogOpen(true) }}><Plus className="w-4 h-4 mr-1" />新建</Button>
                        <Button variant="outline" onClick={() => setTab('generate')}><Sparkles className="w-4 h-4 mr-1" />AI 生成</Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <div className="space-y-3">
                    {workflows.map((wf) => {
                      const sc = STATUS_CONFIG[wf.status] || { label: wf.status, color: 'bg-gray-100', icon: null }
                      return (
                        <Card key={wf.id} className="hover:shadow-sm transition-shadow">
                          <CardContent className="p-4">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                  <h3 className="font-medium truncate">{wf.name}</h3>
                                  <Badge className={cn('text-xs gap-1 shrink-0', sc.color)}>{sc.icon}{sc.label}</Badge>
                                </div>
                                {wf.description && <p className="text-sm text-muted-foreground truncate mb-2">{wf.description}</p>}
                                <div className="flex items-center gap-3 text-xs text-muted-foreground">
                                  {wf.cronExpr && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{wf.cronExpr}</span>}
                                  {wf.lastRunAt && <span className="flex items-center gap-1"><Timer className="w-3 h-3" />上次: {formatDate(wf.lastRunAt)}</span>}
                                  <span>ID: {wf.id}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <Button variant="ghost" size="icon" onClick={() => handleToggleStatus(wf)} title={wf.status === 'active' ? '暂停' : '激活'}>
                                  {wf.status === 'active' ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                                </Button>
                                <Button variant="ghost" size="icon" onClick={() => handleExecute(wf)} disabled={executingIds.has(wf.id)} title="执行">
                                  {executingIds.has(wf.id) ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                                </Button>
                                <Button variant="ghost" size="icon" onClick={() => openVisualEditor(wf)} title="可视化编辑"><GitBranch className="w-4 h-4" /></Button>
                                <Button variant="ghost" size="icon" onClick={() => handleEdit(wf)} title="编辑"><Edit3 className="w-4 h-4" /></Button>
                                <Button variant="ghost" size="icon" onClick={() => handleDelete(wf)} title="删除"><Trash2 className="w-4 h-4 text-red-400" /></Button>
                                <Button variant="ghost" size="icon" onClick={() => { setHistWfId(wf.id); setTab('history') }} title="历史"><ChevronRight className="w-4 h-4" /></Button>
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* === AI 生成 Tab === */}
        {tab === 'generate' && (
          <div className="p-6 space-y-4">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2"><Sparkles className="w-5 h-5 text-purple-500" />AI 生成工作流 DSL</h2>
              <p className="text-sm text-muted-foreground mt-1">用自然语言描述自动化流程，AI 为你生成 DSL 定义</p>
            </div>
            <Card>
              <CardContent className="p-4 space-y-3">
                <Textarea
                  value={genInput}
                  onChange={(e) => setGenInput(e.target.value)}
                  placeholder="例如：每天早上 8 点检查新邮件，有未读则生成摘要并发送到企业微信"
                  rows={4}
                  disabled={genStreaming}
                />
                <div className="flex gap-2">
                  {genStreaming ? (
                    <Button variant="outline" onClick={handleCancelGen}><XCircle className="w-4 h-4 mr-1" />取消生成</Button>
                  ) : (
                    <Button onClick={handleGenerate} disabled={!genInput.trim()}><Sparkles className="w-4 h-4 mr-1" />生成 DSL</Button>
                  )}
                </div>
              </CardContent>
            </Card>

            {(genStreaming || genResult) && (
              <Card>
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    {genStreaming ? (
                      <><Loader2 className="w-4 h-4 animate-spin" /><h3 className="text-sm font-semibold">正在生成...</h3></>
                    ) : (
                      <><CheckCircle2 className="w-4 h-4 text-green-500" /><h3 className="text-sm font-semibold">生成完成</h3></>
                    )}
                    {!genStreaming && genResult && (
                      <Button size="sm" className="ml-auto" onClick={handleUseGenDsl}><Plus className="w-3.5 h-3.5 mr-1" />创建为工作流</Button>
                    )}
                  </div>
                  <pre className="p-3 bg-muted rounded text-xs font-mono whitespace-pre-wrap max-h-96 overflow-auto">
                    {formatJson(genResult) || (genStreaming ? '等待 AI 响应...' : '')}
                  </pre>
                </CardContent>
              </Card>
            )}

            {genError && (
              <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded flex gap-2">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <p className="text-sm text-red-600 dark:text-red-400">{genError}</p>
              </div>
            )}
          </div>
        )}

        {/* === 可视化编辑 Tab === */}
        {tab === 'visual' && (
          <div className="flex flex-col h-full">
            {/* 工作流选择器 + 操作栏 */}
            <div className="shrink-0 px-3 sm:px-5 py-2 sm:py-3 border-b flex items-center justify-between gap-2 flex-wrap bg-muted/20">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-semibold flex items-center gap-1.5">
                  <GitBranch className="w-4 h-4 text-purple-500" />
                  可视化节点编辑器
                </h2>
                <select
                  className="text-xs border rounded-md px-2 py-1.5 bg-background max-w-[200px]"
                  value={visualWfId || ''}
                  onChange={(e) => {
                    const id = e.target.value ? Number(e.target.value) : null
                    if (id) {
                      workflowApi.detail(id).then((detail) => {
                        setVisualWfId(detail.id)
                        setVisualDsl(detail.dsl || '')
                      }).catch((e: any) => alert(e.message))
                    } else {
                      setVisualWfId(null)
                      setVisualDsl('')
                    }
                  }}
                >
                  <option value="">— 选择工作流 —</option>
                  {workflows.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} {w.status === 'active' ? '(运行中)' : ''}
                    </option>
                  ))}
                </select>
                {visualWfId && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-7"
                    onClick={handleSaveVisual}
                    disabled={visualSaving}
                  >
                    {visualSaving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                    ) : (
                      <Save className="w-3.5 h-3.5 mr-1" />
                    )}
                    保存到后端
                  </Button>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                {visualWfId
                  ? '拖拽工具到画布，连接节点构建工作流'
                  : '选择一个工作流开始编辑'}
              </div>
            </div>

            {/* 画布区域 */}
            <div className="flex-1">
              {visualWfId ? (
                <WorkflowCanvas
                  key={visualWfId}
                  initialDsl={visualDsl}
                  onDslChange={setVisualDsl}
                />
              ) : (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-4">
                  <GitBranch className="w-16 h-16 opacity-20" />
                  <div className="text-center">
                    <p className="text-lg font-medium">可视化工作流编辑器</p>
                    <p className="text-sm mt-1">
                      在上方选择一个工作流，或先在「我的工作流」中创建
                    </p>
                  </div>
                  <Button variant="outline" onClick={() => setTab('list')}>
                    <Workflow className="w-4 h-4 mr-1" />
                    前往工作流列表
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* === 执行历史 Tab === */}
        {tab === 'history' && (
          <div className="p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold flex items-center gap-2"><History className="w-5 h-5" />执行历史</h2>
                <p className="text-sm text-muted-foreground mt-1">选择工作流查看执行记录</p>
              </div>
            </div>

            {/* 工作流选择器 */}
            <div className="flex gap-2 flex-wrap">
              <Button
                key="all"
                variant={!histWfId ? 'default' : 'outline'}
                size="sm"
                onClick={() => { setHistWfId(null); setExecutions([]) }}
              >
                全部
              </Button>
              {workflows.map((w) => (
                <Button
                  key={w.id}
                  variant={histWfId === w.id ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setHistWfId(w.id)}
                >
                  {w.name}
                </Button>
              ))}
            </div>

            {/* 执行列表 */}
            {histLoading ? (
              <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin" /></div>
            ) : histError ? (
              <div className="flex flex-col items-center py-12 gap-2"><AlertCircle className="w-8 h-8 text-red-400" /><p className="text-red-500 text-sm">{histError}</p></div>
            ) : executions.length === 0 ? (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center py-12 gap-3">
                  <History className="w-12 h-12 text-muted-foreground/40" />
                  <p className="text-muted-foreground">{histWfId ? '该工作流还没有执行记录' : '选择一个工作流查看历史'}</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {executions.map((ex) => {
                  const sc = STATUS_CONFIG[ex.status] || { label: ex.status, color: 'bg-gray-100', icon: null }
                  return (
                    <Card key={ex.id} className="hover:shadow-sm transition-shadow cursor-pointer" onClick={() => setExecDetailId(ex.id)}>
                      <CardContent className="p-3 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-3">
                          <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', sc.color)}>{sc.icon}</div>
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">#{ex.id}</span>
                              <Badge className={cn('text-xs gap-1', sc.color)}>{sc.icon}{sc.label}</Badge>
                              <Badge variant="outline" className="text-xs">{TRIGGER_LABELS[ex.triggerType] || ex.triggerType}</Badge>
                            </div>
                            <div className="flex gap-3 mt-1 text-xs text-muted-foreground">
                              <span>开始: {ex.startedAt ? formatDate(ex.startedAt) : '-'}</span>
                              {ex.durationMs != null && <span>耗时: {ex.durationMs}ms</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          {ex.status === 'running' && (
                            <Button variant="outline" size="sm" className="text-red-500 hover:text-red-600 hover:bg-red-50"
                              onClick={() => handleStopExecution(ex.id)}>
                              <StopCircle className="w-3.5 h-3.5 mr-1" />停止
                            </Button>
                          )}
                          <ChevronRight className="w-4 h-4 text-muted-foreground" />
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 全局对话框 */}
      <WorkflowFormDialog
        open={dialogOpen}
        onClose={() => { setDialogOpen(false); setGenDslForDialog('') }}
        onSaved={() => { setDialogOpen(false); loadWorkflows(); setGenDslForDialog('') }}
        initialData={editingWf}
        initialDsl={genDslForDialog}
      />
      <ExecutionDetailDialog
        open={!!execDetailId}
        onClose={() => setExecDetailId(null)}
        executionId={execDetailId}
        onTerminal={(execution) => {
          setRunningExecutions((prev) => {
            const next = new Map(prev)
            next.delete(execution.id)
            return next
          })
          if (histWfId === execution.workflowId) loadExecutions(execution.workflowId)
        }}
        onResumeCreated={(execution) => {
          setRunningExecutions((prev) => new Map(prev).set(execution.id, execution.workflowId))
          setHistWfId(execution.workflowId)
          setTab('history')
          setExecDetailId(execution.id)
          loadExecutions(execution.workflowId)
        }}
      />
    </div>
  )
}
