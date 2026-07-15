import { useState, useCallback } from 'react'
import { Star } from 'lucide-react'
import { cn } from '@/lib/utils'

interface StarRatingProps {
  /** 当前评分 (0-5, 支持小数如 3.5) */
  value: number
  /** 评分变化回调（仅 editable 模式） */
  onChange?: (value: number) => void
  /** 星星大小，默认 16px */
  size?: number
  /** 是否只读 */
  readonly?: boolean
  /** 显示评分数字文本 */
  showValue?: boolean
  /** 评分人数显示 */
  count?: number
  /** 自定义类名 */
  className?: string
}

/** 可复用的星级评分组件，支持只读展示和可交互评分 */
export function StarRating({
  value,
  onChange,
  size = 16,
  readonly = false,
  showValue = false,
  count,
  className,
}: StarRatingProps) {
  const [hoverValue, setHoverValue] = useState(0)
  const [isHovering, setIsHovering] = useState(false)

  const displayValue = isHovering && !readonly ? hoverValue : value

  const handleMouseEnter = useCallback((starIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
    if (readonly) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const half = x < rect.width / 2
    setHoverValue(half ? starIndex - 0.5 : starIndex)
    setIsHovering(true)
  }, [readonly])

  const handleMouseMove = useCallback((starIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
    if (readonly) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const half = x < rect.width / 2
    setHoverValue(half ? starIndex - 0.5 : starIndex)
  }, [readonly])

  const handleMouseLeave = useCallback(() => {
    if (readonly) return
    setIsHovering(false)
    setHoverValue(0)
  }, [readonly])

  const handleClick = useCallback((starIndex: number, e: React.MouseEvent<HTMLButtonElement>) => {
    if (readonly || !onChange) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const half = x < rect.width / 2
    const newValue = half ? starIndex - 0.5 : starIndex
    onChange(newValue)
  }, [readonly, onChange])

  const stars = [1, 2, 3, 4, 5]

  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      {stars.map((starIndex) => {
        const fillLevel = Math.min(Math.max(displayValue - (starIndex - 1), 0), 1)

        if (readonly) {
          // 只读模式：纯展示
          return (
            <span key={starIndex} className="relative inline-block" style={{ width: size, height: size }}>
              {/* 空星底色 */}
              <Star
                className="absolute inset-0 text-muted-foreground/25"
                style={{ width: size, height: size }}
                fill="currentColor"
                strokeWidth={1}
              />
              {/* 填充层（裁剪实现半星效果） */}
              {fillLevel > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden"
                  style={{ width: `${fillLevel * 100}%` }}
                >
                  <Star
                    className="text-amber-400"
                    style={{ width: size, height: size }}
                    fill="currentColor"
                    strokeWidth={1}
                  />
                </span>
              )}
            </span>
          )
        }

        // 交互模式：button
        return (
          <button
            key={starIndex}
            type="button"
            className="relative inline-block transition-transform hover:scale-110 focus:outline-none"
            style={{ width: size, height: size }}
            onMouseEnter={(e) => handleMouseEnter(starIndex, e)}
            onMouseMove={(e) => handleMouseMove(starIndex, e)}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => handleClick(starIndex, e)}
          >
            {/* 空星底色 */}
            <Star
              className="absolute inset-0 text-muted-foreground/25 transition-colors"
              style={{ width: size, height: size }}
              fill="currentColor"
              strokeWidth={1}
            />
            {/* 填充层 */}
            {fillLevel > 0 && (
              <span
                className="absolute inset-0 overflow-hidden"
                style={{ width: `${fillLevel * 100}%` }}
              >
                <Star
                  className="text-amber-400"
                  style={{ width: size, height: size }}
                  fill="currentColor"
                  strokeWidth={1}
                />
              </span>
            )}
          </button>
        )
      })}

      {showValue && value > 0 && (
        <span className="text-xs font-medium text-amber-500 ml-1">
          {value.toFixed(1)}
        </span>
      )}

      {count !== undefined && (
        <span className="text-xs text-muted-foreground ml-0.5">
          ({count})
        </span>
      )}
    </div>
  )
}
