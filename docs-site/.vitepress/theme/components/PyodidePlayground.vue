<script setup lang="ts">
/**
 * 浏览器内 Python 运行台。
 * 通过 Pyodide（CPython 编译成 WebAssembly）在浏览器里真正执行 Python，
 * 无需后端。用于讲解 AutoCode 的 Python 侧逻辑时，让读者改代码直接看结果。
 *
 * 说明：Pyodide 运行时约 6MB，首次点击运行时才从 CDN 懒加载，不阻塞页面。
 * 生产 Nginx 的 CSP 已放行 cdn.jsdelivr.net + wasm-unsafe-eval。
 */
import { ref, onMounted } from 'vue'

const props = withDefaults(
  defineProps<{
    /** 初始代码 */
    code?: string
    /** 运行时高度 */
    height?: string
  }>(),
  {
    code: `# 这是在浏览器里真实运行的 Python
def observe_decide_act(context):
    """模拟 AutoCode Agentic Loop 的一次决策"""
    if context.get("has_pending_input"):
        return "answer"      # 有用户输入未处理 -> 优先回答
    if not context.get("verified"):
        return "verify"      # 有改动未验证 -> 先验证
    return "finish"

for ctx in [
    {"has_pending_input": True},
    {"has_pending_input": False, "verified": False},
    {"has_pending_input": False, "verified": True},
]:
    print(ctx, "->", observe_decide_act(ctx))
`,
    height: '',
  },
)

const PYODIDE_VERSION = '0.26.4'
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`

const editor = ref(props.code)
const output = ref('')
const status = ref<'idle' | 'loading' | 'running' | 'ready'>('idle')
const errored = ref(false)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pyodide: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let loadingPromise: Promise<any> | null = null

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve()
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('无法加载 Pyodide 运行时'))
    document.head.appendChild(s)
  })
}

async function ensurePyodide() {
  if (pyodide) return pyodide
  if (loadingPromise) return loadingPromise
  status.value = 'loading'
  loadingPromise = (async () => {
    await loadScript(`${PYODIDE_URL}pyodide.js`)
    // @ts-expect-error 全局由脚本注入
    pyodide = await window.loadPyodide({ indexURL: PYODIDE_URL })
    return pyodide
  })()
  return loadingPromise
}

async function run() {
  errored.value = false
  output.value = ''
  try {
    const py = await ensurePyodide()
    status.value = 'running'
    // 捕获 stdout / stderr
    py.setStdout({ batched: (s: string) => (output.value += s + '\n') })
    py.setStderr({ batched: (s: string) => (output.value += s + '\n') })
    await py.runPythonAsync(editor.value)
    status.value = 'ready'
  } catch (e) {
    errored.value = true
    output.value = String(e)
    status.value = 'ready'
  }
}

function reset() {
  editor.value = props.code
  output.value = ''
  errored.value = false
}

const statusText = {
  idle: '就绪',
  loading: '正在加载 Python 运行时（约 6MB，仅首次）…',
  running: '执行中…',
  ready: '完成',
}

onMounted(() => {
  // 预留：可在此做懒加载观察，这里保持点击才加载以省流量
})
</script>

<template>
  <div class="pyp">
    <div class="pyp-head">
      <span class="pyp-badge">🐍 Python · 浏览器内运行</span>
      <span class="pyp-status" :class="status">{{ statusText[status] }}</span>
    </div>

    <textarea
      v-model="editor"
      class="pyp-editor"
      :style="height ? { height } : {}"
      spellcheck="false"
    />

    <div class="pyp-controls">
      <button class="primary" :disabled="status === 'loading' || status === 'running'" @click="run">
        ▶ 运行
      </button>
      <button @click="reset">重置</button>
    </div>

    <div v-if="output" class="pyp-output" :class="{ err: errored }">
      <div class="pyp-output-head">{{ errored ? '错误' : '输出' }}</div>
      <pre>{{ output }}</pre>
    </div>
  </div>
</template>

<style scoped>
.pyp {
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  background: var(--vp-c-bg-soft);
}
.pyp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: var(--vp-c-bg-alt);
  border-bottom: 1px solid var(--vp-c-divider);
}
.pyp-badge {
  font-size: 12px;
  font-weight: 600;
  color: var(--vp-c-text-2);
}
.pyp-status {
  font-size: 12px;
  color: var(--vp-c-text-3);
}
.pyp-status.loading,
.pyp-status.running {
  color: var(--vp-c-brand-1);
}
.pyp-editor {
  width: 100%;
  min-height: 200px;
  padding: 14px;
  border: 0;
  resize: vertical;
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 1.6;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg);
  box-sizing: border-box;
}
.pyp-editor:focus {
  outline: none;
}
.pyp-controls {
  display: flex;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--vp-c-divider);
}
.pyp-controls button {
  padding: 6px 16px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: pointer;
  color: var(--vp-c-text-1);
}
.pyp-controls button.primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
.pyp-controls button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pyp-output {
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg);
}
.pyp-output-head {
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 600;
  color: var(--vp-c-text-3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.pyp-output.err .pyp-output-head {
  color: #ef4444;
}
.pyp-output pre {
  margin: 0;
  padding: 0 14px 14px;
  font-family: var(--vp-font-family-mono);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--vp-c-text-1);
}
.pyp-output.err pre {
  color: #ef4444;
}
</style>
