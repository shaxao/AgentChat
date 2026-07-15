<script lang="ts">
/**
 * AutoCode Agentic Loop 分步动画。
 * 展示 observe -> decide -> act -> verify -> reconcile -> finish 的循环，
 * 支持自动播放、单步前进/后退，每一步高亮当前阶段并展示该阶段的说明与示例产物。
 *
 * 说明：Phase 接口与 defaultPhases 放在普通 <script> 块中，
 * 因为 defineProps 的默认值工厂无法引用 <script setup> 内声明的局部变量
 * （会被提升到 setup() 外部）。
 */
export interface Phase {
  id: string
  label: string
  desc: string
  /** 该阶段的示例行为/产物 */
  sample: string
}

// 默认相位；也允许通过 prop 覆盖
export const defaultPhases: Phase[] = [
  {
    id: 'observe',
    label: 'observe 观察',
    desc: '读取 SystemContext manifest、最近用户输入、检索计划、CI 与 Review 状态。默认只看 manifest 摘要，不拼接全文。',
    sample: 'system_context: 3 sources changed\nlast_user: "修复 parse_args 中的 args.input_file"\nCI: passing · Review: none',
  },
  {
    id: 'decide',
    label: 'decide 决策',
    desc: 'Agent 根据真实上下文自己判断下一步：search / read / edit / bash / answer / ask，而不是被固定阶段牵着走。',
    sample: 'decision = "read"\nreason = "先定位 parse_args 的定义与调用点"',
  },
  {
    id: 'act',
    label: 'act 执行',
    desc: '调用工具执行决策。工具经过 Tool Registry 注册、Permission Engine 校验后运行。',
    sample: 'tool: read_file("src/cli.py")\ntool: edit_file("src/cli.py", patch=...)',
  },
  {
    id: 'verify',
    label: 'verify 验证',
    desc: '写入后必须运行合适的验证（编译 / 测试 / lint），验证结果决定是否需要 reconcile 或重试。',
    sample: 'bash: pytest tests/test_cli.py -q\nresult: 4 passed in 0.82s',
  },
  {
    id: 'reconcile',
    label: 'reconcile 校准',
    desc: '刷新 SystemContext Epoch，根据 diff 判断是否继续循环。只有 hash 变化的上下文才进入 changed sources。',
    sample: 'epoch += 1\nchanged: [src/cli.py]\nemit: system_context_reconciled',
  },
  {
    id: 'finish',
    label: 'finish 完成',
    desc: '验证通过、没有待处理用户输入、没有失败 guardrail 后，任务才判定完成。',
    sample: 'guardrails: ok\npending_user_input: none\nstatus: DONE',
  },
]
</script>

<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue'

const props = withDefaults(
  defineProps<{ phases?: Phase[]; interval?: number }>(),
  { phases: () => defaultPhases, interval: 2200 },
)

const active = ref(0)
const playing = ref(false)
let timer: ReturnType<typeof setInterval> | null = null

const current = computed(() => props.phases[active.value])

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
  playing.value = true
  timer = setInterval(() => {
    active.value = (active.value + 1) % props.phases.length
  }, props.interval)
}

function step(dir: 1 | -1) {
  stop()
  const n = props.phases.length
  active.value = (active.value + dir + n) % n
}

function goto(i: number) {
  stop()
  active.value = i
}

onUnmounted(stop)
</script>

<template>
  <div class="loop">
    <div class="loop-ring">
      <button
        v-for="(p, i) in phases"
        :key="p.id"
        class="loop-node"
        :class="{ active: i === active, done: i < active }"
        @click="goto(i)"
      >
        <span class="loop-idx">{{ i + 1 }}</span>
        <span class="loop-label">{{ p.label }}</span>
        <span v-if="i < phases.length - 1" class="loop-arrow">→</span>
      </button>
    </div>

    <transition name="fade" mode="out-in">
      <div class="loop-detail" :key="current.id">
        <div class="loop-desc">
          <h4>{{ current.label }}</h4>
          <p>{{ current.desc }}</p>
        </div>
        <pre class="loop-sample"><code>{{ current.sample }}</code></pre>
      </div>
    </transition>

    <div class="loop-controls">
      <button @click="step(-1)" title="上一步">◀</button>
      <button class="primary" @click="play">{{ playing ? '⏸ 暂停' : '▶ 自动播放' }}</button>
      <button @click="step(1)" title="下一步">▶</button>
    </div>
  </div>
</template>

<style scoped>
.loop {
  margin: 24px 0;
  padding: 20px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  background: var(--vp-c-bg-soft);
}
.loop-ring {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
}
.loop-node {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1.5px solid var(--vp-c-divider);
  border-radius: 999px;
  background: var(--vp-c-bg);
  cursor: pointer;
  transition: all 0.25s ease;
  font-size: 13px;
  color: var(--vp-c-text-2);
}
.loop-node.active {
  border-color: var(--vp-c-brand-1);
  background: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-weight: 600;
  transform: scale(1.06);
}
.loop-node.done {
  opacity: 0.55;
}
.loop-idx {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--vp-c-default-soft);
  font-size: 11px;
}
.loop-node.active .loop-idx {
  background: var(--vp-c-brand-1);
  color: #fff;
}
.loop-arrow {
  position: absolute;
  right: -14px;
  color: var(--vp-c-text-3);
  pointer-events: none;
}
.loop-detail {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: stretch;
}
@media (max-width: 640px) {
  .loop-detail {
    grid-template-columns: 1fr;
  }
}
.loop-desc h4 {
  margin: 0 0 8px;
  color: var(--vp-c-brand-1);
}
.loop-desc p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.loop-sample {
  margin: 0;
  padding: 12px;
  border-radius: 8px;
  background: var(--vp-c-bg-alt);
  border: 1px solid var(--vp-c-divider);
  font-size: 12.5px;
  overflow-x: auto;
  white-space: pre-wrap;
}
.loop-controls {
  display: flex;
  gap: 8px;
  justify-content: center;
  margin-top: 18px;
}
.loop-controls button {
  padding: 6px 14px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background: var(--vp-c-bg);
  cursor: pointer;
  color: var(--vp-c-text-1);
  transition: all 0.2s;
}
.loop-controls button:hover {
  border-color: var(--vp-c-brand-1);
}
.loop-controls button.primary {
  background: var(--vp-c-brand-1);
  color: #fff;
  border-color: var(--vp-c-brand-1);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
