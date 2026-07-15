import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import {
  MousePointer2, Square, Circle, Type, Diamond, ArrowRight, Trash2,
  X, Check, Palette, Minus
} from 'lucide-react'
import { Button } from '@/components/ui/button'

// ─── 类型定义 ──────────────────────────────────────────
export interface ExcalidrawElement {
  id: string
  type: 'rectangle' | 'text' | 'arrow' | 'ellipse' | 'line' | 'diamond'
  x: number
  y: number
  width: number
  height: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  roughness?: number
  text?: string
  fontSize?: number
  fontFamily?: string
  groupIds?: string[]
  roundness?: unknown
  boundElements?: unknown[]
  link?: string | null
  locked?: boolean
}

type ToolType = 'select' | 'rectangle' | 'ellipse' | 'text' | 'diamond' | 'arrow'

interface PrototypeEditorProps {
  initialElements: ExcalidrawElement[]
  title?: string
  description?: string
  features?: string[]
  onSave: (elements: ExcalidrawElement[]) => void
  onCancel: () => void
}

// ─── 工具配置 ──────────────────────────────────────────
const TOOLS: { type: ToolType; icon: React.ReactNode; label: string }[] = [
  { type: 'select', icon: <MousePointer2 className="w-4 h-4" />, label: '选择' },
  { type: 'rectangle', icon: <Square className="w-4 h-4" />, label: '矩形' },
  { type: 'ellipse', icon: <Circle className="w-4 h-4" />, label: '椭圆' },
  { type: 'text', icon: <Type className="w-4 h-4" />, label: '文本' },
  { type: 'diamond', icon: <Diamond className="w-4 h-4" />, label: '菱形' },
  { type: 'arrow', icon: <ArrowRight className="w-4 h-4" />, label: '箭头' },
]

const DEFAULT_COLORS = [
  '#1e293b', '#ef4444', '#f97316', '#eab308',
  '#22c55e', '#3b82f6', '#a855f7', '#ec4899',
  '#ffffff', '#f1f5f9', '#cbd5e1', '#94a3b8',
]

// ─── 辅助函数 ──────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).slice(2, 9)
}

function getSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const pt = svg.createSVGPoint()
  pt.x = clientX
  pt.y = clientY
  return pt.matrixTransform(svg.getScreenCTM()?.inverse())
}

function hitTest(el: ExcalidrawElement, x: number, y: number): boolean {
  const ex = el.x, ey = el.y, ew = el.width, eh = el.height
  if (el.type === 'ellipse') {
    const cx = ex + ew / 2, cy = ey + eh / 2
    const dx = (x - cx) / (ew / 2), dy = (y - cy) / (eh / 2)
    return dx * dx + dy * dy <= 1.1 // 稍微放大命中区域
  }
  if (el.type === 'diamond') {
    const cx = ex + ew / 2, cy = ey + eh / 2
    const dx = Math.abs(x - cx) / (ew / 2), dy = Math.abs(y - cy) / (eh / 2)
    return dx + dy <= 1.1
  }
  if (el.type === 'text') {
    return x >= ex && x <= ex + ew && y >= ey && y <= ey + eh
  }
  // rectangle, arrow, line
  return x >= ex - 4 && x <= ex + ew + 4 && y >= ey - 4 && y <= ey + eh + 4
}

function getHandleAt(x: number, y: number, el: ExcalidrawElement): string | null {
  const handles = [
    { name: 'nw', x: el.x, y: el.y },
    { name: 'n', x: el.x + el.width / 2, y: el.y },
    { name: 'ne', x: el.x + el.width, y: el.y },
    { name: 'e', x: el.x + el.width, y: el.y + el.height / 2 },
    { name: 'se', x: el.x + el.width, y: el.y + el.height },
    { name: 's', x: el.x + el.width / 2, y: el.y + el.height },
    { name: 'sw', x: el.x, y: el.y + el.height },
    { name: 'w', x: el.x, y: el.y + el.height / 2 },
  ]
  for (const h of handles) {
    if (Math.abs(x - h.x) <= 8 && Math.abs(y - h.y) <= 8) return h.name
  }
  return null
}

function createElement(tool: ToolType, x: number, y: number): ExcalidrawElement {
  const base: ExcalidrawElement = {
    id: generateId(),
    type: tool === 'arrow' ? 'arrow' : tool as any,
    x, y,
    width: 120,
    height: tool === 'text' ? 30 : 80,
    strokeColor: '#1e293b',
    backgroundColor: tool === 'text' ? 'transparent' : '#ffffff',
    strokeWidth: 1,
    strokeStyle: 'solid',
  }
  if (tool === 'text') {
    base.text = '双击编辑文本'
    base.fontSize = 16
    base.fontFamily = 'sans-serif'
    base.width = 120
    base.height = 30
  }
  if (tool === 'arrow') {
    base.width = 100
    base.height = 0
  }
  return base
}

// ─── 组件 ──────────────────────────────────────────
export default function PrototypeEditor({
  initialElements,
  title,
  description,
  features = [],
  onSave,
  onCancel,
}: PrototypeEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [elements, setElements] = useState<ExcalidrawElement[]>(initialElements)
  const [tool, setTool] = useState<ToolType>('select')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isResizing, setIsResizing] = useState(false)
  const [resizeHandle, setResizeHandle] = useState<string | null>(null)
  const dragRef = useRef({ startX: 0, startY: 0, elX: 0, elY: 0, elW: 0, elH: 0 })
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const textInputRef = useRef<HTMLTextAreaElement>(null)

  // 计算边界框和 viewBox
  const { viewBox, canvasWidth, canvasHeight } = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const el of elements) {
      const x = el.x, y = el.y
      const w = el.width, h = el.height
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + w)
      maxY = Math.max(maxY, y + h)
    }
    const pad = 100
    if (!isFinite(minX)) {
      return { viewBox: '-100 -100 800 600', canvasWidth: 800, canvasHeight: 600 }
    }
    minX -= pad; minY -= pad
    maxX += pad; maxY += pad
    return {
      viewBox: `${minX} ${minY} ${maxX - minX} ${maxY - minY}`,
      canvasWidth: maxX - minX,
      canvasHeight: maxY - minY,
    }
  }, [elements])

  const selectedElement = useMemo(
    () => elements.find(e => e.id === selectedId) || null,
    [elements, selectedId]
  )

  // 键盘事件：Delete 删除
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId && !editingTextId) {
        setElements(prev => prev.filter(el => el.id !== selectedId))
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, editingTextId])

  // 自动聚焦文本输入
  useEffect(() => {
    if (editingTextId && textInputRef.current) {
      textInputRef.current.focus()
      textInputRef.current.select()
    }
  }, [editingTextId])

  const updateElement = useCallback((id: string, patch: Partial<ExcalidrawElement>) => {
    setElements(prev => prev.map(el => el.id === id ? { ...el, ...patch } : el))
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current
    if (!svg) return
    const pt = getSvgPoint(svg, e.clientX, e.clientY)
    const x = pt.x, y = pt.y

    // 非选择工具：创建新元素
    if (tool !== 'select') {
      const newEl = createElement(tool, x, y)
      setElements(prev => [...prev, newEl])
      setSelectedId(newEl.id)
      setTool('select')
      return
    }

    // 选择工具：检查是否点中元素（从后往前，后绘制的在上层）
    const clicked = [...elements].reverse().find(el => hitTest(el, x, y))
    if (clicked) {
      // 检查是否点中调整手柄
      const handle = getHandleAt(x, y, clicked)
      if (handle) {
        setSelectedId(clicked.id)
        setIsResizing(true)
        setResizeHandle(handle)
        dragRef.current = {
          startX: x, startY: y,
          elX: clicked.x, elY: clicked.y,
          elW: clicked.width, elH: clicked.height,
        }
        return
      }
      // 选中并开始拖拽
      setSelectedId(clicked.id)
      setIsDragging(true)
      dragRef.current = {
        startX: x, startY: y,
        elX: clicked.x, elY: clicked.y,
        elW: clicked.width, elH: clicked.height,
      }
      return
    }

    // 点中空白：取消选择
    setSelectedId(null)
  }, [tool, elements])

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (!isDragging && !isResizing) return
    const svg = svgRef.current
    if (!svg) return
    const pt = getSvgPoint(svg, e.clientX, e.clientY)
    const x = pt.x, y = pt.y
    const d = dragRef.current

    if (isDragging && selectedId) {
      updateElement(selectedId, {
        x: d.elX + (x - d.startX),
        y: d.elY + (y - d.startY),
      })
    }

    if (isResizing && selectedId && resizeHandle) {
      let nx = d.elX, ny = d.elY, nw = d.elW, nh = d.elH
      if (resizeHandle.includes('e')) nw = Math.max(20, d.elW + (x - d.startX))
      if (resizeHandle.includes('s')) nh = Math.max(20, d.elH + (y - d.startY))
      if (resizeHandle.includes('w')) {
        const dx = x - d.startX
        nw = Math.max(20, d.elW - dx)
        nx = d.elX + d.elW - nw
      }
      if (resizeHandle.includes('n')) {
        const dy = y - d.startY
        nh = Math.max(20, d.elH - dy)
        ny = d.elY + d.elH - nh
      }
      updateElement(selectedId, { x: nx, y: ny, width: nw, height: nh })
    }
  }, [isDragging, isResizing, selectedId, resizeHandle, updateElement])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
    setIsResizing(false)
    setResizeHandle(null)
  }, [])

  const handleDoubleClick = useCallback((e: React.MouseEvent, el: ExcalidrawElement) => {
    e.stopPropagation()
    if (el.type === 'text') {
      setEditingTextId(el.id)
      setEditValue(el.text || '')
      setSelectedId(el.id)
    }
  }, [])

  const commitTextEdit = useCallback(() => {
    if (editingTextId) {
      updateElement(editingTextId, { text: editValue })
      setEditingTextId(null)
      setEditValue('')
    }
  }, [editingTextId, editValue, updateElement])

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* 顶部栏 */}
      <div className="px-5 py-3 border-b bg-gradient-to-r from-violet-500/10 to-purple-500/5 shrink-0 flex items-center gap-4">
        <div className="flex items-center gap-3 flex-1">
          <div className="w-9 h-9 rounded-lg bg-violet-500/10 flex items-center justify-center">
            <Palette className="w-4 h-4 text-violet-500" />
          </div>
          <div>
            <h2 className="text-sm font-semibold">
              {title ? `编辑原型：${title}` : '编辑 UI 原型'}
            </h2>
            <p className="text-[11px] text-muted-foreground">
              {description || '拖拽移动元素，双击文本编辑，Delete 删除'}
            </p>
          </div>
        </div>

        {/* 工具栏 */}
        <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
          {TOOLS.map(t => (
            <button
              key={t.type}
              onClick={() => setTool(t.type)}
              title={t.label}
              className={`p-2 rounded-md transition-colors ${
                tool === t.type
                  ? 'bg-violet-500 text-white shadow-sm'
                  : 'hover:bg-muted text-muted-foreground'
              }`}
            >
              {t.icon}
            </button>
          ))}
        </div>

        {/* 元素计数 + 操作 */}
        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground">
            <span className="font-bold text-foreground">{elements.length}</span> 个元素
          </span>
          <Button variant="outline" size="sm" onClick={onCancel}>
            <X className="w-3.5 h-3.5 mr-1.5" />
            取消
          </Button>
          <Button size="sm" onClick={() => onSave(elements)}>
            <Check className="w-3.5 h-3.5 mr-1.5" />
            保存修改
          </Button>
        </div>
      </div>

      {/* 主体：画布 + 属性面板 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 画布区域 */}
        <div className="flex-1 relative bg-muted/30 overflow-hidden">
          <svg
            ref={svgRef}
            className="w-full h-full cursor-crosshair"
            viewBox={viewBox}
            preserveAspectRatio="xMidYMid meet"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          >
            {/* 背景网格 */}
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.5" />
              </pattern>
            </defs>
            <rect x={viewBox.split(' ')[0]} y={viewBox.split(' ')[1]} width={canvasWidth} height={canvasHeight} fill="url(#grid)" />
            <rect x={viewBox.split(' ')[0]} y={viewBox.split(' ')[1]} width={canvasWidth} height={canvasHeight} fill="#f8fafc" opacity={0.5} />

            {/* 渲染元素 */}
            {elements.map(el => {
              const isSelected = el.id === selectedId
              const x = el.x, y = el.y, w = el.width, h = el.height
              const fill = el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : 'none'
              const stroke = el.strokeColor ?? '#1e293b'
              const sw = el.strokeWidth ?? 1

              return (
                <g
                  key={el.id}
                  onDoubleClick={e => handleDoubleClick(e, el)}
                  style={{ cursor: tool === 'select' ? 'move' : 'crosshair' }}
                >
                  {el.type === 'rectangle' && (
                    <rect
                      x={x} y={y} width={w} height={h}
                      fill={fill} stroke={stroke} strokeWidth={sw}
                      strokeDasharray={el.strokeStyle === 'dashed' ? '8 4' : undefined}
                      rx={el.roundness ? 8 : 0}
                    />
                  )}
                  {el.type === 'diamond' && (
                    <polygon
                      points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
                      fill={fill} stroke={stroke} strokeWidth={sw}
                    />
                  )}
                  {el.type === 'ellipse' && (
                    <ellipse
                      cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2}
                      fill={fill} stroke={stroke} strokeWidth={sw}
                    />
                  )}
                  {el.type === 'text' && (
                    editingTextId === el.id ? (
                      <foreignObject x={x} y={y} width={Math.max(w, 120)} height={Math.max(h, 40)}>
                        <textarea
                          ref={textInputRef}
                          className="w-full h-full bg-white/95 border border-violet-500 rounded shadow resize-none outline-none text-sm p-1"
                          style={{ fontSize: el.fontSize ?? 16, color: stroke }}
                          value={editValue}
                          onChange={e => setEditValue(e.target.value)}
                          onBlur={commitTextEdit}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault()
                              commitTextEdit()
                            }
                          }}
                        />
                      </foreignObject>
                    ) : (
                      <text
                        x={x} y={y + (el.fontSize ?? 16)}
                        fontSize={el.fontSize ?? 16}
                        fill={stroke}
                        fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
                      >
                        {(el.text || '').split('\n').map((line, i) => (
                          <tspan key={i} x={x} dy={i === 0 ? 0 : (el.fontSize ?? 16) * 1.3}>{line}</tspan>
                        ))}
                      </text>
                    )
                  )}
                  {(el.type === 'arrow' || el.type === 'line') && (
                    <g>
                      <line
                        x1={x} y1={y} x2={x + w} y2={y + h}
                        stroke={stroke} strokeWidth={sw}
                        strokeDasharray={el.strokeStyle === 'dashed' ? '8 4' : undefined}
                      />
                      {el.type === 'arrow' && (w !== 0 || h !== 0) && (
                        <polygon
                          points={(() => {
                            const angle = Math.atan2(h, w)
                            const ax = x + w, ay = y + h
                            const s = 10
                            return `${ax},${ay} ${ax - s * Math.cos(angle - 0.5)},${ay - s * Math.sin(angle - 0.5)} ${ax - s * Math.cos(angle + 0.5)},${ay - s * Math.sin(angle + 0.5)}`
                          })()}
                          fill={stroke}
                        />
                      )}
                    </g>
                  )}

                  {/* 选中框 */}
                  {isSelected && tool === 'select' && (
                    <g pointerEvents="none">
                      <rect
                        x={x - 2} y={y - 2} width={w + 4} height={h + 4}
                        fill="none" stroke="#a855f7" strokeWidth="1"
                        strokeDasharray="4 2"
                      />
                      {/* 8个手柄 */}
                      {[
                        [x, y], [x + w / 2, y], [x + w, y],
                        [x + w, y + h / 2], [x + w, y + h],
                        [x + w / 2, y + h], [x, y + h], [x, y + h / 2],
                      ].map(([hx, hy], i) => (
                        <rect
                          key={i}
                          x={hx - 4} y={hy - 4} width={8} height={8}
                          fill="#fff" stroke="#a855f7" strokeWidth="1"
                          style={{ pointerEvents: 'all', cursor: [
                            'nw-resize', 'n-resize', 'ne-resize',
                            'e-resize', 'se-resize', 's-resize',
                            'sw-resize', 'w-resize',
                          ][i] }}
                        />
                      ))}
                    </g>
                  )}
                </g>
              )
            })}
          </svg>
        </div>

        {/* 右侧属性面板 */}
        <div className="w-64 border-l bg-card shrink-0 flex flex-col overflow-y-auto">
          <div className="px-4 py-3 border-b">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">属性</h3>
          </div>

          {selectedElement ? (
            <div className="p-4 space-y-4">
              {/* 类型 */}
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">类型</label>
                <div className="text-sm font-medium capitalize">{selectedElement.type}</div>
              </div>

              {/* 文本内容 */}
              {selectedElement.type === 'text' && (
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">文本内容</label>
                  <textarea
                    className="w-full text-xs border rounded-md px-2 py-1.5 bg-background resize-none"
                    rows={3}
                    value={selectedElement.text || ''}
                    onChange={e => updateElement(selectedElement.id, { text: e.target.value })}
                  />
                </div>
              )}

              {/* 位置 */}
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">位置 & 大小</label>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground w-3">X</span>
                    <input
                      type="number"
                      className="w-full text-xs border rounded px-1.5 py-1 bg-background"
                      value={Math.round(selectedElement.x)}
                      onChange={e => updateElement(selectedElement.id, { x: Number(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground w-3">Y</span>
                    <input
                      type="number"
                      className="w-full text-xs border rounded px-1.5 py-1 bg-background"
                      value={Math.round(selectedElement.y)}
                      onChange={e => updateElement(selectedElement.id, { y: Number(e.target.value) })}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground w-3">W</span>
                    <input
                      type="number"
                      className="w-full text-xs border rounded px-1.5 py-1 bg-background"
                      value={Math.round(selectedElement.width)}
                      onChange={e => updateElement(selectedElement.id, { width: Math.max(10, Number(e.target.value)) })}
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[10px] text-muted-foreground w-3">H</span>
                    <input
                      type="number"
                      className="w-full text-xs border rounded px-1.5 py-1 bg-background"
                      value={Math.round(selectedElement.height)}
                      onChange={e => updateElement(selectedElement.id, { height: Math.max(10, Number(e.target.value)) })}
                    />
                  </div>
                </div>
              </div>

              {/* 字体大小 */}
              {selectedElement.type === 'text' && (
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">字体大小</label>
                  <input
                    type="number"
                    className="w-full text-xs border rounded px-2 py-1.5 bg-background"
                    value={selectedElement.fontSize ?? 16}
                    onChange={e => updateElement(selectedElement.id, { fontSize: Number(e.target.value) })}
                  />
                </div>
              )}

              {/* 描边颜色 */}
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">描边颜色</label>
                <div className="flex flex-wrap gap-1">
                  {DEFAULT_COLORS.map(c => (
                    <button
                      key={c}
                      className={`w-5 h-5 rounded border ${selectedElement.strokeColor === c ? 'ring-2 ring-violet-500' : ''}`}
                      style={{ backgroundColor: c }}
                      onClick={() => updateElement(selectedElement.id, { strokeColor: c })}
                    />
                  ))}
                </div>
              </div>

              {/* 背景颜色 */}
              {selectedElement.type !== 'arrow' && selectedElement.type !== 'line' && (
                <div className="space-y-1">
                  <label className="text-[11px] text-muted-foreground">背景颜色</label>
                  <div className="flex flex-wrap gap-1">
                    {DEFAULT_COLORS.map(c => (
                      <button
                        key={c}
                        className={`w-5 h-5 rounded border ${selectedElement.backgroundColor === c ? 'ring-2 ring-violet-500' : ''}`}
                        style={{ backgroundColor: c }}
                        onClick={() => updateElement(selectedElement.id, { backgroundColor: c })}
                      />
                    ))}
                    <button
                      className={`w-5 h-5 rounded border border-dashed flex items-center justify-center text-[8px] ${selectedElement.backgroundColor === 'transparent' ? 'ring-2 ring-violet-500' : ''}`}
                      onClick={() => updateElement(selectedElement.id, { backgroundColor: 'transparent' })}
                    >
                      <Minus className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              )}

              {/* 删除按钮 */}
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={() => {
                  setElements(prev => prev.filter(e => e.id !== selectedId))
                  setSelectedId(null)
                }}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                删除元素
              </Button>
            </div>
          ) : (
            <div className="p-4 text-xs text-muted-foreground text-center">
              选择一个元素以编辑属性
            </div>
          )}

          {/* 特性列表 */}
          {features.length > 0 && (
            <div className="mt-auto px-4 py-3 border-t">
              <label className="text-[11px] text-muted-foreground mb-2 block">功能特性</label>
              <div className="flex flex-wrap gap-1">
                {features.map((f, i) => (
                  <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-violet-500/10 text-violet-600 border border-violet-500/20">
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
