'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { API_BASE, devServerApi, withAuthQuery } from '@/lib/api'
import { Loader2, ExternalLink, RefreshCw, Monitor, X } from 'lucide-react'

interface DevServerInfo {
  workspace_id: string
  port: number
  url: string | null
  status: string
}

interface PreviewFrameProps {
  workspaceId: string
  initialUrl?: string | null
  projectType?: string
  className?: string
}

export function PreviewFrame({ workspaceId, initialUrl, projectType, className }: PreviewFrameProps) {
  const [devServer, setDevServer] = useState<DevServerInfo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingProgress, setLoadingProgress] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 加载 dev server 状态
  const loadDevServer = useCallback(async () => {
    try {
      const data = await devServerApi.get(workspaceId)
      setDevServer(data)
      setError(null)
    } catch (e) {
      // dev server 尚未启动，忽略
    }
  }, [workspaceId])

  // 轮询 dev server 状态直到 running
  useEffect(() => {
    loadDevServer()
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(loadDevServer, 3000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [loadDevServer])

  const startDevServer = async () => {
    setLoading(true)
    setError(null)
    setLoadingProgress('正在连接 Workspace...')
    try {
      await devServerApi.start(workspaceId, projectType)
      setLoadingProgress('开发服务器启动中（可能需要 30-60 秒）...')
      await loadDevServer()
    } catch (e: any) {
      setError(e.message || '启动失败')
    } finally {
      setLoading(false)
      setLoadingProgress('')
    }
  }

  const stopDevServer = async () => {
    try {
      await devServerApi.stop(workspaceId)
      setDevServer(null)
    } catch {}
  }

  const refreshIframe = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
    }
  }

  // 确定当前要显示的 URL
  const rawPreviewUrl = devServer?.status === 'running' && devServer.url
    ? `${API_BASE}/api/proxy/${workspaceId}/`
    : initialUrl || null
  const previewUrl = withAuthQuery(rawPreviewUrl)

  const isRunning = devServer?.status === 'running'

  return (
    <div className={cn('border rounded-xl overflow-hidden bg-card', className)}>
      {/* Toolbar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Monitor className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium">实时预览</span>
          {isRunning && devServer && (
            <span className="text-xs bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 px-2 py-0.5 rounded-full">
              :{devServer.port} ● 运行中
            </span>
          )}
          {!previewUrl && !loading && (
            <span className="text-xs text-muted-foreground">未启动预览服务</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {previewUrl && (
            <>
              <button
                onClick={refreshIframe}
                className="p-1.5 rounded-md hover:bg-secondary transition"
                title="刷新预览"
              >
                <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1.5 rounded-md hover:bg-secondary transition"
                title="新窗口打开"
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
              </a>
            </>
          )}
          {!isRunning && !loading && (
            <button
              onClick={startDevServer}
              className="flex items-center gap-1.5 text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition"
            >
              <Loader2 className="w-3 h-3" />
              启动预览
            </button>
          )}
          {isRunning && (
            <button
              onClick={stopDevServer}
              className="p-1.5 rounded-md hover:bg-red-50 text-red-500 transition"
              title="停止预览"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          {loading && (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" />
              {loadingProgress || '启动中...'}
            </span>
          )}
        </div>
      </div>

      {/* Loading / Error / Preview */}
      <div className="relative bg-muted/20" style={{ height: '400px' }}>
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-primary" />
            <p className="text-sm text-muted-foreground">{loadingProgress}</p>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <p className="text-sm text-red-500">{error}</p>
            <button onClick={startDevServer} className="text-xs text-primary hover:underline">
              重试
            </button>
          </div>
        )}

        {!previewUrl && !loading && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center">
              <Monitor className="w-6 h-6 text-muted-foreground/50" />
            </div>
            <p className="text-sm text-muted-foreground">点击「启动预览」在 Workspace 内运行开发服务器</p>
            <button
              onClick={startDevServer}
              className="flex items-center gap-1.5 text-sm bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:opacity-90 transition"
            >
              <Loader2 className="w-4 h-4 animate-spin" />
              启动开发服务器
            </button>
          </div>
        )}

        {previewUrl && !loading && (
          <iframe
            ref={iframeRef}
            src={previewUrl}
            className="w-full h-full border-0"
            title="Project Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          />
        )}
      </div>
    </div>
  )
}
