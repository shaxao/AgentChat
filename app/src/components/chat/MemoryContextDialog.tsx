import { useState, useEffect, useCallback } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { memoryApi, type MemoryContext } from '@/lib/api'
import { useChatStore } from '@/store'
import {
  Brain, BookOpen, User, Wrench, ScrollText, FileText, Lightbulb,
  ChevronDown, ChevronRight, ExternalLink, CheckCircle, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ==================== 记忆类别配置 ====================

const CATEGORY_CONFIG: {
  key: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  desc: string
  hasContent: (ctx: MemoryContext) => boolean
  renderContent: (ctx: MemoryContext) => string | null
}[] = [
  {
    key: 'soul',
    label: 'SOUL（人格设定）',
    icon: Brain,
    desc: 'AI 助手的核心人格与行为风格',
    hasContent: (ctx) => !!ctx.soul?.trim(),
    renderContent: (ctx) => ctx.soul,
  },
  {
    key: 'tools',
    label: 'TOOLS（工具设定）',
    icon: Wrench,
    desc: '可用工具与函数调用规范',
    hasContent: (ctx) => !!ctx.tools?.trim(),
    renderContent: (ctx) => ctx.tools,
  },
  {
    key: 'rules',
    label: 'RULES（行为规则）',
    icon: ScrollText,
    desc: 'AI 行为约束与输出规范',
    hasContent: (ctx) => !!ctx.rules?.trim(),
    renderContent: (ctx) => ctx.rules,
  },
  {
    key: 'userProfile',
    label: '用户画像',
    icon: User,
    desc: '关于你的偏好、习惯与背景信息',
    hasContent: (ctx) => !!ctx.userProfile?.trim(),
    renderContent: (ctx) => ctx.userProfile,
  },
  {
    key: 'conversationMemory',
    label: '对话记忆',
    icon: BookOpen,
    desc: '当前对话的上下文记忆摘要',
    hasContent: (ctx) => !!ctx.conversationMemory?.trim(),
    renderContent: (ctx) => ctx.conversationMemory,
  },
  {
    key: 'relevantSkills',
    label: '相关技能记忆',
    icon: FileText,
    desc: '已学习技能的摘要与用法',
    hasContent: (ctx) => !!(ctx.relevantSkills && ctx.relevantSkills.length > 0),
    renderContent: (ctx) => ctx.relevantSkills?.map(s => `## ${s.title}\n${s.summary}`).join('\n\n') || null,
  },
  {
    key: 'conversationFiles',
    label: '对话工作文件',
    icon: Lightbulb,
    desc: '当前对话关联的工作文件列表',
    hasContent: (ctx) => !!(ctx.conversationFiles && ctx.conversationFiles.length > 0),
    renderContent: (ctx) => ctx.conversationFiles?.join('\n') || null,
  },
]

// ==================== 折叠面板组件 ====================

function MemorySection({
  label,
  icon: Icon,
  desc,
  content,
  hasContent,
}: {
  label: string
  icon: React.ComponentType<{ className?: string }>
  desc: string
  content: string | null
  hasContent: boolean
}) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className={cn(
      'border rounded-lg overflow-hidden',
      hasContent ? 'border-primary/30 bg-primary/5' : 'border-border',
    )}>
      <button
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left hover:bg-accent/50 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className={cn(
          'p-1 rounded-md',
          hasContent ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{label}</span>
            {hasContent ? (
              <Badge variant="default" className="text-[10px] h-4 px-1 shrink-0">已注入</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] h-4 px-1 shrink-0 text-muted-foreground">空</Badge>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground truncate">{desc}</p>
        </div>
        {hasContent && (
          <div className="shrink-0">
            {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </div>
        )}
      </button>

      {expanded && hasContent && content && (
        <div className="border-t bg-muted/30 px-3 py-2.5">
          <pre className="whitespace-pre-wrap text-xs font-mono leading-relaxed text-foreground/90 max-h-[300px] overflow-y-auto">
            {content}
          </pre>
        </div>
      )}
    </div>
  )
}

// ==================== 主对话框组件 ====================

interface MemoryContextDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpenMemoryPanel: () => void
}

export default function MemoryContextDialog({
  open,
  onOpenChange,
  onOpenMemoryPanel,
}: MemoryContextDialogProps) {
  const activeConversationId = useChatStore(s => s.activeConversationId)
  const [ctx, setCtx] = useState<MemoryContext | null>(null)
  const [loading, setLoading] = useState(false)

  const loadContext = useCallback(async () => {
    setLoading(true)
    try {
      const data = await memoryApi.getContext({
        convUuid: activeConversationId || undefined,
      })
      setCtx(data)
    } catch (e) {
      console.error('[MemoryContextDialog] 加载失败:', e)
      setCtx(null)
    } finally {
      setLoading(false)
    }
  }, [activeConversationId])

  useEffect(() => {
    if (open) loadContext()
  }, [open, loadContext])

  const hasAnyMemory = ctx && CATEGORY_CONFIG.some(cat => cat.hasContent(ctx))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="flex flex-row items-center justify-between px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2">
            <Brain className="w-4 h-4 text-primary" />
            记忆状态
            {activeConversationId && (
              <span className="text-xs font-normal text-muted-foreground">
                / {activeConversationId.slice(0, 8)}...
              </span>
            )}
          </DialogTitle>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={onOpenMemoryPanel}
              className="text-xs gap-1"
            >
              <ExternalLink className="w-3 h-3" />
              管理
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onOpenChange(false)}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        {/* Content */}
        <ScrollArea className="flex-1 px-4 py-3">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              加载中...
            </div>
          ) : !activeConversationId ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Brain className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">暂无活跃对话</p>
              <p className="text-xs text-muted-foreground/60">选择一个对话后查看记忆状态</p>
            </div>
          ) : !hasAnyMemory ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Brain className="w-10 h-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">暂无注入的记忆</p>
              <p className="text-xs text-muted-foreground/60 mb-4">
                对话中 AI 会自动学习并建立记忆，或前往记忆管理手动创建
              </p>
              <Button size="sm" variant="outline" onClick={onOpenMemoryPanel}>
                前往记忆管理
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-2 mb-3">
                <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
                <span className="text-xs text-muted-foreground">
                  以下记忆已注入到当前对话的 System Prompt
                </span>
              </div>
              {CATEGORY_CONFIG.map(cat => (
                <MemorySection
                  key={cat.key}
                  label={cat.label}
                  icon={cat.icon}
                  desc={cat.desc}
                  content={cat.renderContent(ctx!)}
                  hasContent={cat.hasContent(ctx!)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t flex items-center justify-between shrink-0">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Brain className="w-3 h-3 shrink-0" />
            记忆让 AI 记住你的偏好与项目背景
          </div>
          <Button size="sm" variant="ghost" onClick={onOpenMemoryPanel}>
            查看全部
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
