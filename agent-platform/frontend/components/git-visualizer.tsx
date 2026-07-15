'use client'

import { useState, useCallback, useMemo } from 'react'
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { cn } from '@/lib/utils'
import type { GitCommit } from '@/types'
import { gitApi } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { GitBranch, GitCommit as GitCommitIcon, ArrowRight, RotateCcw, Plus, Minus, Loader2 } from 'lucide-react'

interface GitVisualizerProps {
  commits: GitCommit[]
  workspaceId: string
  onRollback?: (commitHash: string) => void
  className?: string
}

interface CommitNode {
  id: string
  position: { x: number; y: number }
  data: {
    label: string
    commit: GitCommit
    isSelected: boolean
  }
  type: 'commitNode'
  selected?: boolean
}

// 自定义 Commit 节点
function CommitNodeComponent({ data }: { data: { label: string; commit: GitCommit; isSelected: boolean } }) {
  return (
    <div className={cn(
      'bg-card border rounded-xl px-4 py-3 min-w-[200px] max-w-[260px] shadow-md cursor-pointer transition-all',
      data.isSelected ? 'border-primary ring-2 ring-primary/20 shadow-lg scale-105' : 'border-border hover:border-primary/50 hover:shadow-lg'
    )}>
      <div className="flex items-center gap-2 mb-1.5">
        <GitCommitIcon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded shrink-0">
          {data.commit.hash}
        </code>
      </div>
      <p className="text-sm font-medium line-clamp-2 mb-1.5">{data.commit.message}</p>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{data.commit.author}</span>
        <span>{formatDate(data.commit.date)}</span>
      </div>
      <div className="flex flex-wrap gap-1 mt-2">
        {data.commit.files_changed.slice(0, 3).map(f => (
          <span key={f} className="text-xs bg-muted px-1.5 py-0.5 rounded truncate max-w-[100px]">
            {f.split('/').pop()}
          </span>
        ))}
        {data.commit.files_changed.length > 3 && (
          <span className="text-xs text-muted-foreground">+{data.commit.files_changed.length - 3}</span>
        )}
      </div>
    </div>
  )
}

const nodeTypes = { commitNode: CommitNodeComponent }

export function GitVisualizer({ commits, workspaceId, onRollback, className }: GitVisualizerProps) {
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null)
  const [diffCommit, setDiffCommit] = useState<string | null>(null)
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [viewMode, setViewMode] = useState<'graph' | 'timeline' | 'diff'>('graph')

  // 构建节点和边
  const { initialNodes, initialEdges } = useMemo(() => {
    if (!commits.length) return { initialNodes: [], initialEdges: [] }

    const nodes: Node[] = []
    const edges: Edge[] = []

    // 横向排列（时间从左到右）
    commits.forEach((commit, index) => {
      const x = index * 280
      const y = 0

      nodes.push({
        id: commit.hash,
        position: { x, y },
        data: {
          label: commit.hash,
          commit,
          isSelected: selectedCommit === commit.hash,
        },
        type: 'commitNode',
        selected: selectedCommit === commit.hash,
      })

      // 连接到上一个 commit
      if (index > 0) {
        const prevCommit = commits[index - 1]
        edges.push({
          id: `${prevCommit.hash}-${commit.hash}`,
          source: prevCommit.hash,
          target: commit.hash,
          type: 'smoothstep',
          animated: index === 0,
          style: { strokeWidth: 2 },
          markerEnd: { type: MarkerType.ArrowClosed },
          label: index === 1 ? 'init' : undefined,
          labelStyle: { fontSize: 10 },
        })
      }
    })

    return { initialNodes: nodes, initialEdges: edges }
  }, [commits, selectedCommit])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // 当 commits 更新时同步
  useMemo(() => {
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [initialNodes, initialEdges, setNodes, setEdges])

  const onNodeClick = useCallback((_: any, node: Node) => {
    setSelectedCommit(node.id === selectedCommit ? null : node.id)
    setDiffCommit(null)
    setDiffContent(null)
  }, [selectedCommit])

  // 加载 diff
  const loadDiff = async (commitHash: string) => {
    if (diffCommit === commitHash) {
      setDiffCommit(null)
      setDiffContent(null)
      return
    }
    setLoadingDiff(true)
    setDiffCommit(commitHash)
    try {
      const data = await gitApi.diff(workspaceId, commitHash)
      if (data) {
        setDiffContent(data.diff || '[无变更]')
      }
    } catch {
      setDiffContent('[加载失败]')
    } finally {
      setLoadingDiff(false)
    }
  }

  if (!commits.length) {
    return (
      <div className={cn('border rounded-xl p-8 text-center', className)}>
        <GitBranch className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-sm text-muted-foreground">暂无 Git 提交记录</p>
      </div>
    )
  }

  return (
    <div className={cn('border rounded-xl overflow-hidden', className)}>
      {/* Toolbar */}
      <div className="px-4 py-2 border-b bg-muted/20 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <GitBranch className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">Git 可视化</span>
          <span className="text-xs text-muted-foreground">{commits.length} 个提交</span>
        </div>
        <div className="flex items-center gap-1">
          {['graph', 'timeline', 'diff'].map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode as typeof viewMode)}
              className={cn(
                'px-3 py-1 text-xs rounded-md transition',
                viewMode === mode ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary'
              )}
            >
              {mode === 'graph' ? '分支图' : mode === 'timeline' ? '时间线' : 'Diff'}
            </button>
          ))}
        </div>
      </div>

      {/* 视图内容 */}
      <div className="relative" style={{ height: viewMode === 'graph' ? '320px' : 'auto' }}>
        {/* 分支图 */}
        {viewMode === 'graph' && (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={onNodeClick}
            nodeTypes={nodeTypes}
            fitView
            panOnDrag
            zoomOnScroll
            minZoom={0.3}
            maxZoom={1.5}
            proOptions={{ hideAttribution: true }}
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        )}

        {/* 时间线视图 */}
        {viewMode === 'timeline' && (
          <div className="p-4 space-y-1 max-h-[400px] overflow-y-auto">
            {commits.map((commit, i) => (
              <button
                key={commit.hash}
                onClick={() => setSelectedCommit(commit.hash === selectedCommit ? null : commit.hash)}
                className={cn(
                  'w-full text-left p-3 rounded-lg border transition',
                  selectedCommit === commit.hash
                    ? 'border-primary bg-primary/5'
                    : 'border-transparent hover:bg-secondary/50'
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn('w-2.5 h-2.5 rounded-full shrink-0',
                    i === 0 ? 'bg-green-500' : 'bg-muted-foreground/40'
                  )} />
                  <code className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{commit.hash}</code>
                  <span className="text-xs text-muted-foreground ml-auto">{formatDate(commit.date)}</span>
                  <button
                    onClick={e => { e.stopPropagation(); loadDiff(commit.hash) }}
                    className="text-xs text-primary hover:underline"
                  >
                    查看 Diff
                  </button>
                </div>
                <p className="text-sm mt-1 ml-5.5 pl-5">{commit.message}</p>
              </button>
            ))}
          </div>
        )}

        {/* Diff 视图 */}
        {viewMode === 'diff' && (
          <div className="p-4">
            {!diffCommit ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted-foreground mb-3">选择一个提交查看变更</p>
                <div className="flex flex-wrap gap-2 justify-center">
                  {commits.slice(0, 5).map(c => (
                    <button
                      key={c.hash}
                      onClick={() => loadDiff(c.hash)}
                      className="text-xs bg-secondary px-3 py-1.5 rounded-lg hover:bg-primary/10 transition"
                    >
                      {c.hash}
                    </button>
                  ))}
                </div>
              </div>
            ) : loadingDiff ? (
              <div className="flex items-center justify-center py-8 gap-2">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                <span className="text-sm text-muted-foreground">加载 diff...</span>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <code className="text-xs font-mono bg-muted px-2 py-1 rounded">{diffCommit}</code>
                  <button
                    onClick={() => { setDiffCommit(null); setDiffContent(null) }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    关闭
                  </button>
                </div>
                <pre className="text-xs font-mono bg-[#0d1117] text-[#c9d1d9] p-4 rounded-lg overflow-x-auto max-h-[360px] overflow-y-auto">
                  <code>{diffContent}</code>
                </pre>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 选中 commit 详情 */}
      {selectedCommit && viewMode !== 'diff' && (
        <div className="border-t bg-muted/10 p-4">
          {(() => {
            const commit = commits.find(c => c.hash === selectedCommit)
            if (!commit) return null
            return (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <GitCommitIcon className="w-4 h-4 text-primary" />
                    <code className="font-mono text-sm bg-muted px-2 py-1 rounded">{commit.hash}</code>
                  </div>
                  {onRollback && (
                    <button
                      onClick={() => onRollback(commit.hash)}
                      className="flex items-center gap-1.5 text-xs border border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400 px-3 py-1.5 rounded-lg hover:bg-amber-50 dark:hover:bg-amber-900/30 transition"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      回滚到此版本
                    </button>
                  )}
                </div>
                <p className="text-sm font-medium">{commit.message}</p>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  <span>{commit.author}</span>
                  <span>{formatDate(commit.date)}</span>
                  <span>{commit.files_changed.length} 个文件变更</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {commit.files_changed.map(f => (
                    <span key={f} className="text-xs bg-muted px-2 py-1 rounded">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </div>
  )
}
