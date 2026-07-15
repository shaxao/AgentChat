# 愿景与定位

AutoCode 是整个平台里最「激进」的子系统。普通 AI 对话是「你问，它答」；AutoCode 的目标是——**你提需求，它自己动手把整个项目做完**。

> 让 AI 不只是给建议，而是自己动手完成整个项目。用户提出需求 → AI 理解拆解 → 多 Agent 并行执行 → 实时预览 → 用户验收 → 一键部署。

## 它在整个平台里的位置

回顾 [三系统整体架构](/guide/architecture)，平台里有三种「AI 执行」形态，复杂度递增：

| 形态 | 在哪 | 特征 |
|------|------|------|
| 普通对话 | Java | 一问一答，一次调用 |
| 工作流 | Java | 编排好的多次调用，节点拓扑固定 |
| **AutoCode 任务** | **Python** | **自主决策的循环，自己决定下一步做什么** |

AutoCode 就是第三种。它跑在独立的 Python（FastAPI）进程里，用 Claude Code SDK 驱动一个 **Agentic Loop**，在隔离的工作区中读写文件、跑命令、做验证，直到任务真正完成。

## 为什么单独用 Python 写

这是全项目最核心的架构决策。Java 主系统承载稳定的交易链路（登录、对话、付费），而 Agent Runtime 是「天天在改」的高变化区域：

- **故障隔离**：AutoCode 跑崩了，不影响用户登录、对话、付费。
- **独立迭代**：Python 侧单独重启、单独灰度，不用重新构建整个 Java 应用。
- **生态自由**：直接吃 Claude Code SDK、Python 脚本生态。

代价是跨进程通信。AutoCode 需要模型能力和用量上报时，回调 Java 暴露的内部 API（见 [CacheLedger 计费桥接](/java/cache-ledger)）。

## 核心能力池

按 README 规划，AutoCode 设计了多个专职 Agent 并行协作：

| Agent | 职责 | 核心能力 |
|-------|------|---------|
| Frontend Agent | 前端 UI 开发 | file-write · read · bash · preview |
| Backend Agent | API / 数据库 / 业务逻辑 | file-write · read · bash · docker |
| DevOps Agent | CI/CD / 部署 / 容器化 | docker · bash · deploy · rollback |
| Researcher Agent | 技术调研 / 方案选型 | web-search · read · analyze |

## 后端模块地图

`agent-platform/backend/` 约 2.9 万行 Python，分成四层。先建立整体印象，后面每个模块都有独立章节：

<ArchitectureDiagram
  title="AutoCode 后端模块分层"
  :width="880"
  :height="440"
  :nodes="[
    { id: 'api', label: 'api/', sub: 'FastAPI 路由层', x: 40, y: 30, w: 200, h: 60, group: 'python', link: '/autocode/orchestrator' },
    { id: 'core', label: 'core/', sub: '编排 · LLM · Docker · Git', x: 40, y: 150, w: 200, h: 60, group: 'python', link: '/autocode/orchestrator' },
    { id: 'runtime', label: 'runtime/', sub: 'Agentic Loop 运行时', x: 340, y: 90, w: 220, h: 60, group: 'python', link: '/autocode/agentic-loop' },
    { id: 'services', label: 'services/', sub: '任务队列 · 记忆 · 计费', x: 40, y: 270, w: 200, h: 60, group: 'python' },
    { id: 'sc', label: 'system_context.py', sub: 'SystemContext Epoch', x: 640, y: 30, w: 200, h: 60, group: 'python', link: '/autocode/system-context' },
    { id: 'tr', label: 'tool_registry.py', sub: 'Tool Registry', x: 640, y: 130, w: 200, h: 60, group: 'python', link: '/autocode/tool-registry' },
    { id: 'pe', label: 'permission_engine.py', sub: 'Permission Engine', x: 640, y: 230, w: 200, h: 60, group: 'python', link: '/autocode/permission-engine' },
    { id: 'loop', label: 'agent_loop.py', sub: '主循环', x: 640, y: 330, w: 200, h: 60, group: 'python', link: '/autocode/agentic-loop' },
  ]"
  :edges="[
    { from: 'api', to: 'core' },
    { from: 'core', to: 'runtime', label: '驱动' },
    { from: 'core', to: 'services' },
    { from: 'runtime', to: 'sc' },
    { from: 'runtime', to: 'tr' },
    { from: 'runtime', to: 'pe' },
    { from: 'runtime', to: 'loop' },
  ]"
/>

四层职责：

- **`api/`** — FastAPI 路由，对外暴露任务、工作区、终端、Git、部署等 HTTP/SSE 接口。
- **`core/`** — 编排核心：`agent_orchestrator.py`（编排器）、`llm_client.py`（模型客户端）、`docker_manager.py`（容器池）、`git_manager.py`、`model_router.py`、`review_agent.py` 等。
- **`runtime/`** — Agentic Loop 运行时精华：`agent_loop.py`、`system_context.py`、`context_manager.py`、`tool_registry.py`、`permission_engine.py`、`tool_output_store.py`、`checkpoints.py`。
- **`services/`** — 支撑服务：任务队列、任务仓库、记忆服务、计费桥接客户端、终端管理、本地运行器管理。

## 安全策略

AutoCode 要真的执行代码，安全边界必须收紧（README 规定）：

- 删除/覆盖文件：每次操作需用户手动确认
- 代码执行：隔离 Docker 容器内运行
- 网络隔离：容器内禁止访问内网
- 资源限制：CPU / 内存 / 磁盘配额
- 操作审计：所有 git commit 和文件操作记录

这套安全策略的落地实现，见 [Permission Engine](/autocode/permission-engine) 和 [Docker 隔离执行](/autocode/docker-isolation)。

## 下一步

理解了定位，接下来最重要的是搞懂它的「心脏」——[Agentic Loop](/autocode/agentic-loop)：AutoCode 是怎么在没有固定流程的情况下，自己决定下一步做什么的。
