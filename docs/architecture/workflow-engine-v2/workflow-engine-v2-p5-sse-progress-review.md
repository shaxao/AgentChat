# 工作流引擎 V2 - P5 SSE 实时进度代码审查

## 阶段范围

P5 本次实现工作流执行实时进度的最小闭环：

- 后端提供执行级 SSE 订阅接口。
- 前端执行详情弹窗实时展示执行状态、当前步骤、完成进度、步骤轨迹和事件。
- 手动触发工作流后自动打开实时执行详情。
- 执行终态后自动关闭流，并刷新运行中状态与历史列表。

本阶段不包含分布式事件总线、断点续执行和多实例广播；这些进入后续 P6 或基础设施阶段。

## 已完成

- 后端新增 `GET /api/workflows/executions/{executionId}/stream`。
- SSE 事件类型：
  - `snapshot`：完整执行详情，包含 steps/events。
  - `execution_event`：新增执行事件。
  - `heartbeat`：连接保活。
  - `done`：执行进入 success/failed/cancelled 后关闭连接。
  - `error`：权限或读取异常。
- SSE 订阅前会校验执行记录归属，避免跨用户访问执行进度。
- `WorkflowService` 新增按事件 ID 增量读取执行事件的方法。
- 前端 `workflowApi.streamExecution` 使用 fetch 读取 SSE，因此可以携带 Authorization header。
- 执行详情弹窗：
  - 显示实时连接状态。
  - running 状态展示当前步骤和 `已完成/总步骤`。
  - 收到 snapshot 后刷新完整步骤轨迹。
  - 收到 done 后回调父级刷新历史与 running 状态。
- 手动执行工作流后直接打开执行详情弹窗。

## 审查结果

### 通过项

- 不依赖浏览器原生 EventSource，避免无法设置鉴权头的问题。
- 复用已有 `workflow_execution_step` 和 `workflow_execution_event` 表，无需新增数据库迁移。
- 刷新页面或中途打开执行详情时，初始 snapshot 可以恢复完整状态。
- SSE 终态自动关闭，避免前端长期挂着无意义连接。
- 失败、取消、成功都会进入同一条实时链路，用户能看到最终状态。

### 剩余风险

- 当前后端 SSE 采用短周期数据库轮询，不是事件总线推送；并发执行很多时需要优化为内存广播或消息队列。
- 单连接最长约 30 分钟；更长任务需要 P6 的断点续执行和恢复机制配合。
- 多后端实例部署时，执行线程和 SSE 连接可能落在不同实例，需要 Redis/pub-sub 或统一事件中心。
- heartbeat 目前只用于保活，没有在 UI 上单独展示连接延迟。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- Vite 仍有既有的大 chunk 和 `api.ts` 动静态混合导入警告，本阶段未新增构建失败。

## 下一阶段建议

进入 P6「断点续执行与阶段回放」：

- 保存 checkpoint：已执行步骤、上下文、artifact、模型输出、失败点。
- 支持从指定 step 继续执行。
- UI 支持查看恢复点与重新执行范围。
