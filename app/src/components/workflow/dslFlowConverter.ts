/**
 * DSL ↔ React Flow 双向转换
 */
import type { Node, Edge } from '@xyflow/react'
import type {
  WorkflowDsl,
  TriggerDef,
  StepDef,
  TriggerNodeData,
  StepNodeData,
} from '@/lib/workflowTypes'

// ==================== DSL → Flow ====================

const TRIGGER_NODE_ID = 'trigger-root'

/**
 * 将工作流 DSL JSON 解析为 React Flow 的 nodes + edges
 */
export function dslToFlow(dslJson: string): { nodes: Node[]; edges: Edge[] } {
  let dsl: WorkflowDsl
  try {
    dsl = JSON.parse(dslJson) as WorkflowDsl
  } catch {
    return { nodes: [], edges: [] }
  }

  if (!dsl?.trigger || !dsl?.steps) {
    return { nodes: [], edges: [] }
  }

  const nodes: Node[] = []
  const edges: Edge[] = []

  // 1. 创建触发器节点（固定位置）
  nodes.push({
    id: TRIGGER_NODE_ID,
    type: 'trigger',
    position: { x: 250, y: 30 },
    data: {
      label: dsl.trigger.type === 'cron' ? '定时触发器' : '手动触发器',
      triggerType: dsl.trigger.type,
      cronExpr: dsl.trigger.value || '',
      dataMode: dsl.dataMode || 'auto',
      aiPolicy: dsl.aiPolicy,
    } satisfies TriggerNodeData,
  })

  // 2. 创建步骤节点（优先使用保存的位置，否则纵向排列）
  const stepHeight = 160
  const startY = 180
  const gap = stepHeight + 20

  dsl.steps.forEach((step, index) => {
    const nodeId = step.id || `step-${index}`
    // 从 layout 恢复位置，如果 layout 不存在则使用默认排列
    const savedPos = dsl.layout?.[nodeId]
    const position = savedPos
      ? { x: savedPos.x, y: savedPos.y }
      : { x: 200, y: startY + index * gap }
    nodes.push({
      id: nodeId,
      type: 'step',
      position,
      data: {
        label: step.tool,
        stepId: step.id || `step-${index}`,
        tool: step.tool,
        description: step.description || '',
        args: step.args || {},
        condition: step.condition,
        idempotent: step.idempotent,
        sideEffect: step.sideEffect,
        code: step.code || '',
        language: step.language || 'python',
        timeoutSeconds: step.timeoutSeconds,
        permissions: step.permissions || [],
        inputSchema: step.inputSchema,
        outputSchema: step.outputSchema,
      } satisfies StepNodeData,
    })
  })

  // 3. 创建连接线
  // 触发器 → 第一个步骤
  if (dsl.steps.length > 0) {
    const firstStepId = dsl.steps[0].id || 'step-0'
    edges.push({
      id: `edge-${TRIGGER_NODE_ID}-${firstStepId}`,
      source: TRIGGER_NODE_ID,
      target: firstStepId,
      sourceHandle: 'trigger-out',
      targetHandle: `${firstStepId}-in`,
      animated: true,
      style: { stroke: '#f59e0b', strokeWidth: 2 },
    })
  }

  // 步骤之间的连接
  for (let i = 0; i < dsl.steps.length - 1; i++) {
    const sourceId = dsl.steps[i].id || `step-${i}`
    const targetId = dsl.steps[i + 1].id || `step-${i + 1}`
    edges.push({
      id: `edge-${sourceId}-${targetId}`,
      source: sourceId,
      target: targetId,
      sourceHandle: `${sourceId}-out`,
      targetHandle: `${targetId}-in`,
      animated: true,
      style: { stroke: '#94a3b8', strokeWidth: 2 },
    })
  }

  return { nodes, edges }
}

// ==================== Flow → DSL ====================

/**
 * 将 React Flow 的 nodes + edges 转为工作流 DSL JSON 字符串
 */
export function flowToDsl(nodes: Node[], edges: Edge[]): string {
  // 找到触发器节点
  const triggerNode = nodes.find((n) => n.type === 'trigger')
  if (!triggerNode) {
    return JSON.stringify({ trigger: { type: 'manual' }, steps: [] }, null, 2)
  }

  const triggerData = triggerNode.data as TriggerNodeData
  const trigger: TriggerDef = {
    type: triggerData.triggerType || 'manual',
    value: triggerData.triggerType === 'cron' ? triggerData.cronExpr || '' : undefined,
  }

  // 按拓扑顺序排列步骤节点
  const stepNodes = nodes.filter((n) => n.type === 'step') as Node<StepNodeData>[]
  const sortedSteps = topologicalSort(stepNodes, edges)

  const steps: StepDef[] = sortedSteps.map((node) => ({
    id: node.data.stepId,
    tool: node.data.tool,
    description: node.data.description,
    args: node.data.args && Object.keys(node.data.args).length > 0 ? node.data.args : undefined,
    condition: node.data.condition || undefined,
    idempotent: node.data.idempotent || undefined,
    sideEffect: node.data.sideEffect || undefined,
    code: node.data.code || undefined,
    language: node.data.language || undefined,
    timeoutSeconds: node.data.timeoutSeconds || undefined,
    permissions: node.data.permissions && node.data.permissions.length > 0 ? node.data.permissions : undefined,
    inputSchema: node.data.inputSchema && Object.keys(node.data.inputSchema).length > 0
      ? node.data.inputSchema
      : node.data.code ? { type: 'object', required: [] } : undefined,
    outputSchema: node.data.outputSchema && Object.keys(node.data.outputSchema).length > 0
      ? node.data.outputSchema
      : node.data.code ? { type: 'object', required: [] } : undefined,
  }))

  // 保存节点位置映射
  const layout: Record<string, { x: number; y: number }> = {}
  for (const n of stepNodes) {
    layout[n.id] = { x: n.position.x, y: n.position.y }
  }

  const dsl: WorkflowDsl = {
    trigger,
    steps,
    layout,
    dataMode: triggerData.dataMode || 'auto',
    aiPolicy: triggerData.aiPolicy,
  }
  return JSON.stringify(dsl, null, 2)
}

// ==================== 拓扑排序 ====================

function topologicalSort(stepNodes: Node<StepNodeData>[], edges: Edge[]): Node<StepNodeData>[] {
  const idSet = new Set(stepNodes.map((n) => n.id))
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  stepNodes.forEach((n) => {
    inDegree.set(n.id, 0)
    adjacency.set(n.id, [])
  })

  edges.forEach((e) => {
    if (idSet.has(e.source) && idSet.has(e.target)) {
      adjacency.get(e.source)?.push(e.target)
      inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
    }
  })

  const queue: string[] = []
  inDegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id)
  })

  const result: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)
    adjacency.get(current)?.forEach((neighbor) => {
      const newDeg = (inDegree.get(neighbor) || 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    })
  }

  const nodeMap = new Map(stepNodes.map((n) => [n.id, n]))
  return result.map((id) => nodeMap.get(id)!).filter(Boolean)
}

// ==================== 节点生成辅助 ====================

let _stepCounter = 0

export function resetStepCounter() {
  _stepCounter = 0
}

export function nextStepId(): string {
  _stepCounter++
  return `step-${_stepCounter}`
}

export function createStepNode(
  id: string,
  tool: string,
  description: string,
  x: number,
  y: number,
): Node<StepNodeData> {
  return {
    id,
    type: 'step',
    position: { x, y },
    data: {
      label: tool,
      stepId: id,
      tool,
      description,
      args: {},
      timeoutSeconds: 60,
      permissions: [],
    },
  }
}

export const TRIGGER_NODE_ID_CONST = TRIGGER_NODE_ID
