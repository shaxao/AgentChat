/**
 * 工作流 DSL ↔ React Flow 双向类型定义
 */

// ==================== DSL 类型 ====================

export interface TriggerDef {
  type: 'cron' | 'manual'
  value?: string // cron 表达式
}

export interface StepDef {
  id: string
  tool: string
  description: string
  args?: Record<string, unknown>
  condition?: string // 如 "step1.success" | "step1.failed"
  /** 工具的可执行代码（Python/JS），由用户编写或 AI 生成 */
  idempotent?: boolean
  sideEffect?: 'none' | 'read' | 'write' | 'external_call' | 'notification' | 'payment'
  code?: string
  /** 代码语言：python | javascript */
  language?: string
  /** 自定义工具执行超时秒数 */
  timeoutSeconds?: number
  /** 自定义工具权限：network / filesystem_read / filesystem_write / process */
  permissions?: string[]
  /** 输入参数 schema（JSON Schema 子集） */
  inputSchema?: Record<string, unknown>
  /** 输出结果 schema（JSON Schema 子集） */
  outputSchema?: Record<string, unknown>
}

export interface WorkflowDsl {
  trigger: TriggerDef
  steps: StepDef[]
  /** 节点在画布上的位置映射：nodeId -> {x, y} */
  layout?: Record<string, { x: number; y: number }>
  /** 数据传递模式: "auto"(默认,自动注入) | "template"(纯模板变量) | "ai"(AI编排) */
  dataMode?: 'auto' | 'template' | 'ai'
  aiPolicy?: {
    maxTurns?: number
    allowRepeatSteps?: boolean
    continueOnStepFailure?: boolean
  }
}

// ==================== React Flow 节点类型 ====================

export type WorkflowNodeType = 'trigger' | 'step'

export interface TriggerNodeData {
  label: string
  triggerType: 'cron' | 'manual'
  cronExpr?: string
  /** 数据传递模式: "auto"(默认) | "template" | "ai" */
  dataMode?: 'auto' | 'template' | 'ai'
  aiPolicy?: WorkflowDsl['aiPolicy']
  [key: string]: unknown
}

export interface StepNodeData {
  label: string
  stepId: string
  tool: string
  description: string
  args: Record<string, unknown>
  condition?: string
  /** 工具的可执行代码（内联） */
  idempotent?: boolean
  sideEffect?: StepDef['sideEffect']
  code?: string
  /** 代码语言：python | javascript */
  language?: string
  /** 自定义工具执行超时秒数 */
  timeoutSeconds?: number
  /** 自定义工具权限：network / filesystem_read / filesystem_write / process */
  permissions?: string[]
  /** 输入参数 schema（JSON Schema 子集） */
  inputSchema?: Record<string, unknown>
  /** 输出结果 schema（JSON Schema 子集） */
  outputSchema?: Record<string, unknown>
  [key: string]: unknown
}

export type WorkflowNodeData = TriggerNodeData | StepNodeData

// ==================== 可用工具列表 ====================

export interface AvailableTool {
  name: string
  label: string
  description: string
  /** 工具分类 */
  category: 'builtin' | 'agent' | 'custom'
  /** 示例参数（JSON） */
  exampleArgs?: string
}

/** 内置工具 + 可从后端动态加载 */
export const BUILTIN_TOOLS: AvailableTool[] = [
  {
    name: 'ai_chat',
    label: 'AI 对话',
    description: '调用 AI 模型进行文本对话',
    category: 'builtin',
    exampleArgs: '{"prompt": "总结今天的新闻要点"}',
  },
  {
    name: 'web_search',
    label: '网页搜索',
    description: '搜索互联网获取实时信息',
    category: 'builtin',
    exampleArgs: '{"query": "最新 AI 新闻"}',
  },
  {
    name: 'file_upload',
    label: '文件资产',
    description: '引用已上传的工作流文件，输出统一 Artifact 信息',
    category: 'builtin',
    exampleArgs: '{"artifactUuid": "上传后生成的 artifact uuid"}',
  },
  {
    name: 'image_recognition',
    label: '图片识别',
    description: '识别图片内容、提取文字，并输出可串联的文本结果',
    category: 'builtin',
    exampleArgs: '{"artifactUuid": "图片 artifact uuid", "prompt": "提取图片中的关键信息"}',
  },
  {
    name: 'audio_transcribe',
    label: '音频转写',
    description: '复用 ASR 渠道将音频文件转写为文本',
    category: 'builtin',
    exampleArgs: '{"artifactUuid": "音频 artifact uuid"}',
  },
  {
    name: 'document_chunk_process',
    label: '大文档分段处理',
    description: '按分片读取文本类大文件，逐段分析后合并结果',
    category: 'builtin',
    exampleArgs: '{"artifactUuid": "文档 artifact uuid", "task": "总结文档并提取风险和待办", "chunkBytes": 65536, "maxChunks": 20}',
  },
]
