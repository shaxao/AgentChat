import { useState, useEffect, useCallback } from 'react'
import {
  Search, Loader2, Sparkles, LayoutGrid, ArrowRight,
  Play, CheckCircle2, Star, TrendingUp, Users,
  Workflow, Clock, PauseCircle, AlertCircle,
  Globe, Building2, RefreshCw, Plus, Edit, Trash2, User,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import ScenarioFormDialog from '@/components/scenario/ScenarioFormDialog'
import { scenarioApi, type ScenarioBrief, type ScenarioDetail, type ProfessionGroup, type WorkflowTemplateBrief } from '@/lib/api'
import { useChatStore } from '@/store'
import type { AppPage } from '@/App'

interface ScenarioSquarePageProps {
  onNavigate: (page: AppPage) => void
}

// 职业分组的中文标签和颜色映射
const PROFESSION_META: Record<string, { label: string; color: string }> = {
  '餐饮业': { label: '餐饮业', color: 'from-orange-500 to-red-500' },
  '开发者': { label: '开发者', color: 'from-blue-500 to-cyan-500' },
  '数据':   { label: '数据',   color: 'from-emerald-500 to-teal-500' },
  '创作者': { label: '创作者', color: 'from-purple-500 to-pink-500' },
  '管理':   { label: '管理',   color: 'from-slate-500 to-slate-700' },
  '教育':   { label: '教育',   color: 'from-amber-500 to-yellow-500' },
}

function getProfessionLabel(profession: string): string {
  return PROFESSION_META[profession]?.label || profession
}

function getProfessionColor(profession: string): string {
  return PROFESSION_META[profession]?.color || 'from-slate-400 to-slate-500'
}

// 渲染图标：支持 emoji 和图片 URL
function renderIcon(icon: string | undefined) {
  if (icon && icon.startsWith('http')) {
    return <img src={icon} alt="icon" className="w-full h-full rounded-xl object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
  }
  return <>{icon || '🎯'}</>
}

export default function ScenarioSquarePage({ onNavigate }: ScenarioSquarePageProps) {
  const [professions, setProfessions] = useState<ProfessionGroup[]>([])
  const [scenarios, setScenarios] = useState<ScenarioBrief[]>([])
  const [activeProfession, setActiveProfession] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState<string | null>(null)

  // 详情弹窗
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<ScenarioDetail | null>(null)
  const [activating, setActivating] = useState(false)
  const [activateSuccess, setActivateSuccess] = useState(false)
  const [activateWorkflowCount, setActivateWorkflowCount] = useState(0)

  // P2-3: 社区 Tab 状态
  const [tab, setTab] = useState<'official' | 'community' | 'my'>('official')
  const [toggling, setToggling] = useState<number | null>(null)

  // 创建场景弹窗（复用管理后台表单）
  const [createOpen, setCreateOpen] = useState(false)

  // 编辑/删除
  const [editOpen, setEditOpen] = useState(false)
  const [editId, setEditId] = useState<number | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null)

  // 加载职业分组
  const loadProfessions = useCallback(async () => {
    try {
      const data = await scenarioApi.listProfessions()
      setProfessions(data)
    } catch {
      // 忽略，professions 为空时 fallback 到从 scenarios 中提取
    }
  }, [])

  // 加载场景列表（官方）
  const loadScenarios = useCallback(async (profession?: string) => {
    setLoading(true)
    setPageError(null)
    try {
      const data = await scenarioApi.list(profession || undefined)
      setScenarios(data)
    } catch (e: any) {
      setPageError(e.message || '加载失败')
      setScenarios([])
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载社区公开场景
  const loadCommunityScenarios = useCallback(async () => {
    setLoading(true)
    setPageError(null)
    try {
      const data = await scenarioApi.listCommunity()
      setScenarios(data)
    } catch (e: any) {
      setPageError(e.message || '加载失败')
      setScenarios([])
    } finally {
      setLoading(false)
    }
  }, [])

  // 加载我的场景
  const loadMyScenarios = useCallback(async () => {
    setLoading(true)
    setPageError(null)
    try {
      const data = await scenarioApi.listMy()
      setScenarios(data)
    } catch (e: any) {
      setPageError(e.message || '加载失败')
      setScenarios([])
    } finally {
      setLoading(false)
    }
  }, [])

  // 搜索
  const handleSearch = useCallback(async () => {
    const q = searchQuery.trim()
    if (!q) {
      loadScenarios(activeProfession || undefined)
      return
    }
    setLoading(true)
    setPageError(null)
    try {
      const data = await scenarioApi.search(q)
      setScenarios(data)
    } catch (e: any) {
      setPageError(e.message || '搜索失败')
    } finally {
      setLoading(false)
    }
  }, [searchQuery, activeProfession, loadScenarios])

  useEffect(() => { loadProfessions() }, [loadProfessions])
  useEffect(() => {
    if (tab === 'official') {
      loadScenarios(activeProfession || undefined)
    } else if (tab === 'my') {
      loadMyScenarios()
    } else {
      loadCommunityScenarios()
    }
  }, [activeProfession, tab, loadScenarios, loadCommunityScenarios, loadMyScenarios])

  // 筛选职业
  const handleProfessionClick = (profession: string) => {
    setActiveProfession(p => p === profession ? '' : profession)
    setSearchQuery('')
  }

  // 切换 Tab
  const handleTabChange = (newTab: 'official' | 'community' | 'my') => {
    setTab(newTab)
    setSearchQuery('')
    setActiveProfession('')
  }

  // 创建/编辑场景成功后刷新列表
  const handleCreateSuccess = () => {
    if (tab === 'community') loadCommunityScenarios()
    else if (tab === 'my') loadMyScenarios()
    else loadScenarios(activeProfession || undefined)
  }

  // 编辑我的场景
  const handleEdit = (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    setEditId(id)
    setEditOpen(true)
  }

  // 删除我的场景
  const handleDeleteClick = (e: React.MouseEvent, id: number, name: string) => {
    e.stopPropagation()
    setDeleteTarget({ id, name })
    setDeleteOpen(true)
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      await scenarioApi.delete(deleteTarget.id)
      loadMyScenarios()
    } catch (err) {
      console.error('删除场景失败:', err)
    } finally {
      setDeleteOpen(false)
      setDeleteTarget(null)
    }
  }

  // 切换公开/私有
  const handleTogglePublic = async (e: React.MouseEvent, id: number) => {
    e.stopPropagation()
    setToggling(id)
    try {
      const res = await scenarioApi.togglePublic(id)
      setScenarios(prev => prev.map(s => s.id === id ? { ...s, isPublic: res.isPublic } : s))
    } catch (err) {
      console.error('切换公开失败:', err)
    } finally {
      setToggling(null)
    }
  }

  // 打开详情
  const handleOpenDetail = async (scenario: ScenarioBrief) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    setActivateSuccess(false)
    setActivateWorkflowCount(0)
    try {
      const d = await scenarioApi.detail(scenario.id)
      setDetail(d)
    } catch (e: any) {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }

  // 激活场景
  const handleActivate = async () => {
    if (!detail) return
    setActivating(true)
    try {
      const res = await scenarioApi.activate(detail.id)
      const scenarioSnapshot = {
        id: detail.id,
        name: detail.name,
        icon: detail.icon,
        profession: res.profession || detail.profession,
        description: detail.description,
        systemPrompt: res.systemPrompt,
        recommendedSkills: res.recommendedSkills || [],
        workflowTemplates: res.workflowTemplates || [],
        workflowCount: res.workflowCount ?? (res.workflowTemplates?.length || 0),
      }
      const convId = useChatStore.getState().createConversation(`${detail.name} 场景对话`)
      useChatStore.getState().setActiveConversation(convId)

      // 1) 设置 system prompt
      if (res.systemPrompt) {
        useChatStore.getState().setModelSettings({ systemPrompt: res.systemPrompt })
      }

      // 2) 保存激活的场景身份
      useChatStore.getState().setActiveScenario(scenarioSnapshot)

      // 3) 安装推荐技能（标记为 installed）
      if (res.recommendedSkills && res.recommendedSkills.length > 0) {
        res.recommendedSkills.forEach(skillId => {
          const latest = useChatStore.getState()
          if (!latest.installedSkillIds.includes(skillId)) {
            latest.addInstalledSkill(skillId)
          }
        })
        useChatStore.getState().setActiveSkillIds(res.recommendedSkills)
      }

      useChatStore.getState().updateConversation(convId, {
        tags: [`scenario:${detail.id}`],
        activeScenario: scenarioSnapshot,
        activeSkillIds: res.recommendedSkills || [],
        scenarioSkillIds: res.recommendedSkills || [],
        scenarioWorkflowIds: (res.workflowTemplates || []).map(w => w.id),
      })

      // P2-2: 存储工作流上下文，后续对话可引用
      const workflowCount = res.workflowCount ?? 0
      setActivateWorkflowCount(workflowCount)

      setActivateSuccess(true)
      // 短暂延迟后跳转到对话
      setTimeout(() => {
        setDetailOpen(false)
        onNavigate('chat')
      }, 800)
    } catch (e: any) {
      console.error('激活场景失败:', e)
    } finally {
      setActivating(false)
    }
  }

  // 按职业分组 scenarios
  const groupedScenarios = scenarios.reduce<Record<string, ScenarioBrief[]>>((acc, s) => {
    const key = s.profession || '其他'
    if (!acc[key]) acc[key] = []
    acc[key].push(s)
    return acc
  }, {})

  // 提取 profession 列表
  // 社区 Tab：始终从实际加载的社区场景中提取分类，避免显示官方数据的错误分类
  // 官方 Tab：优先使用 API 返回的 professions，空时从当前场景列表 fallback
  const deriveProfessions = () =>
    Object.entries(groupedScenarios).map(([profession, list]) => ({
      profession,
      label: getProfessionLabel(profession),
      count: list.length,
    }))
  const displayProfessions = tab === 'official' && professions.length > 0
    ? professions
    : deriveProfessions()

  const totalScenarios = scenarios.length
  const totalProfessions = displayProfessions.length

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-background to-muted/20">
      {/* ─── Hero 横幅 ─── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-primary/8 via-primary/4 to-transparent border-b border-border/50">
        <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-7xl mx-auto">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <LayoutGrid className="w-6 h-6 text-primary" />
                场景广场
              </h1>
              <p className="text-sm text-muted-foreground mt-1.5">
                选择你的工作场景，AI 自动配置专属助手——告别手动调 Prompt
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 shrink-0"
              onClick={() => setCreateOpen(true)}
            >
              <Plus className="w-4 h-4" />创建场景
            </Button>
          </div>

          {/* 统计面板 */}
          <div className="flex flex-wrap gap-3 sm:gap-6 mt-5">
            {[
              { label: '场景数量', value: totalScenarios, icon: <LayoutGrid className="w-4 h-4" /> },
              { label: '职业领域', value: totalProfessions, icon: <Users className="w-4 h-4" /> },
            ].map((s, i) => (
              <div key={i} className="flex items-center gap-2.5 bg-card/70 backdrop-blur-sm rounded-xl px-4 py-2.5 border border-border/40">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  {s.icon}
                </div>
                <div>
                  <div className="text-lg font-bold leading-tight">{s.value}</div>
                  <div className="text-[11px] text-muted-foreground">{s.label}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ─── Tab 切换：官方 / 社区 ─── */}
      <div className="px-4 sm:px-6 border-b border-border/50 bg-card/30">
        <div className="max-w-7xl mx-auto flex gap-0">
          <button
            onClick={() => handleTabChange('official')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'official'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Building2 className="w-4 h-4" />官方场景
          </button>
          <button
            onClick={() => handleTabChange('community')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'community'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Globe className="w-4 h-4" />社区
          </button>
          <button
            onClick={() => handleTabChange('my')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'my'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <User className="w-4 h-4" />我的场景
          </button>
        </div>
      </div>

      {/* ─── 搜索 + 职业筛选 ─── */}
      <div className="px-4 sm:px-6 py-4 border-b border-border/50 bg-card/30">
        <div className="max-w-7xl mx-auto flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜索场景名称、职业..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="pl-9 h-10 text-sm"
              />
            </div>
            <Button onClick={handleSearch} disabled={loading} size="sm" className="h-10 px-5">
              搜索
            </Button>
          </div>

          {/* 职业分类标签 */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
            <Badge
              variant={activeProfession === '' ? 'default' : 'outline'}
              className="cursor-pointer shrink-0 px-3 py-1 text-xs"
              onClick={() => handleProfessionClick('')}
            >全部</Badge>
            {displayProfessions.map(p => (
              <Badge
                key={p.profession}
                variant={activeProfession === p.profession ? 'default' : 'outline'}
                className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                onClick={() => handleProfessionClick(p.profession)}
              >{p.label} ({p.count})</Badge>
            ))}
          </div>
        </div>
      </div>

      {/* ─── 场景卡片区域 ─── */}
      <div className="mobile-scroll-bottom-safe flex-1 overflow-auto px-4 sm:px-6 py-4 max-w-7xl mx-auto w-full">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : pageError ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <p className="text-sm text-red-500">{pageError}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => loadScenarios(activeProfession || undefined)}>
              重试
            </Button>
          </div>
        ) : scenarios.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
            <LayoutGrid className="w-10 h-10 mb-2 opacity-30" />
            <p className="text-sm">暂无场景</p>
            <p className="text-xs">换个关键词试试</p>
          </div>
        ) : activeProfession ? (
          // 有筛选：直接网格展示
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {scenarios.map(s => (
              <ScenarioCard key={s.id} scenario={s} onClick={() => handleOpenDetail(s)}
                showPublicBadge={tab === 'community'}
                onTogglePublic={tab === 'community' ? handleTogglePublic : undefined}
                showEditDelete={tab === 'my'}
                onEdit={tab === 'my' ? handleEdit : undefined}
                onDelete={tab === 'my' ? handleDeleteClick : undefined}
                toggling={toggling}
              />
            ))}
          </div>
        ) : (
          // 无筛选：按职业分组展示
          <div className="flex flex-col gap-8">
            {Object.entries(groupedScenarios).map(([profession, list]) => (
              <div key={profession}>
                <div className="flex items-center gap-2 mb-3">
                  <div className={`h-6 w-1 rounded-full bg-gradient-to-b ${getProfessionColor(profession)}`} />
                  <h2 className="text-sm font-semibold">{getProfessionLabel(profession)}</h2>
                  <span className="text-xs text-muted-foreground">{list.length} 个场景</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {list.map(s => (
                    <ScenarioCard key={s.id} scenario={s} onClick={() => handleOpenDetail(s)}
                      showPublicBadge={tab === 'community'}
                      onTogglePublic={tab === 'community' ? handleTogglePublic : undefined}
                      showEditDelete={tab === 'my'}
                      onEdit={tab === 'my' ? handleEdit : undefined}
                      onDelete={tab === 'my' ? handleDeleteClick : undefined}
                      toggling={toggling}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ─── 创建场景弹窗（复用管理后台表单） ─── */}
      <ScenarioFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        isAdmin={false}
        onSuccess={handleCreateSuccess}
      />

      {/* ─── 编辑场景弹窗 ─── */}
      <ScenarioFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        isAdmin={false}
        editingId={editId}
        onSuccess={handleCreateSuccess}
      />

      {/* ─── 删除确认弹窗 ─── */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>确认删除场景</DialogTitle>
            <DialogDescription>
              确定要删除场景「{deleteTarget?.name}」吗？此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>取消</Button>
            <Button variant="destructive" onClick={handleDeleteConfirm}>确认删除</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── 详情弹窗 ─── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-[95vw] sm:max-w-lg max-h-[85vh] overflow-y-auto">
          {detailLoading ? (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">场景详情</DialogTitle>
              </DialogHeader>
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            </>
          ) : detail ? (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div className={`w-11 h-11 rounded-xl bg-gradient-to-br ${getProfessionColor(detail.profession)} flex items-center justify-center text-2xl shadow-sm text-white`}>
                    {renderIcon(detail.icon)}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle className="text-lg flex items-center gap-1.5">
                      {detail.name}
                      {detail.isOfficial && (
                        <Badge className="text-[10px] h-4 px-1.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                          <Star className="w-2.5 h-2.5 mr-0.5" />官方
                        </Badge>
                      )}
                    </DialogTitle>
                    <DialogDescription className="text-xs mt-0.5">
                      {getProfessionLabel(detail.profession)} · {detail.usageCount || 0} 次使用
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <p className="text-sm text-muted-foreground leading-relaxed mt-2">
                {detail.description}
              </p>

              <Separator />

              {/* System Prompt 预览 */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  系统提示词
                </h4>
                <div className="bg-muted/50 rounded-lg p-3 text-xs leading-relaxed max-h-32 overflow-y-auto text-muted-foreground font-mono whitespace-pre-wrap">
                  {detail.systemPrompt || '（无）'}
                </div>
              </div>

              {/* 推荐技能 */}
              {detail.recommendedSkills && detail.recommendedSkills.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                    推荐技能
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.recommendedSkills.map(skill => (
                      <Badge key={skill} variant="secondary" className="text-[10px]">
                        {skill}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              {/* 关联工作流模板（P2-2） */}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                  关联工作流 · {detail.workflowCount ?? 0} 个
                </h4>
                {detail.workflowTemplates && detail.workflowTemplates.length > 0 ? (
                  <div className="space-y-2">
                    {detail.workflowTemplates.map((wt) => (
                      <WorkflowTemplateCard key={wt.id} template={wt} />
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">暂无关联工作流</p>
                )}
              </div>

              <DialogFooter className="gap-2 sm:gap-2">
                <Button variant="outline" onClick={() => setDetailOpen(false)}>
                  关闭
                </Button>
                {activateSuccess ? (
                  <Button disabled className="gap-1.5">
                    <CheckCircle2 className="w-4 h-4" /> 已激活{activateWorkflowCount > 0 ? ` · ${activateWorkflowCount} 个工作流` : ''}，跳转中…
                  </Button>
                ) : (
                  <Button onClick={handleActivate} disabled={activating} className="gap-1.5">
                    {activating ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Play className="w-4 h-4" />
                    )}
                    激活此场景
                  </Button>
                )}
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">场景详情</DialogTitle>
              </DialogHeader>
              <div className="text-center py-8 text-muted-foreground text-sm">
                加载场景详情失败
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── 场景卡片 ─────────────────────────────
function ScenarioCard({ scenario, onClick, showPublicBadge, onTogglePublic, toggling, showEditDelete, onEdit, onDelete }: {
  scenario: ScenarioBrief
  onClick: () => void
  showPublicBadge?: boolean
  onTogglePublic?: (e: React.MouseEvent, id: number) => void
  toggling?: number | null
  showEditDelete?: boolean
  onEdit?: (e: React.MouseEvent, id: number) => void
  onDelete?: (e: React.MouseEvent, id: number, name: string) => void
}) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 border-border/60 overflow-hidden flex flex-col group"
      onClick={onClick}
    >
      <CardContent className="p-4 flex-1 flex flex-col gap-3">
        {/* 头部：图标 + 名称 */}
        <div className="flex items-start gap-2.5">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${getProfessionColor(scenario.profession)} flex items-center justify-center text-xl shrink-0 text-white shadow-sm`}>
            {renderIcon(scenario.icon)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{scenario.name}</h3>
              {scenario.isOfficial && (
                <Badge className="text-[9px] h-3.5 px-1 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
                  <Star className="w-2 h-2 mr-0.5" />官方
                </Badge>
              )}
              {showPublicBadge && scenario.isPublic && !scenario.isOfficial && (
                <Badge className="text-[9px] h-3.5 px-1 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 shrink-0">
                  <Globe className="w-2 h-2 mr-0.5" />公开
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{getProfessionLabel(scenario.profession)}</p>
          </div>
        </div>

        {/* 描述 */}
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{scenario.description}</p>

        {/* 底部：使用次数 + 操作 */}
        <div className="flex items-center justify-between mt-auto pt-2 border-t border-border/30 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-0.5">
            <TrendingUp className="w-3 h-3" />{scenario.usageCount || 0} 次使用
          </span>
          <div className="flex items-center gap-1">
            {showEditDelete && onEdit && onDelete && (
              <>
                <button
                  onClick={(e) => onEdit(e, scenario.id)}
                  className="p-0.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                  title="编辑场景"
                >
                  <Edit className="w-3 h-3" />
                </button>
                <button
                  onClick={(e) => onDelete(e, scenario.id, scenario.name)}
                  className="p-0.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="删除场景"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </>
            )}
            {onTogglePublic && (
              <button
                onClick={(e) => onTogglePublic(e, scenario.id)}
                disabled={toggling === scenario.id}
                className={`flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
                  scenario.isPublic
                    ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
                title={scenario.isPublic ? '设为私有' : '设为公开'}
              >
                {toggling === scenario.id ? (
                  <Loader2 className="w-2.5 h-2.5 animate-spin" />
                ) : scenario.isPublic ? (
                  <Globe className="w-2.5 h-2.5" />
                ) : (
                  <Globe className="w-2.5 h-2.5" />
                )}
                {scenario.isPublic ? '公开中' : '私有'}
              </button>
            )}
            <span className="flex items-center gap-0.5 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
              查看详情 <ArrowRight className="w-3 h-3" />
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 工作流模板卡片（P2-2） ─────────────────────────────
function WorkflowTemplateCard({ template }: { template: WorkflowTemplateBrief }) {
  const statusConfig: Record<string, { icon: React.ReactNode; label: string; cls: string }> = {
    active: { icon: <Clock className="w-3 h-3" />, label: '运行中', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
    paused: { icon: <PauseCircle className="w-3 h-3" />, label: '已暂停', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400' },
    error: { icon: <AlertCircle className="w-3 h-3" />, label: '异常', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' },
  }
  const sc = statusConfig[template.status] || statusConfig.paused

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border/50 p-2.5 hover:bg-muted/30 transition-colors">
      <div className="w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-900/20 flex items-center justify-center text-blue-600 shrink-0 mt-0.5">
        <Workflow className="w-3.5 h-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{template.name}</span>
          <Badge className={`text-[9px] h-3.5 px-1 shrink-0 ${sc.cls}`}>
            {sc.icon} {sc.label}
          </Badge>
        </div>
        {template.description && (
          <p className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{template.description}</p>
        )}
      </div>
    </div>
  )
}
