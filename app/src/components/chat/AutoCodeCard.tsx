import { useState, useEffect, useRef } from 'react'
import { Message } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  ExternalLink, RefreshCw, Loader2, CheckCircle2, XCircle,
  AlertTriangle, Clock, Zap, GitBranch, Eye, Terminal, Rocket,
} from 'lucide-react'

/** AutoCode API 认证头（从 localStorage auth-store 读取） */
function getAuthHeaders(): Record<string, string> {
  try {
    const raw = localStorage.getItem('auth-store')
    if (!raw) return {}
    const store = JSON.parse(raw)
    const token = store?.state?.token
    const userId = store?.state?.user?.id
    const h: Record<string, string> = {}
    if (token) h['Authorization'] = `Bearer ${token}`
    if (userId) h['X-User-Id'] = userId
    return h
  } catch { return {} }
}

// AutoCode 前端地址（开发环境 / 生产环境）
const AUTOCODE_FRONTEND = import.meta.env.VITE_AUTOCODE_API_URL || 'http://localhost:3000'
const AUTOCODE_API = import.meta.env.VITE_AUTOCODE_API_URL || '/autocode-api'

interface AutoCodeCardProps {
  /** AutoCode 任务数据 */
  taskId: string
  workspaceId: string
  title: string
  status: string
  previewUrl?: string
  className?: string
}

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { icon: React.ReactNode; label: string; color: string; bg: string }> = {
    pending:    { icon: <Clock className="w-3 h-3" />, label: '等待中', color: 'text-muted-foreground', bg: 'bg-muted' },
    running:    { icon: <Loader2 className="w-3 h-3 animate-spin" />, label: '执行中', color: 'text-blue-600', bg: 'bg-blue-50 dark:bg-blue-950' },
    waiting_confirm: { icon: <AlertTriangle className="w-3 h-3" />, label: '待确认', color: 'text-amber-600', bg: 'bg-amber-50 dark:bg-amber-950' },
    completed:  { icon: <CheckCircle2 className="w-3 h-3" />, label: '已完成', color: 'text-green-600', bg: 'bg-green-50 dark:bg-green-950' },
    failed:     { icon: <XCircle className="w-3 h-3" />, label: '失败', color: 'text-red-600', bg: 'bg-red-50 dark:bg-red-950' },
    cancelled:  { icon: <XCircle className="w-3 h-3" />, label: '已取消', color: 'text-muted-foreground', bg: 'bg-muted' },
  }
  const c = cfg[status] || cfg.pending
  return (
    <span className={cn('flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border', c.color, c.bg)}>
      {c.icon} {c.label}
    </span>
  )
}

export function AutoCodeCard({ taskId, workspaceId, title, status, previewUrl, className }: AutoCodeCardProps) {
  const [iframeKey, setIframeKey] = useState(0)
  const [iframeUrl, setIframeUrl] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'preview' | 'terminal'>('preview')
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // 构造任务详情页 URL
  const taskUrl = `${AUTOCODE_FRONTEND}/tasks/${taskId}`

  // 轮询任务状态（仅更新 badge，不刷新 iframe）
  const [currentStatus, setCurrentStatus] = useState(status)
  const [currentPreview, setCurrentPreview] = useState(previewUrl)

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`${AUTOCODE_API}/api/tasks/${taskId}/status`, {
          headers: getAuthHeaders()
        })
        if (res.ok && !cancelled) {
          const data = await res.json()
          setCurrentStatus(data.status || currentStatus)
          if (data.preview_url && !cancelled) setCurrentPreview(data.preview_url)
        }
      } catch {}
    }
    // 首次立即查，后续每 5 秒轮询
    poll()
    const interval = setInterval(poll, 5000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [taskId])

  // previewUrl 可能是相对路径，拼接完整 URL
  const resolvePreviewUrl = (url?: string | null): string | undefined => {
    if (!url) return undefined
    if (url.startsWith('http')) return url
    return `${AUTOCODE_API}${url}`
  }

  // 心跳 + 页面关闭时停止预览
  useEffect(() => {
    if (!currentPreview || !workspaceId) return

    const base = AUTOCODE_API  // e.g. /autocode-api

    // 心跳：每 30 秒通知后端"预览还在用"
    const sendHeartbeat = async () => {
      try {
        await fetch(`${base}/api/workspaces/${workspaceId}/heartbeat`, { method: 'POST' })
      } catch {}
    }
    sendHeartbeat()
    const heartbeatInterval = setInterval(sendHeartbeat, 30000)

    // 页面关闭时通知后端停止预览（使用 sendBeacon，页面卸载时也能发出）
    const handleBeforeUnload = () => {
      try {
        const url = `${base}/api/workspaces/${workspaceId}/dev-server/stop`
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([JSON.stringify({})], { type: 'application/json' }))
        } else {
          const xhr = new XMLHttpRequest()
          xhr.open('POST', url, false)
          xhr.setRequestHeader('Content-Type', 'application/json')
          xhr.send(JSON.stringify({}))
        }
      } catch {}
    }
    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      clearInterval(heartbeatInterval)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      // 组件卸载时也通知停止（用户切换对话等场景）
      fetch(`${base}/api/workspaces/${workspaceId}/dev-server/stop`, {
        method: 'POST',
        keepalive: true,
      }).catch(() => {})
    }
  }, [currentPreview, workspaceId])

  return (
    <div className={cn('rounded-2xl border overflow-hidden bg-card shadow-sm', className)}>
      {/* Header */}
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center shrink-0">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold truncate">{title || 'AutoCode 任务'}</p>
            <p className="text-xs text-muted-foreground font-mono">{taskId}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StatusBadge status={currentStatus} />
          <a
            href={taskUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded-md hover:bg-secondary transition text-muted-foreground hover:text-foreground"
            title="在新窗口打开"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
          <button
            onClick={() => { setIframeKey(k => k + 1); setIframeUrl(null) }}
            className="p-1.5 rounded-md hover:bg-secondary transition text-muted-foreground hover:text-foreground"
            title="刷新"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Tabs: 预览 / 终端 */}
      <div className="flex border-b bg-muted/20">
        {(['preview', 'terminal'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-medium transition border-b-2',
              activeTab === tab
                ? 'border-primary text-primary bg-primary/5'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            )}
          >
            {tab === 'preview' ? <Eye className="w-3.5 h-3.5" /> : <Terminal className="w-3.5 h-3.5" />}
            {tab === 'preview' ? '实时预览' : '任务详情'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="relative bg-muted/10" style={{ height: '440px' }}>
        {activeTab === 'preview' ? (
          <>
            {/* 预览模式：显示 iframe */}
            {!currentPreview && currentStatus !== 'completed' && currentStatus !== 'failed' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-10 bg-muted/10">
                <Loader2 className="w-7 h-7 animate-spin text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Skill 正在构建中，请稍候...</p>
                <p className="text-xs text-muted-foreground/60">构建完成后预览将自动显示</p>
              </div>
            )}
            {currentPreview ? (
              <iframe
                key={`preview-${iframeKey}`}
                ref={iframeRef}
                src={resolvePreviewUrl(currentPreview)}
                className="w-full h-full border-0"
                title="AutoCode Preview"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Eye className="w-10 h-10 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">
                  {currentStatus === 'completed'
                    ? '预览服务未启动，点击右上角"在新窗口打开"查看详情'
                    : '预览将在构建完成后自动显示'}
                </p>
              </div>
            )}
          </>
        ) : (
          /* 任务详情模式：iframe 加载 AutoCode 任务页 */
          <iframe
            key={`detail-${iframeKey}`}
            src={taskUrl}
            className="w-full h-full border-0"
            title="AutoCode Task"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t bg-muted/20 flex items-center justify-between">
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <GitBranch className="w-3 h-3" />
            {workspaceId}
          </span>
        </div>
        {currentPreview && (
          <a
            href={resolvePreviewUrl(currentPreview)!}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            新窗口打开
          </a>
        )}
      </div>
    </div>
  )
}

/**
 * 从 Message 中提取 autocode 数据，渲染为卡片。
 * 在 MessageBubble 或 ChatPage 的 messages.map 中使用。
 */
export function AutoCodeMessageCard({ message }: { message: Message }) {
  if (!message.autocode) return null

  const { taskId, workspaceId, title, status, previewUrl } = message.autocode

  return (
    <AutoCodeCard
      taskId={taskId}
      workspaceId={workspaceId}
      title={title}
      status={status}
      previewUrl={previewUrl}
    />
  )
}
