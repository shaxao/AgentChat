/**
 * 工作流自定义 React Flow 节点
 * - TriggerNode: 触发器节点（cron/manual）
 * - StepNode: 步骤节点（工具调用）
 */
import { memo, useState, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Clock, Hand, Trash2, Settings2, Play, ChevronDown, GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { TriggerNodeData, StepNodeData } from '@/lib/workflowTypes'

// ==================== 触发器节点 ====================

export const TriggerNode = memo(function TriggerNode({
  data,
  selected,
}: NodeProps & { data: TriggerNodeData }) {
  const [expanded, setExpanded] = useState(false)
  const isCron = data.triggerType === 'cron'

  return (
    <div
      className={cn(
        'relative min-w-[220px] rounded-xl border-2 shadow-sm transition-all',
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-amber-300 dark:border-amber-600',
        'bg-amber-50 dark:bg-amber-950/30',
      )}
    >
      {/* 头部 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <GripVertical className="w-3.5 h-3.5 text-amber-400 cursor-grab" />
        <div
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center',
            isCron
              ? 'bg-amber-200 dark:bg-amber-800 text-amber-700 dark:text-amber-300'
              : 'bg-blue-200 dark:bg-blue-800 text-blue-700 dark:text-blue-300',
          )}
        >
          {isCron ? <Clock className="w-4 h-4" /> : <Hand className="w-4 h-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-amber-800 dark:text-amber-200">
            触发器
          </div>
          <div className="text-[10px] text-amber-600 dark:text-amber-400">
            {isCron ? `定时 · ${data.cronExpr || '未设置'}` : '手动触发'}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-amber-400 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-2 border-t border-amber-200 dark:border-amber-800">
          {isCron && (
            <div className="mt-2">
              <label className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
                Cron 表达式
              </label>
              <div className="mt-0.5 px-2 py-1 bg-amber-100 dark:bg-amber-900/40 rounded text-xs font-mono text-amber-800 dark:text-amber-200">
                {data.cronExpr || '未设置'}
              </div>
            </div>
          )}
          {!isCron && (
            <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-2">
              需通过 API 或按钮手动触发执行
            </p>
          )}
        </div>
      )}

      {/* 输出连接点（底部） */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !border-2 !border-amber-400 !bg-amber-100 dark:!bg-amber-900 !-bottom-1.5"
        id="trigger-out"
      />
    </div>
  )
})

// ==================== 步骤节点 ====================

export const StepNode = memo(function StepNode({
  id,
  data,
  selected,
}: NodeProps & { data: StepNodeData }) {
  const [expanded, setExpanded] = useState(false)

  const toolColor = getToolColor(data.tool)

  return (
    <div
      className={cn(
        'relative min-w-[240px] rounded-xl border-2 shadow-sm transition-all',
        selected
          ? 'border-primary ring-2 ring-primary/20'
          : 'border-slate-200 dark:border-slate-700',
        'bg-white dark:bg-slate-900',
      )}
    >
      {/* 输入连接点（顶部） */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !border-2 !border-slate-400 !bg-white dark:!bg-slate-800 !-top-1.5"
        id={`${id}-in`}
      />

      {/* 头部 */}
      <div
        className="flex items-center gap-2 px-3 py-2.5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <GripVertical className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 cursor-grab" />
        <div
          className={cn(
            'w-7 h-7 rounded-lg flex items-center justify-center text-white shrink-0',
            toolColor,
          )}
        >
          <Play className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold truncate">{data.label || data.tool}</div>
          <div className="text-[10px] text-muted-foreground truncate">
            {data.description || data.stepId}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'w-3.5 h-3.5 text-muted-foreground transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </div>

      {/* 展开内容 */}
      {expanded && (
        <div className="px-3 pb-3 pt-0 space-y-2 border-t border-slate-100 dark:border-slate-800">
          <div className="mt-2 grid grid-cols-1 gap-2 text-[10px]">
            <div>
              <span className="font-medium text-muted-foreground">步骤 ID: </span>
              <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs">
                {data.stepId}
              </code>
            </div>
            <div>
              <span className="font-medium text-muted-foreground">工具: </span>
              <span className="text-foreground">{data.tool}</span>
            </div>
            {data.condition && (
              <div>
                <span className="font-medium text-muted-foreground">条件: </span>
                <code className="px-1 bg-slate-100 dark:bg-slate-800 rounded text-xs text-orange-600">
                  {data.condition}
                </code>
              </div>
            )}
            {data.args && Object.keys(data.args).length > 0 && (
              <div>
                <span className="font-medium text-muted-foreground">参数:</span>
                <pre className="mt-0.5 p-1.5 bg-slate-50 dark:bg-slate-800 rounded text-[10px] font-mono max-h-24 overflow-auto">
                  {JSON.stringify(data.args, null, 2)}
                </pre>
              </div>
            )}
            {(!data.args || Object.keys(data.args).length === 0) && (
              <p className="text-muted-foreground italic">无参数</p>
            )}
          </div>
        </div>
      )}

      {/* 输出连接点（底部） */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !border-2 !border-slate-400 !bg-white dark:!bg-slate-800 !-bottom-1.5"
        id={`${id}-out`}
      />
    </div>
  )
})

// ==================== 工具颜色映射 ====================

function getToolColor(tool: string): string {
  const colors: Record<string, string> = {
    ai_chat: 'bg-purple-500',
    web_search: 'bg-blue-500',
    http_request: 'bg-green-500',
    send_email: 'bg-orange-500',
    send_wechat: 'bg-green-600',
    generate_report: 'bg-indigo-500',
    check_data: 'bg-cyan-500',
    summarize: 'bg-pink-500',
    translate: 'bg-teal-500',
  }
  return colors[tool] || 'bg-slate-500'
}

// ==================== 注册自定义节点类型 ====================

export const nodeTypes = {
  trigger: TriggerNode,
  step: StepNode,
}
