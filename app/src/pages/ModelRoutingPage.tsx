import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, BarChart3, Check, Edit3, Loader2, Plus, RefreshCw, Search, Shield, Trash2, X, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store'
import {
  routingApi,
  type RouteTestRequest,
  type RouteTestResult,
  type RoutingCandidate,
  type RoutingModelOption,
  type RoutingRule,
  type RoutingStats,
} from '@/lib/api'

type RuleScope = 'effective' | 'mine' | 'global' | 'all'

const SCENE_TYPES = ['*', 'chat', 'vision', 'code', 'image', 'agent']
const AGENT_TYPES = ['*', 'general', 'ledger', 'writing', 'data', 'code', 'frontend', 'backend', 'devops', 'researcher']
const COMPLEXITIES = ['*', 'simple', 'moderate', 'complex']
const FALLBACK_CAPABILITIES = ['text', 'tool', 'code', 'reasoning', 'vision', 'image', 'audio']

const LABELS: Record<string, string> = {
  '*': '通配',
  chat: '对话',
  vision: '视觉',
  code: '代码',
  image: '图像',
  agent: 'Agent',
  general: '通用',
  ledger: '台账',
  writing: '写作',
  data: '数据',
  frontend: '前端',
  backend: '后端',
  devops: '运维',
  researcher: '调研',
  simple: '简单',
  moderate: '中等',
  complex: '复杂',
}

function label(value?: string | null) {
  if (!value) return '-'
  return LABELS[value] || value
}

function parseList(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  } catch {
    // Fall back to comma-separated values.
  }
  return value.split(',').map(item => item.trim()).filter(Boolean)
}

function stringifyList(values: string[]) {
  return JSON.stringify(Array.from(new Set(values.filter(Boolean))))
}

function ruleScene(rule: Partial<RoutingRule>) {
  return rule.sceneType || rule.scene_type || '*'
}

function ruleAgent(rule: Partial<RoutingRule>) {
  return rule.agentType || rule.agent_type || '*'
}

function ruleRequiredCapabilities(rule: Partial<RoutingRule>) {
  return rule.requiredCapabilities || (rule as any).required_capabilities || '[]'
}

function rulePreferredProviders(rule: Partial<RoutingRule>) {
  return rule.preferredProviders || (rule as any).preferred_providers || '[]'
}

function ruleMinContext(rule: Partial<RoutingRule>) {
  return rule.minContextLength ?? (rule as any).min_context_length
}

function ruleMaxInputPrice(rule: Partial<RoutingRule>) {
  return rule.maxInputPrice ?? (rule as any).max_input_price
}

function ruleMaxOutputPrice(rule: Partial<RoutingRule>) {
  return rule.maxOutputPrice ?? (rule as any).max_output_price
}

function isEnabled(rule: Partial<RoutingRule>) {
  return rule.enabled === true || rule.enabled === 1 || rule.enabled == null
}

function isGlobalRule(rule: Partial<RoutingRule>) {
  return rule.userId == null && rule.user_id == null
}

function modelId(model: RoutingModelOption | RoutingCandidate | RouteTestResult) {
  return (model as any).modelId || (model as any).model_id || ''
}

function isAutoModelId(value?: string | null) {
  return !value || value.toLowerCase() === 'auto'
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b))
}

function modelMatchesRule(model: RoutingModelOption, rule: Partial<RoutingRule>) {
  if (isAutoModelId(modelId(model))) return false
  const caps = parseList(model.capabilities).map(item => item.toLowerCase())
  const required = parseList(ruleRequiredCapabilities(rule)).map(item => item.toLowerCase())
  if (!required.every(cap => caps.includes(cap))) return false
  const minContext = ruleMinContext(rule)
  const maxInput = ruleMaxInputPrice(rule)
  const maxOutput = ruleMaxOutputPrice(rule)
  if (minContext && model.context_length && model.context_length < minContext) return false
  if (maxInput != null && model.input_price != null && model.input_price > maxInput) return false
  if (maxOutput != null && model.output_price != null && model.output_price > maxOutput) return false
  return true
}

function scorePreviewModel(model: RoutingModelOption, rule: Partial<RoutingRule>) {
  const preferredProviders = parseList(rulePreferredProviders(rule))
  const strengths = parseList(model.strengths)
  let score = 0
  score += (model.code_quality || 0) / 10
  score += (model.routing_priority || 0) * 2
  if (preferredProviders.includes(model.provider)) score += 25
  if (strengths.includes(ruleScene(rule))) score += 12
  score += Math.min((model.context_length || 0) / 8000, 10)
  score -= ((model.input_price || 0) + (model.output_price || 0)) * 10
  return score
}

function previewModels(models: RoutingModelOption[], rule: Partial<RoutingRule>) {
  return models
    .filter(model => modelMatchesRule(model, rule))
    .sort((a, b) => scorePreviewModel(b, rule) - scorePreviewModel(a, rule))
}

export default function ModelRoutingPage() {
  const [tab, setTab] = useState<'rules' | 'stats' | 'test'>('rules')

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 px-4 sm:px-6 py-4 border-b flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Zap className="w-5 h-5 text-primary" />
            智能模型路由
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            按用户、场景、能力、成本和可用性选择模型；个人规则优先，全局规则作为默认兜底。
          </p>
        </div>
        <div className="flex items-center gap-1 bg-muted rounded-lg p-0.5">
          {(['rules', 'stats', 'test'] as const).map(item => (
            <button
              key={item}
              onClick={() => setTab(item)}
              className={cn(
                'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                tab === item ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item === 'rules' ? '路由规则' : item === 'stats' ? '统计看板' : '路由测试'}
            </button>
          ))}
        </div>
      </div>

      <div className="mobile-scroll-bottom-safe flex-1 overflow-auto">
        {tab === 'rules' && <RulesTab />}
        {tab === 'stats' && <StatsTab />}
        {tab === 'test' && <TestTab />}
      </div>
    </div>
  )
}

function RulesTab() {
  const { user } = useAuthStore()
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin'
  const [rules, setRules] = useState<RoutingRule[]>([])
  const [models, setModels] = useState<RoutingModelOption[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pagination, setPagination] = useState({ page: 1, page_size: 20, total: 0, total_pages: 0 })
  const [scope, setScope] = useState<RuleScope>('effective')
  const [filterAgent, setFilterAgent] = useState('')
  const [filterComplexity, setFilterComplexity] = useState('')
  const [filterEnabled, setFilterEnabled] = useState('')
  const [editing, setEditing] = useState<Partial<RoutingRule> | null>(null)
  const [creating, setCreating] = useState(false)

  const loadRules = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params: Record<string, unknown> = { page: pagination.page, page_size: pagination.page_size, scope }
      if (filterAgent) params.agent_type = filterAgent
      if (filterComplexity) params.complexity = filterComplexity
      if (filterEnabled) params.enabled = filterEnabled === 'true'
      const response = await routingApi.listRules(params)
      setRules(response.data || [])
      setPagination(response.pagination || { page: 1, page_size: 20, total: 0, total_pages: 0 })
    } catch (e: any) {
      setRules([])
      setPagination(p => ({ ...p, total: 0, total_pages: 0 }))
      setError(e.message || '加载路由规则失败')
    } finally {
      setLoading(false)
    }
  }, [filterAgent, filterComplexity, filterEnabled, pagination.page, pagination.page_size, scope])

  useEffect(() => { loadRules() }, [loadRules])
  useEffect(() => {
    if (!isAdmin && (scope === 'global' || scope === 'all')) {
      setScope('effective')
      setPagination(p => ({ ...p, page: 1 }))
    }
  }, [isAdmin, scope])
  useEffect(() => {
    routingApi.listModels()
      .then(response => setModels(response.data || []))
      .catch(e => {
        console.warn('load routing models failed:', e)
        setError(e.message || '加载路由模型失败')
      })
  }, [])

  const saveRule = async (rule: Partial<RoutingRule>) => {
    setError(null)
    try {
      const payload = {
        id: rule.id,
        name: rule.name || `${label(ruleScene(rule))} / ${label(ruleAgent(rule))}`,
        description: rule.description || '',
        sceneType: ruleScene(rule) === '*' ? 'chat' : ruleScene(rule),
        agentType: ruleAgent(rule) === '*' ? undefined : ruleAgent(rule),
        complexity: rule.complexity === '*' ? undefined : rule.complexity,
        requiredCapabilities: ruleRequiredCapabilities(rule),
        preferredProviders: rulePreferredProviders(rule),
        minContextLength: ruleMinContext(rule) || undefined,
        maxInputPrice: ruleMaxInputPrice(rule) ?? undefined,
        maxOutputPrice: ruleMaxOutputPrice(rule) ?? undefined,
        priority: rule.priority || 10,
        enabled: isEnabled(rule),
      }
      if (rule.id) await routingApi.updateRule(rule.id, payload)
      else await routingApi.createRule(payload, scope === 'global' ? 'global' : 'mine')
      setCreating(false)
      setEditing(null)
      loadRules()
    } catch (e: any) {
      const message = e.message || '保存路由规则失败'
      setError(message)
      throw e
    }
  }

  const deleteRule = async (rule: RoutingRule) => {
    const global = isGlobalRule(rule)
    if (global && !isAdmin) {
      setError('全局默认规则是平台兜底策略，普通用户不能直接编辑或删除。你可以新增个人规则覆盖它。')
      return
    }
    if (!confirm(global ? '确定删除这条全局默认路由规则吗？这会影响所有用户。' : '确定删除这条个人路由规则吗？')) return
    await routingApi.deleteRule(rule.id)
    setRules(current => current.filter(item => item.id !== rule.id))
    await loadRules()
  }

  const resetPage = (fn: () => void) => {
    fn()
    setPagination(p => ({ ...p, page: 1 }))
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <select value={scope} onChange={e => resetPage(() => setScope(e.target.value as RuleScope))} className="px-2 py-1.5 border rounded-md text-sm bg-background">
          <option value="effective">我的有效规则（含全局兜底）</option>
          <option value="mine">只看我的规则</option>
          {isAdmin && <option value="global">全局默认（管理员）</option>}
          {isAdmin && <option value="all">全部规则（管理员）</option>}
        </select>
        <select value={filterAgent} onChange={e => resetPage(() => setFilterAgent(e.target.value))} className="px-2 py-1.5 border rounded-md text-sm bg-background">
          <option value="">全部 Agent</option>
          {AGENT_TYPES.map(item => <option key={item} value={item}>{label(item)}</option>)}
        </select>
        <select value={filterComplexity} onChange={e => resetPage(() => setFilterComplexity(e.target.value))} className="px-2 py-1.5 border rounded-md text-sm bg-background">
          <option value="">全部复杂度</option>
          {COMPLEXITIES.map(item => <option key={item} value={item}>{label(item)}</option>)}
        </select>
        <select value={filterEnabled} onChange={e => resetPage(() => setFilterEnabled(e.target.value))} className="px-2 py-1.5 border rounded-md text-sm bg-background">
          <option value="">全部状态</option>
          <option value="true">启用</option>
          <option value="false">禁用</option>
        </select>
        <button onClick={loadRules} className="p-1.5 border rounded-md hover:bg-muted" title="刷新">
          <RefreshCw className="w-4 h-4" />
        </button>
        <div className="flex-1" />
        <button onClick={() => setCreating(true)} className="flex items-center gap-1 px-3 py-1.5 bg-primary text-primary-foreground rounded-md text-sm font-medium">
          <Plus className="w-4 h-4" /> 新增规则
        </button>
      </div>

      <div className="rounded-lg border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        全局默认规则是平台兜底策略，不会自动变化；只有管理员或数据库初始化/迁移会新增和调整。普通用户的个人规则优先于全局规则，想覆盖默认策略时请新增个人规则。
      </div>

      {error && (
        <div className="p-3 border border-red-200 rounded-md bg-red-50 text-red-700 text-sm flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[1180px]">
            <thead>
              <tr className="bg-muted border-b">
                <th className="text-left p-2 font-medium">ID</th>
                <th className="text-left p-2 font-medium">规则</th>
                <th className="text-left p-2 font-medium">范围</th>
                <th className="text-left p-2 font-medium">场景</th>
                <th className="text-left p-2 font-medium">Agent</th>
                <th className="text-left p-2 font-medium">复杂度</th>
                <th className="text-left p-2 font-medium">能力</th>
                <th className="text-left p-2 font-medium">约束</th>
                <th className="text-left p-2 font-medium">预计模型</th>
                <th className="text-right p-2 font-medium">优先级</th>
                <th className="text-center p-2 font-medium">状态</th>
                <th className="text-right p-2 font-medium">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr><td colSpan={12} className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...</td></tr>
              )}
              {!loading && rules.length === 0 && (
                <tr><td colSpan={12} className="p-8 text-center text-muted-foreground">暂无路由规则，点击“新增规则”开始配置。</td></tr>
              )}
              {!loading && rules.map(rule => {
                const matched = previewModels(models, rule)
                const best = matched[0]
                const providers = parseList(rulePreferredProviders(rule))
                const global = isGlobalRule(rule)
                const canModify = !global || isAdmin
                return (
                  <tr key={rule.id} className="border-b hover:bg-muted/50">
                    <td className="p-2 text-muted-foreground">{rule.id}</td>
                    <td className="p-2">
                      <div className="font-medium">{rule.name || `${label(ruleScene(rule))}路由`}</div>
                      {rule.description && <div className="text-xs text-muted-foreground line-clamp-1">{rule.description}</div>}
                    </td>
                    <td className="p-2">
                      <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px]', global ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}>
                        {global ? '全局默认' : '个人规则'}
                      </span>
                    </td>
                    <td className="p-2"><Badge value={ruleScene(rule)} /></td>
                    <td className="p-2"><Badge value={ruleAgent(rule)} /></td>
                    <td className="p-2"><Badge value={rule.complexity || '*'} /></td>
                    <td className="p-2"><TagList values={parseList(ruleRequiredCapabilities(rule))} empty="不限" /></td>
                    <td className="p-2 text-xs text-muted-foreground">
                      <div>{providers.length ? `供应商优先：${providers.join(', ')}` : '供应商不限'}</div>
                      <div>上下文：{ruleMinContext(rule) ? `>= ${ruleMinContext(rule)}` : '不限'}</div>
                      {(ruleMaxInputPrice(rule) != null || ruleMaxOutputPrice(rule) != null) && (
                        <div>成本上限：入 {ruleMaxInputPrice(rule) ?? '-'} / 出 {ruleMaxOutputPrice(rule) ?? '-'}</div>
                      )}
                    </td>
                    <td className="p-2">
                      {models.length === 0 ? (
                        <span className="text-xs text-amber-600">未加载到启用模型</span>
                      ) : best ? (
                        <div>
                          <div className="font-mono text-xs">{modelId(best)}</div>
                          <div className="text-xs text-muted-foreground">{best.provider}，匹配 {matched.length} 个</div>
                        </div>
                      ) : <span className="text-xs text-red-600">条件无匹配模型</span>}
                    </td>
                    <td className="p-2 text-right">{rule.priority ?? 0}</td>
                    <td className="p-2 text-center"><span className={cn('inline-block w-2 h-2 rounded-full', isEnabled(rule) ? 'bg-green-500' : 'bg-gray-300')} /></td>
                    <td className="p-2 text-right">
                      <button disabled={!canModify} onClick={() => setEditing(rule)} className="p-1 hover:bg-muted rounded disabled:opacity-30" title={canModify ? '编辑' : '全局默认规则由管理员维护；请新增个人规则覆盖'}><Edit3 className="w-3.5 h-3.5" /></button>
                      <button disabled={!canModify} onClick={() => deleteRule(rule)} className="p-1 hover:bg-red-50 hover:text-red-600 rounded ml-1 disabled:opacity-30" title={canModify ? '删除' : '全局默认规则由管理员维护；请新增个人规则覆盖'}><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {pagination.total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>共 {pagination.total} 条规则</span>
          <div className="flex items-center gap-1">
            <button disabled={pagination.page <= 1} onClick={() => setPagination(p => ({ ...p, page: p.page - 1 }))} className="px-2 py-1 border rounded disabled:opacity-30">上一页</button>
            <span className="px-2">{pagination.page} / {pagination.total_pages}</span>
            <button disabled={pagination.page >= pagination.total_pages} onClick={() => setPagination(p => ({ ...p, page: p.page + 1 }))} className="px-2 py-1 border rounded disabled:opacity-30">下一页</button>
          </div>
        </div>
      )}

      {(editing || creating) && (
        <RuleModal initial={editing || {}} models={models} onSave={saveRule} onClose={() => { setEditing(null); setCreating(false) }} />
      )}
    </div>
  )
}

function RuleModal({ initial, models, onSave, onClose }: {
  initial: Partial<RoutingRule>
  models: RoutingModelOption[]
  onSave: (rule: Partial<RoutingRule>) => Promise<void>
  onClose: () => void
}) {
  const existingProviders = parseList(rulePreferredProviders(initial))
  const capabilityOptions = useMemo(() => unique([...FALLBACK_CAPABILITIES, ...models.flatMap(model => parseList(model.capabilities))]), [models])
  const providerOptions = useMemo(() => unique([...models.map(model => model.provider), ...existingProviders]), [models, initial.preferredProviders])
  const [providerDraft, setProviderDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [form, setForm] = useState<Partial<RoutingRule>>({
    id: initial.id,
    name: initial.name || '',
    description: initial.description || '',
    sceneType: ruleScene(initial),
    agentType: ruleAgent(initial),
    complexity: initial.complexity || '*',
    requiredCapabilities: ruleRequiredCapabilities(initial),
    preferredProviders: rulePreferredProviders(initial),
    minContextLength: ruleMinContext(initial) || 0,
    maxInputPrice: ruleMaxInputPrice(initial),
    maxOutputPrice: ruleMaxOutputPrice(initial),
    priority: initial.priority || 10,
    enabled: isEnabled(initial),
  })

  const matched = previewModels(models, form)
  const best = matched[0]

  const toggleList = (key: 'requiredCapabilities' | 'preferredProviders', value: string) => {
    const current = parseList(form[key])
    const next = current.includes(value) ? current.filter(item => item !== value) : [...current, value]
    setForm(prev => ({ ...prev, [key]: stringifyList(next) }))
  }

  const addProvider = () => {
    const value = providerDraft.trim()
    if (!value) return
    const current = parseList(form.preferredProviders)
    if (!current.includes(value)) {
      setForm(prev => ({ ...prev, preferredProviders: stringifyList([...current, value]) }))
    }
    setProviderDraft('')
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(form)
    } catch (e: any) {
      setSaveError(e.message || '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3" onClick={onClose}>
      <div className="bg-background rounded-lg w-full max-w-3xl max-h-[90vh] overflow-auto shadow-xl border" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-background border-b px-5 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{form.id ? '编辑路由规则' : '新增路由规则'}</h2>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="规则名称">
              <input value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background" placeholder="例如：复杂代码任务优先强推理模型" />
            </Field>
            <Field label="优先级">
              <input type="number" value={form.priority || 10} onChange={e => setForm({ ...form, priority: Number(e.target.value) })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background" min={0} max={999} />
            </Field>
          </div>

          <Field label="描述">
            <textarea value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background min-h-20" placeholder="说明这条规则适用的业务场景，便于后续维护。" />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="场景">
              <select value={ruleScene(form)} onChange={e => setForm({ ...form, sceneType: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
                {SCENE_TYPES.map(item => <option key={item} value={item}>{label(item)}</option>)}
              </select>
            </Field>
            <Field label="Agent">
              <select value={ruleAgent(form)} onChange={e => setForm({ ...form, agentType: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
                {AGENT_TYPES.map(item => <option key={item} value={item}>{label(item)}</option>)}
              </select>
            </Field>
            <Field label="复杂度">
              <select value={form.complexity || '*'} onChange={e => setForm({ ...form, complexity: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
                {COMPLEXITIES.map(item => <option key={item} value={item}>{label(item)}</option>)}
              </select>
            </Field>
          </div>

          <Field label="必须具备的模型能力">
            <div className="flex gap-1.5 flex-wrap">
              {capabilityOptions.map(cap => (
                <button key={cap} type="button" onClick={() => toggleList('requiredCapabilities', cap)} className={cn('px-2 py-1 rounded-md text-xs border', parseList(form.requiredCapabilities).includes(cap) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted')}>
                  {cap}
                </button>
              ))}
            </div>
          </Field>

          <Field label="优先供应商">
            <div className="flex gap-1.5 flex-wrap">
              {providerOptions.map(provider => (
                <button key={provider} type="button" onClick={() => toggleList('preferredProviders', provider)} className={cn('px-2 py-1 rounded-md text-xs border', parseList(form.preferredProviders).includes(provider) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted')}>
                  {provider}
                </button>
              ))}
              <button type="button" onClick={() => setForm(prev => ({ ...prev, preferredProviders: '[]' }))} className="px-2 py-1 rounded-md text-xs border bg-background hover:bg-muted">
                清空
              </button>
            </div>
            <div className="flex gap-2 mt-2">
              <input
                value={providerDraft}
                onChange={e => setProviderDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addProvider() } }}
                className="flex-1 px-2 py-1.5 border rounded-md text-sm bg-background"
                placeholder={providerOptions.length === 0 ? '后台暂无启用模型，可手动输入供应商名' : '手动输入供应商名'}
              />
              <button type="button" onClick={addProvider} className="px-3 py-1.5 border rounded-md text-sm hover:bg-muted">
                添加
              </button>
            </div>
            {models.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">没有从后台加载到启用模型，预览无法计算；请先确认模型配置里至少有一个启用模型。</p>
            )}
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="最小上下文长度">
              <input type="number" value={ruleMinContext(form) || 0} onChange={e => setForm({ ...form, minContextLength: Number(e.target.value) })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background" min={0} />
            </Field>
            <Field label="输入成本上限">
              <input type="number" value={ruleMaxInputPrice(form) ?? ''} onChange={e => setForm({ ...form, maxInputPrice: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background" min={0} step={0.000001} placeholder="不限" />
            </Field>
            <Field label="输出成本上限">
              <input type="number" value={ruleMaxOutputPrice(form) ?? ''} onChange={e => setForm({ ...form, maxOutputPrice: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background" min={0} step={0.000001} placeholder="不限" />
            </Field>
          </div>

          <div className="border rounded-lg p-3 bg-muted/20">
            <div className="text-sm font-medium mb-2">当前规则预览</div>
            {models.length === 0 ? (
              <div className="text-sm text-amber-600">未加载到启用模型，暂时无法预估。请先确认模型配置里至少有一个启用模型。</div>
            ) : best ? (
              <div className="text-sm">
                <div>智能路由预估：<span className="font-mono">{modelId(best)}</span></div>
                <div className="text-xs text-muted-foreground mt-1">供应商 {best.provider}，共有 {matched.length} 个模型满足硬性条件。</div>
                <div className="text-xs text-muted-foreground mt-1">这里展示的是按当前规则估算的候选模型；真正请求时还会结合用户偏好、熔断状态和可用渠道动态选择。</div>
              </div>
            ) : (
              <div className="text-sm text-red-600">当前条件没有匹配到启用模型，请放宽能力、上下文或成本上限；供应商优先只加分，不作为硬过滤。</div>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isEnabled(form)} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
            启用此规则
          </label>
        </div>

        <div className="sticky bottom-0 bg-background border-t px-5 py-4 flex justify-end gap-2">
          {saveError && <div className="mr-auto text-sm text-red-600 line-clamp-2">{saveError}</div>}
          <button onClick={onClose} className="px-4 py-1.5 border rounded-md text-sm">取消</button>
          <button disabled={saving} onClick={handleSave} className="px-4 py-1.5 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-60">{saving ? '保存中...' : (form.id ? '更新' : '创建')}</button>
        </div>
      </div>
    </div>
  )
}

function StatsTab() {
  const [stats, setStats] = useState<RoutingStats | null>(null)
  const [models, setModels] = useState<RoutingCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsResponse, modelsResponse] = await Promise.all([routingApi.getStats(), routingApi.getCandidates()])
      setStats(statsResponse.data)
      setModels(modelsResponse.data || [])
    } catch (e: any) {
      setError(e.message || '加载统计失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const resetBreaker = async (id?: string) => {
    await routingApi.resetCircuitBreaker(id)
    load()
  }

  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} />

  const broken = stats?.circuit_breaker.broken || {}
  const failures = stats?.circuit_breaker.failure_counts || {}

  return (
    <div className="p-4 space-y-5">
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <StatCard label="路由规则" value={stats?.rules.total || 0} />
        <StatCard label="Agent 覆盖" value={Object.keys(stats?.rules.by_agent_type || {}).length} />
        <StatCard label="启用模型" value={models.length} />
        <StatCard label="熔断缓存" value={stats?.cache.entries || 0} />
      </div>

      <div className="border rounded-lg p-4">
        <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
          <Shield className="w-4 h-4" /> 熔断器状态
          <button onClick={() => resetBreaker()} className="ml-auto text-xs text-primary hover:underline">全部重置</button>
        </h3>
        {Object.keys(broken).length === 0 && Object.keys(failures).length === 0 ? (
          <p className="text-sm text-green-600 flex items-center gap-1"><Check className="w-4 h-4" /> 所有模型正常</p>
        ) : (
          <div className="space-y-2">
            {Object.entries(broken).map(([id, seconds]) => (
              <div key={id} className="flex items-center gap-2 p-2 bg-red-50 rounded-md text-sm">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <span className="font-mono flex-1">{id}</span>
                <span className="text-red-600">剩余 {seconds}s</span>
                <button onClick={() => resetBreaker(id)} className="text-xs text-primary hover:underline">重置</button>
              </div>
            ))}
            {Object.entries(failures).map(([id, count]) => (
              <div key={id} className="flex items-center gap-2 p-2 bg-amber-50 rounded-md text-sm">
                <span className="font-mono flex-1">{id}</span>
                <span className="text-amber-700">连续失败 {count} 次</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted border-b">
              <th className="text-left p-2">模型</th>
              <th className="text-left p-2">供应商</th>
              <th className="text-right p-2">代码质量</th>
              <th className="text-right p-2">上下文</th>
              <th className="text-right p-2">失败次数</th>
            </tr>
          </thead>
          <tbody>
            {models.map(model => (
              <tr key={model.id} className="border-b">
                <td className="p-2 font-mono text-xs">{modelId(model)}</td>
                <td className="p-2">{model.provider}</td>
                <td className="p-2 text-right">{model.code_quality || 0}</td>
                <td className="p-2 text-right">{model.context_length || '-'}</td>
                <td className="p-2 text-right">{model.status?.failures || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TestTab() {
  const [form, setForm] = useState<RouteTestRequest>({
    sceneType: 'chat',
    agentType: 'general',
    complexity: 'moderate',
    requiredCapabilities: [],
    preferredProviders: [],
  })
  const [capDraft, setCapDraft] = useState('')
  const [providerDraft, setProviderDraft] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ selected?: any; candidates: RouteTestResult[]; total?: number } | null>(null)

  const addToList = (key: 'requiredCapabilities' | 'preferredProviders', value: string, clear: () => void) => {
    const trimmed = value.trim()
    if (!trimmed) return
    const current = form[key] || []
    if (!current.includes(trimmed)) setForm(prev => ({ ...prev, [key]: [...current, trimmed] }))
    clear()
  }

  const removeFromList = (key: 'requiredCapabilities' | 'preferredProviders', value: string) => {
    setForm(prev => ({ ...prev, [key]: (prev[key] || []).filter(item => item !== value) }))
  }

  const runTest = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await routingApi.testRoute(form)
      const data = (response as any).data || response
      setResult({ selected: data.selected, candidates: data.candidates || [], total: data.total })
    } catch (e: any) {
      setError(e.message || '路由测试失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="p-4 grid grid-cols-1 xl:grid-cols-[420px_1fr] gap-4">
      <div className="border rounded-lg p-4 space-y-4">
        <h3 className="font-semibold flex items-center gap-2"><Search className="w-4 h-4" /> 测试路由上下文</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="场景">
            <select value={form.sceneType || 'chat'} onChange={e => setForm({ ...form, sceneType: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
              {SCENE_TYPES.filter(item => item !== '*').map(item => <option key={item} value={item}>{label(item)}</option>)}
            </select>
          </Field>
          <Field label="Agent">
            <select value={form.agentType || 'general'} onChange={e => setForm({ ...form, agentType: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
              {AGENT_TYPES.filter(item => item !== '*').map(item => <option key={item} value={item}>{label(item)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="复杂度">
          <select value={form.complexity || 'moderate'} onChange={e => setForm({ ...form, complexity: e.target.value })} className="w-full px-2 py-1.5 border rounded-md text-sm bg-background">
            {COMPLEXITIES.filter(item => item !== '*').map(item => <option key={item} value={item}>{label(item)}</option>)}
          </select>
        </Field>
        <ListInput
          label="必须能力"
          values={form.requiredCapabilities || []}
          draft={capDraft}
          onDraft={setCapDraft}
          onAdd={() => addToList('requiredCapabilities', capDraft, () => setCapDraft(''))}
          onRemove={value => removeFromList('requiredCapabilities', value)}
          placeholder="例如 code"
        />
        <ListInput
          label="优先供应商"
          values={form.preferredProviders || []}
          draft={providerDraft}
          onDraft={setProviderDraft}
          onAdd={() => addToList('preferredProviders', providerDraft, () => setProviderDraft(''))}
          onRemove={value => removeFromList('preferredProviders', value)}
          placeholder="例如 OpenAI"
        />
        <button disabled={loading} onClick={runTest} className="w-full px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm disabled:opacity-60">
          {loading ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
          执行路由测试
        </button>
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>

      <div className="border rounded-lg p-4">
        <h3 className="font-semibold flex items-center gap-2 mb-3"><BarChart3 className="w-4 h-4" /> 测试结果</h3>
        {!result ? (
          <p className="text-sm text-muted-foreground">配置上下文后执行测试，系统会展示当前用户规则与全局规则共同作用后的模型选择。</p>
        ) : (
          <div className="space-y-4">
            {result.selected && (
              <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                <div className="text-sm text-muted-foreground">最终选择</div>
                <div className="font-mono text-sm mt-1">{modelId(result.selected)}</div>
                <div className="text-xs text-muted-foreground mt-1">{result.selected.provider}，评分 {result.selected.score ?? '-'}</div>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="bg-muted border-b">
                    <th className="text-left p-2">模型</th>
                    <th className="text-left p-2">供应商</th>
                    <th className="text-right p-2">评分</th>
                    <th className="text-left p-2">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map(candidate => (
                    <tr key={`${modelId(candidate)}-${candidate.provider}`} className="border-b">
                      <td className="p-2 font-mono text-xs">{modelId(candidate)}</td>
                      <td className="p-2">{candidate.provider}</td>
                      <td className="p-2 text-right">{Number(candidate.score || 0).toFixed(2)}</td>
                      <td className="p-2 text-xs text-muted-foreground">{candidate.reason || '-'}</td>
                    </tr>
                  ))}
                  {result.candidates.length === 0 && (
                    <tr><td colSpan={4} className="p-8 text-center text-muted-foreground">没有候选模型</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function Badge({ value }: { value?: string | null }) {
  return <span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{label(value)}</span>
}

function TagList({ values, empty }: { values: string[]; empty: string }) {
  if (!values.length) return <span className="text-xs text-muted-foreground">{empty}</span>
  return (
    <div className="flex flex-wrap gap-1">
      {values.map(value => <span key={value} className="rounded bg-muted px-1.5 py-0.5 text-[11px]">{value}</span>)}
    </div>
  )
}

function Field({ label: fieldLabel, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm space-y-1">
      <span className="text-muted-foreground">{fieldLabel}</span>
      {children}
    </label>
  )
}

function ListInput({ label: fieldLabel, values, draft, onDraft, onAdd, onRemove, placeholder }: {
  label: string
  values: string[]
  draft: string
  onDraft: (value: string) => void
  onAdd: () => void
  onRemove: (value: string) => void
  placeholder?: string
}) {
  return (
    <Field label={fieldLabel}>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {values.map(value => (
          <button key={value} type="button" onClick={() => onRemove(value)} className="rounded bg-muted px-2 py-1 text-xs hover:bg-red-50 hover:text-red-600">
            {value} ×
          </button>
        ))}
        {values.length === 0 && <span className="text-xs text-muted-foreground">未设置</span>}
      </div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={e => onDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onAdd() } }}
          className="flex-1 px-2 py-1.5 border rounded-md text-sm bg-background"
          placeholder={placeholder}
        />
        <button type="button" onClick={onAdd} className="px-3 py-1.5 border rounded-md text-sm hover:bg-muted">添加</button>
      </div>
    </Field>
  )
}

function StatCard({ label: cardLabel, value }: { label: string; value: number | string }) {
  return (
    <div className="border rounded-lg p-4">
      <div className="text-xs text-muted-foreground">{cardLabel}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  )
}

function LoadingState() {
  return <div className="p-8 text-center text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...</div>
}

function ErrorState({ error }: { error: string }) {
  return <div className="p-8 text-center text-red-600">{error}</div>
}
