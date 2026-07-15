# 如何阅读本手册

这一篇教你**用最高效的顺序**读完这份手册，并说明每个交互组件怎么用。

## 三条阅读路线

不同背景的人，入口不同。选一条最贴近你的：

### 路线 A：Java 后端工程师

你熟悉 Spring，想看一个"真实、复杂、上了生产"的业务系统怎么组织。

```
项目全景 → Java 分层架构 → JWT+RBAC → SSE 流式对话
        → Provider 架构 → 模型路由 → CacheLedger 计费
        → 记忆五层 → 技能系统 → 工作流引擎 V2
```

重点体会：**如何在一个 Spring Boot 单体里，把"稳定交易链路"和"高变化 AI 能力"解耦**。

### 路线 B：全栈 / 前端工程师

你想看现代 React 应用怎么处理**流式 UI、状态管理、代码沙箱**这些硬骨头。

```
项目全景 → React 前端(全部 6 篇) → SSE 流式对话(看后端怎么推)
        → 全链路专题：一次对话的一生
```

重点体会：**SSE 流如何一路从 Java 后端穿到 React 组件的打字机效果**。

### 路线 C：想学 Agent 系统设计

你关心的是"AI 怎么自己写代码"这类 Agentic 系统的工程实现。

```
项目全景 → AutoCode 愿景 → Agentic Loop → SystemContext Epoch
        → Tool Registry → Permission Engine → Docker 隔离
        → 编排器 → 全链路专题：一次 AutoCode 任务
```

重点体会：**一个 Agent Runtime 需要哪些基础设施**——上下文管理、工具注册、权限收敛、隔离执行、失败沉淀。

## 每篇的统一结构

为了让你能快速跳读，每一篇技术章节都遵循同一套骨架：

| 段落 | 你能得到什么 |
|------|------------|
| **设计思路** | 为什么这么做、解决了什么痛点、有哪些取舍 |
| **架构图** | 一张可点击 / 可动画的图，先建立整体印象 |
| **关键源码逐块解释** | 真实源码片段 + 逐块注释，标注 `文件:行号` |
| **交互演示** | 能在浏览器里跑一跑、点一点、改一改 |

> [!TIP]
> 看到 `backend/.../ChatController.java:42` 这样的引用，说明这段讲解对应仓库里的**真实源码**。手册里引用的都不是伪代码。

## 交互组件用法

手册里嵌入了 7 类交互组件，鼠标悬停都有提示。这里先让你各试一个。

### 1. 可点击架构图

点击任意节点会跳到对应章节：

<ArchitectureDiagram />

### 2. 分步动画

点"下一步"逐帧观察 Agentic Loop 的每个阶段：

<AgenticLoopAnimation />

### 3. 流式输出演示

点"开始"看 SSE 打字机效果，这正是主站对话页的渲染方式：

<SSEStreamDemo text="这是一段模拟 AI 流式返回的文字，后端通过 SSE 一个 token 一个 token 地推送，前端实时拼接渲染。" />

### 4. Python Playground

真正在你浏览器里跑 Python（首次加载 Pyodide 需几秒），改代码点"运行"：

<PyodidePlayground :code="'def fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint([fib(i) for i in range(10)])'" />

### 5. 前端沙箱 Playground

在隔离的 iframe 里跑 HTML/JS，改完点"运行"看右侧结果：

<SandboxPlayground :html="'<button id=&quot;b&quot;>点我</button>\n<p id=&quot;out&quot;></p>\n<script>\n  document.getElementById(&quot;b&quot;).onclick = () => {\n    document.getElementById(&quot;out&quot;).textContent = &quot;点击时间：&quot; + new Date().toLocaleTimeString()\n  }\n<\/script>'" />

### 6. 全链路时序动画

点"播放"逐步观察一个请求如何穿过各层：

<FlowTimeline
  :steps="[
    { actor: '浏览器', desc: '用户点击发送，POST /api/chat/stream', side: 'left' },
    { actor: 'Nginx', desc: '反向代理转发，关闭缓冲以支持 SSE', side: 'left' },
    { actor: 'Spring Boot', desc: 'JWT 鉴权 → 扣费预检 → 调用模型', side: 'right' },
    { actor: '模型渠道', desc: '流式返回 token', side: 'right' },
    { actor: '浏览器', desc: 'EventSource 逐块接收，打字机渲染', side: 'left' },
  ]"
/>

### 7. 源码逐块解释

代码 + 右侧注释联动高亮：

<SourceExplainer
  file="docs-site 组件演示"
  lang="typescript"
  :blocks="[
    { code: 'const es = new EventSource(url)', note: '建立 SSE 长连接，浏览器原生支持自动重连。' },
    { code: 'es.onmessage = (e) => {\n  buffer += JSON.parse(e.data).delta\n}', note: '每收到一个数据块就追加到缓冲区，delta 是增量文本。' },
    { code: 'es.addEventListener(\'done\', () => es.close())', note: '收到 done 事件后主动关闭连接，释放资源。' },
  ]"
/>

## 准备好了

如果这些组件都能正常交互，说明文档站已经跑起来了。挑一条上面的路线开始吧——不确定就从 [三系统整体架构](/guide/architecture) 开始。
