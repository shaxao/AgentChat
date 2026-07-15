# 工作流引擎 V2 - P6 断点续执行与阶段回放代码审查

## 阶段范围

P6 本次完成断点续执行的最小可用闭环：

- 失败/取消的执行记录可以从失败步骤继续。
- 用户也可以在执行详情中选择某个步骤，从该步骤重跑。
- 新执行记录使用 `triggerType=resume` 标记续执行来源。
- 续执行会恢复原执行中目标步骤之前已完成步骤的输出，避免重复执行前置步骤。
- 新执行继续接入 P5 的 SSE 实时进度弹窗。

本阶段不新增数据库表，不做完整 checkpoint 表和幂等副作用控制；这些进入后续增强阶段。

## 已完成

- 后端新增 `POST /api/workflows/executions/{executionId}/resume`。
- `WorkflowResumeRequest` 支持 `fromStepId`；为空时自动定位第一个 failed/cancelled 步骤。
- `WorkflowService` 新增：
  - 查询执行步骤实体列表。
  - 收集指定步骤之前已完成步骤的输出。
  - 定位第一个失败或取消步骤。
- `WorkflowScheduler` 新增 `resumeWorkflow(...)`，支持：
  - 注入 checkpoint 输出到 `stepOutputs`。
  - 跳过 fromStepId 之前的步骤，不重复执行。
  - 写入 `workflow_resumed` 执行事件。
- 前端 `workflowApi.resumeExecution(...)` 接入续执行接口。
- 执行详情弹窗：
  - failed/cancelled 状态显示“从失败点继续”。
  - 每个步骤支持“从此步骤重跑”。
  - 续执行创建后自动切到新执行详情，并继续用 SSE 展示实时进度。

## 审查结果

### 通过项

- 续执行复用现有 execution/step/event 表，无迁移风险。
- 续执行不会覆盖原执行记录，审计链路保留。
- 已完成前置步骤输出会进入新执行上下文，后续步骤可继续模板引用。
- 用户可以选择自动失败点，也可以显式指定重跑步骤。
- 和 P5 实时进度链路兼容。

### 剩余风险

- 目前 checkpoint 来源是旧执行的 step output，不是独立 checkpoint 表；如果旧执行输出被清理，续执行会缺上下文。
- 续执行无法保证外部副作用幂等，例如已经发送过通知、写入过第三方系统的步骤，若从较早步骤重跑可能重复产生副作用。
- 跳过的恢复步骤只写入聚合 stepResults，不创建新的 step 记录；UI 主要依赖 `workflow_resumed` 事件与新执行步骤轨迹理解恢复来源。
- 条件判断依赖恢复的前置输出，若前置步骤原本 skipped，后续条件可能和全量重跑不完全一致。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- Vite 仍有既有的大 chunk 和 `api.ts` 动静态混合导入警告，本阶段未新增构建失败。

## 下一阶段建议

进入 P4「AI 驱动执行引擎」或继续强化 P6：

- P4：让 Agent 根据上下文动态选择工具、调整步骤和汇总结果。
- P6 强化：新增 checkpoint 表、步骤幂等策略、副作用标记、从任意 checkpoint 回放。
