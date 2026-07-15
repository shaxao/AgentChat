import { memo, useCallback, useState, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { UIBlockDefinition, ChoicesData, QuickRepliesData, UploadData, UploadSlot } from '@/lib/uiBlocks'
import { validateChoices, validateQuickReplies, validateUpload } from '@/lib/uiBlocks'
import { uploadFileToOss } from '@/lib/api'

// ============================================================
// 类型定义
// ============================================================

/** 上传完成的文件信息 */
export interface UploadedFileInfo {
  name: string
  type: string
  size: number
  ossUrl: string
}

/** UI 交互结果 — 可能带文件附件 */
export interface UIActionPayload {
  message: string
  /** 已上传到 OSS 的文件列表 */
  files?: UploadedFileInfo[]
}

// ============================================================
// UIBlockRenderer — 根据 UI 块类型分发到对应组件
// ============================================================

interface UIBlockRendererProps {
  blocks: UIBlockDefinition[]
  /** 用户交互后触发的回调 */
  onAction: (payload: string | UIActionPayload) => void
  /** 当前对话 ID（OSS 上传需要） */
  convId?: string
  /** 是否禁用交互（流式输出中） */
  disabled?: boolean
}

export const UIBlockRenderer = memo(function UIBlockRenderer({
  blocks,
  onAction,
  convId,
  disabled = false,
}: UIBlockRendererProps) {
  if (!blocks || blocks.length === 0) return null

  return (
    <div className="ui-block-container space-y-3 my-3">
      {blocks.map((block, i) => {
        switch (block.type) {
          case 'choices':
            if (validateChoices(block.data)) {
              return (
                <ChoicesBlock
                  key={`choices-${i}`}
                  data={block.data as ChoicesData}
                  onSelect={onAction}
                  disabled={disabled}
                />
              )
            }
            return null
          case 'quick-replies':
            if (validateQuickReplies(block.data)) {
              return (
                <QuickRepliesBlock
                  key={`replies-${i}`}
                  data={block.data as QuickRepliesData}
                  onSelect={onAction}
                  disabled={disabled}
                />
              )
            }
            return null
          case 'upload':
            if (validateUpload(block.data)) {
              return (
                <UploadBlock
                  key={`upload-${i}`}
                  data={block.data as UploadData}
                  onAction={onAction}
                  convId={convId}
                  disabled={disabled}
                />
              )
            }
            return null
          default:
            // Phase 2/3 的 form/chart/table 类型暂不处理
            return null
        }
      })}
    </div>
  )
})

// ============================================================
// ChoicesBlock — 快捷选项芯片组件
// ============================================================

interface ChoicesBlockProps {
  data: ChoicesData
  onSelect: (message: string) => void
  disabled?: boolean
}

const ChoicesBlock = memo(function ChoicesBlock({
  data,
  onSelect,
  disabled = false,
}: ChoicesBlockProps) {
  const [selectedValues, setSelectedValues] = useState<Set<string>>(new Set())
  const [submitted, setSubmitted] = useState(false)

  const handleToggle = useCallback(
    (value: string) => {
      if (submitted || disabled) return
      if (data.multiSelect) {
        setSelectedValues(prev => {
          const next = new Set(prev)
          if (next.has(value)) {
            next.delete(value)
          } else {
            next.add(value)
          }
          return next
        })
      } else {
        setSubmitted(true)
        onSelect(value)
      }
    },
    [data.multiSelect, onSelect, submitted, disabled],
  )

  const handleSubmitMulti = useCallback(() => {
    if (selectedValues.size === 0 || submitted || disabled) return
    setSubmitted(true)
    const values = Array.from(selectedValues).join(', ')
    onSelect(values)
  }, [selectedValues, submitted, disabled, onSelect])

  return (
    <div className="choices-block rounded-lg border border-border/60 bg-background/60 p-3">
      {data.question && (
        <p className="text-sm text-muted-foreground mb-2.5">{data.question}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {data.options.map((opt, i) => {
          const isSelected = selectedValues.has(opt.value)
          return (
            <button
              key={i}
              type="button"
              disabled={submitted || disabled}
              onClick={() => handleToggle(opt.value)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium',
                'border transition-all duration-150',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                isSelected
                  ? 'bg-primary/10 border-primary/30 text-primary'
                  : 'bg-background border-border hover:border-primary/40 hover:bg-accent/50',
              )}
            >
              {opt.label}
              {data.multiSelect && isSelected && (
                <span className="text-[10px] opacity-70">✓</span>
              )}
            </button>
          )
        })}
      </div>
      {data.multiSelect && selectedValues.size > 0 && !submitted && (
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={handleSubmitMulti}
          >
            确认选择 ({selectedValues.size})
          </Button>
        </div>
      )}
    </div>
  )
})

// ============================================================
// QuickRepliesBlock — 消息末尾快捷回复按钮
// ============================================================

interface QuickRepliesBlockProps {
  data: QuickRepliesData
  onSelect: (message: string) => void
  disabled?: boolean
}

const QuickRepliesBlock = memo(function QuickRepliesBlock({
  data,
  onSelect,
  disabled = false,
}: QuickRepliesBlockProps) {
  const [clicked, setClicked] = useState<string | null>(null)

  const handleClick = useCallback(
    (value: string) => {
      if (clicked || disabled) return
      setClicked(value)
      onSelect(value)
    },
    [clicked, disabled, onSelect],
  )

  return (
    <div className="quick-replies-block flex flex-wrap gap-2">
      {data.replies.map((reply, i) => (
        <Button
          key={i}
          size="sm"
          variant="outline"
          disabled={clicked !== null || disabled}
          onClick={() => handleClick(reply.value)}
          className="rounded-full text-xs h-7 px-3.5"
        >
          {reply.label}
        </Button>
      ))}
    </div>
  )
})

// ============================================================
// UploadBlock — 交互式文件上传组件
// ============================================================

interface UploadBlockProps {
  data: UploadData
  onAction: (payload: string | UIActionPayload) => void
  convId?: string
  disabled?: boolean
}

/** 单个槽位的上传状态 */
interface SlotState {
  /** 已选中的文件 */
  file?: File
  /** 上传状态 */
  status: 'idle' | 'uploading' | 'done' | 'error'
  /** OSS 上传结果 */
  ossUrl?: string
  /** 错误信息 */
  error?: string
}

const UPLOAD_ACCEPT_LABELS: Record<string, string> = {
  'image/*': '图片',
  '.xlsx,.xls': 'Excel',
  '.xls,.xlsx': 'Excel',
  '.pdf': 'PDF',
  '.pdf,.doc,.docx': '文档',
  '.csv': 'CSV',
  '.txt': '文本',
  '.zip': 'ZIP',
  'image/*,.pdf': '图片/PDF',
}

function acceptLabel(accept: string): string {
  return UPLOAD_ACCEPT_LABELS[accept] || accept
}

function acceptExtensions(accept: string): string {
  return accept.split(',').map(s => s.trim()).join(',')
}

const FileIcon = memo(function FileIcon({ type }: { type: string }) {
  if (type.startsWith('image/')) {
    return (
      <svg className="w-5 h-5 shrink-0 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.41a2.25 2.25 0 013.182 0l2.909 2.91m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
      </svg>
    )
  }
  return (
    <svg className="w-5 h-5 shrink-0 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  )
})

const UploadBlock = memo(function UploadBlock({
  data,
  onAction,
  convId,
  disabled = false,
}: UploadBlockProps) {
  const [slots, setSlots] = useState<SlotState[]>(
    data.slots.map(() => ({ status: 'idle' }))
  )
  const [submitted, setSubmitted] = useState(false)
  const inputRefs = useRef<Map<number, HTMLInputElement>>(new Map())

  const setSlot = useCallback((index: number, update: Partial<SlotState>) => {
    setSlots(prev => prev.map((s, i) => i === index ? { ...s, ...update } : s))
  }, [])

  // 处理文件选择
  const handleFileSelect = useCallback(async (slotIndex: number, file: File) => {
    if (disabled || submitted) return
    setSlot(slotIndex, { file, status: 'uploading' })

    try {
      const result = await uploadFileToOss(file, convId)
      setSlot(slotIndex, {
        file,
        status: 'done',
        ossUrl: result.url,
      })
    } catch (e) {
      setSlot(slotIndex, {
        file,
        status: 'error',
        error: (e as Error).message || '上传失败',
      })
    }
  }, [disabled, submitted, convId, setSlot])

  // 重置某个槽位
  const handleRemove = useCallback((slotIndex: number) => {
    if (disabled || submitted) return
    // 清除 input 的值，允许重新选择同文件
    const input = inputRefs.current.get(slotIndex)
    if (input) input.value = ''
    setSlot(slotIndex, { status: 'idle' })
  }, [disabled, submitted, setSlot])

  // 触发文件选择
  const handleClickSlot = useCallback((slotIndex: number) => {
    if (disabled || submitted) return
    inputRefs.current.get(slotIndex)?.click()
  }, [disabled, submitted])

  // 检查是否所有必填槽位已就绪
  const allRequiredFilled = data.slots.every((slotDef, i) => {
    if (slotDef.required === false) return true
    return slots[i]?.status === 'done'
  })

  const hasAnyFile = slots.some(s => s.status === 'done')

  // 提交
  const handleSubmit = useCallback(() => {
    if (submitted || disabled || !hasAnyFile) return
    setSubmitted(true)

    const uploadedFiles: UploadedFileInfo[] = slots
      .filter(s => s.status === 'done' && s.ossUrl && s.file)
      .map(s => ({
        name: s.file!.name,
        type: s.file!.type,
        size: s.file!.size,
        ossUrl: s.ossUrl!,
      }))

    const message = data.autoPrompt ||
      `已上传 ${uploadedFiles.map(f => f.name).join('、')}，请分析验证`

    onAction({ message, files: uploadedFiles })
  }, [submitted, disabled, hasAnyFile, slots, data.autoPrompt, onAction])

  return (
    <div className="upload-block rounded-lg border border-border/60 bg-background/60 p-4">
      {data.question && (
        <p className="text-sm text-muted-foreground mb-3">{data.question}</p>
      )}

      <div className="space-y-2.5">
        {data.slots.map((slotDef, i) => {
          const slot = slots[i]
          const isUploading = slot?.status === 'uploading'
          const isDone = slot?.status === 'done'
          const isError = slot?.status === 'error'

          return (
            <div key={i}>
              {/* 隐藏的 file input */}
              <input
                ref={el => { if (el) inputRefs.current.set(i, el) }}
                type="file"
                accept={acceptExtensions(slotDef.accept)}
                className="hidden"
                disabled={disabled || submitted || isDone}
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFileSelect(i, file)
                }}
              />

              {/* 上传区域 */}
              {isDone ? (
                // 上传完成状态
                <div className="flex items-center gap-2.5 rounded-lg border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 px-3 py-2.5">
                  <FileIcon type={slot.file?.type || ''} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate text-green-700 dark:text-green-400">
                      {slot.file?.name}
                    </p>
                    <p className="text-xs text-green-600/70 dark:text-green-500/70">
                      {slotDef.label} · 已上传
                    </p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors p-1"
                    disabled={submitted}
                    onClick={() => handleRemove(i)}
                    title="移除"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              ) : isError ? (
                // 上传失败状态
                <div className="flex items-center gap-2.5 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2.5">
                  <svg className="w-5 h-5 shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-red-700 dark:text-red-400">{slot.file?.name}</p>
                    <p className="text-xs text-red-600/70 dark:text-red-500/70">{slot.error || '上传失败'}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-xs h-7"
                    disabled={submitted}
                    onClick={() => {
                      // 重试
                      if (slot.file) handleFileSelect(i, slot.file)
                    }}
                  >
                    重试
                  </Button>
                </div>
              ) : (
                // 待上传状态（带进度指示器）
                <button
                  type="button"
                  disabled={disabled || submitted || isUploading}
                  onClick={() => handleClickSlot(i)}
                  className={cn(
                    'w-full flex items-center gap-2.5 rounded-lg border-2 border-dashed px-3 py-2.5',
                    'transition-all duration-150 text-left',
                    isUploading
                      ? 'border-primary/40 bg-primary/5 cursor-wait'
                      : 'border-border hover:border-primary/30 hover:bg-accent/30 cursor-pointer',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                >
                  {isUploading ? (
                    <>
                      <svg className="w-5 h-5 shrink-0 text-primary animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-muted-foreground">正在上传 {slot.file?.name}...</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <svg className="w-5 h-5 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">
                          {slotDef.label}
                          {slotDef.required !== false && (
                            <span className="text-red-400 ml-0.5">*</span>
                          )}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          点击上传 {acceptLabel(slotDef.accept)}{slotDef.hint ? ` · ${slotDef.hint}` : ''}
                        </p>
                      </div>
                    </>
                  )}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* 提交按钮 */}
      {hasAnyFile && !submitted && (
        <div className="mt-3 flex justify-end">
          <Button
            size="sm"
            disabled={disabled}
            onClick={handleSubmit}
            className="gap-1.5"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
            {allRequiredFilled ? '提交并智能验证' : '提交分析'}
          </Button>
        </div>
      )}

      {/* 上传中状态 */}
      {slots.some(s => s.status === 'uploading') && !submitted && (
        <p className="text-xs text-muted-foreground mt-2 text-center">
          请等待文件上传完成后再提交...
        </p>
      )}
    </div>
  )
})
