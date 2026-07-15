# 工作流引擎 V2 P0 审计结论

## 审计日期

2026-07-05

## 审计范围

- 后端工作流实体、DTO、DSL 解析器、执行器、调度器。
- 前端工作流列表、DSL 编辑、可视化画布、执行历史。
- 文件上传、工作文件、OSS 存储、ASR 能力。
- 自定义工具、内联代码、统一工具调用服务。
- 部署层上传限制与长连接配置。

## 关键结论

### 1. 当前工作流是可兼容扩展的旧 DSL

现有表：

- `workflow`：保存用户工作流定义，核心字段是 `dsl`、`cron_expr`、`status`。
- `workflow_execution`：保存执行记录，核心字段是 `input_json`、`output_json`、`step_results`。

现有 DSL 已支持：

- `trigger.type/value`
- `steps[].id/tool/description/condition/args`
- `steps[].code/language`
- `dataMode: auto | template | ai`

注意：当前 `dataMode=ai` 只用于“根据前序输出生成当前步骤参数”，不是完整 AI 驱动流程控制。它不能自行决定下一步、不能动态选择工具、不能插入新步骤。

### 2. 当前执行器是确定性循环，不是真正 Agent 编排

`WorkflowScheduler` 会按 DSL steps 顺序循环执行：

- 有 `condition` 则简单判断。
- 有内联代码则调用 `CodeExecutionService`。
- 没有内联代码则按 `tool` 调用 `UnifiedToolService`。
- 每个 step 结果最终整体写入 `workflow_execution.step_results`。

当前缺口：

- 没有 step/event 独立表。
- 没有实时执行事件流。
- 没有 checkpoint。
- 没有 artifact 输入输出。
- 长任务只能轮询 running execution，无法看到“当前步骤/已完成步骤”。

### 3. 自定义工具已有执行入口，但模型不完整

已有能力：

- 内联 Python/JavaScript 代码可执行。
- Python 通过 `skill_runner.py` 包装运行，单次超时 60 秒。
- `UnifiedToolService` 已能调用内置工具和 Agent Skill 工具。
- `ToolTestController` 支持生成/测试工具代码。

当前缺口：

- 自定义工具没有稳定的持久化 schema：参数 schema、返回 schema、权限、依赖、超时、版本、测试样例都不完整。
- Python 执行目前更像临时进程包装，不足以承载 1GB 文件、大量依赖、长时执行和严格沙箱。
- `UnifiedToolService.listTools()` 只返回内置工具名，不包含完整工具元数据。

### 4. 文件能力存在，但还不是工作流原生 artifact

已有能力：

- `/api/files/upload` 上传到 OSS。
- 上传成功后可保存为 `memory_work_file`。
- 聊天 UI 支持 `ui:upload`。
- 聊天发送时能把文件 URL、服务器路径等拼进对话。

当前限制：

- `FileUploadController` 限制 50MB。
- `ChatFileStorageService` 使用 `file.getBytes()`，会把文件一次性读入内存。
- `memory_work_file` 是工作文件视角，不等价于工作流 artifact。
- 工作流 step 输入输出只能放 JSON，没有文件资产引用关系。
- 没有分片上传、断点续传、上传会话、文件分段处理记录。

### 5. ASR 能力可复用，但需要文件资产化

已有能力：

- `/api/util/transcribe` 支持传入音频 URL。
- `/api/util/transcribe/upload` 支持直接上传音频文件。
- 后端已有 Qwen/Alibaba 与 OpenAI 兼容 ASR Adapter。

当前限制：

- 上传音频同样限制 50MB。
- 直传接口使用 `audioFile.getBytes()`。
- ASR 返回只有 `{ text }`，没有 artifact、segment、duration、timestamps、模型信息等结构化结果。
- 工作流无法把音频节点作为固定 schema 的原生工具串联。

### 6. 部署层不满足 1GB 文件目标

当前配置：

- `app/nginx.conf`：`client_max_body_size 50M`
- `application.yml`：`max-file-size: 100MB`、`max-request-size: 200MB`
- `application-prod.yml` 模板也存在 50MB 级别配置。

结论：

- 不能直接把限制改成 1GB 后就上线。
- 必须先实现流式/分片上传与后端流式处理，否则有 OOM 风险。

### 7. 前端画布已有基础，但节点类型不足

已有能力：

- React Flow 画布。
- 触发器节点、步骤节点。
- DSL 与画布双向转换。
- 节点可编辑 args、代码、语言。
- 工作流页面已有运行中任务轮询和停止按钮。

当前限制：

- 节点类型只有 trigger/step。
- 工具选择只包含 `ai_chat`、`web_search` 等少量内置工具。
- 没有文件输入口、artifact 预览、上传状态、节点输出 schema。
- 执行进度是工作流级别轮询，不是 step/event 级别实时反馈。
- 现有部分按钮文案仍使用 emoji，需要逐步替换为专业图标。

## 推荐的第一阶段边界

P1 不直接做完整 AI Agent 编排。P1 先做“文件资产与执行事件底座”，否则后续文件节点、ASR 节点、实时进度、断点续执行都会重复返工。

### P1-1：新增 Artifact 数据模型

建议新增 `workflow_artifact`：

- `id`
- `uuid`
- `user_id`
- `conversation_id`
- `workflow_id`
- `execution_id`
- `step_id`
- `source_type`: upload / workflow_output / asr / vision / document_parse
- `file_name`
- `file_type`
- `mime_type`
- `file_size`
- `oss_url`
- `object_key`
- `content_text`
- `metadata_json`
- `status`
- `created_at`
- `deleted`

说明：

- 小文本结果可以放 `content_text`。
- 大文件只保存 `oss_url/object_key`。
- 识别结果、分段信息、页码、时间戳放 `metadata_json`。

### P1-2：新增 Step/Event 执行模型

建议新增 `workflow_execution_step`：

- `id`
- `execution_id`
- `workflow_id`
- `step_id`
- `step_name`
- `tool_name`
- `status`
- `input_json`
- `output_json`
- `error_msg`
- `started_at`
- `finished_at`
- `duration_ms`

建议新增 `workflow_execution_event`：

- `id`
- `execution_id`
- `step_id`
- `event_type`
- `message`
- `payload_json`
- `created_at`

说明：

- 旧 `workflow_execution.step_results` 暂时保留，作为兼容字段。
- 新 UI 和 SSE 优先读 event/step 表。

### P1-3：统一 Artifact API

先实现普通上传兼容，不急着一次上分片：

- `POST /api/workflow-artifacts/upload`
- `GET /api/workflow-artifacts/{uuid}`
- `GET /api/workflow-artifacts?executionId=...`

要求：

- 上传实现必须走流式 OSS 上传接口，不使用 `getBytes()`。
- 默认限制可先保持 100MB，分片上传阶段再提升到 1GB。
- 与 `memory_work_file` 打通：工作流 artifact 可选择同步为工作文件。

### P1-4：执行器写入 step/event

在不改变现有 DSL 行为的前提下：

- 每个步骤开始时写 event。
- 每个步骤完成/失败时写 step 和 event。
- 每个步骤输入输出里识别 artifact 引用。
- 前端执行历史可以先展示 step/event，旧 step_results 作为兜底。

## 暂不进入的内容

以下内容进入 P2/P3/P4，不放进 P1：

- 完整 AI Agent 流程控制器。
- 分片上传和断点续传。
- 文件/图片识别节点。
- 音频转写节点。
- 自定义工具完整市场化/版本化。
- Python 严格沙箱重构。

## P1 审查清单

- 不破坏旧工作流创建、编辑、执行。
- 旧 `workflow_execution.step_results` 仍能正常生成。
- 新 artifact 不把大文件内容写入 JSON。
- 上传不使用 `MultipartFile.getBytes()` 读取大文件。
- 执行事件能表达“开始、完成、失败、取消”。
- 前端不新增 emoji 功能图标。
- 后端编译通过，前端构建通过。

