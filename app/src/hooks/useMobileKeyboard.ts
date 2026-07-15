import { useState, useEffect, useRef } from 'react'
import { useIsMobile } from './useIsMobile'

export function useMobileKeyboard() {
  const isMobile = useIsMobile()
  const [keyboardHeight, setKeyboardHeight] = useState(0)
  const baselineHeightRef = useRef(0)
  const frameRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isMobile) {
      setKeyboardHeight(0)
      return
    }

    const vv = window.visualViewport
    if (!vv) return

    baselineHeightRef.current = Math.max(window.innerHeight, vv.height + vv.offsetTop)
    document.documentElement.style.setProperty('--mobile-browser-bottom', '0px')

    const handleResize = () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
      }

      frameRef.current = requestAnimationFrame(() => {
        const visibleHeight = vv.height + vv.offsetTop
        const baseline = Math.max(baselineHeightRef.current, window.innerHeight, visibleHeight)
        const offset = Math.max(0, baseline - visibleHeight)
        const chromeBottom = Math.max(0, window.innerHeight - visibleHeight)

        if (offset < 90) {
          baselineHeightRef.current = baseline
          document.documentElement.style.setProperty('--mobile-browser-bottom', `${Math.min(Math.round(chromeBottom), 88)}px`)
          setKeyboardHeight(0)
          return
        }

        const maxKeyboardHeight = Math.round(window.innerHeight * 0.55)
        document.documentElement.style.setProperty('--mobile-browser-bottom', '0px')
        setKeyboardHeight(Math.min(Math.round(offset), maxKeyboardHeight))
      })
    }

    vv.addEventListener('resize', handleResize)
    vv.addEventListener('scroll', handleResize)
    handleResize()

    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
      vv.removeEventListener('resize', handleResize)
      vv.removeEventListener('scroll', handleResize)
      document.documentElement.style.removeProperty('--mobile-browser-bottom')
    }
  }, [isMobile])

  return {
    keyboardHeight,
    keyboardOpen: keyboardHeight > 0,
  }
}
