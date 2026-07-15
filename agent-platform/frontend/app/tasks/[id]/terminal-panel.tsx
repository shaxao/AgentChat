'use client'

import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { createTerminalWS } from '@/lib/api'

interface TerminalPanelProps {
  workspaceId: string
}

export default function TerminalPanel({ workspaceId }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const term = new XTerm({
      theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#c9d1d9' },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.4,
      cursorBlink: true,
      convertEol: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    fitAddon.fit()

    termRef.current = term
    fitRef.current = fitAddon

    // 连接 WebSocket
    const ws = createTerminalWS(workspaceId)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => term.writeln('\x1b[32m[AutoCode] 终端已连接\x1b[0m\r')
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        const text = new TextDecoder().decode(event.data)
        term.write(text)
      } else {
        term.write(event.data)
      }
    }
    ws.onerror = () => term.writeln('\x1b[31m[Error] WebSocket 连接失败\x1b[0m\r')
    ws.onclose = () => term.writeln('\x1b[33m[AutoCode] 终端已断开\x1b[0m\r')

    // 用户输入 → WebSocket
    term.onData(data => ws.readyState === WebSocket.OPEN && ws.send(data))

    // resize
    const observer = new ResizeObserver(() => fitAddon.fit())
    observer.observe(containerRef.current)
    wsRef.current = ws

    return () => {
      observer.disconnect()
      term.dispose()
      ws.close()
    }
  }, [workspaceId])

  return (
    <div ref={containerRef} className="h-full w-full bg-[#0d1117] rounded-lg overflow-hidden" />
  )
}
