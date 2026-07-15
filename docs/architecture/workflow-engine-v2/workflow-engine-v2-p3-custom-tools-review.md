# 工作流引擎 V2 - P3 自定义工具实心化代码审查

## 阶段范围

P3 本次完成自定义代码工具的最小可用闭环：

- 工作流步骤可以携带 `code`、`language`、`timeoutSeconds`、`permissions`、`inputSchema`、`outputSchema`。
- Python / JavaScript 自定义工具通过统一代码执行服务运行。
- 测试运行和真实工作流执行使用同一套超时与权限边界。
- 自定义工具输出保持结构化对象，后续节点可以继续通过模板变量或自动注入消费。

本阶段不包含 HTTP API 工具持久化、独立工具市场发布、强容器级隔离和 AI 驱动模式全流程控制，这些进入后续 P3 扩展或 P4。

## 已完成

- 后端 `CodeExecutionService` 支持：
  - 可配置超时，范围 1-300 秒。
  - Windows 使用 `python`、其他环境使用 `python3`，也支持 `workflow.python.command` 覆盖。
  - 权限预检：`network`、`filesystem_read`、`filesystem_write`、`process`。
  - 旧调用保持兼容：未传 permissions 时不启用预检。
- 后端 `WorkflowParser` 解析自定义工具运行契约字段。
- 后端 `WorkflowScheduler`：
  - 执行代码前校验 `inputSchema.required`。
  - 执行成功后校验 `outputSchema.required`。
  - 保留结构化输出，不再把对象压成字符串。
- 后端 `/api/tools/test-code` 支持 `timeoutSeconds` 和 `permissions`。
- 前端工作流画布：
  - 自定义工具节点默认带 Python、60 秒超时、空权限、空输入/输出 schema。
  - 节点代码页显性展示运行边界、权限开关、输入/输出 schema。
  - 测试运行会带上当前节点的超时和权限。
- DSL 转换已持久化上述字段，刷新后不会丢失。

## 审查结果

### 通过项

- 自定义工具已从“名称元数据”变为可执行节点，满足 P3 最小闭环。
- 测试与正式执行共用后端 `CodeExecutionService`，避免测试/上线行为不一致。
- 工作流执行事件仍复用现有 step/event 记录，不破坏旧执行详情。
- 结构化输出保留为对象，对后续 AI 编排和模板引用更友好。
- 本阶段没有新增数据库表，不需要新的迁移脚本。

### 剩余风险

- 当前权限控制是代码静态预检 + 进程超时，不等价于容器/系统调用级沙箱。生产环境如开放给不可信用户，P3 后续必须接入容器、Firecracker、nsjail 或等价隔离。
- 文件读写权限目前只建议用于临时目录语义，尚未把进程文件系统限制到真实 chroot/容器内。
- `outputSchema` 目前只校验 `required`，还未完整实现 JSON Schema 类型、枚举、数组等约束。
- JavaScript 工具直接调用本机 `node`，需要确认服务器运行环境具备 Node.js。
- 权限预检基于关键字，能阻挡常见误用，但不能作为恶意代码防护边界。

## 验证

- `mvn.cmd -DskipTests compile` 通过。
- `npm.cmd run build` 通过。
- Vite 仍有既有的大 chunk 和 `api.ts` 动静态混合导入警告，本阶段未新增构建失败。

## 下一阶段建议

进入 P3 扩展或 P5：

- P3 扩展：独立自定义工具资产表、HTTP API 工具、工具版本、测试用例、审计日志、容器级沙箱。
- P5：工作流 SSE 实时进度，因为 step/event 表已经具备基础。
