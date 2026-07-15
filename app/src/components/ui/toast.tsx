/**
 * 简单的 Toast 组件
 * 提供 useToast hook 用于显示提示消息
 */

import { useState, useCallback } from 'react'

export interface Toast {
  id: number
  title?: string
  description?: string
  variant?: 'default' | 'destructive' | 'success'
}

let toastCount = 0

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([])

  const toast = useCallback(({ title, description, variant = 'default' }: {
    title?: string
    description?: string
    variant?: 'default' | 'destructive' | 'success'
  }) => {
    const id = ++toastCount
    const newToast: Toast = { id, title, description, variant }
    
    setToasts((prev) => [...prev, newToast])
    
    // 3秒后自动移除
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 3000)
    
    // 同时在控制台输出（开发调试）
    if (variant === 'destructive') {
      console.error(title || description)
    } else if (variant === 'success') {
      console.log('✅', title || description)
    } else {
      console.log(title || description)
    }
  }, [])

  return {
    toast,
    toasts,
    dismiss: (id: number) => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    },
  }
}

/**
 * Toast 提供者组件（如果需要上下文）
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
