import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCheck2,
  GitPullRequest,
  Loader2,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from 'lucide-react'
import {
  harnessApi,
  type HarnessFailureVO,
  type HarnessOverviewVO,
  type HarnessPatchVO,
  type HarnessRecurringFailureVO,
  type HarnessRegressionCaseVO,
  type HarnessRegressionPreviewVO,
  type HarnessRegressionRunVO,
  type HarnessTraceVO,
  type HarnessVersionVO,
  type PageResult,
} from '@/lib/api'
import { useAuthStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

const SURFACES = [
  { value: 'all', label: '全部' },
  { value: 'chat', label: '普通对话' },
  { value: 'chat_agent', label: 'Agent 对话' },
  { value: 'chat_sync', label: '同步对话' },
  { value: 'autocode', label: '代码开发' },
]

const PAGE_SIZE = 20

const SURFACE_LABELS = Object.fromEntries(SURFACES.map(item => [item.value, item.label])) as Record<string, string>
const STATUS_LABELS: Record<string, string> = {
  active: '已启用',
  candidate: '候选版本',
  retired: '已归档',
  pending: '待开始',
  running: '运行中',
  passed: '已通过',
  failed: '失败',
  blocked: '阻塞',
  cancelled: '已取消',
  success: '成功',
  approved: '已批准',
  applied: '已应用',
  rejected: '已拒绝',
  resolved: '已解决',
  ignored: '已忽略',
  regression: '已加入回归',
  draft: '草稿',
  open: '待处理',
}
const FAILURE_TYPE_LABELS: Record<string, string> = {
  empty_output: '无输出',
  timeout: '超时',
  exception: '执行异常',
  invalid_json: 'JSON 格式错误',
  tool_error: '工具调用失败',
  low_quality: '质量偏低',
  missing_steps: '步骤缺失',
  security_violation: '安全风险',
  policy_violation: '策略违规',
  regression: '回归失败',
  unknown: '未知问题',
}
const PATCH_TARGET_LABELS: Record<string, string> = {
  prompt: '提示词',
  tool: '工具链',
  workflow: '工作流',
  autocode: '代码开发',
  policy: '策略',
}
const VERSION_DESCRIPTION_LABELS: Record<string, string> = {
  'Default chat harness trace contract': '普通对话默认采集契约',
  'Default agent chat harness trace contract': 'Agent 对话默认采集契约',
  'Synchronous chat fallback harness trace contract': '同步对话兜底采集契约',
  'Default AutoCode task harness trace contract': '代码开发任务默认采集契约',
}

type RegressionCaseResult = {
  caseId?: number | string
  surface?: string
  failureType?: string
  status?: string
  summary?: string
  evidence?: unknown
}

function emptyPage<T>(): PageResult<T> {
  return { list: [], total: 0, page: 1, size: PAGE_SIZE }
}

function appendPage<T>(current: PageResult<T>, next: PageResult<T>): PageResult<T> {
  return { ...next, list: [...current.list, ...next.list] }
}

function hasMore<T>(page: PageResult<T>) {
  return page.list.length < page.total
}

function fmtDate(value?: string) {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function safeJson<T = unknown>(raw?: string, fallback?: T): T | undefined {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

function statusClass(status?: string) {
  if (['success', 'approved', 'applied', 'resolved', 'active', 'passed'].includes(status || '')) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700'
  }
  if (['failed', 'rejected'].includes(status || '')) return 'border-rose-200 bg-rose-50 text-rose-700'
  if (status === 'running') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (['regression', 'candidate'].includes(status || '')) return 'border-indigo-200 bg-indigo-50 text-indigo-700'
  return 'border-amber-200 bg-amber-50 text-amber-700'
}

function surfaceLabel(value?: string) {
  return value ? (SURFACE_LABELS[value] || value) : '-'
}

function statusLabel(value?: string) {
  return value ? (STATUS_LABELS[value] || value) : '-'
}

function failureTypeLabel(value?: string) {
  return value ? (FAILURE_TYPE_LABELS[value] || value) : '-'
}

function patchTargetLabel(value?: string) {
  return value ? (PATCH_TARGET_LABELS[value] || value) : '-'
}

function versionTitle(version: HarnessVersionVO) {
  const suffix = version.version?.match(/v\d+$/i)?.[0]?.toUpperCase()
  return `${surfaceLabel(version.surface)}采集契约${suffix ? ` ${suffix}` : ''}`
}

function versionDescription(version: HarnessVersionVO) {
  return VERSION_DESCRIPTION_LABELS[version.description || ''] ||
    VERSION_DESCRIPTION_LABELS[version.name || ''] ||
    version.description ||
    version.name ||
    '-'
}

function regressionCaseResults(run?: HarnessRegressionRunVO | null): RegressionCaseResult[] {
  const parsed = safeJson<Record<string, unknown>>(run?.resultJson, {})
  const caseResults = parsed?.caseResults
  return Array.isArray(caseResults) ? (caseResults as RegressionCaseResult[]) : []
}

function resultCount(results: RegressionCaseResult[], status: string) {
  return results.filter(item => item.status === status).length
}

function StatBlock({ icon: Icon, label, value, hint }: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string | number
  hint?: string
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="mt-1 truncate text-2xl font-semibold tracking-normal">{value}</p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SectionTitle({ title, count, action }: { title: string; count?: number; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold">{title}</h3>
        {typeof count === 'number' && <Badge variant="outline">{count}</Badge>}
      </div>
      {action}
    </div>
  )
}

function JsonBlock({ title, value }: { title: string; value?: string }) {
  const parsed = safeJson(value, value || '')
  const text = typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{title}</p>
      <pre className="max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs leading-relaxed">{text || '-'}</pre>
    </div>
  )
}

function TraceRow({ trace, onOpen }: { trace: HarnessTraceVO; onOpen: (trace: HarnessTraceVO) => void }) {
  const quality = safeJson<Record<string, unknown>>(trace.qualityJson, {})
  return (
    <tr className="cursor-pointer border-b last:border-b-0 hover:bg-muted/40" onClick={() => onOpen(trace)}>
      <td className="px-3 py-3 align-top">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{surfaceLabel(trace.surface)}</Badge>
          <Badge variant="outline" className={cn('border', statusClass(trace.status))}>{statusLabel(trace.status)}</Badge>
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <div className="max-w-[30rem]">
          <p className="truncate text-sm font-medium">{trace.taskId || trace.conversationUuid || trace.traceUuid || `#${trace.id}`}</p>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{trace.inputSummary || trace.errorMsg || trace.outputSummary || '-'}</p>
        </div>
      </td>
      <td className="px-3 py-3 align-top text-sm">{trace.model || '-'}</td>
      <td className="px-3 py-3 align-top text-sm">{trace.provider || '-'}</td>
      <td className="px-3 py-3 align-top text-sm">{trace.latencyMs || 0}ms</td>
      <td className="px-3 py-3 align-top text-sm">{(trace.inputTokens || 0) + (trace.outputTokens || 0)}</td>
      <td className="px-3 py-3 align-top text-sm">{quality?.hasOutput === false ? '无输出' : failureTypeLabel(trace.failureType)}</td>
      <td className="px-3 py-3 align-top text-xs text-muted-foreground">{fmtDate(trace.createdAt)}</td>
    </tr>
  )
}

export default function HarnessEvolutionTab() {
  const { user, permissions } = useAuthStore()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  const hasPerm = (code: string) => (
    (isAdmin && permissions.length === 0) ||
    permissions.includes(code) ||
    permissions.includes(`PERM_${code}`)
  )
  const canView = hasPerm('harness:view')
  const canPatch = hasPerm('harness:patch')
  const canRegression = hasPerm('harness:regression')

  const [surface, setSurface] = useState('all')
  const [overview, setOverview] = useState<HarnessOverviewVO | null>(null)
  const [versions, setVersions] = useState<HarnessVersionVO[]>([])
  const [traces, setTraces] = useState<PageResult<HarnessTraceVO>>(emptyPage)
  const [failures, setFailures] = useState<PageResult<HarnessFailureVO>>(emptyPage)
  const [patches, setPatches] = useState<PageResult<HarnessPatchVO>>(emptyPage)
  const [regressionCases, setRegressionCases] = useState<HarnessRegressionCaseVO[]>([])
  const [recurringFailures, setRecurringFailures] = useState<HarnessRecurringFailureVO[]>([])
  const [regressionPreview, setRegressionPreview] = useState<HarnessRegressionPreviewVO | null>(null)
  const [regressionRuns, setRegressionRuns] = useState<HarnessRegressionRunVO[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState<'traces' | 'failures' | 'patches' | null>(null)
  const [workingId, setWorkingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [selectedTrace, setSelectedTrace] = useState<HarnessTraceVO | null>(null)
  const [traceLoading, setTraceLoading] = useState(false)
  const [selectedRun, setSelectedRun] = useState<HarnessRegressionRunVO | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [runStatusDraft, setRunStatusDraft] = useState<'passed' | 'failed' | 'blocked' | 'cancelled'>('passed')
  const [runSummaryDraft, setRunSummaryDraft] = useState('')
  const [runCaseResultsDraft, setRunCaseResultsDraft] = useState('[]')
  const [runDraftError, setRunDraftError] = useState('')

  const failureTypes = useMemo(() => Object.entries(overview?.byFailureType || {})
    .sort((a, b) => b[1] - a[1]), [overview])

  const activeVersions = useMemo(() => versions.filter(v => v.status === 'active'), [versions])

  const hasPassedRegressionRun = (version: HarnessVersionVO) => regressionRuns.some(run =>
    run.versionId === version.id &&
    run.status === 'passed' &&
    (run.totalCases || 0) > 0 &&
    (run.failedCases || 0) === 0 &&
    (run.blockedCases || 0) === 0
  )

  const needsRegressionBeforeActivation = (version: HarnessVersionVO) =>
    version.status === 'candidate' && regressionCases.length > 0 && !hasPassedRegressionRun(version)

  const load = async () => {
    if (!canView) return
    setLoading(true)
    setError('')
    try {
      const [summary, versionList, tracePage, failurePage, patchPage, regression, recurring, preview, runs] = await Promise.all([
        harnessApi.overview(surface, 120),
        harnessApi.versions(surface, 80),
        harnessApi.tracePage(surface, 1, PAGE_SIZE),
        harnessApi.failurePage(surface, 1, PAGE_SIZE),
        harnessApi.patchPage(surface, 1, PAGE_SIZE),
        harnessApi.regressionCases(surface, 80),
        harnessApi.recurringFailures({ surface, minCount: 2, limit: 20 }),
        harnessApi.regressionPreview({ surface, limit: 80 }),
        harnessApi.regressionRuns(surface, 30),
      ])
      setOverview(summary)
      setVersions(versionList)
      setTraces(tracePage)
      setFailures(failurePage)
      setPatches(patchPage)
      setRegressionCases(regression)
      setRecurringFailures(recurring)
      setRegressionPreview(preview)
      setRegressionRuns(runs)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载 Harness 数据失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [surface, canView])

  useEffect(() => {
    if (!selectedRun) return
    const existing = regressionCaseResults(selectedRun)
    setRunStatusDraft(
      ['passed', 'failed', 'blocked', 'cancelled'].includes(selectedRun.status)
        ? (selectedRun.status as 'passed' | 'failed' | 'blocked' | 'cancelled')
        : 'passed'
    )
    setRunSummaryDraft(selectedRun.summary || '')
    setRunCaseResultsDraft(JSON.stringify(existing, null, 2))
    setRunDraftError('')
  }, [selectedRun])

  const loadMore = async (kind: 'traces' | 'failures' | 'patches') => {
    setLoadingMore(kind)
    try {
      if (kind === 'traces') {
        const next = await harnessApi.tracePage(surface, traces.page + 1, PAGE_SIZE)
        setTraces(prev => appendPage(prev, next))
      }
      if (kind === 'failures') {
        const next = await harnessApi.failurePage(surface, failures.page + 1, PAGE_SIZE)
        setFailures(prev => appendPage(prev, next))
      }
      if (kind === 'patches') {
        const next = await harnessApi.patchPage(surface, patches.page + 1, PAGE_SIZE)
        setPatches(prev => appendPage(prev, next))
      }
    } finally {
      setLoadingMore(null)
    }
  }

  const runAction = async (key: string, action: () => Promise<unknown>) => {
    setWorkingId(key)
    try {
      await action()
      await load()
    } finally {
      setWorkingId(null)
    }
  }

  const generatePatch = (failureType: string) => {
    if (!canPatch) return
    runAction(`generate:${failureType}`, () => harnessApi.generatePatch({
      surface: surface === 'all' ? undefined : surface,
      failureType,
    }))
  }

  const promoteRecurringFailures = () => {
    if (!canPatch) return
    runAction('promote-recurring', () => harnessApi.autoGeneratePatches({
      surface: surface === 'all' ? undefined : surface,
      minCount: 2,
      limit: 20,
    }))
  }

  const updatePatchStatus = (patch: HarnessPatchVO, status: 'approved' | 'rejected' | 'applied') => {
    if (!canPatch) return
    runAction(`patch:${patch.id}:${status}`, () => harnessApi.updatePatchStatus(patch.id, status))
  }

  const createVersionFromPatch = (patch: HarnessPatchVO) => {
    if (!canPatch) return
    runAction(`version-from-patch:${patch.id}`, () => harnessApi.createVersionFromPatch(patch.id))
  }

  const activateVersion = (version: HarnessVersionVO) => {
    if (!canPatch) return
    runAction(`activate-version:${version.id}`, () => harnessApi.activateVersion(version.id))
  }

  const updateFailureStatus = (failure: HarnessFailureVO, status: 'resolved' | 'ignored' | 'regression') => {
    if (status === 'regression' && !canRegression) return
    if (status !== 'regression' && !canPatch) return
    runAction(`failure:${failure.id}:${status}`, () => harnessApi.updateFailureStatus(failure.id, status))
  }

  const createRegressionRun = (version?: HarnessVersionVO) => {
    if (!canRegression) return
    runAction(`create-regression:${version?.id || surface}`, () => harnessApi.createRegressionRun({
      surface: surface === 'all' ? undefined : surface,
      versionId: version?.id,
    }))
  }

  const startRegressionRun = (run: HarnessRegressionRunVO) => {
    if (!canRegression) return
    runAction(`start-regression:${run.id}`, () => harnessApi.startRegressionRun(run.id))
  }

  const runRegressionPreflight = (run: HarnessRegressionRunVO) => {
    if (!canRegression) return
    runAction(`preflight-regression:${run.id}`, () => harnessApi.runRegressionPreflight(run.id))
  }

  const completeRegressionRun = (run: HarnessRegressionRunVO, status: 'passed' | 'failed' | 'blocked' | 'cancelled') => {
    if (!canRegression) return
    const total = run.totalCases || 0
    runAction(`complete-regression:${run.id}:${status}`, () => harnessApi.completeRegressionRun(run.id, {
      status,
      totalCases: total,
      passedCases: status === 'passed' ? total : 0,
      failedCases: status === 'failed' ? Math.max(1, total) : 0,
      blockedCases: status === 'blocked' ? Math.max(1, total) : 0,
      summary: `Manual regression result: ${status}`,
      runMode: 'manual',
    }))
  }

  const openRegressionRun = async (run: HarnessRegressionRunVO) => {
    setSelectedRun(run)
    setRunLoading(true)
    try {
      setSelectedRun(await harnessApi.regressionRun(run.id))
    } finally {
      setRunLoading(false)
    }
  }

  const seedSelectedRunCaseResults = () => {
    if (!selectedRun) return
    const cases = regressionCases
      .filter(item => selectedRun.surface === 'all' || item.surface === selectedRun.surface)
      .map(item => ({
        caseId: item.id,
        surface: item.surface,
        failureType: item.failureType,
        status: 'passed',
        summary: item.expected || item.input || '',
        evidence: {
          input: item.input,
          expected: item.expected,
          avoid: item.avoid,
        },
      }))
    setRunCaseResultsDraft(JSON.stringify(cases, null, 2))
    setRunDraftError('')
  }

  const submitSelectedRunResult = async () => {
    if (!selectedRun || !canRegression) return
    let caseResults: RegressionCaseResult[]
    try {
      const parsed = JSON.parse(runCaseResultsDraft || '[]')
      if (!Array.isArray(parsed)) throw new Error('caseResults 必须是数组')
      caseResults = parsed as RegressionCaseResult[]
    } catch (e) {
      setRunDraftError(e instanceof Error ? e.message : 'JSON 格式错误')
      return
    }

    setRunDraftError('')
    setWorkingId(`complete-regression:${selectedRun.id}:structured`)
    try {
      const totalCases = caseResults.length
      const updated = await harnessApi.completeRegressionRun(selectedRun.id, {
        status: runStatusDraft,
        totalCases,
        passedCases: resultCount(caseResults, 'passed'),
        failedCases: resultCount(caseResults, 'failed'),
        blockedCases: resultCount(caseResults, 'blocked'),
        summary: runSummaryDraft || `Manual regression result: ${runStatusDraft}`,
        runMode: 'manual_structured',
        caseResults,
      })
      setSelectedRun(updated)
      await load()
    } finally {
      setWorkingId(null)
    }
  }

  const openTrace = async (trace: HarnessTraceVO) => {
    setSelectedTrace(trace)
    setTraceLoading(true)
    try {
      setSelectedTrace(await harnessApi.trace(trace.id))
    } finally {
      setTraceLoading(false)
    }
  }

  const exportRegressionCases = () => {
    downloadJson(`harness-regression-${surface}-${new Date().toISOString().slice(0, 10)}.json`, regressionCases)
  }

  const exportRegressionRunBundle = async (run: HarnessRegressionRunVO) => {
    const bundle = await harnessApi.regressionRunBundle(run.id)
    downloadJson(`harness-run-${run.runUuid || run.id}.json`, bundle)
  }

  if (!canView) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <div className="rounded-lg border bg-background p-8 text-center">
          <ShieldAlert className="mx-auto h-8 w-8 text-muted-foreground" />
          <h2 className="mt-3 text-lg font-semibold">没有 Harness 演进权限</h2>
          <p className="mt-2 text-sm text-muted-foreground">需要 harness:view 权限后才能查看此页面。</p>
        </div>
      </div>
    )
  }

  const summary = overview?.summary
  const successRate = summary && summary.totalTraces > 0
    ? Math.round((summary.successCount / summary.totalTraces) * 100)
    : 0

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain p-4 pb-24 md:p-6 md:pb-6">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Harness 演进</h2>
          <p className="text-sm text-muted-foreground">用真实 Trace、失败样本和回归证据推动提示词、工具链和代码开发流程迭代。</p>
        </div>
        <div className="flex gap-2">
          <Select value={surface} onValueChange={setSurface}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SURFACES.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1.5 h-4 w-4" />}
            刷新
          </Button>
        </div>
      </div>

      <div className="mb-5 rounded-lg border bg-muted/25 p-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <p className="text-sm font-medium">1. 自动采集</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">对话、Agent 对话、同步对话和代码开发执行后，后端会自动记录 Trace、模型、耗时、输入输出摘要与质量信号。</p>
          </div>
          <div>
            <p className="text-sm font-medium">2. 发现问题</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">失败 Trace 会沉淀为失败样本；高频失败可一键生成候选改进，用来优化提示词、工具链或流程契约。</p>
          </div>
          <div>
            <p className="text-sm font-medium">3. 回归验证</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">候选版本激活前先创建回归运行，记录每个 case 的通过、失败、阻塞证据，避免修一个问题又引入新问题。</p>
          </div>
          <div>
            <p className="text-sm font-medium">4. 激活版本</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">回归通过后再激活新 Harness 版本，让平台按新的采集和评估契约持续演进。</p>
          </div>
        </div>
      </div>

      {error && <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <StatBlock icon={Activity} label="Trace 总数" value={summary?.totalTraces ?? 0} hint={`成功率 ${successRate}%`} />
        <StatBlock icon={CheckCircle2} label="成功" value={summary?.successCount ?? 0} />
        <StatBlock icon={XCircle} label="失败" value={summary?.failedCount ?? 0} />
        <StatBlock icon={Clock} label="平均延迟" value={`${summary?.avgLatencyMs ?? 0}ms`} />
        <StatBlock icon={GitPullRequest} label="候选改进" value={summary?.draftPatches ?? 0} />
        <StatBlock icon={FileCheck2} label="回归样本" value={regressionCases.length} hint={`激活版本 ${activeVersions.length}`} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="rounded-lg border bg-background p-4">
          <SectionTitle title="Harness 版本" count={versions.length} />
          <div className="space-y-2">
            {versions.map(version => (
              <div key={version.id} className="rounded-md border p-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{surfaceLabel(version.surface)}</Badge>
                      <Badge variant="outline" className={cn('border', statusClass(version.status))}>{statusLabel(version.status)}</Badge>
                    </div>
                    <p className="mt-2 truncate text-sm font-medium">{versionTitle(version)}</p>
                    <p className="mt-1 text-xs text-muted-foreground">技术标识：{version.version || version.name || '-'}</p>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{versionDescription(version)}</p>
                    {needsRegressionBeforeActivation(version) && (
                      <p className="mt-2 text-xs text-amber-700">此候选版本需要先通过回归运行，才能激活。</p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => createRegressionRun(version)}
                      disabled={!canRegression || workingId === `create-regression:${version.id}`}
                    >
                      {workingId === `create-regression:${version.id}` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      回归
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => activateVersion(version)}
                      disabled={!canPatch || version.status === 'active' || needsRegressionBeforeActivation(version) || workingId === `activate-version:${version.id}`}
                    >
                      {workingId === `activate-version:${version.id}` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      激活
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {versions.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无版本</p>}
          </div>

          <div className="mt-5 border-t pt-4">
            <SectionTitle
              title="回归样本"
              count={regressionPreview?.caseCount ?? 0}
              action={
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => createRegressionRun()} disabled={!canRegression || regressionCases.length === 0 || !!workingId?.startsWith('create-regression')}>
                    {workingId?.startsWith('create-regression') && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                    创建运行
                  </Button>
                  <Button variant="outline" size="sm" onClick={exportRegressionCases} disabled={regressionCases.length === 0}>导出样本</Button>
                </div>
              }
            />
            <div className="rounded-md bg-muted/40 p-3 text-sm">
              <div className="flex flex-wrap gap-3 text-muted-foreground">
                <span>范围: {surfaceLabel(regressionPreview?.surface || surface)}</span>
                <span>样本数: {regressionPreview?.caseCount ?? 0}</span>
                <span>失败类型: {Object.keys(regressionPreview?.byFailureType || {}).length}</span>
              </div>
              <div className="mt-3 space-y-2">
                {(regressionPreview?.checklist || []).slice(0, 6).map(item => (
                  <div key={item.caseId} className="rounded-md bg-background px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{surfaceLabel(item.surface)}</Badge>
                      <span className="text-xs font-medium">{failureTypeLabel(item.failureType)}</span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.input || item.expected || '-'}</p>
                  </div>
                ))}
                {!regressionPreview?.checklist?.length && <p className="py-4 text-center text-sm text-muted-foreground">暂无可回归样本</p>}
              </div>
            </div>
          </div>

          <div className="mt-5 border-t pt-4">
            <SectionTitle title="回归运行" count={regressionRuns.length} />
            <div className="space-y-2">
              {regressionRuns.map(run => {
                const editable = run.status === 'pending' || run.status === 'running'
                const caseResults = regressionCaseResults(run)
                return (
                  <div key={run.id} className="rounded-md border p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{surfaceLabel(run.surface)}</Badge>
                          <Badge variant="outline" className={cn('border', statusClass(run.status))}>{statusLabel(run.status)}</Badge>
                          {run.version && <Badge variant="outline">{run.version}</Badge>}
                        </div>
                        <p className="mt-2 text-sm">
                          共 {run.totalCases || 0} 个，过 {run.passedCases || 0}，失败 {run.failedCases || 0}，阻塞 {run.blockedCases || 0}
                        </p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{run.summary || '-'}</p>
                        {caseResults.length > 0 && (
                          <p className="mt-1 text-xs text-muted-foreground">已记录 {caseResults.length} 条结构化 case 证据</p>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">{fmtDate(run.createdAt)}</p>
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
                        <Button size="sm" variant="outline" onClick={() => openRegressionRun(run)}>查看结果</Button>
                        <Button size="sm" variant="outline" onClick={() => exportRegressionRunBundle(run)}>导出</Button>
                        <Button size="sm" variant="outline" onClick={() => startRegressionRun(run)} disabled={!canRegression || run.status !== 'pending' || workingId === `start-regression:${run.id}`}>
                          {workingId === `start-regression:${run.id}` ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <PlayCircle className="mr-1.5 h-4 w-4" />}
                          开始
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => runRegressionPreflight(run)} disabled={!canRegression || !editable || workingId === `preflight-regression:${run.id}`}>
                          {workingId === `preflight-regression:${run.id}` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                          预检
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => completeRegressionRun(run, 'passed')} disabled={!canRegression || !editable}>通过</Button>
                        <Button size="sm" variant="outline" onClick={() => completeRegressionRun(run, 'failed')} disabled={!canRegression || !editable}>失败</Button>
                        <Button size="sm" variant="ghost" onClick={() => completeRegressionRun(run, 'blocked')} disabled={!canRegression || !editable}>阻塞</Button>
                        <Button size="sm" variant="ghost" onClick={() => completeRegressionRun(run, 'cancelled')} disabled={!canRegression || !editable}>取消</Button>
                      </div>
                    </div>
                  </div>
                )
              })}
              {regressionRuns.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无回归运行</p>}
            </div>
          </div>
        </section>

        <section className="rounded-lg border bg-background p-4">
          <SectionTitle title="失败类型" count={failureTypes.length} />
          <div className="space-y-2">
            {failureTypes.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无失败类型</p>}
            {failureTypes.map(([type, count]) => (
              <div key={type} className="flex items-center justify-between gap-3 rounded-md bg-muted/50 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
                  <span className="truncate text-sm font-medium">{failureTypeLabel(type)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">{count}</span>
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => generatePatch(type)} disabled={!canPatch || workingId === `generate:${type}`}>
                    {workingId === `generate:${type}` && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    生成改进
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 border-t pt-4">
            <SectionTitle
              title="高频失败"
              count={recurringFailures.length}
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={promoteRecurringFailures}
                  disabled={!canPatch || recurringFailures.length === 0 || workingId === 'promote-recurring'}
                >
                  {workingId === 'promote-recurring' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  自动生成候选
                </Button>
              }
            />
            <div className="space-y-2">
              {recurringFailures.slice(0, 6).map(item => (
                <div key={`${item.surface}:${item.failureType}`} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{surfaceLabel(item.surface)}</Badge>
                    <Badge variant="outline" className="bg-muted/60">score {item.score}</Badge>
                    {item.hasPatch && <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700">已有改进</Badge>}
                    <span className="text-sm font-medium">{failureTypeLabel(item.failureType)}</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    共 {item.count} 次，未解决 {item.openCount}，回归 {item.regressionCount}，高危 {item.highSeverityCount}
                  </p>
                  {item.samples?.[0]?.summary && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.samples[0].summary}</p>
                  )}
                </div>
              ))}
              {recurringFailures.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无高频失败</p>}
            </div>
          </div>
        </section>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
        <section className="rounded-lg border bg-background p-4">
          <SectionTitle title="失败样本" count={failures.total} />
          <div className="space-y-2">
            {failures.list.map(failure => (
              <div key={failure.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{surfaceLabel(failure.surface)}</Badge>
                  <Badge variant="outline" className={cn('border', statusClass(failure.status))}>{statusLabel(failure.status)}</Badge>
                  <span className="text-sm font-medium">{failureTypeLabel(failure.failureType)}</span>
                </div>
                <p className="mt-2 line-clamp-3 text-sm text-muted-foreground">{failure.summary || '无摘要'}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => generatePatch(failure.failureType)} disabled={!canPatch}>生成改进</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => updateFailureStatus(failure, 'resolved')} disabled={!canPatch}>解决</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => updateFailureStatus(failure, 'regression')} disabled={!canRegression}>加入回归</Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => updateFailureStatus(failure, 'ignored')} disabled={!canPatch}>忽略</Button>
                </div>
              </div>
            ))}
            {failures.list.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">暂无失败样本</p>}
            {hasMore(failures) && (
              <Button variant="outline" className="w-full" onClick={() => loadMore('failures')} disabled={loadingMore === 'failures'}>
                {loadingMore === 'failures' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                加载更多失败样本
              </Button>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <SectionTitle title="候选改进" count={patches.total} />
          {patches.list.map(patch => {
            const detail = safeJson<{ recommendations?: string[]; sampleCount?: number }>(patch.patchJson, {})
            const canCreateVersion = patch.status === 'approved' || patch.status === 'applied'
            return (
              <div key={patch.id} className="rounded-lg border bg-background p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{surfaceLabel(patch.surface)}</Badge>
                      <Badge variant="outline">{patchTargetLabel(patch.targetType)}</Badge>
                      <Badge variant="outline" className={cn('border', statusClass(patch.status))}>{statusLabel(patch.status)}</Badge>
                    </div>
                    <h3 className="mt-2 font-semibold">{patch.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{patch.rationale}</p>
                    {detail?.recommendations && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {detail.recommendations.slice(0, 4).map(item => (
                          <span key={item} className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">{item}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2 md:justify-end">
                    <Button size="sm" variant="outline" onClick={() => updatePatchStatus(patch, 'approved')} disabled={!canPatch || patch.status === 'approved'}>批准</Button>
                    <Button size="sm" variant="outline" onClick={() => updatePatchStatus(patch, 'applied')} disabled={!canPatch || patch.status === 'applied'}>标记应用</Button>
                    <Button size="sm" variant="outline" onClick={() => createVersionFromPatch(patch)} disabled={!canPatch || !canCreateVersion || workingId === `version-from-patch:${patch.id}`}>
                      {workingId === `version-from-patch:${patch.id}` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                      生成版本
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => updatePatchStatus(patch, 'rejected')} disabled={!canPatch || patch.status === 'rejected'}>拒绝</Button>
                  </div>
                </div>
              </div>
            )
          })}
          {patches.list.length === 0 && <div className="rounded-lg border bg-background py-12 text-center text-sm text-muted-foreground">暂无候选改进</div>}
          {hasMore(patches) && (
            <Button variant="outline" className="w-full" onClick={() => loadMore('patches')} disabled={loadingMore === 'patches'}>
              {loadingMore === 'patches' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              加载更多候选改进
            </Button>
          )}
        </section>
      </div>

      <section className="mt-5 rounded-lg border bg-background">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="font-semibold">执行 Trace</h3>
          <Badge variant="outline">{traces.total}</Badge>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">状态</th>
                <th className="px-3 py-2 font-medium">目标</th>
                <th className="px-3 py-2 font-medium">模型</th>
                <th className="px-3 py-2 font-medium">供应商</th>
                <th className="px-3 py-2 font-medium">延迟</th>
                <th className="px-3 py-2 font-medium">Token</th>
                <th className="px-3 py-2 font-medium">失败类型</th>
                <th className="px-3 py-2 font-medium">时间</th>
              </tr>
            </thead>
            <tbody>
              {traces.list.map(trace => <TraceRow key={trace.id} trace={trace} onOpen={openTrace} />)}
              {traces.list.length === 0 && <tr><td colSpan={8} className="px-3 py-10 text-center text-sm text-muted-foreground">暂无 Trace</td></tr>}
            </tbody>
          </table>
        </div>
        {hasMore(traces) && (
          <div className="border-t p-3">
            <Button variant="outline" className="w-full" onClick={() => loadMore('traces')} disabled={loadingMore === 'traces'}>
              {loadingMore === 'traces' && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              加载更多 Trace
            </Button>
          </div>
        )}
      </section>

      <Dialog open={!!selectedTrace} onOpenChange={(open) => !open && setSelectedTrace(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Trace 详情</DialogTitle>
          </DialogHeader>
          {selectedTrace && (
            <div className="space-y-4">
              <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-3">
                <div><span className="text-muted-foreground">范围: </span>{surfaceLabel(selectedTrace.surface)}</div>
                <div><span className="text-muted-foreground">状态: </span>{statusLabel(selectedTrace.status)}</div>
                <div><span className="text-muted-foreground">模型: </span>{selectedTrace.model || '-'}</div>
                <div><span className="text-muted-foreground">供应商: </span>{selectedTrace.provider || '-'}</div>
                <div><span className="text-muted-foreground">延迟: </span>{selectedTrace.latencyMs || 0}ms</div>
                <div><span className="text-muted-foreground">时间: </span>{fmtDate(selectedTrace.createdAt)}</div>
              </div>
              {traceLoading && <div className="rounded-lg border p-4 text-sm text-muted-foreground">正在加载完整 Trace...</div>}
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">输入摘要</p>
                <p className="rounded-md bg-muted p-3 text-sm">{selectedTrace.inputSummary || '-'}</p>
              </div>
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">输出 / 错误</p>
                <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{selectedTrace.errorMsg || selectedTrace.outputSummary || '-'}</p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <JsonBlock title="Events" value={selectedTrace.eventsJson} />
                <JsonBlock title="Metrics" value={selectedTrace.metricsJson} />
                <JsonBlock title="Quality" value={selectedTrace.qualityJson} />
                <JsonBlock title="Request" value={(selectedTrace as HarnessTraceVO & { requestJson?: string }).requestJson} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!selectedRun} onOpenChange={(open) => !open && setSelectedRun(null)}>
        <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>回归运行详情</DialogTitle>
          </DialogHeader>
          {selectedRun && (
            <div className="space-y-4">
              {(() => {
                const result = safeJson<Record<string, unknown>>(selectedRun.resultJson, {}) || {}
                const caseResults = regressionCaseResults(selectedRun)
                return (
                  <>
                    <div className="grid gap-3 rounded-lg border bg-muted/30 p-3 text-sm md:grid-cols-3">
                      <div><span className="text-muted-foreground">范围: </span>{surfaceLabel(selectedRun.surface)}</div>
                      <div><span className="text-muted-foreground">状态: </span>{statusLabel(selectedRun.status)}</div>
                      <div><span className="text-muted-foreground">版本: </span>{selectedRun.version || '-'}</div>
                      <div><span className="text-muted-foreground">模式: </span>{String(result.runMode || '-')}</div>
                      <div><span className="text-muted-foreground">可激活: </span>{result.activationEligible === true ? '是' : '否'}</div>
                      <div><span className="text-muted-foreground">完成时间: </span>{fmtDate(selectedRun.completedAt || selectedRun.createdAt)}</div>
                    </div>
                    {runLoading && <div className="rounded-lg border p-4 text-sm text-muted-foreground">正在加载回归结果...</div>}
                    <div>
                      <p className="mb-1 text-xs font-medium text-muted-foreground">摘要</p>
                      <p className="whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{selectedRun.summary || '-'}</p>
                    </div>
                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-medium text-muted-foreground">Case 结果</p>
                        <Badge variant="outline">{caseResults.length}</Badge>
                      </div>
                      <div className="space-y-2">
                        {caseResults.map((item, idx) => (
                          <div key={`${item.caseId || idx}`} className="rounded-md border p-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">#{item.caseId || idx + 1}</Badge>
                              {item.surface && <Badge variant="outline">{surfaceLabel(item.surface)}</Badge>}
                              <Badge variant="outline" className={cn('border', statusClass(item.status))}>{statusLabel(item.status)}</Badge>
                              <span className="text-sm font-medium">{failureTypeLabel(item.failureType)}</span>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">{item.summary || '-'}</p>
                            {item.evidence !== undefined && (
                              <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(item.evidence, null, 2)}</pre>
                            )}
                          </div>
                        ))}
                        {caseResults.length === 0 && (
                          <p className="rounded-md border py-8 text-center text-sm text-muted-foreground">还没有结构化 case 结果，请运行预检、CI 或手动提交结果。</p>
                        )}
                      </div>
                    </div>
                    {canRegression && ['pending', 'running'].includes(selectedRun.status) && (
                      <div className="rounded-lg border bg-muted/20 p-3">
                        <div className="mb-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                          <div>
                            <p className="text-sm font-medium">填写本次回归执行结果</p>
                            <p className="text-xs text-muted-foreground">按 case 记录状态、摘要和证据；提交后会作为版本激活依据，并可沉淀为失败样本。</p>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" variant="outline" onClick={seedSelectedRunCaseResults}>从样本生成草稿</Button>
                            <Select value={runStatusDraft} onValueChange={(value) => setRunStatusDraft(value as typeof runStatusDraft)}>
                              <SelectTrigger className="h-8 w-28">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="passed">通过</SelectItem>
                                <SelectItem value="failed">失败</SelectItem>
                                <SelectItem value="blocked">阻塞</SelectItem>
                                <SelectItem value="cancelled">取消</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <textarea
                          value={runSummaryDraft}
                          onChange={e => setRunSummaryDraft(e.target.value)}
                          className="mb-2 min-h-16 w-full resize-y rounded-md border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-primary/30"
                          placeholder="本次回归运行摘要"
                        />
                        <textarea
                          value={runCaseResultsDraft}
                          onChange={e => setRunCaseResultsDraft(e.target.value)}
                          className="min-h-64 w-full resize-y rounded-md border bg-background p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-primary/30"
                          spellCheck={false}
                          placeholder='[{"caseId":1,"status":"passed","summary":"...","evidence":{}}]'
                        />
                        {runDraftError && <p className="mt-2 text-xs text-rose-600">{runDraftError}</p>}
                        <div className="mt-3 flex justify-end">
                          <Button onClick={submitSelectedRunResult} disabled={workingId === `complete-regression:${selectedRun.id}:structured`}>
                            {workingId === `complete-regression:${selectedRun.id}:structured` && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                            提交结构化结果
                          </Button>
                        </div>
                      </div>
                    )}
                    <JsonBlock title="完整 Result JSON" value={selectedRun.resultJson} />
                  </>
                )
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
