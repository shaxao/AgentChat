<script setup lang="ts">
/**
 * SSE 流式对话演示。
 * 模拟后端 text/event-stream：一个 token 一个 token 地推送，
 * 左侧展示"网络层"收到的原始 SSE 帧，右侧展示前端渲染出的对话气泡。
 * 用于讲解 Java 后端 SseEmitter -> Nginx proxy_buffering off -> 前端 EventSource 的全链路。
 */
import { ref, onUnmounted, computed } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 要"流式"输出的完整回答 */
    answer?: string
    /** 每个 chunk 的间隔（毫秒） */
    speed?: number
  }>(),
  {
    answer:
      '流式输出的核心是服务端用 SseEmitter 持有连接，模型每产出一个 token 就 emitter.send() 推送一帧，' +
      '中间的 Nginx 必须关闭 proxy_buffering，否则帧会被缓冲成一整块，前端就看不到"逐字出现"的效果了。',
    speed: 55,
  },
)

// 把答案切成"token"（这里按 2~4 个字符一组模拟）
function tokenize(text: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < text.length) {
    const len = 1 + Math.floor(Math.random() * 3)
    out.push(text.slice(i, i + len))
    i += len
  }
  return out
}

const rendered = ref('')
const frames = ref<string[]>([])
const running = ref(false)
const finished = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

const framePreview = computed(() => frames.value.slice(-8))

function reset() {
  if (timer) clearTimeout(timer)
  timer = null
  rendered.value = ''
  frames.value = []
  running.value = false
  finished.value = false
}

function start() {
  reset()
  running.value = true
  const tokens = tokenize(props.answer)
  let idx = 0
  const tick = () => {
    if (idx >= tokens.length) {
      frames.value.push('data: [DONE]')
      running.value = false
      finished.value = true
      return
    }
    const tk = tokens[idx++]
    rendered.value += tk
    // 模拟真实 SSE 帧：data: {"choices":[{"delta":{"content":"..."}}]}
    frames.value.push(`data: {"delta":${JSON.stringify(tk)}}`)
    timer = setTimeout(tick, props.speed)
  }
  tick()
}

onUnmounted(reset)
</script>

<template>
  <div class="sse">
    <div class="sse-cols">
      <div class="sse-net">
        <div class="sse-net-head">
          <span class="dot" :class="{ live: running }" />
          text/event-stream
        </div>
        <div class="sse-frames">
          <div v-if="!frames.length" class="sse-empty">点击「开始流式」查看 SSE 帧</div>
          <div v-for="(f, i) in framePreview" :key="i" class="sse-frame">{{ f }}</div>
        </div>
      </div>

      <div class="sse-view">
        <div class="sse-view-head">前端渲染</div>
        <div class="sse-bubble">
          {{ rendered }}<span v-if="running" class="caret" />
          <span v-if="finished" class="sse-done">✓</span>
        </div>
      </div>
    </div>

    <div class="sse-controls">
      <button class="primary" :disabled="running" @click="start">
        {{ running ? '流式输出中…' : '▶ 开始流式' }}
      </button>
      <button :disabled="running" @click="reset">重置</button>
    </div>
  </div>
</template>

<style scoped>
.sse {
  margin: 24px 0;
  padding: 18px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.sse-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
@media (max-width: 640px) {
  .sse-cols {
    grid-template-columns: 1fr;
  }
}
.sse-net,
.sse-view {
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  overflow: hidden;
}
.sse-net-head,
.sse-view-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
  border-bottom: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-alt);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--vp-c-text-3);
}
.dot.live {
  background: #22c55e;
  animation: pulse 1s infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.3;
  }
}
.sse-frames {
  padding: 10px 12px;
  min-height: 160px;
  font-family: var(--vp-font-family-mono);
  font-size: 11.5px;
}
.sse-frame {
  color: var(--vp-c-brand-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 1px 0;
}
.sse-empty {
  color: var(--vp-c-text-3);
  font-size: 12px;
}
.sse-bubble {
  padding: 12px;
  min-height: 160px;
  font-size: 14px;
  line-height: 1.7;
  color: var(--vp-c-text-1);
}
.caret {
  display: inline-block;
  width: 7px;
  height: 15px;
  background: var(--vp-c-brand-1);
  vertical-align: text-bottom;
  animation: blink 0.9s step-end infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.sse-done {
  margin-left: 6px;
  color: #22c55e;
  font-weight: 700;
}
.sse-controls {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.sse-controls button {
  padding: 6px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: pointer;
  color: var(--vp-c-text-1);
}
.sse-controls button.primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
.sse-controls button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
