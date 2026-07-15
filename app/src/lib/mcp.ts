/**
 * MCP (Model Context Protocol) 客户端
 *
 * 架构说明：
 * - 标准 MCP over HTTP/SSE：向 MCP Server 端点发送 JSON-RPC 请求
 * - 支持两种传输：HTTP POST（tools/call）和 SSE 流式（streaming tools）
 * - 工具注册表：本地内置工具 + 远程 MCP Server 动态发现工具
 *
 * MCP Server 接入方式：
 *   用户填写端点 URL（如 http://localhost:3001/mcp），
 *   平台自动调用 tools/list 发现可用工具，调用 tools/call 执行工具。
 */

export interface MCPCallResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

// ── 内置工具实现（无需外部服务） ──────────────────────────────

/** 内置：网络搜索（使用 DuckDuckGo Instant Answer API，无需 API Key） */
async function builtinSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`
    const res = await fetch(url)
    const data = await res.json()
    const abstract = data.AbstractText || ''
    const topics = (data.RelatedTopics || [])
      .slice(0, 3)
      .map((t: any) => t.Text || '')
      .filter(Boolean)
      .join('\n')
    return [abstract, topics].filter(Boolean).join('\n\n') || `未找到"${query}"的即时答案，建议直接访问搜索引擎查询。`
  } catch {
    return '搜索服务暂时不可用，请稍后重试。'
  }
}

/** 内置：计算器（安全求值） */
function builtinCalculate(expression: string): string {
  try {
    // 只允许数学运算符和数字，防止注入
    const safe = expression.replace(/[^0-9+\-*/().,\s^%√]/g, '')
    if (!safe.trim()) return '无效表达式'
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${safe})`)()
    return String(result)
  } catch (e: any) {
    return `计算错误: ${e.message}`
  }
}

/** 内置：时间工具 */
function builtinDateTime(format: string = 'full'): string {
  const now = new Date()
  if (format === 'date') return now.toLocaleDateString('zh-CN')
  if (format === 'time') return now.toLocaleTimeString('zh-CN')
  return now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

// ── 内置工具注册表 ─────────────────────────────────────────────

interface BuiltinTool {
  name: string
  description: string
  parameters: Record<string, { type: string; description: string; required?: boolean }>
  execute: (params: Record<string, string>) => Promise<string> | string
}

const BUILTIN_TOOLS: Record<string, BuiltinTool> = {
  'web_search': {
    name: 'web_search',
    description: '搜索网络获取实时信息，使用 DuckDuckGo 即时答案 API',
    parameters: {
      query: { type: 'string', description: '搜索关键词', required: true },
    },
    execute: (p) => builtinSearch(p.query),
  },
  'calculator': {
    name: 'calculator',
    description: '进行数学计算',
    parameters: {
      expression: { type: 'string', description: '数学表达式，如 (1+2)*3', required: true },
    },
    execute: (p) => builtinCalculate(p.expression),
  },
  'get_datetime': {
    name: 'get_datetime',
    description: '获取当前日期和时间（上海时区）',
    parameters: {
      format: { type: 'string', description: 'full/date/time，默认 full' },
    },
    execute: (p) => builtinDateTime(p.format),
  },
}

// ── 远程 MCP Server 调用 ─────────────────────────────────────

/**
 * 探测远程 MCP Server 的工具列表
 * MCP 标准：POST /tools/list  →  { tools: [{ name, description, inputSchema }] }
 */
export async function mcpListTools(endpoint: string): Promise<{ name: string; description: string; inputSchema?: object }[]> {
  // 内置服务不需要远程探测
  if (endpoint.startsWith('builtin://')) {
    return Object.values(BUILTIN_TOOLS).map(t => ({
      name: t.name,
      description: t.description,
    }))
  }

  try {
    const res = await fetch(`${endpoint}/tools/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    return data.result?.tools || []
  } catch (e: any) {
    throw new Error(`MCP Server 连接失败 (${endpoint}): ${e.message}`)
  }
}

/**
 * 调用 MCP 工具
 * MCP 标准：POST /tools/call  →  { content: [{ type: 'text', text: '...' }] }
 */
export async function mcpCallTool(
  endpoint: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<MCPCallResult> {
  // 内置工具直接在浏览器中执行
  if (endpoint.startsWith('builtin://')) {
    const tool = BUILTIN_TOOLS[toolName]
    if (!tool) return { content: [{ type: 'text', text: `未知工具: ${toolName}` }], isError: true }
    const result = await tool.execute(params as Record<string, string>)
    return { content: [{ type: 'text', text: result }] }
  }

  // 远程 MCP Server
  try {
    const res = await fetch(`${endpoint}/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: params },
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      return { content: [{ type: 'text', text: `工具调用失败 (HTTP ${res.status}): ${errText}` }], isError: true }
    }
    const data = await res.json()
    if (data.error) {
      return { content: [{ type: 'text', text: `MCP 错误: ${data.error.message}` }], isError: true }
    }
    return data.result as MCPCallResult
  } catch (e: any) {
    return { content: [{ type: 'text', text: `网络错误: ${e.message}` }], isError: true }
  }
}

/**
 * 生成可注入 systemPrompt 的工具描述（OpenAI function calling 格式）
 * 用于告知 AI 可用哪些工具及其参数格式
 */
export function buildToolsSystemPrompt(
  services: Array<{ id: string; name: string; description: string; endpoint: string; enabled: boolean; tools: Array<{ name: string; description: string }> }>
): string {
  const enabledServices = services.filter(s => s.enabled)
  if (enabledServices.length === 0) return ''

  const toolList = enabledServices.flatMap(s =>
    s.tools.map(t => `- **${t.name}** (来自 ${s.name}): ${t.description}`)
  ).join('\n')

  return `
## 可用工具（MCP Tools）

你可以调用以下工具来获取实时信息或执行操作。当你需要使用工具时，请在回复中**明确说明你正在使用哪个工具**，格式如下：

\`\`\`tool_call
{"tool": "工具名称", "params": {"参数名": "参数值"}}
\`\`\`

可用工具列表：
${toolList}

重要说明：
- 工具调用结果将由系统自动执行并返回给你
- 如果工具不可用，请告知用户并给出替代建议
- 优先使用工具获取最新信息，而不是依赖训练数据
`
}

/**
 * 解析 AI 回复中的工具调用请求
 * 返回所有需要执行的工具调用
 */
export function parseToolCalls(content: string): Array<{ tool: string; params: Record<string, unknown> }> {
  const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
  // 匹配 ```tool_call ... ``` 代码块
  const regex = /```tool_call\s*([\s\S]*?)```/g
  let match
  while ((match = regex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (parsed.tool) {
        calls.push({ tool: parsed.tool, params: parsed.params || {} })
      }
    } catch {
      // 忽略解析失败的工具调用
    }
  }
  return calls
}

// ── 默认内置 MCP 服务配置 ─────────────────────────────────────

export const DEFAULT_BUILTIN_SERVICES = [
  {
    id: 'builtin-search',
    name: '网络搜索',
    description: '使用 DuckDuckGo 搜索实时信息（无需 API Key）',
    endpoint: 'builtin://search',
    enabled: false,
    tools: [{ name: 'web_search', description: '搜索网络获取实时信息', parameters: { query: { type: 'string' } } }],
  },
  {
    id: 'builtin-calculator',
    name: '计算器',
    description: '进行数学计算',
    endpoint: 'builtin://calculator',
    enabled: false,
    tools: [{ name: 'calculator', description: '数学计算', parameters: { expression: { type: 'string' } } }],
  },
  {
    id: 'builtin-datetime',
    name: '时间工具',
    description: '获取当前日期时间（上海时区）',
    endpoint: 'builtin://datetime',
    enabled: false,
    tools: [{ name: 'get_datetime', description: '获取当前时间', parameters: { format: { type: 'string' } } }],
  },
]
