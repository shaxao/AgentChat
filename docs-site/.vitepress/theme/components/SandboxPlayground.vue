<script setup lang="ts">
/**
 * iframe 沙箱运行台。
 * 在 sandbox iframe 内执行 HTML / CSS / JS 片段，与主页面隔离。
 * 用于演示前端渲染逻辑（如流式 Markdown、组件片段）。
 *
 * 安全：iframe 使用 sandbox="allow-scripts"，不带 allow-same-origin，
 * 因此沙箱内脚本无法读取父页面 DOM / cookie / localStorage。
 * 与生产 Nginx 的 CSP（worker-src blob:、iframe 沙箱）策略一致。
 */
import { ref, watch, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 初始 HTML（可含 <style> / <script>） */
    html?: string
    height?: string
  }>(),
  {
    html: `<div id="app" style="font-family: system-ui; padding: 16px;"></div>
<script>
  // 模拟前端流式渲染：逐字符追加，就像 ChatPage 收到 SSE token
  const target = document.getElementById('app');
  const full = '你好，我是运行在 iframe 沙箱里的前端演示。';
  let i = 0;
  const timer = setInterval(() => {
    target.textContent = full.slice(0, ++i);
    if (i >= full.length) clearInterval(timer);
  }, 80);
<\/script>`,
    height: '220px',
  },
)

const editor = ref(props.html)
const frame = ref<HTMLIFrameElement | null>(null)
const runKey = ref(0)

function buildSrcDoc(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;color:#222;background:#fff;}</style>
</head><body>${body}</body></html>`
}

function run() {
  runKey.value++
  if (frame.value) {
    frame.value.srcdoc = buildSrcDoc(editor.value)
  }
}

function reset() {
  editor.value = props.html
  run()
}

onMounted(run)
watch(runKey, () => {})
</script>

<template>
  <div class="sbx">
    <div class="sbx-head">
      <span class="sbx-badge">🧩 前端 · iframe 沙箱</span>
      <span class="sbx-hint">脚本与主站隔离，可安全实验</span>
    </div>

    <div class="sbx-body">
      <textarea v-model="editor" class="sbx-editor" spellcheck="false" />
      <iframe
        ref="frame"
        class="sbx-preview"
        :style="{ height }"
        sandbox="allow-scripts"
        title="sandbox-preview"
      />
    </div>

    <div class="sbx-controls">
      <button class="primary" @click="run">▶ 运行</button>
      <button @click="reset">重置</button>
    </div>
  </div>
</template>

<style scoped>
.sbx {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.sbx-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--vp-c-bg-alt);
  border-bottom: 1px solid var(--vp-c-divider);
}
.sbx-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.sbx-hint {
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.sbx-body {
  display: grid;
  grid-template-columns: 1fr 1fr;
}
@media (max-width: 720px) {
  .sbx-body {
    grid-template-columns: 1fr;
  }
}
.sbx-editor {
  min-height: 220px;
  padding: 14px;
  border: 0;
  border-right: 1px solid var(--vp-c-divider);
  resize: vertical;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  box-sizing: border-box;
}
.sbx-editor:focus {
  outline: none;
}
.sbx-preview {
  width: 100%;
  border: 0;
  background: #fff;
}
.sbx-controls {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--vp-c-divider);
}
.sbx-controls button {
  padding: 6px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: pointer;
  color: var(--vp-c-text-1);
}
.sbx-controls button.primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
</style>
