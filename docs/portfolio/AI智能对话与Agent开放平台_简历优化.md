# AI 智能对话与Agent开放平台 — 简历项目描述（优化版）

> 替换原简历中「AI Chat Platform 智能对话平台」模块，建议作为重点项目单列。

---

## 项目名称

**AI 智能对话与 Agent 开放平台（MuhugoChat）**

## 技术栈

`Spring Boot 3.2` `MyBatis-Plus` `MySQL` `Redis` `SSE/SseEmitter` `ReAct Agent` `Function Calling` `React 18 + Zustand + shadcn/ui` `Docker Compose + Nginx` `OSS（阿里云/腾讯云/MinIO 策略模式）`

## 项目概述

从零架构的 AI 对话平台，核心特色是 **Agent 自主决策与工具调用体系**——Agent 不再是简单问答，而是具备感知-推理-执行循环、多技能调度、记忆管理和成本感知的智能体。已构建完整的开放平台生态（Agent 注册/审核/上下架、技能商店、钱包分成）。

---

## 一、Agent 核心架构 —— 感知 → 推理 → 执行循环

- **ReAct 范式实现**：Agent 在每轮对话中自主决策——理解意图 → 选择工具 → 解析参数 → 执行调用 → 分析结果 → 决定下一步，形成完整的 Think-Act-Observe 循环，而非传统的单次问答模式。
- **Function Calling 完整链路**：后端 `ToolService` 统一管理工具定义与注册，LLM 返回 tool_call 后由 `ToolExecutor` 解析参数、校验类型、执行调用并通过 SSE `tool_call`/`tool_result` 事件实时推流前端；前端渲染工具调用卡片（参数折叠 + 结果摘要），让用户可感知 Agent 的决策过程。
- **降级容错**：当模型原生不支持 Function Calling 时，自动启用 `parsePseudoToolCalls()` 解析 ` ```tool ` 代码块格式的降级调用，确保低能力模型也能使用工具。Vision 能力同理——非 vision 模型通过 Vision 路由自动寻找最便宜的 vision 模型完成图片识别，描述文本注入对话上下文。
- **AgentSessionContext（ThreadLocal）**：每个 Agent 会话维护独立的工具调用上下文，支持 7 个真实业务工具（台账生成、数据查询、报表导出等），工具间共享会话状态，实现多步骤、有状态的任务编排。
- **上下文窗口管理**：基于 Token 预算（9000 字符 / 3000 Token）动态裁剪历史消息，超长时自动生成对话摘要注入 system 消息，保证长对话不丢失关键上下文。

## 二、技能模块 —— 可扩展的 Agent 能力体系

- **内置技能矩阵**：内容生成（Markdown 渲染 + 流式输出）、代码执行（沙箱隔离 + 多语言支持）、台账生成（7 个真实工具 + 模板引擎 + Excel/PDF 导出）、对话创建技能（ZIP 导入 + SKILL.md 规范 + Manifest 校验），每种技能独立注册、独立调度、独立计费。
- **技能商店机制**：技能以 ZIP 包形式分发（须含 SKILL.md 元数据），后端 `SkillImportService` 解析 Manifest、校验结构、注册到 `agent_scripts` 表，前端提供技能浏览/安装/卸载界面。支持 OSS 存储技能包，降低本地存储压力。
- **技能开发规范**：制定 `agent-sdk.ts` Manifest 规范 + 6 章节开发者文档，定义技能的触发条件、参数 Schema、工具列表、脚本入口，第三方可按规范自主开发并上传技能。

## 三、记忆管理系统 —— 三层记忆模型

- **参考 Coze 三层记忆架构**：基础设定（memory_setting）→ 对话记忆（memory_document + memory_index）→ 项目记忆（memory_work_file），4 张数据库表 + MemoryService 统一管理。
- **LLM 摘要**：对话记忆不再粗暴截断，而是调用 LLM（用户消息前500字 + AI回复前1000字 → ≤80字中文摘要），摘要质量远超纯字符截断方案。
- **自动注入**：`ChatController.buildEffectiveSystemPrompt()` 在 Agent 和非 Agent 模式下自动检索相关记忆文档，构建动态 system prompt，实现"越聊越懂你"的个性化体验。

## 四、OSS 存储与性能优化

- **策略+工厂模式 OSS**：`OssService` 接口统一阿里云 OSS / 腾讯云 COS / MinIO，配置从数据库 `oss_config` 表热加载，`OssServiceFactory.refresh()` 运行时切换，无需重启。
- **工具结果外部化**：超阈值工具结果（代码/文件 50KB，数据 20KB，其他 5KB）自动上传 OSS，前端通过 `read_stored_result` 工具按需分页读取，避免 SSE 通道阻塞。
- **文件上传 OSS 优先**：图片/文件先传 OSS 获取 URL 再发送消息，替代 base64 直传，减小请求体；上传失败自动降级为 base64。

## 五、前端渲染架构 —— 流式高性能

- **轻量 Markdown**：`marked`（~50KB）替代 react-markdown 管线（~2MB+），流式阶段用 `<pre>` 纯文本零解析开销，完成后切 Markdown 渲染。
- **消息与渲染双上限**：Store 层 MAX_MESSAGES=50，流式完成自动截断旧消息至 500 字符；渲染层 MAX_RENDER=50，isRecent=最后 10 条。
- **SSE 节流**：500ms + MIN_DELTA=200 字符，每秒最多 2 次 store 更新；React memo 自定义比较（content/isStreaming/error/toolCalls/files），避免无关重渲染。
- **AbortController 管理**：切对话立即取消进行中的请求，ChatInput 卸载时 revokeObjectURL 清理 blob URL。

## 六、开放平台与生态

- **Agent 开放平台**：`agent_registry` 表 + REST API（register/update/delete/list/search/detail/approve/reject），完整审核工作流：pending → approved → active ⇄ disabled，rejected 终态。
- **钱包与分成系统**：`wallet_transaction` 表记录 balance/total_consumed/earned/recharged，支持 revenue_ratio（默认 0.3）分成机制，Agent 开发者可按调用量获得收益。
- **多模型路由 + 能力标签**：`model_channel` 表维护模型渠道（api_key/base_url/priority/capabilities），支持 tool/vision/text/audio/code/reasoning 6 种能力标签映射，Agent 模式自动过滤 tool 能力模型，前端批量编辑支持 set/add/remove 三种模式。
- **费用管控**：每次调用前查询 `model_limit` 阶梯限制，超限模型不出现在候选列表，SSE error 事件实时提示，ApiLog 记录 input/output tokens 及费用估算。

## 七、技术优势总结

| 维度 | 传统方案 | 本平台 |
|------|---------|--------|
| **交互模式** | 单次问答 | Agent 自主决策 + 多轮工具调用 |
| **能力扩展** | 硬编码功能 | 技能商店 + ZIP 导入 + 开发者规范 |
| **上下文管理** | 粗暴截断/丢失 | 三层记忆 + LLM 摘要 + 动态注入 |
| **模型兼容** | 单一厂商 | 多模型路由 + Function Calling/Vision 降级 |
| **性能** | 全量渲染导致卡顿 | 流式零解析 + 双上限 + memo 优化 |
| **成本** | 无感知 | Token 统计 + 阶梯限费 + 最便宜 Vision 路由 |
| **生态** | 封闭 | 开放 API + 审核流程 + 钱包分成 |

---

## 替换指南

将以上内容替换原简历中「AI Chat Platform 智能对话平台」区块。如果简历空间有限，可压缩为以下精简版：

---

### 精简版（适合单栏简历）

**AI 智能对话与 Agent 开放平台** | Spring Boot 3.2 + React 18 + Docker Compose

- **Agent 架构**：实现 ReAct 感知-推理-执行循环，自主决策调用 7+ 业务工具（台账生成/数据查询/报表导出），SSE 实时推流工具调用过程；Function Calling 与 Vision 自动降级，适配不同能力模型。
- **记忆系统**：Coze 三层记忆模型（设定/对话/项目），LLM 摘要替代粗暴截断，动态注入 system prompt 实现个性化体验。
- **技能商店**：ZIP 包分发 + SKILL.md 规范，第三方可自主开发上传；Agent 审核工作流 + 钱包分成（revenue_ratio 0.3）。
- **性能优化**：marked 轻量渲染，流式阶段纯文本零开销，消息/渲染双上限 + SSE 节流 + React memo；工具结果 OSS 外部化，前端分页按需读取。
- **开放平台**：多模型路由 + 6 种能力标签映射，阶梯费用管控，ApiLog Token 统计，OSS 策略+工厂模式三厂商切换。
