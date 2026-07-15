import { useState, useMemo, useRef, useEffect } from 'react'
import { useChatStore, useAdminStore, useAuthStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { agentRegistryApi, chatApi, type AgentRegistryItem } from '@/lib/api'
import { getFrontendModels, parseUserModelLimit } from '@/lib/frontendModels'
import { useAvailableModels } from '@/hooks/useAvailableModels'
import { DEFAULT_CHAT_SYSTEM_PROMPT } from '@/config/defaultPrompt'


import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import {
  Cpu, Settings2, Zap, Eye, Code, Brain, Bot, Wrench, X, ChevronRight,
  Puzzle, Globe, Star, Check, Plus, RotateCcw, Search, Upload, FileJson,
  Server, Loader2, BookOpen, PackageOpen, PackageCheck, Download, Sparkles,
  Lightbulb,
} from 'lucide-react'
import { importAgent, getAgentTemplates, BAN_BIAO_AGENT_TEMPLATE, manifestToAgentApp, type AgentRegisterOptions } from '@/lib/agent-sdk'
import AgentDocsDialog from '@/components/agent/AgentDocsDialog'
import AgentDetailDialog from '@/components/agent/AgentDetailDialog'
import { hasCapability, getAgentRequiredCapabilities, getTagLabel, TAG_MAPPING } from '@/config/capabilities'

interface ModelPanelProps {
  onClose: () => void
}

export default function ModelPanel({ onClose }: ModelPanelProps) {
  const { selectedModel, setSelectedModel, modelSettings, setModelSettings, activeAgent, setActiveAgent, activeSkillIds, mcpServices, toggleMCPService, addMCPService, removeMCPService } = useChatStore()
  const { models, channels, agents, plugins, togglePlugin, addAgent, updateAgent, deleteAgent, setModels } = useAdminStore()
  const { user } = useAuthStore()
  const { installedSkillIds, addInstalledSkill, removeInstalledSkill } = useChatStore()
  const [activeTab, setActiveTab] = useState<'model' | 'agent' | 'mcp' | 'plugins'>('model')
  const [showMCPAdd, setShowMCPAdd] = useState(false)
  const [mcpForm, setMcpForm] = useState({ name: '', endpoint: '', description: '' })
  const [modelSearch, setModelSearch] = useState('')
  const [providerFilter, setProviderFilter] = useState('all')
  const [showAgentEdit, setShowAgentEdit] = useState(false)
  const [editingAgent, setEditingAgent] = useState<any | null>(null)
  const [agentForm, setAgentForm] = useState({ name: '', description: '', icon: '🤖', systemPrompt: '', model: 'gpt-4o', temperature: 0.7, maxTokens: 4096, tools: '' })
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const agentFileRef = useRef<HTMLInputElement>(null)
  // 后端 Skill 注册中心
  const [serverAgents, setServerAgents] = useState<AgentRegistryItem[]>([])
  const [serverAgentLoading, setServerAgentLoading] = useState(false)
  const [serverAgentSearch, setServerAgentSearch] = useState('')
  // Skill 文档和详情弹窗
  const [showAgentDocs, setShowAgentDocs] = useState(false)
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null)
  const [detailListItem, setDetailListItem] = useState<AgentRegistryItem | undefined>(undefined)
  const [installingAgentIds, setInstallingAgentIds] = useState<Set<string>>(new Set())
  const [backendModelsLoaded, setBackendModelsLoaded] = useState(false)

  // 加载后端 Agent 列表
  useEffect(() => {
    if (activeTab === 'agent') loadServerAgents()
  }, [activeTab])

  useEffect(() => {
    let cancelled = false
    chatApi.listModels()
      .then(list => {
        if (cancelled) return
        if (Array.isArray(list) && list.length > 0) {
          setModels(list)
          setBackendModelsLoaded(true)
        }
      })
      .catch(err => {
        console.warn('加载用户可用模型失败:', err)
        setBackendModelsLoaded(false)
      })
    return () => { cancelled = true }
  }, [setModels])

  const loadServerAgents = async () => {
    setServerAgentLoading(true)
    try {
      const res = await agentRegistryApi.list()
      setServerAgents(res.list || [])
    } catch (e) {
      console.warn('加载后端 Skill 列表失败:', e)
      setServerAgents([])
    } finally {
      setServerAgentLoading(false)
    }
  }

  const searchServerAgents = async () => {
    if (!serverAgentSearch.trim()) { loadServerAgents(); return }
    setServerAgentLoading(true)
    try {
      const res = await agentRegistryApi.search(serverAgentSearch)
      setServerAgents(res.list || [])
    } catch (e) {
      console.warn('搜索 Skill 失败:', e)
    } finally {
      setServerAgentLoading(false)
    }
  }

  const handleInstall = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    setInstallingAgentIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.install(agentId)
      addInstalledSkill(agentId)
    } catch (err) {
      console.warn('安装技能失败:', err)
    } finally {
      setInstallingAgentIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleUninstall = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    setInstallingAgentIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.uninstall(agentId)
      removeInstalledSkill(agentId)
    } catch (err) {
      console.warn('卸载技能失败:', err)
    } finally {
      setInstallingAgentIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleDownload = (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    agentRegistryApi.download(agentId).catch(err => console.warn('下载失败:', err))
  }

  // 用户订阅的模型限制（逗号分隔，空表示不限）
  const userModelLimit = useMemo(() => parseUserModelLimit(user?.modelLimit), [user?.modelLimit])
  const isUserAgentMode = Boolean(activeAgent || (activeSkillIds && activeSkillIds.length > 0))
  const requiredModelCapabilities = useMemo(
    () => isUserAgentMode ? getAgentRequiredCapabilities() as any : undefined,
    [isUserAgentMode]
  )
  const userAvailableModels = useAvailableModels({ userModelLimit, requiredCapabilities: requiredModelCapabilities })
  const effectiveChannels = backendModelsLoaded ? [] : channels

  // 从活跃渠道聚合可用模型列表
  const activeChannelModels = useMemo(() => {
    const activeChannels = effectiveChannels.filter(c => c.status === 'active')
    const modelIds = new Set<string>()
    activeChannels.forEach(ch => {
      ch.models.filter(Boolean).forEach(m => modelIds.add(m))
    })
    return Array.from(modelIds)
  }, [effectiveChannels])

  // 优先显示渠道中的模型，再按订阅限制过滤
  // 重要：如果用户有订阅限制，必须基于订阅限制来过滤，而不是 fallback 到所有模型
  const legacyAvailableModels = useMemo(() => {
    let list: (typeof models[0] | typeof channels[0])[] = []

    // 优先使用渠道模型（如果渠道已配置）
    if (activeChannelModels.length > 0) {
      list = activeChannelModels.map(id => {
        const meta = models.find(m => m.id === id)
        // 从所有提供此模型的渠道中收集 tags 作为 capabilities
        const channelTags = effectiveChannels
          .filter(c => c.status === 'active' && c.models.includes(id) && c.tags?.length)
          .flatMap(c => c.tags!)
        const uniqueTags = [...new Set(channelTags)] as ('text' | 'vision' | 'audio' | 'code' | 'reasoning' | 'tool' | 'think')[]
        return meta || {
          id, name: id, provider: effectiveChannels.find(c => c.models.includes(id))?.provider || '',
          description: '', contextLength: 128000, inputPrice: 0, outputPrice: 0,
          capabilities: uniqueTags.length > 0 ? uniqueTags : ['text'] as ('text' | 'vision' | 'audio' | 'code' | 'reasoning' | 'tool')[],
          enabled: true,
        }
      })
    } else {
      // 渠道未配置时，fallback 到所有启用的模型
      // 但如果有订阅限制，这个 fallback 会被订阅限制覆盖
      list = models.filter(m => m.enabled)
    }

    // 按订阅模型限制过滤（重要：订阅限制优先于渠道配置）
    if (userModelLimit) {
      list = list.filter(m => userModelLimit.has(m.id))
      // 如果订阅限制过滤后没有可用模型，但用户有订阅限制，说明套餐配置可能有问题
      if (list.length === 0) {
        console.warn('用户订阅限制了模型但配置的模型不可用:', userModelLimit)
      }
    }

    // Agent/技能模式下过滤：只显示支持必要能力的模型（默认 tool）
    list = getFrontendModels(models, effectiveChannels, { userModelLimit })
    const isAgentMode = activeAgent || (activeSkillIds && activeSkillIds.length > 0)
    if (isAgentMode) {
      const beforeCount = list.length
      const requiredCaps = getAgentRequiredCapabilities()
      // 过滤：需满足所有 Agent 必需能力
      list = list.filter(m => requiredCaps.every(capId => (m as any).capabilities?.includes(capId)))
      if (list.length === 0 && beforeCount > 0) {
        console.warn('Agent/技能模式下无可用的 tool 模型，请添加支持 function calling 的模型（如 gpt-4o）')
      }
    }
    return list
  }, [activeChannelModels, models, effectiveChannels, userModelLimit, activeAgent, activeSkillIds])

  const availableModels = userAvailableModels.backendLoaded ? userAvailableModels.models : legacyAvailableModels

  const currentModel = availableModels.find((m) => m.id === selectedModel)

  useEffect(() => {
    if (selectedModel !== 'auto' && availableModels.length > 0 && !currentModel) {
      setSelectedModel('auto')
    }
  }, [availableModels, currentModel, selectedModel, setSelectedModel])

  // 供应商列表（用于筛选）
  const providers = useMemo(() => {
    const set = new Set(availableModels.map(m => m.provider).filter(Boolean))
    return ['all', ...Array.from(set)]
  }, [availableModels])

  // 搜索 + 供应商筛选后的模型
  const filteredModels = useMemo(() => availableModels.filter(m => {
    const matchSearch = !modelSearch || m.name.toLowerCase().includes(modelSearch.toLowerCase()) || m.provider.toLowerCase().includes(modelSearch.toLowerCase())
    const matchProvider = providerFilter === 'all' || m.provider === providerFilter
    return matchSearch && matchProvider
  }), [availableModels, modelSearch, providerFilter])
  const installedPlugins = plugins.filter((p) => p.installed)
  const availablePlugins = plugins.filter((p) => !p.installed)

  const capabilityIcons: Record<string, React.ReactNode> = {
    text: <Zap className="w-3 h-3" />,
    vision: <Eye className="w-3 h-3" />,
    code: <Code className="w-3 h-3" />,
    reasoning: <Brain className="w-3 h-3" />,
    audio: <Globe className="w-3 h-3" />,
    tool: <Wrench className="w-3 h-3" />,
    think: <Lightbulb className="w-3 h-3" />,
  }

  const tabs = [
    { id: 'model', label: '模型', icon: <Cpu className="w-3.5 h-3.5" /> },
    { id: 'agent', label: 'Skill', icon: <Bot className="w-3.5 h-3.5" /> },
    { id: 'mcp', label: 'MCP', icon: <Wrench className="w-3.5 h-3.5" /> },
  ]

  const handleResetSettings = () => {
    setModelSettings({ temperature: 0.7, maxTokens: 4096, topP: 1, systemPrompt: DEFAULT_CHAT_SYSTEM_PROMPT })
  }

  return (
    <>
      {/* 移动端遮罩 */}
      <div
        className="fixed inset-0 z-40 bg-black/50 md:hidden"
        onClick={onClose}
      />

      {/* 移动端底部抽屉 / 桌面端侧边面板 */}
      <div className={[
        // 桌面端：右侧固定宽度面板
        'md:relative md:flex md:flex-col md:h-full md:w-72 md:bg-background md:border-l md:border-border md:shrink-0',
        // 移动端：固定底部抽屉，最大高度 85vh，overflow-hidden 确保 flex 高度链路正确
        'fixed bottom-0 left-0 right-0 z-50 flex flex-col bg-background rounded-t-2xl shadow-2xl overflow-hidden',
        'md:rounded-none md:bottom-auto md:left-auto md:right-auto md:z-auto md:shadow-none md:overflow-visible',
        'max-h-[85vh] md:max-h-full',
      ].join(' ')}>
        {/* 移动端拖动指示条 */}
        <div className="flex justify-center pt-2 pb-1 md:hidden">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h3 className="font-semibold text-sm">模型与工具</h3>
        <button onClick={onClose} className="p-1 rounded-md hover:bg-muted transition-colors">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as typeof activeTab)}
            className={`flex-1 flex items-center justify-center gap-1 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-primary border-b-2 border-primary'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain" style={{ WebkitOverflowScrolling: 'touch' }}>
        {/* MODEL TAB */}
        {activeTab === 'model' && (
          <div className="p-4 space-y-5">
            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 block">
                选择模型
                {userModelLimit
                  ? <span className="ml-2 text-orange-500 normal-case font-normal">· 套餐限定 {userModelLimit.size} 个</span>
                  : activeChannelModels.length > 0
                    ? <span className="ml-2 text-green-500 normal-case font-normal">· 来自活跃渠道</span>
                    : null
                }
              </Label>
              {/* 搜索框 */}
              <div className="relative mb-2">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={modelSearch}
                  onChange={e => setModelSearch(e.target.value)}
                  placeholder="搜索模型..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {/* 供应商筛选 */}
              {providers.length > 2 && (
                <div className="flex flex-wrap gap-1 mb-3">
                  {providers.map(p => (
                    <button
                      key={p}
                      onClick={() => setProviderFilter(p)}
                      className={`text-[10px] px-2 py-0.5 rounded-full border transition-colors ${
                        providerFilter === p
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-muted text-muted-foreground border-border hover:border-primary/40'
                      }`}
                    >
                      {p === 'all' ? '全部' : p}
                    </button>
                  ))}
                </div>
              )}
              {availableModels.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">暂无可用模型，请在管理后台配置渠道</p>
              )}
              {filteredModels.length === 0 && availableModels.length > 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">未找到匹配的模型</p>
              )}
              <div className="space-y-1.5">
                {/* Auto 智能路由选项（始终显示在最顶部） */}
                <button
                  onClick={() => setSelectedModel('auto')}
                  className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                    selectedModel === 'auto'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:border-primary/40 hover:bg-muted/50'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <span className="text-sm font-medium">Auto</span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">智能路由</span>
                      {selectedModel === 'auto' && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                    </div>
                    <p className="text-[10px] text-muted-foreground">根据任务类型自动选择最优模型</p>
                  </div>
                </button>

                {/* 分隔线：内置模型 */}
                {filteredModels.length > 0 && (
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide pt-1">内置模型</p>
                )}

                {filteredModels.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => setSelectedModel(model.id)}
                    className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                      selectedModel === model.id
                        ? 'border-primary bg-primary/5 ring-1 ring-primary'
                        : 'border-border hover:border-primary/40 hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium truncate">{model.name}</span>
                        {selectedModel === model.id && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
                      </div>
                      <p className="text-[10px] text-muted-foreground mb-1.5">{model.provider} · {'contextLength' in model ? `${((model.contextLength as number) / 1000).toFixed(0)}K context` : '–'}</p>
                      <div className="flex flex-wrap gap-1">
                        {'capabilities' in model && Array.isArray(model.capabilities) && (model.capabilities as string[]).map((cap) => (
                          <span key={cap} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                            {(capabilityIcons as Record<string, React.ReactNode>)[cap]}{getTagLabel(cap)}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-muted-foreground shrink-0">
                      <p>${'inputPrice' in model ? (model.inputPrice as number) : 0}/1M</p>
                      <p className="text-[9px]">输入</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <Separator />

            <div className="space-y-5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">模型参数</Label>
                <button onClick={handleResetSettings} className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <RotateCcw className="w-3 h-3" />重置
                </button>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">温度</Label>
                  <span className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{modelSettings.temperature}</span>
                </div>
                <Slider value={[modelSettings.temperature]} onValueChange={([v]) => setModelSettings({ temperature: v })} min={0} max={2} step={0.1} />
                <p className="text-[10px] text-muted-foreground">较低值输出更确定，较高值更具创意</p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">最大 Token</Label>
                  <span className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{modelSettings.maxTokens}</span>
                </div>
                <Slider value={[modelSettings.maxTokens]} onValueChange={([v]) => setModelSettings({ maxTokens: v })} min={256} max={'contextLength' in (currentModel ?? {}) ? (currentModel as {contextLength: number}).contextLength : 8192} step={256} />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Top P</Label>
                  <span className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded">{modelSettings.topP}</span>
                </div>
                <Slider value={[modelSettings.topP]} onValueChange={([v]) => setModelSettings({ topP: v })} min={0} max={1} step={0.05} />
              </div>

              <div className="space-y-2">
                <Label className="text-sm">系统提示词</Label>
                <Textarea
                  value={modelSettings.systemPrompt}
                  onChange={(e) => setModelSettings({ systemPrompt: e.target.value })}
                  placeholder="设置AI的角色和行为..."
                  className="text-xs min-h-[100px] resize-none"
                />
                <p className="text-[10px] text-muted-foreground">{modelSettings.systemPrompt.length} 个字符</p>
              </div>
            </div>
          </div>
        )}

        {/* AGENT TAB */}
        {activeTab === 'agent' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Skill 应用</Label>
              <div className="flex gap-1">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowAgentDocs(true)} title="开发者文档">
                  <BookOpen className="w-3 h-3" />文档
                </Button>
                {activeAgent && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setActiveAgent(null)}>
                    <X className="w-3 h-3 mr-1" />清除
                  </Button>
                )}
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowTemplateDialog(true)} title="从模板创建">
                  <FileJson className="w-3 h-3" />模板
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => agentFileRef.current?.click()} title="导入 Agent JSON">
                  <Upload className="w-3 h-3" />导入
                </Button>
                <input ref={agentFileRef} type="file" accept=".json" className="hidden" onChange={async (e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  setImportError(null)
                  try {
                    const text = await file.text()
                    const result = importAgent(text)
                    if (result.success && result.agent) {
                      addAgent(result.agent)
                    } else {
                      setImportError(result.error || '导入失败')
                    }
                  } catch (err) {
                    setImportError(`读取文件失败: ${(err as Error).message}`)
                  }
                  e.target.value = ''
                }} />
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => { setEditingAgent(null); setAgentForm({ name: '', description: '', icon: '🤖', systemPrompt: '', model: availableModels[0]?.id || 'gpt-4o', temperature: 0.7, maxTokens: 4096, tools: '' }); setShowAgentEdit(true) }}>
                  <Plus className="w-3 h-3" />新建
                </Button>
              </div>
            </div>
            {importError && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-2 text-xs text-destructive flex items-center justify-between">
                <span>{importError}</span>
                <button onClick={() => setImportError(null)} className="ml-2 p-0.5 hover:bg-destructive/20 rounded"><X className="w-3 h-3" /></button>
              </div>
            )}
            {activeAgent && (
              <div className="bg-primary/5 border border-primary/30 rounded-xl p-3 text-xs">
                <p className="font-medium text-primary">当前使用: {activeAgent.name}</p>
                <p className="text-muted-foreground mt-0.5">{activeAgent.description}</p>
              </div>
            )}

            {/* 本地 Agent 列表 */}
            {agents.length > 0 && (
              <>
                <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">本地 Agent</Label>
                {agents.map((agent) => (
                  <div key={agent.id} className={`group relative flex items-center gap-3 p-3 rounded-xl border text-left transition-all cursor-pointer ${activeAgent?.id === agent.id ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/40 hover:bg-muted/50'}`}
                    onClick={() => setActiveAgent(activeAgent?.id === agent.id ? null : agent)}>
                    <span className="text-2xl">{agent.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{agent.name}</span>
                        {activeAgent?.id === agent.id && <Badge variant="default" className="text-[10px] h-4 px-1">启用</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{agent.description}</p>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{agent.model} · T={agent.temperature}{agent.tools?.length > 0 ? ` · ${agent.tools.length} 工具` : ''}</p>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                      <button className="p-1 rounded hover:bg-muted" onClick={() => { setEditingAgent(agent); setAgentForm({ name: agent.name, description: agent.description, icon: agent.icon, systemPrompt: agent.systemPrompt, model: agent.model, temperature: agent.temperature, maxTokens: agent.maxTokens, tools: (agent.tools || []).join(', ') }); setShowAgentEdit(true) }} title="编辑">
                        <Settings2 className="w-3.5 h-3.5 text-muted-foreground" />
                      </button>
                      <button className="p-1 rounded hover:bg-muted" onClick={() => { if (activeAgent?.id === agent.id) setActiveAgent(null); deleteAgent(agent.id) }} title="删除">
                        <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}

            <Separator />

            {/* 后端 Agent 市场 */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                  <Server className="w-3 h-3" /> Agent 市场
                </Label>
                <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={loadServerAgents}>
                  <RotateCcw className="w-3 h-3" />
                </Button>
              </div>
              {/* 搜索框 */}
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={serverAgentSearch}
                  onChange={e => setServerAgentSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && searchServerAgents()}
                  placeholder="搜索平台 Agent..."
                  className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border bg-muted/40 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              {serverAgentLoading && (
                <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />加载中...
                </div>
              )}
              {!serverAgentLoading && serverAgents.length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-3">暂无平台 Agent</p>
              )}
              {serverAgents.map((sa) => {
                const isInstalled = installedSkillIds.includes(sa.agentId)
                const isInstalling = installingAgentIds.has(sa.agentId)
                return (
                <div
                  key={sa.agentId}
                  className={`group flex items-center gap-3 p-3 rounded-xl border text-left transition-all cursor-pointer ${activeAgent?.id === `server:${sa.agentId}` ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:border-primary/40 hover:bg-muted/50'}`}
                  onClick={() => {
                    // 点击进入详情
                    setDetailAgentId(sa.agentId)
                    setDetailListItem(sa)
                  }}
                >
                  <span className="text-2xl">{sa.icon || '🤖'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{sa.name}</span>
                      {sa.isBuiltin && <Badge variant="secondary" className="text-[9px] h-3.5 px-1">内置</Badge>}
                      {isInstalled && <Badge variant="outline" className="text-[9px] h-3.5 px-1 text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700">已安装</Badge>}
                      {activeAgent?.id === `server:${sa.agentId}` && <Badge variant="default" className="text-[10px] h-4 px-1">启用</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{sa.description}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] text-muted-foreground">{sa.model}</span>
                      {sa.toolCount > 0 && <span className="text-[10px] text-muted-foreground">· {sa.toolCount} 工具</span>}
                      {sa.categories?.length > 0 && sa.categories.map(c => (
                        <span key={c} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{c}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
                    {isInstalled ? (
                      <button
                        onClick={(e) => handleUninstall(e, sa.agentId)}
                        disabled={isInstalling}
                        className="p-1.5 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        title="卸载"
                      >
                        {isInstalling ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <PackageCheck className="w-3.5 h-3.5" />
                        )}
                      </button>
                    ) : (
                      <button
                        onClick={(e) => handleInstall(e, sa.agentId)}
                        disabled={isInstalling}
                        className="p-1.5 rounded-lg hover:bg-primary/10 text-muted-foreground hover:text-primary transition-colors"
                        title="安装"
                      >
                        {isInstalling ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <PackageOpen className="w-3.5 h-3.5" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={(e) => handleDownload(e, sa.agentId)}
                      className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                      title="下载"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
                </div>
                )
              })}
            </div>
          </div>
        )}

        {/* MCP TAB */}
        {activeTab === 'mcp' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">MCP 服务</Label>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setShowMCPAdd(true)}>
                <Plus className="w-3 h-3" />添加
              </Button>
            </div>
            <div className="bg-muted/40 rounded-lg p-2.5 text-xs text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">MCP (Model Context Protocol) 真实工具调用</p>
              <p>• <span className="text-green-500">内置工具</span>（builtin://）：直接在浏览器运行，无需配置</p>
              <p>• <span className="text-blue-500">自建服务</span>（http://）：填写你的 MCP Server 地址，系统自动发现工具并执行</p>
              <p>• 启用后 AI 可真实调用工具，不只是文字描述</p>
            </div>
            {mcpServices.map((service) => (
              <div key={service.id} className={`p-3 rounded-xl border transition-all ${service.enabled ? 'border-primary/40 bg-primary/5' : 'border-border'}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <Wrench className={`w-4 h-4 ${service.enabled ? 'text-primary' : 'text-muted-foreground'}`} />
                    <span className="text-sm font-medium">{service.name}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Switch checked={service.enabled} onCheckedChange={() => toggleMCPService(service.id)} />
                    <button className="p-1 rounded hover:bg-muted ml-1" onClick={() => removeMCPService(service.id)} title="删除">
                      <X className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mb-1">{service.description}</p>
                <p className="text-[10px] text-muted-foreground font-mono">{service.endpoint}</p>
                {service.enabled && service.tools.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {service.tools.map((tool) => (
                      <Badge key={tool.name} variant="secondary" className="text-[10px] h-4">{tool.name}</Badge>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* PLUGINS TAB */}
        {activeTab === 'plugins' && (
          <div className="p-4 space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 text-xs text-amber-700 dark:text-amber-400">
              插件安装状态已持久化保存。已安装的插件会在对话中显示为可用工具标识。
            </div>
            {installedPlugins.length > 0 && (
              <div>
                <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 block">已安装 ({installedPlugins.length})</Label>
                <div className="space-y-2">
                  {installedPlugins.map((plugin) => (
                    <div key={plugin.id} className="flex items-center gap-3 p-3 rounded-xl border border-primary/20 bg-primary/5">
                      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xl shrink-0">
                        {plugin.icon}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className="text-sm font-medium truncate">{plugin.name}</span>
                          <Badge variant="success" className="text-[9px] h-3.5 px-1">已安装</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{plugin.description}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                            <Star className="w-2.5 h-2.5 text-yellow-500 fill-yellow-500" />{plugin.rating}
                          </span>
                          <span className="text-[10px] text-muted-foreground">v{plugin.version}</span>
                        </div>
                      </div>
                      <Button size="sm" variant="outline" className="h-7 text-xs shrink-0 text-destructive border-destructive/30 hover:bg-destructive hover:text-destructive-foreground" onClick={() => togglePlugin(plugin.id)}>
                        卸载
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {installedPlugins.length > 0 && <Separator />}

            <div>
              <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3 block">可用插件 ({availablePlugins.length})</Label>
              <div className="space-y-2">
                {availablePlugins.map((plugin) => (
                  <div key={plugin.id} className="flex items-center gap-3 p-3 rounded-xl border border-border hover:bg-muted/30 transition-colors">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center text-xl shrink-0">
                      {plugin.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">{plugin.name}</span>
                      <p className="text-xs text-muted-foreground truncate">{plugin.description}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                          <Star className="w-2.5 h-2.5 text-yellow-500 fill-yellow-500" />{plugin.rating}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{plugin.downloads.toLocaleString()} 安装</span>
                      </div>
                    </div>
                    <Button size="sm" variant="default" className="h-7 text-xs shrink-0" onClick={() => togglePlugin(plugin.id)}>
                      安装
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Add MCP Dialog */}
      <Dialog open={showMCPAdd} onOpenChange={setShowMCPAdd}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>添加 MCP 服务</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>服务名称</Label>
              <Input value={mcpForm.name} onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })} placeholder="如: 文件读写" />
            </div>
            <div className="space-y-1.5">
              <Label>端点 URL</Label>
              <Input value={mcpForm.endpoint} onChange={(e) => setMcpForm({ ...mcpForm, endpoint: e.target.value })} placeholder="mcp://your-service" />
            </div>
            <div className="space-y-1.5">
              <Label>描述</Label>
              <Input value={mcpForm.description} onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value })} placeholder="服务描述" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowMCPAdd(false)}>取消</Button>
            <Button onClick={() => {
              if (!mcpForm.name || !mcpForm.endpoint) return
              // 真实添加到 store
              useChatStore.getState().addMCPService({
                id: `mcp-${Date.now()}`,
                name: mcpForm.name,
                endpoint: mcpForm.endpoint,
                description: mcpForm.description,
                enabled: false,
                tools: [],
              })
              setShowMCPAdd(false)
              setMcpForm({ name: '', endpoint: '', description: '' })
            }} disabled={!mcpForm.name || !mcpForm.endpoint}>
              添加服务
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Agent Edit Dialog */}
      <Dialog open={showAgentEdit} onOpenChange={setShowAgentEdit}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{editingAgent ? '编辑 Agent' : '新建 Agent'}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1.5">
                <Label>图标</Label>
                <Input value={agentForm.icon} onChange={e => setAgentForm({ ...agentForm, icon: e.target.value })} className="text-center text-lg" maxLength={2} />
              </div>
              <div className="col-span-3 space-y-1.5">
                <Label>名称 <span className="text-destructive">*</span></Label>
                <Input value={agentForm.name} onChange={e => setAgentForm({ ...agentForm, name: e.target.value })} placeholder="Agent 名称" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>描述</Label>
              <Input value={agentForm.description} onChange={e => setAgentForm({ ...agentForm, description: e.target.value })} placeholder="简短描述" />
            </div>
            <div className="space-y-1.5">
              <Label>系统提示词 <span className="text-destructive">*</span></Label>
              <textarea value={agentForm.systemPrompt} onChange={e => setAgentForm({ ...agentForm, systemPrompt: e.target.value })} placeholder="定义 Agent 的角色和行为..." className="w-full h-28 text-xs p-2 rounded-lg border bg-muted/30 focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
            </div>
            <div className="space-y-1.5">
              <Label>使用模型</Label>
              <select value={agentForm.model} onChange={e => setAgentForm({ ...agentForm, model: e.target.value })} className="w-full text-sm p-2 rounded-lg border bg-background focus:outline-none focus:ring-1 focus:ring-primary">
                {availableModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>工具列表</Label>
              <Input value={agentForm.tools} onChange={e => setAgentForm({ ...agentForm, tools: e.target.value })} placeholder="工具名，逗号分隔（如：search,code-exec）" />
              <p className="text-[10px] text-muted-foreground">填写后端已注册的工具名，Agent 运行时可调用这些工具</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>温度 ({agentForm.temperature})</Label>
                <input type="range" min="0" max="2" step="0.1" value={agentForm.temperature} onChange={e => setAgentForm({ ...agentForm, temperature: Number(e.target.value) })} className="w-full" />
              </div>
              <div className="space-y-1.5">
                <Label>最大 Token</Label>
                <Input type="number" value={agentForm.maxTokens} onChange={e => setAgentForm({ ...agentForm, maxTokens: Number(e.target.value) })} />
              </div>
            </div>
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setShowAgentEdit(false)}>取消</Button>
            <Button onClick={() => {
              if (!agentForm.name || !agentForm.systemPrompt) return
              const toolsArray = agentForm.tools ? agentForm.tools.split(',').map(t => t.trim()).filter(Boolean) : []
              if (editingAgent) {
                updateAgent(editingAgent.id, { ...agentForm, tools: toolsArray })
              } else {
                addAgent({ ...agentForm, id: `agent-${Date.now()}`, tools: toolsArray })
              }
              setShowAgentEdit(false)
            }} disabled={!agentForm.name || !agentForm.systemPrompt}>
              {editingAgent ? '保存修改' : '创建 Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Agent Template Dialog */}
      <Dialog open={showTemplateDialog} onOpenChange={setShowTemplateDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>从模板创建 Agent</DialogTitle></DialogHeader>
          <div className="space-y-2 mt-2">
            {getAgentTemplates().map((tpl) => (
              <button
                key={tpl.displayName}
                className="w-full flex items-center gap-3 p-3 rounded-xl border border-border hover:border-primary/40 hover:bg-muted/50 text-left transition-all"
                onClick={() => {
                  const agent = manifestToAgentApp({
                    specVersion: '1.0.0',
                    agentId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    displayName: tpl.displayName,
                    description: tpl.description,
                    icon: tpl.icon,
                    systemPrompt: tpl.systemPrompt,
                    model: tpl.model || 'gpt-4o',
                    temperature: tpl.temperature ?? 0.7,
                    maxTokens: tpl.maxTokens ?? 4096,
                    tools: tpl.tools || [],
                    toolDefinitions: tpl.toolDefinitions,
                    hooks: tpl.hooks,
                  })
                  addAgent(agent)
                  setShowTemplateDialog(false)
                }}
              >
                <span className="text-2xl">{tpl.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{tpl.displayName}</div>
                  <p className="text-xs text-muted-foreground line-clamp-2">{tpl.description}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">{tpl.model} · T={tpl.temperature}{(tpl.tools?.length ?? 0) > 0 ? ` · ${tpl.tools!.length} 工具` : ''}</p>
                </div>
                <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTemplateDialog(false)}>关闭</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Agent 开放平台文档 */}
      <AgentDocsDialog open={showAgentDocs} onOpenChange={setShowAgentDocs} />

      {/* Agent 详情弹窗 */}
      <AgentDetailDialog
        open={!!detailAgentId}
        onOpenChange={(open) => { if (!open) { setDetailAgentId(null); setDetailListItem(undefined) } }}
        agentId={detailAgentId}
        listItem={detailListItem}
        onUse={(agentId, detail) => {
          const sa = serverAgents.find(a => a.agentId === agentId)
          if (!sa) return
          // 优先用详情中的完整信息，回退到列表基本信息
          const systemPrompt = detail?.systemPrompt || ''
          const tools = detail?.tools?.map(t => t.name) || []
          const temperature = detail?.temperature ?? 0.1
          const maxTokens = detail?.maxTokens ?? 8192
          const toolDefinitions = detail?.tools?.map(t => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters || {},
          })) || []
          const agentApp = {
            id: `server:${agentId}`,
            name: sa.name,
            description: detail?.description || sa.description || '',
            icon: sa.icon || '🤖',
            systemPrompt,
            model: detail?.model || sa.model,
            tools,
            temperature,
            maxTokens,
            agentType: 'custom' as const,
            manifest: {
              specVersion: '1.0.0',
              agentId,
              displayName: sa.name,
              description: detail?.description || sa.description || '',
              icon: sa.icon || '🤖',
              systemPrompt,
              model: detail?.model || sa.model,
              temperature,
              maxTokens,
              tools,
              toolDefinitions,
            },
          }
          setActiveAgent(activeAgent?.id === `server:${agentId}` ? null : agentApp)
        }}
      />
      </div>
    </>
  )
}
