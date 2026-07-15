# 工作流引擎 V2 P1-1/P1-2 阶段审查

## 审查日期

2026-07-05

## 本阶段范围

- P1-1：新增工作流 Artifact 数据模型。
- P1-2：新增工作流 Step/Event 执行模型，并接入现有执行器。

## 已完成

### 数据模型

新增表：

- `workflow_artifact`
- `workflow_execution_step`
- `workflow_execution_event`

同步更新：

- `backend/src/main/resources/schema.sql`
- `backend/src/main/resources/migration.sql`
- `init-mysql.sql`

新增实体和 Mapper：

- `WorkflowArtifact`
- `WorkflowExecutionStep`
- `WorkflowExecutionEvent`
- `WorkflowArtifactMapper`
- `WorkflowExecutionStepMapper`
- `WorkflowExecutionEventMapper`

### 执行链路

执行器现在会写入：

- `workflow_started`
- `step_started`
- `step_completed`
- `step_failed`
- `step_skipped`
- `step_cancelled`
- `workflow_completed`
- `workflow_failed`
- `workflow_cancelled`

兼容性：

- 旧 `workflow_execution.step_results` 仍然照常生成。
- 旧工作流 DSL 不需要迁移即可继续执行。
- `ExecutionVO` 新增 `steps` 和 `events`，旧字段仍保留。

### 前端展示

工作流执行详情弹窗新增：

- 步骤轨迹。
- 执行事件。
- 原有输入参数、步骤结果、输出结果折叠区保留。

## 审查结论

未发现阻断性问题。

## 剩余风险

- `workflow_artifact` 已建模，但本阶段还没有实现上传 API 和实际 artifact 引用写入。
- step 的 `input_json` 已记录解析后的安全入参快照，但后续文件类入参需要改为 artifact 引用，不能继续把大内容放入 JSON。
- 当前执行进度仍是轮询执行详情，SSE 实时推送进入后续阶段。
- 分片上传、断点续传、1GB 文件限制未进入本阶段。
- Python 执行沙箱仍沿用旧实现，严格隔离和资源限制需要进入自定义工具阶段处理。

## 验证

- 后端：`mvn.cmd -DskipTests compile` 通过。
- 前端：`npm.cmd run build` 通过。

