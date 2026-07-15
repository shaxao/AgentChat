# 工作流引擎 V2 - P7 产物 UI 补充评审

## 本阶段范围

在 P7 后端已沉淀 workflow artifact、`WORK.md` 与记忆上下文的基础上，补齐前端查看入口，让用户能直接看到执行产物。

## 实现位置

- `app/src/pages/WorkflowPage.tsx`
  - 执行详情弹窗新增“执行产物”区域。
  - 自动按 `executionId` 拉取 workflow artifact。
  - 支持查看产物名称、类型、大小、来源步骤、UUID、OSS 链接、文本内容与元数据。
- `app/src/pages/ChatPage.tsx`
  - 场景对话内触发工作流后，完成消息会按 `executionId` 拉取 artifact。
  - 对话消息中展示产物名称、类型、大小、来源步骤、URL 或 artifact UUID。

## 审查结论

P7 不再只是后端写入。用户在工作流执行详情和场景对话结果中都能看到产物引用，减少“结果写进系统但前台找不到”的断层。

## 剩余风险

- 当前对话消息展示为摘要文本，图片、音频、表格仍未按类型做原生预览。
- 执行详情已有文本内容与元数据展开能力，后续可增加图片预览、音频播放、表格预览。

## 验证

- `npm.cmd run build` 通过。
