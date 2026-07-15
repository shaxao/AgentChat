import { useState, useRef, useEffect, useCallback } from 'react'
import { Send, Loader2, Mic, MicOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { transcribeAudioFile } from '@/lib/api'

interface InlineInputProps {
  /** 用户发送内容时的回调 */
  onSend: (content: string) => void
  /** 是否正在生成中（生成时仍显示输入框，但添加视觉提示） */
  isGenerating?: boolean
  /** 占位提示文字 */
  placeholder?: string
  /** 自定义类名 */
  className?: string
}

const normalizeSpeechText = (value: string) => value.replace(/\s+/g, ' ').trim()

const composeSpeechInput = (base: string, spoken: string) => {
  const cleanBase = normalizeSpeechText(base)
  const cleanSpoken = normalizeSpeechText(spoken)
  if (!cleanBase) return cleanSpoken
  if (!cleanSpoken) return cleanBase
  return `${cleanBase} ${cleanSpoken}`
}

/**
 * 轻量级内联输入组件 — 嵌入到 AI 回复消息气泡底部
 *
 * 设计意图（参考研究文档 3.3 节）：
 * - 用户在 AI 回复元素内直接输入，无需滚动到底部
 * - 输入后携带当前上下文继续对话，AI 回复追加到同一消息元素
 * - 极简设计：只有文本输入 + 发送按钮，无文件上传/语音/斜杠命令
 */
export function InlineInput({
  onSend,
  isGenerating = false,
  placeholder = '继续对话…',
  className,
}: InlineInputProps) {
  const [text, setText] = useState('')
  const [isListening, setIsListening] = useState(false)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<any>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])

  // 自适应高度
  const adjustHeight = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
  }, [])

  useEffect(() => {
    adjustHeight()
  }, [text, adjustHeight])

  useEffect(() => {
    return () => {
      try { recognitionRef.current?.abort?.() } catch {}
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop() } catch {}
      }
    }
  }, [])

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
    // 重置高度
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }, [text, onSend])

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  const startRecorderFallback = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setVoiceError('当前浏览器不支持麦克风录音，请使用 HTTPS 或上传音频')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'
      const recorder = new MediaRecorder(stream, { mimeType })
      audioChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data)
      }
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        setIsListening(false)
        const blob = new Blob(audioChunksRef.current, { type: mimeType })
        if (blob.size < 500) return

        setIsTranscribing(true)
        setVoiceError('正在使用 ASR 识别语音...')
        try {
          const file = new File([blob], `inline-voice-${Date.now()}.webm`, { type: mimeType })
          const result = await transcribeAudioFile(file)
          if (result.trim()) {
            setText(prev => {
              const base = prev.trimEnd()
              return base ? `${base} ${result.trim()}` : result.trim()
            })
          }
          setVoiceError(null)
        } catch (err: any) {
          setVoiceError(`语音识别失败: ${err?.message || '请稍后重试'}`)
        } finally {
          setIsTranscribing(false)
        }
      }

      recorderRef.current = recorder
      recorder.start()
      setIsListening(true)
      setVoiceError('录音中，点击麦克风结束后识别')
    } catch (err: any) {
      setVoiceError(`无法启动麦克风: ${err?.message || err?.name || '权限被拒绝'}`)
    }
  }, [])

  const handleVoiceToggle = useCallback(() => {
    if (isListening) {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        try { recorderRef.current.stop() } catch {}
      }
      setIsListening(false)
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      void startRecorderFallback()
      return
    }

    setVoiceError(null)
    const recognition = new SpeechRecognition()
    recognition.lang = 'zh-CN'
    recognition.interimResults = true
    recognition.continuous = true
    recognition.maxAlternatives = 1

    const speechBase = text.trimEnd()
    recognition.onresult = (event: any) => {
      let finalTranscript = ''
      let interim = ''
      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i]
        if (result.isFinal) finalTranscript += result[0].transcript
        else interim += result[0].transcript
      }
      setText(composeSpeechInput(speechBase, `${finalTranscript}${interim}`))
    }
    recognition.onerror = () => {
      setIsListening(false)
      void startRecorderFallback()
    }
    recognition.onstart = () => setIsListening(true)
    recognition.onend = () => setIsListening(false)
    recognitionRef.current = recognition

    try {
      recognition.start()
    } catch {
      void startRecorderFallback()
    }
  }, [isListening, startRecorderFallback])

  const voiceButton = (
    <button
      onClick={handleVoiceToggle}
      disabled={isTranscribing}
      className={cn(
        'shrink-0 rounded-lg p-1.5 transition-all',
        isListening
          ? 'bg-red-500/15 text-red-500 animate-pulse'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
        isTranscribing && 'cursor-wait opacity-70',
      )}
      title={isListening ? '停止语音输入' : '语音输入'}
    >
      {isTranscribing
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : isListening
          ? <MicOff className="w-3.5 h-3.5" />
          : <Mic className="w-3.5 h-3.5" />}
    </button>
  )

  if (isGenerating) {
    // 生成中：仍显示输入框，但添加视觉提示（脉冲边框 + 旋转图标 + 不同 placeholder）
    return (
      <div
        className={cn(
          'relative mt-2 flex items-end gap-1.5 rounded-xl border border-primary/30 bg-background/60 px-2 py-1.5',
          'transition-colors focus-within:border-primary/60 focus-within:bg-background',
          'animate-pulse-border',
          className,
        )}
      >
        <Loader2 className="w-3.5 h-3.5 animate-spin text-primary/50 shrink-0 mb-1" />
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="AI 正在生成中，输入即可介入…"
          rows={1}
          className={cn(
            'flex-1 resize-none bg-transparent text-sm leading-relaxed',
            'placeholder:text-muted-foreground/50',
            'outline-none border-none',
            'max-h-[120px]',
          )}
          style={{ minHeight: '24px' }}
        />
        {voiceButton}
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className={cn(
            'shrink-0 rounded-lg p-1.5 transition-all',
            text.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'text-muted-foreground/40 cursor-not-allowed',
          )}
          title="发送 (Enter)"
        >
          <Send className="w-3.5 h-3.5" />
        </button>
        {voiceError && (
          <div className="absolute left-2 right-2 top-full mt-1 text-[10px] text-amber-500">
            {voiceError}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative mt-2 flex items-end gap-1.5 rounded-xl border border-border/40 bg-background/60 px-2 py-1.5',
        'transition-colors focus-within:border-primary/40 focus-within:bg-background',
        className,
      )}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        className={cn(
          'flex-1 resize-none bg-transparent text-sm leading-relaxed',
          'placeholder:text-muted-foreground/50',
          'outline-none border-none',
          'max-h-[120px]',
        )}
        style={{ minHeight: '24px' }}
      />
      {voiceButton}
      <button
        onClick={handleSend}
        disabled={!text.trim()}
        className={cn(
          'shrink-0 rounded-lg p-1.5 transition-all',
          text.trim()
            ? 'bg-primary text-primary-foreground hover:bg-primary/90'
            : 'text-muted-foreground/40 cursor-not-allowed',
        )}
        title="发送 (Enter)"
      >
        <Send className="w-3.5 h-3.5" />
      </button>
      {voiceError && (
        <div className="absolute left-2 right-2 top-full mt-1 text-[10px] text-amber-500">
          {voiceError}
        </div>
      )}
    </div>
  )
}

/** 生成中的内联指示器 — 替代 InlineInput 在 isGenerating 时显示 */
export function InlineGeneratingIndicator() {
  return (
    <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground/60 px-1">
      <Loader2 className="w-3 h-3 animate-spin" />
      <span>正在继续生成…</span>
    </div>
  )
}
