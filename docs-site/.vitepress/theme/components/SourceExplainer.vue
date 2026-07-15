<script setup lang="ts">
import { ref } from 'vue'

/**
 * SourceExplainer —— 源码逐块讲解
 *
 * 左侧是完整源码（通过默认插槽传入一个标准 markdown 代码块，天然安全、带语法高亮），
 * 右侧是一串「解释条」。鼠标悬停 / 点击某条解释时，页面滚动无关，仅高亮该条；
 * 每条解释可标注它对应源码的行号范围，方便读者对照阅读。
 *
 * 为什么代码走 slot 而不是 prop：
 *   在 HTML 属性里塞多行代码字符串（尤其含反引号 / 引号）极易触发 Vue 模板解析错误。
 *   改用默认插槽后，代码写在标准 ```lang fenced block 里，由 VitePress 的 Shiki 高亮，
 *   彻底规避转义地狱。
 *
 * 用法（markdown 中）：
 *   <SourceExplainer
 *     file="backend/.../ChatService.java"
 *     :notes="[
 *       { lines: '1', text: '创建无限超时的 SSE 发射器，0 表示不超时' },
 *       { lines: '2-4', text: '异步线程处理，避免阻塞 Tomcat 请求线程' },
 *     ]">
 *
 *   ```java
 *   SseEmitter emitter = new SseEmitter(0L);
 *   executor.submit(() -> {
 *       // ...
 *   });
 *   ```
 *
 *   </SourceExplainer>
 */

interface Note {
  /** 对应源码的行号或范围，如 "3" 或 "5-8"，纯展示用 */
  lines?: string
  text: string
}

withDefaults(defineProps<{
  notes: Note[]
  file?: string
  title?: string
}>(), {
  title: '源码逐块讲解',
})

const active = ref<number>(-1)

function setActive(i: number) {
  active.value = i
}
function clearActive() {
  active.value = -1
}
</script>

<template>
  <div class="source-explainer" @mouseleave="clearActive">
    <div class="se-head">
      <span class="se-title">{{ title }}</span>
      <code v-if="file" class="se-file">{{ file }}</code>
    </div>

    <div class="se-body">
      <!-- 左：源码，标准 markdown 代码块（Shiki 高亮） -->
      <div class="se-code" :class="{ 'has-active': active >= 0 }">
        <slot />
      </div>

      <!-- 右：解释列表 -->
      <ol class="se-notes">
        <li
          v-for="(n, i) in notes"
          :key="i"
          class="se-note"
          :class="{ 'is-active': i === active }"
          @mouseenter="setActive(i)"
          @click="setActive(i)"
        >
          <span class="se-note-idx">{{ i + 1 }}</span>
          <span class="se-note-body">
            <code v-if="n.lines" class="se-note-lines">L{{ n.lines }}</code>
            <span class="se-note-text">{{ n.text }}</span>
          </span>
        </li>
      </ol>
    </div>
  </div>
</template>

<style scoped>
.source-explainer {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  overflow: hidden;
  margin: 1.5rem 0;
  background: var(--vp-c-bg-soft);
}

.se-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--vp-c-divider);
  flex-wrap: wrap;
}
.se-title {
  font-weight: 600;
  font-size: 0.9rem;
}
.se-file {
  font-size: 0.75rem;
  color: var(--vp-c-brand-1);
}

.se-body {
  display: grid;
  grid-template-columns: 1.4fr 1fr;
  gap: 0;
}
@media (max-width: 768px) {
  .se-body {
    grid-template-columns: 1fr;
  }
}

.se-code {
  overflow-x: auto;
  border-right: 1px solid var(--vp-c-divider);
  min-width: 0;
}
/* slot 里是 VitePress 渲染的 div[class*=language-]，去掉它的外边距让它贴合容器 */
.se-code :deep(div[class*='language-']) {
  margin: 0;
  border-radius: 0;
}
@media (max-width: 768px) {
  .se-code {
    border-right: none;
    border-bottom: 1px solid var(--vp-c-divider);
  }
}

.se-notes {
  list-style: none;
  margin: 0;
  padding: 0.5rem;
}
.se-note {
  display: flex;
  gap: 0.6rem;
  padding: 0.55rem 0.6rem;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  align-items: flex-start;
}
.se-note:hover,
.se-note.is-active {
  background: color-mix(in srgb, var(--vp-c-brand-1) 12%, transparent);
}
.se-note-idx {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--vp-c-brand-1);
  color: #fff;
  font-size: 0.72rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 0.1rem;
}
.se-note-body {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.se-note-lines {
  align-self: flex-start;
  font-size: 0.68rem;
  padding: 0.05rem 0.4rem;
  border-radius: 4px;
  background: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}
.se-note-text {
  font-size: 0.83rem;
  line-height: 1.55;
  color: var(--vp-c-text-1);
}
</style>
