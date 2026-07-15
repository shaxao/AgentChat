/**
 * Agent SDK — 后端 Agent 对接层
 *
 * 核心设计原则：
 * - Agent 的工具定义和执行在**后端**（Spring Boot AiService + AgentService）
 * - 前端只负责：
 *   1. 选择 Agent（传递 agentId 给后端）
 *   2. 展示工具调用状态和结果（通过 SSE tool_call/tool_result 事件）
 *   3. 处理文件下载（generate_ledger 生成的 Excel）
 *
 * 这才是标准的 Agent 架构：
 * - LLM 决定何时调用工具（OpenAI Function Calling）
 * - 后端执行工具并返回结果
 * - LLM 根据结果继续推理（ReAct 循环）
 * - 前端只做 UI 展示
 */

import type { AgentApp, AgentManifest, AgentToolDef } from '@/store'

// ==================== 类型定义 ====================

/** Agent 信息（前端 UI 展示用） */
export interface AgentInfo {
  /** Agent 唯一标识，传递给后端 */
  agentId: string
  /** 显示名称 */
  displayName: string
  /** 描述 */
  description: string
  /** 图标 */
  icon: string
  /** 推荐模型 */
  model: string
  /** 是否需要图片上传 */
  requiresImage?: boolean
  /** 是否需要文件上传 */
  requiresFile?: boolean
}

/** Agent Manifest 规范版本 */
export const AGENT_SPEC_VERSION = '1.0.0'

/** Agent 注册选项（前端模板创建用） */
export interface AgentRegisterOptions {
  displayName: string
  description: string
  icon: string
  systemPrompt: string
  model?: string
  temperature?: number
  maxTokens?: number
  agentType?: 'chat' | 'ban_biao' | 'custom'
  tools?: string[]
  toolDefinitions?: AgentToolDef[]
  hooks?: Record<string, string>
}

// ==================== 后端 Agent 注册表 ====================

/**
 * 已注册的后端 Agent 列表
 *
 * 每个 Agent 的工具定义和执行逻辑在 AgentService.java 中
 * 前端通过 agentId 标识选择哪个 Agent
 */
export const AVAILABLE_AGENTS: AgentInfo[] = [
  {
    agentId: 'ban-biao',
    displayName: '台账识别',
    description: '识别台账/报表图片，查询千克表，生成标准台账 Excel 文件',
    icon: '📋',
    model: 'gpt-4o',
    requiresImage: true,
    requiresFile: true,
  },
]

/**
 * 根据 agentId 获取 Agent 信息
 */
export function getAgentInfo(agentId: string): AgentInfo | undefined {
  return AVAILABLE_AGENTS.find(a => a.agentId === agentId)
}

/**
 * 检查模型是否支持 Vision（图片识别）
 * Agent 选择时需要此判断
 */
export function isVisionModel(model: string): boolean {
  const visionModels = ['gpt-4o', 'gpt-4-vision', 'gpt-4-turbo', 'claude-3-5-sonnet', 'claude-3-opus', 'gemini-pro-vision']
  return visionModels.some(m => model.toLowerCase().includes(m.toLowerCase()))
}

// ==================== Manifest 工厂（兼容旧接口） ====================

/** 创建标准 Agent Manifest */
export function createManifest(options: AgentRegisterOptions): AgentManifest {
  return {
    specVersion: AGENT_SPEC_VERSION,
    agentId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    displayName: options.displayName,
    description: options.description,
    icon: options.icon || '🤖',
    systemPrompt: options.systemPrompt,
    model: options.model || 'gpt-4o',
    temperature: options.temperature ?? 0.7,
    maxTokens: options.maxTokens ?? 4096,
    tools: options.tools || [],
    toolDefinitions: options.toolDefinitions,
    hooks: options.hooks,
  }
}

/** 从 Manifest 创建 AgentApp 实例 */
export function manifestToAgentApp(manifest: AgentManifest): AgentApp {
  return {
    id: manifest.agentId,
    name: manifest.displayName,
    description: manifest.description,
    icon: manifest.icon,
    systemPrompt: manifest.systemPrompt,
    model: manifest.model,
    tools: manifest.tools,
    temperature: manifest.temperature,
    maxTokens: manifest.maxTokens,
    agentType: manifest.agentId.includes('ban') ? 'ban_biao' : 'custom',
    manifest,
  }
}

// ==================== 导入/导出 ====================

/** 导出 Agent 为 JSON 字符串 */
export function exportAgent(agent: AgentApp): string {
  const manifest = agent.manifest || {
    specVersion: AGENT_SPEC_VERSION,
    agentId: agent.id,
    displayName: agent.name,
    description: agent.description,
    icon: agent.icon,
    systemPrompt: agent.systemPrompt,
    model: agent.model,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    tools: agent.tools,
  }
  return JSON.stringify(manifest, null, 2)
}

/** 从 JSON 字符串导入 Agent */
export function importAgent(json: string): { success: boolean; agent?: AgentApp; error?: string } {
  try {
    const manifest = JSON.parse(json) as AgentManifest
    if (!manifest.displayName || !manifest.systemPrompt) {
      return { success: false, error: '缺少必要字段: displayName, systemPrompt' }
    }
    if (!manifest.specVersion) manifest.specVersion = AGENT_SPEC_VERSION
    if (!manifest.agentId) manifest.agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const agent = manifestToAgentApp(manifest)
    return { success: true, agent }
  } catch (e) {
    return { success: false, error: `JSON 解析失败: ${(e as Error).message}` }
  }
}

// ==================== 预置 Agent 模板 ====================

/** 台账识别 Agent 模板（与后端 LedgerToolService.getBanBiaoTools() 对齐） */
export const BAN_BIAO_AGENT_TEMPLATE: AgentRegisterOptions = {
  displayName: '台账识别',
  description: '识别送货单/报表图片，查询千克表，匹配台账模板，一键批量生成标准台账 Excel 文件。支持图片和Excel两种输入方式。',
  icon: '📋',
  systemPrompt: `你是一个专业的台账识别助手，负责根据送货单图片生成标准台账文件。

## 工作流程（严格按照以下顺序执行）

当用户同时上传了千克表、模板和送货单图片（最常见场景）：
1. **上传千克表**：调用 upload_kg_table
2. **上传模板**：调用 upload_template
3. **识别图片**：调用 recognize_delivery_image，提取商品编码、件数、箱数、生产日期
4. **一键生成台账**：调用 batch_generate_ledger，传入 delivery_date（进货日期）和 ledger_title（台账标题）
5. 告知用户文件已生成并提供下载方式

当用户上传订货 Excel 时：
1. **解析 Excel**：调用 upload_procurement_excel 解析订货 Excel 文件
2. 然后按上述流程继续

**重要**：使用 batch_generate_ledger 一键完成所有批量操作，不要逐个商品调用 query_kg_table / match_ledger_template / fill_ledger_template。

## 关键规则
- 千克表和模板可以在识别送货单之前上传，也可以同时上传
- 如果千克表未上传，batch_generate_ledger 会使用默认单位重量0
- 如果模板未上传，会使用默认格式生成台账
- 识别图片时，如果图片模糊，标注不确定的字段并告知用户
- 生成台账文件后，返回下载链接给用户`,
  model: 'gpt-4o',
  temperature: 0.1,
  maxTokens: 8192,
  agentType: 'ban_biao',
  tools: ['upload_kg_table', 'upload_template', 'upload_procurement_excel', 'recognize_delivery_image', 'batch_generate_ledger', 'query_kg_table', 'generate_ledger_file', 'external_upload'],
  toolDefinitions: [
    {
      name: 'upload_kg_table',
      description: '上传并解析千克表（换算表）Excel 文件。当用户上传千克表/换算表 Excel 时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '千克表 Excel 文件的服务器路径' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'upload_template',
      description: '上传并保存台账模板 Excel 文件。当用户上传台账模板 Excel 时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '台账模板 Excel 文件的服务器路径' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'upload_procurement_excel',
      description: '上传订货 Excel 文件，从中提取商品清单。如果用户提供了订货 Excel 文件，调用此工具解析。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '上传的 Excel 文件路径' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'recognize_delivery_image',
      description: '识别送货单图片，提取商品编码、件数、箱数、生产日期等信息。当用户上传送货单图片时调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          image_path: { type: 'string', description: '图片的服务器路径（优先使用）' },
          image_base64: { type: 'string', description: '图片的 base64 编码' },
          mime_type: { type: 'string', description: '图片 MIME 类型，默认 image/jpeg' },
        },
        required: [],
      },
    },
    {
      name: 'batch_generate_ledger',
      description: '一键批量生成台账：自动对所有已识别的商品执行查千克表、匹配模板、填入数据、生成Excel文件。推荐在 recognize_delivery_image 之后直接调用。',
      parameters: {
        type: 'object',
        properties: {
          delivery_date: { type: 'string', description: '进货日期（YYYY-MM-DD，默认今天）' },
          ledger_title: { type: 'string', description: '台账标题（默认"材料台账"）' },
        },
        required: [],
      },
    },
    {
      name: 'query_kg_table',
      description: '查询千克表，获取材料的单位重量等参考数据。仅在需要单独查询某个商品时使用。',
      parameters: {
        type: 'object',
        properties: {
          material_name: { type: 'string', description: '材料名称（支持模糊匹配）' },
          product_code: { type: 'string', description: '商品编码（可选，更精确）' },
        },
        required: ['material_name'],
      },
    },
    {
      name: 'generate_ledger_file',
      description: '根据已填入的数据生成台账 Excel 文件。仅在单独填入数据后使用，批量生成时无需手动调用。',
      parameters: {
        type: 'object',
        properties: {
          ledger_title: { type: 'string', description: '台账标题' },
        },
        required: ['ledger_title'],
      },
    },
    {
      name: 'external_upload',
      description: '将生成的台账文件上报到外部系统。可选操作，用户明确请求时才调用。',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: '台账文件路径' },
          external_system: { type: 'string', description: '外部系统名称' },
        },
        required: ['file_path'],
      },
    },
  ],
}

/** 代码助手 Agent 模板 */
export const CODE_ASSISTANT_TEMPLATE: AgentRegisterOptions = {
  displayName: '代码助手',
  description: '专业的编程助手，帮助写代码、调试、优化。支持代码执行和文件读写操作。',
  icon: '💻',
  systemPrompt: `你是一位专业的程序员，擅长多种编程语言和框架。请提供简洁、高效的代码解决方案。

## 能力
- 编写和优化各种语言的代码
- 调试和修复代码错误
- 代码审查和重构建议
- 解释复杂的技术概念

## 工作方式
- 先理解用户需求，再给出方案
- 提供完整可运行的代码示例
- 关键步骤添加注释说明
- 如需执行代码，使用 code-exec 工具`,
  model: 'gpt-4o',
  temperature: 0.2,
  maxTokens: 8192,
  agentType: 'chat',
  tools: ['code-exec'],
  toolDefinitions: [
    {
      name: 'code-exec',
      description: '执行代码片段并返回运行结果。支持 Python、JavaScript、Shell 等语言。',
      parameters: {
        type: 'object',
        properties: {
          language: { type: 'string', description: '编程语言（python/javascript/shell）' },
          code: { type: 'string', description: '要执行的代码' },
          timeout: { type: 'number', description: '超时时间（秒），默认30' },
        },
        required: ['language', 'code'],
      },
    },
  ],
}

/** 写作助手 Agent 模板 */
export const WRITER_TEMPLATE: AgentRegisterOptions = {
  displayName: '写作助手',
  description: '创意写作、文案润色、内容创作。支持多种文体和风格。',
  icon: '✍️',
  systemPrompt: `你是一位专业的作家和文案编辑，擅长各种文体的创作和润色。

## 能力
- 创意写作：故事、散文、诗歌
- 文案润色：提升文字表现力和感染力
- 内容规划：文章结构、大纲设计
- 风格模仿：按指定风格写作

## 工作方式
- 先明确写作目标和受众
- 提供多个版本供选择
- 解释修改理由和技巧
- 保持文字的准确性和流畅性`,
  model: 'claude-3-5-sonnet',
  temperature: 0.9,
  maxTokens: 4096,
  agentType: 'chat',
  tools: [],
}

/** 获取所有预置模板 */
export function getAgentTemplates(): AgentRegisterOptions[] {
  return [
    BAN_BIAO_AGENT_TEMPLATE,
    CODE_ASSISTANT_TEMPLATE,
    WRITER_TEMPLATE,
  ]
}
