# Harness 架构

我先说明一个边界：我没能直接读取 Coze 分享页内容，公开搜索里也没有稳定检索到题为《Don’t Train the Model, Evolve the Harness》的原文。因此下面不假装“已经读到原文”，而是基于你给出的论文/实验名、harness evolution 这个核心思想，以及相关公开研究整理执行计划。相关方向可以参考 DSPy、Reflexion、Voyager、SWE-agent，以及近期 HarnessFix/RHO/Bayesian-Agent 这类“优化外部脚手架而非训练模型”的研究。

**核心判断**
这个理念非常适合你的系统。你的平台现在已经不是单纯聊天产品，而是“模型 + 工具 + 技能 + 工作流 + 记忆 + 代码执行 + 审查 + 权限”的 Agent 操作系统。真正提升效果的关键，不是每次换更强模型，而是让外部 harness 持续进化：

- 提示词怎么组织
- 什么时候联网搜索
- 什么时候调用技能/工作流
- 记忆如何提取、更新、遗忘
- 代码开发如何规划、执行、审查、修复
- 工具权限如何收敛
- 失败后如何沉淀成可复用规则

这件事可以命名为：**Harness Evolution Engine，脚手架进化引擎**。

**一、Harness 在你系统里的定义**
在你的平台里，harness 不只是 prompt，而是模型外部所有影响 Agent 行为的东西：

- 对话 Harness：系统提示词、场景提示词、用户画像、记忆注入、联网搜索策略、技能匹配策略、模型路由、UI 渲染协议。
- 工具 Harness：工具 schema、调用条件、权限边界、输入输出格式、安全策略、失败重试策略。
- 工作流 Harness：节点拓扑、普通工具模式、AI 驱动模式、SSE 进度、断点续执行。
- 代码开发 Harness：SPEC、计划分组、原型确认、任务执行器、文件工具、bash 沙箱、代码审查器、测试命令、阶段验收。
- 评估 Harness：质量打分、用户反馈、任务成功率、成本、耗时、安全违规、是否需要人工确认。

**二、目标形态**
不要让 AI 每次“从零发挥”，而是让系统形成这种循环：

```
用户任务
  -> 当前 harness 执行
  -> 记录完整轨迹
  -> 判断成功/失败/低质
  -> 归因问题出在哪里
  -> 生成候选 harness patch
  -> 沙盒回放验证
  -> 小流量启用
  -> 成功后固化为规则/技能/SOP
```

这和 Reflexion 的“语言反馈记忆”、Voyager 的“技能库累积”、SWE-agent 的“为 Agent 设计专用接口”、DSPy 的“自动优化 LM pipeline”是一条线上的思想。

**三、正常对话落地计划**
第一阶段先做“可观测”，不急着自动改：

- 每次对话记录 `trace`：用户输入、模型、系统提示词版本、场景、技能候选、实际调用技能、搜索触发、记忆注入、最终回答、用户是否继续追问/停止/点赞/重试。
- 增加 `conversation_quality_event`：答非所问、没调用技能、误调用技能、搜索不足、记忆错误、过度推断、回复太长/太短。
- 给每条回答打轻量评分：相关性、完整性、工具使用合理性、记忆使用正确性、成本。

第二阶段做“策略进化”：

- 技能匹配不再只靠一次算法，而是形成可进化策略：关键词召回、向量召回、历史 WORK.md、用户场景、LLM 小判别器共同投票。
- 联网搜索策略进化：记录哪些 query 成功、哪些结果被用户点击、哪些搜索导致回答变好。
- 记忆策略进化：哪些画像字段被反复验证，哪些字段被用户纠正，自动调整置信度和更新规则。
- 场景策略进化：不同职业场景沉淀独立 SOP，例如餐饮、财务、代码、运营、论文研究。

第三阶段做“自动候选 patch”：

- 发现“技能该调用没调用”时，自动生成技能触发规则 patch。
- 发现“联网搜索经常遗漏”时，自动生成搜索触发规则 patch。
- 发现“用户总嫌回答啰嗦”时，更新用户画像和用户系统提示词。
- 发现“某类问题常失败”时，生成场景 SOP 或推荐工作流。

所有 patch 先进入后台审核，不能直接改全局行为。

**四、代码开发落地计划**
代码开发更适合 harness evolution，因为它有明确结果：有没有生成代码、有没有通过测试、审查是否通过、用户是否满意。

建议分成 6 层：

1. 任务规划 Harness
   记录计划是否合理、任务是否过度拆分、是否遗漏后端/移动端/安全/数据库迁移。失败后优化 planner prompt 和分组规则。
2. 原型 Harness
   对“不需要前端”的任务跳过原型；对需要 UI 的任务沉淀页面类型模板；原型保存到工作区 UI 原型库。
3. 执行 Harness
   记录每个工具调用、文件变更、命令输出、空响应、无代码生成、重复执行。失败后优化 Agent SOP。
4. 安全 Harness
   文件和 bash 工具强制 workspace 隔离。任何越权读取、越权命令、路径穿越都记录为安全事件，永远不能靠提示词解决。
5. 审查 Harness
   每组任务完成后必须审查，且审查必须看到真实 diff、真实文件、测试结果。0 文件变更不能通过。
6. 修复 Harness
   审查失败后自动生成修复任务，修复后回放测试，不允许直接“口头通过”。

**五、核心数据表建议**
新增几类表：

- `agent_trace`：完整运行轨迹。
- `harness_version`：每套 prompt/SOP/工具策略/审查规则版本。
- `harness_patch`：候选改动，状态为 draft/reviewing/approved/rejected/rolled_back。
- `harness_eval_case`：从真实失败中沉淀的回放用例。
- `harness_metric_snapshot`：按版本统计成功率、成本、耗时、用户满意度、安全事件。
- `agent_failure_case`：失败归因，例如 tool_policy、skill_match、memory、planning、review、security。

**六、后台管理界面**
后台要有一个“Agent 进化中心”：

- Trace 列表：查看每次任务完整轨迹。
- 失败聚类：按失败原因自动聚类。
- Harness 版本：查看当前对话/代码开发/工作流各自版本。
- Patch 审核：AI 提议的规则改动必须人工批准。
- 回放测试：选定历史任务，用新 harness 跑一遍，对比旧版本。
- 灰度发布：只对 5% 用户或指定管理员启用。
- 回滚：任何 harness 改动都能一键回滚。

**七、最小可行版本**
我建议先别一口气做全自动进化，先做 P0-P3：

- P0：统一 trace 记录，对话和代码开发都接入。
- P1：代码开发审查和执行失败归因。
- P2：技能/搜索/记忆的触发效果统计。
- P3：后台生成“候选 harness patch”，但人工确认后才生效。

等稳定后再做自动 A/B 和灰度。

**八、关键安全原则**
这个系统必须非常克制：

- 不能让 AI 直接修改全局系统提示词。
- 不能让 AI 直接放宽工具权限。
- 安全规则只能收紧，放宽必须人工审批。
- 用户隐私数据不能进入全局训练/全局进化，只能做脱敏聚合。
- 代码开发 trace 不能跨用户复用原始内容，只能复用抽象失败模式。
- 所有 harness patch 必须可审计、可回滚、可比较效果。

**九、参考依据**

- [DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines](https://arxiv.org/abs/2310.03714)
- [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366)
- [Voyager: An Open-Ended Embodied Agent with Large Language Models](https://arxiv.org/abs/2305.16291)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793)
- [From Failed Trajectories to Reliable LLM Agents: Diagnosing and Repairing Harness Flaws](https://arxiv.org/abs/2606.06324)
- [Retrospective Harness Optimization](https://arxiv.org/abs/2606.05922)
- [Bayesian-Agent: Posterior-Guided Skill Evolution for LLM Agent Harnesses](https://arxiv.org/abs/2606.08348)

