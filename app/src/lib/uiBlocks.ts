/**
 * 动态 UI 块解析器
 *
 * 从 AI 回复中解析 ```ui:xxx ... ``` 代码块，分离为：
 *  - UI 块定义（JSON 数据）
 *  - 剩余纯文本内容（Markdown）
 *
 * 支持的 UI 块类型：
 *  - ui:choices     快捷选项芯片（单选/多选）
 *  - ui:quick-replies 消息末尾快捷回复按钮
 *  - ui:form        表单（Phase 2）
 *  - ui:chart       图表（Phase 3）
 *  - ui:table       数据表格（Phase 3）
 */

export interface UIBlockDefinition {
  /** UI 块类型 */
  type: 'choices' | 'quick-replies' | 'upload' | 'form' | 'chart' | 'table'
  /** 原始 JSON 数据 */
  data: Record<string, unknown>
  /** 块在原始内容中的位置信息 */
  index: number
}

export interface ChoicesData {
  question?: string
  options: Array<{ label: string; value: string }>
  multiSelect?: boolean
}

export interface QuickRepliesData {
  replies: Array<{ label: string; value: string }>
}

/** 单个文件上传槽位定义 */
export interface UploadSlot {
  /** 槽位标签，如"送货单图片" */
  label: string
  /** 接受的文件类型，如 "image/*" | ".xlsx,.xls,.pdf" */
  accept: string
  /** 是否必填（默认 true） */
  required?: boolean
  /** 提示文字 */
  hint?: string
}

/** ui:upload 块数据 */
export interface UploadData {
  /** 显示在上传区域上方的提示问题 */
  question?: string
  /** 需要上传的文件槽位列表 */
  slots: UploadSlot[]
  /** 上传完成后自动发送给 AI 的提示文本 */
  autoPrompt?: string
}

export interface ParsedContent {
  /** 移除 UI 块后的纯 Markdown 文本 */
  markdown: string
  /** 解析出的 UI 块列表（按出现顺序） */
  uiBlocks: UIBlockDefinition[]
}

/**
 * 匹配 ```ui:xxx\n{...}\n``` 代码块
 * 支持的语言标识：ui:choices, ui:quick-replies, ui:upload, ui:form, ui:chart, ui:table
 */
const UI_BLOCK_RE = /```ui:(choices|quick-replies|upload|form|chart|table)\s*\n([\s\S]*?)```/g

const VALID_TYPES = new Set(['choices', 'quick-replies', 'upload', 'form', 'chart', 'table'])

function isValidType(t: string): t is UIBlockDefinition['type'] {
  return VALID_TYPES.has(t)
}

/**
 * 从消息内容中提取 UI 块
 */
export function parseUIBlocks(content: string): ParsedContent {
  const uiBlocks: UIBlockDefinition[] = []
  let index = 0

  const markdown = content.replace(UI_BLOCK_RE, (_match, type: string, jsonStr: string) => {
    if (!isValidType(type)) return _match

    try {
      const trimmed = jsonStr.trim()
      const data = JSON.parse(trimmed)
      uiBlocks.push({ type, data, index: index++ })
      // 替换为空字符串，从 Markdown 中移除
      return ''
    } catch {
      // JSON 解析失败，保留原始内容
      return _match
    }
  })

  // 清理多余空行（UI 块被移除后可能留下连续空行）
  const cleaned = markdown.replace(/\n{3,}/g, '\n\n').trim()

  return { markdown: cleaned, uiBlocks }
}

/**
 * 验证 choices 数据格式
 */
export function validateChoices(data: unknown): data is ChoicesData {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.options) || d.options.length === 0) return false
  return d.options.every(
    (o: unknown) =>
      typeof o === 'object' && o !== null &&
      typeof (o as Record<string, unknown>).label === 'string' &&
      typeof (o as Record<string, unknown>).value === 'string'
  )
}

/**
 * 验证 quick-replies 数据格式
 */
export function validateQuickReplies(data: unknown): data is QuickRepliesData {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.replies) || d.replies.length === 0) return false
  return d.replies.every(
    (o: unknown) =>
      typeof o === 'object' && o !== null &&
      typeof (o as Record<string, unknown>).label === 'string' &&
      typeof (o as Record<string, unknown>).value === 'string'
  )
}

/**
 * 验证 upload 数据格式
 */
export function validateUpload(data: unknown): data is UploadData {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  if (!Array.isArray(d.slots) || d.slots.length === 0) return false
  return d.slots.every(
    (s: unknown) =>
      typeof s === 'object' && s !== null &&
      typeof (s as Record<string, unknown>).label === 'string' &&
      typeof (s as Record<string, unknown>).accept === 'string'
  )
}
