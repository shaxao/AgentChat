/**
 * AnimatedAvatar - AI 动画头像组件
 *
 * 参考 LobeChat 的头像动效设计：
 * - 流式输出时：柔和的脉动光晕 (pulse glow)
 * - 思考状态：呼吸灯效果 (breathing)
 * - 静态状态：品牌 Logo + 微妙的悬浮感
 *
 * 支持两种模式：
 * 1. 默认模式：使用 logo.png 作为品牌头像
 * 2. LobeIcon 模式：使用 @lobehub/icons 的品牌 Avatar 组件
 */

import { memo } from 'react'
import { cn } from '@/lib/utils'

interface AnimatedAvatarProps {
  /** 头像尺寸 */
  size?: number
  /** 是否为流式输出中（触发脉动动画） */
  isStreaming?: boolean
  /** 是否为用户 */
  isUser?: boolean
  /** 自定义 className */
  className?: string
  /** 模型名称（用于匹配 LobeIcon 品牌） */
  modelName?: string
}

/**
 * AI 品牌图标映射表
 * 将模型名称映射到 @lobehub/icons 的品牌组件名
 */
const MODEL_BRAND_MAP: Record<string, string> = {
  // OpenAI 系列
  'gpt-4o': 'OpenAI', 'gpt-4': 'OpenAI', 'gpt-4-turbo': 'OpenAI',
  'gpt-3.5-turbo': 'OpenAI', 'o1': 'OpenAI', 'o3': 'OpenAI',
  'gpt-oss-120b': 'OpenAI', 'gpt-oss-20b': 'OpenAI',
  // Anthropic / Claude
  'claude': 'Claude', 'claude-3': 'Claude', 'claude-3.5': 'Claude',
  'claude-3.5-sonnet': 'Claude', 'claude-3-opus': 'Claude',
  // DeepSeek
  'deepseek': 'DeepSeek', 'deepseek-chat': 'DeepSeek',
  'deepseek-coder': 'DeepSeek', 'deepseek-v3': 'DeepSeek',
  // Google / Gemini
  'gemini': 'Google', 'gemini-pro': 'Google', 'gemini-1.5': 'Google',
  // 国产模型
  'qwen': 'Alibaba', 'tongyi': 'Alibaba', 'qwen-max': 'Alibaba',
  'wenxin': 'Baidu', 'ernie': 'Baidu',
  'chatglm': 'ChatGLM', 'zhipu': 'ChatGLM',
  'spark': 'Xunfei', 'xunfei': 'Xunfei',
  'hunyuan': 'Tencent', 'doubao': 'ByteDance',
  'kimi': 'Moonshot', 'moonshot': 'Moonshot',
  'yi': 'Yi', 'minimax': 'MiniMax',
  // 其他
  'mistral': 'Mistral', 'cohere': 'Cohere', 'llama': 'Meta',
  'ollama': 'Ollama', 'groq': 'Groq',
}

function getBrandKey(modelName?: string): string | undefined {
  if (!modelName) return undefined
  const lower = modelName.toLowerCase()
  // 精确匹配
  if (MODEL_BRAND_MAP[lower]) return MODEL_BRAND_MAP[lower]
  // 模糊匹配
  for (const [key, brand] of Object.entries(MODEL_BRAND_MAP)) {
    if (lower.includes(key) || key.includes(lower)) return brand
  }
  return undefined
}

export const AnimatedAvatar = memo(function AnimatedAvatar({
  size = 32,
  isStreaming = false,
  isUser = false,
  className,
  modelName,
}: AnimatedAvatarProps) {
  const brandKey = getBrandKey(modelName)

  return (
    <div
      className={cn(
        'relative shrink-0 rounded-full overflow-hidden',
        isStreaming && !isUser && 'animate-avatar-pulse',
        className
      )}
      style={{ width: size, height: size }}
    >
      {/* 用户头像 */}
      {isUser ? (
        <div className="w-full h-full bg-primary flex items-center justify-center">
          <svg className="w-[55%] h-[55%] text-primary-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>
      ) : (
        <>
          {/* AI 头像：品牌 Logo 或默认 Logo */}
          <div className={cn(
            'w-full h-full flex items-center justify-center bg-gradient-to-br from-primary to-primary/80 relative z-10',
            isStreaming && 'animate-avatar-breathe'
          )}>
            {brandKey ? (
              // 使用 LobeIcon 品牌 Logo（动态导入，避免打包所有图标）
              <LobeIconBrand brandKey={brandKey} size={size * 0.6} />
            ) : (
              // 默认使用网站 Logo
              <img
                src="/logo.png"
                alt="AI"
                className="w-[65%] h-[65%] object-contain drop-shadow-sm"
              />
            )}
          </div>

          {/* 流式输出时的脉动光晕层 */}
          {isStreaming && (
            <>
              <div className="absolute inset-0 rounded-full bg-primary/30 animate-avatar-glow-outer z-0" />
              <div className="absolute inset-[8%] rounded-full bg-primary/20 animate-avatar-glow-inner z-0" />
            </>
          )}
        </>
      )}

      {/* 思考状态的旋转指示器 */}
      {isStreaming && !isUser && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-20">
          <div className="absolute w-[90%] h-[90%] rounded-full border-2 border-transparent border-t-primary-foreground/40 animate-avatar-spin-slow" />
        </div>
      )}
    </div>
  )
})

/**
 * LobeIcon 品牌组件懒加载包装器
 * 动态导入 @lobehub/icons 的品牌组件，避免一次性打包所有图标
 */
function LobeIconBrand({ brandKey, size }: { brandKey: string; size: number }) {
  // 使用内联 SVG 作为 fallback（常见品牌的简化版）
  // 实际生产环境可改为动态 import(`@lobehub/icons/es/${brandKey}`).then(m => <m.default.Color size={size} />)
  return (
    <img
      src={`https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${brandKey.toLowerCase()}.svg`}
      alt={brandKey}
      className="w-full h-full object-contain p-[8%]"
      style={{ filter: 'brightness(0) invert(1)' }} // 反白以适配深色背景
      onError={(e) => {
        // 图片加载失败时隐藏，回退到 Logo 文字
        ;(e.target as HTMLImageElement).style.display = 'none'
      }}
    />
  )
}

export default AnimatedAvatar
