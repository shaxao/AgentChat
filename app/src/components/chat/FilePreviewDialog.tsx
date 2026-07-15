import { useState, useEffect, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { FileAttachment } from '@/store'
import { getToken } from '@/lib/api-token'
import { cn } from '@/lib/utils'
import {
  X, Download, FileText, FileImage, FileSpreadsheet,
  Loader2, Maximize2, Minimize2, ChevronLeft, ChevronRight,
} from 'lucide-react'

interface FilePreviewDialogProps {
  file: FileAttachment | null
  open: boolean
  onClose: () => void
  /** 多文件时提供导航 */
  allFiles?: FileAttachment[]
  onNavigate?: (file: FileAttachment) => void
}

const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.c', '.cpp', '.h', '.hpp',
  '.go', '.rs', '.rb', '.php', '.sql', '.sh', '.bat', '.css', '.scss', '.less',
  '.html', '.htm', '.svg', '.csv', '.log', '.env',
])

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'])

const OFFICE_EXTS = new Set(['.xlsx', '.xls', '.docx', '.doc'])

export default function FilePreviewDialog({ file, open, onClose, allFiles, onNavigate }: FilePreviewDialogProps) {
  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const [textContent, setTextContent] = useState<string | null>(null)
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!file || !open) {
      setHtmlContent(null)
      setTextContent(null)
      setError(null)
      setLoading(false)
      setZoomed(false)
      fetchedRef.current = false
      return
    }

    if (fetchedRef.current) return
    fetchedRef.current = true

    const ext = file.name.toLowerCase().split('.').pop() || ''
    const extWithDot = '.' + ext

    // 图片：用 file.content (base64) 或 file.url
    if (isImage(file.type) || IMAGE_EXTS.has(extWithDot)) {
      return // 图片直接在 UI 中用 <img> 渲染
    }

    // 文本文件：直接用 file.content
    if (TEXT_EXTS.has(extWithDot) && file.content) {
      setTextContent(file.content)
      return
    }

    // Office 文件：调后端 API 获取 HTML 预览
    if (OFFICE_EXTS.has(extWithDot)) {
      loadOfficePreview(file)
      return
    }

    // PDF：直接用 iframe + file.url（或 content）
    if (ext === 'pdf') {
      return
    }

    // 其他：尝试读文本
    if (file.content) {
      setTextContent(file.content)
    } else {
      setError('不支持预览此文件类型')
    }
  }, [file, open])

  const loadOfficePreview = async (f: FileAttachment) => {
    setLoading(true)
    setError(null)
    try {
      const ext = f.name.toLowerCase().includes('.xls') ? 'xlsx' : 'docx'
      const endpoint = ext === 'xlsx' ? '/api/util/preview-xlsx' : '/api/util/preview-docx'

      // 优先 OSS URL（预签名 URL 可直接 fetch），其次 content base64，最后 blob URL
      let body: FormData
      if (f.ossUrl) {
        // OSS 预签名 URL → 直接 fetch
        const res = await fetch(f.ossUrl)
        if (!res.ok) throw new Error(`获取文件失败 (${res.status})`)
        const blob = await res.blob()
        body = new FormData()
        body.append('file', blob, f.name)
      } else if (f.content && f.content.startsWith('data:')) {
        // data URL → blob
        const res = await fetch(f.content)
        const blob = await res.blob()
        body = new FormData()
        body.append('file', blob, f.name)
      } else if (f.url) {
        const res = await fetch(f.url)
        const blob = await res.blob()
        body = new FormData()
        body.append('file', blob, f.name)
      } else {
        throw new Error('无法获取文件内容')
      }

      const token = getToken()
      const headers: Record<string, string> = {}
      if (token) headers['Authorization'] = `Bearer ${token}`

      const BASE_URL = (window as any).__API_URL__ || '/api'
      const resp = await fetch(`${BASE_URL.replace('/api', '')}${endpoint}`, {
        method: 'POST',
        headers,
        body,
      })
      if (!resp.ok) throw new Error(`预览失败 (${resp.status})`)
      const html = await resp.text()
      setHtmlContent(html)
    } catch (e) {
      setError(e instanceof Error ? e.message : '预览失败')
    } finally {
      setLoading(false)
    }
  }

  const fileIndex = allFiles ? allFiles.findIndex(f => f.id === file?.id) : -1
  const hasPrev = fileIndex > 0
  const hasNext = fileIndex >= 0 && fileIndex < (allFiles?.length || 0) - 1

  const handlePrev = () => {
    if (hasPrev && allFiles && onNavigate) onNavigate(allFiles[fileIndex - 1])
  }
  const handleNext = () => {
    if (hasNext && allFiles && onNavigate) onNavigate(allFiles[fileIndex + 1])
  }

  if (!file) return null

  const ext = file.name.toLowerCase().split('.').pop() || ''
  const extWithDot = '.' + ext
  const isImageFile = isImage(file.type) || IMAGE_EXTS.has(extWithDot)
  const isPdfFile = ext === 'pdf'
  const imageSrc = file.ossUrl || file.content || file.url

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className={cn(
        'p-0 gap-0 overflow-hidden border-0 shadow-2xl',
        zoomed ? 'max-w-[95vw] w-[95vw] max-h-[95vh] h-[95vh]' : 'max-w-3xl'
      )}>
        <DialogHeader className="flex-row items-center justify-between px-4 py-3 border-b shrink-0">
          <DialogTitle className="text-sm font-semibold flex items-center gap-2 truncate max-w-[60%]">
            {isImageFile ? <FileImage className="w-4 h-4 text-purple-500" /> :
             isPdfFile ? <FileText className="w-4 h-4 text-red-500" /> :
             file.name.endsWith('.xlsx') || file.name.endsWith('.xls') ? <FileSpreadsheet className="w-4 h-4 text-green-600" /> :
             <FileText className="w-4 h-4 text-muted-foreground" />}
            <span className="truncate">{file.name}</span>
          </DialogTitle>
          <div className="flex items-center gap-1">
            {allFiles && allFiles.length > 1 && (
              <>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handlePrev} disabled={!hasPrev}>
                  <ChevronLeft className="w-4 h-4" />
                </Button>
                <span className="text-xs text-muted-foreground">{fileIndex + 1}/{allFiles.length}</span>
                <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleNext} disabled={!hasNext}>
                  <ChevronRight className="w-4 h-4" />
                </Button>
              </>
            )}
            {file.url && (
              <a href={file.url} download={file.name} title="下载" className="inline-flex items-center justify-center rounded-md h-7 w-7 hover:bg-accent hover:text-accent-foreground transition-colors">
                <Download className="w-4 h-4" />
              </a>
            )}
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setZoomed(!zoomed)} title={zoomed ? '缩小' : '放大'}>
              {zoomed ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-auto bg-muted/20 min-h-[300px] max-h-[70vh] flex items-center justify-center">
          {loading && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">正在加载预览...</span>
            </div>
          )}

          {!loading && error && (
            <div className="flex flex-col items-center gap-3 text-destructive/80 p-8 text-center">
              <AlertCircle className="w-10 h-10" />
              <span className="text-sm">{error}</span>
              {textContent !== null && (
                <pre className="mt-4 p-4 bg-muted rounded-xl text-xs text-left overflow-auto max-h-[300px] max-w-full">
                  {textContent.slice(0, 5000)}
                </pre>
              )}
            </div>
          )}

          {!loading && !error && isImageFile && imageSrc && (
            <img
              src={imageSrc}
              alt={file.name}
              className="max-w-full max-h-full object-contain"
              style={{ maxHeight: zoomed ? 'calc(95vh - 60px)' : '70vh' }}
            />
          )}

          {!loading && !error && isPdfFile && (file.url || file.content) && (
            <iframe
              src={file.url || file.content}
              className="w-full h-full min-h-[500px] border-0"
              title={file.name}
            />
          )}

          {!loading && !error && htmlContent && (
            <iframe
              srcDoc={htmlContent}
              className="w-full h-full min-h-[400px] border-0"
              title={file.name}
              sandbox="allow-same-origin"
            />
          )}

          {!loading && !error && textContent !== null && !isImageFile && !isPdfFile && !htmlContent && (
            <pre className="w-full h-full p-4 text-xs font-mono leading-relaxed overflow-auto whitespace-pre-wrap bg-white dark:bg-muted rounded-b-lg">
              {textContent}
            </pre>
          )}

          {!loading && !error && !isImageFile && !isPdfFile && !htmlContent && textContent === null && !file.content && !file.url && (
            <div className="flex flex-col items-center gap-3 text-muted-foreground p-8 text-center">
              <FileText className="w-12 h-12 opacity-30" />
              <p className="text-sm">无法预览此文件</p>
              <p className="text-xs">文件类型不支持在线预览，请下载后查看</p>
              {file.url && (
                <a href={file.url} download={file.name} className="inline-flex items-center gap-1.5 text-primary hover:underline text-sm">
                  <Download className="w-4 h-4" /> 下载文件
                </a>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function isImage(type: string): boolean {
  return type.startsWith('image/')
}

function AlertCircle(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
    </svg>
  )
}
