---
layout: home

hero:
  name: WorkBuddy 学习手册
  text: 深入源码理解一个真实的多子系统 AI 平台
  tagline: 16.5 万行代码 · 5 种语言 · Java 主系统 + Python AutoCode + Rust 连接器。不是玩具项目，而是一套可运行、可部署的 Agent 操作系统。
  actions:
    - theme: brand
      text: 从这里开始 →
      link: /guide/overview
    - theme: alt
      text: 三系统架构
      link: /guide/architecture
    - theme: alt
      text: AutoCode Agentic Loop
      link: /autocode/agentic-loop

features:
  - icon: ☕
    title: Java 主系统
    details: Spring Boot 3.2 + MyBatis Plus + JWT/RBAC。承载 SSE 流式对话、Provider 架构、模型路由、CacheLedger 计费、记忆五层、技能、工作流引擎 V2。约 4.7 万行。
    link: /java/architecture
    linkText: 深入 Java 系统
  - icon: ⚛️
    title: React 前端
    details: React 18 + Vite + Tailwind + shadcn/ui。13 个页面、流式 Markdown/KaTeX/Shiki 渲染、浏览器内代码执行预览。约 5.3 万行。
    link: /frontend/build
    linkText: 深入前端
  - icon: 🤖
    title: Python AutoCode
    details: FastAPI + Claude Code SDK。自主编程 Agent —— Agentic Loop、SystemContext Epoch、Tool Registry、Permission Engine、Docker 隔离执行。约 2.9 万行。
    link: /autocode/vision
    linkText: 深入 AutoCode
  - icon: 🦀
    title: Rust 本地连接器
    details: Rust + Tauri 桌面应用。把用户本机变成 Agent 的执行环境，处理会话代次、项目授权、本地 Runner 桥接。约 3.4 万行。
    link: /connector/why
    linkText: 深入连接器
  - icon: 🎬
    title: 边读边看
    details: 架构图可点击跳转、Agentic Loop 分步动画、SSE 流式打字机演示、全链路时序动画。抽象概念看得见。
    link: /guide/how-to-read
    linkText: 交互演示说明
  - icon: 🧪
    title: 边读边跑
    details: 内嵌 Pyodide 让你在浏览器里直接运行 Python，iframe 沙箱运行前端片段。改代码、看结果，不用配环境。
    link: /guide/how-to-read
    linkText: Playground 说明
---

<div class="vp-doc" style="max-width: 1152px; margin: 0 auto; padding: 0 24px;">

## 这份手册为谁而写

如果你想学的不是「怎么调 OpenAI 接口」，而是**一个真实的 AI 产品在生产环境里到底由哪些部件拼起来、每个部件为什么这样设计**，那么这份手册就是为你准备的。

我们不回避复杂度。这个项目有历史包袱、有多次重构的痕迹、有跨语言的边界。我们会带你：

- 从**设计动机**出发（为什么要拆成三个子系统？为什么 Agent 要用 Agentic Loop 而不是固定流程？）
- 落到**架构图**（每张图都可点击，跳到对应章节）
- 再深入到**关键源码**（带 `文件:行号`，逐块讲解它在做什么、为什么这么写）
- 最后用**交互演示**把抽象流程变成看得见、跑得起来的东西

## 建议的阅读路线

<div class="reading-paths">

**🎯 我想快速理解全貌（1 小时）**
[这是什么项目](/guide/overview) → [三系统架构](/guide/architecture) → [一次对话的一生](/deep-dive/chat-lifecycle)

**☕ 我是后端工程师，想学 Agent 系统设计**
[分层架构](/java/architecture) → [SSE 流式对话](/java/sse-chat) → [AutoCode Agentic Loop](/autocode/agentic-loop) → [SystemContext Epoch](/autocode/system-context)

**⚛️ 我是前端工程师，想学复杂前端工程**
[Vite 构建体系](/frontend/build) → [流式渲染管线](/frontend/streaming-render) → [代码执行预览](/frontend/code-preview)

**🤖 我只关心 AI Agent 怎么落地**
[AutoCode 愿景](/autocode/vision) → [Agentic Loop](/autocode/agentic-loop) → [Permission Engine](/autocode/permission-engine) → [Docker 隔离执行](/autocode/docker-isolation)

</div>

</div>
