# 这是什么项目

> 一句话：这是一个把「AI 对话产品」和「自主编程 Agent」缝在一起，再配一个桌面端连接器的**多子系统平台**，约 16.5 万行代码、5 种语言。

如果你是第一次打开这个仓库，大概率会被它的体量和目录数量吓到。这一章的目标只有一个：**让你在 10 分钟内建立起正确的心智模型**，知道每一块是干什么的、彼此怎么协作，然后你就能带着地图去看后面的深度章节。

## 别被杂乱的根目录骗了

仓库根目录下有大量临时文件（`*.log`、`fix_*.py`、`backend-base64.txt`、各种 `autocode_*_check_*` 目录……）——这些是开发过程中产生的调试产物、迁移脚本、一次性工具，**不是项目主体**。真正构成系统的只有下面这几个目录：

| 目录 | 子系统 | 语言/栈 | 规模 | 角色 |
|------|--------|---------|------|------|
| `backend/` | AI 对话平台后端 | Spring Boot 3.2 + MyBatis Plus | ~46.8K 行 Java | **主系统**：稳定业务链路 |
| `app/` | AI 对话平台前端 | React 18 + Vite + Tailwind | ~53.4K 行 TS/TSX | 主系统 UI |
| `agent-platform/backend/` | AutoCode 编程 Agent | FastAPI + Claude Code SDK | ~28.7K 行 Python | **Agent Runtime** |
| `agent-platform/frontend/` | AutoCode 控制台 | Next.js 15 + React 19 | ~3.3K 行 | Agent UI |
| `agent-platform/local-connector/` | 本地连接器 | Rust + Tauri | ~33.6K 行 | 桌面端执行代理 |

其余的 `docs/`（已有架构与面试文档）、`deploy/`（部署脚本与迁移 SQL）、`scripts/`（工具脚本）是支撑设施。

## 三个系统，各司其职

这个平台最重要的设计判断，是把「稳定的业务」和「高速迭代的 Agent 能力」**物理拆开**，用两种语言、两个进程承载：

<ArchitectureDiagram />

<div class="tip custom-block">
  <p class="custom-block-title">点一下上面的方框</p>
  <p>架构图里的每个节点都可以点击，会带你跳到对应的深度章节。先不用记细节，感受一下三块之间的数据流向即可。</p>
</div>

### ① Java 主系统（`backend/` + `app/`）

承载所有**需要稳定、需要交易一致性**的能力：

- 用户登录、JWT、RBAC 权限
- 普通 AI 对话（SSE 流式输出）
- 模型 / 渠道 / 价格 / 调用日志管理
- 记忆系统、技能系统
- 钱包、订阅、套餐、统一计费
- 对 AutoCode 暴露内部模型与用量接口

选 Java + Spring Boot，是因为这条线更像一个「交易系统」——用户付钱、扣费、权限校验都不能出错，Spring 生态在事务、安全、稳定性上最成熟。

### ② Python AutoCode（`agent-platform/backend/`）

承载所有**高变化、需要快速试错**的 Agent 能力：

- 代码开发任务的完整生命周期
- Agentic Loop（`observe → decide → act → verify → reconcile → finish`）
- 工具执行：搜索、读文件、写文件、命令、验证、预览
- 工作区管理、SystemContext Epoch、Workspace Index
- Tool Registry、Permission Engine、Tool Output Store
- Local Runner（把执行下放到用户本地）

选 Python，是因为 Agent Runtime 每周都在改协议、加工具、调 prompt，Python 的迭代速度和 Claude Code SDK 的生态最合适。

### ③ Rust 本地连接器（`agent-platform/local-connector/`）

一个 Tauri 桌面应用。当 AutoCode 需要在**用户自己的机器**上跑命令、读写用户本地项目时，云端的 Python worker 够不着——连接器就是那只「伸到用户本地的手」。它解决的核心问题之一（会话代次机制）在 [Rust 连接器章节](/connector/session-generation)详述。

## 一次请求怎么流动

把三个系统串起来，最直观的是跟着一次请求走一遍。下面是「一次普通 AI 对话」的极简版链路（完整版见 [一次对话的一生](/deep-dive/chat-lifecycle)）：

<FlowTimeline :steps="[
  { actor: '浏览器', label: '用户发消息', detail: 'POST /api/chat/stream，携带 JWT' },
  { actor: 'Nginx', label: '反向代理', detail: '/api/* → backend:8080，关闭 proxy_buffering 以支持 SSE' },
  { actor: 'Spring Boot', label: 'JWT 鉴权 + 扣费预检', detail: '校验 token、检查套餐/钱包余额' },
  { actor: 'Spring Boot', label: '选渠道 + 调模型', detail: 'Provider 架构选择上游，SSE 流式转发' },
  { actor: '浏览器', label: '打字机式渲染', detail: '逐 token 渲染 Markdown/KaTeX/代码高亮' },
  { actor: 'Spring Boot', label: '结算落账', detail: 'CacheLedger 记录用量与扣费' },
]" />

## 你现在应该记住什么

1. **三个系统**：Java 管稳定业务，Python 管 Agent 能力，Rust 管本地执行。
2. **拆分的理由**：稳定性 vs 迭代速度，用语言和进程边界把它们隔开。
3. **根目录很乱**：只看上面表格里的 5 个目录，其余忽略。

准备好后，进入 [三系统整体架构](/guide/architecture) 看更细的协作关系，或直接跳到你感兴趣的子系统。

## 如何使用本手册的交互组件

本手册不是纯文字。你会频繁遇到这几类可交互内容——先认识它们：

- **架构图**：节点可点击跳转。
- **流程时间线**：可播放的分步动画，展示一次请求/任务的全链路。
- **源码解释器**：源码 + 逐块注释，鼠标悬停高亮对应解释。
- **Python Playground**：浏览器内直接运行真实 Python（基于 Pyodide/WASM），可改代码看结果。
- **前端沙箱**：iframe 沙箱内运行 HTML/JS 片段。

下一步阅读建议见 [如何阅读本手册](/guide/how-to-read)。
