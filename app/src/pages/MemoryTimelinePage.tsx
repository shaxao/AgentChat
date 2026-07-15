import { useEffect, useState } from 'react'
import { memoryApi, type MemoryDocumentVO } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  ArrowLeft, Brain, Database, FileText, Zap, Clock, Search,
  Calendar, Trash2, Eye, X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface MemoryTimelinePageProps {
  onBack?: () => void
}

/**
 * 记忆时间线页面 - P1-4
 * 按时间线展示 AI 记住的所有信息
 */
export default function MemoryTimelinePage({ onBack }: MemoryTimelinePageProps) {
  const [timeline, setTimeline] = useState<MemoryDocumentVO[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<string>('all')  // all | user_profile | project_memory | conversation_summary | skill_memory
  const [selectedDoc, setSelectedDoc] = useState<MemoryDocumentVO | null>(null)

  useEffect(() => {
    loadTimeline()
  }, [])

  const loadTimeline = async () => {
    try {
      setLoading(true)
      const data = await memoryApi.getTimeline(50)
      setTimeline(data)
    } catch (e) {
      console.warn('获取记忆时间线失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const filteredTimeline = timeline.filter(doc => {
    if (filter !== 'all' && doc.docType !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return doc.title?.toLowerCase().includes(q) || doc.content?.toLowerCase().includes(q)
    }
    return true
  })

  const getDocTypeIcon = (docType: string) => {
    switch (docType) {
      case 'user_profile': return <Brain className="w-4 h-4 text-blue-500" />
      case 'project_memory': return <Database className="w-4 h-4 text-green-500" />
      case 'conversation_summary': return <FileText className="w-4 h-4 text-orange-500" />
      case 'skill_memory': return <Zap className="w-4 h-4 text-purple-500" />
      default: return <FileText className="w-4 h-4" />
    }
  }

  const getDocTypeLabel = (docType: string) => {
    switch (docType) {
      case 'user_profile': return '用户偏好'
      case 'project_memory': return '项目记忆'
      case 'conversation_summary': return '对话记忆'
      case 'skill_memory': return '技能记忆'
      default: return docType
    }
  }

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return ''
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 60) return `${diffMins} 分钟前`
    if (diffHours < 24) return `${diffHours} 小时前`
    if (diffDays < 7) return `${diffDays} 天前`
    return d.toLocaleDateString('zh-CN')
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* 顶部导航 */}
      <div className="flex items-center gap-3 p-4 border-b">
        <Button variant="ghost" size="icon" onClick={() => onBack?.()}>
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Clock className="w-5 h-5 text-primary" />
          记忆时间线
        </h1>
      </div>

      {/* 搜索和筛选 */}
      <div className="p-4 border-b space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索记忆..."
            className="pl-9"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {[
            { value: 'all', label: '全部' },
            { value: 'user_profile', label: '偏好' },
            { value: 'project_memory', label: '项目' },
            { value: 'conversation_summary', label: '对话' },
            { value: 'skill_memory', label: '技能' },
          ].map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'px-3 py-1 rounded-full text-xs font-medium transition-colors',
                filter === f.value
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted hover:bg-muted/80'
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* 时间线列表 */}
      <div className="mobile-scroll-bottom-safe flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Clock className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredTimeline.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            <Brain className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>暂无记忆数据</p>
          </div>
        ) : (
          <div className="space-y-4">
            {filteredTimeline.map((doc, idx) => (
              <div key={doc.uuid || idx} className="flex gap-3">
                {/* 时间线指示器 */}
                <div className="flex flex-col items-center">
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    {getDocTypeIcon(doc.docType)}
                  </div>
                  {idx < filteredTimeline.length - 1 && (
                    <div className="w-px flex-1 bg-border mt-2" />
                  )}
                </div>

                {/* 内容卡片 */}
                <div className="flex-1 pb-4">
                  <div className="p-3 rounded-lg border bg-card hover:bg-accent/50 transition-colors cursor-pointer"
                    onClick={() => setSelectedDoc(doc)}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-medium px-1.5 py-0.5 rounded bg-muted">
                            {getDocTypeLabel(doc.docType)}
                          </span>
                          {doc.importance && doc.importance > 3 && (
                            <span className="text-xs text-orange-500">⭐ 重要</span>
                          )}
                        </div>
                        <h3 className="font-medium text-sm truncate">{doc.title}</h3>
                        {doc.content && (
                          <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                            {doc.content.replace(/[#*\[\]]/g, '').substring(0, 150)}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                        <Clock className="w-3 h-3" />
                        {formatDate(doc.updatedAt)}
                      </div>
                    </div>

                    {doc.tags && doc.tags.length > 0 && (
                      <div className="flex gap-1 mt-2">
                        {doc.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="text-xs px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 详情弹窗 */}
      {selectedDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50" onClick={() => setSelectedDoc(null)}>
          <div className="bg-card border rounded-xl shadow-2xl max-w-lg w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            {/* 弹窗头部 */}
            <div className="flex items-center justify-between p-4 border-b">
              <div className="flex items-center gap-2 min-w-0">
                {getDocTypeIcon(selectedDoc.docType)}
                <span className="text-sm font-medium px-1.5 py-0.5 rounded bg-muted shrink-0">
                  {getDocTypeLabel(selectedDoc.docType)}
                </span>
                {selectedDoc.importance && selectedDoc.importance > 3 && (
                  <span className="text-xs text-orange-500 shrink-0">⭐ 重要</span>
                )}
              </div>
              <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8" onClick={() => setSelectedDoc(null)}>
                <X className="w-4 h-4" />
              </Button>
            </div>

            {/* 弹窗内容 */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              <h2 className="text-base font-semibold">{selectedDoc.title}</h2>

              {selectedDoc.content && (
                <div className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {selectedDoc.content}
                </div>
              )}

              {selectedDoc.tags && selectedDoc.tags.length > 0 && (
                <div className="flex gap-1 flex-wrap pt-2">
                  {selectedDoc.tags.map(tag => (
                    <span key={tag} className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 底部信息 */}
            <div className="flex items-center justify-between px-4 py-3 border-t text-xs text-muted-foreground">
              <span>UUID: {selectedDoc.uuid?.slice(0, 12)}...</span>
              <span>{formatDate(selectedDoc.updatedAt)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
