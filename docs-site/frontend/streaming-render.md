# 流式渲染管线

上一章末尾我们留了个钩子：真正的流式收发在 `ChatPage` 里。这一章就把它讲透——从浏览器发起请求，到一个字一个字冒出来、还能实时渲染 Markdown/代码/公式的完整链路。这是 [Java SSE 流式对话](/java/sse-chat) 的前端另一半。

## 先感受一下

<SSEStreamDemo
  thinking="用户问的是流式原理，先讲传输、再讲渲染。"
  content="前端用 fetch + ReadableStream 读取字节流，按 SSE 格式切分事件，再把 content 事件里的 token 逐段追加到消息气泡，触发 Markdown 重新渲染。"
/>

## 为什么不用 EventSource

一提到 SSE，很多人第一反应是浏览器原生的 `EventSource`。但这个项目**没用它**，而是用 `fetch + response.body.getReader()` 手动读流。原因很实际：

- `EventSource` **只支持 GET**，不能带请求体。而发消息需要 POST 一个 JSON（内容、模型、文件、参数）。
- `EventSource` 不能自定义请求头，没法带 `Authorization: Bearer <token>`。

所以这里选择用 `fetch` 拿到 `ReadableStream`，自己按 SSE 格式解析。代价是要手写解析循环，收益是完全的控制权。

## 核心循环

<SourceExplainer
  file="app/src/pages/ChatPage.tsx:795"
  :notes="[
    { lines: '1-5', text: 'POST 请求，带上 JSON body。这就是不能用 EventSource 的原因——它只能 GET。' },
    { lines: '9-11', text: '拿到响应体的 reader 和一个 TextDecoder。ReadableStream 给的是字节（Uint8Array），要解码成字符串。' },
    { lines: '13', text: 'buffer 累积还没处理完的半个事件。网络分片不保证按事件边界到达，必须自己攒。' },
    { lines: '15-18', text: '主循环：不断 read()，done 为 true 时结束。decode 时 stream:true 表示还有后续，避免多字节字符被截断。' },
    { lines: '20-22', text: 'SSE 事件之间用空行（\\n\\n）分隔。split 后最后一段可能是不完整的，pop 出来放回 buffer 等下一轮。' }
  ]">

```ts
const response = await fetch(endpoint, {
  method: 'POST',
  headers,
  body: JSON.stringify(payload),
})

const reader = response.body?.getReader()
const decoder = new TextDecoder()
if (!reader) throw new Error('无法读取响应流')

let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break
  buffer += decoder.decode(value, { stream: true })

  const events = buffer.split('\n\n')
  buffer = events.pop() || ''
  // ... 逐个事件解析
}
```

</SourceExplainer>

## 解析事件类型

每个事件块形如 `event: content\ndata: {...}`。解析出 `eventType` 和 `dataStr` 后，按类型分发：

<SourceExplainer
  file="app/src/pages/ChatPage.tsx"
  :notes="[
    { lines: '1-8', text: '把事件块按行拆开，分别提取 event: 和 data: 两行的值。' },
    { lines: '12', text: 'data 是 JSON 字符串，解析成对象。' },
    { lines: '13-22', text: '按事件类型分发：thinking 追加到思考区、content 追加到正文、done 收尾。这三种类型和后端 ChatController 里 emitter.send 的 name 一一对应。' }
  ]">

```ts
const lines = eventBlock.split('\n')
let eventType = ''
let dataStr = ''
for (const line of lines) {
  if (line.startsWith('event:')) eventType = line.slice(6).trim()
  else if (line.startsWith('data:')) dataStr = line.slice(5).trim()
}
if (!eventType || !dataStr) continue

const parsed = JSON.parse(dataStr)
switch (eventType) {
  case 'thinking':
    // 追加思考内容
    break
  case 'content':
    // 追加正文内容，触发 Markdown 重渲染
    break
  case 'done':
    // 标记 isStreaming = false
    break
}
```

</SourceExplainer>

两端事件名对得上，是整条链路能跑通的关键：后端 `ChatController` 用 `SseEmitter.event().name("thinking"|"content"|"user"|"error")` 发，前端就 `case` 对应的名字收。

## 实时 Markdown 渲染

token 是一段段追加的，而每追加一段就要重新渲染成 HTML（代码高亮、公式、表格）。渲染器在 `MarkdownRenderer.tsx`，用了三个库：

| 库 | 作用 |
|------|------|
| `marked` | Markdown → HTML |
| `katex` | 数学公式 `$...$` 渲染 |
| `shiki` | 代码块语法高亮（VS Code 同款引擎） |

::: warning 流式渲染的性能陷阱
每来一个 token 就整段重新 `marked.parse` + 高亮，长回复会明显卡顿。这类渲染器通常要做节流（比如每 N 毫秒或每积累若干字符才重渲一次）、以及对「未闭合的代码块」做容错——流到一半时 ``` 还没配对，不能让高亮器崩掉。读 `MarkdownRenderer.tsx` 时重点关注它怎么处理这两件事。
:::

## 完整链路回顾

把前后端拼起来，一次流式对话的字节是这样流动的：

<FlowTimeline
  title="流式对话：从点击发送到逐字渲染"
  :steps='[
    { system: "React", title: "乐观插入用户消息", detail: "store.sendMessage 立即上屏", file: "app/src/store/index.ts:270" },
    { system: "React", title: "fetch POST 流式端点", detail: "带 Authorization 和 JSON body", file: "app/src/pages/ChatPage.tsx:795" },
    { system: "Nginx", title: "反代且不缓冲", detail: "proxy_buffering off", file: "app/nginx.conf:43" },
    { system: "Spring Boot", title: "SseEmitter 逐 token 推送", detail: "emitter.send(content 事件)", file: "backend/.../ChatController.java" },
    { system: "React", title: "getReader 逐块读取", detail: "ReadableStream + TextDecoder", file: "app/src/pages/ChatPage.tsx:820" },
    { system: "React", title: "按 event 类型分发", detail: "thinking / content / done", file: "app/src/pages/ChatPage.tsx" },
    { system: "React", title: "Markdown 实时渲染", detail: "marked + katex + shiki", file: "app/src/components/chat/MarkdownRenderer.tsx" }
  ]'
/>

下一章 [shadcn 组件体系](/frontend/components)，看这个界面是怎么用一套可复制的组件搭起来的。
