import { useState, useEffect, useCallback, useMemo } from 'react'
import {
  Search, Plus, Loader2, Sparkles, TrendingUp,
  LayoutGrid, Star, Zap, ArrowRight, Flame,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { agentRegistryApi, chatApi, isDemoMode, type AgentRegistryDetail, type AgentRegistryItem, type AgentStoreStats } from '@/lib/api'
import type { AppPage } from '@/App'
import AgentDetailDialog from '@/components/agent/AgentDetailDialog'
import AgentRegisterDialog from '@/components/agent/AgentRegisterDialog'
import { StarRating } from '@/components/ui/star-rating'
import { useChatStore } from '@/store'

interface AgentMarketPageProps {
  onNavigate: (page: AppPage) => void
}

const PAGE_SIZE = 12

export default function AgentMarketPage({ onNavigate }: AgentMarketPageProps) {
  const [agents, setAgents] = useState<AgentRegistryItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [stats, setStats] = useState<AgentStoreStats | null>(null)
  const [activeCategory, setActiveCategory] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [loading, setLoading] = useState(true)
  const [statsLoading, setStatsLoading] = useState(true)

  // 详情弹窗
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null)
  const [detailItem, setDetailItem] = useState<AgentRegistryItem | null>(null)

  // 注册弹窗
  const [showRegister, setShowRegister] = useState(false)
  const { installedSkillIds, addInstalledSkill, setActiveSkillIds, setActiveScenario } = useChatStore()

  // 精选技能（按使用次数排序前6）
  const featuredAgents = useMemo(() => {
    return [...agents].sort((a, b) => (b.totalUsage || 0) - (a.totalUsage || 0)).slice(0, 6)
  }, [agents])

  const loadAgents = useCallback(async (pageNum: number, category: string) => {
    setLoading(true)
    try {
      const result = await agentRegistryApi.list({
        page: pageNum, size: PAGE_SIZE, category: category || undefined,
      })
      const list = result.list || result.content || []
      setAgents(list)
      setTotalPages(Math.ceil((result.total || 0) / PAGE_SIZE))
    } catch (e) {
      console.error('加载技能市场失败:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadCategories = useCallback(async () => {
    try {
      const cats = await agentRegistryApi.getCategories()
      setCategories(cats)
    } catch { /* ignore */ }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const s = await agentRegistryApi.getStats()
      setStats(s)
    } catch { /* ignore */ }
    finally { setStatsLoading(false) }
  }, [])

  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => { loadStats() }, [loadStats])
  useEffect(() => { loadAgents(page, activeCategory) }, [page, activeCategory, loadAgents])

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadAgents(1, activeCategory)
      return
    }
    setLoading(true)
    try {
      const result = await agentRegistryApi.search(searchQuery, 1, PAGE_SIZE)
      const list = result.list || result.content || []
      setAgents(list)
      setTotalPages(Math.ceil((result.total || 0) / PAGE_SIZE))
      setPage(1)
    } catch (e) {
      console.error('搜索失败:', e)
    } finally { setLoading(false) }
  }

  const handleCategoryClick = (cat: string) => {
    setActiveCategory(cat === activeCategory ? '' : cat)
    setPage(1)
    setSearchQuery('')
  }

  const handleUseSkill = async (agentId: string, detail?: AgentRegistryDetail | null) => {
    try {
      if (!installedSkillIds.includes(agentId)) {
        await agentRegistryApi.install(agentId)
        addInstalledSkill(agentId)
      }
    } catch {
      // 忽略已安装等状态差异，继续尝试进入对话。
    }
    const title = detail?.name ? `${detail.name} 对话` : 'Skill 对话'
    setActiveScenario(null)
    setActiveSkillIds([agentId])
    if (isDemoMode()) {
      const id = useChatStore.getState().createConversation(title)
      useChatStore.getState().updateConversation(id, { activeSkillIds: [agentId], activeScenario: null })
      useChatStore.getState().setActiveConversation(id)
    } else {
      try {
        const conv = await chatApi.createConversation({ title, agentId })
        const { conversations } = useChatStore.getState()
        useChatStore.setState({
          conversations: [{
            id: conv.id,
            title: conv.title || title,
            model: conv.model || 'gpt-4o',
            messages: [],
            createdAt: conv.createdAt || new Date().toISOString(),
            updatedAt: conv.updatedAt || new Date().toISOString(),
            pinned: conv.pinned,
            activeSkillIds: [agentId],
            activeScenario: null,
          }, ...conversations],
          activeConversationId: conv.id,
          activeAgent: null,
          activeScenario: null,
          activeSkillIds: [agentId],
        })
      } catch (e: any) {
        alert('创建对话失败: ' + (e?.message || e))
        return
      }
    }
    setDetailOpen(false)
    onNavigate('chat')
  }

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-background to-muted/20">
      {/* Hero 横幅区 */}
      <div className="relative overflow-hidden bg-gradient-to-r from-primary/8 via-primary/4 to-transparent border-b border-border/50">
        <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-7xl mx-auto">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <Sparkles className="w-6 h-6 text-primary" />
                技能商店
              </h1>
              <p className="text-sm text-muted-foreground mt-1.5">
                发现和添加 AI 技能，扩展你的智能助手能力
              </p>
            </div>
            <Button size="sm" onClick={() => setShowRegister(true)} className="shrink-0">
              <Plus className="w-4 h-4 mr-1.5" />发布技能
            </Button>
          </div>

          {/* 统计面板 */}
          {!statsLoading && stats && (
            <div className="flex flex-wrap gap-3 sm:gap-6 mt-6">
              {[
                { label: '上架技能', value: stats.totalAgents, icon: <LayoutGrid className="w-4 h-4" /> },
                { label: '技能分类', value: stats.totalCategories, icon: <Zap className="w-4 h-4" /> },
                { label: '累计使用', value: stats.totalUsage > 10000
                  ? (stats.totalUsage / 10000).toFixed(1) + '万'
                  : stats.totalUsage, icon: <TrendingUp className="w-4 h-4" /> },
                { label: '本周新增', value: stats.newThisWeek, icon: <Flame className="w-4 h-4 text-orange-500" /> },
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
          )}
        </div>
      </div>

      {/* 搜索 + 分类 */}
      <div className="px-6 py-4 border-b border-border/50 bg-card/30">
        <div className="max-w-7xl mx-auto flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="搜索技能名称、描述、分类..."
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
          {/* 分类标签横向滚动 */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
            <Badge
              variant={activeCategory === '' ? 'default' : 'outline'}
              className="cursor-pointer shrink-0 px-3 py-1 text-xs"
              onClick={() => handleCategoryClick('')}
            >全部</Badge>
            {categories.map(cat => (
              <Badge
                key={cat}
                variant={activeCategory === cat ? 'default' : 'outline'}
                className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                onClick={() => handleCategoryClick(cat)}
              >{cat}</Badge>
            ))}
          </div>
        </div>
      </div>

      {/* 精选技能（仅首屏展示） */}
      {!loading && agents.length > 0 && page === 1 && !searchQuery && (
        <div className="px-6 pt-6 pb-2 max-w-7xl mx-auto w-full">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold flex items-center gap-1.5">
              <Star className="w-4 h-4 text-amber-500" />精选技能
            </h2>
            <Button variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground">
              查看更多 <ArrowRight className="w-3 h-3" />
            </Button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {featuredAgents.slice(0, 3).map(agent => (
              <FeaturedCard
                key={agent.agentId}
                agent={agent}
                onClick={() => {
                  setDetailAgentId(agent.agentId)
                  setDetailItem(agent)
                  setDetailOpen(true)
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* 技能卡片网格 */}
      <div className="flex-1 overflow-auto px-6 py-4 max-w-7xl mx-auto w-full">
        {loading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {agents.map(agent => (
                <SkillCard
                  key={agent.agentId}
                  agent={agent}
                  onClick={() => {
                    setDetailAgentId(agent.agentId)
                    setDetailItem(agent)
                    setDetailOpen(true)
                  }}
                />
              ))}
            </div>

            {agents.length === 0 && (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <LayoutGrid className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">暂无技能</p>
                <p className="text-xs">成为第一个发布者吧！</p>
              </div>
            )}

            {/* 分页 */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2 mt-6 pb-4">
                <Button
                  variant="outline" size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => p - 1)}
                >上一页</Button>
                <span className="text-sm text-muted-foreground px-3">
                  {page} / {totalPages}
                </span>
                <Button
                  variant="outline" size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => p + 1)}
                >下一页</Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* 详情弹窗 */}
      {detailAgentId && (
        <AgentDetailDialog
          open={detailOpen}
          onOpenChange={setDetailOpen}
          agentId={detailAgentId}
          listItem={detailItem || undefined}
          onUse={handleUseSkill}
        />
      )}

      {/* 注册弹窗 */}
      <AgentRegisterDialog
        open={showRegister}
        onOpenChange={setShowRegister}
        onSuccess={() => {
          setShowRegister(false)
          loadAgents(1, activeCategory)
          loadCategories()
          loadStats()
        }}
      />
    </div>
  )
}

// ─── 精选技能卡片 ─────────────────────────────
function FeaturedCard({ agent, onClick }: { agent: AgentRegistryItem; onClick: () => void }) {
  const isImageIcon = Boolean(agent.icon && (agent.icon.startsWith('http://') || agent.icon.startsWith('https://') || agent.icon.startsWith('/api/')))
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 border-border/60 bg-gradient-to-br from-card to-primary/5"
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-2xl shrink-0 overflow-hidden">
          {isImageIcon ? <img src={agent.icon} alt="" className="h-full w-full object-cover" /> : (agent.icon || '🤖')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
            {agent.isBuiltin && (
              <Badge variant="secondary" className="text-[9px] h-4 px-1 shrink-0">内置</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{agent.description}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><TrendingUp className="w-3 h-3" />{agent.totalUsage || 0}</span>
            <span>{agent.author || '未知'}</span>
            {agent.avgRating > 0 && (
              <StarRating value={agent.avgRating} readonly size={12} />
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 技能卡片 ─────────────────────────────
function SkillCard({ agent, onClick }: { agent: AgentRegistryItem; onClick: () => void }) {
  const isImageIcon = Boolean(agent.icon && (agent.icon.startsWith('http://') || agent.icon.startsWith('https://') || agent.icon.startsWith('/api/')))
  const catColor = (cat: string) => {
    const map: Record<string, string> = {
      '金融': 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
      '法律': 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      '教育': 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      '医疗': 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
      '办公': 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
      '开发': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400',
      '台账': 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
      'OCR': 'bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400',
      '工具': 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
      '开发助手': 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
    }
    return map[cat] || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
  }

  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 border-border/60 overflow-hidden flex flex-col"
      onClick={onClick}
    >
      <CardContent className="p-4 flex-1 flex flex-col gap-2.5">
        {/* 头部：图标 + 名称 + 作者 */}
        <div className="flex items-start gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-muted/70 flex items-center justify-center text-xl shrink-0 overflow-hidden">
            {isImageIcon ? <img src={agent.icon} alt="" className="h-full w-full object-cover" /> : (agent.icon || '🤖')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
              {agent.isBuiltin && (
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 shrink-0">内置</Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{agent.author || '未知作者'}</p>
          </div>
        </div>

        {/* 描述 */}
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{agent.description}</p>

        {/* 分类标签 */}
        <div className="flex flex-wrap gap-1 mt-auto">
          {agent.categories?.slice(0, 2).map(cat => (
            <Badge key={cat} className={`text-[10px] h-4 px-1.5 ${catColor(cat.trim())}`}>
              {cat.trim()}
            </Badge>
          ))}
        </div>

        {/* 底部统计 */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground pt-1 border-t border-border/30">
          <span className="flex items-center gap-0.5">
            <Zap className="w-3 h-3" />{agent.toolCount || 0} 工具
          </span>
          <span className="flex items-center gap-0.5">
            <TrendingUp className="w-3 h-3" />{agent.totalUsage || 0} 次
          </span>
        </div>

        {/* 评分展示 */}
        {agent.avgRating > 0 && (
          <div className="flex items-center gap-1.5">
            <StarRating value={agent.avgRating} readonly size={12} showValue />
            <span className="text-[10px] text-muted-foreground">{agent.ratingCount || 0} 评</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
