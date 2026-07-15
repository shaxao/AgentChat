import { useEffect } from 'react'
import { useThemeStore } from '@/store'

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { mode, color, customCss } = useThemeStore()

  useEffect(() => {
    const root = document.documentElement
    
    // Apply dark/light mode
    const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const isDark = mode === 'dark' || (mode === 'system' && systemDark)
    
    root.classList.toggle('dark', isDark)
    
    // Remove old color themes
    root.classList.remove('theme-blue', 'theme-green', 'theme-purple', 'theme-orange', 'theme-rose')
    if (color !== 'blue' && color !== 'custom') {
      root.classList.add(`theme-${color}`)
    }
    
    // Apply custom CSS
    let styleEl = document.getElementById('custom-theme-css')
    if (customCss) {
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'custom-theme-css'
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = customCss
    } else if (styleEl) {
      styleEl.remove()
    }
  }, [mode, color, customCss])

  return <>{children}</>
}
