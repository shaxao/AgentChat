/**
 * 方向一致性分析工具库
 *
 * 基于研究文档《对话Agent实时干预_数学模型与极致实现》中的理论：
 * - 方向一致性度量: similarity(U, T) = cos(embed(U), embed(T))
 * - 阈值决策: >0.7 排队 | 0.3-0.7 待确认 | <0.3 抢占
 *
 * 实现方案：纯前端字符二元组 (character bigram) + TF 余弦相似度
 * - 中文友好：无需分词词典，二元组天然捕捉汉字共现关系
 * - 英文兼容：空格分词 + 字符级 bigram 混合
 * - 零网络延迟：全部在浏览器端计算，< 1ms
 */

// ============================================================================
// 1. 分词 — 字符二元组 + 空格分词混合
// ============================================================================

/**
 * 将文本分词为 token 数组
 *
 * 策略：
 * - 中文连续段 → 字符二元组（如 "你好世界" → ["你好", "好世", "世界"]）
 * - 英文/数字连续段 → 整体作为一个 token（如 "hello" → ["hello"]）
 * - 标点符号 → 忽略
 * - 全部转小写
 *
 * @param text 输入文本
 * @returns token 数组
 */
export function tokenize(text: string): string[] {
  if (!text || text.trim().length === 0) return []

  const tokens: string[] = []
  const lower = text.toLowerCase()

  // 匹配：中文字符段 | 英文/数字/下划线段
  // 中文范围: \u4e00-\u9fff (CJK Unified Ideographs)
  const segmentRegex = /([\u4e00-\u9fff]+)|([a-z0-9_]+)/g
  let match: RegExpExecArray | null

  while ((match = segmentRegex.exec(lower)) !== null) {
    const chineseSegment = match[1]
    const alphaSegment = match[2]

    if (chineseSegment) {
      // 中文段：提取字符二元组
      for (let i = 0; i < chineseSegment.length - 1; i++) {
        tokens.push(chineseSegment.substring(i, i + 2))
      }
      // 单字也加入（处理极短中文段）
      if (chineseSegment.length === 1) {
        tokens.push(chineseSegment)
      }
    } else if (alphaSegment) {
      // 英文/数字段：整体作为一个 token
      tokens.push(alphaSegment)
    }
  }

  return tokens
}

// ============================================================================
// 2. 词频向量 — TF (Term Frequency)
// ============================================================================

/**
 * 计算 token 数组的词频向量
 *
 * @param tokens token 数组
 * @returns Map<token, 词频> — 词频为该 token 出现次数 / 总 token 数
 */
export function tf(tokens: string[]): Map<string, number> {
  if (tokens.length === 0) return new Map()

  const freq = new Map<string, number>()
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1)
  }

  // 归一化：除以总 token 数
  const total = tokens.length
  for (const [key, value] of freq) {
    freq.set(key, value / total)
  }

  return freq
}

// ============================================================================
// 3. 余弦相似度 — Cosine Similarity
// ============================================================================

/**
 * 计算两个文本的余弦相似度
 *
 * cosine(A, B) = (A · B) / (||A|| * ||B||)
 *
 * @param textA 文本 A
 * @param textB 文本 B
 * @returns 相似度值 [0, 1]，0 表示完全无关，1 表示完全相同
 */
export function cosineSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0

  const tokensA = tokenize(textA)
  const tokensB = tokenize(textB)

  if (tokensA.length === 0 || tokensB.length === 0) return 0

  const tfA = tf(tokensA)
  const tfB = tf(tokensB)

  // 计算点积：遍历较小的向量
  const [smaller, larger] = tfA.size <= tfB.size ? [tfA, tfB] : [tfB, tfA]

  let dotProduct = 0
  for (const [token, weight] of smaller) {
    const otherWeight = larger.get(token)
    if (otherWeight !== undefined) {
      dotProduct += weight * otherWeight
    }
  }

  // 计算向量模长
  let magnitudeA = 0
  for (const weight of tfA.values()) {
    magnitudeA += weight * weight
  }
  magnitudeA = Math.sqrt(magnitudeA)

  let magnitudeB = 0
  for (const weight of tfB.values()) {
    magnitudeB += weight * weight
  }
  magnitudeB = Math.sqrt(magnitudeB)

  if (magnitudeA === 0 || magnitudeB === 0) return 0

  return dotProduct / (magnitudeA * magnitudeB)
}

// ============================================================================
// 4. 干预策略决策
// ============================================================================

/** 干预策略类型 */
export type InterventionStrategy = 'queue' | 'confirm' | 'preempt' | 'speculative_parallel'

/** 干预决策结果 */
export interface InterventionDecision {
  /** 策略：排队 / 待确认 / 抢占 / 投机双轨 */
  strategy: InterventionStrategy
  /** 方向一致性得分 [0, 1] */
  similarity: number
  /** 决策原因（人类可读） */
  reason: string
  /** 进度估计 [0, 1] — 当前生成内容的完成度估计 */
  progress?: number
  /** 剩余时间估计（ms）— 基于当前输出速率估算 */
  estimatedRemainingMs?: number
}

/** 决策阈值（可配置） */
export const SIMILARITY_THRESHOLDS = {
  QUEUE: 0.7,    // > 0.7 → 排队
  PREEMPT: 0.3,  // < 0.3 → 抢占
} as const

/**
 * 根据方向一致性决定干预策略
 *
 * - similarity > 0.7 → 'queue'（新消息与当前 AI 回复方向一致，排队等待）
 * - 0.3 < similarity ≤ 0.7 → 'confirm'（方向部分相关，需用户确认）
 * - similarity ≤ 0.3 且进度 > 0.8 → 'speculative_parallel'（即将完成，投机双轨：让当前完成 + 同时启动新方向）
 * - similarity ≤ 0.3 且进度 ≤ 0.8 → 'preempt'（方向完全不同，抢占当前回复）
 *
 * @param newMessage 用户新输入的消息
 * @param currentStreamingContent 当前 AI 正在流式输出的内容
 * @param progressHint 可选的进度提示（0-1），不传则根据内容特征估算
 * @returns 干预决策结果
 */
export function decideIntervention(
  newMessage: string,
  currentStreamingContent: string,
  progressHint?: number,
): InterventionDecision {
  // 边界情况：没有正在流式的内容 → 排队（不应抢占空内容）
  if (!currentStreamingContent || currentStreamingContent.trim().length < 10) {
    return {
      strategy: 'queue',
      similarity: 0,
      reason: '当前回复内容过少，无需抢占',
    }
  }

  // 边界情况：新消息为空 → 排队（不应发生）
  if (!newMessage || newMessage.trim().length === 0) {
    return {
      strategy: 'queue',
      similarity: 0,
      reason: '新消息为空',
    }
  }

  const similarity = cosineSimilarity(newMessage, currentStreamingContent)
  const progress = progressHint ?? estimateProgress(currentStreamingContent)

  let strategy: InterventionStrategy
  let reason: string

  if (similarity > SIMILARITY_THRESHOLDS.QUEUE) {
    strategy = 'queue'
    reason = `方向一致性 ${similarity.toFixed(2)} > ${SIMILARITY_THRESHOLDS.QUEUE}，新消息与当前回复高度相关，排队等待`
  } else if (similarity > SIMILARITY_THRESHOLDS.PREEMPT) {
    strategy = 'confirm'
    reason = `方向一致性 ${similarity.toFixed(2)} 介于 ${SIMILARITY_THRESHOLDS.PREEMPT}-${SIMILARITY_THRESHOLDS.QUEUE}，方向部分相关，需确认`
  } else {
    // similarity ≤ 0.3 → 方向不同
    // 投机双轨策略：如果当前生成进度 > 80%，让它完成（避免浪费），同时排队新方向
    if (progress > 0.8) {
      strategy = 'speculative_parallel'
      reason = `方向一致性 ${similarity.toFixed(2)} < ${SIMILARITY_THRESHOLDS.PREEMPT}，但进度 ${(progress * 100).toFixed(0)}% > 80%，投机双轨：让当前完成 + 排队新方向`
    } else {
      strategy = 'preempt'
      reason = `方向一致性 ${similarity.toFixed(2)} < ${SIMILARITY_THRESHOLDS.PREEMPT}，进度 ${(progress * 100).toFixed(0)}% ≤ 80%，抢占当前回复`
    }
  }

  return { strategy, similarity, reason, progress }
}

// ============================================================================
// 5. 关键词提取 — 用于 UI 展示决策依据
// ============================================================================

/**
 * 提取文本中的关键词（按词频排序）
 *
 * @param text 输入文本
 * @param maxKeywords 最多返回的关键词数量
 * @returns 关键词数组
 */
export function extractKeywords(text: string, maxKeywords: number = 5): string[] {
  const tokens = tokenize(text)
  if (tokens.length === 0) return []

  const freq = new Map<string, number>()
  for (const token of tokens) {
    freq.set(token, (freq.get(token) || 0) + 1)
  }

  return Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([token]) => token)
}

// ============================================================================
// 6. 进度估计 — estimate_progress()
// ============================================================================

/**
 * 估计当前流式输出的完成进度
 *
 * 启发式规则：
 * - 内容长度 < 100 字符 → 进度 0.1（刚开始）
 * - 内容中有明确的结束信号（"。"结尾 + 长度 > 500）→ 进度 0.9
 * - 内容中有代码块 ``` → 代码完成后进度 +0.2
 * - 基于平均回复长度（~800-2000 字符）线性插值
 *
 * @param content 当前流式输出内容
 * @returns 进度估计值 [0, 1]
 */
export function estimateProgress(content: string): number {
  if (!content || content.length === 0) return 0

  const len = content.length

  // 基于长度的线性插值（平均回复 800-2000 字符）
  const AVG_RESPONSE_LENGTH = 1200
  let progress = Math.min(len / AVG_RESPONSE_LENGTH, 0.85)

  // 结束信号检测
  const trimmed = content.trimEnd()

  // 以句号/感叹号/问号结尾 + 长度 > 200 → 接近完成
  if (len > 200 && /[。！？.!?]\s*$/.test(trimmed)) {
    progress = Math.max(progress, 0.75)
  }

  // 以段落分隔结尾（\n\n）→ 段落完成
  if (/\n\n\s*$/.test(content)) {
    progress = Math.max(progress, 0.6)
  }

  // 代码块完成检测：有配对的 ```
  const codeBlockCount = (content.match(/```/g) || []).length
  if (codeBlockCount > 0 && codeBlockCount % 2 === 0) {
    progress = Math.max(progress, 0.7)
  }

  // Markdown 标题/列表 → 结构化输出，进度更高
  if (/^#{1,6}\s/m.test(content) && len > 300) {
    progress = Math.max(progress, 0.6)
  }

  return Math.min(progress, 0.95) // 永远不返回 1.0（只有 done 事件才表示完成）
}

// ============================================================================
// 7. 自然断点检测 — detectNaturalBreakpoint()
// ============================================================================

/** 自然断点类型 */
export type NaturalBreakpoint = 'paragraph_end' | 'sentence_end' | 'tool_result' | 'chunk_boundary'

/**
 * 检测当前内容是否处于自然断点
 *
 * 自然断点定义（参考文档 3.4 节）：
 * - 段落结束（\n\n）
 * - 句子结束（。！？.!? 后跟换行或空格）
 * - 工具调用完成（tool_result 事件）
 * - 流式输出的 chunk 边界（每个 SSE 事件天然是 chunk 边界）
 *
 * @param content 当前累积的流式内容
 * @param lastChunk 最新收到的 token/chunk
 * @returns 断点类型，null 表示非自然断点
 */
export function detectNaturalBreakpoint(content: string, lastChunk: string): NaturalBreakpoint | null {
  // 段落结束：最新 chunk 以 \n\n 结尾，或内容以 \n\n 结尾
  if (content.endsWith('\n\n') || lastChunk.endsWith('\n\n')) {
    return 'paragraph_end'
  }

  // 句子结束：内容以句号 + 换行/空格结尾
  if (/[。！？.!?]\s*\n?$/.test(content.trimEnd())) {
    return 'sentence_end'
  }

  // chunk 边界：每个 SSE token 天然是 chunk 边界
  // 但我们只在有意义的位置插入（避免每个 token 都算断点）
  if (lastChunk.includes('\n') || lastChunk.includes('。') || lastChunk.includes('．')) {
    return 'chunk_boundary'
  }

  return null
}

// ============================================================================
// 8. 输出可撤销标记 — findSplitPoint()
// ============================================================================

/**
 * 计算输出分割点
 *
 * split_point = max {i : output[1..i] 与 U(t₀) 不矛盾}
 *
 * 启发式实现：
 * - 找到最后一个段落分隔符（\n\n）的位置 → 段落级分割
 * - 如果没有段落分隔，找最后一个句子结束符 → 句子级分割
 * - 如果都没有，在当前位置分割（token 级）
 *
 * @param content 当前完整的流式输出内容
 * @returns 分割点索引（valid_output = content[0..splitPoint]）
 */
export function findSplitPoint(content: string): number {
  if (!content || content.length === 0) return 0

  // 优先在段落分隔处分割
  const lastParagraphEnd = content.lastIndexOf('\n\n')
  if (lastParagraphEnd > 50) {
    return lastParagraphEnd + 2 // 包含 \n\n
  }

  // 其次在句子结束处分割
  const sentenceEndRegex = /[。！？.!?]\s/g
  let lastSentenceEnd = -1
  let match: RegExpExecArray | null
  while ((match = sentenceEndRegex.exec(content)) !== null) {
    lastSentenceEnd = match.index + match[0].length
  }
  if (lastSentenceEnd > 50) {
    return lastSentenceEnd
  }

  // 最后在换行处分割
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline > 50) {
    return lastNewline + 1
  }

  // 兜底：在当前位置分割（整个内容都作为 valid_output）
  return content.length
}
