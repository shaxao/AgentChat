# 工作流引擎 V2 - P7 记忆与工作文件联调评审

## 本阶段范围

将工作流执行结果真正沉淀到当前对话/场景的记忆与工作文件空间，让后续对话能够引用工作流执行结论、步骤轨迹和产物引用。

## 输入与输出边界

- 输入：`workflow_execution`、`workflow_execution_step`、`workflow_execution_event`、`workflow_artifact`、执行输入中的 `_scenarioContext`。
- 输出：
  - `memory_document`：新增 `doc_type=workflow_result` 的执行档案。
  - `memory_work_file`：新增执行档案对应的 Markdown 工作文件。
  - `WORK.md`：追加当前对话的工作流执行索引与 artifact 引用。
  - `MemoryContext`：注入当前对话的 `WORK.md` 内容。

## 实现位置

- `backend/src/main/java/com/aiplatform/backend/service/WorkflowService.java`
  - `completeExecution(...)` 切换为 `saveExecutionMemoryV2(...)`。
  - 执行档案包含基础元数据、步骤轨迹、执行事件、关联 artifact、输出与错误信息。
  - 当前对话存在时，自动更新 `WORK.md`，使用 `workflow-exec:{executionId}` 防止重复追加。
- `backend/src/main/java/com/aiplatform/backend/service/MemoryService.java`
  - `buildMemoryContext(...)` 读取当前对话的 `WORK.md`。
  - `buildInjectedPrompt(...)` 将 `WORK.md` 注入 system prompt。
- `backend/src/main/java/com/aiplatform/backend/dto/MemoryDTO.java`
  - `MemoryContext` 新增 `workIndex` 字段。
- `app/src/pages/WorkflowPage.tsx`
  - 执行详情弹窗新增“执行产物”区域。
  - 自动按 `executionId` 拉取 workflow artifact。
  - 支持查看产物名称、类型、大小、来源步骤、UUID、OSS 链接、文本内容与元数据。

## 审查结论

本阶段解决了“工作流执行完只留下最终摘要，场景对话无法稳定知道做过什么”的问题。执行结果现在既进入长期可检索的 `workflow_result` 文档，也进入当前对话的 `WORK.md`，刷新后再次对话时会被注入上下文。

## 剩余风险

- 目前执行档案会截断超长 `stepResults` 与 `outputJson`，后续大文件/大输出应进一步按 artifact 分段沉淀。
- UI 已提供执行详情内的产物入口；后续可继续补充按产物类型的预览器，例如图片预览、音频播放、表格预览。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
