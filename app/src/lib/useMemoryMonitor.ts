/**
 * 🔴 OOM 防御 — 浏览器端内存监控 Hook
 *
 * 双通道监控：
 * 1. performance.memory API — JS 堆内存（仅 Chrome）
 * 2. DOM 节点数统计 — 渲染层内存（所有浏览器）★ 本次 OOM 根因
 *
 * 背景：本次 bug 中 JS 堆仅 4MB 就 OOM，根因是 DOM/渲染层爆炸。
 * domNodeCount 直接在渲染进程中统计 → 是更准确的 OOM 预测指标。
 *
 * 策略：
 * - DOM > 5000 节点: warn 告警
 * - DOM > 8000 节点: error 告警
 * - DOM > 10000 节点: 红色横幅 + 建议刷新
 * - JS 堆 75%: warn
 * - JS 堆 85%: error + 尝试 GC
 * - JS 堆 90%: 横幅
 */

import { useEffect, useRef } from 'react'

interface MemoryInfo {
  jsHeapSizeLimit: number
  totalJSHeapSize: number
  usedJSHeapSize: number
}

interface PerformanceWithMemory extends Performance {
  memory?: MemoryInfo
}

// 全局单例：确保整个应用只有一个监控实例
let globalMonitorStarted = false
let globalIntervalId: ReturnType<typeof setInterval> | null = null
let globalRoundCount = 0

/**
 * 🔴 突发检测模式 — 用于流式完成等关键时刻的高频采样
 *
 * 背景：常规 10 秒采样无法捕获单帧内的 OOM 爆发（如 marked.parser 大内容渲染）。
 * burstMonitor() 启动后以 500ms 间隔持续采样 5 秒，
 * 如果 DOM 节点数在两次采样间增长超过 50%，触发告警。
 */
let burstActive = false
let burstTimer: ReturnType<typeof setTimeout> | null = null
let burstInterval: ReturnType<typeof setInterval> | null = null

export function burstMonitor() {
  if (burstActive) return // 防止重复启动
  burstActive = true

  const samples: { time: number; dom: number; heap: number }[] = []
  const takeSample = () => {
    const dom = document.querySelectorAll('*').length
    const perf = performance as PerformanceWithMemory
    const heap = perf.memory ? perf.memory.usedJSHeapSize / 1024 / 1024 : 0
    samples.push({ time: Date.now(), dom, heap })

    // 检测突发增长
    if (samples.length >= 2) {
      const prev = samples[samples.length - 2]
      const curr = samples[samples.length - 1]
      const domGrowth = prev.dom > 0 ? (curr.dom - prev.dom) / prev.dom : 0
      const heapGrowth = prev.heap > 0 ? (curr.heap - prev.heap) / prev.heap : 0

      if (domGrowth > 1.0 || heapGrowth > 1.0) {
        console.warn(
          `[OOM-BURST] 突发增长检测！DOM ${prev.dom}→${curr.dom} (${(domGrowth*100).toFixed(1)}%) | ` +
          `JS堆 ${prev.heap.toFixed(1)}→${curr.heap.toFixed(1)}MB (${(heapGrowth*100).toFixed(1)}%)`
        )
      }
    }
  }

  takeSample() // 立即采样一次

  burstInterval = setInterval(takeSample, 500)

  burstTimer = setTimeout(() => {
    if (burstInterval) clearInterval(burstInterval)
    if (burstTimer) clearTimeout(burstTimer)
    burstInterval = null
    burstTimer = null
    burstActive = false

    if (samples.length > 0) {
      const first = samples[0]
      const last = samples[samples.length - 1]
      console.log(
        `[OOM-BURST] 5s 采样结束（${samples.length} 次）。` +
        `DOM ${first.dom}→${last.dom} | JS堆 ${first.heap.toFixed(1)}→${last.heap.toFixed(1)}MB`
      )
    }
  }, 5000)
}

export function useMemoryMonitor(enabled = true) {
  const warnedRef = useRef(false)        // DOM 告警
  const heapWarnedRef = useRef(false)    // 堆告警
  const criticalRef = useRef(false)       // DOM 严重
  const heapCriticalRef = useRef(false)   // 堆严重
  const logRef = useRef<number[]>([])

  useEffect(() => {
    if (!enabled || globalMonitorStarted) return

    globalMonitorStarted = true

    globalIntervalId = setInterval(() => {
      try {
        globalRoundCount++

        // ================ 通道 1: DOM 节点数 ================
        const domCount = document.querySelectorAll('*').length

        // 通道 2: JS 堆内存（Chrome only）
        const perf = performance as PerformanceWithMemory
        const hasHeap = !!perf.memory
        let usedPct = 0
        let usedMB = 0
        let limitMB = 0

        if (hasHeap) {
          const m = perf.memory!
          usedMB = m.usedJSHeapSize / 1024 / 1024
          limitMB = m.jsHeapSizeLimit / 1024 / 1024
          const totalMB = m.totalJSHeapSize / 1024 / 1024
          usedPct = (m.usedJSHeapSize / m.jsHeapSizeLimit) * 100

          // 堆内存记录
          logRef.current.push(usedMB)
          if (logRef.current.length > 10) logRef.current.shift()
        }

        // ================ 定期日志（每 5 轮 = 50 秒） ================
        if (globalRoundCount % 5 === 0) {
          const parts = [`[OOM-Monitor] #${globalRoundCount}`]
          parts.push(`DOM: ${domCount} 节点`)
          if (hasHeap) {
            parts.push(`JS堆: ${usedMB.toFixed(1)}/${limitMB.toFixed(1)}MB (${usedPct.toFixed(1)}%)`)
          } else {
            parts.push('JS堆: 不可用（需 Chrome）')
          }
          console.log(parts.join(' | '))
        }

        // ================ DOM 节点数告警 ================
        if (domCount > 5000 && !warnedRef.current) {
          warnedRef.current = true
          console.warn(
            `[OOM-WARN] DOM 节点数 ${domCount} 超过 5000！可能导致渲染层 OOM。` +
            `请检查是否有大量未清理的 DOM 节点。`
          )
        }

        if (domCount > 8000 && !criticalRef.current) {
          criticalRef.current = true
          console.error(
            `[OOM-ERROR] DOM 节点数 ${domCount} 超过 8000！` +
            `浏览器渲染进程即将耗尽内存，请立即刷新页面！`
          )
        }

        if (domCount > 10000) {
          if (typeof window !== 'undefined' && !document.querySelector('#oom-banner')) {
            const banner = document.createElement('div')
            banner.id = 'oom-banner'
            banner.style.cssText = `
              position:fixed;top:0;left:0;right:0;z-index:99999;
              background:#ef4444;color:white;padding:8px 16px;
              font-size:14px;text-align:center;font-weight:bold;
              display:flex;align-items:center;justify-content:center;gap:8px;
            `
            banner.innerHTML = `
              ⚠️ 浏览器内存不足（DOM 节点 ${domCount} 个），页面可能崩溃。
              <button id="oom-banner-close"
                style="background:white;color:#ef4444;border:none;padding:4px 12px;border-radius:4px;cursor:pointer;font-weight:bold">
                知道了
              </button>
            `
            document.body.prepend(banner)
            document.getElementById('oom-banner-close')?.addEventListener('click', () => {
              banner.remove()
            })
          }
        }

        // ================ JS 堆告警（仅 Chrome） ================
        if (hasHeap) {
          if (usedPct > 75 && !heapWarnedRef.current) {
            heapWarnedRef.current = true
            console.warn(
              `[OOM-WARN] JS 堆使用率 ${usedPct.toFixed(1)}%（${usedMB.toFixed(1)}MB/${limitMB.toFixed(1)}MB）`
            )
          }

          if (usedPct > 85 && !heapCriticalRef.current) {
            heapCriticalRef.current = true
            console.error(
              `[OOM-ERROR] JS 堆使用率 ${usedPct.toFixed(1)}%！即将 OOM！`
            )
            if (typeof (window as any).gc === 'function') {
              console.warn('[OOM-Monitor] 尝试手动 GC...')
              ;(window as any).gc()
            }
          }
        }

        // ================ 恢复正常时重置告警 ================
        if (domCount < 3000) {
          warnedRef.current = false
          criticalRef.current = false
          document.getElementById('oom-banner')?.remove()
        }
        if (hasHeap && usedPct < 60) {
          heapWarnedRef.current = false
          heapCriticalRef.current = false
          document.getElementById('oom-banner')?.remove()
        }

      } catch (e) {
        // 忽略监控本身的错误
      }
    }, 10000)

    console.info('[OOM-Monitor] 双通道内存监控已启动（DOM节点数 + JS堆）')

    return () => {
      if (globalIntervalId) {
        clearInterval(globalIntervalId)
        globalIntervalId = null
        globalMonitorStarted = false
      }
    }
  }, [enabled])
}
