import { useState, useEffect, memo, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { marked } from 'marked'
// ─── 轻量级 Markdown 渲染（借鉴 LobeChat / chat-next-web 方案）──────────────
// 用 marked（~50KB 单文件解析器）替代 react-markdown + unified/remark/rehype 管线（~2MB+）。
// 原管线每次渲染都触发 V8 编译 14,487 个函数对象 = 1.6MB compiled code，直接导致 OOM。
// marked 是纯字符串→HTML 的单遍扫描器，零 AST 中间树、零插件编译、零 V8 bytecode 膨胀。
import { Message, ToolCallInfo, type MessageSearchInfo } from '@/store'
import { cn, formatDate } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ttsApi, type TtsVoice, type TtsVoicesResponse, type TtsChannelVoices, translateApi, type TranslateLang } from '@/lib/api'
import { parseUIBlocks } from '@/lib/uiBlocks'
import { sanitizeHtml } from '@/lib/sanitizeHtml'
import { renderMathInMarkdownSource } from '@/lib/renderMath'
import { UIBlockRenderer, type UIActionPayload } from '@/components/chat/UIBlockRenderer'
import { agentRegistryApi, type AgentRegistryItem } from '@/lib/api'
import { useSkillEditStore } from '@/lib/skillEditStore'
import { InlineInput } from './InlineInput'

// ─── marked 配置（一次性设置，全局复用）────────────────────────────────────
marked.setOptions({
  gfm: true,
  breaks: true,
})

// ─── 模块级缓存清理 ──────────────────────────────────────────────────────
// truncateCache 存储每条消息的截断版本，切换对话时需清理避免无限增长
const truncateCache = new Map<string, string>()

/** 清除所有模块级缓存（切换对话时调用） */
export function clearMessageCaches() {
  truncateCache.clear()
}

// ─── 剥离用户消息中的文件内容注入标记（后端存储时文件内容被注入到 content 中）───
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Bot, User, Copy, Check, RefreshCw, ThumbsUp, ThumbsDown, X,
  Languages, Volume2, VolumeX, Code, Play, ExternalLink, ChevronDown, ChevronUp,
  FileText, Image as ImageIcon, Loader2, Wrench, CheckCircle2, AlertCircle,
  Download, FileSpreadsheet, FileImage, ArrowDownToLine, Database, Search,
  Table, FilePlus, Sparkles, Package, Eye, EyeOff, Circle, Zap, Rocket,
} from 'lucide-react'
import { AutoCodeMessageCard } from './AutoCodeCard'
import FilePreviewDialog from './FilePreviewDialog'
import { ThinkingPanel } from './ThinkingPanel'
import { AnimatedAvatar } from './AnimatedAvatar'
import { useHighlight } from '@/hooks/useHighlight'

// ─── 剥离用户消息中的文件内容注入标记（后端存储时文件内容被注入到 content 中）───
function stripFileInjections(content: string): string {
  if (!content) return content
  let result = content
  // 1. 文本文件注入: \n\n--- 文件: name ---\ncontent...
  result = result.replace(/\n\n--- 文件: .+? ---\n[\s\S]*?(?=\n\n--- 文件: |\n\n\[|$)/g, '')
  // 2. 已上传文件标记（含服务器路径）
  result = result.replace(/\n\n\[已上传(文件|图片): .+?\]/g, '')
  // 3. 文件上传失败标记
  result = result.replace(/\n\n\[文件上传失败: .+?\]/g, '')
  // 4. 二进制文件提示
  result = result.replace(/\n\n\[已上传文件: .+?（二进制文件.+?）\]/g, '')
  return result.trim()
}

/** 获取用户消息的显示内容：剥离文件注入，如果剥离后为空则返回原始输入 */
function getUserDisplayContent(message: Message): string {
  const cleaned = stripFileInjections(message.content)
  // 如果剥离后还有文字就显示；否则返回空字符串（让文件卡片独立展示）
  return cleaned
}

function SearchResultsPanel({ search }: { search: MessageSearchInfo }) {
  const documents = search.documents || []
  const isSearching = search.status === 'searching'
  const hasError = search.status === 'error'
  const [expanded, setExpanded] = useState(false)
  const [previewDoc, setPreviewDoc] = useState<NonNullable<MessageSearchInfo['documents']>[number] | null>(null)
  const [previewHeight, setPreviewHeight] = useState(60)
  const canExpand = !isSearching && !hasError && documents.length > 0
  const scrollToChatBottom = useCallback(() => {
    const container = document.querySelector<HTMLElement>('[data-chat-scroll-container="true"]')
    if (container) {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' })
  }, [])
  const handlePreviewResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = previewHeight
    const onMove = (event: PointerEvent) => {
      const delta = startY - event.clientY
      const next = startHeight + (delta / window.innerHeight) * 100
      setPreviewHeight(Math.min(92, Math.max(42, next)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [previewHeight])
  return (
    <div className="w-full max-w-full rounded-xl border border-border/70 bg-background/80 p-2.5 sm:p-3 shadow-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground"
        onClick={() => canExpand && setExpanded(v => !v)}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          {isSearching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-foreground">{isSearching ? '正在联网搜索' : hasError ? '搜索未完成' : '联网搜索结果'}</span>
            {search.provider && <Badge variant="outline" className="h-4 px-1 text-[10px]">{search.provider}</Badge>}
          </div>
          <p className="truncate">{search.query || search.reason || '准备查询'}</p>
        </div>
        {canExpand && (
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </div>
        )}
      </button>

      {hasError && (
        <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">
          {search.errorMessage || search.errorCode || '搜索渠道暂不可用'}
        </div>
      )}

      {canExpand && expanded && (
        <div className="mt-2 grid gap-2">
          {documents.slice(0, 5).map((doc, idx) => {
            const host = doc.host?.hostname || (() => {
              try { return new URL(doc.url).hostname } catch { return '' }
            })()
            const image = doc.images?.[0]?.url
            return (
              <button
                key={`${doc.url}-${idx}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  scrollToChatBottom()
                  setPreviewDoc(doc)
                }}
                className="group grid w-full grid-cols-[1fr_auto] gap-2 rounded-lg border border-border/60 bg-card/60 p-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    {doc.host?.iconUrl && <img src={doc.host.iconUrl} alt="" className="h-3.5 w-3.5 rounded-sm" />}
                    <span className="truncate">{host || '网页'}</span>
                    {doc.publishTime && <span className="hidden sm:inline">· {doc.publishTime}</span>}
                  </div>
                  <div className="mt-0.5 flex items-start gap-1.5">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground group-hover:text-primary">
                      {doc.title || doc.url}
                    </p>
                    <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  </div>
                  {doc.snippet && (
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {doc.snippet}
                    </p>
                  )}
                </div>
                {image && (
                  <img
                    src={image}
                    alt={doc.images?.[0]?.alt || doc.title || ''}
                    className="h-14 w-16 rounded-md object-cover sm:h-16 sm:w-20"
                    loading="lazy"
                  />
                )}
              </button>
            )
          })}
        </div>
      )}
      {previewDoc && createPortal((
        <div className="fixed inset-0 z-[99990] flex items-end bg-black/45 backdrop-blur-[1px]" onClick={() => setPreviewDoc(null)}>
          <div
            className="w-full overflow-hidden rounded-t-2xl border border-border bg-background shadow-2xl"
            style={{ height: `${previewHeight}vh` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex h-5 cursor-ns-resize touch-none items-center justify-center"
              onPointerDown={handlePreviewResizeStart}
              title="拖拽调整预览窗口高度"
            >
              <div className="h-1 w-12 rounded-full bg-muted-foreground/35" />
            </div>
            <div className="flex items-start gap-2 border-b border-border p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-foreground">{previewDoc.title || previewDoc.url}</div>
                <div className="mt-0.5 truncate text-xs text-muted-foreground">{previewDoc.url}</div>
              </div>
              <a
                href={previewDoc.url}
                target="_blank"
                rel="noreferrer"
                aria-label="在新页面打开"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <ExternalLink className="h-4 w-4" />
              </a>
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setPreviewDoc(null)} aria-label="关闭预览">
                <X className="h-4 w-4" />
              </Button>
            </div>
            <iframe
              title={previewDoc.title || previewDoc.url}
              src={previewDoc.url}
              className="w-full bg-background"
              style={{ height: `calc(${previewHeight}vh - 77px)` }}
              sandbox="allow-same-origin allow-scripts allow-popups allow-forms"
            />
          </div>
        </div>
      ), document.body)}
    </div>
  )
}

// ─── 翻译语言 / TTS 音色（模块级缓存，首次打开下拉时动态获取）────────────
let cachedChannels: TtsChannelVoices[] | null = null   // 多渠道音色缓存（新）
let cachedVoices: TtsVoice[] | null = null             // 向后兼容：首个渠道的扁平音色
let cachedChannelId: string = ''
let cachedLangs: TranslateLang[] | null = null
let fetchingVoices: Promise<TtsVoicesResponse> | null = null
let fetchingLangs: Promise<TranslateLang[]> | null = null

/** 获取 TTS 音色列表（多渠道分组 + 向后兼容） */
export async function getTtsVoices(): Promise<TtsVoice[]> {
  if (cachedVoices) return cachedVoices
  if (fetchingVoices) return fetchingVoices.then(r => r.voices)
  fetchingVoices = ttsApi.getVoices().then(r => {
    // 缓存多渠道数据
    cachedChannels = r.channels || []
    cachedVoices = r.voices || []
    cachedChannelId = r.channelId || ''
    return r
  }).catch(() => {
    fetchingVoices = null
    // 降级：返回默认音色
    const fallback = [{ id: 'alloy', label: '标准' }, { id: 'echo', label: '男声' }, { id: 'fable', label: '英式' }, { id: 'onyx', label: '深沉' }, { id: 'nova', label: '女声' }, { id: 'shimmer', label: '柔和' }]
    return { voices: fallback as any, channels: [], channelId: '' } as any
  })
  return fetchingVoices.then(r => r.voices)
}

/** 获取多渠道音色数据（供组件内部使用） */
export function getCachedTtsChannels(): TtsChannelVoices[] { return cachedChannels || [] }

/** 获取翻译语言列表（带缓存） */
export async function getTranslateLangs(): Promise<TranslateLang[]> {
  if (cachedLangs) return cachedLangs
  if (fetchingLangs) return fetchingLangs
  fetchingLangs = translateApi.getLangs().then(l => { cachedLangs = l; return l }).catch(() => {
    fetchingLangs = null
    return [{ code: '英文', label: '🇺🇸 英文' }, { code: '日文', label: '🇯🇵 日文' }, { code: '韩文', label: '🇰🇷 韩文' }, { code: '法文', label: '🇫🇷 法文' }, { code: '德文', label: '🇩🇪 德文' }, { code: '西班牙文', label: '🇪🇸 西班牙文' }, { code: '俄文', label: '🇷🇺 俄文' }, { code: '阿拉伯文', label: '🇸🇦 阿拉伯文' }, { code: '中文', label: '🇨🇳 中文' }]
  })
  return fetchingLangs
}

// ─── 工具调用 UI 辅助函数 ─────────────────────────────────

/** 根据工具名返回对应的图标、颜色和中文名称 */
const getToolMeta = (toolName: string) => {
  const map: Record<string, { icon: React.ReactNode; color: string; bg: string; border: string; label: string }> = {
    upload_kg_table: { icon: <Database className="w-3.5 h-3.5" />, color: 'text-amber-600', bg: 'bg-amber-500/8', border: 'border-amber-500/20', label: '上传千克表' },
    upload_template: { icon: <Table className="w-3.5 h-3.5" />, color: 'text-indigo-600', bg: 'bg-indigo-500/8', border: 'border-indigo-500/20', label: '上传模板' },
    upload_procurement_excel: { icon: <FilePlus className="w-3.5 h-3.5" />, color: 'text-cyan-600', bg: 'bg-cyan-500/8', border: 'border-cyan-500/20', label: '解析订货单' },
    recognize_delivery_image: { icon: <FileImage className="w-3.5 h-3.5" />, color: 'text-purple-600', bg: 'bg-purple-500/8', border: 'border-purple-500/20', label: '识别送货单' },
    query_kg_table: { icon: <Search className="w-3.5 h-3.5" />, color: 'text-emerald-600', bg: 'bg-emerald-500/8', border: 'border-emerald-500/20', label: '查询千克表' },
    match_ledger_template: { icon: <Sparkles className="w-3.5 h-3.5" />, color: 'text-pink-600', bg: 'bg-pink-500/8', border: 'border-pink-500/20', label: '匹配模板' },
    fill_ledger_template: { icon: <Package className="w-3.5 h-3.5" />, color: 'text-orange-600', bg: 'bg-orange-500/8', border: 'border-orange-500/20', label: '填入数据' },
    generate_ledger_file: { icon: <FileSpreadsheet className="w-3.5 h-3.5" />, color: 'text-green-600', bg: 'bg-green-500/8', border: 'border-green-500/20', label: '生成台账' },
    external_upload: { icon: <ArrowDownToLine className="w-3.5 h-3.5" />, color: 'text-sky-600', bg: 'bg-sky-500/8', border: 'border-sky-500/20', label: '外网上报' },
  }
  return map[toolName] || { icon: <Wrench className="w-3.5 h-3.5" />, color: 'text-muted-foreground', bg: 'bg-muted/40', border: 'border-border', label: toolName }
}

/** 根据文件名返回文件附件的图标和颜色 */
const getAttachmentMeta = (fileName: string, fileType: string) => {
  const name = fileName.toLowerCase()
  if (fileType.startsWith('image/')) {
    return { icon: <FileImage className="w-4 h-4 text-purple-500" />, bg: 'bg-purple-500/10', border: 'border-purple-500/20', label: '图片' }
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return { icon: <FileSpreadsheet className="w-4 h-4 text-green-600" />, bg: 'bg-green-500/10', border: 'border-green-500/20', label: 'Excel' }
  }
  if (name.endsWith('.pdf')) {
    return { icon: <FileText className="w-4 h-4 text-red-500" />, bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'PDF' }
  }
  if (name.endsWith('.doc') || name.endsWith('.docx')) {
    return { icon: <FileText className="w-4 h-4 text-blue-500" />, bg: 'bg-blue-500/10', border: 'border-blue-500/20', label: 'Word' }
  }
  return { icon: <FileText className="w-4 h-4 text-muted-foreground" />, bg: 'bg-muted/50', border: 'border-border', label: '文件' }
}

// ─── ToolCallItem 子组件 ──────────────────────────────────────────────────────
// 必须是独立组件，不能直接内联在 .map() 里，否则 useState 违反 React Hooks 规则

function ToolCallItem({ tc }: { tc: ToolCallInfo }) {
  const meta = getToolMeta(tc.toolName)
  // 有下载链接时默认展开
  const [expanded, setExpanded] = useState<boolean>(
    !!(tc.result && tc.result.includes('download_url'))
  )

  if (tc.status === 'calling') {
    return (
      <div className="rounded-xl border text-xs overflow-hidden bg-blue-500/5 border-blue-500/20 shadow-sm">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <div className="w-6 h-6 rounded-full bg-blue-500/10 flex items-center justify-center">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-500 shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-blue-600 dark:text-blue-400 font-semibold">{meta.label}</span>
            <span className="text-muted-foreground ml-1.5">正在执行...</span>
          </div>
        </div>
      </div>
    )
  }

  if (tc.status === 'error') {
    return (
      <div className="rounded-xl border text-xs overflow-hidden bg-destructive/5 border-destructive/20">
        <div className="flex items-center gap-2.5 px-3.5 py-2.5">
          <div className="w-6 h-6 rounded-full bg-destructive/10 flex items-center justify-center">
            <AlertCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-destructive font-semibold">{meta.label}</span>
            <span className="text-muted-foreground ml-1.5">执行失败</span>
          </div>
        </div>
      </div>
    )
  }

  // completed
  return (
    <div className={cn('rounded-xl border text-xs overflow-hidden transition-all', meta.bg, meta.border)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2.5 px-3.5 py-2.5 hover:bg-black/3 dark:hover:bg-white/3 transition-colors text-left"
      >
        <div className={cn('w-6 h-6 rounded-full flex items-center justify-center shrink-0', meta.bg.replace('/8', '/15'))}>
          {meta.icon}
        </div>
        <span className={cn('font-semibold', meta.color)}>{meta.label}</span>
        <span className="text-muted-foreground ml-1">已完成</span>
        {tc.result && tc.result.includes('download_url') && (
          <Badge variant="outline" className="ml-1.5 text-[9px] h-4 px-1 border-green-500/30 text-green-600 bg-green-500/5">
            可下载
          </Badge>
        )}
        <ChevronDown className={cn('w-3.5 h-3.5 text-muted-foreground ml-auto transition-transform shrink-0', expanded && 'rotate-180')} />
      </button>
      {expanded && (
        <div className="border-t px-3.5 py-2.5 bg-background/40">
          {tc.arguments && (
            <div className="mb-2">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                <Code className="w-3 h-3" />
                <span>调用参数</span>
              </div>
              <pre className="p-2 bg-muted/60 rounded-lg text-[10px] overflow-x-auto max-h-[120px] whitespace-pre-wrap font-mono leading-relaxed">
                {(() => {
                  // 🔴 OOM 防御 — JSON 格式化输出长度限制
                  //    JSON.stringify(..., null, 2) 对 2000 字符的参数可能产生 6000+ 字符，
                  //    全部渲染为 DOM 文本节点 → 大量渲染内存。
                  const MAX_JSON_DISPLAY = 1500
                  try {
                    const formatted = JSON.stringify(JSON.parse(tc.arguments), null, 2)
                    if (formatted.length > MAX_JSON_DISPLAY) {
                      return formatted.slice(0, MAX_JSON_DISPLAY)
                        + '\n\n... [JSON 显示已截断，原 ' + formatted.length + ' 字符]'
                    }
                    return formatted
                  } catch { return tc.arguments }
                })()}
              </pre>
            </div>
          )}
          {tc.result && (() => {
            try {
              const resultObj = JSON.parse(tc.result)
              if (resultObj.download_url) {
                // download_url 可能是绝对路径或相对路径
                // 使用 fetch + Authorization header 下载，避免 <a href> 不带 token 导致 401
                const fullUrl = resultObj.download_url.startsWith('http')
                  ? resultObj.download_url
                  : window.location.origin + resultObj.download_url
                const handleDownload = async () => {
                  try {
                    // 从 localStorage 获取 token（与 api.ts getToken 逻辑一致）
                    const raw = localStorage.getItem('auth-store')
                    const token = raw ? JSON.parse(raw)?.state?.token : null
                    const headers: Record<string, string> = {}
                    if (token) headers['Authorization'] = `Bearer ${token}`
                    const res = await fetch(fullUrl, { headers })
                    if (!res.ok) {
                      alert(`下载失败：${res.status} ${res.statusText}`)
                      return
                    }
                    const blob = await res.blob()
                    const url = URL.createObjectURL(blob)
                    const a = document.createElement('a')
                    a.href = url
                    a.download = resultObj.file_name || '台账.xlsx'
                    document.body.appendChild(a)
                    a.click()
                    document.body.removeChild(a)
                    URL.revokeObjectURL(url)
                  } catch (e) {
                    alert('下载失败：' + (e instanceof Error ? e.message : String(e)))
                  }
                }
                return (
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-green-500/8 border border-green-500/20">
                    <div className="w-10 h-10 rounded-xl bg-green-500/15 flex items-center justify-center shrink-0">
                      <FileSpreadsheet className="w-5 h-5 text-green-600 dark:text-green-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-green-700 dark:text-green-300">
                        {resultObj.message || '台账文件已生成'}
                      </p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        共 {resultObj.row_count || '?'} 条记录 · {resultObj.file_name || '台账.xlsx'}
                      </p>
                    </div>
                    <button
                      onClick={handleDownload}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-xs font-semibold transition-all hover:shadow-md shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      下载
                    </button>
                  </div>
                )
              }
              return (
                <div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                    <CheckCircle2 className="w-3 h-3 text-green-500" />
                    <span>执行结果</span>
                  </div>
                  <pre className="p-2 bg-muted/60 rounded-lg text-[10px] overflow-x-auto max-h-[200px] whitespace-pre-wrap font-mono leading-relaxed">
                    {JSON.stringify(resultObj, null, 2)}
                  </pre>
                </div>
              )
            } catch { /* not JSON */ }
            return (
              <div>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1">
                  <CheckCircle2 className="w-3 h-3 text-green-500" />
                  <span>执行结果</span>
                </div>
                <pre className="p-2 bg-muted/60 rounded-lg text-[10px] overflow-x-auto max-h-[200px] whitespace-pre-wrap font-mono leading-relaxed">
                  {tc.result}
                </pre>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── SkillStepProgress 组件 ─────────────────────────────────────────────────
// 当 AI 消息中出现 "## 📋 第X步：" 格式的步骤标题时，渲染为可视化步骤进度条

interface SkillStep {
  icon: string     // emoji
  label: string    // 步骤名称
  index: number    // 步骤序号
  matched: boolean // 是否匹配到（出现在消息中）
}

const SKILL_STEP_PATTERN = /##\s*([📋🔧📝✅🚀🎉])\s*第(\d+)步[：:]\s*(.+)/g

function parseSkillSteps(content: string): SkillStep[] | null {
  const steps: SkillStep[] = []
  // 重新创建正则时必须保留 flags；否则丢失 `g` 会让 exec() 一直命中同一条结果，死循环直到 OOM。
  const regex = new RegExp(SKILL_STEP_PATTERN.source, SKILL_STEP_PATTERN.flags)
  const MAX_STEPS = 10

  for (const match of content.matchAll(regex)) {
    steps.push({
      icon: match[1],
      label: match[3].trim(),
      index: parseInt(match[2], 10),
      matched: true,
    })
    if (steps.length >= MAX_STEPS) break
  }
  return steps.length > 0 ? steps : null
}

function SkillStepProgress({ content }: { content: string }) {
  const steps = parseSkillSteps(content)
  if (!steps) return null

  // 找到最大步骤号来确定当前进度
  const maxStep = Math.max(...steps.map(s => s.index))
  // 定义完整的 5 步流程
  const allSteps = [
    { index: 1, icon: '📋', label: '分析代码' },
    { index: 2, icon: '🔧', label: '精简代码' },
    { index: 3, icon: '📝', label: '编写提示词' },
    { index: 4, icon: '✅', label: '准备发布' },
    { index: 5, icon: '🚀', label: '创建完成' },
  ]

  // 检测第5步完成
  const isComplete = steps.some(s => s.index === 5)

  return (
    <div className="mb-3 px-3 py-2.5 rounded-xl border bg-gradient-to-r from-blue-500/5 to-purple-500/5 border-blue-500/15">
      <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-2">
        <Rocket className="w-3 h-3 text-blue-500" />
        <span className="font-medium">技能创建进度</span>
      </div>
      <div className="flex items-center gap-1">
        {allSteps.map((step, i) => {
          const reached = step.index <= maxStep
          const isLast = i === allSteps.length - 1
          return (
            <div key={step.index} className="flex items-center gap-1 flex-1">
              <div className={cn(
                'flex items-center gap-1.5 px-1.5 py-1 rounded-md text-[11px] transition-all',
                reached
                  ? isComplete
                    ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                    : step.index === maxStep
                      ? 'bg-blue-500/10 text-blue-700 dark:text-blue-400'
                      : 'bg-blue-500/5 text-blue-600/70 dark:text-blue-400/70'
                  : 'bg-muted/40 text-muted-foreground/50'
              )}>
                <span className="text-xs">{reached ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}</span>
                <span className="whitespace-nowrap">{step.label}</span>
              </div>
              {!isLast && (
                <div className={cn('h-px flex-1 min-w-[8px]', i < maxStep - 1 ? 'bg-primary/40' : 'bg-muted-foreground/15')} />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── SkillCreationCard 组件 ─────────────────────────────────────────────────
// 当 quick_create_skill 工具调用成功时，渲染精美的技能摘要卡片

interface SkillCreationResult {
  skillName: string
  agentId: string
  toolCount: number
  tools: { name: string; description: string }[]
  status: string
  scriptPath?: string
  endpoint?: string
}

function parseSkillCreationResult(resultJson: string): SkillCreationResult | null {
  try {
    const obj = JSON.parse(resultJson)
    if (!obj.success || !obj.skillName) return null
    return {
      skillName: obj.skillName,
      agentId: obj.agentId,
      toolCount: obj.toolCount || 0,
      tools: obj.tools || [],
      status: obj.status || 'active',
      scriptPath: obj.scriptPath,
      endpoint: obj.endpoint,
    }
  } catch {
    return null
  }
}

function SkillCreationCard({ tc, onTest }: { tc: ToolCallInfo; onTest?: (skillName: string) => void }) {
  const skill = tc.status === 'completed' && tc.result ? parseSkillCreationResult(tc.result) : null
  if (!skill) return null

  return (
    <div className="rounded-xl border overflow-hidden bg-gradient-to-br from-emerald-500/5 to-teal-500/5 border-emerald-500/20 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-emerald-500/10">
        <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 truncate">
            {skill.skillName}
          </h4>
          <p className="text-[11px] text-muted-foreground font-mono">agent: {skill.agentId}</p>
        </div>
        <Badge className="text-[9px] h-5 bg-green-500/10 text-green-600 border-green-500/20">
          已激活
        </Badge>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        {/* Tools */}
        {skill.tools.length > 0 && (
          <div>
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground mb-1.5">
              <Wrench className="w-3 h-3" />
              <span>{skill.toolCount} 个工具</span>
            </div>
            <div className="space-y-1">
              {skill.tools.map((t, i) => (
                <div key={i} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md bg-muted/40">
                  <Zap className="w-3 h-3 text-amber-500 shrink-0" />
                  <span className="font-mono font-medium">{t.name}</span>
                  <span className="text-muted-foreground truncate">- {t.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-t border-emerald-500/10 bg-emerald-500/3">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 border-emerald-500/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10"
          onClick={() => onTest?.(skill.skillName)}
        >
          <Play className="w-3 h-3" />
          测试此技能
        </Button>
        <span className="text-[10px] text-muted-foreground">
          发送 "@{skill.agentId} 查询今天的排班" 即可测试
        </span>
      </div>
    </div>
  )
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── 常见语言显示名映射 ───────────────────────────────────────────────────
const USE_LANGUAGE_LABELS: Record<string, string> = {
  js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
  py: 'Python', rb: 'Ruby', java: 'Java', go: 'Go', rs: 'Rust',
  c: 'C', cpp: 'C++', cs: 'C#', swift: 'Swift', kt: 'Kotlin',
  php: 'PHP', sh: 'Bash', bash: 'Bash', zsh: 'Zsh', ps1: 'PowerShell',
  sql: 'SQL', json: 'JSON', yaml: 'YAML', yml: 'YAML', xml: 'XML',
  html: 'HTML', htm: 'HTML', css: 'CSS', scss: 'SCSS', less: 'Less',
  md: 'Markdown', dockerfile: 'Dockerfile', docker: 'Dockerfile',
  nginx: 'Nginx', graphql: 'GraphQL', toml: 'TOML', ini: 'INI',
  diff: 'Diff', svg: 'SVG', vue: 'Vue', svelte: 'Svelte',
  tf: 'Terraform', proto: 'Protobuf', lua: 'Lua', dart: 'Dart',
}

// ─── CodeBlock ─────────────────────────────────────────────────────────────

interface CodeBlockProps {
  code: string
  language: string
}

const buildHtmlPreviewDocument = (code: string) => {
  const trimmed = code.trim()
  const hasDocumentShell = /<!doctype\s+html|<html[\s>]/i.test(trimmed)
  if (hasDocumentShell) return trimmed

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    html, body { margin: 0; min-height: 100%; background: #fff; color: #111827; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { padding: 16px; box-sizing: border-box; }
  </style>
</head>
<body>
${trimmed}
</body>
</html>`
}

const CODE_FOLD_LINES = 30 // 超过此行数默认折叠

function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [output, setOutput] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [showOutput, setShowOutput] = useState(false)

  // ─── 语法高亮 + 行号 + 折叠 ────────────────────────────────────────────
  const [highlightedHtml, setHighlightedHtml] = useState<string>('')
  const [isFolded, setIsFolded] = useState(true) // 默认折叠
  const [lineCount, setLineCount] = useState(0)
  const [highlighting, setHighlighting] = useState(false)
  const { highlight } = useHighlight()
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const prevCodeLangRef = useRef('')

  // 语言显示名映射
  const displayLang = USE_LANGUAGE_LABELS[language] || language || 'code'
  const needsFold = lineCount > CODE_FOLD_LINES

  // 异步触发高亮（带防抖，流式场景避免频繁调用）
  useEffect(() => {
    const key = `${code}:${language}`
    if (key === prevCodeLangRef.current) return // 相同内容跳过
    prevCodeLangRef.current = key

    // 流式期间防抖 300ms
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
    setHighlighting(true)
    highlightTimerRef.current = setTimeout(async () => {
      try {
        const html = await highlight(code, language)
        setHighlightedHtml(sanitizeHtml(html))
        // 从 Shiki HTML 中统计行数（每个 <span class="line"> 算一行）
        const lines = (html.match(/class="line"/g) || []).length || code.split('\n').length
        setLineCount(lines)
        setIsFolded(lines > CODE_FOLD_LINES)
      } catch {
        setHighlightedHtml('')
      } finally {
        setHighlighting(false)
      }
    }, 300)

    return () => { if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current) }
  }, [code, language, highlight])

  const isHTML = language === 'html' || language === 'htm'
  const isRunnable = ['javascript', 'js', 'python', 'py', 'typescript', 'ts'].includes(language) || isHTML
  const htmlPreviewDocument = useMemo(() => isHTML ? buildHtmlPreviewDocument(code) : '', [code, isHTML])

  // ─── 复制 ──────────────────────────────────────────────────────────────
  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(code)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = code
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      alert('自动复制失败，请手动选中代码后按 Ctrl+C 复制')
    }
  }

  // ─── 运行 ──────────────────────────────────────────────────────────────
  const handleRun = async () => {
    if (isHTML) { setShowPreview(true); return }
    setIsRunning(true)
    setShowOutput(true)
    setOutput(null)

    if (language === 'javascript' || language === 'js') {
      try {
        const result = await new Promise<string>((resolve) => {
          const iframe = document.createElement('iframe')
          iframe.style.display = 'none'
          iframe.sandbox.add('allow-scripts')
          document.body.appendChild(iframe)

          const timeout = setTimeout(() => {
            document.body.removeChild(iframe)
            resolve('[超时] 代码执行超过 5 秒')
          }, 5000)

          const wrappedCode = `
            const __logs = [];
            const console = {
              log: (...a) => __logs.push(a.map(String).join(' ')),
              error: (...a) => __logs.push('[error] ' + a.map(String).join(' ')),
              warn: (...a) => __logs.push('[warn] ' + a.map(String).join(' ')),
            };
            try {
              ${code}
              parent.postMessage({ type: 'result', logs: __logs }, '*');
            } catch(e) {
              parent.postMessage({ type: 'error', message: e.message }, '*');
            }
          `
          const handler = (e: MessageEvent) => {
            if (e.source !== iframe.contentWindow) return
            clearTimeout(timeout)
            window.removeEventListener('message', handler)
            document.body.removeChild(iframe)
            if (e.data.type === 'result') {
              resolve(e.data.logs.join('\n') || '(无输出)')
            } else {
              resolve(`错误: ${e.data.message}`)
            }
          }
          window.addEventListener('message', handler)
          iframe.srcdoc = `<script>${wrappedCode}<\/script>`
        })
        setOutput(result)
      } catch (e) {
        setOutput(`错误: ${(e as Error).message}`)
      } finally {
        setIsRunning(false)
      }
      return
    }

    if (language === 'python' || language === 'py') {
      try {
        setOutput('⏳ 正在加载 Python 运行时（首次需要约 10 秒）...')
        let pyodide = (window as any).__pyodide
        if (!pyodide) {
          if (!(window as any).loadPyodide) {
            await new Promise<void>((resolve, reject) => {
              const s = document.createElement('script')
              s.src = 'https://cdn.jsdelivr.net/pyodide/v0.27.3/full/pyodide.js'
              s.onload = () => resolve()
              s.onerror = () => reject(new Error('Pyodide 脚本加载失败，请检查网络'))
              document.head.appendChild(s)
            })
          }
          setOutput('⏳ 初始化 Python 环境...')
          pyodide = await (window as any).loadPyodide()
          ;(window as any).__pyodide = pyodide
        }

        await pyodide.runPythonAsync(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
        `)
        let outputText = ''
        try {
          await pyodide.runPythonAsync(code)
          const stdout = await pyodide.runPythonAsync('sys.stdout.getvalue()')
          const stderr = await pyodide.runPythonAsync('sys.stderr.getvalue()')
          outputText = [stdout, stderr].filter(Boolean).join('\n') || '(无输出)'
        } catch (e: any) {
          outputText = `错误: ${e.message}`
        }
        setOutput(outputText)
      } catch (e: any) {
        setOutput(`Python 运行时加载失败: ${e.message}\n\n备选方案: https://replit.com 或 https://colab.research.google.com`)
      } finally {
        setIsRunning(false)
      }
      return
    }

    if (language === 'typescript' || language === 'ts') {
      setOutput('TypeScript 需要编译后执行。\n在线运行: https://www.typescriptlang.org/play')
    } else {
      setOutput(`${language} 代码无法在浏览器中执行，请复制到本地环境运行。`)
    }
    setIsRunning(false)
  }

  // ─── SVG 代码块：直接渲染为内联 SVG ────────────────────────────────────
  const isSvgBlock = code.trim().startsWith('<svg')
  if ((language === 'svg' || language === 'xml') && isSvgBlock) {
    return (
      <div className="my-3 rounded-xl overflow-hidden border border-blue-300 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-950/20">
        <div className="flex items-center justify-between px-4 py-2 bg-blue-100/50 dark:bg-blue-900/30 border-b border-blue-200 dark:border-blue-800">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
            <span className="text-xs font-medium text-blue-700 dark:text-blue-300">SVG 图形</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className={cn('h-7 px-2 text-xs gap-1 transition-colors', copied && 'text-green-500')} onClick={handleCopy}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? '已复制！' : '复制 SVG'}
            </Button>
          </div>
        </div>
        <div
          className="flex items-center justify-center p-4 bg-white dark:bg-neutral-900 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(code) }}
        />
      </div>
    )
  }

  // 🎨 兜底：无语言标签但内容识别为 SVG
  if (isSvgBlock && !language) {
    return (
      <div className="my-3 rounded-xl overflow-hidden border border-green-300 dark:border-green-700 bg-green-50/30 dark:bg-green-950/20">
        <div className="flex items-center justify-between px-4 py-2 bg-green-100/50 dark:bg-green-900/30 border-b border-green-200 dark:border-green-800">
          <div className="flex items-center gap-2">
            <ImageIcon className="w-3.5 h-3.5 text-green-600 dark:text-green-400" />
            <span className="text-xs font-medium text-green-700 dark:text-green-300">SVG 图形（自动识别）</span>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className={cn('h-7 px-2 text-xs gap-1 transition-colors', copied && 'text-green-500')} onClick={handleCopy}>
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {copied ? '已复制！' : '复制 SVG'}
            </Button>
          </div>
        </div>
        <div
          className="flex items-center justify-center p-4 bg-white dark:bg-neutral-900 overflow-x-auto"
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(code) }}
        />
      </div>
    )
  }

  // ─── 正常代码块（Shiki 高亮 + 行号 + 折叠） ───────────────────────────
  return (
    <div className="my-3 rounded-xl overflow-hidden border border-border/50 bg-muted/30">
      {/* 头部工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border/50">
        <div className="flex items-center gap-2">
          <Code className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-mono text-muted-foreground font-medium uppercase tracking-wide">
            {displayLang}
          </span>
          {lineCount > 0 && (
            <span className="text-[10px] text-muted-foreground/50 font-mono ml-1">
              {lineCount} 行
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {isRunnable && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs gap-1" onClick={handleRun} disabled={isRunning}>
              {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {isHTML ? '预览' : '运行'}
            </Button>
          )}
          <Button size="sm" variant="ghost" className={cn('h-7 px-2 text-xs gap-1 transition-colors', copied && 'text-green-500')} onClick={handleCopy}>
            {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
            {copied ? '已复制！' : '复制'}
          </Button>
        </div>
      </div>

      {/* 代码区域：Shiki 高亮 + CSS 行号 */}
      <div className={cn('relative', needsFold && isFolded && 'max-h-[600px] overflow-hidden')}>
        {highlighting && !highlightedHtml ? (
          // 高亮加载中 → 显示纯文本
          <pre className="overflow-x-auto min-w-0 p-4 text-sm leading-relaxed">
            <code className={`language-${language}`}>{code}</code>
          </pre>
        ) : highlightedHtml ? (
          // Shiki 高亮 HTML + 行号
          <div
            className="shiki-wrapper [counter-reset:line] overflow-x-auto min-w-0 [&_.line]:min-h-[1.5rem] [&_.line]:pl-12 [&_.line]:relative [&_.line]:block [&_.line::before]:[counter-increment:line] [&_.line::before]:[content:counter(line)] [&_.line::before]:absolute [&_.line::before]:left-0 [&_.line::before]:w-9 [&_.line::before]:text-right [&_.line::before]:pr-2 [&_.line::before]:text-[10px] [&_.line::before]:leading-relaxed [&_.line::before]:text-muted-foreground/40 [&_.line::before]:select-none [&_.line::before]:font-mono [&_.line::before]:tabular-nums"
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          // 无高亮（Shiki 未加载）→ 纯文本 + 行号
          <pre className="overflow-x-auto min-w-0 p-4 text-sm leading-relaxed [counter-reset:line]">
            <code className={`language-${language}`}>
              {code.split('\n').map((line, i) => (
                <span
                  key={i}
                  className="block min-h-[1.5rem] pl-12 relative [counter-increment:line] before:absolute before:left-0 before:w-9 before:text-right before:pr-2 before:text-[10px] before:text-muted-foreground/40 before:select-none before:font-mono before:tabular-nums before:[content:counter(line)]"
                >
                  {line || '\u00A0'}
                </span>
              ))}
            </code>
          </pre>
        )}

        {/* 折叠渐变遮罩 + 展开按钮 */}
        {needsFold && isFolded && (
          <div className="absolute bottom-0 left-0 right-0 h-24 bg-gradient-to-t from-muted/95 to-transparent pointer-events-none" />
        )}
      </div>

      {/* 折叠/展开按钮 */}
      {needsFold && (
        <button
          onClick={() => setIsFolded(!isFolded)}
          className="w-full flex items-center justify-center gap-1.5 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors border-t border-border/30"
        >
          {isFolded ? (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              展开全部 {lineCount} 行
            </>
          ) : (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              收起代码
            </>
          )}
        </button>
      )}

      {/* HTML 预览 */}
      {isHTML && showPreview && (
        <div className="border-t border-border/50">
          <div className="flex items-center justify-between px-4 py-2 bg-muted/30">
            <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5"><ExternalLink className="w-3 h-3" />页面预览</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setShowPreview(false)}>关闭</Button>
          </div>
          <iframe
            srcDoc={htmlPreviewDocument}
            className="w-full h-64 border-0 bg-white"
            sandbox="allow-scripts allow-forms allow-popups allow-modals"
            title="Preview"
          />
        </div>
      )}

      {/* 运行输出 */}
      {showOutput && (
        <div className="border-t border-border/50">
          <div className="flex items-center justify-between px-4 py-2 bg-muted/30">
            <span className="text-xs font-medium text-muted-foreground">输出</span>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setShowOutput(false)}>
              <ChevronUp className="w-3 h-3" />
            </Button>
          </div>
          <pre className="p-4 text-xs font-mono text-green-500 dark:text-green-400 bg-black/80 min-h-[3rem]">
            {isRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : (output || '')}
          </pre>
        </div>
      )}
    </div>
  )
}

// ─── MarkdownContent：基于 marked 的轻量级 React Markdown 渲染组件 ─────────
// 设计原则（借鉴 LobeChat / chat-next-web）：
//   1. marked.lexer() 分词为 token 数组（单遍扫描，O(n) 时间）
//   2. 每个 token 映射为一个 React 元素（代码块→CodeBlock，其他→HTML）
//   3. 非代码块用 dangerouslySetInnerHTML 渲染（marked 已处理 XSS 转义）
//   4. 无 remark/rehype 插件管线、无 AST 中间树、无 V8 bytecode 编译膨胀
//
// 内存对比（每条消息渲染一次）：
//   旧方案 react-markdown + 6 个插件: ~2MB compiled code + 3 棵 AST 树
//   新方案 marked: ~5KB token 数组 + HTML 字符串

interface MarkdownContentProps {
  content: string
  /** 用户与 UI 块交互时的回调，例如点击了选项芯片 */
  onUIAction?: (payload: string | UIActionPayload) => void
  /** 当前对话 ID（文件上传组件需要） */
  convId?: string
}

// ═══════════════════════════════════════════════════════════════════
// StreamingContent — 流式文本渲染（轻量，避免布局 OOM）
// ═══════════════════════════════════════════════════════════════════

/**
 * 🔴 OOM 修复（第 34 轮） — 流式 `<pre>` 渲染保护
 *
 * 问题：浏览器渲染进程在布局大文本时，`whitespace-pre-wrap` + `break-words` 组合
 * 迫使布局引擎逐字符计算换行 → 构建数千行 line box → OOM。
 * 即使 DOM 节点只有 1 个，渲染层内部数据可能数十倍膨胀。
 *
 * 修复：
 *   1. 仅显示尾部 STREAM_TAIL_CHARS 字符，让布局引擎处理短文本
 *   2. 添加 CSS containment 隔离布局影响
 *   3. 使用 `overflow: hidden` + `max-height` 限制渲染体积
 */
const STREAM_TAIL_CHARS = 8000
const StreamingContent = memo(function StreamingContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false)
  const preRef = useRef<HTMLPreElement>(null)
  const truncated = content.length > STREAM_TAIL_CHARS
  const displayContent = truncated && !expanded
    ? '[正在显示最新内容，流式结束后会显示完整回复]\n\n' + content.slice(-STREAM_TAIL_CHARS)
    : content

  useEffect(() => {
    const el = preRef.current
    if (!el) return

    const gapToBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (!expanded || gapToBottom < 96) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [content, expanded])

  return (
    <div className="space-y-2">
      {truncated && (
        <button
          type="button"
          onClick={() => setExpanded(v => !v)}
          className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/50 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? '收起到最新内容' : `已省略前 ${content.length - STREAM_TAIL_CHARS} 字，点此查看当前完整缓冲`}
        </button>
      )}
      <pre
        ref={preRef}
        className="chat-prose max-h-[min(58vh,520px)] overflow-y-auto whitespace-pre-wrap pr-1 text-sm leading-relaxed font-sans break-all overscroll-contain"
        style={{
          contain: 'content',
        }}
      >
        {displayContent}
      </pre>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span>AI 正在继续生成...</span>
        {content.length > 0 && <span>{content.length.toLocaleString()} 字符</span>}
      </div>
    </div>
  )
})

/**
 * 🔴 OOM 修复（第 33 轮） — MarkdownContent 渲染重写
 *
 * 问题根因：旧实现对 marked.lexer() 输出的每个非代码 token 单独调用 marked.parser([token])。
 *   对于 Agent Builder 第 4 步 25KB+ 的输出，lexer() 产生 50-100 个 token，
 *   在流式完成切换到 MarkdownContent 的同一 React 渲染帧内，
 *   50-100 次同步 marked.parser() 调用同时发生：
 *     - 每次调用创建 Renderer 对象和内部编译函数
 *     - 50-100 个 HTML 字符串通过 dangerouslySetInnerHTML 注入
 *     - 浏览器必须在同一帧解析所有 HTML 片段为 DOM 子树
 *   → 标签页内存瞬时耗尽 → "喔唷，崩溃啦！Out of Memory"
 *
 * 修复方案：
 *   1. 用标记占位符（§CODE§N§）替代代码块 token
 *   2. 对全部非代码 token 只调用 **1 次** marked.parser()
 *   3. 将输出的单个 HTML 字符串按标记分割，与 CodeBlock 组件交替渲染
 *   4. 渲染元素从 50-100 个 <div> 降低为 ~5 个 <div> + N 个 CodeBlock
 *   5. marked.parser 调用从 50-100 次降低为 **1 次**
 */
const MarkdownContent = memo(function MarkdownContent({ content, onUIAction, convId }: MarkdownContentProps) {
  const cached = useRef<{
    input: string
    parts: Array<{ type: 'html'; html: string } | { type: 'code'; text: string; lang: string }>
    uiBlockCount: number
  }>({ input: '', parts: [], uiBlockCount: 0 })

  // ── 第47轮：解析 UI 块 ─────────────────────────────────────────
  const { markdown: cleanContent, uiBlocks } = useMemo(
    () => parseUIBlocks(content),
    [content],
  )

  // 内容大小硬上限（第34轮：15KB，与 SSE 层统一）
  const MAX_CONTENT_CHARS = 15000
  const displayContent = cleanContent.length > MAX_CONTENT_CHARS
    ? cleanContent.slice(0, MAX_CONTENT_CHARS) + '\n\n[... 内容过长已截断，原 ' + cleanContent.length + ' 字符，上限 ' + MAX_CONTENT_CHARS + ' 字符 ...]'
    : cleanContent

  let parts = cached.current.parts
  if (displayContent !== cached.current.input) {
    try {
      // ─── 第42轮重写：用 HTML 注释标记替代代码块再解析 ─────────────────
      // 旧方案问题：marked.lexer()→tokens→在 paragraph token 插入标记→parser
      //  → marked.parser 用 tokens 数组重建内容，text 属性被忽略 → 标记丢失 → 所有代码块丢失
      //
      // 新方案：用正则预先替换 ```lang\ncode\n``` → <!--__CODE__N__lang__-->
      //  → HTML 注释能原样通过 marked.parse() → 按注释分割 → CodeBlock 渲染
      //  → 同时修复了 SVG 不渲染（lang='svg' 完整保留）、代码块丢失等问题
      const codeMap = new Map<number, { text: string; lang: string }>()
      // 匹配 fenced code block：```后面可选空格+language，然后是内容（跨行），```结束
      // 支持 \r\n 和 \n 两种换行
      const CODE_FENCE_RE = /```(\S*?)[ \t]*[\r\n]+([\s\S]*?)```/g
      let codeIdx = 0
      const markedSource = displayContent.replace(CODE_FENCE_RE, (_match, langStr, code) => {
        const idx = codeIdx++
        const lang = (langStr || '').trim()
        codeMap.set(idx, { text: code.trimEnd(), lang })
        return `<!--__CODE__${idx}__${lang}__-->`
      })
      const mathSource = renderMathInMarkdownSource(markedSource)

      // 一次性 marked.parse() 替代 lexer+parser
      const html = sanitizeHtml(marked.parse(mathSource, { breaks: true, gfm: true }) as string)

      // 按 HTML 注释标记分割，与 CodeBlock 交替
      const MARKER_RE = /<!--__CODE__(\d+)__(\S*?)__-->/g
      const newParts: typeof parts = []
      let lastIdx = 0
      let match: RegExpExecArray | null
      while ((match = MARKER_RE.exec(html)) !== null) {
        if (match.index > lastIdx) {
          newParts.push({ type: 'html', html: html.slice(lastIdx, match.index) })
        }
        const c = codeMap.get(parseInt(match[1], 10))
        if (c) {
          newParts.push({ type: 'code', text: c.text, lang: c.lang })
        }
        lastIdx = match.index + match[0].length
      }
      if (lastIdx < html.length) {
        newParts.push({ type: 'html', html: html.slice(lastIdx) })
      }

      parts = newParts
      cached.current = { input: displayContent, parts: newParts, uiBlockCount: uiBlocks.length }
    } catch {
      return <pre className="whitespace-pre-wrap">{displayContent}</pre>
    }
  }

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'code' ? (
          <CodeBlock key={i} code={part.text} language={part.lang} />
        ) : (
          <div key={i} className="md-block" dangerouslySetInnerHTML={{ __html: part.html }} />
        ),
      )}
      {uiBlocks.length > 0 && onUIAction && (
        <UIBlockRenderer blocks={uiBlocks} onAction={onUIAction} convId={convId} />
      )}
    </>
  )
})

interface MessageBubbleProps {
  message: Message
  isRecent?: boolean      // 是否为最近消息（兼容旧接口）
  renderLevel?: 1 | 2 | 3 // 🔴 第35轮新增：L3=完整渲染, L2=500字预览, L1=200字预览
  onRetry?: () => void
  onTranslate?: (messageId: string, targetLang: string) => void
  onSpeak?: (text: string, voice: string, messageId: string, channelId?: string | number) => void
  speakingId?: string | null
  onStopSpeak?: () => void
  /** 🔧 LobeChat 优化：本地流式内容缓冲（避免频繁 store 更新） */
  streamingContent?: string
  /** 用户与 UI 块交互时的回调（例如点击了选项芯片） */
  onUIAction?: (payload: string | UIActionPayload) => void
  /** 当前对话 ID（文件上传组件需要） */
  convId?: string
  /** 🧠 内联继续对话：用户在 AI 回复元素内的输入框中发送内容时的回调 */
  onContinueInPlace?: (content: string) => void
  /** 🧠 内联继续对话：当前是否正在内联生成中（控制 InlineInput 显示/隐藏） */
  inlineIsGenerating?: boolean
}

// ═══════════════════════════════════════════════════════════════════
// 🔴 OOM 修复（第 35 轮）— 三级渲染策略
//
// 回到旧对话时，一次性加载 20+ 条消息，每条都触发 marked.lexer() + parser()
// → 累积 DOM 解析在一帧内完成 → 标签页 OOM
//
// 三级策略：
//   L3 = 最近 5 条消息 → 完整 MarkdownContent 渲染（可展开的代码块/表格/列表）
//   L2 = 第 6-10 条消息 → 纯文本预览（首 500 字符，无 markdown 解析）
//   L1 = 第 11-20 条 → 超轻量预览（首 200 字符，零解析）
//   用户可点击"展开"升级到 L3
// ═══════════════════════════════════════════════════════════════════

const COLLAPSED_PREVIEW_CHARS = 500   // L2: 纯文本预览长度
const MINI_PREVIEW_CHARS = 200        // L1: 超轻量预览长度

/**
 * 折叠预览组件 — 零 markdown 解析，纯文本渲染
 * 用于非最近消息的初始显示，避免 20+ 条消息同时触发 markdown → HTML 转换
 */
const CollapsedContent = memo(function CollapsedContent({
  content,
  messageId,
  previewChars,
  onUIAction,
  convId,
}: {
  content: string
  messageId: string
  previewChars: number
  onUIAction?: (payload: string | UIActionPayload) => void
  convId?: string
}) {
  const [expanded, setExpanded] = useState(false)

  if (expanded) {
    // 展开后使用完整 MarkdownContent
    return <MarkdownContent content={content} onUIAction={onUIAction} convId={convId} />
  }

  const preview = content.length > previewChars
    ? content.slice(0, previewChars).replace(/\n{2,}/g, '\n') + '...'
    : content

  return (
    <div className="chat-prose">
      <pre className="whitespace-pre-wrap text-sm leading-relaxed font-sans break-all text-muted-foreground/70">
        {preview}
      </pre>
      {content.length > previewChars && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-1 text-xs text-primary hover:underline"
        >
          展开完整内容（{Math.round(content.length / 1024)}KB）
        </button>
      )}
    </div>
  )
})

/** 截断阈值：非最近消息超过此长度时截断显示 — 第35轮已废弃此逻辑，改用 CollapsedContent */
const TRUNCATE_THRESHOLD = 2000
const TRUNCATE_SUFFIX = '\n\n> ...（内容过长已截断，导出对话可查看完整内容）'

// 模块级截断缓存：避免重复创建截断字符串

/** 获取消息的显示内容（处理截断）— 第35轮保留兼容，但主要渲染路径不再使用 */
function getDisplayContent(message: Message, isRecent?: boolean): Message {
  if (isRecent || message.content.length <= TRUNCATE_THRESHOLD) return message
  const cached = truncateCache.get(message.id)
  if (cached) return { ...message, content: cached }
  const truncated = message.content.slice(0, TRUNCATE_THRESHOLD) + TRUNCATE_SUFFIX
  truncateCache.set(message.id, truncated)
  return { ...message, content: truncated }
}

export const MessageBubble = memo(function MessageBubble({ message, isRecent, renderLevel, onRetry, onTranslate, onSpeak, speakingId, onStopSpeak, streamingContent, onUIAction, convId, onContinueInPlace, inlineIsGenerating }: MessageBubbleProps) {
  const [showActions, setShowActions] = useState(false)
  const [liked, setLiked] = useState<null | boolean>(null)
  const [showTranslated, setShowTranslated] = useState(false)
  const [copied, setCopied] = useState(false)
  const [previewFile, setPreviewFile] = useState<import('@/store').FileAttachment | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [langs, setLangs] = useState<TranslateLang[]>([])
  const [loadingVoices, setLoadingVoices] = useState(false)
  const [loadingLangs, setLoadingLangs] = useState(false)
  const [ttsChannelId, setTtsChannelId] = useState<string>('')
  const [ttsChannels, setTtsChannels] = useState<TtsChannelVoices[]>([])  // 多渠道数据
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  const isUser = message.role === 'user'
  const isSpeaking = speakingId === message.id

  // ─── 自动检测技能名称 ─────────────────────────────────────
  const [detectedSkill, setDetectedSkill] = useState<{
    agentId: string
    name: string
    canEdit: boolean
  } | null>(null)
  const [detectingSkill, setDetectingSkill] = useState(false)
  const detectionCache = useRef<Map<string, any>>(new Map())

  // 🔴 OOM 诊断：追踪流式→静止的切换点
  const prevStreamingRef = useRef(message.isStreaming)
  if (prevStreamingRef.current && !message.isStreaming && message.content.length > 15000) {
    const contentKB = (message.content.length / 1024).toFixed(1)
    console.log(
      `[OOM-SWITCH] MessageBubble 流式→静止 | 内容: ${contentKB}KB | ` +
      `toolCalls: ${message.toolCalls?.length || 0} | msgId: ${message.id}`
    )
  }
  prevStreamingRef.current = message.isStreaming

  // 获取 TTS 音色列表（挂载时获取，带模块级缓存）
  useEffect(() => {
    let cancelled = false
    // 优先使用多渠道缓存
    const chCache = getCachedTtsChannels()
    if (chCache.length > 0) {
      setTtsChannels(chCache)
      // 扁平化所有渠道的音色（用于兼容）
      const all = chCache.flatMap(c => c.voices || [])
      if (all.length > 0) { setVoices(all); setTtsChannelId(chCache[0]?.channelId || ''); return }
    }
    if (cachedVoices && cachedChannelId) { setVoices(cachedVoices); setTtsChannelId(cachedChannelId); return }
    if (fetchingVoices) {
      fetchingVoices.then(r => {
        if (!cancelled) {
          const channels = r.channels || []
          setTtsChannels(channels)
          setVoices(r.voices || [])
          setTtsChannelId(r.channelId || '')
        }
      })
      return
    }
    setLoadingVoices(true)
    fetchingVoices = ttsApi.getVoices()
    fetchingVoices.then(r => {
      if (!cancelled) {
        const channels = r.channels || []
        setTtsChannels(channels)
        setVoices(r.voices || [])
        setTtsChannelId(r.channelId || '')
        setLoadingVoices(false)
      }
    }).catch(() => { fetchingVoices = null; if (!cancelled) setLoadingVoices(false) })
    return () => { cancelled = true }
  }, [])

  // 获取翻译语言列表（挂载时获取，带模块级缓存）
  useEffect(() => {
    let cancelled = false
    if (cachedLangs) { setLangs(cachedLangs); return }
    setLoadingLangs(true)
    getTranslateLangs().then(l => { if (!cancelled) { setLangs(l); setLoadingLangs(false) } })
    return () => { cancelled = true }
  }, [])

  // 停止朗读时清除预览音频
  useEffect(() => {
    if (!isSpeaking && previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl)
      setPreviewAudioUrl(null)
    }
  }, [isSpeaking])

  // ─── 自动检测技能名称（消息完成流式传输后）────────────────────
  useEffect(() => {
    // 只检测 AI 消息，且消息已完成（不再流式）
    if (isUser || message.isStreaming) return
    
    // 如果已经检测过，跳过
    if (detectedSkill) return
    
    // 检查缓存
    const cacheKey = `detect_${message.id}`
    if (detectionCache.current.has(cacheKey)) {
      const cached = detectionCache.current.get(cacheKey)
      if (cached) setDetectedSkill(cached)
      return
    }
    
    // 从消息内容中提取可能的技能名称
    const content = message.content
    if (!content || content.length < 10) return
    
    // 使用简单的关键词提取
    // 查找常见模式：技能 XXX、XXX 技能、使用 XXX、调用 XXX
    const extractSkillName = (text: string): string | null => {
      // 模式1: 技能名称（支持中文引号、英文引号、括号等）
      const pattern1 = text.match(/(?:技能|skill)[：:\s]+["「【]?([^"」】\n]{2,30})["」】]?(?:\s|$)/i)
      if (pattern1 && pattern1[1]) return pattern1[1].trim()
      
      // 模式2: XXX 技能
      const pattern2 = text.match(/(["「【]?([^"」】\n]{2,30})["」】]?)(?:\s|的)(?:技能|skill)/i)
      if (pattern2 && pattern2[1]) return pattern2[1].trim()
      
      // 模式3: 使用/调用 XXX
      const pattern3 = text.match(/(?:使用|调用|use|call)[了]?\s+["「【]?([^"」】\n]{2,30})["」】]?(?:\s|$)/i)
      if (pattern3 && pattern3[1]) return pattern3[1].trim()
      
      return null
    }
    
    const skillName = extractSkillName(content)
    if (!skillName) return
    
    // 调用 API 进行匹配
    setDetectingSkill(true)
    
    const doDetection = async () => {
      try {
        const matches = await agentRegistryApi.matchSkill(skillName)
        if (!matches || matches.length === 0) {
          detectionCache.current.set(cacheKey, null)
          return
        }
        
        // 取第一个匹配结果
        const match = matches[0]
        
        // 获取技能详情以检查权限
        try {
          const detail = await agentRegistryApi.getDetail(match.agentId)
          
          // 检查权限（只能编辑自己的技能）
          const currentUserId = localStorage.getItem('userId') || undefined
          const isOwner = currentUserId && detail.createdBy === parseInt(currentUserId)
          const isAdmin = localStorage.getItem('userRole') === 'ADMIN'
          const canEdit = isOwner || isAdmin
          
          const result = {
            agentId: match.agentId,
            name: match.name,
            canEdit
          }
          
          // 缓存结果
          detectionCache.current.set(cacheKey, result)
          setDetectedSkill(result)
        } catch (error) {
          console.warn('[SkillDetection] 获取技能详情失败:', error)
          detectionCache.current.set(cacheKey, null)
        }
      } catch (error) {
        console.warn('[SkillDetection] 技能匹配失败:', error)
        detectionCache.current.set(cacheKey, null)
      } finally {
        setDetectingSkill(false)
      }
    }
    
    doDetection()
  }, [message.id, message.content, message.isStreaming, isUser])

  /** 预览音色：调用后端生成短音频并播放（使用指定渠道） */
  const handlePreviewVoice = async (voiceId: string) => {
    await handlePreviewVoiceWithChannel(voiceId, ttsChannelId || undefined)
  }

  /** 预览音色（指定渠道 ID） */
  const handlePreviewVoiceWithChannel = async (voiceId: string, channelId?: string) => {
    try {
      const base64 = await ttsApi.preview(voiceId, undefined, channelId)
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'audio/mpeg' })
      const url = URL.createObjectURL(blob)
      if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl)
      setPreviewAudioUrl(url)
      const audio = new Audio(url)
      previewAudioRef.current = audio
      audio.play()
    } catch (e) {
      console.warn('音色预览失败:', e)
    }
  }

  // ✅ 内部截断：仅在非最近消息且内容过长时截断（首次渲染后缓存结果）
  // 由于 memo 的存在，非流式的已完成消息只渲染一次，之后不再重渲染
  const displayMsg = getDisplayContent(message, isRecent)

  // 🔧 LobeChat 优化：本地流式内容缓冲（避免频繁 store 更新）
  // 流式传输时优先使用 streamingContent（本地缓冲），完成后回退到 store 中的 message.content
  const effectiveContent = (message.isStreaming && streamingContent !== undefined)
    ? streamingContent
    : message.content

  const handleCopy = async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(displayMsg.content)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = displayMsg.content
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      alert('自动复制失败，请手动选中后按 Ctrl+C 复制')
    }
  }

  return (
    <div
      className={cn(
        'group flex gap-2 sm:gap-3 py-2 sm:py-3 message-animate',
        isUser ? 'flex-row-reverse px-2 sm:px-4' : 'px-3 sm:px-4'
      )}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
      onTouchStart={() => setShowActions(true)}
    >
      <div className="shrink-0">
        <AnimatedAvatar
          size={typeof window !== 'undefined' && window.innerWidth >= 640 ? 32 : 30}
          isStreaming={message.isStreaming}
          isUser={isUser}
          modelName={message.model}
        />
      </div>

      <div className={cn(
        'flex flex-col gap-1 min-w-0 overflow-visible',
        isUser ? 'max-w-[88%] sm:max-w-[80%] items-end' : 'flex-1 max-w-[calc(100%-2.5rem)] sm:max-w-[84%]'
      )}>
        <div className="flex items-center gap-1.5 sm:gap-2 text-xs text-muted-foreground">
          <span className="font-medium">{isUser ? '你' : (message.model || 'AI 助手')}</span>
          <span className="hidden sm:inline">{formatDate(message.timestamp)}</span>
          {message.tokens && <Badge variant="outline" className="text-[10px] h-4 px-1 hidden sm:flex">{message.tokens} tokens</Badge>}
        </div>

        {message.files && message.files.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-1.5">
            {message.files.map(file => {
              const isImage = file.type.startsWith('image/')
              const imageSrc = file.ossUrl || file.content || file.url
              const meta = getAttachmentMeta(file.name, file.type)
              return (
                <div key={file.id} className={cn(
                  'rounded-xl border text-xs overflow-hidden transition-all hover:shadow-sm cursor-pointer group',
                  isUser ? meta.bg + ' ' + meta.border : 'bg-muted border-border',
                  isImage && imageSrc ? 'max-w-[220px]' : 'flex items-center gap-2 px-3 py-2'
                )}
                onClick={() => { setPreviewFile(file); setPreviewOpen(true) }}
                >
                  {isImage && imageSrc ? (
                    <div className="space-y-1 p-1.5">
                      <img
                        src={imageSrc}
                        alt={file.name}
                        className="max-w-full max-h-[180px] rounded-lg object-contain cursor-pointer hover:opacity-80 transition-opacity"
                        onClick={() => {
                          const overlay = document.createElement('div')
                          overlay.className = 'fixed inset-0 z-[9999] bg-black/85 flex items-center justify-center p-4 cursor-pointer backdrop-blur-sm'
                          overlay.onclick = () => overlay.remove()
                          const img = document.createElement('img')
                          img.src = imageSrc
                          img.className = 'max-w-full max-h-full object-contain rounded-xl shadow-2xl'
                          overlay.appendChild(img)
                          const caption = document.createElement('div')
                          caption.className = 'absolute bottom-6 left-0 right-0 text-center text-white/80 text-sm'
                          caption.textContent = file.name
                          overlay.appendChild(caption)
                          document.body.appendChild(overlay)
                        }}
                      />
                      <div className="flex items-center gap-1.5 px-1">
                        {meta.icon}
                        <p className="text-[10px] text-muted-foreground truncate flex-1">{file.name}</p>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="shrink-0 w-8 h-8 rounded-lg bg-background/60 flex items-center justify-center">
                        {meta.icon}
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate max-w-[140px]">{file.name}</p>
                        <p className="text-[9px] text-muted-foreground">{meta.label}</p>
                      </div>
                    </>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Skill 工具调用展示 */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1.5 mb-2">
            {message.toolCalls.map(tc => {
              // quick_create_skill 完成后展示技能卡片
              if (tc.toolName === 'quick_create_skill' && tc.status === 'completed') {
                return <SkillCreationCard key={tc.toolCallId} tc={tc} />
              }
              return <ToolCallItem key={tc.toolCallId} tc={tc} />
            })}
          </div>
        )}

        {/* AutoCode 嵌入卡片（任务详情页） */}
        {message.autocode && (
          <div className="mt-2">
            <AutoCodeMessageCard message={message} />
          </div>
        )}

        {/* 技能创建步骤进度条 */}
        {!isUser && <SkillStepProgress content={displayMsg.content} />}

        {/* 深度思考内容 */}
        {!isUser && message.thinkingContent && (
          <ThinkingPanel content={message.thinkingContent} streaming={message.isStreaming} />
        )}

        {!isUser && message.search && (
          <SearchResultsPanel search={message.search} />
        )}

        {/* 🧠 Phase 2: 被抢占标记 — 显示在内容气泡上方 */}
        {message.preempted && !message.directionChanged && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground/70 mb-0.5 px-1">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/60" />
            <span>回复已被新消息抢占，内容可能不完整</span>
          </div>
        )}

        <div className={cn(
          'min-w-0 text-sm leading-relaxed',
          isUser
            ? 'rounded-2xl rounded-tr-sm bg-primary px-3 py-2.5 text-primary-foreground sm:px-4 sm:py-3 overflow-hidden'
            : 'mobile-ai-message rounded-none bg-transparent px-0 py-2.5 text-foreground sm:rounded-2xl sm:rounded-tl-sm sm:bg-muted/70 sm:px-4 sm:py-3',
          message.error && 'bg-destructive/10 border border-destructive/30 text-destructive',
          message.preempted && 'opacity-55 border border-dashed border-amber-500/30 rounded-2xl'
        )}>
          {message.error ? (
            <div className="flex items-center gap-2">
              <span>{message.error}</span>
              {onRetry && <button onClick={onRetry} className="underline hover:no-underline flex items-center gap-1"><RefreshCw className="w-3 h-3" />重试</button>}
            </div>
          ) : isUser ? (
            <p className="whitespace-pre-wrap">{getUserDisplayContent(displayMsg)}</p>
          ) : message.isStreaming ? (
            // 流式输出：纯文本渲染。React textContent 更新只需替换一个文本节点，零 DOM 解析开销。
            // 🔴 OOM 修复：流式期间仅显示尾部内容，避免 25KB+ 大文本的布局计算压垮浏览器渲染进程
            <StreamingContent content={effectiveContent} />
          ) : (() => {
            // 🔴 OOM 修复（第 35 轮）— 三级渲染策略
            // L3 (renderLevel=3): 完整 MarkdownContent 渲染 — 最近 5 条消息
            // L2 (renderLevel=2): 折叠预览 500 字符 — 第 6-10 条消息
            // L1 (renderLevel=1): 超轻量预览 200 字符 — 第 11+ 条消息
            // 效果：初始加载 20 条消息时，仅 5 条走完整 markdown 解析（降低 75% 渲染成本）
            const level = renderLevel ?? (isRecent ? 3 : 1)
            if (level === 3) {
              return <div className="chat-prose"><MarkdownContent content={effectiveContent} onUIAction={onUIAction} convId={convId} /></div>
            }
            return (
              <CollapsedContent
                content={effectiveContent}
                messageId={message.id}
                previewChars={level === 2 ? COLLAPSED_PREVIEW_CHARS : MINI_PREVIEW_CHARS}
                onUIAction={onUIAction}
                convId={convId}
              />
            )
          })()}
        </div>

        {/* 🧠 输出可撤销标记 — 被废弃的内容以灰色/删除线显示 */}
        {!isUser && message.discardedContent && (
          <div className="px-3 sm:px-4 py-1 text-xs text-muted-foreground/35 line-through opacity-50 break-all whitespace-pre-wrap max-h-[100px] overflow-hidden">
            {message.discardedContent.length > 300
              ? message.discardedContent.slice(0, 300) + '...'
              : message.discardedContent}
          </div>
        )}

        {/* 🧠 方向调整分隔线 — 抢占后继续在同一消息上生成时显示 */}
        {!isUser && message.directionChanged && !message.isStreaming && (
          <div className="flex items-center gap-2 py-1 px-1">
            <div className="flex-1 h-px bg-amber-500/25" />
            <span className="text-[10px] text-amber-500/60 font-medium whitespace-nowrap flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" />
              方向调整
            </span>
            <div className="flex-1 h-px bg-amber-500/25" />
          </div>
        )}

        {/* 🧠 内联继续对话输入框 — 嵌入在 AI 回复内容元素中 */}
        {/* 生成中仍显示 InlineInput（带 isGenerating=true 视觉提示），用户可随时介入 */}
        {/* preempted 消息也显示 InlineInput，允许用户继续对话 */}
        {!isUser && !message.error && onContinueInPlace && (
          <InlineInput
            onSend={onContinueInPlace}
            isGenerating={message.isStreaming || inlineIsGenerating}
            placeholder="继续对话…"
          />
        )}

        {/* 翻译结果 - 支持 Markdown 渲染 */}
        {message.translated && showTranslated && (
          <div className="bg-accent/50 rounded-lg px-3 py-2 text-sm text-muted-foreground border border-border/50 max-w-full">
            <p className="text-xs font-medium text-muted-foreground mb-1.5">翻译结果</p>
            {message.translated === '翻译中...' ? (
              <span className="flex items-center gap-1.5 text-xs"><Loader2 className="w-3 h-3 animate-spin" />翻译中...</span>
            ) : (
              <div className="chat-prose text-foreground"><MarkdownContent content={message.translated} onUIAction={onUIAction} convId={convId} /></div>
            )}
          </div>
        )}

        {/* Action bar - 移动端始终显示，桌面端 hover 显示 */}
        {!isUser && (
          <div className={cn(
            'flex items-center gap-0.5 transition-opacity duration-200',
            // 移动端始终显示（opacity-60），hover/touch 时完全显示
            'opacity-60 sm:opacity-0 group-hover:opacity-100',
            showActions && 'opacity-100'
          )}>
            {/* 复制 - 带动画 */}
            <button
              title={copied ? '已复制！' : '复制'}
              onClick={handleCopy}
              className={cn('p-1.5 rounded-md transition-all', copied ? 'text-green-500 bg-green-50 dark:bg-green-950/30' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
            >
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
            </button>

            {/* 翻译 - 下拉选语言 */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button title="翻译" className={cn('p-1.5 rounded-md transition-colors', message.translated ? 'text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}
                  onClick={() => message.translated && setShowTranslated(!showTranslated)}>
                  <Languages className="w-3.5 h-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-40">
                <div className="px-2 py-1 text-xs text-muted-foreground font-medium">翻译成</div>
                {loadingLangs && <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中...</div>}
                {!loadingLangs && langs.length === 0 && (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无语言配置</div>
                )}
                {langs.map(lang => (
                  <DropdownMenuItem key={lang.code} onClick={() => { onTranslate?.(message.id, lang.code); setShowTranslated(true) }} className="text-xs">
                    {lang.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* 语音朗读 - 带音色选择和中断 */}
            {isSpeaking ? (
              <button title="停止朗读" onClick={onStopSpeak} className="p-1.5 rounded-md text-primary bg-primary/10 hover:bg-primary/20 transition-colors">
                <VolumeX className="w-3.5 h-3.5" />
              </button>
            ) : (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button title="朗读" className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                    <Volume2 className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52 max-h-[320px] overflow-y-auto">
                  <div className="px-2 py-1 text-xs text-muted-foreground font-medium">选择音色（点击 🔊 预览）</div>
                  {loadingVoices && <div className="px-2 py-1.5 text-xs text-muted-foreground">加载中...</div>}
                  {!loadingVoices && ttsChannels.length === 0 && voices.length === 0 && (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">暂无音色配置</div>
                  )}
                  {/* 按渠道分组显示音色 */}
                  {ttsChannels.length > 0 ? ttsChannels.map(ch => (
                    <div key={ch.channelId}>
                      {/* 渠道分组标题 */}
                      <div className="px-2 pt-1.5 pb-0.5 text-[10px] font-medium text-primary/70 flex items-center gap-1">
                        <span>{ch.name}</span>
                        <span className="text-muted-foreground/50 font-normal">({ch.provider})</span>
                      </div>
                      {ch.voices.map(v => (
                        <div key={v.id} className="flex items-center px-2 py-1 hover:bg-accent rounded-sm cursor-pointer group">
                          <span
                            className="flex-1 text-xs truncate"
                            onClick={() => onSpeak?.(message.content, v.id, message.id, ch.channelId)}
                          >{v.label}</span>
                          <button
                            title="预览音色"
                            className="ml-1 p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={async e => { e.stopPropagation(); await handlePreviewVoiceWithChannel(v.id, ch.channelId) }}
                          >
                            <Volume2 className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )) : /* 向后兼容：无渠道分组时扁平显示 */ voices.map(v => (
                    <div key={v.id} className="flex items-center px-2 py-1 hover:bg-accent rounded-sm cursor-pointer group">
                      <span className="flex-1 text-xs" onClick={() => onSpeak?.(message.content, v.id, message.id, ttsChannelId || undefined)}>{v.label}</span>
                      <button
                        title="预览音色"
                        className="ml-1 p-0.5 rounded hover:bg-primary/10 text-muted-foreground hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={async e => { e.stopPropagation(); await handlePreviewVoice(v.id) }}
                      >
                        <Volume2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <button title="好评" onClick={() => setLiked(true)} className={cn('p-1.5 rounded-md transition-colors', liked === true ? 'text-green-500' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
              <ThumbsUp className="w-3.5 h-3.5" />
            </button>
            <button title="差评" onClick={() => setLiked(false)} className={cn('p-1.5 rounded-md transition-colors', liked === false ? 'text-red-500' : 'text-muted-foreground hover:text-foreground hover:bg-muted')}>
              <ThumbsDown className="w-3.5 h-3.5" />
            </button>
            {onRetry && (
              <button title="重新生成" onClick={onRetry} className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            )}

            {/* 编辑检测到的技能 */}
            {detectedSkill && detectedSkill.canEdit && (
              <button
                title={`编辑技能 ${detectedSkill.name}`}
                onClick={() => {
                  useSkillEditStore.getState().openSkillEditor(detectedSkill.agentId)
                }}
                className="p-1.5 rounded-md text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
              >
                <Wrench className="w-3.5 h-3.5" />
              </button>
            )}

            {/* 检测中提示 */}
            {detectingSkill && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/50" />
            )}
          </div>
        )}
      </div>

      {/* 文件预览 */}
      <FilePreviewDialog
        file={previewFile}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        allFiles={message.files || []}
        onNavigate={(f) => setPreviewFile(f)}
      />
    </div>
  )
}, (prevProps, nextProps) => {
  // 🔧 自定义比较：避免消息内容未变时的无效重渲染
  // 默认 shallow 比较看到新对象引用就重渲染 → 100 条消息全部重建 → OOM
  // 这里只比对实际会改变 UI 的字段
  const p = prevProps.message
  const n = nextProps.message
  if (p.id !== n.id) return false  // 不同消息，必须渲染
  if (p.content !== n.content) return false        // 内容变化（流式更新）
  if (p.isStreaming !== n.isStreaming) return false // 流式状态切换
  if (p.error !== n.error) return false             // 错误状态
  if (p.translated !== n.translated) return false   // 翻译结果
  if (prevProps.isRecent !== nextProps.isRecent) return false
  if (prevProps.speakingId !== nextProps.speakingId) return false
  // 工具调用状态变化
  const ptc = p.toolCalls?.length || 0
  const ntc = n.toolCalls?.length || 0
  if (ptc !== ntc) return false
  if (p.search?.status !== n.search?.status) return false
  if (p.search?.query !== n.search?.query) return false
  if ((p.search?.documents?.length || 0) !== (n.search?.documents?.length || 0)) return false
  if (p.search?.errorMessage !== n.search?.errorMessage) return false
  // 文件附件变化
  if ((p.files?.length || 0) !== (n.files?.length || 0)) return false
  // 流式内容变化（streamingBuffers local state 驱动的实时更新）
  if (prevProps.streamingContent !== nextProps.streamingContent) return false
  // 🧠 内联继续对话状态变化（显示/隐藏 InlineInput ↔ InlineGeneratingIndicator）
  if (prevProps.inlineIsGenerating !== nextProps.inlineIsGenerating) return false
  if (p.preempted !== n.preempted) return false  // 抢占标记变化 → 显示/隐藏 InlineInput
  // 🧠 输出可撤销标记字段变化
  if (p.splitPoint !== n.splitPoint) return false
  if (p.discardedContent !== n.discardedContent) return false
  if (p.directionChanged !== n.directionChanged) return false
  if (p.thinkingContent !== n.thinkingContent) return false
  return true // 跳过重渲染
})

export function TypingIndicator({ model }: { model: string }) {
  return (
    <div className="flex gap-3 px-4 py-3">
      <Avatar className="w-8 h-8 shrink-0 mt-0.5">
        <AvatarFallback className="bg-gradient-to-br from-primary/80 to-primary text-primary-foreground text-sm">
          <Bot className="w-4 h-4" />
        </AvatarFallback>
      </Avatar>
      <div className="flex flex-col gap-1">
        <div className="text-xs text-muted-foreground font-medium">{model}</div>
        <div className="bg-muted/70 rounded-2xl rounded-tl-sm px-4 py-3 flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 rounded-full bg-primary/60 animate-bounce" />
        </div>
      </div>
    </div>
  )
}
