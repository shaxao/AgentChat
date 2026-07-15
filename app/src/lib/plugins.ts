/**
 * 插件系统（Plugin System）
 *
 * 架构设计：
 * - 每个插件都是一个实现了 PluginHandler 接口的模块
 * - 插件可以：
 *   1. 在发送消息前 hook（preprocessMessage）：修改/增强用户输入
 *   2. 在收到 AI 回复后 hook（postprocessResponse）：解析特殊格式，执行操作
 *   3. 提供自定义 UI 组件（renderWidget）
 *   4. 注册工具命令（commands）
 *
 * 插件市场：
 * - 内置插件直接打包到前端
 * - 第三方插件通过 URL 动态加载（ESM import）
 * - 开发者按 PluginManifest 规范开发后提交到市场
 */

export interface PluginManifest {
  id: string
  name: string
  version: string
  description: string
  author: string
  icon: string
  category: string
  homepage?: string
  /** 插件入口（第三方插件为远程 URL） */
  entry?: string
  /** 插件所需权限 */
  permissions?: ('network' | 'clipboard' | 'storage' | 'file')[]
}

export interface PluginContext {
  /** 当前用户输入 */
  userMessage: string
  /** 当前对话 ID */
  conversationId: string
  /** 向对话追加消息（用于插件注入信息） */
  appendMessage?: (content: string) => void
}

export interface PluginHookResult {
  /** 修改后的消息内容（不修改则返回原文） */
  message?: string
  /** 插件追加的附加信息（会加入 systemPrompt） */
  extra?: string
  /** 是否阻止发送（用于拦截无效输入等） */
  preventDefault?: boolean
}

export interface PluginHandler {
  manifest: PluginManifest
  /** 消息发送前的钩子 */
  preprocessMessage?: (ctx: PluginContext) => Promise<PluginHookResult>
  /** AI 回复后的钩子（用于解析特殊格式、触发操作等） */
  postprocessResponse?: (response: string, ctx: PluginContext) => Promise<void>
}

// ── 内置插件实现 ─────────────────────────────────────────────

/** 插件：网络搜索增强（自动检测问句，提示用户开启搜索） */
const webSearchPlugin: PluginHandler = {
  manifest: {
    id: 'web-search',
    name: '网络搜索',
    version: '1.2.0',
    description: '自动识别需要实时信息的问题，提示使用搜索工具',
    author: 'MuhugoChat',
    icon: '🔍',
    category: '工具',
  },
  preprocessMessage: async (ctx) => {
    // 检测是否包含实时信息需求的关键词
    const realtimeKeywords = ['今天', '最新', '现在', '当前', '最近', '今年', '价格', '行情', '新闻', '天气']
    const hasRealtimeNeed = realtimeKeywords.some(kw => ctx.userMessage.includes(kw))
    if (hasRealtimeNeed) {
      return {
        extra: '注意：用户问题可能需要实时信息。如果你的训练数据不包含最新信息，请明确告知用户并建议他们启用 MCP 网络搜索工具。',
      }
    }
    return {}
  },
}

/** 插件：代码增强（为代码问题自动优化提示词） */
const codeAssistantPlugin: PluginHandler = {
  manifest: {
    id: 'python-runner',
    name: 'Python Runner',
    version: '1.0.5',
    description: '自动识别 Python 代码请求，优化代码生成提示词，支持 Pyodide 在线执行',
    author: 'DevTools',
    icon: '🐍',
    category: '开发',
  },
  preprocessMessage: async (ctx) => {
    const isPythonRequest = /python|py脚本|python代码/.test(ctx.userMessage.toLowerCase())
    if (isPythonRequest) {
      return {
        extra: '代码生成要求：1) 使用 Python 3.x 语法；2) 避免依赖 numpy/pandas 以外的第三方包（Pyodide 支持有限）；3) 如需打印结果，使用 print() 函数；4) 代码块格式必须使用 ```python 标记。',
      }
    }
    return {}
  },
}

/** 插件：DALL·E 图像生成（识别图像生成请求，标注为特殊命令） */
const dallePlugin: PluginHandler = {
  manifest: {
    id: 'dalle',
    name: 'DALL·E 图像生成',
    version: '1.0.0',
    description: '识别图像生成请求，调用 DALL·E API 生成图像',
    author: 'OpenAI',
    icon: '🎨',
    category: '图像',
  },
  preprocessMessage: async (ctx) => {
    const isImageRequest = /生成.*图|画.*图|图片生成|image.*generate|create.*image/i.test(ctx.userMessage)
    if (isImageRequest) {
      return {
        extra: '用户请求生成图像。请用以下格式返回图像生成请求（后端将处理实际生成）：\n```image_gen\n{"prompt": "详细的英文图像描述", "size": "1024x1024"}\n```\n同时用中文解释你生成了什么。',
      }
    }
    return {}
  },
}

// ── 插件注册表 ────────────────────────────────────────────────

const PLUGIN_REGISTRY: Record<string, PluginHandler> = {
  'web-search': webSearchPlugin,
  'python-runner': codeAssistantPlugin,
  'dalle': dallePlugin,
}

/** 获取已安装插件的处理器列表 */
export function getActivePluginHandlers(installedPluginIds: string[]): PluginHandler[] {
  return installedPluginIds
    .map(id => PLUGIN_REGISTRY[id])
    .filter((handler): handler is PluginHandler => Boolean(handler))
}

/**
 * 运行所有已安装插件的 preprocessMessage 钩子
 * 返回合并后的额外系统提示词
 */
export async function runPluginPreprocess(
  message: string,
  installedPluginIds: string[],
  conversationId: string
): Promise<{ processedMessage: string; extras: string[] }> {
  const handlers = getActivePluginHandlers(installedPluginIds)
  let processedMessage = message
  const extras: string[] = []

  for (const handler of handlers) {
    if (!handler.preprocessMessage) continue
    try {
      const result = await handler.preprocessMessage({
        userMessage: processedMessage,
        conversationId,
      })
      if (result.message) processedMessage = result.message
      if (result.extra) extras.push(`[插件 ${handler.manifest.name}]\n${result.extra}`)
    } catch (e) {
      console.warn(`插件 ${handler.manifest.id} preprocessMessage 失败:`, e)
    }
  }

  return { processedMessage, extras }
}

/** 获取插件市场展示数据（供 AdminStore 初始化） */
export function getPluginMarketplace() {
  return Object.values(PLUGIN_REGISTRY).map(h => ({
    id: h.manifest.id,
    name: h.manifest.name,
    description: h.manifest.description,
    icon: h.manifest.icon,
    category: h.manifest.category,
    version: h.manifest.version,
    author: h.manifest.author,
    rating: 4.8,
    downloads: 10000,
    installed: ['dalle', 'web-search', 'python-runner'].includes(h.manifest.id), // 默认安装
  }))
}
