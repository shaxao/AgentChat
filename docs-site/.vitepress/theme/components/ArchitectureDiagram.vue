<script setup lang="ts">
/**
 * 可交互的系统架构图。
 * 传入一组节点（node）和连线（edge），点击节点可跳转到对应文档章节。
 * 纯 SVG 绘制，无第三方依赖，随主题明暗自动适配颜色。
 */
import { ref, computed } from 'vue'
import { useRouter } from 'vitepress'

interface DiagramNode {
  id: string
  label: string
  sub?: string
  x: number
  y: number
  w?: number
  h?: number
  /** 节点分组，决定配色 */
  group?: 'java' | 'python' | 'rust' | 'frontend' | 'infra' | 'user'
  /** 点击跳转的文档路径 */
  link?: string
}

interface DiagramEdge {
  from: string
  to: string
  label?: string
  /** 虚线连接 */
  dashed?: boolean
}

const props = withDefaults(
  defineProps<{
    nodes?: DiagramNode[]
    edges?: DiagramEdge[]
    width?: number
    height?: number
    title?: string
  }>(),
  {
    nodes: () => [],
    edges: () => [],
    width: 860,
    height: 520,
  },
)

const router = useRouter()
const hovered = ref<string | null>(null)

const groupColors: Record<string, { fill: string; stroke: string; text: string }> = {
  java: { fill: 'rgba(59,130,246,0.14)', stroke: '#3b82f6', text: '#1d4ed8' },
  python: { fill: 'rgba(34,197,94,0.14)', stroke: '#22c55e', text: '#15803d' },
  rust: { fill: 'rgba(249,115,22,0.14)', stroke: '#f97316', text: '#c2410c' },
  frontend: { fill: 'rgba(168,85,247,0.14)', stroke: '#a855f7', text: '#7e22ce' },
  infra: { fill: 'rgba(100,116,139,0.14)', stroke: '#64748b', text: '#475569' },
  user: { fill: 'rgba(236,72,153,0.14)', stroke: '#ec4899', text: '#be185d' },
}

const DEFAULT_W = 180
const DEFAULT_H = 64

const nodeMap = computed(() => {
  const m = new Map<string, DiagramNode>()
  for (const n of props.nodes) m.set(n.id, n)
  return m
})

function nodeCenter(n: DiagramNode) {
  return { cx: n.x + (n.w ?? DEFAULT_W) / 2, cy: n.y + (n.h ?? DEFAULT_H) / 2 }
}

/** 计算两个节点中心之间的连线端点（贴到矩形边缘） */
function edgePath(edge: DiagramEdge) {
  const from = nodeMap.value.get(edge.from)
  const to = nodeMap.value.get(edge.to)
  if (!from || !to) return null
  const a = nodeCenter(from)
  const b = nodeCenter(to)
  return { a, b }
}

function edgeLabelPos(edge: DiagramEdge) {
  const p = edgePath(edge)
  if (!p) return { x: 0, y: 0 }
  return { x: (p.a.cx + p.b.cx) / 2, y: (p.a.cy + p.b.cy) / 2 - 6 }
}

function colorOf(n: DiagramNode) {
  return groupColors[n.group ?? 'infra'] ?? groupColors.infra
}

function onNodeClick(n: DiagramNode) {
  if (n.link) router.go(n.link)
}

function isDimmed(id: string) {
  return hovered.value !== null && hovered.value !== id
}
</script>

<template>
  <figure class="arch-diagram">
    <figcaption v-if="title" class="arch-title">{{ title }}</figcaption>
    <svg
      :viewBox="`0 0 ${width} ${height}`"
      class="arch-svg"
      role="img"
      :aria-label="title || '系统架构图'"
    >
      <defs>
        <marker
          id="arrow-head"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" class="arch-arrow" />
        </marker>
      </defs>

      <!-- 连线 -->
      <g class="arch-edges">
        <template v-for="(edge, i) in edges" :key="`e-${i}`">
          <line
            v-if="edgePath(edge)"
            :x1="edgePath(edge)!.a.cx"
            :y1="edgePath(edge)!.a.cy"
            :x2="edgePath(edge)!.b.cx"
            :y2="edgePath(edge)!.b.cy"
            class="arch-edge"
            :class="{ dashed: edge.dashed }"
            marker-end="url(#arrow-head)"
          />
          <text
            v-if="edge.label"
            :x="edgeLabelPos(edge).x"
            :y="edgeLabelPos(edge).y"
            class="arch-edge-label"
            text-anchor="middle"
          >
            {{ edge.label }}
          </text>
        </template>
      </g>

      <!-- 节点 -->
      <g class="arch-nodes">
        <g
          v-for="n in nodes"
          :key="n.id"
          class="arch-node"
          :class="{ clickable: !!n.link, dimmed: isDimmed(n.id) }"
          @click="onNodeClick(n)"
          @mouseenter="hovered = n.id"
          @mouseleave="hovered = null"
        >
          <rect
            :x="n.x"
            :y="n.y"
            :width="n.w ?? DEFAULT_W"
            :height="n.h ?? DEFAULT_H"
            rx="10"
            :fill="colorOf(n).fill"
            :stroke="colorOf(n).stroke"
            stroke-width="1.6"
          />
          <text
            :x="n.x + (n.w ?? DEFAULT_W) / 2"
            :y="n.sub ? n.y + (n.h ?? DEFAULT_H) / 2 - 4 : n.y + (n.h ?? DEFAULT_H) / 2 + 5"
            class="arch-node-label"
            text-anchor="middle"
          >
            {{ n.label }}
          </text>
          <text
            v-if="n.sub"
            :x="n.x + (n.w ?? DEFAULT_W) / 2"
            :y="n.y + (n.h ?? DEFAULT_H) / 2 + 14"
            class="arch-node-sub"
            text-anchor="middle"
          >
            {{ n.sub }}
          </text>
        </g>
      </g>
    </svg>
    <p v-if="nodes.some((n) => n.link)" class="arch-hint">
      提示：点击带下划线的节点可跳转到对应章节
    </p>
  </figure>
</template>

<style scoped>
.arch-diagram {
  margin: 24px 0;
  padding: 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.arch-title {
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--vp-c-text-1);
}
.arch-svg {
  width: 100%;
  height: auto;
}
.arch-edge {
  stroke: var(--vp-c-text-3);
  stroke-width: 1.6;
  fill: none;
}
.arch-edge.dashed {
  stroke-dasharray: 6 4;
}
.arch-arrow {
  fill: var(--vp-c-text-3);
}
.arch-edge-label {
  font-size: 12px;
  fill: var(--vp-c-text-2);
  paint-order: stroke;
  stroke: var(--vp-c-bg-soft);
  stroke-width: 3px;
}
.arch-node {
  transition: opacity 0.2s ease;
}
.arch-node.clickable {
  cursor: pointer;
}
.arch-node.clickable .arch-node-label {
  text-decoration: underline;
  text-underline-offset: 3px;
}
.arch-node.dimmed {
  opacity: 0.35;
}
.arch-node.clickable:hover rect {
  filter: brightness(1.05);
  stroke-width: 2.4;
}
.arch-node-label {
  font-size: 14px;
  font-weight: 600;
  fill: var(--vp-c-text-1);
}
.arch-node-sub {
  font-size: 11px;
  fill: var(--vp-c-text-2);
}
.arch-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--vp-c-text-3);
}
</style>
