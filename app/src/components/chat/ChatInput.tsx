import { useState, useRef, useEffect, useCallback } from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { Button } from '@/components/ui/button'
import { Send, Paperclip, Image as ImageIcon, X, FileText, Loader2, Square, FileSpreadsheet, FileImage, Eye, Zap, Bot, Sparkles, Wrench, Mic, MicOff, Brain } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useChatStore, useAdminStore, FileAttachment } from '@/store'
import { isDemoMode, uploadFileToOss, agentRegistryApi, AgentRegistryItem, transcribeAudioFile } from '@/lib/api'
import { hasCapability, getCapabilityLabel } from '@/config/capabilities'
import FilePreviewDialog from './FilePreviewDialog'
import { parseCommand, isCommand as isChatCommand, getCommandHelp, extractSkillName } from '@/lib/chatCommands'
import { useSkillEditStore } from '@/lib/skillEditStore'

interface ChatInputProps {
  onSend: (content: string, files?: FileAttachment[]) => void
  disabled?: boolean
  placeholder?: string
  conversationId?: string
  isGenerating?: boolean
  onStop?: () => void
  onAutoCode?: (description: string) => void
  /** 输入框上方自定义内容（如快速操作按钮） */
  aboveSlot?: React.ReactNode
  /** 消息提示文字（显示在输入框底部） */
  hintText?: string
  /** 外层容器自定义类名 */
  className?: string
  mobileBottomOffset?: string
  /** 排队中的消息数量（Phase 1: 动态干预 - 消息队列） */
  pendingCount?: number
}

// 判断文件是否为二进制格式（不可作为文本读取）
const isBinaryFile = (file: File): boolean => {
  const binaryExts = ['.xlsx', '.xls', '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.zip', '.rar', '.7z']
  const name = file.name.toLowerCase()
  return binaryExts.some(ext => name.endsWith(ext))
}

// 读取文件内容（图片→base64，文本→text，二进制→base64）
const readFileAsContent = (file: File): Promise<{ content: string; isBinary: boolean }> => {
  return new Promise((resolve, reject) => {
    if (file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => resolve({ content: reader.result as string, isBinary: false })
      reader.onerror = () => reject(new Error(`读取图片失败: ${file.name}`))
      reader.readAsDataURL(file)
    } else if (isBinaryFile(file)) {
      // 二进制文件：读为 base64（DataURL），标记 isBinary
      const reader = new FileReader()
      reader.onload = () => resolve({ content: reader.result as string, isBinary: true })
      reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`))
      reader.readAsDataURL(file)
    } else {
      const reader = new FileReader()
      reader.onload = () => resolve({ content: reader.result as string, isBinary: false })
      reader.onerror = () => reject(new Error(`读取文件失败: ${file.name}`))
      reader.readAsText(file)
    }
  })
}

const normalizeSpeechText = (value: string) => value.replace(/\s+/g, ' ').trim()

const appendSpeechSegment = (current: string, segment: string) => {
  const base = normalizeSpeechText(current)
  const next = normalizeSpeechText(segment)
  if (!base) return next
  if (!next) return base
  if (base.endsWith(next)) return base
  if (next.startsWith(base)) return next

  const maxOverlap = Math.min(base.length, next.length, 80)
  for (let len = maxOverlap; len >= 2; len--) {
    if (base.slice(-len) === next.slice(0, len)) {
      return `${base}${next.slice(len)}`
    }
  }
  return `${base} ${next}`
}

const composeSpeechInput = (base: string, spoken: string) => {
  const cleanBase = normalizeSpeechText(base)
  const cleanSpoken = normalizeSpeechText(spoken)
  if (!cleanBase) return cleanSpoken
  if (!cleanSpoken) return cleanBase
  return `${cleanBase} ${cleanSpoken}`
}

export default function ChatInput({ onSend, disabled, placeholder, conversationId, isGenerating, onStop, onAutoCode, aboveSlot, hintText, className, mobileBottomOffset = '0px', pendingCount = 0 }: ChatInputProps) {
  const [input, setInput] = useState('')
  const [files, setFiles] = useState<FileAttachment[]>([])
  const [reading, setReading] = useState(false)
  const [previewFile, setPreviewFile] = useState<FileAttachment | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const audioUploadRef = useRef<HTMLInputElement>(null)
  const inputWrapperRef = useRef<HTMLDivElement>(null)

  const isMobile = useIsMobile()

  const { selectedModel, setActiveSkillIds, activeSkillIds, thinkEnabled, setThinkEnabled } = useChatStore()
  const { models } = useAdminStore()
  const currentModel = models.find(m => m.id === selectedModel)

  // 🔧 斜杠命令状态
  const [slashOpen, setSlashOpen] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashSkills, setSlashSkills] = useState<AgentRegistryItem[]>([])
  const [slashLoading, setSlashLoading] = useState(false)
  const slashRef = useRef<HTMLDivElement>(null)

  // ─── 语音输入（Web Speech API + MediaRecorder 回退） ──────────────────────
  const [isListening, setIsListening] = useState(false)
  const [voiceSupported, setVoiceSupported] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const recognitionRef = useRef<any>(null)

  // MediaRecorder 回退（HTTP 环境下 Web Speech API 不可用）
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const liveTranscriptBaseRef = useRef('')
  const liveTranscriptRef = useRef('')
  const liveTranscribingRef = useRef(false)
  const liveTranscriptPendingRef = useRef(false)

  // 检测浏览器是否支持语音识别（仅在 HTTPS 或 localhost 下可用）
  useEffect(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    setVoiceSupported(!!SpeechRecognition)
  }, [])

  // 清理 recognition 实例 + MediaRecorder
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.abort() } catch {}
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stop() } catch {}
      }
    }
  }, [])

  // MediaRecorder 回退：录音 → 上传 → 后端 ASR → 文本
  const startMediaRecorder = useCallback(async () => {
    // HTTP 环境下 navigator.mediaDevices 为 undefined（浏览器安全策略）
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setVoiceError('语音输入需要 HTTPS 安全连接，请使用 https:// 地址访问')
      setTimeout(() => setVoiceError(null), 5000)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []
      liveTranscriptBaseRef.current = input.trimEnd()
      liveTranscriptRef.current = ''
      liveTranscribingRef.current = false
      liveTranscriptPendingRef.current = false

      const transcribeAudioBlob = async (audioBlob: Blob, suffix = 'live') => {
        if (audioBlob.size < 500) return ''
        const audioFile = new File([audioBlob], `voice-${suffix}-${Date.now()}.webm`, { type: mimeType })
        return normalizeSpeechText(await transcribeAudioFile(audioFile))
      }

      const transcribeLiveChunk = async (chunk: Blob) => {
        if (liveTranscribingRef.current) {
          liveTranscriptPendingRef.current = true
          return
        }

        liveTranscribingRef.current = true
        try {
          const text = await transcribeAudioBlob(chunk, 'live')
          if (text) {
            liveTranscriptRef.current = appendSpeechSegment(liveTranscriptRef.current, text)
            setInput(composeSpeechInput(liveTranscriptBaseRef.current, liveTranscriptRef.current))
          }
        } catch (e) {
          console.warn('[Voice] Live ASR chunk failed:', e)
        } finally {
          liveTranscribingRef.current = false
          if (liveTranscriptPendingRef.current && recorder.state !== 'inactive') {
            liveTranscriptPendingRef.current = false
          }
        }
      }

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data)
          void transcribeLiveChunk(e.data)
        }
      }

      recorder.onstop = async () => {
        // 停止所有音轨
        stream.getTracks().forEach(t => t.stop())

        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType })
        if (audioBlob.size < 500) {
          setVoiceError('录音太短，请重试')
          setTimeout(() => setVoiceError(null), 3000)
          return
        }

        setIsTranscribing(true)
        setVoiceError('正在识别语音…')
        try {
          // 上传音频文件到 OSS → 获取 URL → 发送到后端转录
          const text = await transcribeAudioBlob(audioBlob, 'final')
          if (text) {
            liveTranscriptRef.current = text
            setInput(composeSpeechInput(liveTranscriptBaseRef.current, text))
          }
          setVoiceError(null)
        } catch (e: any) {
          console.error('[Voice] Transcription failed:', e)
          setVoiceError(`语音识别失败: ${e.message || '请重试'}`)
          setTimeout(() => setVoiceError(null), 4000)
        } finally {
          setIsTranscribing(false)
        }
      }

      mediaRecorderRef.current = recorder
      recorder.start(3000)
      setIsListening(true)
    } catch (e: any) {
      console.error('[Voice] MediaRecorder failed:', e)
      if (e.name === 'NotAllowedError') {
        setVoiceError('麦克风权限被拒绝，请在浏览器设置中允许')
      } else {
        setVoiceError(`无法启动录音: ${e.message || e.name}`)
      }
      setTimeout(() => setVoiceError(null), 4000)
    }
  }, [input])

  const stopMediaRecorder = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    setIsListening(false)
  }, [])

  // 音频文件上传转文字（HTTP 环境替代方案）
  const handleAudioUpload = useCallback(() => {
    audioUploadRef.current?.click()
  }, [])

  const handleAudioFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // 重置 input 以允许重复选择同一文件
    e.target.value = ''

    setIsTranscribing(true)
    setVoiceError('正在识别音频文件…')
    try {
      const text = await transcribeAudioFile(file)
      if (text && text.trim()) {
        setInput(prev => {
          const base = prev.trimEnd()
          return base ? base + ' ' + text.trim() : text.trim()
        })
      }
      setVoiceError(null)
    } catch (err: any) {
      console.error('[Voice] Audio file transcription failed:', err)
      setVoiceError(`音频识别失败: ${err.message || '请重试'}`)
      setTimeout(() => setVoiceError(null), 5000)
    } finally {
      setIsTranscribing(false)
    }
  }, [])

  const handleVoiceToggle = useCallback(() => {
    // 优先使用 Web Speech API（HTTPS 环境，实时识别）
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

    if (isListening) {
      // 停止录音
      if (SpeechRecognition && recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        stopMediaRecorder()
      }
      setIsListening(false)
      return
    }

    if (SpeechRecognition) {
      // ─── 方式 1：Web Speech API（HTTPS） ───
      setVoiceError(null)
      const recognition = new SpeechRecognition()
      recognition.lang = 'zh-CN'
      recognition.interimResults = true
      recognition.continuous = true
      recognition.maxAlternatives = 1

      const speechBase = input.trimEnd()
      let fallbackStarted = false

      recognition.onresult = (event: any) => {
        let finalTranscript = ''
        let interim = ''
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i]
          if (result.isFinal) {
            finalTranscript += result[0].transcript
          } else {
            interim += result[0].transcript
          }
        }
        setInput(composeSpeechInput(speechBase, `${finalTranscript}${interim}`))
      }

      recognition.onerror = (event: any) => {
        console.warn('[Voice] Recognition error:', event.error)
        const fallbackErrors = new Set(['network', 'audio-capture', 'service-not-allowed'])
        if (fallbackErrors.has(event.error)) {
          fallbackStarted = true
          try { recognition.abort() } catch {}
          setIsListening(false)
          setVoiceError('浏览器实时语音识别不可用，已切换为录音转写模式')
          startMediaRecorder()
          return
        }
        if (event.error === 'not-allowed' || event.error === 'permission-denied') {
          setVoiceError('麦克风权限被拒绝，请在浏览器设置中允许麦克风访问')
        } else if (event.error === 'no-speech') {
          // 静默处理
        } else if (event.error !== 'aborted') {
          setVoiceError(`语音识别出错: ${event.error}`)
        }
        if (event.error !== 'no-speech') {
          setIsListening(false)
          setTimeout(() => setVoiceError(null), 4000)
        }
      }

      recognition.onend = () => {
        if (!fallbackStarted) {
          setIsListening(false)
        }
      }

      recognition.onstart = () => {
        setIsListening(true)
      }

      recognitionRef.current = recognition
      try {
        recognition.start()
      } catch (e) {
        console.warn('[Voice] Recognition start failed:', e)
        setIsListening(false)
        // HTTP 环境下 SpeechRecognition 也可能因安全策略被拒，回退到 MediaRecorder
        startMediaRecorder()
      }
    } else {
      // ─── 方式 2：MediaRecorder 回退（HTTP 环境） ───
      startMediaRecorder()
    }
  }, [isListening, startMediaRecorder, stopMediaRecorder])

  // 判断当前模型是否支持图片上传（Auto 模式由后端路由自动选择，原生 vision 或 tool 模型可通过 Vision 路由识别）
  const isAutoMode = selectedModel === 'auto'
  const hasVision = hasCapability(currentModel?.capabilities, 'vision')
  const hasTool = hasCapability(currentModel?.capabilities, 'tool')
  const canUploadImage = isAutoMode || hasVision || hasTool  // Auto 模式允许上传，后端路由会选 vision 模型

  // 自动调整textarea高度
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }, [input])

  // 🔧 OOM 修复：组件卸载时清理所有未释放的 blob URL（URL.createObjectURL）
  useEffect(() => {
    return () => {
      setFiles(currentFiles => {
        for (const f of currentFiles) {
          if (f.url?.startsWith('blob:')) URL.revokeObjectURL(f.url)
        }
        return currentFiles
      })
    }
  }, [])

  // 📱 移动端键盘适配：使用共享 Hook 检测键盘高度
  // 🔧 斜杠命令：打开时加载已安装技能
  useEffect(() => {
    if (!slashOpen) return
    setSlashLoading(true)
    agentRegistryApi.listInstalled()
      .then(list => setSlashSkills(list || []))
      .catch(() => setSlashSkills([]))
      .finally(() => setSlashLoading(false))
  }, [slashOpen])

  // 🔧 斜杠命令：点击外部关闭
  useEffect(() => {
    if (!slashOpen) return
    const handler = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) {
        setSlashOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [slashOpen])

  // 选中图片文件
  const handleImageClick = () => {
    if (!canUploadImage) {
      return
    }
    imageInputRef.current?.click()
  }

  // 选中任意文件
  const handleFileClick = () => {
    fileInputRef.current?.click()
  }

  // 处理文件选择
  const handleFilesSelected = useCallback(async (fileList: FileList, isImage: boolean) => {
    setReading(true)
    const now = Date.now()

    // Step 1: 并行读取所有文件内容（base64预览用）
    const readTasks = Array.from(fileList).map((file, i) =>
      readFileAsContent(file)
        .then(({ content, isBinary }) => ({
          file,
          content,
          isBinary,
          ok: true as const,
          i,
          attachmentId: `file-${now}-${i}`,
        }))
        .catch(err => {
          console.warn('读取文件失败:', file.name, err)
          return {
            file,
            ok: false as const,
            i,
            attachmentId: `file-${now}-${i}-err`,
          }
        })
    )
    const results = await Promise.all(readTasks)

    // Step 2: 构建 FileAttachment 列表 + 收集需要 OSS 上传的条目
    const newFiles: FileAttachment[] = []
    const uploadEntries: { attachmentId: string; file: File }[] = []

    for (const r of results) {
      if (!r.ok) {
        newFiles.push({
          id: r.attachmentId,
          name: r.file.name,
          size: r.file.size,
          type: r.file.type,
          url: URL.createObjectURL(r.file),
          ossUploadStatus: 'error' as const,
        })
      } else {
        newFiles.push({
          id: r.attachmentId,
          name: r.file.name,
          size: r.file.size,
          type: r.file.type,
          url: URL.createObjectURL(r.file),
          content: r.content,
          isBinary: r.isBinary,
          ossUploadStatus: 'uploading' as const,
        })
        uploadEntries.push({ attachmentId: r.attachmentId, file: r.file })
      }
    }

    setFiles(prev => [...prev, ...newFiles])
    setReading(false)

    // Step 3: 并行上传到 OSS（用 attachmentId 精确匹配，不依赖 find）
    const uploadPromises = uploadEntries.map(({ attachmentId, file }) =>
      uploadFileToOss(file, conversationId)
        .then(result => {
          setFiles(prev => prev.map(f2 =>
            f2.id === attachmentId
              ? { ...f2, ossUrl: result.url, ossUploadStatus: 'success' as const }
              : f2
          ))
        })
        .catch(err => {
          console.warn('OSS 上传失败，将降级为 base64:', file.name, err)
          setFiles(prev => prev.map(f2 =>
            f2.id === attachmentId
              ? { ...f2, ossUploadStatus: 'error' as const }
              : f2
          ))
        })
    )

    void Promise.allSettled(uploadPromises)
  }, [])

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(e.target.files, true)
    }
    e.target.value = ''
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesSelected(e.target.files, false)
    }
    e.target.value = ''
  }

  // 粘贴上传：截图 (Ctrl+V) 或从文件管理器复制的文件
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return

    const pastedFiles: File[] = []
    for (let i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        const file = items[i].getAsFile()
        if (file) pastedFiles.push(file)
      }
    }

    if (pastedFiles.length === 0) {
      // 纯文本粘贴，保持默认行为
      return
    }

    // 有文件 → 阻止默认粘贴行为（否则会粘贴文件名文本）
    e.preventDefault()

    // 用 DataTransfer 构造 FileList（handleFilesSelected 的参数类型）
    const dt = new DataTransfer()
    pastedFiles.forEach(f => dt.items.add(f))
    handleFilesSelected(dt.files, false)
  }

  const removeFile = (idx: number) => {
    setFiles(prev => {
      const file = prev[idx]
      if (file?.url?.startsWith('blob:')) URL.revokeObjectURL(file.url)
      return prev.filter((_, i) => i !== idx)
    })
  }

  const handlePreview = (file: FileAttachment, idx: number) => {
    setPreviewFile(file)
    setPreviewOpen(true)
  }

  // 处理聊天命令
  const handleChatCommand = useCallback(async (cmd: any) => {
    const { command, args } = cmd
    
    if (command === '/edit-skill' || command === '/edit') {
      const skillName = extractSkillName(args)
      if (!skillName) {
        alert('请提供技能名称。用法：/edit-skill <技能名>')
        return
      }
      
      // 触发技能编辑
      useSkillEditStore.getState().triggerFromCommand(skillName)
      
      // 清空输入框
      setInput('')
      setSlashOpen(false)
      
    } else if (command === '/view-skill' || command === '/view') {
      const skillName = extractSkillName(args)
      if (!skillName) {
        alert('请提供技能名称。用法：/view-skill <技能名>')
        return
      }
      
      // 触发查看技能详情
      window.dispatchEvent(
        new CustomEvent('skill-view-command', {
          detail: { skillIdentifier: skillName }
        })
      )
      
      // 清空输入框
      setInput('')
      setSlashOpen(false)
      
    } else if (command === '/help') {
      // 显示帮助信息
      alert(getCommandHelp())
      setInput('')
      setSlashOpen(false)
      
    } else {
      alert(`未知命令: ${command}。输入 /help 查看可用命令。`)
    }
  }, [])

  const handleSend = () => {
    if (!input.trim() && files.length === 0) return
    // 🧠 Phase 1: 动态干预 — 不再阻止 isGenerating 时的发送
    // 用户在生成中发送消息会触发排队/抢占逻辑（由 ChatPage.handleSend 处理）
    if (disabled) return
    
    // 检查是否是命令（以 / 开头且不是斜杠技能选择）
    if (input.trim().startsWith('/')) {
      const cmd = parseCommand(input.trim())
      if (cmd) {
        handleChatCommand(cmd)
        return
      }
    }
    
    onSend(input, files.length > 0 ? files : undefined)
    setInput('')
    // 释放所有 Blob URL，防止内存泄漏
    for (const f of files) {
      if (f.url?.startsWith('blob:')) URL.revokeObjectURL(f.url)
    }
    setFiles([])
    textareaRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 检查是否是命令（以 / 开头且不是技能选择）
    const isCommandInput = input.trim().startsWith('/') && 
                         !input.trim().match(/^\/[a-zA-Z0-9_-]*\s*$/)
    
    // 如果是命令，不显示斜杠下拉
    if (isCommandInput) {
      setSlashOpen(false)
    }
    
    // 🔧 斜杠命令导航
    if (slashOpen && !isCommandInput) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIndex(prev => Math.min(prev + 1, filteredSlashSkills.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIndex(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        if (filteredSlashSkills.length > 0 && filteredSlashSkills[slashIndex]) {
          e.preventDefault()
          handleSlashSelect(filteredSlashSkills[slashIndex])
          return
        }
        // 无匹配技能时正常发送
        e.preventDefault()
        setSlashOpen(false)
        handleSend()
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashOpen(false)
        return
      }
    }

    // 普通 Enter 发送（Phase 1: 动态干预 — 生成中也可以发送，消息进入队列）
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // 🔧 输入变更处理（检测 / 斜杠命令或技能选择）
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value
    setInput(value)
    
    // 检测 / 开头
    if (value.startsWith('/')) {
      // 检查是否是命令（包含空格，如 /edit-skill pdf）
      const hasSpace = value.includes(' ')
      const isCommand = hasSpace || value.match(/^\/[a-zA-Z-]+$/)
      
      if (isCommand && !value.match(/^\/[a-zA-Z0-9_-]+$/)) {
        // 是命令，不显示技能选择下拉
        setSlashOpen(false)
      } else {
        // 是技能选择，显示下拉
        const query = value.slice(1)
        setSlashQuery(query)
        setSlashIndex(0)
        setSlashOpen(true)
      }
    } else {
      setSlashOpen(false)
    }
  }

  // 🔧 过滤后的斜杠技能列表
  const filteredSlashSkills = slashQuery
    ? slashSkills.filter(s =>
        s.name.toLowerCase().includes(slashQuery.toLowerCase()) ||
        s.description.toLowerCase().includes(slashQuery.toLowerCase())
      )
    : slashSkills

  // 🔧 选择斜杠技能 — 选择后不自动发送，保留为可编辑的可选标题
  const handleSlashSelect = (skill: AgentRegistryItem) => {
    setActiveSkillIds([skill.agentId])
    // 提取 /命令 之后的实际输入内容
    const afterSlash = input.slice(1 + slashQuery.length).trimStart()
    setSlashOpen(false)
    // 保留用户已输入的内容（如果有），否则清空输入框让用户补充内容
    setInput(afterSlash)
    // 聚焦输入框，方便用户立即补充内容
    setTimeout(() => textareaRef.current?.focus(), 0)
  }

  // 🔧 技能图标
  const getSkillIcon = (item: AgentRegistryItem) => {
    if (item.icon && item.icon.trim() && item.icon.length <= 4) {
      return <span className="text-base">{item.icon}</span>
    }
    const name = item.name.toLowerCase()
    if (name.includes('台账') || name.includes('ledger')) return <FileText className="w-3.5 h-3.5" />
    if (name.includes('翻译') || name.includes('transl')) return <Sparkles className="w-3.5 h-3.5" />
    return <Wrench className="w-3.5 h-3.5" />
  }

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  }

  // 根据文件类型返回对应的图标和样式
  const getFileMeta = (file: FileAttachment) => {
    const name = file.name.toLowerCase()
    if (file.type.startsWith('image/')) {
      return { icon: <FileImage className="w-5 h-5 text-purple-500" />, bg: 'bg-purple-500/10', border: 'border-purple-500/20', label: '图片' }
    }
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      return { icon: <FileSpreadsheet className="w-5 h-5 text-green-600" />, bg: 'bg-green-500/10', border: 'border-green-500/20', label: 'Excel' }
    }
    if (name.endsWith('.pdf')) {
      return { icon: <FileText className="w-5 h-5 text-red-500" />, bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'PDF' }
    }
    if (name.endsWith('.doc') || name.endsWith('.docx')) {
      return { icon: <FileText className="w-5 h-5 text-blue-500" />, bg: 'bg-blue-500/10', border: 'border-blue-500/20', label: 'Word' }
    }
    return { icon: <FileText className="w-5 h-5 text-muted-foreground" />, bg: 'bg-muted/50', border: 'border-border', label: '文件' }
  }

  return (
    <div
      ref={inputWrapperRef}
      className={cn('border-t bg-card/50 backdrop-blur-sm sm:border-t sm:bg-card/50', className)}
      style={{
        paddingBottom: isMobile
          ? `calc(${mobileBottomOffset} + var(--mobile-safe-bottom) + var(--mobile-browser-bottom))`
          : undefined,
      }}
    >
      {/* 自定义上方区域（如快速操作按钮） */}
      {aboveSlot}

      {/* 已选技能标签（可取消） */}
      {activeSkillIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2 px-1">
          {activeSkillIds.map(skillId => {
            const skill = slashSkills.find(s => s.agentId === skillId)
            if (!skill) return null
            return (
              <div
                key={skillId}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary/10 border border-primary/20 text-[11px] text-primary font-medium group"
              >
                {getSkillIcon(skill)}
                <span className="max-w-[100px] truncate">{skill.name}</span>
                <button
                  onClick={() => setActiveSkillIds(activeSkillIds.filter(id => id !== skillId))}
                  className="ml-0.5 w-3.5 h-3.5 rounded-full flex items-center justify-center hover:bg-primary/20 transition-colors"
                  title="取消选择"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* 文件预览区域 */}
      {files.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2.5">
          {files.map((file, idx) => {
            const meta = getFileMeta(file)
            const isImage = file.type.startsWith('image/')
            return (
              <div key={idx} className={cn(
                "relative group rounded-xl border p-2.5 flex items-center gap-2.5 max-w-[240px] transition-all hover:shadow-sm cursor-pointer",
                meta.bg, meta.border
              )}>
                <button
                  onClick={() => removeFile(idx)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-destructive text-destructive-foreground rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:scale-110 shadow-sm z-10"
                  title="移除文件"
                >
                  <X className="w-3 h-3" />
                </button>
                {/* 预览按钮 */}
                <button
                  onClick={(e) => { e.stopPropagation(); handlePreview(file, idx) }}
                  className="absolute top-1.5 left-1.5 w-6 h-6 bg-background/90 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-background shadow-sm z-10"
                  title="预览文件"
                >
                  <Eye className="w-3 h-3 text-foreground" />
                </button>
                <div onClick={() => handlePreview(file, idx)} className="flex items-center gap-2.5 flex-1 min-w-0">
                {isImage && file.url ? (
                  <div className="relative shrink-0">
                    <img src={file.url} alt={file.name} className="w-14 h-14 object-cover rounded-lg border border-black/5" />
                    <span className="absolute -bottom-1 -right-1 bg-purple-500 text-white text-[9px] px-1 py-0.5 rounded-full font-medium">
                      {meta.label}
                    </span>
                  </div>
                ) : (
                  <div className="shrink-0 w-12 h-12 rounded-lg bg-background/80 flex items-center justify-center border border-black/5">
                    {meta.icon}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold truncate max-w-[140px] text-foreground">{file.name}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-muted-foreground">{formatFileSize(file.size)}</span>
                    <span className="text-[9px] px-1 py-0.5 rounded-full bg-background/80 text-muted-foreground border border-black/5 font-medium">
                      {meta.label}
                    </span>
                  </div>
                  {/* OSS 上传状态 */}
                  {file.ossUploadStatus === 'uploading' && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">上传中...</p>
                  )}
                  {file.ossUploadStatus === 'error' && (
                    <p className="text-[10px] text-orange-500 mt-0.5">上传失败，将使用原文件</p>
                  )}
                </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 输入卡片 — 工具栏 + 输入框分离布局，借鉴现代聊天 App */}
      <div className="mx-2 my-1 rounded-2xl border border-border/70 bg-background/92 shadow-lg shadow-black/5 backdrop-blur-md transition-all focus-within:border-primary/30 focus-within:shadow-xl sm:mx-3 sm:my-2 sm:border-2 sm:border-primary/10 sm:bg-background sm:shadow-sm sm:focus-within:border-primary/25 sm:focus-within:shadow-md">

        {/* 隐藏的文件输入 */}
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
        <input ref={imageInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageChange} />
        <input ref={audioUploadRef} type="file" accept="audio/*" className="hidden" onChange={handleAudioFileChange} />

        {/* ── 工具栏行 — 紧凑图标按钮 ── */}
        <div className="flex items-center gap-0.5 px-1.5 pt-1.5 sm:px-2 sm:pt-2">
          {/* 文件上传 */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="shrink-0 h-8 w-8 sm:h-9 sm:w-9 rounded-lg hover:bg-primary/10 transition-colors"
            onClick={handleFileClick}
            disabled={disabled || isGenerating}
            title="上传文件"
          >
            <Paperclip className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />
          </Button>

          {/* 图片上传 */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              'shrink-0 h-8 w-8 sm:h-9 sm:w-9 rounded-lg hover:bg-primary/10 transition-colors',
              !canUploadImage && 'opacity-50 cursor-not-allowed'
            )}
            onClick={handleImageClick}
            disabled={disabled || isGenerating}
            title={isAutoMode ? '上传图片（智能路由自动选择模型）'
              : hasVision ? '上传图片（原生识图）'
              : hasTool ? '上传图片（Vision 路由识别）'
              : '当前模型不支持识图，请切换到支持 vision 或 tool 的模型'}
          >
            <ImageIcon className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />
          </Button>

          {/* 深度思考 */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              'shrink-0 h-8 w-8 sm:h-9 sm:w-9 rounded-lg transition-all',
              thinkEnabled
                ? 'bg-amber-500/15 text-amber-500 hover:bg-amber-500/25'
                : 'hover:bg-primary/10'
            )}
            onClick={() => setThinkEnabled(!thinkEnabled)}
            disabled={disabled || isGenerating}
            title={thinkEnabled ? '深度思考：已开启' : '深度思考：已关闭'}
          >
            <Brain className={cn('w-4 h-4 sm:w-[18px] sm:h-[18px]', thinkEnabled && 'animate-pulse')} />
          </Button>

          {/* 语音输入 */}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              'shrink-0 h-8 w-8 sm:h-9 sm:w-9 rounded-lg transition-all',
              isListening
                ? 'bg-red-500/15 text-red-500 hover:bg-red-500/25 animate-pulse'
                : 'hover:bg-primary/10'
            )}
            onClick={handleVoiceToggle}
            disabled={disabled || isTranscribing}
            title={isTranscribing ? '正在识别语音…' : isListening ? '点击停止录音' : '语音输入'}
          >
            {isTranscribing
              ? <Loader2 className="w-4 h-4 sm:w-[18px] sm:h-[18px] animate-spin" />
              : isListening
                ? <MicOff className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />
                : <Mic className="w-4 h-4 sm:w-[18px] sm:h-[18px]" />}
          </Button>

          <div className="flex-1" />

          {/* 深度思考状态文字指示 */}
          {thinkEnabled && (
            <span className="text-[10px] text-amber-500 font-medium pr-1.5 select-none">深度思考</span>
          )}
        </div>

        {/* ── 输入行 — textarea + 发送按钮 ── */}
        <div className="relative flex items-end gap-1.5 px-1.5 pb-1.5 sm:px-2 sm:pb-2">
          {/* 斜杠命令下拉菜单 */}
          {slashOpen && (
            <div
              ref={slashRef}
              className="absolute left-0 right-0 bottom-full mb-1 z-50"
            >
              <div className="bg-card border rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-bottom-2">
                {/* 头部 */}
                <div className="px-3 py-2 border-b flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-medium">
                    输入 / 快速使用技能
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 ml-auto">
                    ↑↓ 导航  Enter 选择  Esc 关闭
                  </span>
                </div>

                {/* 列表 */}
                <div className="max-h-[220px] overflow-y-auto p-1">
                  {slashLoading ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                    </div>
                  ) : filteredSlashSkills.length === 0 ? (
                    <div className="text-center py-6 text-xs text-muted-foreground">
                      {slashQuery ? `未找到匹配 "${slashQuery}" 的技能` : '暂无已安装的技能，前往技能商店安装'}
                    </div>
                  ) : (
                    filteredSlashSkills.map((skill, idx) => (
                      <button
                        key={skill.agentId}
                        onClick={() => handleSlashSelect(skill)}
                        onMouseEnter={() => setSlashIndex(idx)}
                        className={cn(
                          'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors',
                          idx === slashIndex
                            ? 'bg-primary/10 ring-1 ring-primary/20'
                            : 'hover:bg-muted/60'
                        )}
                      >
                        <div className={cn(
                          'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                          idx === slashIndex ? 'bg-primary/15' : 'bg-muted'
                        )}>
                          {getSkillIcon(skill)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{skill.name}</p>
                          {skill.description && (
                            <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                              {skill.description}
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0 bg-muted px-1.5 py-0.5 rounded-full font-medium">
                          /{skill.agentId}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 输入框 — Phase 1: 动态干预，生成时不锁定 */}
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder || (canUploadImage ? '输入消息，输入 / 使用技能，或上传文件、图片…' : '输入消息，输入 / 使用技能，或上传文件…')}
            disabled={disabled}
            rows={1}
            className={cn(
              'flex-1 resize-none rounded-xl border-0 bg-transparent px-2 py-2 text-sm',
              'focus:outline-none focus:ring-0',
              'placeholder:text-muted-foreground/50',
              'max-h-[160px] overflow-y-auto min-h-[36px] sm:min-h-[40px]'
            )}
          />

          {/* 发送/停止按钮 — Phase 1: 动态干预，发送按钮始终可用 */}
          <div className="flex items-center gap-1.5 shrink-0">
            {isGenerating && onStop && (
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10"
                onClick={onStop}
                title="停止生成"
              >
                <Square className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground shadow-sm"
              onClick={handleSend}
              disabled={disabled || (!input.trim() && files.length === 0)}
            >
              {reading ? <Loader2 className="w-4 h-4 sm:w-5 sm:h-5 animate-spin" /> : <Send className="w-4 h-4 sm:w-5 sm:h-5" />}
            </Button>
          </div>
        </div>
      </div>

      {/* Phase 1: 动态干预 — 排队消息指示器 */}
      {pendingCount > 0 && (
        <div className="mt-1.5 flex items-center gap-1.5 animate-in fade-in slide-in-from-top-1">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400 text-xs font-medium">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>{pendingCount} 条消息排队中，将在当前回复后自动发送</span>
          </div>
        </div>
      )}

      {!isAutoMode && !hasVision && !hasTool && files.some(f => f.type.startsWith('image/')) && (
        <p className="text-xs text-amber-500 mt-1">⚠️ 当前模型不支持图片识别，图片将无法被 AI 理解。请切换到支持 vision 或 tool 的模型。</p>
      )}
      {!isAutoMode && !hasVision && hasTool && files.some(f => f.type.startsWith('image/')) && (
        <p className="text-xs text-blue-500 mt-1">🔧 当前模型无原生 vision 能力，图片将通过 Vision 路由由其他模型识别后转为文字描述。</p>
      )}

      {activeSkillIds.length > 0 && currentModel && selectedModel !== 'auto' && !hasCapability(currentModel.capabilities, 'tool') && (
        <p className="text-xs text-red-500 mt-1 font-medium">⚠️ 当前模型 {currentModel.name} 不支持 {getCapabilityLabel('tool')}（工具调用），使用技能将功能受限。请切换到支持 tool 标签的模型（如 gpt-4o、claude-3-5-sonnet 等）。</p>
      )}

      {/* 语音错误提示 + 上传音频按钮 */}
      {voiceError && (
        <div className="mt-1 flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
          <p className="text-xs text-amber-500">
            ⚠️ {voiceError}
          </p>
          {(voiceError.includes('HTTPS') || voiceError.includes('http')) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 text-xs border-amber-300 text-amber-700 hover:bg-amber-50"
              onClick={handleAudioUpload}
              disabled={isTranscribing}
            >
              {isTranscribing ? '识别中…' : '上传音频转文字'}
            </Button>
          )}
        </div>
      )}

      {/* 底部提示文字 */}
      {hintText && (
        <p className="text-[10px] text-muted-foreground mt-1.5 text-center">{hintText}</p>
      )}

      {/* 文件预览对话框 */}
      <FilePreviewDialog
        file={previewFile}
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        allFiles={files}
        onNavigate={(f) => setPreviewFile(f)}
      />
    </div>
  )
}
