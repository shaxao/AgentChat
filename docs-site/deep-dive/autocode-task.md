# 一次 AutoCode 任务的一生

前一篇追了「一次普通对话」。这一篇追踪复杂度更高的形态：**一次 AutoCode 编程任务**——从用户提需求，到 Agent 自主循环、隔离执行、验证、审查，直到任务完成。

读之前，建议先看过这几章：[Agentic Loop](/autocode/agentic-loop)、[SystemContext Epoch](/autocode/system-context)、[Tool Registry](/autocode/tool-registry)、[Permission Engine](/autocode/permission-engine)、[Docker 隔离执行](/autocode/docker-isolation)、[编排器](/autocode/orchestrator)、[Review Agent](/autocode/review-agent)。这一篇把它们串成一条线。

## 全链路时序

<FlowTimeline
  title="一次 AutoCode 任务的端到端流转"
  :interval="1600"
  :steps='[
    { system: "React", title: "用户提交需求", detail: "AutoCodePage 创建任务，POST /autocode-api/tasks", file: "app/src/pages/AutoCodePage.tsx" },
    { system: "Nginx", title: "反代到 Python", detail: "/autocode-api/ 转发到 autocode-backend:8000", file: "app/nginx.conf:63" },
    { system: "AutoCode", title: "创建工作区", detail: "为任务分配隔离工作区与 .autocode/ 目录", file: "agent-platform/backend/core/docker_manager.py" },
    { system: "AutoCode", title: "初始化 Git 仓库", detail: "GitManager.init，配置 author 身份", file: "agent-platform/backend/core/git_manager.py:44" },
    { system: "AutoCode", title: "建立 SystemContext", detail: "扫描上下文源，建 manifest，发 system_context_indexed", file: "agent-platform/backend/runtime/system_context.py" },
    { system: "AutoCode", title: "进入 Agentic Loop", detail: "observe → decide → act → verify → reconcile", file: "agent-platform/backend/core/agent_orchestrator.py:247" },
    { system: "AutoCode", title: "decide 决策", detail: "Agent 自主判断：search / read / edit / bash", file: "agent-platform/backend/core/agent_orchestrator.py" },
    { system: "AutoCode", title: "Permission 校验", detail: "工具调用前经 PermissionEngine.check", file: "agent-platform/backend/runtime/permission_engine.py:82" },
    { system: "AutoCode", title: "act 执行", detail: "在 Docker 容器内跑 bash / 写文件", file: "agent-platform/backend/core/docker_manager.py:54" },
    { system: "AutoCode", title: "verify 验证", detail: "选择验证命令并运行，分类 CI 失败", file: "agent-platform/backend/core/agent_orchestrator.py:78" },
    { system: "AutoCode", title: "reconcile 校准", detail: "刷新 epoch，算 diff，发 system_context_reconciled", file: "agent-platform/backend/runtime/system_context.py" },
    { system: "AutoCode", title: "Git commit", detail: "阶段产物提交，记录变更", file: "agent-platform/backend/core/git_manager.py" },
    { system: "AutoCode", title: "Review Agent 审查", detail: "artifact gate → static scan → toolchain → AI review", file: "agent-platform/backend/core/review_agent.py:88" },
    { system: "AutoCode", title: "finish 判定", detail: "验证通过 + 无待处理输入 + 无失败 guardrail", file: "agent-platform/backend/core/agent_orchestrator.py:255" },
    { system: "React", title: "前端实时呈现", detail: "SSE 推送任务进度、文件变更、预览", file: "app/src/pages/AutoCodePage.tsx" }
  ]'
/>

## 和普通对话的本质区别

把这条线和上一篇的对话链路并排看，区别一目了然：

| 维度 | 普通对话 | AutoCode 任务 |
|------|----------|---------------|
| 调用次数 | 一次 LLM 调用 | 多轮循环，几十次工具调用 |
| 谁决定下一步 | 固定流程 | Agent 自己 decide |
| 执行环境 | 无（纯文本生成） | Docker 隔离容器 |
| 上下文管理 | 历史消息拼接 | SystemContext manifest + epoch 增量 |
| 权限 | 无工具，无需校验 | 每次工具调用经 PermissionEngine |
| 验证 | 无 | verify 阶段强制运行验证命令 |
| 质量把关 | 无 | Review Agent 多层审查 |
| 完成条件 | LLM 输出结束 | 验证通过 + 无待办 + 无失败 guardrail |

一句话：**对话是「一次调用」，AutoCode 是「自主决策的循环」**。中间那一档「编排好的多次调用」是[工作流](/java/workflow)。理解这个复杂度梯度，是理解整个平台的关键。

## 两个系统在这里如何协作

这条链路跨越了 Python AutoCode 和 Java 主系统两个进程：

- **Python 侧**：负责 Agent Runtime 的全部——循环、工具、隔离执行、上下文、审查。这些是高频演进的部分。
- **Java 侧**：在 AutoCode 需要模型能力和用量上报时被回调。见下一篇 [一次计费的流转](/deep-dive/billing-flow)，那里会讲 AutoCode 的工具用量如何通过 CacheLedger 落到 Java 的台账里。

这正是[三系统整体架构](/guide/architecture)里「两个后端为什么要分开」的实战体现：稳定的交易链路在 Java，善变的 Agent Runtime 在 Python，两者用内部接口桥接。

## 关键设计回顾

这条链路里藏着几个前面章节讲过的精华设计，串起来再体会一遍：

1. **默认自主，可手动降级**（[Agentic Loop](/autocode/agentic-loop)）——`_should_use_agentic_execution` 的两道否决门。
2. **只关注增量**（[SystemContext Epoch](/autocode/system-context)）——manifest + hash + epoch，避免 prompt 随任务膨胀。
3. **分层防御**（[Permission Engine](/autocode/permission-engine)）——角色 → bash 禁令 → 路径穿越 → 策略，四道门。
4. **执行隔离**（[Docker 隔离执行](/autocode/docker-isolation)）——容器内跑命令，路径限制在 /workspace。
5. **质量门槛**（[Review Agent](/autocode/review-agent)）——artifact gate 先挡住「什么都没产出」的空转。

把这五个设计放在一条时间线上看，你会发现它们不是孤立的功能，而是共同支撑「让 AI 自己动手完成整个项目」这个愿景的一套协作机制。
