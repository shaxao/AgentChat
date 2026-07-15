# 工作流引擎 V2 - P4 AI 策略强化代码审查

## 本阶段范围

本次在 P4 AI 驱动执行引擎基础上补充 `aiPolicy`：

- `maxTurns`：限制 AI 决策最大轮次，默认 `min(20, steps * 3)`，最低 3 轮，配置上限 50。
- `allowRepeatSteps`：是否允许 AI 重复执行同一个步骤，默认 `false`。
- `continueOnStepFailure`：步骤失败后是否继续让 AI 决策，默认 `false`。
- AI 决策 prompt 会收到策略上下文。
- 执行器层面做硬拦截，不能只依赖模型自觉遵守。
- 可视化 DSL 转换保留 `aiPolicy`，避免高级字段在画布保存时丢失。

## 实现位置

- `backend/src/main/java/com/aiplatform/backend/service/WorkflowParser.java`
  - 新增 `ParsedAiPolicy`。
  - 解析 DSL 顶层 `aiPolicy` 字段。
- `backend/src/main/java/com/aiplatform/backend/service/WorkflowScheduler.java`
  - 根据 `aiPolicy` 计算最大轮次。
  - 默认禁止重复执行步骤。
  - 默认步骤失败即停止 AI 驱动流程。
  - 策略拦截和失败停止写入执行事件。
- `app/src/lib/workflowTypes.ts`
  - 新增 `WorkflowDsl.aiPolicy` 和 `TriggerNodeData.aiPolicy` 类型。
- `app/src/components/workflow/dslFlowConverter.ts`
  - DSL 转 Flow 时保留 `aiPolicy`。
  - Flow 转 DSL 时写回 `aiPolicy`。
- `app/src/components/workflow/WorkflowCanvas.tsx`
  - 在触发器属性面板的 AI 编排模式下新增策略配置。
  - `maxTurns` 使用滑块和数字输入。
  - `allowRepeatSteps`、`continueOnStepFailure` 使用开关控件。

## 审查结论

本次强化解决了 P4 最小闭环中的主要副作用风险：AI 不会默认重复执行通知、写入、接口调用等步骤；步骤失败也不会默认继续“试错”。

需要关注的剩余风险：

- `allowRepeatSteps=true` 仍然可能产生业务副作用，后续应增加步骤级 `idempotent` / `sideEffect` 标记。
- `continueOnStepFailure=true` 适合分析类流程，不适合支付、通知、写入型流程，后续 UI 应给出明确风险提示。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- 前端仍有既有 Vite 警告：`api.ts` 同时动态/静态导入、部分 chunk 超过 500 kB。
