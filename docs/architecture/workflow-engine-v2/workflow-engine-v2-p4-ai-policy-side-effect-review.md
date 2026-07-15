# 工作流引擎 V2 - P4 AI 策略补充评审：副作用与幂等

## 本阶段范围

在 P4 AI 驱动执行与 `aiPolicy` 基础上，补齐步骤级副作用与幂等控制，避免 AI 在长链路中重复执行通知、支付、写入、外部调用等高风险步骤。

## 实现位置

- `backend/src/main/java/com/aiplatform/backend/service/WorkflowParser.java`
  - DSL step 支持 `idempotent` 与 `sideEffect`。
  - `sideEffect` 限定为 `none/read/write/external_call/notification/payment`。
  - 未显式声明时按工具类型提供默认副作用与幂等值。
- `backend/src/main/java/com/aiplatform/backend/service/WorkflowScheduler.java`
  - AI 决策上下文包含步骤幂等与副作用信息。
  - 即使 `allowRepeatSteps=true`，重复执行非幂等且有副作用的步骤也会被拦截。
  - 策略拦截写入 `workflow_ai_policy_blocked` 事件。
- `app/src/lib/workflowTypes.ts`
  - 前端类型保留 `idempotent` 与 `sideEffect`。
- `app/src/components/workflow/dslFlowConverter.ts`
  - DSL 与画布互转时保留副作用字段。
- `app/src/components/workflow/WorkflowCanvas.tsx`
  - 步骤属性面板增加“副作用与重复执行”配置。

## 审查结论

P4 的主要执行安全边界已形成闭环：

- AI 只能选择 DSL 声明的步骤。
- AI 执行轮次受 `maxTurns` 限制。
- 默认禁止重复步骤。
- 默认步骤失败即停止。
- 对高副作用步骤，即使用户允许重复执行，也会被执行器硬拦截。

## 剩余风险

- 仍保留字符串字段以兼容旧 DSL，但解析层已经限制允许值。
- `continueOnStepFailure=true` 仍适合分析类流程，不适合支付、通知、写入型流程，模板侧应给出更明确的默认配置。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- 新增 `backend/src/test/java/com/aiplatform/backend/service/WorkflowParserTest.java`，覆盖内置工具默认副作用、显式幂等配置、非法 `sideEffect` 拒绝。
- `mvn.cmd -Dtest=WorkflowParserTest test` 未执行：本次提权审批系统返回不可用错误，并非测试失败。
