import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Search, Plus, Loader2, Sparkles, TrendingUp,
  LayoutGrid, Star, Zap, ArrowRight, Flame,
  PackageOpen, PackageCheck, Edit3, Trash2, User, Store,
  FileEdit, Send,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { agentRegistryApi, chatApi, isDemoMode, type AgentRegistryItem, type AgentStoreStats } from '@/lib/api'
import { cn } from '@/lib/utils'
import AgentDetailDialog from '@/components/agent/AgentDetailDialog'
import AgentRegisterDialog from '@/components/agent/AgentRegisterDialog'
import SkillEditDialog from '@/components/skill/SkillEditDialog'
import { useChatStore } from '@/store'
import type { MainView } from '@/components/layout/IconNavBar'
import type { AgentRegistryDetail } from '@/lib/api'
import { useToast } from '@/components/ui/toast'

const PAGE_SIZE = 12

export default function SkillStoreView({ onNavigate }: { onNavigate?: (view: MainView) => void }) {
  const { toast } = useToast()
  const [agents, setAgents] = useState<AgentRegistryItem[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [stats, setStats] = useState<AgentStoreStats | null>(null)
  const [activeCategory, setActiveCategory] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(true)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [statsLoading, setStatsLoading] = useState(true)
  const [searchError, setSearchError] = useState<string | null>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  const [detailOpen, setDetailOpen] = useState(false)
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null)
  const [detailItem, setDetailItem] = useState<AgentRegistryItem | null>(null)
  const [showRegister, setShowRegister] = useState(false)
  const [installingIds, setInstallingIds] = useState<Set<string>>(new Set())
  const { installedSkillIds, addInstalledSkill, removeInstalledSkill, setActiveSkillIds, setActiveScenario } = useChatStore()

  // 我的技能
  type ViewMode = 'market' | 'my-skills'
  const [viewMode, setViewMode] = useState<ViewMode>('market')
  const [mySkills, setMySkills] = useState<AgentRegistryItem[]>([])
  const [mySkillsLoading, setMySkillsLoading] = useState(false)
  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editItem, setEditItem] = useState<AgentRegistryDetail | null>(null)
  const [editLoading, setEditLoading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  
  // 文件编辑对话框
  const [editFileDialogOpen, setEditFileDialogOpen] = useState(false)
  const [editFileAgentId, setEditFileAgentId] = useState<string | null>(null)
  const [reviewSubmittingIds, setReviewSubmittingIds] = useState<Set<string>>(new Set())

  const isSkillUsable = (status?: string) => status === 'approved' || status === 'active'

  const featuredAgents = useMemo(() => {
    return [...agents].sort((a, b) => (b.totalUsage || 0) - (a.totalUsage || 0)).slice(0, 6)
  }, [agents])

  const loadAgents = useCallback(async (pageNum: number, category: string, append = false) => {
    if (append) setLoadingMore(true)
    else setLoading(true)
    try {
      const result = await agentRegistryApi.list({
        page: pageNum, size: PAGE_SIZE, category: category || undefined,
      })
      const list = result.list || result.content || []
      if (append) {
        setAgents(prev => {
          const existingIds = new Set(prev.map(a => a.agentId))
          const newItems = list.filter((item: AgentRegistryItem) => !existingIds.has(item.agentId))
          return [...prev, ...newItems]
        })
      } else {
        // 同页去重
        const seen = new Set<string>()
        const deduped = list.filter((item: AgentRegistryItem) => {
          if (seen.has(item.agentId)) return false
          seen.add(item.agentId)
          return true
        })
        setAgents(deduped)
      }
      const totalItems = result.total || 0
      const totalPages = Math.ceil(totalItems / PAGE_SIZE)
      setHasMore(pageNum < totalPages)
    } catch (e) {
      console.error('加载技能市场失败:', e)
    } finally {
      setLoading(false)
      setLoadingMore(false)
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
  // 初始加载
  useEffect(() => {
    setPage(1)
    setHasMore(true)
    loadAgents(1, activeCategory, false)
  }, [activeCategory, loadAgents])

  // 监听技能编辑命令事件（来自聊天命令 /edit-skill）
  useEffect(() => {
    const handleEditCommand = async (event: CustomEvent) => {
      const { skillIdentifier } = event.detail
      if (!skillIdentifier) return
      
      try {
        // 调用技能匹配API
        const matches = await agentRegistryApi.matchSkill(skillIdentifier)
        
        if (!matches || matches.length === 0) {
          alert(`未找到匹配的技能: ${skillIdentifier}`)
          return
        }
        
        // 取第一个匹配结果
        const match = matches[0]
        
        // 获取技能详情以检查权限
        const detail = await agentRegistryApi.getDetail(match.agentId)
        
        if (!detail) {
          alert(`获取技能详情失败: ${match.agentId}`)
          return
        }
        
        // 检查权限（只能编辑自己的技能）
        const currentUserId = localStorage.getItem('userId') || undefined
        const isOwner = currentUserId && detail.createdBy === parseInt(currentUserId)
        const isAdmin = localStorage.getItem('userRole') === 'ADMIN'
        
        if (!isOwner && !isAdmin) {
          alert(`您只能编辑自己创建的技能。此技能由用户ID ${detail.createdBy} 创建。`)
          return
        }
        
        // 打开文件编辑对话框
        setEditFileAgentId(match.agentId)
        setEditFileDialogOpen(true)
        
      } catch (error: any) {
        console.error('[SkillStoreView] 处理编辑命令失败:', error)
        alert(`处理编辑命令失败: ${error.message || '未知错误'}`)
      }
    }
    
    window.addEventListener('skill-edit-command', handleEditCommand as any)
    
    return () => {
      window.removeEventListener('skill-edit-command', handleEditCommand as any)
    }
  }, [])
  
  // 监听技能查看命令事件（来自聊天命令 /view-skill）
  useEffect(() => {
    const handleViewCommand = async (event: CustomEvent) => {
      const { skillIdentifier } = event.detail
      if (!skillIdentifier) return
      
      try {
        // 调用技能匹配API
        const matches = await agentRegistryApi.matchSkill(skillIdentifier)
        
        if (!matches || matches.length === 0) {
          alert(`未找到匹配的技能: ${skillIdentifier}`)
          return
        }
        
        // 取第一个匹配结果，打开详情对话框
        const match = matches[0]
        setDetailAgentId(match.agentId)
        setDetailOpen(true)
        
      } catch (error: any) {
        console.error('[SkillStoreView] 处理查看命令失败:', error)
        alert(`处理查看命令失败: ${error.message || '未知错误'}`)
      }
    }
    
    window.addEventListener('skill-view-command', handleViewCommand as any)
    
    return () => {
      window.removeEventListener('skill-view-command', handleViewCommand as any)
    }
  }, [])

  // 无限滚动：仅在非搜索模式且还有更多数据时启用
  const loadMore = useCallback(() => {
    if (loadingMore || !hasMore || searchQuery.trim()) return  // 搜索模式下禁用无限滚动
    const nextPage = page + 1
    setPage(nextPage)
    loadAgents(nextPage, activeCategory, true)
  }, [loadingMore, hasMore, page, activeCategory, loadAgents, searchQuery])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) loadMore() },
      { rootMargin: '200px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore, agents.length])


  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setPage(1)
      setSearchError(null)
      loadAgents(1, activeCategory)
      return
    }
    setLoading(true)
    setSearchError(null)
    try {
      const result = await agentRegistryApi.search(searchQuery, 1, PAGE_SIZE)
      const list = result.list || result.content || []
      setAgents(list)
      const totalPages = Math.ceil((result.total || 0) / PAGE_SIZE)
      setHasMore(totalPages > 1)
    } catch (err) {
      console.error('[SkillStore] 搜索失败:', err)
      setSearchError('搜索请求失败，请稍后重试')
      setAgents([])
      setHasMore(false)
    } finally {
      setPage(1)
      setLoading(false)
    }
  }

  const handleCategoryClick = (cat: string) => {
    setActiveCategory(cat === activeCategory ? '' : cat)
    setPage(1)
    setSearchQuery('')
    setSearchError(null)
  }

  // "查看更多" — 平滑滚动到全部技能区域
  const handleViewMore = () => {
    gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleInstall = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    const agent = [...agents, ...mySkills].find(a => a.agentId === agentId)
    if (agent && !isSkillUsable(agent.status)) {
      toast({ title: 'Skill 尚未通过审核', description: '待审核通过后才能安装和使用。', variant: 'destructive' })
      return
    }
    setInstallingIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.install(agentId)
      addInstalledSkill(agentId)
    } catch (err) {
      console.warn('安装技能失败:', err)
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleUninstall = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    setInstallingIds(prev => new Set(prev).add(agentId))
    try {
      await agentRegistryApi.uninstall(agentId)
      removeInstalledSkill(agentId)
    } catch (err) {
      console.warn('卸载技能失败:', err)
    } finally {
      setInstallingIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  const handleUseSkill = async (agentId: string, detail?: AgentRegistryDetail | null) => {
    if (detail && !isSkillUsable(detail.status)) {
      toast({ title: 'Skill 尚未通过审核', description: '待审核通过后才能开始使用。', variant: 'destructive' })
      return
    }
    try {
      if (!installedSkillIds.includes(agentId)) {
        await agentRegistryApi.install(agentId)
        addInstalledSkill(agentId)
      }
    } catch {
      // 已安装或安装状态不同步时，仍允许进入对话尝试使用。
    }

    const title = detail?.name ? `${detail.name} 对话` : 'Skill 对话'
    setActiveScenario(null)
    setActiveSkillIds([agentId])

    if (isDemoMode()) {
      const id = useChatStore.getState().createConversation(title)
      useChatStore.getState().updateConversation(id, {
        activeSkillIds: [agentId],
        activeScenario: null,
        scenarioSkillIds: undefined,
        scenarioWorkflowIds: undefined,
      })
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
        toast({ title: '创建对话失败', description: e?.message || '请稍后重试', variant: 'destructive' })
        return
      }
    }
    setDetailOpen(false)
    onNavigate?.('chat')
  }

  // ── 我的技能 ──
  const loadMySkills = useCallback(async () => {
    setMySkillsLoading(true)
    try {
      const list = await agentRegistryApi.listMy()
      setMySkills(list || [])
    } catch (e) {
      console.error('加载我的技能失败:', e)
    } finally {
      setMySkillsLoading(false)
    }
  }, [])

  const handleEdit = async (agentId: string) => {
    setEditLoading(true)
    try {
      const detail = await agentRegistryApi.getDetail(agentId)
      setEditItem(detail)
      setEditDialogOpen(true)
    } catch (e) {
      console.error('加载技能详情失败:', e)
    } finally {
      setEditLoading(false)
    }
  }

  const handleDelete = async (agentId: string) => {
    setDeletingId(agentId)
    try {
      await agentRegistryApi.delete(agentId)
      setMySkills(prev => prev.filter(s => s.agentId !== agentId))
    } catch (e) {
      console.error('删除技能失败:', e)
    } finally {
      setDeletingId(null)
    }
  }

  const handleSubmitReview = async (e: React.MouseEvent, agentId: string) => {
    e.stopPropagation()
    setReviewSubmittingIds(prev => new Set(prev).add(agentId))
    try {
      const updated = await agentRegistryApi.submitReview(agentId)
      setMySkills(prev => prev.map(s => s.agentId === agentId ? { ...s, status: updated.status, reviewComment: updated.reviewComment, reviewedAt: updated.reviewedAt } : s))
      toast({ title: '已提交审核', description: '管理员审核通过后，该 Skill 才能被安装和使用。' })
    } catch (e: any) {
      toast({ title: '提交审核失败', description: e?.message || '请稍后重试', variant: 'destructive' })
    } finally {
      setReviewSubmittingIds(prev => {
        const next = new Set(prev)
        next.delete(agentId)
        return next
      })
    }
  }

  // 切换到"我的技能"时加载数据
  useEffect(() => {
    if (viewMode === 'my-skills') loadMySkills()
  }, [viewMode, loadMySkills])

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-background to-muted/20">
      {/* Hero 横幅区 */}
      <div className="relative overflow-hidden bg-gradient-to-r from-primary/8 via-primary/4 to-transparent border-b border-border/50">
        <div className="px-4 sm:px-6 py-3 sm:py-8 max-w-7xl mx-auto">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-2 sm:gap-0">
            <div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2">
                <Sparkles className="w-5 h-5 sm:w-6 sm:h-6 text-primary" />
                技能商店
              </h1>
              <p className="text-xs sm:text-sm text-muted-foreground mt-1 sm:mt-1.5">
                发现和添加 AI 技能，扩展你的智能助手能力
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* 视图切换 */}
              <div className="flex bg-muted rounded-lg p-0.5">
                <button
                  onClick={() => setViewMode('market')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                    viewMode === 'market' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Store className="w-3.5 h-3.5" />市场
                </button>
                <button
                  onClick={() => setViewMode('my-skills')}
                  className={cn(
                    'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                    viewMode === 'my-skills' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <User className="w-3.5 h-3.5" />我的技能
                </button>
              </div>
              <Button size="sm" onClick={() => setShowRegister(true)} className="shrink-0">
                <Plus className="w-4 h-4 mr-1.5" />发布技能
              </Button>
            </div>
          </div>

          {/* 统计面板 */}
          {!statsLoading && stats && (
            <div className="flex gap-3 sm:gap-6 mt-3 sm:mt-6 overflow-x-auto sm:flex-wrap pb-1 sm:pb-0 scrollbar-thin">
              {[
                { label: '上架技能', value: stats.totalAgents, icon: <LayoutGrid className="w-4 h-4" /> },
                { label: '技能分类', value: stats.totalCategories, icon: <Zap className="w-4 h-4" /> },
                { label: '累计使用', value: stats.totalUsage > 10000
                  ? (stats.totalUsage / 10000).toFixed(1) + '万'
                  : stats.totalUsage, icon: <TrendingUp className="w-4 h-4" /> },
                { label: '本周新增', value: stats.newThisWeek, icon: <Flame className="w-4 h-4 text-orange-500" /> },
              ].map((s, i) => (
                <div key={i} className="flex items-center gap-2.5 bg-card/70 backdrop-blur-sm rounded-xl px-4 py-2.5 border border-border/40 shrink-0">
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
      <div className="px-4 sm:px-6 py-2.5 sm:py-4 border-b border-border/50 bg-card/30">
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

      {/* ── 我的技能视图 ── */}
      {viewMode === 'my-skills' && (
        <div className="mobile-scroll-bottom-safe flex-1 overflow-auto px-4 sm:px-6 py-4 max-w-7xl mx-auto w-full">
          {mySkillsLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : mySkills.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <PackageOpen className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm">你还没有发布过技能</p>
              <p className="text-xs mt-1">点击右上角「发布技能」开始创建</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {mySkills.map(agent => (
                <div key={agent.agentId} className="relative group">
                  <SkillCard
                    agent={agent}
                    isInstalled={installedSkillIds.includes(agent.agentId)}
                    isInstalling={installingIds.has(agent.agentId)}
                    canUse={isSkillUsable(agent.status)}
                    onInstall={(e) => handleInstall(e, agent.agentId)}
                    onUninstall={(e) => handleUninstall(e, agent.agentId)}
                    onClick={() => {
                      setDetailAgentId(agent.agentId)
                      setDetailItem(agent)
                      setDetailOpen(true)
                    }}
                  />
                  {/* 编辑/删除按钮 */}
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    {agent.status !== 'pending' && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 bg-background/80 backdrop-blur-sm hover:bg-primary/10"
                        title={isSkillUsable(agent.status) ? '重新提交审核' : '提交审核'}
                        onClick={(e) => handleSubmitReview(e, agent.agentId)}
                        disabled={reviewSubmittingIds.has(agent.agentId)}
                      >
                        {reviewSubmittingIds.has(agent.agentId) ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      </Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm hover:bg-primary/10"
                      onClick={(e) => { e.stopPropagation(); handleEdit(agent.agentId) }}
                      disabled={editLoading}
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm hover:bg-blue-500/10 text-blue-500"
                      onClick={(e) => { e.stopPropagation(); setEditFileAgentId(agent.agentId); setEditFileDialogOpen(true) }}
                    >
                      <FileEdit className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 bg-background/80 backdrop-blur-sm hover:bg-destructive/10 text-destructive"
                      onClick={(e) => { e.stopPropagation(); handleDelete(agent.agentId) }}
                      disabled={deletingId === agent.agentId}
                    >
                      {deletingId === agent.agentId ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 技能市场视图 ── */}
      {viewMode === 'market' && (
        <div className="mobile-scroll-bottom-safe flex-1 overflow-auto">
          {/* 精选技能（仅首屏展示） */}
          {!loading && agents.length > 0 && page === 1 && !searchQuery && (
            <div className="px-4 sm:px-6 pt-4 sm:pt-6 pb-2 max-w-7xl mx-auto w-full">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold flex items-center gap-1.5">
                  <Star className="w-4 h-4 text-amber-500" />精选技能
                </h2>
                <Button variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground" onClick={handleViewMore}>
                  查看更多 <ArrowRight className="w-3 h-3" />
                </Button>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {featuredAgents.slice(0, 3).map(agent => (
                  <FeaturedCard
                    key={agent.agentId}
                    agent={agent}
                    isInstalled={installedSkillIds.includes(agent.agentId)}
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

          {/* 全部技能 */}
          <div ref={gridRef} className="px-4 sm:px-6 py-4 max-w-7xl mx-auto w-full scroll-mt-2">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <LayoutGrid className="w-4 h-4 text-primary" />全部技能
              </h2>
            </div>
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
                      isInstalled={installedSkillIds.includes(agent.agentId)}
                      isInstalling={installingIds.has(agent.agentId)}
                      canUse={isSkillUsable(agent.status)}
                      onInstall={(e) => handleInstall(e, agent.agentId)}
                      onUninstall={(e) => handleUninstall(e, agent.agentId)}
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
                    {searchError ? (
                      <>
                        <p className="text-sm text-destructive">{searchError}</p>
                        <p className="text-xs mt-1">请检查网络连接或稍后重试</p>
                      </>
                    ) : searchQuery.trim() ? (
                      <>
                        <p className="text-sm">未找到匹配的技能</p>
                        <p className="text-xs mt-1">试试其他关键词，或更换分类浏览</p>
                      </>
                    ) : (
                      <>
                        <p className="text-sm">暂无技能</p>
                        <p className="text-xs">成为第一个发布者吧！</p>
                      </>
                    )}
                  </div>
                )}

                {/* 无限滚动 sentinel */}
                {hasMore && agents.length > 0 && (
                  <div ref={sentinelRef} className="flex items-center justify-center py-8">
                    {loadingMore && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
                  </div>
                )}
                {!hasMore && agents.length > 0 && (
                  <div className="flex items-center justify-center py-6">
                    <span className="text-xs text-muted-foreground">— 已加载全部技能 —</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

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
          setViewMode('my-skills')
          loadMySkills()
          loadAgents(1, activeCategory)
          loadCategories()
          loadStats()
        }}
      />

      {/* 编辑弹窗 */}
      <AgentRegisterDialog
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        editItem={editItem}
        onSuccess={() => {
          setEditDialogOpen(false)
          setEditItem(null)
          loadMySkills()
          loadAgents(1, activeCategory)
          loadCategories()
          loadStats()
        }}
      />

      {/* 文件编辑弹窗 */}
      {editFileAgentId && (
        <SkillEditDialog
          open={editFileDialogOpen}
          onOpenChange={setEditFileDialogOpen}
          agentId={editFileAgentId}
        />
      )}
    </div>
  )
}

// ─── 精选技能卡片 ─────────────────────────────
function FeaturedCard({ agent, isInstalled, onClick }: { agent: AgentRegistryItem; isInstalled: boolean; onClick: () => void }) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 border-border/60 bg-gradient-to-br from-card to-primary/5"
      onClick={onClick}
    >
      <CardContent className="p-4 flex items-center gap-3">
        <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center text-2xl shrink-0 overflow-hidden">
          {agent.icon && (agent.icon.startsWith('http://') || agent.icon.startsWith('https://'))
            ? <img src={agent.icon} alt="" className="w-full h-full object-cover" />
            : (agent.icon || '🤖')}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
            {agent.isBuiltin && (
              <Badge variant="secondary" className="text-[9px] h-4 px-1 shrink-0">内置</Badge>
            )}
            {isInstalled && (
              <Badge variant="outline" className="text-[9px] h-4 px-1 shrink-0 text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700">已安装</Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{agent.description}</p>
          <div className="flex items-center gap-2 mt-1.5 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5"><TrendingUp className="w-3 h-3" />{agent.totalUsage || 0}</span>
            <span>{agent.author || '未知'}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ─── 技能卡片 ─────────────────────────────
function SkillCard({ agent, isInstalled, isInstalling, canUse, onInstall, onUninstall, onClick }: {
  agent: AgentRegistryItem
  isInstalled: boolean
  isInstalling: boolean
  canUse?: boolean
  onInstall: (e: React.MouseEvent) => void
  onUninstall: (e: React.MouseEvent) => void
  onClick: () => void
}) {
  const canUseSkill = canUse ?? (agent.status === 'approved' || agent.status === 'active')
  const statusConfig: Record<string, { label: string; className: string }> = {
    pending: { label: '待审核', className: 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800' },
    approved: { label: '已上架', className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800' },
    active: { label: '可使用', className: 'bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800' },
    rejected: { label: '已拒绝', className: 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800' },
    disabled: { label: '已禁用', className: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700' },
  }
  const status = statusConfig[agent.status] || { label: agent.status || '未知', className: 'bg-slate-100 text-slate-600 border-slate-200' }
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
      className="cursor-pointer hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 border-border/60 overflow-hidden flex flex-col group"
      onClick={onClick}
    >
      <CardContent className="p-4 flex-1 flex flex-col gap-2.5">
        <div className="flex items-start gap-2.5">
          <div className="w-10 h-10 rounded-xl bg-muted/70 flex items-center justify-center text-xl shrink-0 overflow-hidden">
            {agent.icon && (agent.icon.startsWith('http://') || agent.icon.startsWith('https://') || agent.icon.startsWith('/api/'))
              ? <img src={agent.icon} alt="" className="w-full h-full object-cover" />
              : (agent.icon || '🤖')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1">
              <h3 className="font-semibold text-sm truncate">{agent.name}</h3>
              {agent.isBuiltin && (
                <Badge variant="secondary" className="text-[9px] h-3.5 px-1 shrink-0">内置</Badge>
              )}
              <Badge variant="outline" className={cn('text-[9px] h-3.5 px-1 shrink-0', status.className)}>
                {status.label}
              </Badge>
              {isInstalled && (
                <Badge variant="outline" className="text-[9px] h-3.5 px-1 shrink-0 text-emerald-600 border-emerald-300 dark:text-emerald-400 dark:border-emerald-700">已安装</Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{agent.author || '未知作者'}</p>
          </div>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{agent.description}</p>
        <div className="flex flex-wrap gap-1 mt-auto">
          {agent.categories?.slice(0, 2).map(cat => (
            <Badge key={cat} className={`text-[10px] h-4 px-1.5 ${catColor(cat.trim())}`}>
              {cat.trim()}
            </Badge>
          ))}
        </div>
        <div className="flex items-center justify-between pt-1 border-t border-border/30">
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-0.5">
              <Zap className="w-3 h-3" />{agent.toolCount || 0} 工具
            </span>
            <span className="flex items-center gap-0.5">
              <TrendingUp className="w-3 h-3" />{agent.totalUsage || 0} 次
            </span>
          </div>
          <div className="opacity-0 group-hover:opacity-100 transition-opacity" onClick={e => e.stopPropagation()}>
            {isInstalled ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[10px] gap-1 text-destructive hover:bg-destructive/10"
                onClick={onUninstall}
                disabled={isInstalling}
              >
                {isInstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <PackageCheck className="w-3 h-3" />}
                卸载
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[10px] gap-1 text-primary hover:bg-primary/10"
                onClick={onInstall}
                disabled={isInstalling || !canUseSkill}
                title={!canUseSkill ? 'Pending review' : undefined}
              >
                {isInstalling ? <Loader2 className="w-3 h-3 animate-spin" /> : <PackageOpen className="w-3 h-3" />}
                安装
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
