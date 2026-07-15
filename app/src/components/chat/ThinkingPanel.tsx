import { useEffect, useState, useMemo } from 'react'
import { marked } from 'marked'
import { cn } from '@/lib/utils'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { sanitizeHtml } from '@/lib/sanitizeHtml'
import { renderMathInMarkdownSource } from '@/lib/renderMath'

// ─── 简单 SVG Brain 图标（无需额外依赖）──────────────────────────────────
function BrainIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {/* 左脑 */}
      <path d="M12 4.5a2.5 2.5 0 0 0-4.96-.46 2.5 2.5 0 0 0-1.98 3.46 2.5 2.5 0 0 0-1.32 4.24 3 3 0 0 0 .34 5.58 2.5 2.5 0 0 0 2.96 3.08A2.5 2.5 0 0 0 12 19.5V4.5Z" />
      {/* 右脑 */}
      <path d="M12 4.5a2.5 2.5 0 0 1 4.96-.46 2.5 2.5 0 0 1 1.98 3.46 2.5 2.5 0 0 1 1.32 4.24 3 3 0 0 1-.34 5.58 2.5 2.5 0 0 1-2.96 3.08A2.5 2.5 0 0 1 12 19.5V4.5Z" />
      {/* 中间连接 */}
      <path d="M12 4.5v15" strokeDasharray="1 1" />
    </svg>
  )
}

interface ThinkingPanelProps {
  content: string
  streaming?: boolean
  className?: string
}

/**
 * ThinkingPanel — 深度思考内容展示组件
 *
 * 默认折叠，点击标题栏展开/收起。
 * 展开时使用 marked 将思考内容渲染为 HTML，带基础排版样式。
 */
export function ThinkingPanel({ content, streaming, className }: ThinkingPanelProps) {
  const [expanded, setExpanded] = useState(Boolean(streaming))

  useEffect(() => {
    if (streaming && content) setExpanded(true)
  }, [streaming, content])

  // 仅在展开时解析 markdown
  const htmlContent = useMemo(() => {
    if (!expanded) return ''
    try {
      return sanitizeHtml(marked.parse(renderMathInMarkdownSource(content)) as string)
    } catch {
      return sanitizeHtml(`<p>${content}</p>`)
    }
  }, [content, expanded])

  // 内容摘要（折叠时显示第一行）
  const summary = useMemo(() => {
    const firstLine = content.split('\n')[0]?.trim() || ''
    return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine
  }, [content])

  return (
    <div className={cn('rounded-xl border border-amber-500/20 bg-amber-500/5 overflow-hidden', className)}>
      {/* 折叠标题栏 */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-amber-500/10 transition-colors"
        title={expanded ? '收起思考过程' : '展开思考过程'}
      >
        <BrainIcon className="w-4 h-4 text-amber-500 shrink-0" />
        <span className="text-xs font-medium text-amber-700 dark:text-amber-400 flex-1">
          深度思考
        </span>
        {!expanded && (
          <span className="text-[10px] text-amber-600/60 dark:text-amber-400/50 truncate max-w-[240px] hidden sm:inline">
            {summary}
          </span>
        )}
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        )}
      </button>

      {/* 展开内容区 */}
      {expanded && (
        <div className="px-3 pb-3 pt-1 border-t border-amber-500/10">
          <div
            className="text-xs leading-relaxed text-amber-900/70 dark:text-amber-200/60 thinking-content"
            dangerouslySetInnerHTML={{ __html: htmlContent }}
          />
        </div>
      )}
    </div>
  )
}

export default ThinkingPanel
