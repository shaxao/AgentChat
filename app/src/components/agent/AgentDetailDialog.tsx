import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { agentRegistryApi, type AgentRegistryDetail, BASE_URL } from '@/lib/api'
import { useChatStore } from '@/store'
import {
  X, Bot, Wrench, Cpu, Thermometer, Hash, Clock, User,
  Tag, ChevronRight, Loader2, BookOpen, Zap, Check, Star,
  PackageOpen, PackageCheck, Download, Copy, ClipboardCheck, MessageSquare,
} from 'lucide-react'
import { StarRating } from '@/components/ui/star-rating'
import { Textarea } from '@/components/ui/textarea'

interface AgentDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  agentId: string | null
  /** 如果已知列表信息，直接展示，无需额外请求 */
  listItem?: {
    agentId: string
    name: string
    description: string
    icon: string
    model: string
    isBuiltin: boolean
    toolCount: number
    categories: string[]
    author: string
    version: string
    status: string
    avgRating: number
    ratingCount: number
  }
  onUse?: (agentId: string, detail: AgentRegistryDetail | null) => void
}

export default function AgentDetailDialog({ open, onOpenChange, agentId, listItem, onUse }: AgentDetailDialogProps) {
  const [detail, setDetail] = useState<AgentRegistryDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeToolIdx, setActiveToolIdx] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [instCopied, setInstCopied] = useState(false)
  const { installedSkillIds, addInstalledSkill, removeInstalledSkill } = useChatStore()

  // ─── P2-3 评分 ───────────────────────
  const [myRating, setMyRating] = useState<number>(0)          // 当前用户的评分值
  const [myComment, setMyComment] = useState('')                // 当前用户的评论
  const [myRatingId, setMyRatingId] = useState<number | null>(null) // 当前用户的评分记录 ID
  const [ratingSubmitting, setRatingSubmitting] = useState(false)
  const [ratingList, setRatingList] = useState<Array<{
    id: number; userId: number; username: string; avatar: string
    rating: number; comment: string; createdAt: string
  }>>([])
  const [ratingTotal, setRatingTotal] = useState(0)
  const [ratingPage, setRatingPage] = useState(1)

  const isInstalled = agentId ? installedSkillIds.includes(agentId) : false

  useEffect(() => {
    if (open && agentId) {
      setLoading(true)
      setError(null)
      agentRegistryApi.getDetail(agentId)
        .then(d => setDetail(d))
        .catch(e => {
          console.warn('加载 Skill 详情失败:', e)
          setError('加载详情失败')
        })
        .finally(() => setLoading(false))
    }
    if (!open) {
      setDetail(null)
      setError(null)
      setActiveToolIdx(null)
    }
  }, [open, agentId])

  // 合并列表信息和详情
  const name = detail?.name || listItem?.name || ''
  const icon = detail?.icon || listItem?.icon || '🤖'
  const description = detail?.description || listItem?.description || ''
  const model = detail?.model || listItem?.model || ''
  const isBuiltin = detail?.isBuiltin ?? listItem?.isBuiltin ?? false
  const categories = detail?.categories || listItem?.categories || []
  const author = detail?.author || listItem?.author || ''
  const version = detail?.version || listItem?.version || ''
  const status = detail?.status || listItem?.status || ''
  const canUseSkill = status === 'approved' || status === 'active'

  const handleInstall = async () => {
    if (!agentId) return
    if (!canUseSkill) return
    setInstalling(true)
    try {
      await agentRegistryApi.install(agentId)
      addInstalledSkill(agentId)
    } catch (err) {
      console.warn('安装技能失败:', err)
    } finally {
      setInstalling(false)
    }
  }

  const handleUninstall = async () => {
    if (!agentId) return
    setInstalling(true)
    try {
      await agentRegistryApi.uninstall(agentId)
      removeInstalledSkill(agentId)
    } catch (err) {
      console.warn('卸载技能失败:', err)
    } finally {
      setInstalling(false)
    }
  }

  const handleDownload = () => {
    if (!agentId) return
    agentRegistryApi.download(agentId).catch(err => console.warn('下载失败:', err))
  }

  // 加载评分列表
  useEffect(() => {
    if (open && agentId) {
      // 加载我的评分
      agentRegistryApi.getUserRating(agentId)
        .then(r => {
          if (r) {
            setMyRating(r.rating)
            setMyComment(r.comment || '')
            setMyRatingId(r.id)
          } else {
            setMyRating(0)
            setMyComment('')
            setMyRatingId(null)
          }
        })
        .catch(() => { /* 忽略 */ })

      // 加载评分列表
      setRatingPage(1)
      agentRegistryApi.listRatings(agentId, 1, 10)
        .then(res => {
          setRatingList(res.list || [])
          setRatingTotal(res.total || 0)
        })
        .catch(() => { /* 忽略 */ })
    }
    if (!open) {
      setMyRating(0)
      setMyComment('')
      setMyRatingId(null)
      setRatingList([])
      setRatingTotal(0)
    }
  }, [open, agentId])

  /** 提交评分 */
  const handleSubmitRating = async () => {
    if (!agentId || myRating === 0) return
    setRatingSubmitting(true)
    try {
      const result = await agentRegistryApi.rate(agentId, myRating, myComment || undefined)
      // 更新详情中的聚合数据
      if (detail) {
        setDetail({ ...detail, avgRating: result.avgRating, ratingCount: result.ratingCount })
      }
      // 重新加载评分列表
      const res = await agentRegistryApi.listRatings(agentId, 1, 10)
      setRatingList(res.list || [])
      setRatingTotal(res.total || 0)
      // 刷新我的评分 ID
      const mine = await agentRegistryApi.getUserRating(agentId)
      if (mine) setMyRatingId(mine.id)
    } catch (e) {
      console.warn('提交评分失败:', e)
    } finally {
      setRatingSubmitting(false)
    }
  }

  /** 删除评分 */
  const handleDeleteRating = async () => {
    if (!agentId || !myRatingId) return
    setRatingSubmitting(true)
    try {
      await agentRegistryApi.deleteRating(agentId, myRatingId)
      setMyRating(0)
      setMyComment('')
      setMyRatingId(null)
      // 重新加载详情和列表
      if (detail) {
        const freshDetail = await agentRegistryApi.getDetail(agentId)
        setDetail(freshDetail)
      }
      const res = await agentRegistryApi.listRatings(agentId, 1, 10)
      setRatingList(res.list || [])
      setRatingTotal(res.total || 0)
    } catch (e) {
      console.warn('删除评分失败:', e)
    } finally {
      setRatingSubmitting(false)
    }
  }

  /** 加载更多评分 */
  const handleLoadMoreRatings = async () => {
    if (!agentId) return
    const nextPage = ratingPage + 1
    try {
      const res = await agentRegistryApi.listRatings(agentId, nextPage, 10)
      setRatingList(prev => [...prev, ...(res.list || [])])
      setRatingPage(nextPage)
      setRatingTotal(res.total || 0)
    } catch { /* ignore */ }
  }

  const handleCopyInstallInstruction = () => {
    if (!agentId) return
    const text = `复制以下指令发给 Agent，让它自动安装此技能：

1. 安装「虾评指南 Skill」（如已安装可跳过）：
   curl -sL https://xiaping.coze.com/skill.md

2. 下载并导入本技能（${agentId}）：
   TOKEN="YOUR_TOKEN"
   BASE="${BASE_URL}"
   SKILL_ID="${agentId}"

   # 下载技能ZIP
   curl -sL "$BASE/skills/$SKILL_ID/download" -H "Authorization: Bearer $TOKEN" -o /tmp/skill.zip

   # 导入到本地技能商店
   curl -X POST "$BASE/skills/import" \\
     -H "Authorization: Bearer $TOKEN" \\
     -F "file=@/tmp/skill.zip"`
    navigator.clipboard.writeText(text)
    setInstCopied(true)
    setTimeout(() => setInstCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 gap-0">
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-3">
            {icon && (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('/api/')) ? (
              <img src={icon} alt="" className="w-10 h-10 object-cover rounded-lg shrink-0" />
            ) : (
              <span className="text-3xl">{icon || '🤖'}</span>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate">{name}</span>
                {isBuiltin && <Badge variant="secondary" className="text-[9px] h-4 px-1">内置</Badge>}
                <Badge variant="outline" className="text-[9px] h-4 px-1">v{version}</Badge>
              </div>
              <p className="text-xs text-muted-foreground font-normal mt-0.5 line-clamp-2">{description}</p>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 overflow-y-auto space-y-4" style={{ maxHeight: 'calc(85vh - 130px)' }}>
          {loading && (
            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />加载详情...
            </div>
          )}

          {error && (
            <div className="text-center py-8 text-sm text-destructive">{error}</div>
          )}

          {!loading && !error && (
            <>
              {/* 元信息 */}
              <div className="grid grid-cols-2 gap-3">
                <InfoItem icon={<Cpu className="w-3.5 h-3.5" />} label="推荐模型" value={model} />
                <InfoItem icon={<Thermometer className="w-3.5 h-3.5" />} label="温度" value={detail?.temperature?.toFixed(1) ?? '0.1'} />
                <InfoItem icon={<Hash className="w-3.5 h-3.5" />} label="最大 Token" value={String(detail?.maxTokens ?? 8192)} />
                <InfoItem icon={<User className="w-3.5 h-3.5" />} label="作者" value={author || '未知'} />
              </div>

              {/* 分类标签 */}
              {categories.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <Tag className="w-3.5 h-3.5 text-muted-foreground" />
                  {categories.map(c => (
                    <Badge key={c} variant="secondary" className="text-[10px] h-5">{c}</Badge>
                  ))}
                </div>
              )}

              <Separator />

              {/* ─── P2-3 评分与评论 ─────────────────────── */}
              <div className="space-y-3">
                {/* 评分概览 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Star className="w-3.5 h-3.5 text-amber-400" fill="currentColor" /> 评分与评价
                  </div>
                  <div className="flex items-center gap-1.5">
                    <StarRating value={detail?.avgRating ?? listItem?.avgRating ?? 0} readonly size={14} showValue />
                    <span className="text-xs text-muted-foreground">
                      ({detail?.ratingCount ?? listItem?.ratingCount ?? 0} 人评分)
                    </span>
                  </div>
                </div>

                {/* 我的评分 */}
                <div className="bg-muted/30 border rounded-lg p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium">我的评分</span>
                    {myRatingId && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] text-destructive hover:text-destructive px-2"
                        onClick={handleDeleteRating}
                        disabled={ratingSubmitting}
                      >删除评分</Button>
                    )}
                  </div>
                  <StarRating value={myRating} onChange={setMyRating} size={20} />
                  <Textarea
                    placeholder="写下你的评价..."
                    value={myComment}
                    onChange={e => setMyComment(e.target.value)}
                    className="min-h-[60px] text-xs resize-none"
                    rows={2}
                  />
                  <Button
                    size="sm"
                    className="w-full gap-1.5"
                    onClick={handleSubmitRating}
                    disabled={ratingSubmitting || myRating === 0}
                  >
                    {ratingSubmitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Star className="w-3.5 h-3.5" fill="currentColor" />}
                    {myRatingId ? '更新评分' : '提交评分'}
                  </Button>
                </div>

                {/* 评分列表 */}
                {ratingList.length > 0 && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <MessageSquare className="w-3.5 h-3.5" /> 用户评价 ({ratingTotal})
                    </div>
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {ratingList.map(r => (
                        <div key={r.id} className="flex gap-2.5 p-2 rounded-lg bg-muted/20">
                          <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                            {r.username?.charAt(0)?.toUpperCase() || '?'}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className="text-xs font-medium">{r.username || '匿名用户'}</span>
                              <StarRating value={r.rating} readonly size={10} />
                            </div>
                            {r.comment && (
                              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{r.comment}</p>
                            )}
                            <span className="text-[10px] text-muted-foreground mt-0.5 block">
                              {new Date(r.createdAt).toLocaleDateString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {ratingList.length < ratingTotal && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs"
                        onClick={handleLoadMoreRatings}
                      >加载更多评价</Button>
                    )}
                  </div>
                )}
              </div>

              <Separator />

              {/* 系统提示词 */}
              {detail?.systemPrompt && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <BookOpen className="w-3.5 h-3.5" /> 系统提示词
                  </div>
                  <div className="bg-muted/40 border rounded-lg p-3 text-xs leading-relaxed whitespace-pre-wrap max-h-32 overflow-y-auto">
                    {detail.systemPrompt}
                  </div>
                </div>
              )}

              {/* 工具列表 */}
              {detail?.tools && detail.tools.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                    <Wrench className="w-3.5 h-3.5" /> 工具列表 ({detail.tools.length})
                  </div>
                  <div className="space-y-1.5">
                    {detail.tools.map((tool, idx) => (
                      <div key={tool.name} className="border rounded-lg overflow-hidden">
                        <button
                          className="w-full flex items-center gap-2 p-2.5 text-left hover:bg-muted/30 transition-colors"
                          onClick={() => setActiveToolIdx(activeToolIdx === idx ? null : idx)}
                        >
                          <Wrench className="w-3 h-3 text-muted-foreground shrink-0" />
                          <div className="flex-1 min-w-0">
                            <span className="text-xs font-medium">{tool.name}</span>
                            <p className="text-[10px] text-muted-foreground truncate">{tool.description}</p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {tool.executionMode && (
                              <Badge variant="outline" className="text-[9px] h-4 px-1">
                                {tool.executionMode === 'http' ? '远程' : '本地'}
                              </Badge>
                            )}
                            <ChevronRight className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${activeToolIdx === idx ? 'rotate-90' : ''}`} />
                          </div>
                        </button>
                        {activeToolIdx === idx && (
                          <div className="border-t bg-muted/20 p-2.5 space-y-2">
                            <div className="text-[10px] text-muted-foreground">参数定义：</div>
                            <pre className="bg-muted/40 rounded p-2 text-[10px] font-mono overflow-x-auto whitespace-pre-wrap break-all">
                              {JSON.stringify(tool.parameters, null, 2)}
                            </pre>
                            {tool.endpoint && (
                              <div className="text-[10px]">
                                <span className="text-muted-foreground">端点：</span>
                                <code className="text-primary break-all">{tool.endpoint}</code>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 使用说明 */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Zap className="w-3.5 h-3.5" /> 使用说明
                </div>
                <div className="bg-muted/40 border rounded-lg p-3 text-xs leading-relaxed space-y-1.5">
                  <p>1. 点击下方「使用此 Skill」按钮激活</p>
                  <p>2. 在聊天界面中输入你的问题，Skill 会自动调用工具完成任务</p>
                  <p>3. 你可以在模型面板中切换其他模型，但工具定义保持不变</p>
                  {detail?.tools && detail.tools.some(t => t.executionMode === 'http') && (
                    <p className="text-amber-600 dark:text-amber-400">⚠️ 此 Skill 使用远程工具，需要工具端点可用才能正常工作</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="px-5 py-3 border-t shrink-0 flex items-center justify-between bg-muted/20">
          <div className="text-[10px] text-muted-foreground">
            {detail?.updatedAt && `更新于 ${new Date(detail.updatedAt).toLocaleDateString()}`}
          </div>
          <div className="flex items-center gap-2">
            {isInstalled ? (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={handleUninstall}
                disabled={installing}
              >
                {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PackageCheck className="w-3.5 h-3.5" />}
                卸载
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={handleInstall}
                disabled={installing || !canUseSkill}
                title={!canUseSkill ? '待审核通过后才能安装' : undefined}
              >
                {installing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PackageOpen className="w-3.5 h-3.5" />}
                安装
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={handleDownload}
              title="下载技能包"
            >
              <Download className="w-3.5 h-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5"
              onClick={handleCopyInstallInstruction}
              title="复制安装指令（喂给 Agent）"
            >
              {instCopied ? <ClipboardCheck className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => {
                if (canUseSkill && onUse && agentId) onUse(agentId, detail)
                onOpenChange(false)
              }}
              disabled={!canUseSkill}
              title={!canUseSkill ? '待审核通过后才能使用' : undefined}
            >
              <Check className="w-3.5 h-3.5" />
              使用此 Skill
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function InfoItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-muted-foreground">{label}:</span>
      <span className="font-medium truncate">{value}</span>
    </div>
  )
}
