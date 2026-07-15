'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { cn } from '@/lib/utils'
import { Loader2, RefreshCw, ExternalLink, Palette, Send, Sparkles, PenTool } from 'lucide-react'
import { prototypeApi, withAuthQuery } from '@/lib/api'

interface PrototypePreviewProps {
  workspaceId: string
  previewUrl?: string | null
  className?: string
}

export function PrototypePreview({ workspaceId, previewUrl: initialUrl, className }: PrototypePreviewProps) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(initialUrl || null)
  const [generating, setGenerating] = useState(false)
  const [modifyOpen, setModifyOpen] = useState(false)
  const [modifyInput, setModifyInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [generatedTitle, setGeneratedTitle] = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const checkExistingPrototype = useCallback(async () => {
    try {
      const data = await prototypeApi.get(workspaceId)
      if (data.exists) {
        setPreviewUrl(data.preview_url || null)
        setGeneratedTitle(data.title || '')
      } else {
        setPreviewUrl(null)
      }
    } catch {
      // ignore
    }
  }, [workspaceId])

  useEffect(() => {
    checkExistingPrototype()
  }, [checkExistingPrototype])

  // 妫€鏌ュ凡鏈夊師鍨?  useState(() => { checkExistingPrototype() })

  const handleGenerate = async () => {
    const desc = prompt('请描述你想要的 UI 原型，例如：一个登录页，包含邮箱和密码输入框、主按钮和简洁背景。')
    if (!desc?.trim()) return

    setGenerating(true)
    setError(null)
    try {
      const data = await prototypeApi.generate(workspaceId, desc)
      if (data.ok) {
        setPreviewUrl(data.preview_url)
        setGeneratedTitle(data.title || '')
        // 鍒锋柊 iframe
        setTimeout(() => {
          if (iframeRef.current) iframeRef.current.src = withAuthQuery(data.preview_url) || data.preview_url
        }, 300)
      } else {
        setError('鐢熸垚澶辫触')
      }
    } catch (e: any) {
      setError(e.message || '鐢熸垚澶辫触')
    } finally {
      setGenerating(false)
    }
  }

  const handleRefine = async () => {
    if (!modifyInput.trim()) return

    setGenerating(true)
    setError(null)
    try {
      const data = await prototypeApi.refine(workspaceId, modifyInput)
      if (data.ok) {
        setModifyInput('')
        setModifyOpen(false)
        // 寮哄埗鍒锋柊 iframe锛堝姞鏃堕棿鎴抽伩鍏嶇紦瀛橈級
        const newUrl = `${data.preview_url}?t=${Date.now()}`
        setPreviewUrl(newUrl)
        setTimeout(() => {
          if (iframeRef.current) iframeRef.current.src = withAuthQuery(newUrl) || newUrl
        }, 200)
      } else {
        setError('淇敼澶辫触')
      }
    } catch (e: any) {
      setError(e.message || '淇敼澶辫触')
    } finally {
      setGenerating(false)
    }
  }

  const refreshIframe = () => {
    if (iframeRef.current) {
      iframeRef.current.src = iframeRef.current.src
    }
  }
  const authedPreviewUrl = withAuthQuery(previewUrl)

  return (
    <div className={cn('border rounded-xl overflow-hidden bg-card flex flex-col', className)}>
      {/* Toolbar */}
      <div className="px-4 py-2 border-b bg-muted/30 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Palette className="w-4 h-4 text-purple-500 shrink-0" />
          <span className="text-sm font-medium truncate">
            {generatedTitle || 'UI 鍘熷瀷棰勮'}
          </span>
          {previewUrl && (
            <span className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 px-2 py-0.5 rounded-full shrink-0">
              宸茬敓鎴?            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {previewUrl && (
            <>
              <button
                onClick={refreshIframe}
                className="p-1.5 rounded-md hover:bg-secondary transition"
                title="鍒锋柊棰勮"
              >
                <RefreshCw className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
              <button
                onClick={() => setModifyOpen(!modifyOpen)}
                className={cn(
                  'p-1.5 rounded-md transition',
                  modifyOpen ? 'bg-purple-100 text-purple-600' : 'hover:bg-secondary text-muted-foreground'
                )}
                title="淇敼鍘熷瀷"
              >
                <PenTool className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          <button
            onClick={handleGenerate}
            disabled={generating}
            className={cn(
              'flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md transition',
              previewUrl
                ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
                : 'bg-purple-600 text-white hover:bg-purple-700'
            )}
          >
            {generating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Sparkles className="w-3 h-3" />
            )}
            {previewUrl ? '閲嶆柊鐢熸垚' : 'AI 鐢熸垚鍘熷瀷'}
          </button>
        </div>
      </div>

      {/* Modify input */}
      {modifyOpen && (
        <div className="px-4 py-2 border-b bg-purple-50/30 dark:bg-purple-950/10 flex items-center gap-2 shrink-0">
          <input
            type="text"
            value={modifyInput}
            onChange={(e) => setModifyInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRefine()}
            placeholder="描述你想要的修改，例如：把按钮改成蓝色、增加导航栏、添加深色模式。"
            className="flex-1 text-sm bg-background border rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            onClick={handleRefine}
            disabled={!modifyInput.trim() || generating}
            className="p-1.5 rounded-md bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition shrink-0"
          >
            {generating ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      )}

      {/* Content */}
      <div className="relative flex-1 bg-muted/10" style={{ minHeight: '360px' }}>
        {generating && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 z-10">
            <div className="w-12 h-12 rounded-2xl bg-purple-100 dark:bg-purple-900 flex items-center justify-center">
              <Sparkles className="w-6 h-6 text-purple-500 animate-pulse" />
            </div>
            <p className="text-sm text-muted-foreground">AI 姝ｅ湪鐢熸垚 UI 鍘熷瀷...</p>
            <div className="flex gap-1">
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-purple-400 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <p className="text-sm text-red-500">{error}</p>
            <button onClick={handleGenerate} className="text-xs text-primary hover:underline">
              閲嶈瘯
            </button>
          </div>
        )}

        {!previewUrl && !generating && !error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="w-16 h-16 rounded-2xl bg-purple-50 dark:bg-purple-900 flex items-center justify-center">
              <Palette className="w-8 h-8 text-purple-400" />
            </div>
            <div className="text-center">
              <p className="text-sm text-muted-foreground mb-1">浣跨敤 AI 鐢熸垚浜や簰寮?UI 鍘熷瀷</p>
              <p className="text-xs text-muted-foreground/70">鎻忚堪浣犳兂瑕佺殑鐣岄潰锛孉I 灏嗚嚜鍔ㄧ敓鎴愬彲浜や簰鐨?HTML 椤甸潰</p>
            </div>
            <button
              onClick={handleGenerate}
              className="flex items-center gap-2 bg-purple-600 text-white px-5 py-2.5 rounded-xl hover:bg-purple-700 transition shadow-lg shadow-purple-200"
            >
              <Sparkles className="w-4 h-4" />
              AI 鐢熸垚 UI 鍘熷瀷
            </button>
          </div>
        )}

        {authedPreviewUrl && !generating && (
          <iframe
            ref={iframeRef}
            src={authedPreviewUrl}
            className="w-full h-full border-0"
            title="UI Prototype Preview"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
            style={{ height: '100%', minHeight: '360px' }}
          />
        )}
      </div>
    </div>
  )
}

