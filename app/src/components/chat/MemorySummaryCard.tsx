import { useEffect, useState } from 'react'
import { memoryApi, type MemoryStatsVO } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Brain, Clock, Database, FileText, Zap, ChevronDown, ChevronUp } from 'lucide-react'

interface MemorySummaryCardProps {
  className?: string
  onViewTimeline?: () => void
}

export default function MemorySummaryCard({ className, onViewTimeline }: MemorySummaryCardProps) {
  const [stats, setStats] = useState<MemoryStatsVO | null>(null)
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    memoryApi.getStats()
      .then(data => { if (!cancelled) setStats(data) })
      .catch(e => console.warn('[MemorySummary] load stats failed:', e))
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className={cn('flex items-center gap-2 border-b px-3 py-1.5 text-sm text-muted-foreground sm:px-4', className)}>
        <Brain className="h-4 w-4 animate-pulse" />
        <span>加载记忆...</span>
      </div>
    )
  }

  if (!stats || stats.totalDocs === 0) return null

  const totalItems = stats.preferences + stats.projectMemories + stats.conversationMemories + stats.skillMemories

  return (
    <div className={cn('border-b bg-gradient-to-r from-primary/5 via-background to-primary/5 px-3 py-1.5 sm:px-4 sm:py-2', className)}>
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="flex shrink-0 items-center gap-1.5">
            <Brain className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">AI 记住了</span>
          </div>
          <div className="flex min-w-0 items-center gap-3 overflow-hidden text-sm text-muted-foreground">
            <span className="shrink-0">
              <span className="font-semibold text-foreground">{totalItems}</span> 条
            </span>
            {expanded && (
              <>
                {stats.preferences > 0 && <span className="hidden whitespace-nowrap sm:inline"><span className="font-semibold text-foreground">{stats.preferences}</span> 个偏好</span>}
                {stats.projectMemories > 0 && <span className="hidden whitespace-nowrap sm:inline"><span className="font-semibold text-foreground">{stats.projectMemories}</span> 条项目记忆</span>}
                {stats.conversationMemories > 0 && <span className="hidden whitespace-nowrap sm:inline"><span className="font-semibold text-foreground">{stats.conversationMemories}</span> 段对话</span>}
                {stats.skillMemories > 0 && <span className="hidden whitespace-nowrap sm:inline"><span className="font-semibold text-foreground">{stats.skillMemories}</span> 个技能</span>}
                {stats.workFiles > 0 && <span className="hidden whitespace-nowrap sm:inline">{stats.workFiles} 个文件</span>}
              </>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {expanded && onViewTimeline && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onViewTimeline() }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  e.stopPropagation()
                  onViewTimeline()
                }
              }}
              className="flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Clock className="h-3 w-3" />
              时间线
            </span>
          )}
          {expanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-2 text-xs sm:grid-cols-4">
          <StatItem icon={<Brain className="h-3 w-3 text-blue-500" />} label="偏好" value={stats.preferences} />
          <StatItem icon={<Database className="h-3 w-3 text-green-500" />} label="项目" value={stats.projectMemories} />
          <StatItem icon={<FileText className="h-3 w-3 text-orange-500" />} label="对话" value={stats.conversationMemories} />
          <StatItem icon={<Zap className="h-3 w-3 text-purple-500" />} label="技能" value={stats.skillMemories} />
          {stats.lastUpdated && (
            <div className="col-span-2 text-center text-muted-foreground sm:col-span-4">
              最近更新: {stats.lastUpdated}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatItem({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5 rounded bg-background/60 p-1.5">
      {icon}
      <span className="text-muted-foreground">{label}</span>
      <span className="font-semibold">{value}</span>
    </div>
  )
}
