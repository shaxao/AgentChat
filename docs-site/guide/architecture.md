# 三系统整体架构

上一章你已经知道了「有三个系统」。这一章我们把它们之间的**边界、通信方式、数据流向**讲清楚，让你在读任何一个子系统的深度章节时，都能把它放回全局。

## 全景图

下面这张图是可交互的：把鼠标移到节点上会高亮，点击带下划线的节点可直接跳转到对应的深度章节。

<ArchitectureDiagram
  title="WorkBuddy 三系统全景"
  :width="880"
  :height="560"
  :nodes="[
    { id: 'user', label: '浏览器', sub: 'React SPA', x: 350, y: 20, group: 'user' },
    { id: 'nginx', label: 'Nginx', sub: '统一入口 :80', x: 350, y: 130, group: 'infra' },
    { id: 'java', label: 'Spring Boot 后端', sub: ':8080 · 业务/对话/计费', x: 60, y: 250, w: 230, group: 'java', link: '/java/architecture' },
    { id: 'autocode', label: 'Python AutoCode', sub: ':8000 · Agent Runtime', x: 340, y: 250, w: 230, group: 'python', link: '/autocode/vision' },
    { id: 'connector', label: 'Rust 连接器', sub: 'Tauri 桌面端', x: 620, y: 250, w: 200, group: 'rust', link: '/connector/why' },
    { id: 'mysql', label: 'MySQL', sub: ':3306 · 53 张业务表', x: 120, y: 400, group: 'infra' },
    { id: 'redis', label: 'Redis', sub: ':6379 · 缓存/验证码', x: 360, y: 400, group: 'infra' },
    { id: 'llm', label: '模型渠道', sub: 'OpenAI/Claude/…', x: 600, y: 400, group: 'infra' },
  ]"
  :edges="[
    { from: 'user', to: 'nginx', label: 'HTTP/SSE' },
    { from: 'nginx', to: 'java', label: '/api/*' },
    { from: 'nginx', to: 'autocode', label: '/autocode-api/*' },
    { from: 'java', to: 'mysql' },
    { from: 'java', to: 'redis' },
    { from: 'java', to: 'llm', label: '流式调用' },
    { from: 'autocode', to: 'java', label: '内部接口回调', dashed: true },
    { from: 'connector', to: 'autocode', label: '本地执行', dashed: true },
  ]"
/>

## 进程与端口

三个系统在运行时是**独立进程**，通过 HTTP / SSE 通信，Nginx 在最前面做统一入口：

| 进程 | 监听 | 谁来访问 | 反代路径 |
|------|------|----------|----------|
| Nginx（前端容器） | `:80` | 浏览器 | — |
| Spring Boot 后端 | `:8080` | Nginx | `/api/*` |
| Python AutoCode 后端 | `:8000` | Nginx | `/autocode-api/*` |
| MySQL | `:3306` | 两个后端 | — |
| Redis | `:6379` | Spring Boot | — |

Nginx 的关键配置（`app/nginx.conf`）有两点值得注意：

1. **SSE 支持**：`/api/` 和 `/autocode-api/` 都设了 `proxy_buffering off` + `proxy_read_timeout 600s`，否则流式输出会被缓冲住，用户看不到「逐字冒出来」的效果。
2. **CSP 放行 WASM**：`Content-Security-Policy` 里显式放行了 `cdn.jsdelivr.net` 和 `wasm-unsafe-eval`——这是前端「浏览器内跑代码」功能（Pyodide）的硬性要求。本学习站的 Python Playground 复用的正是同一套策略。

## 两个后端为什么要分开

这是全项目最核心的架构决策，值得单独强调。

> Java 更适合承载业务系统的稳定交易链路；Python 更适合快速迭代 Agent Runtime、工具编排和本地执行能力。

拆分带来的直接好处：

- **故障隔离**：AutoCode 的 Agent Runtime 天天在改，就算跑崩了，也不影响用户登录、对话、付费这些交易链路。
- **独立迭代与发布**：Python 侧可以单独重启、单独灰度，不用重新构建整个 Java 应用。
- **技术选型自由**：Agent 侧能直接吃 Claude Code SDK、Python 的脚本生态；业务侧稳稳待在 Spring 生态里。

代价是引入了跨进程通信和一部分数据/契约的重复。项目用**内部接口**解决：AutoCode 需要模型能力和用量上报时，回调 Java 暴露的内部 API（见 [CacheLedger 计费桥接](/java/cache-ledger)）。

## 数据的两条主线

### 业务数据（MySQL，Java 主写）

53 张实体表，覆盖用户、订阅、钱包、渠道、价格、日志、技能、工作流、记忆等。Java 主系统是主要写入方，AutoCode 只在计费/用量场景通过内部接口间接触达。

### Agent 运行时状态（AutoCode 自管）

AutoCode 的任务状态、SystemContext manifest、工具输出、检查点等，由 Python 侧自己管理（部分落 MySQL、部分落工作区文件系统 `.autocode/`）。这套「运行时状态」的设计是 AutoCode 的精华，见 [SystemContext Epoch](/autocode/system-context)。

## 三种「AI 执行」形态

同一个平台里其实存在三种不同层次的 AI 执行，别混淆：

| 形态 | 在哪 | 特征 |
|------|------|------|
| **普通对话** | Java | 一问一答，SSE 流式，可能触发技能/搜索/记忆 |
| **工作流** | Java | 预定义节点拓扑，可含 AI 节点，SSE 推进度，支持断点续跑 |
| **AutoCode 任务** | Python | 开放式 Agentic Loop，自己决定下一步做什么，直到验证通过 |

三者复杂度递增：对话是「一次调用」，工作流是「编排好的多次调用」，AutoCode 是「自主决策的循环」。理解这个梯度，是理解整个平台的关键。

## 部署拓扑

生产部署把三块分到不同服务器（见 `deploy/deploy.sh`）：

- **Server A**：Java 后端 + Nginx + 前端静态资源（也是本学习站 `/learn/` 的宿主）
- **Server B**：AutoCode Python worker + 工作区
- **Server C**：MySQL

本学习站作为静态资源，构建后同步到 Server A 的 `/var/www/muhugochat-frontend/learn/`，与主前端共存。详见 [本地启动指南](/guide/getting-started) 的部署小节。

## 下一步

- 想先看技术选型清单 → [技术栈全景](/guide/tech-stack)
- 想把项目跑起来 → [本地启动指南](/guide/getting-started)
- 想直接钻某个子系统 → 顶部导航选 Java / React / AutoCode / Rust
