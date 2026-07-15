/**
 * 工作流可视化节点编辑器
 * 使用 @xyflow/react 提供拖拽式节点编排
 */
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import {
  ReactFlow,
  Controls,
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  addEdge,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  type OnConnect,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

import {
  Plus,
  Trash2,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Save,
  Braces,
  Eye,
  EyeOff,
  Play,
  GripVertical,
  Clock,
  Hand,
  Search,
  Wrench,
  Bot,
  Puzzle,
  Code2,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  Info,
  Terminal,
  Settings,
  ArrowLeft,
  X,
  Zap,
  Link2,
  FileUp,
  ImageIcon,
  Mic2,
  MessageSquare,
  UploadCloud,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { nodeTypes } from './WorkflowNode'
import {
  dslToFlow,
  flowToDsl,
  resetStepCounter,
  nextStepId,
  createStepNode,
  TRIGGER_NODE_ID_CONST,
} from './dslFlowConverter'
import type {
  TriggerNodeData,
  StepNodeData,
  AvailableTool,
  TriggerDef,
  StepDef,
  WorkflowDsl,
} from '@/lib/workflowTypes'
import { BUILTIN_TOOLS } from '@/lib/workflowTypes'
import { toolCodeApi, workflowArtifactApi } from '@/lib/api'

// ==================== Props ====================

interface WorkflowCanvasProps {
  /** 初始 DSL JSON 字符串 */
  initialDsl?: string
  /** DSL 变更回调 */
  onDslChange?: (dsl: string) => void
  /** 是否只读 */
  readOnly?: boolean
}

// ==================== 主组件 ====================

export default function WorkflowCanvas({
  initialDsl,
  onDslChange,
  readOnly = false,
}: WorkflowCanvasProps) {
  // --- 状态 ---
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [showDslPreview, setShowDslPreview] = useState(false)
  const [availableTools, setAvailableTools] = useState<AvailableTool[]>(() => {
    // 从 localStorage 恢复自定义工具
    try {
      const stored = localStorage.getItem('workflow_custom_tools')
      if (stored) {
        const customTools: AvailableTool[] = JSON.parse(stored)
        return [...BUILTIN_TOOLS, ...customTools]
      }
    } catch { /* ignore */ }
    return BUILTIN_TOOLS
  })
  const [toolSearch, setToolSearch] = useState('')
  const [showCustomTool, setShowCustomTool] = useState(false)
  const [customToolName, setCustomToolName] = useState('')
  const [customToolDesc, setCustomToolDesc] = useState('')
  const undoStackRef = useRef<string[]>([])
  const redoStackRef = useRef<string[]>([])
  const initializedRef = useRef(false)

  // --- 移动端检测 ---
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  // --- 移动端面板状态：none | tools | properties ---
  const [mobilePanel, setMobilePanel] = useState<'none' | 'tools' | 'properties'>('none')

  // --- 同步 selectedNodeId 与 mobilePanel ---
  useEffect(() => {
    if (isMobile && selectedNodeId && mobilePanel !== 'properties') {
      setMobilePanel('properties')
    }
  }, [selectedNodeId, isMobile, mobilePanel])

  // --- 初始化加载 DSL ---
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    if (initialDsl) {
      resetStepCounter()
      const { nodes: initNodes, edges: initEdges } = dslToFlow(initialDsl)
      setNodes(initNodes)
      setEdges(initEdges)
    }
  }, [initialDsl]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- 添加/删除节点后防抖同步 DSL（初始化后启用）---
  useEffect(() => {
    if (!initializedRef.current) return
    const timer = setTimeout(() => emitDsl(), 250)
    return () => clearTimeout(timer)
  }, [nodes, edges]) // eslint-disable-line react-hooks/exhaustive-deps

  // --- DSL 同步回调 ---
  // 使用 ref 避免闭包陷阱
  const nodesRef = useRef(nodes)
  const edgesRef = useRef(edges)
  nodesRef.current = nodes
  edgesRef.current = edges

  const emitDsl = useCallback(() => {
    const dsl = flowToDsl(nodesRef.current, edgesRef.current)
    // 保存到撤销栈
    undoStackRef.current.push(dsl)
    if (undoStackRef.current.length > 50) undoStackRef.current.shift()
    redoStackRef.current = []
    onDslChange?.(dsl)
  }, [onDslChange])

  // --- 连接处理 ---
  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return
      // 阻止自连接和重复连接
      if (connection.source === connection.target) return
      setEdges((eds) => {
        const exists = eds.some(
          (e) => e.source === connection.source && e.target === connection.target,
        )
        if (exists) return eds
        return addEdge(
          {
            ...connection,
            animated: true,
            style: { stroke: '#94a3b8', strokeWidth: 2 },
          },
          eds,
        )
      })
    },
    [readOnly, setEdges],
  )

  // --- 节点变化回调（拖动结束时自动同步 DSL）---
  const onNodesChangeWrapped = useCallback(
    (changes: NodeChange[]) => {
      onNodesChange(changes)
      // 拖动结束时（position 变化且 dragging=false），自动同步 DSL
      const dragEnded = changes.some(
        (c) => c.type === 'position' && c.dragging === false,
      )
      if (dragEnded) {
        // 延迟一帧确保 ReactFlow 内部状态已更新
        requestAnimationFrame(() => {
          emitDsl()
        })
      }
    },
    [onNodesChange, emitDsl],
  )

  const onEdgesChangeWrapped = useCallback(
    (changes: EdgeChange[]) => {
      onEdgesChange(changes)
    },
    [onEdgesChange],
  )

  // --- 添加步骤节点 ---
  const addStep = useCallback(
    (tool: AvailableTool) => {
      if (readOnly) return
      const id = nextStepId()
      const node = createStepNode(
        id,
        tool.name,
        tool.description,
        250 + Math.random() * 100,
        200 + nodes.filter((n) => n.type === 'step').length * 180 + Math.random() * 40,
      )
      if (tool.category === 'custom') {
        node.data = {
          ...node.data,
          language: 'python',
          timeoutSeconds: 60,
          permissions: [],
          inputSchema: { type: 'object', required: [] },
          outputSchema: { type: 'object', required: [] },
        }
      }
      setNodes((nds) => [...nds, node])
      setSelectedNodeId(id)
    },
    [readOnly, nodes, setNodes],
  )

  // --- 删除选中节点 ---
  const deleteSelected = useCallback(() => {
    if (readOnly || !selectedNodeId) return
    // 不删除触发器
    if (selectedNodeId === TRIGGER_NODE_ID_CONST) return
    setNodes((nds) => nds.filter((n) => n.id !== selectedNodeId))
    setEdges((eds) =>
      eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId),
    )
    setSelectedNodeId(null)
  }, [readOnly, selectedNodeId, setNodes, setEdges])

  // --- 键盘快捷键 ---
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (
          document.activeElement instanceof HTMLInputElement ||
          document.activeElement instanceof HTMLTextAreaElement
        )
          return
        deleteSelected()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [deleteSelected])

  // --- 选中节点 ---
  const selectedNode = useMemo(() => {
    if (!selectedNodeId) return null
    return nodes.find((n) => n.id === selectedNodeId) || null
  }, [selectedNodeId, nodes])

  // --- 自定义工具 ---
  const addCustomTool = useCallback(() => {
    const name = customToolName.trim()
    if (!name) return
    const exists = availableTools.find(
      (t) => t.name.toLowerCase() === name.toLowerCase(),
    )
    if (exists) {
      setCustomToolName('')
      setCustomToolDesc('')
      const id = nextStepId()
      const node = createStepNode(
        id, exists.name, exists.description, 250 + Math.random() * 100,
        200 + nodes.filter((n) => n.type === 'step').length * 180 + Math.random() * 40,
      )
      if (exists.category === 'custom') {
        node.data = {
          ...node.data,
          language: 'python',
          timeoutSeconds: 60,
          permissions: [],
          inputSchema: { type: 'object', required: [] },
          outputSchema: { type: 'object', required: [] },
        }
      }
      setNodes((nds) => [...nds, node])
      setSelectedNodeId(id)
      return
    }
    const newTool: AvailableTool = {
      name,
      label: customToolDesc.trim() || name,
      description: customToolDesc.trim() || `自定义工具：${name}`,
      category: 'custom',
    }
    const updated = [...availableTools, newTool]
    setAvailableTools(updated)
    // localStorage 持久化
    try {
      const customTools = updated.filter((t) => t.category === 'custom')
      localStorage.setItem('workflow_custom_tools', JSON.stringify(customTools))
    } catch { /* ignore */ }
    const id = nextStepId()
    const node = createStepNode(id, newTool.name, newTool.description, 250 + Math.random() * 100, 200 + nodes.filter((n) => n.type === 'step').length * 180 + Math.random() * 40)
    node.data = {
      ...node.data,
      language: 'python',
      timeoutSeconds: 60,
      permissions: [],
      inputSchema: { type: 'object', required: [] },
      outputSchema: { type: 'object', required: [] },
    }
    setNodes((nds) => [...nds, node])
    setSelectedNodeId(id)
    setCustomToolName('')
    setCustomToolDesc('')
  }, [customToolName, customToolDesc, nodes, availableTools, setNodes])
  const filteredTools = useMemo(() => {
    if (!toolSearch.trim()) return availableTools
    const q = toolSearch.toLowerCase()
    return availableTools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.label.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    )
  }, [availableTools, toolSearch])

  // ==================== 渲染 ====================

  return (
    <div className="flex h-full">
      {/* ===== 左侧工具面板 ===== */}
      {!readOnly && (
        <div className="hidden md:flex w-64 shrink-0 border-r bg-muted/30 flex flex-col h-full">
          <div className="p-3 border-b">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Puzzle className="w-4 h-4" />工具面板
            </h3>
            <div className="relative mt-2">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索工具..."
                value={toolSearch}
                onChange={(e) => setToolSearch(e.target.value)}
                className="pl-7 h-8 text-xs"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {filteredTools.map((tool) => (
              <ToolCard key={tool.name} tool={tool} onAdd={() => addStep(tool)} />
            ))}
            {filteredTools.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-8">
                没有找到匹配的工具
              </p>
            )}
          </div>

          <div className="p-2 border-t space-y-2">
            {showCustomTool ? (
              <div className="space-y-2 rounded-lg border-2 border-blue-300 dark:border-blue-600 bg-blue-50/70 dark:bg-blue-950/30 p-2.5">
                <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">创建自定义工具 — 输入名称和描述，添加到工具面板</p>
                <Input
                  placeholder="工具名称（英文）"
                  value={customToolName}
                  onChange={(e) => setCustomToolName(e.target.value)}
                  className="h-7 text-xs"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustomTool()
                    if (e.key === 'Escape') {
                      setShowCustomTool(false)
                      setCustomToolName('')
                      setCustomToolDesc('')
                    }
                  }}
                />
                <Input
                  placeholder="功能描述（可选）"
                  value={customToolDesc}
                  onChange={(e) => setCustomToolDesc(e.target.value)}
                  className="h-7 text-xs"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') addCustomTool()
                    if (e.key === 'Escape') {
                      setShowCustomTool(false)
                      setCustomToolName('')
                      setCustomToolDesc('')
                    }
                  }}
                />
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    className="flex-1 h-7 text-xs"
                    onClick={addCustomTool}
                    disabled={!customToolName.trim()}
                  >
                    <Plus className="w-3 h-3 mr-1" />添加
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => {
                      setShowCustomTool(false)
                      setCustomToolName('')
                      setCustomToolDesc('')
                    }}
                  >
                    取消
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full h-9 text-xs font-medium border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-blue-600 dark:text-blue-400"
                  onClick={() => setShowCustomTool(true)}
                >
                  <Plus className="w-3.5 h-3.5 mr-1.5" />添加自定义工具
                </Button>
                <p className="text-[10px] text-muted-foreground text-center">
                  自定义工具会<span className="text-blue-500 font-medium">自动保存</span>，刷新不丢失
                </p>
              </div>
            )}
            <p className="text-[10px] text-muted-foreground text-center">
              点击工具添加到画布，或创建自定义工具
            </p>
          </div>
        </div>
      )}

      {/* ===== 中间画布 ===== */}
      <div className="flex-1 relative min-w-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChangeWrapped}
          onEdgesChange={onEdgesChangeWrapped}
          onConnect={onConnect}
          onNodeClick={(_e, node) => setSelectedNodeId(node.id)}
          onPaneClick={() => setSelectedNodeId(null)}
          nodeTypes={nodeTypes}
          fitView
          snapToGrid
          snapGrid={[15, 15]}
          connectionLineStyle={{ stroke: '#94a3b8', strokeWidth: 2 }}
          defaultEdgeOptions={{
            animated: true,
            style: { stroke: '#94a3b8', strokeWidth: 2 },
          }}
          deleteKeyCode={readOnly ? null : ['Delete', 'Backspace']}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable={!readOnly}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
          <Controls
            showInteractive={!readOnly}
            className="!bg-white dark:!bg-slate-800 !border !rounded-lg !shadow-sm"
          />
          <MiniMap
            nodeColor={(n) => {
              if (n.type === 'trigger') return '#f59e0b'
              if (n.type === 'step') return '#6366f1'
              return '#94a3b8'
            }}
            className="!bg-white dark:!bg-slate-800 !border !rounded-lg !shadow-sm"
          />

          {/* 顶部工具栏 */}
          <Panel position="top-center" className="flex items-center gap-1.5">
            <div className="flex items-center gap-1 bg-white dark:bg-slate-800 border rounded-lg shadow-sm px-2 py-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => setShowDslPreview(!showDslPreview)}
              >
                {showDslPreview ? (
                  <EyeOff className="w-3.5 h-3.5 mr-1" />
                ) : (
                  <Braces className="w-3.5 h-3.5 mr-1" />
                )}
                {showDslPreview ? '隐藏 DSL' : '预览 DSL'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={emitDsl}
              >
                <Save className="w-3.5 h-3.5 mr-1" />
                同步 DSL
              </Button>
              {/* 移动端：工具面板快捷按钮 */}
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs md:hidden"
                onClick={() => setMobilePanel(mobilePanel === 'tools' ? 'none' : 'tools')}
              >
                <Puzzle className="w-3.5 h-3.5 mr-1" />
                工具
              </Button>
              {!readOnly && (
                <>
                  <div className="w-px h-4 bg-border mx-1" />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-red-500 hover:text-red-600"
                    onClick={deleteSelected}
                    disabled={!selectedNodeId || selectedNodeId === TRIGGER_NODE_ID_CONST}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1" />
                    删除节点
                  </Button>
                </>
              )}
            </div>
          </Panel>
        </ReactFlow>

        {/* DSL 预览浮层 */}
        {showDslPreview && (
          <DslPreviewOverlay
            nodes={nodes}
            edges={edges}
            onClose={() => setShowDslPreview(false)}
          />
        )}
      </div>

      {/* ===== 右侧属性编辑面板 ===== */}
      {!readOnly && (
        <div className="hidden md:flex w-72 shrink-0 border-l bg-muted/30 flex flex-col h-full">
          <div className="p-3 border-b">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Wrench className="w-4 h-4" />属性编辑
            </h3>
          </div>

          <div className="flex-1 overflow-y-auto">
            {selectedNode ? (
              <NodePropertyEditor
                node={selectedNode}
                onChange={(updatedNode) => {
                  setNodes((nds) =>
                    nds.map((n) => (n.id === updatedNode.id ? updatedNode : n)),
                  )
                }}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
                <GripVertical className="w-8 h-8 opacity-30" />
                <p className="text-xs text-center">点击画布上的节点<br />编辑其属性</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ===== 移动端：工具面板覆盖层 ===== */}
      {isMobile && mobilePanel === 'tools' && (
        <MobileToolsPanel
          availableTools={availableTools}
          toolSearch={toolSearch}
          setToolSearch={setToolSearch}
          filteredTools={filteredTools}
          onAddTool={addStep}
          onClose={() => setMobilePanel('none')}
          customToolName={customToolName}
          setCustomToolName={setCustomToolName}
          customToolDesc={customToolDesc}
          setCustomToolDesc={setCustomToolDesc}
          showCustomTool={showCustomTool}
          setShowCustomTool={setShowCustomTool}
          addCustomTool={addCustomTool}
        />
      )}

      {/* ===== 移动端：属性编辑覆盖层 ===== */}
      {isMobile && mobilePanel === 'properties' && selectedNode && (
        <MobilePropertyPanel
          node={selectedNode}
          onChange={(updatedNode) => {
            setNodes((nds) =>
              nds.map((n) => (n.id === updatedNode.id ? updatedNode : n)),
            )
          }}
          onClose={() => { setMobilePanel('none'); setSelectedNodeId(null) }}
          onDelete={deleteSelected}
          canDelete={selectedNode.id !== TRIGGER_NODE_ID_CONST}
        />
      )}
    </div>
  )
}

// ==================== 工具卡片（左侧面板） ====================

function ToolCard({ tool, onAdd }: { tool: AvailableTool; onAdd: () => void }) {
  const iconByName: Record<string, JSX.Element> = {
    ai_chat: <MessageSquare className="w-3.5 h-3.5" />,
    web_search: <Search className="w-3.5 h-3.5" />,
    file_upload: <FileUp className="w-3.5 h-3.5" />,
    image_recognition: <ImageIcon className="w-3.5 h-3.5" />,
    audio_transcribe: <Mic2 className="w-3.5 h-3.5" />,
    document_chunk_process: <Braces className="w-3.5 h-3.5" />,
  }
  const icon = iconByName[tool.name] || {
    builtin: <Wrench className="w-3.5 h-3.5" />,
    agent: <Bot className="w-3.5 h-3.5" />,
    custom: <Puzzle className="w-3.5 h-3.5" />,
  }[tool.category]

  const colorMap = {
    builtin: 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30',
    agent: 'border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30',
    custom: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30',
  }

  return (
    <button
      onClick={onAdd}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/tool', tool.name)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      className={cn(
        'w-full p-2.5 rounded-lg border text-left transition-all hover:shadow-sm active:scale-[0.98] group',
        colorMap[tool.category] || colorMap.builtin,
      )}
    >
      <div className="flex items-start gap-2">
        <div className="shrink-0 mt-0.5 text-muted-foreground">{icon}</div>
        <div className="min-w-0">
          <div className="text-xs font-medium truncate">{tool.label}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2">
            {tool.description}
          </div>
          <Badge variant="outline" className="mt-1 text-[9px] px-1 py-0 h-4">
            {tool.name}
          </Badge>
        </div>
      </div>
    </button>
  )
}

// ==================== DSL 预览浮层 ====================

function DslPreviewOverlay({
  nodes,
  edges,
  onClose,
}: {
  nodes: Node[]
  edges: Edge[]
  onClose: () => void
}) {
  const dsl = useMemo(() => flowToDsl(nodes, edges), [nodes, edges])

  return (
    <div className="absolute right-4 top-16 w-96 max-h-[70vh] bg-white dark:bg-slate-900 border rounded-xl shadow-lg z-20 flex flex-col">
      <div className="flex items-center justify-between p-3 border-b">
        <div className="flex items-center gap-1.5">
          <Braces className="w-4 h-4 text-purple-500" />
          <h4 className="text-sm font-semibold">DSL 预览</h4>
        </div>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
          <EyeOff className="w-3.5 h-3.5" />
        </Button>
      </div>
      <pre className="flex-1 overflow-auto p-3 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
        {dsl}
      </pre>
      <div className="p-2 border-t">
        <Button
          size="sm"
          className="w-full text-xs h-7"
          onClick={() => {
            navigator.clipboard.writeText(dsl)
          }}
        >
          复制 DSL
        </Button>
      </div>
    </div>
  )
}

// ==================== 节点属性编辑器（右侧面板） ====================

function NodePropertyEditor({
  node,
  onChange,
}: {
  node: Node
  onChange: (node: Node) => void
}) {
  // --- 触发器编辑器 ---
  if (node.type === 'trigger') {
    return <TriggerEditor node={node} onChange={onChange} />
  }

  // --- 步骤编辑器 ---
  if (node.type === 'step') {
    // key={node.id} 强制切换节点时重新挂载组件，确保 useState（argsText 等）重新初始化
    return <StepEditor key={node.id} node={node as Node<StepNodeData>} onChange={onChange} />
  }

  return null
}

function TriggerEditor({
  node,
  onChange,
}: {
  node: Node
  onChange: (node: Node) => void
}) {
  const data = node.data as TriggerNodeData
  const aiPolicy = data.aiPolicy || {}
  const policyMaxTurns = typeof aiPolicy.maxTurns === 'number' ? aiPolicy.maxTurns : 12
  const updateAiPolicy = (patch: NonNullable<TriggerNodeData['aiPolicy']>) => {
    onChange({
      ...node,
      data: {
        ...data,
        aiPolicy: {
          ...aiPolicy,
          ...patch,
        },
      },
    })
  }

  return (
    <div className="p-3 space-y-4">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-amber-500" />
        <h4 className="text-sm font-semibold">触发器设置</h4>
      </div>

      {/* 触发类型 */}
      <div>
        <label className="text-xs font-medium text-muted-foreground">触发类型</label>
        <div className="flex gap-1 mt-1">
          {(['cron', 'manual'] as const).map((type) => (
            <button
              key={type}
              onClick={() => {
                onChange({
                  ...node,
                  data: {
                    ...data,
                    triggerType: type,
                    label: type === 'cron' ? '定时触发器' : '手动触发器',
                    cronExpr: type === 'cron' ? data.cronExpr || '' : undefined,
                  },
                })
              }}
              className={cn(
                'flex-1 py-1.5 px-2 rounded-md text-xs font-medium transition-colors border',
                data.triggerType === type
                  ? 'border-amber-400 bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300'
                  : 'border-border hover:bg-muted',
              )}
            >
              {type === 'cron' ? (
                <span className="flex items-center justify-center gap-1">
                  <Clock className="w-3 h-3" />定时
                </span>
              ) : (
                <span className="flex items-center justify-center gap-1">
                  <Hand className="w-3 h-3" />手动
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 数据传递模式 */}
      <div>
        <label className="text-xs font-medium text-muted-foreground flex items-center gap-1">
          <Sparkles className="w-3 h-3 text-purple-500" />
          步骤间数据传递
        </label>
        <div className="mt-1.5 space-y-1.5">
          {([
            { value: 'auto', label: '自动注入', desc: '前步输出自动填充到 body/content 等参数', icon: <Zap className="w-3.5 h-3.5" /> },
            { value: 'template', label: '模板变量', desc: '使用 ${steps.stepId.output} 手动引用', icon: <Link2 className="w-3.5 h-3.5" /> },
            { value: 'ai', label: 'AI 编排', desc: '由 AI 智能判断步骤间数据传递', icon: <Bot className="w-3.5 h-3.5" /> },
          ] as const).map((mode) => (
            <button
              key={mode.value}
              onClick={() => {
                onChange({
                  ...node,
                  data: { ...data, dataMode: mode.value },
                })
              }}
              className={cn(
                'w-full p-2.5 rounded-lg border text-left transition-all',
                (data.dataMode || 'auto') === mode.value
                  ? 'border-purple-400 bg-purple-50 dark:bg-purple-900/30 ring-1 ring-purple-300'
                  : 'border-border hover:bg-muted',
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn(
                  (data.dataMode || 'auto') === mode.value
                    ? 'text-purple-500'
                    : 'text-muted-foreground'
                )}>{mode.icon}</span>
                <span className={cn(
                  'text-xs font-medium',
                  (data.dataMode || 'auto') === mode.value
                    ? 'text-purple-700 dark:text-purple-300'
                    : 'text-foreground',
                )}>
                  {mode.label}
                </span>
                {(data.dataMode || 'auto') === mode.value && (
                  <CheckCircle2 className="w-3.5 h-3.5 text-purple-500 ml-auto" />
                )}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1 ml-6">{mode.desc}</p>
            </button>
          ))}
        </div>
        {/* 模板变量提示 */}
        {(data.dataMode || 'auto') === 'template' && (
          <div className="mt-2 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-2.5 space-y-1.5">
            <p className="text-[10px] text-blue-700 dark:text-blue-300 font-medium flex items-center gap-1">
              <Info className="w-3 h-3" />
              可用模板变量
            </p>
            <div className="space-y-1">
              <div className="text-[10px]">
                <code className="font-mono text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">{'${previous_output}'}</code>
                <span className="text-muted-foreground ml-1.5">引用上一个步骤的完整输出</span>
              </div>
              <div className="text-[10px]">
                <code className="font-mono text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">{'${steps.stepId.output}'}</code>
                <span className="text-muted-foreground ml-1.5">引用指定步骤的输出</span>
              </div>
              <div className="text-[10px]">
                <code className="font-mono text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">{'${steps.stepId.field}'}</code>
                <span className="text-muted-foreground ml-1.5">引用指定步骤输出中的字段</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground pt-1 border-t border-blue-200 dark:border-blue-800">
              在步骤参数值中使用上述变量，执行时自动替换
            </p>
          </div>
        )}
        {/* AI 编排提示 */}
        {(data.dataMode || 'auto') === 'ai' && (
          <div className="mt-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-2.5">
            <p className="text-[10px] text-amber-700 dark:text-amber-300 flex items-start gap-1">
              <Info className="w-3 h-3 shrink-0 mt-0.5" />
              <span>AI 将分析前序步骤的输出内容，智能判断如何将数据传递到当前步骤的参数中。AI 失败时自动降级为自动注入模式。</span>
            </p>
          </div>
        )}
        {/* 自动注入提示 */}
        {(data.dataMode || 'auto') === 'ai' && (
          <div className="mt-2 rounded-lg border border-border bg-muted/30 p-2.5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium">AI 执行策略</span>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">默认禁止重复步骤，失败即停止</p>
              </div>
              <Badge variant="outline" className="shrink-0 rounded-md text-[10px]">
                {aiPolicy.maxTurns ? `${aiPolicy.maxTurns} 轮` : '自动'}
              </Badge>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label className="text-[11px] text-muted-foreground">最大决策轮次</label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={policyMaxTurns}
                  onChange={(e) => {
                    const next = Math.max(1, Math.min(50, Number(e.target.value) || 1))
                    updateAiPolicy({ maxTurns: next })
                  }}
                  className="h-7 w-16 px-2 text-xs"
                />
              </div>
              <Slider
                min={1}
                max={50}
                step={1}
                value={[policyMaxTurns]}
                onValueChange={([next]) => updateAiPolicy({ maxTurns: next })}
                className="py-1"
              />
            </div>

            <div className="grid gap-2">
              <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-2.5 py-2">
                <span className="text-[11px] text-foreground">允许重复执行步骤</span>
                <Switch
                  checked={Boolean(aiPolicy.allowRepeatSteps)}
                  onCheckedChange={(checked) => updateAiPolicy({ allowRepeatSteps: checked })}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-2.5 py-2">
                <span className="text-[11px] text-foreground">步骤失败后继续</span>
                <Switch
                  checked={Boolean(aiPolicy.continueOnStepFailure)}
                  onCheckedChange={(checked) => updateAiPolicy({ continueOnStepFailure: checked })}
                />
              </label>
            </div>
          </div>
        )}
        {(data.dataMode || 'auto') === 'auto' && (
          <div className="mt-2 rounded-lg border border-green-200 dark:border-green-800 bg-green-50/50 dark:bg-green-950/20 p-2.5">
            <p className="text-[10px] text-green-700 dark:text-green-300 flex items-start gap-1">
              <Info className="w-3 h-3 shrink-0 mt-0.5" />
              <span>系统自动检测 body/content/message/text 等常见参数名，将前一步骤的输出注入。也支持在参数值中使用模板变量。</span>
            </p>
          </div>
        )}
      </div>

      {/* Cron 表达式 */}
      {data.triggerType === 'cron' && (
        <div>
          <label className="text-xs font-medium text-muted-foreground">
            Cron 表达式
          </label>
          <Input
            value={data.cronExpr || ''}
            onChange={(e) => {
              onChange({
                ...node,
                data: { ...data, cronExpr: e.target.value },
              })
            }}
            placeholder="* * * * * (每分钟) 或 0 8 * * * (每天8点)"
            className="mt-1 h-8 text-xs font-mono"
          />
          <div className="mt-1.5 space-y-0.5">
            <p className="text-[10px] text-muted-foreground">
              格式：分 时 日 月 周（5 段），系统自动兼容 6 段格式
            </p>
            {[
              { expr: '* * * * *', desc: '每分钟' },
              { expr: '0 8 * * *', desc: '每天早上 8:00' },
              { expr: '0 */2 * * *', desc: '每 2 小时' },
              { expr: '0 0 * * 1', desc: '每周一 0:00' },
              { expr: '0 0 1 * *', desc: '每月 1 号 0:00' },
            ].map((item) => (
              <button
                key={item.expr}
                onClick={() => {
                  onChange({
                    ...node,
                    data: { ...data, cronExpr: item.expr },
                  })
                }}
                className="block w-full text-left text-[10px] px-2 py-1 rounded hover:bg-muted transition-colors"
              >
                <code className="font-mono text-amber-600">{item.expr}</code>
                <span className="ml-2 text-muted-foreground">{item.desc}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {data.triggerType === 'manual' && (
        <p className="text-xs text-muted-foreground">
          手动触发模式，需通过 API 或按钮启动执行
        </p>
      )}
    </div>
  )
}

/**
 * 从生成的工具代码中提取参数名，生成示例 JSON
 * 支持 Python: args.get("xxx"), args["xxx"], args['xxx']
 * 支持 JS:    args.xxx, args["xxx"], args['xxx']
 */
function inferArgsSample(code: string): Record<string, string> {
  const params: string[] = []
  const patterns = [
    /args\.get\s*\(\s*["'](\w+)["']/g,   // args.get("email")
    /args\s*\[\s*["'](\w+)["']\s*\]/g,    // args["email"]
    /args\s*\.\s*(\w+)/g,                  // args.email
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      if (!params.includes(m[1])) params.push(m[1])
    }
  }

  const sample: Record<string, string> = {}
  for (const p of params) {
    const info = inferParamInfo(p)
    sample[p] = info.sample
  }
  return sample
}

/** 参数说明：名称 + 含义 + 示例值 */
interface ParamGuide {
  name: string
  label: string     // 中文含义
  sample: string    // 示例值
}

/** 根据参数名推断含义和示例值 */
function inferParamInfo(paramName: string): { label: string; sample: string } {
  const low = paramName.toLowerCase()
  // 按优先级排序，确保更精确的匹配优先
  if (low.includes('email') || low === 'mail')
    return { label: '邮箱地址', sample: 'user@example.com' }
  if (low.includes('phone') || low.includes('mobile') || low.includes('tel'))
    return { label: '手机号码', sample: '13800138000' }
  if (low.includes('password') || low.includes('passwd') || low.includes('pwd'))
    return { label: '密码', sample: '******' }
  if (low.includes('token') || low.includes('api_key') || low.includes('apikey'))
    return { label: 'API 密钥/Token', sample: 'sk-xxxxx' }
  if (low.includes('key'))
    return { label: '密钥/Key', sample: 'sk-xxxxx' }
  if (low.includes('secret'))
    return { label: '密钥/Secret', sample: '******' }
  if (low.includes('url') || low.includes('link') || low.includes('href'))
    return { label: 'URL 地址', sample: 'https://example.com' }
  if (low.includes('name') || low === 'username')
    return { label: '姓名/用户名', sample: '张三' }
  if (low.includes('id') || low.includes('uid'))
    return { label: 'ID 编号', sample: '12345' }
  if (low.includes('age'))
    return { label: '年龄', sample: '25' }
  if (low.includes('date') || low.includes('time'))
    return { label: '日期/时间', sample: '2026-01-01' }
  if (low.includes('price') || low.includes('amount') || low.includes('money'))
    return { label: '金额', sample: '99.00' }
  if (low.includes('status') || low.includes('state'))
    return { label: '状态', sample: 'active' }
  if (low.includes('text') || low.includes('content') || low.includes('message') || low.includes('msg'))
    return { label: '文本内容', sample: '示例文本内容' }
  if (low.includes('subject') || low.includes('title'))
    return { label: '主题/标题', sample: '示例标题' }
  if (low.includes('type') || low.includes('category'))
    return { label: '类型/分类', sample: 'general' }
  if (low.includes('code'))
    return { label: '状态码', sample: '200' }
  if (low.includes('ip'))
    return { label: 'IP 地址', sample: '192.168.1.1' }
  if (low.includes('port'))
    return { label: '端口号', sample: '8080' }
  if (low.includes('path') || low.includes('file'))
    return { label: '文件路径', sample: '/path/to/file' }
  if (low.includes('limit') || low.includes('size') || low.includes('count') || low.includes('num') || low.includes('number'))
    return { label: '数量/限制', sample: '10' }
  if (low.includes('page'))
    return { label: '页码', sample: '1' }
  if (low.includes('lang') || low.includes('language'))
    return { label: '语言代码', sample: 'zh-CN' }
  if (low.includes('color') || low.includes('colour'))
    return { label: '颜色值', sample: '#336699' }
  if (low.includes('enable') || low.includes('disable') || low.includes('flag') || low.includes('bool') || low.includes('enabled'))
    return { label: '开关（true/false）', sample: 'true' }
  return { label: `${paramName} 的值`, sample: `[请填写]` }
}

/** 从代码中提取所有参数及其说明 */
function getParamGuide(code: string): ParamGuide[] {
  const params: string[] = []
  const patterns = [
    /args\.get\s*\(\s*["'](\w+)["']/g,
    /args\s*\[\s*["'](\w+)["']\s*\]/g,
    /args\s*\.\s*(\w+)/g,
  ]
  for (const re of patterns) {
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) {
      if (!params.includes(m[1])) params.push(m[1])
    }
  }
  return params.map((name) => {
    const info = inferParamInfo(name)
    return { name, label: info.label, sample: info.sample }
  })
}

function getNativeFileToolConfig(tool: string) {
  if (tool === 'file_upload') {
    return {
      title: '文件资产',
      description: '上传后会自动写入 artifactUuid，后续节点可引用该资产。',
      accept: undefined,
      sourceType: 'workflow_node_file',
      icon: <FileUp className="w-3.5 h-3.5" />,
    }
  }
  if (tool === 'image_recognition') {
    return {
      title: '图片输入',
      description: '上传图片后可在 prompt 中描述识别目标。',
      accept: 'image/*',
      sourceType: 'workflow_node_image',
      icon: <ImageIcon className="w-3.5 h-3.5" />,
    }
  }
  if (tool === 'audio_transcribe') {
    return {
      title: '音频输入',
      description: '上传音频后会使用 ASR 渠道转写为文本。',
      accept: 'audio/*',
      sourceType: 'workflow_node_audio',
      icon: <Mic2 className="w-3.5 h-3.5" />,
    }
  }
  if (tool === 'document_chunk_process') {
    return {
      title: '大文档输入',
      description: '上传 txt、md、json、csv 等文本类文档后，执行时会分段送入模型处理。',
      accept: '.txt,.md,.json,.jsonl,.csv,.tsv,.log,text/*,application/json',
      sourceType: 'workflow_node_document',
      icon: <Braces className="w-3.5 h-3.5" />,
    }
  }
  return null
}

const CUSTOM_TOOL_PERMISSIONS = [
  { key: 'network', label: '网络访问', desc: '允许 HTTP/API 请求' },
  { key: 'filesystem_read', label: '读取文件', desc: '允许读取临时目录文件' },
  { key: 'filesystem_write', label: '写入文件', desc: '允许写入或删除临时目录文件' },
  { key: 'process', label: '进程调用', desc: '允许调用子进程' },
] as const

const STEP_SIDE_EFFECT_OPTIONS = [
  { value: 'none', label: '无副作用', desc: '纯计算或格式转换' },
  { value: 'read', label: '读取', desc: '查询数据或读取文件' },
  { value: 'write', label: '写入', desc: '保存文件或更新数据' },
  { value: 'external_call', label: '外部调用', desc: '调用第三方 API' },
  { value: 'notification', label: '通知', desc: '发送消息、邮件或提醒' },
  { value: 'payment', label: '支付', desc: '支付、退款或资金动作' },
] as const

type ArtifactUploadStatus = {
  fileName: string
  uploadedBytes: number
  totalBytes: number
  partNumber?: number
  totalParts?: number
  uploadId?: string
  state: 'idle' | 'uploading' | 'paused' | 'failed' | 'completed'
}

function formatUploadBytes(size?: number) {
  if (!size || Number.isNaN(size)) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`
}

function StepEditor({
  node,
  onChange,
}: {
  node: Node<StepNodeData>
  onChange: (node: Node) => void
}) {
  const data = node.data
  const [activeTab, setActiveTab] = useState<'props' | 'code'>('props')
  const nativeFileTool = getNativeFileToolConfig(data.tool)
  const artifactInputRef = useRef<HTMLInputElement>(null)
  const artifactAbortRef = useRef<AbortController | null>(null)
  const lastArtifactFileRef = useRef<File | null>(null)
  const [uploadingArtifact, setUploadingArtifact] = useState(false)
  const [artifactUploadError, setArtifactUploadError] = useState('')
  const [artifactUploadStatus, setArtifactUploadStatus] = useState<ArtifactUploadStatus | null>(null)

  // --- 属性 Tab ---
  const [argsText, setArgsText] = useState(
    data.args && Object.keys(data.args).length > 0
      ? JSON.stringify(data.args, null, 2)
      : '{}',
  )
  const [argsError, setArgsError] = useState('')
  const [inputSchemaText, setInputSchemaText] = useState(
    data.inputSchema && Object.keys(data.inputSchema).length > 0
      ? JSON.stringify(data.inputSchema, null, 2)
      : '{\n  "type": "object",\n  "required": []\n}',
  )
  const [outputSchemaText, setOutputSchemaText] = useState(
    data.outputSchema && Object.keys(data.outputSchema).length > 0
      ? JSON.stringify(data.outputSchema, null, 2)
      : '{\n  "type": "object",\n  "required": []\n}',
  )
  const [inputSchemaError, setInputSchemaError] = useState('')
  const [outputSchemaError, setOutputSchemaError] = useState('')

  const handleArgsBlur = useCallback(() => {
    try {
      const parsed = JSON.parse(argsText)
      setArgsError('')
      onChange({
        ...node,
        data: { ...data, args: parsed },
      })
    } catch {
      setArgsError('JSON 格式无效')
    }
  }, [argsText, node, data, onChange])

  const handleSchemaBlur = useCallback((kind: 'input' | 'output') => {
    const text = kind === 'input' ? inputSchemaText : outputSchemaText
    const setError = kind === 'input' ? setInputSchemaError : setOutputSchemaError
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('schema 必须是 JSON 对象')
      }
      setError('')
      onChange({
        ...node,
        data: {
          ...data,
          [kind === 'input' ? 'inputSchema' : 'outputSchema']: parsed,
        },
      })
    } catch (e: any) {
      setError(e?.message || 'JSON 格式无效')
    }
  }, [data, inputSchemaText, node, onChange, outputSchemaText])

  const togglePermission = useCallback((permission: string) => {
    const current = Array.isArray(data.permissions) ? data.permissions : []
    const next = current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]
    onChange({
      ...node,
      data: { ...data, permissions: next },
    })
  }, [data, node, onChange])

  const handleArtifactUpload = useCallback(async (file?: File, resumeUploadId?: string) => {
    if (!file || !nativeFileTool) return
    lastArtifactFileRef.current = file
    const controller = new AbortController()
    artifactAbortRef.current = controller
    setUploadingArtifact(true)
    setArtifactUploadError('')
    setArtifactUploadStatus({
      fileName: file.name,
      uploadedBytes: resumeUploadId ? (artifactUploadStatus?.uploadedBytes || 0) : 0,
      totalBytes: file.size,
      uploadId: resumeUploadId,
      state: 'uploading',
      totalParts: artifactUploadStatus?.totalParts,
    })
    try {
      const artifact = await workflowArtifactApi.upload(file, {
        uploadId: resumeUploadId,
        signal: controller.signal,
        sourceType: nativeFileTool.sourceType,
        metadataJson: JSON.stringify({
          nodeId: data.stepId,
          tool: data.tool,
        }),
        onSession: (session) => {
          setArtifactUploadStatus((prev) => ({
            fileName: file.name,
            uploadedBytes: prev?.uploadedBytes || 0,
            totalBytes: file.size,
            uploadId: session.uploadId,
            state: 'uploading',
            totalParts: session.totalParts,
          }))
        },
        onProgress: (progress) => {
          setArtifactUploadStatus((prev) => ({
            fileName: file.name,
            uploadedBytes: progress.uploadedBytes,
            totalBytes: progress.totalBytes,
            partNumber: progress.partNumber,
            totalParts: progress.totalParts || prev?.totalParts,
            uploadId: prev?.uploadId || resumeUploadId,
            state: 'uploading',
          }))
        },
      })
      const nextArgs: Record<string, unknown> = {
        ...(data.args || {}),
        artifactUuid: artifact.uuid,
        fileName: artifact.fileName,
        fileType: artifact.fileType,
        mimeType: artifact.mimeType,
      }
      if (data.tool === 'image_recognition' && !nextArgs.prompt) {
        nextArgs.prompt = '请识别图片中的主要内容，提取关键文字，并输出结构化摘要。'
      }
      if (data.tool === 'document_chunk_process' && !nextArgs.task) {
        nextArgs.task = '总结文档内容，提取关键事实、风险、决策和待办事项。'
      }
      const nextText = JSON.stringify(nextArgs, null, 2)
      setArgsText(nextText)
      onChange({
        ...node,
        data: { ...data, args: nextArgs },
      })
      setArtifactUploadStatus((prev) => prev ? {
        ...prev,
        uploadedBytes: file.size,
        totalBytes: file.size,
        state: 'completed',
      } : null)
    } catch (e: any) {
      if (e?.name === 'AbortError') {
        setArtifactUploadStatus((prev) => prev ? { ...prev, state: 'paused' } : null)
        setArtifactUploadError('')
      } else {
        setArtifactUploadStatus((prev) => prev ? { ...prev, state: 'failed' } : null)
        setArtifactUploadError(e?.message || '上传失败')
      }
    } finally {
      setUploadingArtifact(false)
      artifactAbortRef.current = null
      if (artifactInputRef.current) artifactInputRef.current.value = ''
    }
  }, [artifactUploadStatus?.totalParts, artifactUploadStatus?.uploadedBytes, data, nativeFileTool, node, onChange])

  const pauseArtifactUpload = useCallback(() => {
    artifactAbortRef.current?.abort()
  }, [])

  const retryArtifactUpload = useCallback(() => {
    const file = lastArtifactFileRef.current
    if (!file) return
    handleArtifactUpload(file, artifactUploadStatus?.uploadId)
  }, [artifactUploadStatus?.uploadId, handleArtifactUpload])

  // --- 代码 Tab ---
  const [language, setLanguage] = useState<'python' | 'javascript'>(
    (data.language as 'python' | 'javascript') || 'python',
  )
  const [generatingCode, setGeneratingCode] = useState(false)
  const [testingCode, setTestingCode] = useState(false)
  const [testResult, setTestResult] = useState<{
    success: boolean
    output?: unknown
    error?: string
    elapsedMs?: number
  } | null>(null)

  const refinePanelRef = useRef<HTMLDivElement>(null)

  const handleAiGenerate = useCallback(() => {
    setGeneratingCode(true)
    setTestResult(null)
    setRefineInstruction('')
    toolCodeApi.generateCode(
      data.tool,
      data.description || `工具：${data.tool}`,
      language,
      (code) => {
        // onToken: 流式写入
        onChange({
          ...node,
          data: { ...data, code, language },
        })
      },
      (code) => {
        // onDone
        // 如果参数为空，自动从代码中推断示例参数
        const hasEmptyArgs = !data.args || Object.keys(data.args).length === 0
        const newArgs = hasEmptyArgs ? inferArgsSample(code) : data.args
        onChange({
          ...node,
          data: { ...data, code, args: newArgs, condition: data.condition, language },
        })
        setGeneratingCode(false)
        // 始终同步 argsText，确保参数 UI 与 data.args 一致
        setArgsText(JSON.stringify(newArgs, null, 2))
        // 生成完成后自动滚动到微调面板
        setTimeout(() => {
          refinePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 200)
      },
      (error) => {
        setGeneratingCode(false)
        alert('AI 生成失败: ' + error)
      },
    )
  }, [data, language, node, onChange])

  // --- 对话式微调 ---
  const [refineInstruction, setRefineInstruction] = useState('')
  const [refining, setRefining] = useState(false)

  const handleRefine = useCallback(() => {
    if (!refineInstruction.trim()) {
      alert('请输入代码修改意见')
      return
    }
    if (!data.code?.trim()) {
      alert('请先生成或编写代码，再进行微调')
      return
    }
    setRefining(true)
    setTestResult(null)
    toolCodeApi.generateCode(
      data.tool,
      data.description || `工具：${data.tool}`,
      language,
      (code) => {
        onChange({ ...node, data: { ...data, code, language } })
      },
      (code) => {
        onChange({ ...node, data: { ...data, code, condition: data.condition, language } })
        setRefining(false)
        setRefineInstruction('')
        // 同步 argsText，确保参数 UI 与 data.args 一致
        setArgsText(JSON.stringify(data.args || {}, null, 2))
      },
      (error) => {
        setRefining(false)
        alert('AI 微调失败: ' + error)
      },
      data.code,
      refineInstruction,
    )
  }, [data, language, node, onChange, refineInstruction])

  const handleTest = useCallback(async () => {
    if (!data.code?.trim()) {
      alert('请先编写或生成代码')
      return
    }
    setTestingCode(true)
    setTestResult(null)
    try {
      // ★ 修复：从 argsText 实时解析参数，而非依赖 data.args（后者仅在 onBlur 时同步）
      let currentArgs: Record<string, unknown> | undefined
      try {
        const parsed = JSON.parse(argsText)
        setArgsError('')
        currentArgs = parsed
        // 同步到 data.args，确保后续操作使用最新值
        onChange({
          ...node,
          data: { ...data, args: parsed },
        })
      } catch {
        setArgsError('JSON 格式无效，请修正参数后再测试')
        setTestingCode(false)
        return
      }
      const res = await toolCodeApi.testCode(data.code, language, currentArgs, {
        timeoutSeconds: typeof data.timeoutSeconds === 'number' ? data.timeoutSeconds : 60,
        permissions: Array.isArray(data.permissions) ? data.permissions : [],
      })
      setTestResult({
        success: res.success,
        output: res.output,
        error: res.error,
        elapsedMs: res.elapsedMs,
      })
    } catch (e: any) {
      setTestResult({ success: false, error: e.message || '测试请求失败' })
    } finally {
      setTestingCode(false)
    }
  }, [data.code, data, language, node, onChange, argsText])

  return (
    <div className="p-0 flex flex-col h-full">
      {/* Tab 切换 */}
      <div className="flex border-b shrink-0">
        <button
          onClick={() => setActiveTab('props')}
          className={cn(
            'flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'props'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Settings className="w-3.5 h-3.5 inline mr-1" />
          属性
        </button>
        <button
          onClick={() => setActiveTab('code')}
          className={cn(
            'flex-1 py-2.5 text-xs font-medium transition-colors border-b-2 -mb-px',
            activeTab === 'code'
              ? 'border-purple-500 text-purple-600 dark:text-purple-400'
              : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <Code2 className="w-3.5 h-3.5 inline mr-1" />
          代码
          {data.code?.trim() && (
            <span className="ml-1 w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
          )}
        </button>
      </div>

      {/* Tab 内容 */}
      <div className="flex-1 overflow-y-auto">
        {activeTab === 'props' ? (
          <div className="p-3 space-y-4">
            <div className="flex items-center gap-2">
              <Play className="w-4 h-4 text-purple-500" />
              <h4 className="text-sm font-semibold">步骤属性</h4>
            </div>

            {/* 步骤 ID */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">步骤 ID</label>
              <Input
                value={data.stepId}
                onChange={(e) => {
                  onChange({
                    ...node,
                    data: { ...data, stepId: e.target.value },
                  })
                }}
                className="mt-1 h-8 text-xs font-mono"
              />
            </div>

            {/* 工具名 */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">工具名称</label>
              <Input
                value={data.tool}
                onChange={(e) => {
                  onChange({
                    ...node,
                    data: { ...data, tool: e.target.value, label: e.target.value },
                  })
                }}
                className="mt-1 h-8 text-xs font-mono"
              />
            </div>

            {/* 描述 */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">描述</label>
              <Textarea
                value={data.description}
                onChange={(e) => {
                  onChange({
                    ...node,
                    data: { ...data, description: e.target.value },
                  })
                }}
                rows={2}
                className="mt-1 text-xs resize-none"
                placeholder="描述此步骤的功能..."
              />
            </div>

            {/* 条件 */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                执行条件 <span className="text-muted-foreground/60">（可选）</span>
              </label>
              <Input
                value={data.condition || ''}
                onChange={(e) => {
                  onChange({
                    ...node,
                    data: { ...data, condition: e.target.value || undefined },
                  })
                }}
                placeholder="例如: step1.success | step1.failed"
                className="mt-1 h-8 text-xs font-mono"
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                格式：<code>前置步骤ID.success</code> 或 <code>.failed</code>
              </p>
            </div>

            {/* 参数 */}
            <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-2.5">
              <div className="flex items-start gap-2">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="text-xs font-medium">副作用与重复执行</div>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    AI 编排重复调用步骤时，会优先保护非幂等和有副作用的节点。
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {STEP_SIDE_EFFECT_OPTIONS.map((item) => {
                  const active = (data.sideEffect || 'none') === item.value
                  return (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => {
                        onChange({
                          ...node,
                          data: { ...data, sideEffect: item.value },
                        })
                      }}
                      className={cn(
                        'rounded-md border p-2 text-left transition-colors',
                        active
                          ? 'border-purple-400 bg-purple-50 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300'
                          : 'border-border bg-background hover:bg-muted',
                      )}
                    >
                      <div className="text-[11px] font-medium">{item.label}</div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">{item.desc}</div>
                    </button>
                  )
                })}
              </div>

              <label className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-2.5 py-2">
                <span className="text-[11px] text-foreground">此步骤可安全重复执行</span>
                <Switch
                  checked={Boolean(data.idempotent)}
                  onCheckedChange={(checked) => {
                    onChange({
                      ...node,
                      data: { ...data, idempotent: checked },
                    })
                  }}
                />
              </label>
            </div>

            {nativeFileTool && (
              <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <div className="mt-0.5 text-muted-foreground">{nativeFileTool.icon}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{nativeFileTool.title}</div>
                    <p className="text-[10px] text-muted-foreground mt-0.5 leading-relaxed">
                      {nativeFileTool.description}
                    </p>
                  </div>
                </div>
                <input
                  ref={artifactInputRef}
                  type="file"
                  accept={nativeFileTool.accept}
                  className="hidden"
                  onChange={(e) => handleArtifactUpload(e.target.files?.[0])}
                />
                <div
                  className="rounded-md border border-dashed bg-background/70 p-3 text-center"
                  onDragOver={(e) => {
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'copy'
                  }}
                  onDrop={(e) => {
                    e.preventDefault()
                    handleArtifactUpload(e.dataTransfer.files?.[0])
                  }}
                >
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={uploadingArtifact}
                    onClick={() => artifactInputRef.current?.click()}
                  >
                    {uploadingArtifact ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <UploadCloud className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    {uploadingArtifact ? '上传中' : '上传到节点'}
                  </Button>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    也可以拖拽文件到这里
                  </p>
                </div>
                {artifactUploadStatus && artifactUploadStatus.state !== 'idle' && (
                  <div className="rounded-md border bg-background px-2.5 py-2 text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate font-medium">{artifactUploadStatus.fileName}</div>
                        <div className="mt-0.5 text-muted-foreground">
                          {formatUploadBytes(artifactUploadStatus.uploadedBytes)} / {formatUploadBytes(artifactUploadStatus.totalBytes)}
                          {artifactUploadStatus.totalParts ? ` · ${artifactUploadStatus.partNumber || '-'} / ${artifactUploadStatus.totalParts} 片` : ''}
                        </div>
                      </div>
                      <Badge variant="outline" className="shrink-0 rounded-md">
                        {artifactUploadStatus.state === 'uploading' ? '上传中' :
                          artifactUploadStatus.state === 'paused' ? '已暂停' :
                            artifactUploadStatus.state === 'failed' ? '失败' : '完成'}
                      </Badge>
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          'h-full rounded-full transition-all',
                          artifactUploadStatus.state === 'failed' ? 'bg-red-500' :
                            artifactUploadStatus.state === 'completed' ? 'bg-green-500' : 'bg-purple-500',
                        )}
                        style={{
                          width: `${Math.min(100, Math.round((artifactUploadStatus.uploadedBytes / Math.max(artifactUploadStatus.totalBytes, 1)) * 100))}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex justify-end gap-1.5">
                      {artifactUploadStatus.state === 'uploading' && (
                        <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[10px]" onClick={pauseArtifactUpload}>
                          暂停
                        </Button>
                      )}
                      {['paused', 'failed'].includes(artifactUploadStatus.state) && (
                        <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-[10px]" onClick={retryArtifactUpload}>
                          重试
                        </Button>
                      )}
                    </div>
                  </div>
                )}
                {typeof data.args?.artifactUuid === 'string' && (
                  <div className="rounded-md bg-background px-2 py-1.5 text-[10px] text-muted-foreground">
                    已绑定：<code className="font-mono">{data.args.artifactUuid}</code>
                    {typeof data.args.fileName === 'string' && (
                      <span className="ml-1">({data.args.fileName})</span>
                    )}
                  </div>
                )}
                {artifactUploadError && (
                  <p className="text-[10px] text-red-500">{artifactUploadError}</p>
                )}
              </div>
            )}

            <div>
              <label className="text-xs font-medium text-muted-foreground">
                参数 (JSON)
              </label>
              <Textarea
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                onBlur={handleArgsBlur}
                rows={4}
                className={cn(
                  'mt-1 text-xs font-mono resize-none',
                  argsError && 'border-red-500',
                )}
                placeholder='{"key": "value"}'
              />
              {argsError && (
                <p className="text-[10px] text-red-500 mt-0.5">{argsError}</p>
              )}
              {!argsError && data.args && Object.keys(data.args).length > 0 && (
                <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                  <Info className="w-3 h-3 shrink-0" /> 已自动检测参数，请根据实际需求修改示例值
                </p>
              )}
            </div>

            {/* 参数说明卡片 — 从代码中提取参数含义 */}
            {data.code?.trim() && (() => {
              const guide = getParamGuide(data.code)
              if (guide.length === 0) return null
              return (
                <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] text-blue-700 dark:text-blue-300 font-medium flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      参数说明（从代码自动检测）
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        // ★ 修复：一键将参数示例值填入参数输入框
                        const sampleArgs: Record<string, string> = {}
                        for (const p of guide) {
                          sampleArgs[p.name] = p.sample
                        }
                        const newText = JSON.stringify(sampleArgs, null, 2)
                        setArgsText(newText)
                        setArgsError('')
                        // 同步到 data.args
                        try {
                          const parsed = JSON.parse(newText)
                          onChange({
                            ...node,
                            data: { ...data, args: parsed },
                          })
                        } catch {
                          // 不会失败，因为是我们生成的 JSON
                        }
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-blue-300 dark:border-blue-700 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors font-medium"
                    >
                      一键填入
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {guide.map((p) => (
                      <div key={p.name} className="flex items-start gap-2">
                        <code className="text-[10px] font-mono bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-1.5 py-0.5 rounded shrink-0 min-w-[60px] text-center">
                          {p.name}
                        </code>
                        <span className="text-[10px] text-muted-foreground leading-relaxed">
                          {p.label}，示例：<code className="text-[10px] font-mono">{p.sample}</code>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>
        ) : (
          <div className="p-3 space-y-3">
            <div className="flex items-center gap-2">
              <Code2 className="w-4 h-4 text-blue-500" />
              <h4 className="text-sm font-semibold">工具代码</h4>
            </div>

            <p className="text-[10px] text-muted-foreground -mt-1">
              编写或由 AI 生成工具的可执行代码。支持 Python 和 JavaScript。
            </p>

            {/* 语言选择 */}
            <div>
              <label className="text-xs font-medium text-muted-foreground">语言</label>
              <div className="flex gap-1 mt-1">
                {(['python', 'javascript'] as const).map((lang) => (
                  <button
                    key={lang}
                    onClick={() => {
                      setLanguage(lang)
                      onChange({ ...node, data: { ...data, language: lang } })
                    }}
                    className={cn(
                      'flex-1 py-1.5 px-2 rounded text-xs font-medium border transition-colors',
                      language === lang
                        ? 'border-blue-400 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="flex items-center gap-1">
                      {lang === 'python' ? <><Code2 className="w-3 h-3" /> Python</> : <><Code2 className="w-3 h-3" /> JavaScript</>}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3 space-y-3">
              <div className="flex items-center gap-2">
                <Settings className="w-3.5 h-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">运行边界</span>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">超时秒数</label>
                <Input
                  type="number"
                  min={1}
                  max={300}
                  value={typeof data.timeoutSeconds === 'number' ? data.timeoutSeconds : 60}
                  onChange={(e) => {
                    const next = Math.max(1, Math.min(Number(e.target.value) || 60, 300))
                    onChange({ ...node, data: { ...data, timeoutSeconds: next } })
                  }}
                  className="mt-1 h-8 text-xs"
                />
                <p className="text-[10px] text-muted-foreground mt-1">范围 1-300 秒，超过后自动终止。</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">权限</label>
                <div className="grid grid-cols-2 gap-1.5 mt-1.5">
                  {CUSTOM_TOOL_PERMISSIONS.map((item) => {
                    const selected = Array.isArray(data.permissions) && data.permissions.includes(item.key)
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => togglePermission(item.key)}
                        className={cn(
                          'rounded-md border px-2 py-1.5 text-left transition-colors',
                          selected
                            ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-300'
                            : 'border-border bg-background hover:bg-muted',
                        )}
                      >
                        <span className="block text-[11px] font-medium">{item.label}</span>
                        <span className="block text-[10px] text-muted-foreground mt-0.5">{item.desc}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
              <div className="grid gap-2">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">输入 Schema</label>
                  <Textarea
                    value={inputSchemaText}
                    onChange={(e) => setInputSchemaText(e.target.value)}
                    onBlur={() => handleSchemaBlur('input')}
                    rows={4}
                    className={cn('mt-1 text-[10px] font-mono resize-none', inputSchemaError && 'border-red-500')}
                    spellCheck={false}
                  />
                  {inputSchemaError && <p className="text-[10px] text-red-500 mt-1">{inputSchemaError}</p>}
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">输出 Schema</label>
                  <Textarea
                    value={outputSchemaText}
                    onChange={(e) => setOutputSchemaText(e.target.value)}
                    onBlur={() => handleSchemaBlur('output')}
                    rows={4}
                    className={cn('mt-1 text-[10px] font-mono resize-none', outputSchemaError && 'border-red-500')}
                    spellCheck={false}
                  />
                  {outputSchemaError && <p className="text-[10px] text-red-500 mt-1">{outputSchemaError}</p>}
                </div>
              </div>
            </div>

            {/* 代码编辑区 */}
            <div>
              <label className="text-xs font-medium text-muted-foreground flex items-center justify-between">
                代码
                <span className="text-[10px] text-muted-foreground/60">
                  {data.code ? `${data.code.split('\n').length} 行` : '空'}
                </span>
              </label>
              <Textarea
                value={data.code || ''}
                onChange={(e) => {
                  onChange({
                    ...node,
                    data: { ...data, code: e.target.value },
                  })
                  setTestResult(null) // 代码变更清除测试结果
                }}
                rows={12}
                className="mt-1 text-[11px] font-mono resize-none leading-relaxed"
                placeholder={`# 在这里编写或粘贴工具代码\n# 函数签名: def main(args):\n# args 是字典，包含输入参数\n# 返回字典作为执行结果\n\n`}
                spellCheck={false}
              />
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 text-xs h-8"
                onClick={handleAiGenerate}
                disabled={generatingCode}
              >
                {generatingCode ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                ) : (
                  <Sparkles className="w-3.5 h-3.5 mr-1 text-amber-500" />
                )}
                {generatingCode ? 'AI 生成中...' : 'AI 生成代码'}
              </Button>
              <Button
                size="sm"
                className="flex-1 text-xs h-8"
                onClick={handleTest}
                disabled={testingCode || !data.code?.trim()}
              >
                {testingCode ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                ) : (
                  <Terminal className="w-3.5 h-3.5 mr-1" />
                )}
                {testingCode ? '测试中...' : '测试运行'}
              </Button>
            </div>

            {/* 对话式微调 */}
            {data.code?.trim() && (
              <div
                ref={refinePanelRef}
                className="space-y-2 rounded-lg border-2 border-blue-300 dark:border-blue-600 bg-blue-50/70 dark:bg-blue-950/30 p-3 scroll-mt-16"
              >
                <p className="text-xs text-blue-700 dark:text-blue-300 font-semibold flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                  继续对话完善代码
                </p>
                <p className="text-[10px] text-blue-600/70 dark:text-blue-400/70">
                  在下方用自然语言描述修改意见，AI 会在当前代码基础上迭代，无需重新生成
                </p>
                <Textarea
                  value={refineInstruction}
                  onChange={(e) => setRefineInstruction(e.target.value)}
                  rows={2}
                  className="text-[11px] resize-none"
                  placeholder='例如："增加错误日志记录" "改用正则表达式提高效率" "处理空值情况"'
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.ctrlKey) {
                      e.preventDefault()
                      handleRefine()
                    }
                  }}
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1 text-xs h-8 bg-blue-600 hover:bg-blue-700 text-white"
                    onClick={handleRefine}
                    disabled={refining || !refineInstruction.trim()}
                  >
                    {refining ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                    ) : (
                      <Bot className="w-3.5 h-3.5 mr-1" />
                    )}
                    {refining ? 'AI 修改中...' : '发送修改意见'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-xs h-8"
                    onClick={() => setRefineInstruction('')}
                    disabled={refining || !refineInstruction.trim()}
                  >
                    清空
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground text-center">
                  Ctrl + Enter 快速发送修改意见
                </p>
              </div>
            )}

            {/* 测试结果 */}
            {testResult && (
              <div
                className={cn(
                  'rounded-lg border p-3 space-y-2',
                  testResult.success
                    ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/20'
                    : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/20',
                )}
              >
                <div className="flex items-center gap-1.5">
                  {testResult.success ? (
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                  ) : (
                    <XCircle className="w-4 h-4 text-red-500" />
                  )}
                  <span
                    className={cn(
                      'text-xs font-medium',
                      testResult.success ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300',
                    )}
                  >
                    {testResult.success ? '运行成功' : '运行失败'}
                  </span>
                  {testResult.elapsedMs != null && (
                    <span className="text-[10px] text-muted-foreground ml-auto">
                      {testResult.elapsedMs}ms
                    </span>
                  )}
                </div>
                {testResult.success && testResult.output !== undefined && (
                  <pre className="text-[10px] font-mono bg-green-100 dark:bg-green-900/30 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap text-green-900 dark:text-green-100">
                    {typeof testResult.output === 'string'
                      ? testResult.output
                      : JSON.stringify(testResult.output, null, 2)}
                  </pre>
                )}
                {testResult.error && (
                  <pre className="text-[10px] font-mono bg-red-100 dark:bg-red-900/30 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap text-red-900 dark:text-red-100">
                    {testResult.error}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ==================== 移动端工具面板覆盖层 ====================

function MobileToolsPanel({
  availableTools,
  toolSearch,
  setToolSearch,
  filteredTools,
  onAddTool,
  onClose,
  customToolName,
  setCustomToolName,
  customToolDesc,
  setCustomToolDesc,
  showCustomTool,
  setShowCustomTool,
  addCustomTool,
}: {
  availableTools: AvailableTool[]
  toolSearch: string
  setToolSearch: (v: string) => void
  filteredTools: AvailableTool[]
  onAddTool: (tool: AvailableTool) => void
  onClose: () => void
  customToolName: string
  setCustomToolName: (v: string) => void
  customToolDesc: string
  setCustomToolDesc: (v: string) => void
  showCustomTool: boolean
  setShowCustomTool: (v: boolean) => void
  addCustomTool: () => void
}) {
  return (
    <div className="absolute inset-0 z-30 bg-background flex flex-col animate-in slide-in-from-bottom duration-200">
      <div className="shrink-0 flex items-center gap-2 px-3 py-3 border-b">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Puzzle className="w-4 h-4" />
        <h3 className="text-sm font-semibold flex-1">工具面板</h3>
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>
      <div className="px-3 py-2 border-b">
        <div className="relative">
          <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="搜索工具..." value={toolSearch} onChange={(e) => setToolSearch(e.target.value)} className="pl-7 h-8 text-xs" />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filteredTools.map((tool) => (
          <button
            key={tool.name}
            onClick={() => onAddTool(tool)}
            className={cn(
              'w-full p-3 rounded-lg border text-left transition-all active:scale-[0.98]',
              tool.category === 'builtin' && 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30',
              tool.category === 'agent' && 'border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-950/30',
              tool.category === 'custom' && 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30',
            )}
          >
            <div className="text-sm font-medium">{tool.label}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{tool.description}</div>
            <Badge variant="outline" className="mt-1.5 text-[10px] px-1 py-0 h-4">{tool.name}</Badge>
          </button>
        ))}
        {filteredTools.length === 0 && (
          <p className="text-xs text-muted-foreground text-center py-8">没有找到匹配的工具</p>
        )}
      </div>
      <div className="shrink-0 p-3 border-t bg-muted/20">
        {showCustomTool ? (
          <div className="space-y-2 rounded-lg border-2 border-blue-300 dark:border-blue-600 bg-blue-50/70 dark:bg-blue-950/30 p-2.5">
            <p className="text-[10px] text-blue-600 dark:text-blue-400 font-medium">创建自定义工具</p>
            <Input placeholder="工具名称（英文）" value={customToolName} onChange={(e) => setCustomToolName(e.target.value)} className="h-8 text-xs" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') addCustomTool(); if (e.key === 'Escape') { setShowCustomTool(false); setCustomToolName(''); setCustomToolDesc('') } }} />
            <Input placeholder="功能描述（可选）" value={customToolDesc} onChange={(e) => setCustomToolDesc(e.target.value)} className="h-8 text-xs" onKeyDown={(e) => { if (e.key === 'Enter') addCustomTool(); if (e.key === 'Escape') { setShowCustomTool(false); setCustomToolName(''); setCustomToolDesc('') } }} />
            <div className="flex gap-2">
              <Button size="sm" className="flex-1 h-8 text-xs" onClick={addCustomTool} disabled={!customToolName.trim()}><Plus className="w-3 h-3 mr-1" />添加</Button>
              <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => { setShowCustomTool(false); setCustomToolName(''); setCustomToolDesc('') }}>取消</Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" size="sm" className="w-full h-9 text-xs font-medium border-blue-300 dark:border-blue-700 hover:bg-blue-50 dark:hover:bg-blue-950/30 text-blue-600 dark:text-blue-400" onClick={() => setShowCustomTool(true)}><Plus className="w-3.5 h-3.5 mr-1.5" />添加自定义工具</Button>
        )}
      </div>
    </div>
  )
}

// ==================== 移动端属性编辑器覆盖层 ====================

function MobilePropertyPanel({
  node,
  onChange,
  onClose,
  onDelete,
  canDelete,
}: {
  node: Node
  onChange: (node: Node) => void
  onClose: () => void
  onDelete: () => void
  canDelete: boolean
}) {
  const title = node.type === 'trigger'
    ? '触发器设置'
    : `节点属性：${(node.data as StepNodeData).label || (node.data as StepNodeData).tool || node.id}`

  return (
    <div className="absolute inset-0 z-30 bg-background flex flex-col animate-in slide-in-from-right duration-200">
      <div className="shrink-0 flex items-center gap-2 px-3 py-3 border-b">
        <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={onClose}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <Wrench className="w-4 h-4" />
        <h3 className="text-sm font-semibold flex-1 truncate">{title}</h3>
        {canDelete && (
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-red-500" onClick={onDelete}>
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        <NodePropertyEditor node={node} onChange={onChange} />
      </div>
    </div>
  )
}
