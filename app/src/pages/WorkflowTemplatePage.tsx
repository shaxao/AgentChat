import { useState, useEffect, useCallback } from 'react'
import {
  Search, Loader2, Sparkles, LayoutGrid, ArrowRight,
  Star, TrendingUp, Users, Workflow, Clock, Globe,
  Building2, RefreshCw, Download, Upload, Copy,
  CheckCircle2, Plus, Trash2, Zap, Trophy, Medal, Crown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { cn } from '@/lib/utils'
import {
  workflowTemplateApi, creatorApi, workflowApi,
  type WorkflowTemplateBriefVO, type WorkflowTemplateVO,
  type TemplateSearchRequest, type TemplateCategory,
  type WorkflowBriefVO, type CreatorRankVO, type CreatorLeaderboardResponse,
} from '@/lib/api'

// ==================== 常量 ====================

type Tab = 'market' | 'leaderboard' | 'my-published'

const CATEGORY_ICONS: Record<string, string> = {
  '内容生成': '✍️',
  '数据分析': '📊',
  '开发运维': '🛠️',
  '社交媒体': '📱',
  '办公自动化': '📋',
  '监控告警': '🔍',
  '学习教育': '📚',
  '金融商业': '💰',
  '健康生活': '💪',
  '其他': '📦',
}

const SORT_OPTIONS: { value: TemplateSearchRequest['sort']; label: string }[] = [
  { value: 'hot', label: '热门' },
  { value: 'newest', label: '最新' },
  { value: 'rating', label: '评分最高' },
]

// ==================== 星级评分组件 ====================

function StarRating({ rating, interactive = false, onChange }: {
  rating: number
  interactive?: boolean
  onChange?: (v: number) => void
}) {
  const [hover, setHover] = useState(0)
  const display = hover || rating

  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          disabled={!interactive}
          onClick={() => onChange?.(star)}
          onMouseEnter={() => interactive && setHover(star)}
          onMouseLeave={() => interactive && setHover(0)}
          className={cn(
            'transition-colors',
            interactive ? 'cursor-pointer hover:scale-110' : 'cursor-default',
          )}
          style={{ background: 'none', border: 'none', padding: 0 }}
        >
          <Star
            className={cn(
              'w-4 h-4',
              star <= display
                ? 'fill-amber-400 text-amber-400'
                : 'fill-none text-muted-foreground/30',
            )}
          />
        </button>
      ))}
    </div>
  )
}

// ==================== 模板卡片 ====================

function TemplateCard({ template, onClick, onClone, onUnpublish, isMyTemplate }: {
  template: WorkflowTemplateBriefVO
  onClick: () => void
  onClone?: () => void
  onUnpublish?: () => void
  isMyTemplate?: boolean
}) {
  return (
    <Card
      className="cursor-pointer hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 border-border/60 overflow-hidden flex flex-col group"
      onClick={onClick}
    >
      <CardContent className="p-4 flex-1 flex flex-col gap-3">
        {/* 头部：图标 + 名称 */}
        <div className="flex items-start gap-2.5">
          <div className={cn(
            'w-10 h-10 rounded-xl flex items-center justify-center text-xl shrink-0 shadow-sm',
            template.isOfficial
              ? 'bg-gradient-to-br from-amber-400 to-orange-500 text-white'
              : 'bg-gradient-to-br from-blue-400 to-purple-500 text-white',
          )}>
            {CATEGORY_ICONS[template.category] || template.icon || '📋'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1 flex-wrap">
              <h3 className="font-semibold text-sm truncate">{template.name}</h3>
              {template.isOfficial && (
                <Badge className="text-[9px] h-3.5 px-1 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 shrink-0">
                  <Building2 className="w-2 h-2 mr-0.5" />官方
                </Badge>
              )}
              {template.isCertified && (
                <Badge className="text-[9px] h-3.5 px-1 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">
                  <CheckCircle2 className="w-2 h-2 mr-0.5" />认证
                </Badge>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{template.category || '未分类'}</p>
          </div>
        </div>

        {/* 描述 */}
        <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">{template.description}</p>

        {/* 评分 */}
        {template.rating > 0 && (
          <div className="flex items-center gap-1.5">
            <StarRating rating={template.rating} />
            <span className="text-[11px] text-muted-foreground">({template.ratingCount})</span>
          </div>
        )}

        {/* 底部信息 */}
        <div className="flex items-center justify-between mt-auto pt-2 border-t border-border/30 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-0.5">
              <TrendingUp className="w-3 h-3" />{template.useCount} 使用
            </span>
            {template.stepCount > 0 && (
              <span className="flex items-center gap-0.5">
                <Workflow className="w-3 h-3" />{template.stepCount} 步骤
              </span>
            )}
          </div>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {isMyTemplate && onUnpublish && (
              <button
                onClick={onUnpublish}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 transition-colors"
                title="取消发布"
              >
                <Trash2 className="w-2.5 h-2.5" />取消
              </button>
            )}
            {onClone && (
              <button
                onClick={onClone}
                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 transition-colors"
                title="克隆为工作流"
              >
                <Download className="w-2.5 h-2.5" />克隆
              </button>
            )}
            <span className="flex items-center gap-0.5 text-primary opacity-0 group-hover:opacity-100 transition-opacity">
              详情 <ArrowRight className="w-3 h-3" />
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// ==================== 克隆模板对话框 ====================

function CloneDialog({ open, onClose, template }: {
  open: boolean
  onClose: () => void
  template: WorkflowTemplateVO | null
}) {
  const [name, setName] = useState('')
  const [params, setParams] = useState<Record<string, string>>({})
  const [cloning, setCloning] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (open && template) {
      setName(template.name + ' (克隆)')
      setError('')
      setSuccess(false)
      // Parse params schema
      try {
        if (template.paramsSchema) {
          const schema = JSON.parse(template.paramsSchema)
          const initial: Record<string, string> = {}
          if (Array.isArray(schema)) {
            schema.forEach((p: any) => { initial[p.key || p.name] = p.default || '' })
          } else if (typeof schema === 'object') {
            Object.entries(schema).forEach(([k, v]) => { initial[k] = String(v) })
          }
          setParams(initial)
        } else {
          setParams({})
        }
      } catch {
        setParams({})
      }
    }
  }, [open, template])

  const handleClone = async () => {
    if (!template || !name.trim()) return
    setCloning(true)
    setError('')
    try {
      await workflowTemplateApi.clone(template.uuid, {
        name: name.trim(),
        params: Object.keys(params).length > 0 ? JSON.stringify(params) : undefined,
      })
      setSuccess(true)
      setTimeout(() => { onClose(); setSuccess(false) }, 1000)
    } catch (e: any) {
      setError(e.message || '克隆失败')
    }
    setCloning(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="w-5 h-5" />
            克隆模板为工作流
          </DialogTitle>
          <DialogDescription>
            将「{template?.name}」克隆到你的工作流列表
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <label className="text-sm font-medium">工作流名称</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="输入名称..."
              className="mt-1"
            />
          </div>

          {/* 参数输入 */}
          {Object.keys(params).length > 0 && (
            <div>
              <label className="text-sm font-medium mb-2 block">参数配置</label>
              <div className="space-y-2">
                {Object.entries(params).map(([key, value]) => (
                  <div key={key}>
                    <label className="text-[11px] text-muted-foreground mb-0.5 block">{key}</label>
                    <Input
                      value={value}
                      onChange={(e) => setParams((p) => ({ ...p, [key]: e.target.value }))}
                      placeholder={`输入 ${key}...`}
                      className="h-8 text-sm"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          {success ? (
            <Button disabled className="gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> 克隆成功
            </Button>
          ) : (
            <Button onClick={handleClone} disabled={cloning || !name.trim()}>
              {cloning && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              确认克隆
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ==================== 发布模板对话框 ====================

function PublishDialog({ open, onClose, onPublished }: {
  open: boolean
  onClose: () => void
  onPublished: () => void
}) {
  const [workflows, setWorkflows] = useState<WorkflowBriefVO[]>([])
  const [loadingWfs, setLoadingWfs] = useState(false)
  const [selectedWfId, setSelectedWfId] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [category, setCategory] = useState('')
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)

  useEffect(() => {
    if (open) {
      setLoadingWfs(true)
      workflowApi.list()
        .then(setWorkflows)
        .catch(() => setWorkflows([]))
        .finally(() => setLoadingWfs(false))
      setSelectedWfId(null)
      setName('')
      setDesc('')
      setCategory('')
      setError('')
      setSuccess(false)
    }
  }, [open])

  const handlePublish = async () => {
    if (!selectedWfId || !name.trim()) return
    setPublishing(true)
    setError('')
    try {
      await workflowTemplateApi.publish({
        workflowId: selectedWfId,
        name: name.trim(),
        description: desc.trim() || undefined,
        category: category || undefined,
      })
      setSuccess(true)
      setTimeout(() => { onClose(); setSuccess(false); onPublished() }, 1000)
    } catch (e: any) {
      setError(e.message || '发布失败')
    }
    setPublishing(false)
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            发布工作流为模板
          </DialogTitle>
          <DialogDescription>
            将你的工作流分享到模板市场，供其他用户使用
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* 选择工作流 */}
          <div>
            <label className="text-sm font-medium">选择工作流 *</label>
            {loadingWfs ? (
              <div className="flex items-center gap-2 mt-1 text-muted-foreground text-sm">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中...
              </div>
            ) : workflows.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">暂无可用工作流，请先创建</p>
            ) : (
              <select
                className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-background"
                value={selectedWfId || ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null
                  setSelectedWfId(id)
                  const wf = workflows.find(w => w.id === id)
                  if (wf) {
                    if (!name) setName(wf.name)
                    if (!desc) setDesc(wf.description || '')
                  }
                }}
              >
                <option value="">— 请选择 —</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label className="text-sm font-medium">模板名称 *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="模板名称" className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">描述</label>
            <Textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="描述模板用途..." rows={2} className="mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium">分类</label>
            <select
              className="w-full mt-1 border rounded-md px-3 py-2 text-sm bg-background"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">— 选择分类 —</option>
              {Object.entries(CATEGORY_ICONS).map(([key, icon]) => (
                <option key={key} value={key}>{icon} {key}</option>
              ))}
            </select>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          {success ? (
            <Button disabled className="gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> 发布成功
            </Button>
          ) : (
            <Button onClick={handlePublish} disabled={publishing || !selectedWfId || !name.trim()}>
              {publishing && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              确认发布
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ==================== 创作者排行榜 ====================

function LeaderboardView() {
  const [data, setData] = useState<CreatorLeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('month')

  const loadLeaderboard = useCallback(async (p: typeof period) => {
    setLoading(true)
    try {
      setData(await creatorApi.leaderboard(p, 20))
    } catch {
      setData(null)
    }
    setLoading(false)
  }, [])

  useEffect(() => { loadLeaderboard(period) }, [period, loadLeaderboard])

  const rankIcon = (rank: number) => {
    if (rank === 1) return <Crown className="w-5 h-5 text-amber-400" />
    if (rank === 2) return <Medal className="w-5 h-5 text-slate-400" />
    if (rank === 3) return <Medal className="w-5 h-5 text-amber-700" />
    return <span className="w-5 h-5 flex items-center justify-center text-xs font-bold text-muted-foreground">{rank}</span>
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Trophy className="w-5 h-5 text-amber-500" />
            创作者排行榜
          </h2>
          <p className="text-sm text-muted-foreground mt-1">技能创作者收益排行</p>
        </div>
        <div className="flex gap-1">
          {(['week', 'month', 'all'] as const).map((p) => (
            <Button
              key={p}
              variant={period === p ? 'default' : 'outline'}
              size="sm"
              onClick={() => setPeriod(p)}
            >
              {p === 'week' ? '本周' : p === 'month' ? '本月' : '全部'}
            </Button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : !data || data.rankings.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center py-12 gap-3">
            <Trophy className="w-12 h-12 text-muted-foreground/40" />
            <p className="text-muted-foreground">暂无排行数据</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data.rankings.map((r) => (
            <Card key={`${r.userId}-${r.agentId}`} className="hover:shadow-sm transition-shadow">
              <CardContent className="p-3 flex items-center gap-3">
                {/* 排名 */}
                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0">
                  {rankIcon(r.rank)}
                </div>
                {/* 信息 */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-sm truncate">{r.username}</span>
                    {r.certified && (
                      <Badge className="text-[9px] h-3.5 px-1 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 shrink-0">
                        <CheckCircle2 className="w-2 h-2 mr-0.5" />认证
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {r.agentName} · {r.useCount} 次使用
                  </p>
                </div>
                {/* 收益 */}
                <div className="text-right shrink-0">
                  <div className="text-sm font-semibold text-amber-600">¥{r.totalRevenue.toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground">总收益</div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

// ==================== 主页面 ====================

export default function WorkflowTemplatePage() {
  const [tab, setTab] = useState<Tab>('market')

  // === 市场列表状态 ===
  const [categories, setCategories] = useState<TemplateCategory[]>([])
  const [templates, setTemplates] = useState<WorkflowTemplateBriefVO[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [pageError, setPageError] = useState<string | null>(null)

  // === 筛选状态 ===
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState('')
  const [sort, setSort] = useState<TemplateSearchRequest['sort']>('hot')
  const [officialOnly, setOfficialOnly] = useState(false)
  const [page, setPage] = useState(1)
  const pageSize = 12

  // === 对话框状态 ===
  const [detailOpen, setDetailOpen] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detail, setDetail] = useState<WorkflowTemplateVO | null>(null)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneTarget, setCloneTarget] = useState<WorkflowTemplateVO | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)

  // === 我的发布状态 ===
  const [myTemplates, setMyTemplates] = useState<WorkflowTemplateBriefVO[]>([])
  const [myLoading, setMyLoading] = useState(false)

  // ========== 数据加载 ==========

  // 加载分类
  const loadCategories = useCallback(async () => {
    try {
      setCategories(await workflowTemplateApi.categories())
    } catch { /* fallback to extracting from templates */ }
  }, [])

  // 搜索/浏览模板
  const searchTemplates = useCallback(async (p?: number) => {
    setLoading(true)
    setPageError(null)
    const currentPage = p || page
    try {
      const req: TemplateSearchRequest = {
        keyword: searchQuery.trim() || undefined,
        category: activeCategory || undefined,
        official: officialOnly || undefined,
        sort,
        page: currentPage,
        pageSize,
      }
      const result = await workflowTemplateApi.search(req)
      setTemplates(result.items)
      setTotal(result.total)
      setPage(currentPage)
    } catch (e: any) {
      setPageError(e.message || '加载失败')
      setTemplates([])
    }
    setLoading(false)
  }, [searchQuery, activeCategory, officialOnly, sort, page, pageSize])

  // 加载我的发布
  const loadMyTemplates = useCallback(async () => {
    setMyLoading(true)
    try {
      const result = await workflowTemplateApi.search({ pageSize: 100 })
      // TODO: 后端需要支持 authorOnly 筛选，当前用自定义过滤模拟
      // 由于 API 不支持按用户筛选，这里显示所有模板（实际应后端支持）
      setMyTemplates(result.items.filter(t => !t.isOfficial)) // fallback
    } catch {
      setMyTemplates([])
    }
    setMyLoading(false)
  }, [])

  // ========== 初始加载 ==========
  useEffect(() => { loadCategories() }, [loadCategories])
  useEffect(() => {
    if (tab === 'market') searchTemplates(1)
    else if (tab === 'my-published') loadMyTemplates()
  }, [tab, searchTemplates, loadMyTemplates])

  // ========== 事件处理 ==========
  const handleSearch = () => {
    setPage(1)
    searchTemplates(1)
  }

  const handleOpenDetail = async (t: WorkflowTemplateBriefVO) => {
    setDetailOpen(true)
    setDetailLoading(true)
    setDetail(null)
    try {
      setDetail(await workflowTemplateApi.detail(t.uuid))
    } catch {
      setDetail(null)
    }
    setDetailLoading(false)
  }

  const handleClone = (t: WorkflowTemplateVO) => {
    setDetailOpen(false)
    setCloneTarget(t)
    setCloneOpen(true)
  }

  const handleUnpublish = async (t: WorkflowTemplateBriefVO) => {
    if (!confirm(`确定取消发布「${t.name}」？`)) return
    try {
      await workflowTemplateApi.unpublish(t.uuid)
      loadMyTemplates()
    } catch (e: any) { alert(e.message) }
  }

  // 从模板卡片直接克隆
  const handleDirectClone = async (t: WorkflowTemplateBriefVO) => {
    try {
      const detail = await workflowTemplateApi.detail(t.uuid)
      setCloneTarget(detail)
      setCloneOpen(true)
    } catch (e: any) { alert(e.message) }
  }

  // 统计信息
  const deriveCategories = categories.length > 0
    ? categories
    : (() => {
        const map = new Map<string, number>()
        templates.forEach(t => {
          const cat = t.category || '其他'
          map.set(cat, (map.get(cat) || 0) + 1)
        })
        return Array.from(map.entries()).map(([key, count]) => ({
          key, label: key, icon: CATEGORY_ICONS[key] || '📦', count,
        }))
      })()

  return (
    <div className="flex flex-col h-full bg-gradient-to-b from-background to-muted/20">
      {/* ─── Hero 横幅 ─── */}
      <div className="relative overflow-hidden bg-gradient-to-r from-primary/8 via-primary/4 to-transparent border-b border-border/50">
        <div className="px-4 sm:px-6 py-6 sm:py-8 max-w-7xl mx-auto">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <LayoutGrid className="w-6 h-6 text-primary" />
                工作流模板市场
              </h1>
              <p className="text-sm text-muted-foreground mt-1.5">
                浏览官方和社区模板，一键克隆到你的工作流，快速搭建自动化流程
              </p>
            </div>
            <Button onClick={() => setPublishOpen(true)} className="gap-1.5 shrink-0">
              <Upload className="w-4 h-4" /> 发布我的工作流
            </Button>
          </div>

          {/* 统计面板 */}
          <div className="flex flex-wrap gap-3 sm:gap-6 mt-5">
            {[
              { label: '模板总数', value: total || templates.length, icon: <LayoutGrid className="w-4 h-4" /> },
              { label: '分类数量', value: deriveCategories.length, icon: <Workflow className="w-4 h-4" /> },
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

      {/* ─── Tab 切换 ─── */}
      <div className="px-6 border-b border-border/50 bg-card/30">
        <div className="max-w-7xl mx-auto flex gap-0">
          <button
            onClick={() => setTab('market')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'market'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Globe className="w-4 h-4" />模板市场
          </button>
          <button
            onClick={() => setTab('leaderboard')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'leaderboard'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Trophy className="w-4 h-4" />创作者排行
          </button>
          <button
            onClick={() => setTab('my-published')}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'my-published'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <Upload className="w-4 h-4" />我的发布
          </button>
        </div>
      </div>

      {/* ─── Tab Content ─── */}
      {tab === 'market' && (
        <>
          {/* 搜索 + 筛选 */}
          <div className="px-6 py-4 border-b border-border/50 bg-card/30">
            <div className="max-w-7xl mx-auto flex flex-col gap-3">
              <div className="flex gap-2">
                <div className="flex-1 relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="搜索模板名称、描述..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    className="pl-9 h-10 text-sm"
                  />
                </div>
                <Button onClick={handleSearch} disabled={loading} size="sm" className="h-10 px-5">
                  搜索
                </Button>
              </div>

              {/* 筛选行 */}
              <div className="flex items-center gap-2 flex-wrap">
                {/* 官方筛选 */}
                <Badge
                  variant={officialOnly ? 'default' : 'outline'}
                  className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                  onClick={() => { setOfficialOnly(!officialOnly); setPage(1) }}
                >
                  <Building2 className="w-3 h-3 mr-1" />官方
                </Badge>

                {/* 排序 */}
                <div className="flex gap-1">
                  {SORT_OPTIONS.map((opt) => (
                    <Badge
                      key={opt.value}
                      variant={sort === opt.value ? 'default' : 'outline'}
                      className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                      onClick={() => { setSort(opt.value); setPage(1) }}
                    >
                      {sort === opt.value && <CheckCircle2 className="w-3 h-3 mr-1" />}
                      {opt.label}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* 分类标签 */}
              <div className="flex gap-1.5 overflow-x-auto pb-1 scrollbar-thin">
                <Badge
                  variant={activeCategory === '' ? 'default' : 'outline'}
                  className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                  onClick={() => { setActiveCategory(''); setPage(1) }}
                >全部</Badge>
                {deriveCategories.map((c) => (
                  <Badge
                    key={c.key}
                    variant={activeCategory === c.key ? 'default' : 'outline'}
                    className="cursor-pointer shrink-0 px-3 py-1 text-xs"
                    onClick={() => { setActiveCategory(c.key); setPage(1) }}
                  >{c.icon} {c.label} ({c.count})</Badge>
                ))}
              </div>
            </div>
          </div>

          {/* 模板卡片区域 */}
          <div className="mobile-scroll-bottom-safe flex-1 overflow-auto px-6 py-4 max-w-7xl mx-auto w-full">
            {loading ? (
              <div className="flex items-center justify-center h-48">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : pageError ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <p className="text-sm text-red-500">{pageError}</p>
                <Button variant="outline" size="sm" className="mt-2" onClick={() => searchTemplates(1)}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />重试
                </Button>
              </div>
            ) : templates.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
                <LayoutGrid className="w-10 h-10 mb-2 opacity-30" />
                <p className="text-sm">暂无模板</p>
                <p className="text-xs">换个关键词试试，或发布你的工作流</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                  {templates.map((t) => (
                    <TemplateCard
                      key={t.uuid}
                      template={t}
                      onClick={() => handleOpenDetail(t)}
                      onClone={() => handleDirectClone(t)}
                    />
                  ))}
                </div>

                {/* 分页 */}
                {total > pageSize && (
                  <div className="flex items-center justify-center gap-2 mt-6">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => { setPage(page - 1); searchTemplates(page - 1) }}
                    >
                      上一页
                    </Button>
                    <span className="text-sm text-muted-foreground">
                      第 {page} / {Math.ceil(total / pageSize)} 页（共 {total} 个）
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={page >= Math.ceil(total / pageSize)}
                      onClick={() => { setPage(page + 1); searchTemplates(page + 1) }}
                    >
                      下一页
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}

      {/* === 创作者排行榜 Tab === */}
      {tab === 'leaderboard' && <LeaderboardView />}

      {/* === 我的发布 Tab === */}
      {tab === 'my-published' && (
        <div className="mobile-scroll-bottom-safe flex-1 overflow-auto px-6 py-4 max-w-7xl mx-auto w-full">
          {myLoading ? (
            <div className="flex items-center justify-center h-48">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : myTemplates.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
              <Upload className="w-10 h-10 mb-2 opacity-30" />
              <p className="text-sm">还没有发布任何模板</p>
              <Button variant="outline" size="sm" className="mt-2" onClick={() => setPublishOpen(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />发布工作流
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {myTemplates.map((t) => (
                <TemplateCard
                  key={t.uuid}
                  template={t}
                  onClick={() => handleOpenDetail(t)}
                  onUnpublish={() => handleUnpublish(t)}
                  isMyTemplate
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ─── 全局对话框 ─── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          {detailLoading ? (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">模板详情</DialogTitle>
              </DialogHeader>
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            </>
          ) : detail ? (
            <DetailDialogContent
              template={detail}
              onClose={() => setDetailOpen(false)}
              onClone={(t) => { setDetailOpen(false); setCloneTarget(t); setCloneOpen(true) }}
              onRated={loadCategories}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle className="sr-only">模板详情</DialogTitle>
              </DialogHeader>
              <div className="text-center py-8 text-muted-foreground text-sm">
                加载模板详情失败
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <CloneDialog
        open={cloneOpen}
        onClose={() => setCloneOpen(false)}
        template={cloneTarget}
      />

      <PublishDialog
        open={publishOpen}
        onClose={() => setPublishOpen(false)}
        onPublished={() => loadMyTemplates()}
      />
    </div>
  )
}

// ==================== 详情对话框内容（供外部 Dialog 包裹使用） ====================

function DetailDialogContent({ template, onClose, onClone, onRated }: {
  template: WorkflowTemplateVO
  onClose: () => void
  onClone: (t: WorkflowTemplateVO) => void
  onRated: () => void
}) {
  const [rating, setRating] = useState(0)
  const [ratingLoading, setRatingLoading] = useState(false)

  const handleRate = async (v: number) => {
    setRatingLoading(true)
    try {
      await workflowTemplateApi.rate(template.uuid, v)
      setRating(v)
      onRated()
    } catch (e: any) {
      console.error('评分失败:', e)
    }
    setRatingLoading(false)
  }

  return (
    <>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-11 h-11 rounded-xl flex items-center justify-center text-2xl shadow-sm text-white',
            template.isOfficial
              ? 'bg-gradient-to-br from-amber-400 to-orange-500'
              : 'bg-gradient-to-br from-blue-400 to-purple-500',
          )}>
            {CATEGORY_ICONS[template.category] || template.icon || '📋'}
          </div>
          <div className="min-w-0">
            <DialogTitle className="text-lg flex items-center gap-1.5">
              {template.name}
              {template.isOfficial && (
                <Badge className="text-[10px] h-4 px-1.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                  <Building2 className="w-2.5 h-2.5 mr-0.5" />官方
                </Badge>
              )}
              {template.isCertified && (
                <Badge className="text-[10px] h-4 px-1.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                  <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />认证
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs mt-0.5">
              {template.category || '未分类'} · 作者: {template.authorName || '未知'} · {template.useCount || 0} 次使用
            </DialogDescription>
          </div>
        </div>
      </DialogHeader>

      <p className="text-sm text-muted-foreground leading-relaxed mt-2">
        {template.description}
      </p>

      <Separator />

      {/* DSL 预览 */}
      {template.dsl && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            工作流 DSL
          </h4>
          <pre className="bg-muted/50 rounded-lg p-3 text-xs leading-relaxed max-h-32 overflow-y-auto text-muted-foreground font-mono whitespace-pre-wrap">
            {(() => {
              try { return JSON.stringify(JSON.parse(template.dsl), null, 2) }
              catch { return template.dsl }
            })()}
          </pre>
        </div>
      )}

      {/* 参数 Schema */}
      {template.paramsSchema && (
        <div>
          <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
            可配置参数
          </h4>
          <div className="bg-muted/50 rounded-lg p-3 text-xs space-y-1">
            {(() => {
              try {
                const schema = JSON.parse(template.paramsSchema)
                if (Array.isArray(schema)) {
                  return schema.map((p: any, i: number) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="font-mono text-primary">{p.key || p.name}</span>
                      <span className="text-muted-foreground">{p.label || p.description || ''}</span>
                      {p.default && <Badge variant="outline" className="text-[9px] h-3.5">默认: {p.default}</Badge>}
                    </div>
                  ))
                }
                return Object.entries(schema).map(([key, val]) => (
                  <div key={key} className="flex items-center gap-2">
                    <span className="font-mono text-primary">{key}</span>
                    <span className="text-muted-foreground">{String(val)}</span>
                  </div>
                ))
              } catch { return <span className="text-muted-foreground">{template.paramsSchema}</span> }
            })()}
          </div>
        </div>
      )}

      {/* 评分 */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
          评分
        </h4>
        <div className="flex items-center gap-3">
          <StarRating rating={template.rating || 0} interactive onChange={handleRate} />
          <span className="text-xs text-muted-foreground">
            ({template.ratingCount || 0} 人评价{ratingLoading && <Loader2 className="w-3 h-3 inline animate-spin ml-1" />})
          </span>
        </div>
      </div>

      <DialogFooter className="gap-2 sm:gap-2">
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
        <Button onClick={() => onClone(template)} className="gap-1.5">
          <Download className="w-4 h-4" /> 克隆为工作流
        </Button>
      </DialogFooter>
    </>
  )
}
