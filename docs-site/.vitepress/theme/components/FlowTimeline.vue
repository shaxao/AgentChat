<script setup lang="ts">
import { ref, computed, onBeforeUnmount } from 'vue'

/**
 * FlowTimeline —— 全链路时序动画
 *
 * 用于「一次对话 / 一次 AutoCode 任务 / 一次计费」这类端到端追踪：
 * 把一串跨系统的步骤按时间线逐个点亮，每步显示所在系统、动作、涉及的
 * 源码位置。支持自动播放 / 手动单步 / 拖动进度。
 *
 * 用法（markdown 中）：
 *   <FlowTimeline :steps="[
 *     { system: 'React', title: '用户发送消息', detail: 'ChatPage 调用 chatApi.stream()', file: 'app/src/pages/ChatPage.tsx' },
 *     { system: 'Nginx', title: '反向代理', detail: '/api/ 转发到 backend:8080', file: 'app/nginx.conf:43' },
 *     ...
 *   ]" />
 */

interface FlowStep {
  system: string
  title: string
  detail?: string
  file?: string
}

const props = withDefaults(defineProps<{
  steps: FlowStep[]
  /** 每步自动播放的间隔（毫秒） */
  interval?: number
  title?: string
}>(), {
  interval: 1400,
  title: '全链路时序',
})

// 当前已点亮到第几步（-1 表示尚未开始）
const active = ref(-1)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

// 不同系统给不同的主题色，让读者一眼看出「现在在哪个系统里」
const systemColor: Record<string, string> = {
  React: '#61dafb',
  Nginx: '#009639',
  Java: '#f89820',
  'Spring Boot': '#6db33f',
  Python: '#3776ab',
  AutoCode: '#a855f7',
  Rust: '#dea584',
  MySQL: '#4479a1',
  Redis: '#dc382d',
  Claude: '#d97757',
}

function colorFor(system: string): string {
  return systemColor[system] || 'var(--vp-c-brand-1)'
}

function stop() {
  playing.value = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function play() {
  if (playing.value) {
    stop()
    return
  }
  if (active.value >= props.steps.length - 1) {
    active.value = -1
  }
  playing.value = true
  timer = setInterval(() => {
    if (active.value >= props.steps.length - 1) {
      stop()
      return
    }
    active.value += 1
  }, props.interval)
}

function step(delta: number) {
  stop()
  const next = active.value + delta
  active.value = Math.max(-1, Math.min(props.steps.length - 1, next))
}

function reset() {
  stop()
  active.value = -1
}

function jumpTo(i: number) {
  stop()
  active.value = i
}

const progress = computed(() => {
  if (props.steps.length === 0) return 0
  return ((active.value + 1) / props.steps.length) * 100
})

onBeforeUnmount(stop)
</script>

<template>
  <div class="flow-timeline">
    <div class="ft-head">
      <span class="ft-title">{{ title }}</span>
      <div class="ft-controls">
        <button class="ft-btn" @click="step(-1)" :disabled="active < 0" title="上一步">‹</button>
        <button class="ft-btn ft-play" @click="play">
          {{ playing ? '⏸ 暂停' : '▶ 播放' }}
        </button>
        <button class="ft-btn" @click="step(1)" :disabled="active >= steps.length - 1" title="下一步">›</button>
        <button class="ft-btn" @click="reset" title="重置">↺</button>
      </div>
    </div>

    <div class="ft-progress">
      <div class="ft-progress-bar" :style="{ width: progress + '%' }" />
    </div>

    <ol class="ft-list">
      <li
        v-for="(s, i) in steps"
        :key="i"
        class="ft-item"
        :class="{ 'is-active': i === active, 'is-done': i < active }"
        @click="jumpTo(i)"
      >
        <div class="ft-dot" :style="{ '--sys-color': colorFor(s.system) }">
          <span class="ft-dot-num">{{ i + 1 }}</span>
        </div>
        <div class="ft-body">
          <div class="ft-row">
            <span class="ft-badge" :style="{ background: colorFor(s.system) }">{{ s.system }}</span>
            <span class="ft-item-title">{{ s.title }}</span>
          </div>
          <p v-if="s.detail" class="ft-detail">{{ s.detail }}</p>
          <code v-if="s.file" class="ft-file">{{ s.file }}</code>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.flow-timeline {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1rem 1.25rem 1.25rem;
  margin: 1.5rem 0;
  background: var(--vp-c-bg-soft);
}

.ft-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}

.ft-title {
  font-weight: 600;
  font-size: 0.95rem;
}

.ft-controls {
  display: flex;
  gap: 0.4rem;
}

.ft-btn {
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  color: var(--vp-c-text-1);
  border-radius: 6px;
  padding: 0.25rem 0.6rem;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
}
.ft-btn:hover:not(:disabled) {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
.ft-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ft-play {
  font-weight: 600;
}

.ft-progress {
  height: 4px;
  background: var(--vp-c-divider);
  border-radius: 2px;
  overflow: hidden;
  margin-bottom: 1rem;
}
.ft-progress-bar {
  height: 100%;
  background: linear-gradient(90deg, var(--vp-c-brand-1), var(--vp-c-brand-2, var(--vp-c-brand-1)));
  transition: width 0.4s ease;
}

.ft-list {
  list-style: none;
  padding: 0;
  margin: 0;
  position: relative;
}
/* 竖直连线 */
.ft-list::before {
  content: '';
  position: absolute;
  left: 15px;
  top: 8px;
  bottom: 8px;
  width: 2px;
  background: var(--vp-c-divider);
}

.ft-item {
  display: flex;
  gap: 0.9rem;
  padding: 0.55rem 0;
  position: relative;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.3s;
}
.ft-item.is-active,
.ft-item.is-done {
  opacity: 1;
}
.ft-item:hover {
  opacity: 0.85;
}

.ft-dot {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 2px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: all 0.3s;
}
.ft-item.is-active .ft-dot {
  border-color: var(--sys-color);
  background: var(--sys-color);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--sys-color) 25%, transparent);
  transform: scale(1.1);
}
.ft-item.is-done .ft-dot {
  border-color: var(--sys-color);
}
.ft-dot-num {
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--vp-c-text-2);
}
.ft-item.is-active .ft-dot-num {
  color: #fff;
}

.ft-body {
  flex: 1;
  min-width: 0;
}
.ft-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.ft-badge {
  color: #fff;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  letter-spacing: 0.02em;
}
.ft-item-title {
  font-weight: 600;
  font-size: 0.9rem;
}
.ft-detail {
  margin: 0.35rem 0 0.25rem;
  font-size: 0.83rem;
  color: var(--vp-c-text-2);
  line-height: 1.5;
}
.ft-file {
  font-size: 0.75rem;
  color: var(--vp-c-brand-1);
  background: var(--vp-c-bg);
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  border: 1px solid var(--vp-c-divider);
}
</style>
