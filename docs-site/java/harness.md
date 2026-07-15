# Harness 进化引擎

这是整个平台里最有「野心」的一块设计。理解它，你会对「怎么让 AI 系统持续变好」有一个全新的视角。

## 什么是 Harness

先定义清楚。在这个平台里，**harness（脚手架）不是模型本身，而是模型外部所有影响 Agent 行为的东西**：

- 对话 Harness：系统提示词、场景提示词、用户画像、记忆注入、联网搜索策略、技能匹配策略、模型路由、UI 渲染协议
- 工具 Harness：工具 schema、调用条件、权限边界、输入输出格式、失败重试策略
- 工作流 Harness：节点拓扑、AI 驱动模式、SSE 进度、断点续执行
- 代码开发 Harness：SPEC、计划分组、任务执行器、bash 沙箱、代码审查器、阶段验收
- 评估 Harness：质量打分、用户反馈、任务成功率、成本、耗时、安全违规

## 核心判断：不训模型，进化脚手架

这个理念的一句话概括：

> 真正提升效果的关键，不是每次换更强的模型，而是让外部 harness 持续进化。

为什么？因为对于一个已经很强的基座模型，**同样的模型，配不同的脚手架，效果天差地别**。提示词怎么组织、什么时候联网、什么时候调技能、记忆怎么提取更新、失败后怎么沉淀成规则——这些都是 harness 的事，都不需要动模型权重。

这条线上的相关研究：DSPy（自动优化 LM pipeline）、Reflexion（语言反馈记忆）、Voyager（技能库累积）、SWE-agent（为 Agent 设计专用接口）。这个平台把这些思想收敛成一件具体的事：**Harness Evolution Engine，脚手架进化引擎**。

## 目标形态：一个自我改进的循环

不要让 AI 每次「从零发挥」，而是让系统形成这样一个闭环：

<FlowTimeline
  title="Harness 进化闭环"
  :steps='[
    { system: "Java", title: "用户任务", detail: "一次对话 / 一次工作流 / 一次 AutoCode 任务" },
    { system: "Java", title: "当前 harness 执行", detail: "用现有提示词/策略/工具配置跑" },
    { system: "Java", title: "记录完整轨迹 trace", detail: "输入、模型、提示词版本、技能候选、搜索、记忆、回答、用户反应" },
    { system: "Java", title: "判断成功/失败/低质", detail: "相关性、完整性、工具使用合理性、成本" },
    { system: "Java", title: "归因：问题出在哪", detail: "答非所问？该调技能没调？搜索不足？记忆错误？" },
    { system: "Java", title: "生成候选 harness patch", detail: "比如一条新的技能触发规则" },
    { system: "Java", title: "沙盒回放验证", detail: "在历史 trace 上重放，看 patch 是否真的更好" },
    { system: "Java", title: "小流量启用", detail: "灰度，观察真实效果" },
    { system: "Java", title: "固化为规则/技能/SOP", detail: "成功的 patch 沉淀下来，进入下一轮循环" }
  ]'
/>

## 三个阶段的落地路径

这套东西不是一步到位的，设计上分三阶段推进：

### 阶段一：可观测（先不自动改）

先把「发生了什么」记全。每次对话记录一条 `trace`：用户输入、模型、系统提示词版本、场景、技能候选、实际调用的技能、是否触发搜索、注入了哪些记忆、最终回答、用户是继续追问还是停止、点赞还是重试。

再加 `conversation_quality_event`：答非所问、没调用该调的技能、误调用技能、搜索不足、记忆错误、过度推断、回复太长/太短。

::: tip 回到 SSE 对话章节
还记得 [SSE 流式对话](/java/sse-chat) 里，`ChatController` 在流式过程中不断调用 `harnessEvolutionService.startTrace(...)`、`addEvent(...)`、`failTrace(...)` 吗？那就是阶段一在真实代码里的落点——**每一次对话都在为 harness 进化积累原料**。这也是为什么这个 Service 的调用散布在对话主链路各处。
:::

### 阶段二：策略进化

有了数据，让策略从「一次性算法」变成「可进化策略」：

- **技能匹配**：不再只靠 [SkillMatchingService](/java/skills) 的一次打分，而是关键词召回、向量召回、历史记录、用户场景、LLM 小判别器共同投票
- **搜索策略**：记录哪些 query 成功、哪些结果被用户采纳，反过来调整「什么时候该搜」
- **记忆策略**：哪些画像字段被反复验证、哪些被用户纠正，自动调整置信度（呼应 [记忆系统](/java/memory) 的权重机制）
- **场景策略**：不同职业沉淀独立 SOP（餐饮、财务、代码、运营、论文研究……）

### 阶段三：自动候选 patch

系统自己发现问题并提出改进。比如检测到「这类问题本该调用某技能却没调」，就自动生成一条技能触发规则 patch，走沙盒回放 → 灰度 → 固化的流程。

## 为什么这是「操作系统」级的设计

把前面几章串起来看：这个平台已经不是一个「聊天产品」，而是一个 **Agent 操作系统**——模型 + 工具 + 技能 + 工作流 + 记忆 + 代码执行 + 审查 + 权限。

Harness Evolution 是这个操作系统的「自我优化层」：它观测所有子系统的运行轨迹，归因问题，生成改进，并让改进沉淀下来。这也是为什么它在前端有独立的管理页面（`HarnessEvolutionTab`），在后端有独立的 Controller 和 Service。

## 相关源码与文档

- `backend/src/main/java/com/aiplatform/backend/controller/HarnessEvolutionController.java`
- `backend/src/main/java/com/aiplatform/backend/service/HarnessEvolutionService.java` — `startTrace` / `addEvent` / `failTrace` 等
- `app/src/components/admin/HarnessEvolutionTab.tsx` — 前端管理页
- `docs/architecture/Harness 架构.md` — 完整设计思路
- `docs/architecture/harness/` — 演进细节

::: warning 一个诚实的说明
仓库里的 `docs/architecture/Harness 架构.md` 开头有一段坦白：它是基于「harness evolution」这一核心思想和相关公开研究整理的执行计划，而不是对某篇特定论文的复述。本章沿用了这个诚实的态度——讲清楚这套设计的**思想来源和落地路径**，而不夸大它已经全部实现。阅读代码时，阶段一（可观测）的落点最扎实，阶段二、三是持续演进中的方向。
:::

这是 Java 主系统的最后一章。接下来可以转到 [AutoCode 子系统](/autocode/vision)，看另一套完全不同的 Agent 运行时是怎么设计的。
