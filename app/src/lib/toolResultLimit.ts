/**
 * 🔧 OOM 防御 — 分层截断工具结果
 *
 * 参考各大 Agent 平台最佳实践（Claude PTC、LangChain Deep Agents、
 * Cursor Code Compression），不再一刀切截断，而是根据工具类型分层：
 *
 * | 工具类型          | 上限    | 说明                               |
 * |------------------|---------|------------------------------------|
 * | 代码/文件读取     | 50,000  | read_file, grep, cat 等            |
 * | 数据/搜索/查询    | 20,000  | search, query, select, find 等     |
 * | 其他（默认）      |  5,000  | 聊天、计算等纯文本工具              |
 *
 * 核心原则：LLM 上下文只存"索引+预览"，完整数据应走文件系统（Layer 2）。
 */

/**
 * 代码/文件类工具 — 匹配关键词（按优先级检查）
 * 匹配 read, file, cat, tail, head, grep, glob, code, open, view, ls, dir,
 * edit, write, diff, create, save, build, generate, skill, script, publish,
 * deploy, export, import, compile, transform, convert
 *
 * 🔴 注意：quick_create_skill/save_script/generate_code 等 Agent Builder 工具
 * 的结果可能包含完整代码（10万+字符），必须用 50KB 上限而不是默认的 5KB。
 */
const CODE_FILE_PATTERN = /(?:^|[_\s-])(read|file|cat|tail|head|grep|glob|code|open|view|ls|dir|edit|write|diff|create|save|build|generat|skill|script|publish|deploy|export|import|compile|transform|convert)(?:[_\s-]|$)/i

/**
 * 数据/搜索/查询类工具 — 匹配关键词（在非代码工具中检查）
 * 匹配 search, query, select, find, scan, list, sql, data, fetch, aggregate, lookup, browse
 */
const DATA_SEARCH_PATTERN = /(?:search|query|select|find|scan|list|sql|data|fetch|aggregate|lookup|browse)/i

export function getToolResultLimit(toolName: string | null | undefined): number {
  const name = (toolName || '').toLowerCase()

  // Layer 1: 代码/文件类 → 50KB（约 1000 行代码，覆盖大部分脚本）
  if (CODE_FILE_PATTERN.test(name)) return 50000

  // Layer 2: 数据/搜索/查询 → 20KB（覆盖典型数据库查询结果）
  if (DATA_SEARCH_PATTERN.test(name)) return 20000

  // Layer 3: 默认 → 5KB（聊天/计算等纯文本工具）
  return 5000
}

/**
 * 对工具结果执行分层截断
 * @returns 截断后的结果字符串
 */
export function truncateToolResult(
  toolName: string | null | undefined,
  rawResult: string | null | undefined
): string {
  if (!rawResult) return ''
  const limit = getToolResultLimit(toolName)
  if (rawResult.length <= limit) return rawResult
  return rawResult.slice(0, limit)
    + `\n\n[... 结果已截断，原 ${rawResult.length} 字符，上限 ${limit} 字符 ...]`
}

/**
 * 截断工具调用的参数（防止 1M+ 的 code_content 撑爆浏览器内存）。
 * 工具参数上限固定 2000 字符。
 */
const MAX_TOOL_ARG_CHARS = 2000

export function truncateToolArgs(args: string | null | undefined): string {
  if (!args) return ''
  if (args.length <= MAX_TOOL_ARG_CHARS) return args
  return args.slice(0, MAX_TOOL_ARG_CHARS)
    + `\n\n[... 参数已截断，原 ${args.length} 字符，上限 ${MAX_TOOL_ARG_CHARS} 字符 ...]`
}
