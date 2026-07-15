# 工作流引擎 V2 - P1-3 代码审查

## 阶段范围

P1-3 目标是建立统一的工作流 Artifact API，让工作流节点、执行记录、场景对话和工作文件后续都能使用同一套文件资产模型。

本阶段不包含 1GB 分片上传、断点续传、视觉/OCR/ASR 节点 UI、AI 驱动执行器调度。

## 已完成

- 后端新增工作流资产上传、详情、列表接口：
  - `POST /api/workflow-artifacts/upload`
  - `GET /api/workflow-artifacts/{uuid}`
  - `GET /api/workflow-artifacts`
- 上传时校验 workflow/execution 所属用户，避免跨用户引用资产。
- 上传文件使用 `InputStream` 流式传递给 OSS，避免 `file.getBytes()` 带来的大文件内存峰值。
- 支持绑定 `workflowId`、`executionId`、`stepId`、`convUuid`、`sourceType`、`metadataJson`。
- 支持 `syncToWorkFile=true` 时同步写入对话工作文件，给场景工作模式和记忆系统复用。
- 旧聊天文件 OSS 上传也改为流式上传。
- 前端新增 `workflowArtifactApi`，统一提供上传、详情、列表方法。

## 审查结果

### 通过项

- 权限边界清晰：workflow、execution、conversation 都按当前用户过滤。
- 资产数据模型与执行步骤模型解耦，后续节点可以只引用 artifact UUID，不需要重复上传。
- 上传链路没有把文件完整读入 JVM byte array，满足 P1 的内存安全要求。
- 前端 API 没有直接复用聊天上传接口，后续工作流节点可以保留独立语义。

### 剩余风险

- 当前单文件上传上限仍为 100MB。1GB 文件需要 P1 后续阶段实现分片上传、断点续传和 Nginx/后端超时配置。
- Artifact 只完成了资产登记和存储，尚未接入 OCR、视觉理解、ASR、表格解析等原生工具处理器。
- 执行器尚未把节点输入中的文件字段标准化为 Artifact 引用，后续需要在 DSL schema 和节点运行时补齐。
- 当前没有下载/预览代理接口，前端预览仍依赖 OSS URL 可访问性。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- Vite 仍有既有的大 chunk 和 `api.ts` 动静态混合导入提示，本阶段未扩大该问题。

## 下一阶段建议

P1-4 进入原生文件节点最小闭环：

- 设计 DSL 中 `file_upload`、`image_recognition`、`audio_transcribe` 的输入输出 schema。
- 执行器支持从 Artifact 读取文件元数据/URL 并传给处理器。
- 前端画布节点支持文件输入口和执行详情展示 artifact。
