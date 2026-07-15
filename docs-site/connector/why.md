# 为什么需要本地连接器

前面讲的 AutoCode，Agent 是在**服务器上的隔离容器**里干活的。那为什么还需要一个跑在**用户自己电脑上**的桌面程序？这一章先把「为什么存在」讲清楚，再进入它最精彩的设计——[会话代次机制](/connector/session-generation)。

## 一句话定位

> `agent-platform/local-connector` 是一个 Tauri（Rust + WebView）桌面应用，它让浏览器里的 AutoCode 前端，能够操作**用户本地磁盘上的真实项目**。

Web 端（`app/`）跑在浏览器沙箱里，出于安全根本碰不到你电脑的文件系统。而很多真实需求是「帮我改一下我本地这个项目」。连接器就是这座桥。

## 它解决什么问题

| 场景 | 没有连接器 | 有连接器 |
|------|-----------|----------|
| 改本地项目 | 只能把代码传到服务器容器 | 直接在本地磁盘读写 |
| 跑本地命令 | 容器环境，缺你的本地工具链 | 用你本机真实的 node/python/git |
| 敏感代码 | 得上传到服务器 | 代码不出本机 |
| 预览 dev server | 服务器端口映射麻烦 | 直接 `localhost` |

核心价值就一句：**把 Agent 的执行能力，安全地延伸到用户本地环境**，同时代码和执行都不离开本机。

## 整体协作关系

<ArchitectureDiagram
  title="连接器在整体中的位置"
  :nodes="[
    { id: 'web', label: 'Web 前端', sub: 'app/ (浏览器)', x: 40, y: 40, w: 200, h: 70, group: 'frontend' },
    { id: 'backend', label: 'AutoCode 后端', sub: 'FastAPI :8000', x: 330, y: 40, w: 200, h: 70, group: 'python' },
    { id: 'connector', label: '本地连接器', sub: 'Tauri / Rust', x: 40, y: 200, w: 200, h: 70, group: 'rust' },
    { id: 'fs', label: '本地项目', sub: '用户磁盘 / git', x: 330, y: 200, w: 200, h: 70, group: 'infra' },
  ]"
  :edges="[
    { from: 'web', to: 'backend', label: 'HTTP / SSE' },
    { from: 'web', to: 'connector', label: '深链 muhuo-autocode://', dashed: true },
    { from: 'connector', to: 'backend', label: 'WebSocket 会话' },
    { from: 'connector', to: 'fs', label: '读写 / 执行' },
  ]"
/>

关键流程：

1. 用户在 Web 端授权一个本地项目，前端通过**深链**（`muhuo-autocode://…`）唤起桌面连接器。
2. 连接器向后端 `enable(task_id)` 申请建立一个**执行会话**，拿到一个带 token 的 WebSocket 连接。
3. Agent 要读写文件、跑命令时，指令经后端下发给连接器，连接器在本地执行后回传结果。

## 为什么用 Rust + Tauri

- **Tauri**：比 Electron 轻得多（用系统 WebView，不打包整个 Chromium），桌面分发体积小。
- **Rust**：本地文件操作、进程管理、长连接维护，需要一个稳定、无 GC 停顿、并发安全的运行时。下一章你会看到，正是 Rust 的 `Arc<AtomicU64>` 这类并发原语，让「会话代次机制」实现得既优雅又正确。

## 一个反直觉的难点

听起来「唤起桌面程序、连上后端」很简单，但真实世界里最容易出问题的恰恰是**会话切换**：

> 用户从连接器打开一个已授权的项目，浏览器却不自动连接、不打开任务。

这个 bug 的根因涉及 Rust 端的连接闸门设计和前端的重试逻辑，非常典型也非常有教学价值。下一章 [会话代次机制](/connector/session-generation) 会完整拆解它。
