/**
 * 模型能力标签配置中心
 *
 * 🔧 集中管理所有能力标签，方便后期修改标签名称、图标、描述
 * 如需新增能力：只需在此文件添加新条目即可，无需修改其他文件
 *
 * 使用方式：
 *   import { CAPABILITIES, CAPABILITY_IDS, hasCapability, filterByCapability } from '@/config/capabilities'
 */

// ─── 能力标签定义 ────────────────────────────────────────────

export interface CapabilityDef {
  /** 唯一标识（用于代码逻辑），不建议修改 */
  id: string
  /** 显示名称（可自定义修改） */
  label: string
  /** 中文描述 */
  description: string
  /** 是否影响 Agent/技能使用（标记为 true 的能力在 Agent 模式下为必需） */
  requiredForAgent: boolean
  /** 是否影响文件上传 */
  requiredForUpload: boolean
}

/**
 * 所有能力标签定义
 *
 * 修改指南：
 *  - 新增能力：在数组末尾添加一条即可
 *  - 修改标签名称：改 `label` 字段
 *  - 调整 Agent 必需条件：改 `requiredForAgent`
 *  - 调整上传必需条件：改 `requiredForUpload`
 */
export const CAPABILITIES: CapabilityDef[] = [
  {
    id: 'text',
    label: '文本',
    description: '支持文本生成与理解',
    requiredForAgent: false,
    requiredForUpload: false,
  },
  {
    id: 'vision',
    label: '视觉识别',
    description: '支持图片/视频的视觉理解',
    requiredForAgent: false,
    requiredForUpload: true,
  },
  {
    id: 'audio',
    label: '音频',
    description: '支持音频输入/输出',
    requiredForAgent: false,
    requiredForUpload: false,
  },
  {
    id: 'code',
    label: '代码',
    description: '擅长代码生成与理解',
    requiredForAgent: false,
    requiredForUpload: false,
  },
  {
    id: 'reasoning',
    label: '推理',
    description: '支持深度推理与链式思考',
    requiredForAgent: false,
    requiredForUpload: false,
  },
  {
    id: 'tool',
    label: '工具调用',
    description: '支持 Function Calling 工具调用',
    requiredForAgent: true,
    requiredForUpload: false,
  },
  {
    id: 'think',
    label: '深度思考',
    description: '支持深度推理与思考过程展示',
    requiredForAgent: false,
    requiredForUpload: false,
  },
  {
    id: 'asr',
    label: '语音识别',
    description: '支持语音转文字（ASR）',
    requiredForAgent: false,
    requiredForUpload: false,
  },
]

// ─── 类型定义 ────────────────────────────────────────────────

/** 所有能力 ID 的联合类型 */
export type CapabilityId = typeof CAPABILITIES[number]['id']

// ─── 标签映射表（API值 → 显示值）───────────────────────────
// 第一个值（key）用于数据请求/API操作，第二个值（value）仅用于界面显示给用户
//
// 内置标签不可删除；自定义标签通过 localStorage 持久化，全局同步

const BUILTIN_MAPPINGS: Record<string, string> = {
  tool: '工具调用',
  text: '文本',
  vision: '视觉识别',
  audio: '音频',
  code: '代码',
  reasoning: '推理',
  think: '深度思考',
  asr: '语音识别',
}

function loadCustomMappings(): Record<string, string> {
  try {
    const stored = localStorage.getItem('tag_mappings')
    if (stored) return JSON.parse(stored)
  } catch { /* ignore corrupt data */ }
  return {}
}

function persistTagMappings() {
  const custom: Record<string, string> = {}
  for (const [k, v] of Object.entries(TAG_MAPPING)) {
    if (!(k in BUILTIN_MAPPINGS)) custom[k] = v
  }
  localStorage.setItem('tag_mappings', JSON.stringify(custom))
}

/** 完整映射表（内置 + 自定义），支持运行时动态修改 */
export const TAG_MAPPING: Record<string, string> = {
  ...BUILTIN_MAPPINGS,
  ...loadCustomMappings(),
}

/** 根据 API 标签值获取显示名称 */
export function getTagLabel(apiTag: string): string {
  return TAG_MAPPING[apiTag] ?? apiTag
}

/** 根据显示名称反向查找 API 标签值 */
export function getTagApiValue(label: string): string | undefined {
  return Object.entries(TAG_MAPPING).find(([, v]) => v === label)?.[0]
}

/** 获取所有 API 标签值（用于表单、过滤等） */
export function getAllApiTags(): string[] {
  return Object.keys(TAG_MAPPING)
}

/** 获取所有显示名称 */
export function getAllTagLabels(): string[] {
  return Object.values(TAG_MAPPING)
}

/** 将 API 标签列表转换为显示名称列表 */
export function apiTagsToLabels(tags: string[]): string[] {
  return tags.map(t => getTagLabel(t))
}

/** 将显示名称列表转换为 API 标签列表（忽略无法识别的） */
export function labelsToApiTags(labels: string[]): string[] {
  return labels.map(l => getTagApiValue(l)).filter(Boolean) as string[]
}

/** 获取标签的 key→value 显示对 */
export function getTagPair(key: string): { key: string; label: string; isBuiltin: boolean } {
  return { key, label: getTagLabel(key), isBuiltin: key in BUILTIN_MAPPINGS }
}

/** 判断是否为内置标签（不可删除） */
export function isBuiltinTag(key: string): boolean {
  return key in BUILTIN_MAPPINGS
}

/** 设置/更新标签映射（会同步到 localStorage） */
export function setTagMapping(key: string, label: string) {
  TAG_MAPPING[key] = label
  persistTagMappings()
}

/** 删除自定义标签映射（内置标签不可删除），返回是否成功 */
export function removeTagMapping(key: string): boolean {
  if (key in BUILTIN_MAPPINGS) return false
  delete TAG_MAPPING[key]
  persistTagMappings()
  return true
}

// ─── 便捷查询工具 ────────────────────────────────────────────

/** 以 Set 形式提供所有能力 ID，方便快速查找 */
export const CAPABILITY_IDS = new Set(CAPABILITIES.map(c => c.id))

/** 根据 ID 查找能力定义 */
export function getCapability(id: string): CapabilityDef | undefined {
  return CAPABILITIES.find(c => c.id === id)
}

/** 检查能力列表中是否包含指定能力 */
export function hasCapability(caps: string[] | undefined, id: string): boolean {
  return caps?.includes(id) ?? false
}

/** 按能力过滤列表（返回匹配的条目） */
export function filterByCapability<T extends { capabilities?: string[] }>(
  items: T[],
  requiredCapability: string
): T[] {
  return items.filter(item => hasCapability(item.capabilities, requiredCapability))
}

/** 获取所有 Agent 模式必需的能力 ID 列表 */
export function getAgentRequiredCapabilities(): string[] {
  return CAPABILITIES.filter(c => c.requiredForAgent).map(c => c.id)
}

/** 获取文件上传必需的能力 ID 列表 */
export function getUploadRequiredCapabilities(): string[] {
  return CAPABILITIES.filter(c => c.requiredForUpload).map(c => c.id)
}

/** 获取能力的中文标签 */
export function getCapabilityLabel(id: string): string {
  return getCapability(id)?.label ?? id
}
