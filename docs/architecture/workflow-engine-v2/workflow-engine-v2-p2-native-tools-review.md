# 工作流引擎 V2 - P2 原生工具节点代码审查

## 阶段范围

P2 本次实现的是原生工具节点最小可用闭环：

- 工作流执行器能识别并执行文件资产、图片识别、音频转写工具。
- 前端画布能直接添加这些节点。
- 节点输入使用 Artifact UUID 或 URL 引用，不把文件内容放入 DSL JSON。

本阶段不包含拖拽上传 UI、1GB 分片上传、OCR 专用解析器、表格解析器、SSE 流式进度。

## 已完成

- 后端 `UnifiedToolService` 新增原生工具：
  - `file_upload`：规范化已上传 Artifact 或外部 URL，输出统一文件引用。
  - `image_recognition`：读取 Artifact/URL，调用 Vision 能力返回图片内容文本。
  - `audio_transcribe`：读取 Artifact/URL，复用 ASR 渠道返回转写文本。
- 原生工具统一支持以下输入别名：
  - `artifactUuid` / `artifact_uuid` / `uuid`
  - `artifactId` / `artifact_id` / `id`
  - `fileUrl` / `imageUrl` / `audioUrl` / `url` / `ossUrl`
- Artifact 查询按 `user_id` 和 `deleted=0` 过滤，避免跨用户访问。
- 图片/音频节点会根据 `fileType` 或 `mimeType` 做基础类型校验。
- 前端内置工具列表新增三类节点，并给出标准 JSON 参数示例。
- 画布工具卡片为 AI 对话、搜索、文件、图片、音频节点使用专业 lucide 图标。
- 原生文件类节点的属性面板支持直接上传或拖拽文件。
- 上传完成后自动写入 `args.artifactUuid`、`fileName`、`fileType`、`mimeType`，图片识别节点会补默认 `prompt`。
- 执行详情支持识别 `workflow.native.v1` 输出，并按文件资产、提示词、文本结果、耗时结构化展示。
- 普通工具输出仍保留可展开的原始 JSON，兼容旧工作流执行结果。

## 审查结果

### 通过项

- 节点执行入口真实接入后端，不是仅前端展示。
- 文件输入以 Artifact/URL 引用传递，符合大文件不进 JSON 的约束。
- Vision 和 ASR 复用已有平台能力，避免重复造一套模型调用逻辑。
- 原生工具输出包含 `schemaVersion=workflow.native.v1`，后续节点可以按稳定结构消费。

### 剩余风险

- `image_recognition` 依赖 OSS URL 可被 Vision 模型访问；私有桶场景需要下载代理或临时签名 URL。
- `audio_transcribe` 复用现有 `speechToText(fileUrl)`，底层部分适配器仍可能下载整个音频文件，1GB 目标需要在分片/长音频阶段继续改造。
- 输出结果目前记录在 step output 中，尚未自动生成 `sourceType=vision/asr` 的派生 Artifact。
- 还没有表格解析、文档 OCR、分页/分段处理与结果合并。
- 节点上传暂未传入 `workflowId`，当前 Artifact 先作为用户级资产保存；编辑页向画布传递工作流 ID 后可进一步绑定到具体工作流。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- Vite 仍有既有的大 chunk 和 `api.ts` 动静态混合导入提示，本阶段未引入新的构建失败。

## 下一阶段建议

P2-2 继续补“执行详情和派生资产”：

- 将 Vision/ASR 结果保存为 `sourceType=vision/asr` 的派生 Artifact。
- 给私有 OSS 增加临时签名 URL 或后端下载代理。
