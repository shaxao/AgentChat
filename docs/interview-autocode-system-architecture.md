# AutoCode / AI 对话平台架构与面试讲解稿

> 适用场景：面试项目介绍、系统设计复盘、技术亮点讲解。
>
> 项目整体可以概括为：一个面向 AI 对话与代码开发的多 Agent 平台。Java 主系统负责用户、对话、模型、技能、记忆、权限、支付计费；AutoCode 子系统负责代码开发任务、Agentic Loop、工具执行、本地 Runner、工作区和任务生命周期。

---

## 1. 项目整体定位

这个系统不是单纯的聊天机器人，而是一个“AI 应用平台 + AI IDE/代码开发平台”。

核心能力包括：

- 普通 AI 对话：支持流式输出、多模型路由、文件读取、图片/语音等扩展能力。
- 代码开发 AutoCode：用户给出需求后，Agent 自主读取项目、修改代码、运行验证、继续修复。
- 技能系统：用户/管理员可以导入、发布、审核、下载技能包，类似插件市场。
- 记忆系统：把用户画像、对话摘要、项目记忆、工作文件、技能记忆分层存储和检索。
- 权限系统：基于 RBAC 的角色权限管理，同时 AutoCode 工具层还有独立的工具权限和审批机制。
- 统一计费：区分上游渠道成本和用户侧套餐/钱包扣费，支持 chat/autocode/workflow 场景化额度。
- 本地 Runner：用户本地项目可由 AutoCode 直接读取、修改和验证，不必完全上传到服务器。

我在设计时的核心思想是：

1. **对话系统和代码开发系统分层**
   Java 主系统稳定承载业务能力；AutoCode Python 服务专注 Agent 工具链和工作区执行。

2. **让 Agent 真正自主决策**
   不再让任务被固定阶段卡死，而是采用 Agentic Loop：observe -> decide -> act -> verify -> reconcile -> finish。

3. **上下文、缓存、权限都平台化**
   Agent 不是盲目读全项目，而是通过 SystemContext、Workspace Index、CacheLedger、Tool Registry 控制成本、安全和准确率。

4. **所有高风险能力都要可审计**
   文件写入、shell 命令、本地执行、计费、权限变更都要有事件、日志和可追踪的状态。

---

## 2. 总体架构分层

### 2.1 前端层

目录：`app/`

技术栈：

- React
- TypeScript
- Vite
- Tailwind CSS
- lucide-react
- SSE / WebSocket 事件展示

前端主要模块：

- 对话页面：普通聊天、流式响应、AI 回复、文件上传。
- AutoCode 页面：任务列表、活动区、预览、审批、本地 Runner 接入。
- 管理后台：模型、渠道、日志、套餐、权限、技能、钱包。
- 登录注册页面：账号认证入口。

### 2.2 Java 主系统

目录：`backend/`

技术栈：

- Spring Boot
- MyBatis-Plus
- MySQL
- SSE
- JWT / RBAC
- 钱包与订阅计费
- OSS / 文件存储

职责：

- 用户认证、JWT、权限。
- 普通对话和 Agent 对话。
- 模型配置、渠道配置、模型路由。
- 记忆系统。
- 技能系统。
- 计费、钱包、订阅、日志。
- 给 AutoCode 暴露内部模型与用量接口。

### 2.3 AutoCode 子系统

目录：`agent-platform/backend/`

技术栈：

- FastAPI
- Python asyncio
- WebSocket
- MySQL + 内存 fallback
- Docker workspace / 本地 Runner
- Agent 工具注册与权限引擎

职责：

- 创建代码开发任务。
- 管理工作区和任务状态。
- 运行 Agentic Loop。
- 执行工具：读文件、搜索、写文件、命令、预览、本地 Runner。
- 活动区事件、缓存、工具输出收敛。
- SystemContext / Workspace Index / CacheLedger。

---

## 3. AutoCode 核心 Agentic Loop

### 3.1 为什么从固定流水线改成 Agentic Loop

早期 AutoCode 是固定流水线：

```text
计划 -> 原型 -> 分组执行 -> 审查 -> 验证
```

这个模式的问题是：

- 用户已经明确指出函数/文件/错误点时，系统还会要求“再说明需求”。
- 冒烟测试、使用说明这类阶段本来可能不产生源码变更，却因为“无文件变更”失败。
- 任务完成后再继续修改，会被固定阶段状态卡住。
- Agent 只是在阶段里被动执行，不是真正自主判断下一步。

所以我把执行主线改成 Agentic Loop：

```text
observe -> decide -> act -> verify -> reconcile -> finish
```

对应代码：`agent-platform/backend/core/agent_orchestrator.py`

```python
def _execution_mode(task: dict | None) -> str:
    configured = str((task or {}).get("execution_mode")
        or os.getenv("AUTOCODE_EXECUTION_MODE", "agentic")).strip().lower()
    return "planned" if configured in {"planned", "phase", "legacy"} else "agentic"

def _should_use_agentic_execution(task: dict | None, description: str, project_type: str = "") -> bool:
    if _execution_mode(task) == "planned":
        return False
    if task and task.get("force_planned_execution"):
        return False
    return True
```

这里默认执行模式是 `agentic`，老的 planned phase flow 保留为 fallback/guardrail。

### 3.2 Agentic Loop 的提示协议

核心提示在 `_run_agentic_loop` 中：

```python
async def _run_agentic_loop(...):
    """Run the default autonomous execution path.

    TaskPlan remains useful context, but it is a guardrail instead of the
    driver. The single-agent runtime owns observe -> act -> verify.
    """
    prompt = f"""## Agentic Loop Execution

Execution mode: agentic. The plan/subtasks below are guardrails and context only; do not execute them as a fixed phase pipeline.

Required behavior:
1. Observe the SystemContext manifest, retrieval/index files, current workspace, recent review/CI state, and pending user messages.
2. Decide the next useful tool call yourself: search, read, edit, validate, answer, or ask only when blocked by missing product intent.
3. If the request is actionable, produce real code/docs/config/test changes.
4. After any write, run an appropriate validation command.
5. Finish only when the requested behavior is implemented...
"""
```

这个提示协议解决了几个核心问题：

- Agent 不再机械执行阶段。
- 明确需求时必须进入修改。
- 写文件后必须验证。
- 验证失败后继续修复，而不是直接失败。
- 任务完成后继续聊天也能重新进入 Agentic continuation。

### 3.3 完成状态和可恢复 checkpoint

Agentic Loop 每轮会记录稳定 checkpoint：

```python
def _set_agentic_finish(task: dict, *, status: str, reason: str, changed_files=None, ...):
    payload = {
        "status": status,
        "reason": reason,
        "changed_files": [...],
        "validated": validated,
        "review_passed": review_passed,
        "retryable": bool(retryable),
        "blocked": bool(blocked),
        "system_context_epoch": task.get("system_context_epoch"),
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    task["agentic_finish"] = payload
    append_event(task, "agentic_loop_checkpoint", payload, source="orchestrator")
```

设计目的：

- 前端能知道任务是真完成、可重试、被阻塞还是等待续跑。
- 页面刷新、标签页关闭后可以恢复状态。
- 解决“关闭页面再回来不知道任务在哪一步”的问题。

---

## 4. SystemContext Epoch：上下文不是全量拼接，而是可 diff 的 manifest

### 4.1 背景问题

早期 Agent 每次任务都会读取大量 `.autocode/*.md` 文件，导致：

- token 浪费。
- 上下文重复。
- 文件变化无法精确判断。
- Agent 不知道哪些上下文是新的、哪些是旧的。

所以我设计了 `SystemContext Epoch`。

文件：`agent-platform/backend/runtime/system_context.py`

它生成：

```text
.autocode/SYSTEM_CONTEXT.json
```

里面记录：

- epoch
- generated_at
- workspace_id
- task_id
- sources[]
  - path
  - kind
  - sha256
  - mtime
  - size
  - priority
  - summary
- last_diff

核心代码：

```python
def build_manifest(workspace_root: Path, *, workspace_id=None, task_id=None, sources=DEFAULT_SYSTEM_CONTEXT_SOURCES, write=True):
    previous = _read_previous_manifest(root)
    source_items = []

    for rel in sources:
        path = root / rel
        if not path.exists() or not path.is_file():
            continue
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        source_items.append({
            "path": rel.replace("\\", "/"),
            "kind": _source_kind(rel),
            "sha256": _sha256_bytes(raw),
            "size": int(stat.st_size),
            "priority": int(SOURCE_PRIORITIES.get(rel, 500)),
            "summary": _summarize_text(text),
        })

    diff = diff_manifest(previous, draft)
    if diff.changed_paths or not previous:
        draft["epoch"] = int(previous.get("epoch") or 0) + 1
```

### 4.2 RuntimeContext 如何使用 manifest

文件：`agent-platform/backend/runtime/context_manager.py`

```python
@dataclass
class RuntimeContext:
    task_id: str
    workspace_id: str | None
    summary: str
    files: dict[str, str] = field(default_factory=dict)
    manifest: dict = field(default_factory=dict)
    changed_sources: list[str] = field(default_factory=list)
    epoch: int = 0

    def to_prompt(self, max_chars: int = 24_000) -> str:
        ...
        sections.append("## System Context Manifest\n" + json.dumps({
            "epoch": self.epoch,
            "manifest_path": self.manifest.get("manifest_path"),
            "changed_sources": self.changed_sources,
            "sources": sources,
        }, ensure_ascii=False, indent=2))
```

这个设计的好处：

- Agent 先看 manifest，再决定读哪个源文件。
- 不再把所有 `.autocode` 文件全文塞进 prompt。
- 通过 epoch 判断上下文是否变化。
- 通过 changed_sources 决定是否继续执行或停止。

### 4.3 上下文事件

`ContextManager` 会产生事件：

```python
append_event(task, "system_context_indexed", {...})
append_event(task, "system_context_changed", {...})
append_event(task, "system_context_reconciled", {...})
```

这些事件用于：

- 活动区展示“上下文已索引”。
- 后端判断是否继续 Agentic Loop。
- 调试任务为什么继续/停止。

---

## 5. 缓存体系：从单轮缓存到平台级 CacheLedger

### 5.1 缓存分层思想

平台缓存分为多层：

| 层级 | 作用 |
|---|---|
| L0 请求内缓存 | 同一次 Agent Loop 内重复工具调用去重 |
| L1 会话缓存 | 同 task/session 内复用上下文、工具结果 |
| L2 工作区缓存 | SystemContext、Workspace Index、文件 sha |
| L3 Provider prompt cache | 稳定 prompt 前缀，提高模型侧 cached tokens |
| L4 长期记忆缓存 | 用户偏好、项目约定、长期知识 |
| L5 解决方案缓存 | 错误指纹、根因、补丁摘要、验证命令 |

核心原则：

- 能不进模型上下文的，就不进。
- 能摘要的，不塞全文。
- 能用 hash 判断没变的，不重复读取。
- 历史解决方案可以建议复用，但不能绕过验证和权限。

### 5.2 CacheLedger 统一记账

文件：`agent-platform/backend/services/cache_ledger_service.py`

```python
@dataclass
class CacheLedgerEvent:
    cache_layer: str
    cache_key: str
    status: str
    scene_type: str = "autocode"
    tenant_id: str = ""
    user_id: str = ""
    task_id: str = ""
    session_id: str = ""
    workspace_id: str = ""
    epoch: int = 0
    input_hash: str = ""
    hit_reason: str = ""
    miss_reason: str = ""
    token_saved_estimate: int = 0
    latency_saved_ms: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
```

设计目标：

- AutoCode 和 Java 对话系统都写入同一类缓存事件。
- 后续可以按用户、租户、模型、场景统计命中率。
- MySQL 不可用时降级内存，不影响主流程。

初始化时自动建表：

```python
CREATE TABLE IF NOT EXISTS autocode_cache_ledger (...)
CREATE TABLE IF NOT EXISTS autocode_solved_patterns (...)
```

### 5.3 解决方案缓存

`autocode_solved_patterns` 存：

- fingerprint
- scene_type
- error_excerpt
- root_cause
- patch_summary
- validation_command
- validation_result
- risk_level
- reuse_policy

在 Agentic Loop 中会查历史解决方案：

```python
cached_solutions = cache_ledger_service.search_solutions(...)
if cached_solutions:
    append_event(task, "cache_solution_suggested", ...)
    cache_ledger_service.record(CacheLedgerEvent(
        cache_layer="L5",
        status="hit",
        hit_reason="historical_solution_cache_suggested",
    ))
```

面试可以这样讲：

> 我没有把缓存只理解成 KV，而是把它做成“可审计的缓存账本”。每次命中/失效都有 cache_layer、key、scene、user、epoch 和节省 token 的估算，方便后续做成本优化和命中率分析。

---

## 6. Tool Output Store：大输出不进 prompt

### 6.1 背景问题

代码开发里经常有大输出：

- `npm build` 大量日志。
- `pytest` 长报错。
- `ls -R` 或 `cat` 大文件。
- 终端输出导致 prompt 爆炸。

解决方案：工具输出分层。

文件：`agent-platform/backend/runtime/tool_output_store.py`

```python
MAX_PREVIEW_CHARS = 12_000
MAX_MODEL_CHARS = 2_000
MAX_LINES = 400
MANAGED_DIR = ".autocode/tool-output"

def bound_tool_output(workspace_root: Path, output: Any, *, tool_name: str = "tool", ...):
    text = "" if output is None else str(output)
    truncated = total_chars > max_preview_chars or total_lines > max_lines

    if truncated:
        output_path = directory / filename
        output_path.write_text(text, encoding="utf-8", errors="replace")
        full_rel_path = f"{MANAGED_DIR}/{filename}"

    preview = _bounded_preview(text, max_chars=max_preview_chars, max_lines=max_lines)
    model_preview = _bounded_preview(text, max_chars=max_model_chars, max_lines=min(max_lines, 120))
```

模型只看到 `model_preview`，完整日志存到：

```text
.autocode/tool-output/tool_xxx.txt
```

好处：

- 防止 LLM 上下文被日志淹没。
- 活动区仍可展开查看完整输出。
- 长日志保留可追溯性。

---

## 7. Tool Registry：工具元数据统一

文件：`agent-platform/backend/runtime/tool_registry.py`

工具不是散落的字符串，而是统一注册为 `ToolSpec`：

```python
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    label: str = ""
    side_effect: SideEffect = "none"
    permission_default: PermissionDefault = "ask"
    risk_level: int = 1
    cacheable: bool = False
    mutates_workspace: bool = False
    requires_confirmation: bool = False
    output_mode: OutputMode = "bounded"
    agent_enabled: bool = False
    local_runner_enabled: bool = False
```

这个设计解决了：

- 前后端工具展示不一致。
- 权限规则散落。
- 哪些工具可缓存、哪些工具可本地执行不清楚。
- 活动区只显示工具名，用户看不懂。

Tool Registry 还能生成 Agent 工具定义：

```python
def agent_tool_definitions(self):
    return [
        ToolDefinition(
            name=spec.name,
            description=spec.agent_description(),
            parameters=spec.parameters or {"type": "object", "properties": {}},
        )
        for spec in self.agent_specs()
    ]
```

---

## 8. 权限与审批机制

### 8.1 两层权限

系统里有两层权限：

1. **业务权限 RBAC**
   Java 主系统：角色、菜单、按钮、API 权限。

2. **Agent 工具权限**
   AutoCode 工具执行：bash、写文件、删除、git、外部网络、本地 Runner。

这两层不能混为一谈。

### 8.2 Tool Permission Engine

文件：`agent-platform/backend/runtime/permission_engine.py`

核心返回值：

```python
@dataclass
class PermissionDecision:
    decision: Literal["allow", "ask", "deny"]
    reason: str = ""
    tool: str = ""
    risk_level: int = 0
    approval_payload: dict = field(default_factory=dict)
```

危险命令检测：

```python
def is_forbidden_destructive_command(command: str) -> bool:
    dangerous_roots = (
        r"rm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\s+(/|\\|~|\$home|\$env:userprofile|c:\\)",
        r"git\s+reset\s+--hard\b",
        r"git\s+clean\b.*(-f|-force)",
    )
    return any(re.search(pattern, compact) for pattern in dangerous_roots)
```

策略思想：

- 只读类工具默认 allow。
- 写文件、命令执行按风险判断。
- 删除、reset、clean 这类高风险必须 ask 或 deny。
- 绝对危险命令直接 deny。
- 自动批准模式也不能绕过极高风险删除。

### 8.3 普通 RBAC 权限

Java 主系统 RBAC：

文件：`backend/src/main/java/com/aiplatform/backend/controller/RbacController.java`

```java
@RestController
@RequestMapping("/api/admin/rbac")
public class RbacController {
    @GetMapping("/roles")
    public Result<List<SysRole>> listRoles(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(rbacService.listRoles());
    }

    @PutMapping("/roles/{roleId}/permissions")
    public Result<String> assignPermissionsToRole(...) {
        requireAdmin(userRole);
        rbacService.assignPermissionsToRole(roleId, permissionIds);
        return Result.ok("权限分配成功");
    }
}
```

技能导入也用了 Spring Security：

```java
@PreAuthorize("hasAuthority('PERM_skill:publish')")
@PostMapping("/import")
public ResponseEntity<Result<Map<String, Object>>> importSkill(...)
```

面试讲法：

> 我把“用户能不能进入某个业务功能”和“Agent 能不能执行某个危险工具”拆开。RBAC 管业务边界，PermissionEngine 管运行时工具边界，这样即使用户有代码开发权限，Agent 也不能直接执行危险命令。

---

## 9. 本地 Runner：低成本、本地环境执行

### 9.1 为什么要本地 Runner

用户经常修改自己的项目：

- 本地有数据库。
- 本地有私有依赖。
- 本地有上传文件。
- 云端 workspace 很难完全复刻环境。
- 服务器执行命令消耗资源，也有安全风险。

所以设计了 `autocode-local-runner`：

- 用户本机启动一个 Python 小程序。
- 主动连接服务器 WebSocket。
- 不需要公网 IP。
- 不需要开放本地端口。
- 服务器发工具请求，本地执行后回传结果。

### 9.2 会话管理

文件：`agent-platform/backend/services/local_runner_manager.py`

```python
@dataclass
class LocalRunnerSession:
    task_id: str
    session_id: str
    token: str
    enabled: bool = True
    connected: bool = False
    project_root: str = ""
    websocket: WebSocket | None = None
    pending: dict[str, asyncio.Future] = field(default_factory=dict)
    tool_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
```

为什么要有 token？

- session_id 是路由标识。
- token 是连接鉴权。
- 防止别人伪造 WebSocket 接管本地项目。

### 9.3 稳定性设计

```python
def is_stale(self, stale_after_seconds: int) -> bool:
    if not self.connected:
        return False
    if self.active_tool_id or self.pending:
        return False
    last_seen = _parse_utc(self.last_seen_at)
    return datetime.utcnow() - last_seen > timedelta(seconds=stale_after_seconds)
```

这避免了：

- 正在读写文件时被误判断线。
- WebSocket ping 超时导致任务误失败。
- 用户页面刷新后状态丢失。

### 9.4 下载和启动命令

文件：`agent-platform/backend/api/local_runner.py`

```python
@router.get("/download")
async def download_local_runner():
    return FileResponse(
        str(path),
        media_type="text/x-python",
        filename="autocode-local-runner.py",
    )

payload["command"] = (
    f"python autocode-local-runner.py --server \"{base_url}\" "
    f"--session {session.session_id} --token {session.token} --project \"{project_arg}\""
)
```

### 9.5 本地导入和云端同步

本地导入可以选择：

- 不同步到云端：只操作本地项目。
- 同步快照到云端：方便云端预览或备份。

核心快照逻辑：

```python
snapshot = await local_runner_manager.execute_tool(
    task_id,
    "snapshot_files",
    {"max_files": 800, "max_total_bytes": 8 * 1024 * 1024, "max_file_bytes": 512 * 1024},
)
```

这里限制文件数、总大小、单文件大小，避免把整个项目或隐私文件无脑上传。

---

## 10. Java 对话系统

### 10.1 流式对话

文件：`backend/src/main/java/com/aiplatform/backend/controller/ChatController.java`

```java
@PostMapping(value = "/conversations/{uuid}/messages/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter sendMessageStream(...) {
    boolean isAgent = req.getAgentId() != null && !req.getAgentId().isBlank();
    SseEmitter emitter = new SseEmitter(isAgent ? 1_800_000L : 180_000L);
    String requestIp = ClientIpUtil.getClientIp(httpRequest);

    sseExecutor.submit(() -> {
        ...
        chatService.ensureConversationExists(userId, uuid, req.getModel());
        List<Map<String, String>> history = chatService.getHistoryForAi(userId, uuid);
        ChatDTO.MessageVO userMsg = chatService.saveUserMessage(...);
    });
}
```

设计点：

- 普通聊天 3 分钟超时。
- Agent 模式 30 分钟超时。
- SSE 异步线程执行，避免阻塞 HTTP 请求线程。
- 对话不存在时自动恢复，避免重启/数据异常导致 SSE 中断。
- 支持 thinking token、tool_call、tool_result、done、error 等事件。

### 10.2 记忆注入

```java
MemoryDTO.MemoryContext ctx = memoryService.buildMemoryContext(userId, conversationId, currentQuery);

if (ctx.getInjectedSystemPrompt() != null && !ctx.getInjectedSystemPrompt().isBlank()) {
    sb.append(ctx.getInjectedSystemPrompt());
}
```

这说明对话不是只靠当前输入，而是会把用户画像、项目记忆、对话摘要等注入 system prompt。

### 10.3 Java 对话系统接入 CacheLedger

```java
cacheLedgerClient.recordProviderUsage(
    "default",
    String.valueOf(userId),
    convUuid,
    model,
    provider,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    latencyMs
);
```

意义：

- Java 对话系统和 AutoCode 共用缓存账本。
- 可以统一统计 cached tokens、命中率、节省成本。
- 后续 Java 客服/对话系统也能复用 L5 solved pattern。

---

## 11. 记忆系统设计

### 11.1 表结构分层

在 `schema.sql` 里有：

- `memory_setting`
- `memory_document`
- `memory_index`
- `memory_archive`
- `memory_work_file`

设计上对应：

| 层级 | 内容 |
|---|---|
| 热记忆 | 当前对话、用户画像、近期项目 |
| 温记忆 | memory_document / memory_index |
| 冷记忆 | memory_archive |
| 工作文件 | memory_work_file |

### 11.2 自动保存项目/技能记忆

文件：`MemoryService.java`

```java
public MemoryDTO.DocumentVO autoSaveProjectMemory(Long userId, String convUuid,
        String projectName, String summary, String content, List<String> tags) {
    MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
    req.setDocType("project_memory");
    req.setTitle(projectName);
    req.setCategory("project");
    req.setContent(content);
    req.setTags(tags);

    MemoryDTO.DocumentVO doc = saveDocument(userId, req, convUuid);

    MemoryDTO.IndexRequest idxReq = new MemoryDTO.IndexRequest();
    idxReq.setDocId(doc.getId());
    idxReq.setCategory("project");
    idxReq.setSummary(summary);
    saveIndex(userId, idxReq);

    return doc;
}
```

### 11.3 对话完成后更新 MEMORY.md / WORK.md

```java
public void autoUpdateConversationMemory(...) {
    String summaryEntry = summarizeWithLlm(userId, userMessage, assistantReply, timestamp, requestIp);

    MemoryDTO.DocumentRequest memReq = new MemoryDTO.DocumentRequest();
    memReq.setTitle("MEMORY.md");
    memReq.setDocType("conversation_memory");
    memReq.setCategory("memory");

    saveDocument(userId, conversationId, memReq);

    if (fileNames != null && !fileNames.isEmpty()) {
        // 更新 WORK.md
    }

    knowledgeGraphService.extractAndUpsertAsync(userId, convUuid, userMessage, assistantReply);
    updateUserProfileFromTurn(userId, userMessage, assistantReply, timestamp);
}
```

面试讲法：

> 我把记忆分成“内容”和“索引”。memory_document 保存原始文档，memory_index 保存摘要、标签和重要性。这样注入上下文时不需要全量读取所有历史，只根据当前 query 取相关记忆，控制 token 成本。

---

## 12. 技能系统设计

### 12.1 技能是什么

技能可以理解为可复用 Agent 插件，包含：

- `SKILL.md`
- system prompt
- toolsJson
- 脚本文件
- 分类、版本、依赖
- ZIP 原始包

### 12.2 技能导入

文件：`SkillImportController.java`

```java
@PreAuthorize("hasAuthority('PERM_skill:publish')")
@PostMapping("/import")
public ResponseEntity<Result<Map<String, Object>>> importSkill(
        @RequestParam("file") MultipartFile file,
        @RequestAttribute Long userId) {

    if (file.getSize() > MAX_IMPORT_SIZE) {
        return ResponseEntity.badRequest().body(Result.fail("ZIP 文件过大"));
    }

    Map<String, Object> result = agentRegistryService.importFromZip(file, userId);
    return ResponseEntity.ok(Result.ok(result));
}
```

关键点：

- 上传大小限制，避免 OOM。
- 权限控制 `PERM_skill:publish`。
- 支持单个导入和批量导入。
- 支持下载原始 ZIP 或动态生成 ZIP。

### 12.3 skill_runner

文件：`backend/skill_runner.py`

用途：

- 自动扫描 Python 脚本依赖。
- 缺依赖时尝试 pip install。
- 运行用户技能脚本。
- 捕获错误并返回结构化结果。

这个设计让技能脚本可以更接近 Coze 插件/工具的体验。

---

## 13. 文件分层与工作区管理

### 13.1 Java 主系统文件

```text
backend/
  controller/       API 层
  service/          业务逻辑
  entity/           数据库实体
  mapper/           MyBatis Mapper
  dto/              请求/响应 DTO
  config/           安全、JWT、OSS、MyBatis 配置
  memory/           分层记忆支持
  resources/
    schema.sql
    migration.sql
    data.sql
```

优点：

- 典型 Spring Boot 分层，面试容易解释。
- Controller 保持薄，业务集中在 Service。
- Entity/Mapper 对应数据库。
- DTO 防止直接暴露实体。

### 13.2 AutoCode 子系统文件

```text
agent-platform/backend/
  api/              FastAPI 路由
  core/             Agent 编排、状态、Docker/workspace
  runtime/          上下文、权限、工具注册、输出裁剪
  services/         cache ledger、本地 runner、memory、task repo
  local_runner/     用户本地执行器
  deploy/           AutoCode 相关部署/迁移
```

### 13.3 工作区文件

AutoCode 每个任务会有 workspace：

```text
.autocode/
  PLAN.md
  MEMORY.md
  SYSTEM_CONTEXT.json
  SESSION_SUMMARY.md
  CI_REPORT.md
  REVIEW.md
  RETRIEVAL_PLAN.md
  tool-output/
```

其中：

- `PLAN.md` 是 guardrail，不再是硬流程。
- `MEMORY.md` 记录任务过程。
- `SYSTEM_CONTEXT.json` 是上下文 manifest。
- `tool-output` 存完整工具输出。

---

## 14. 统一安全计费与 Coding Plan 适配

### 14.1 问题背景

Coding Plan 是上游供应商给 IDE/代码工具的套餐，但用户侧还有自己的企业套餐、钱包余额和平台计费。

如果混在一起会出现：

- 普通对话提示套餐余额不足。
- AutoCode 还能跑，因为它执行后才上报用量。
- 上游余额不足和用户余额不足文案混淆。
- 免费上游套餐可能绕过平台计费。

### 14.2 解决思路

拆成两层：

1. 上游渠道成本层
   - metered
   - coding_plan
   - included

2. 用户侧计费层
   - chat
   - autocode
   - workflow
   - wallet fallback

新增：

- `BillingPolicy`
- `BillingDecision`
- `BillingErrorCode`
- `BillingException`
- `BillingPolicyResolver`

示例配置：

```json
{
  "billing": {
    "scenes": {
      "chat": {
        "enabled": true,
        "costLimit": 100,
        "walletFallbackEnabled": false,
        "upstreamBillingMode": "metered"
      },
      "autocode": {
        "enabled": true,
        "costLimit": 200,
        "walletFallbackEnabled": false,
        "upstreamBillingMode": "coding_plan"
      }
    }
  }
}
```

### 14.3 安全原则

- 钱包兜底默认关闭。
- 开启钱包兜底时只扣超额部分。
- 仍然使用 `WalletService.consume()` 原子扣款。
- 扣费失败不得写 success 流水。
- 上游 quota/billing/account 错误不扣用户钱包。

---

## 15. 开发中遇到的问题与解决方案

### 15.1 固定流水线导致“无文件变更失败”

问题：

冒烟测试/使用说明阶段可能本来不需要修改源码，但系统强制要求每个子任务必须产生文件变更，导致任务失败。

解决：

- 引入 Agentic Loop。
- 阶段计划变成 guardrail。
- finish 条件改为“需求完成 + 验证通过”，而不是“每阶段必须改文件”。

### 15.2 用户明确列出函数/错误点，系统仍要求再说明

问题：

AI controller 只按关键词判断，无法识别“具体修改清单”。

解决：

- 明确可行动需求直接进入 `continue_development`。
- Agentic Loop 自主 search/read/edit/validate。
- 不允许停在“请再描述具体需求”。

### 15.3 中文乱码

问题：

日志、终端、历史文件存在 GBK/UTF-8 混用导致乱码。

解决：

- 新增/修改文件统一 UTF-8。
- 前端活动区要展示中文摘要，不直接把原始工具字段丢给用户。
- 对后续新增文档和配置尽量使用明确编码。

### 15.4 长日志塞爆上下文

问题：

构建日志、终端输出进入模型上下文后，token 成本高且模型注意力下降。

解决：

- Tool Output Store 保存完整输出到文件。
- prompt 只给模型 2k 左右摘要。
- 活动区可点击展开完整输出。

### 15.5 本地项目云端难以复刻

问题：

用户本地项目依赖数据库、文件、私有包，云端 workspace 无法真实测试。

解决：

- 本地 Runner 主动连接服务器 WebSocket。
- 服务器发工具请求，本地执行。
- 支持 `.autocodeignore` 类似忽略策略。
- 不需要公网 IP，不开放本地端口。

### 15.6 本地 Runner 连接不稳定

问题：

WebSocket ping timeout，任务显示断开。

解决：

- 增加 last_seen、stale window、reconnect_count。
- 正在执行工具时不判 stale。
- 服务端 Uvicorn / WebSocket ping 参数调大。
- 客户端自动重连。

### 15.7 普通对话和 AutoCode 计费不一致

问题：

普通对话前置校验企业套餐额度，AutoCode 执行后上报，造成“聊天不能用、代码开发能用”的差异。

解决：

- 统一 `UsageTrackingService.preflightUsage(...)`。
- 场景化额度：chat/autocode/workflow。
- Coding Plan 只作为上游成本模式，不作为用户免费权限。

### 15.8 预览页面 Next.js 静态资源 404

问题：

Next.js `output: export` 生成的 `_next/static`、动态路由和 AutoCode 预览代理路径不匹配。

解决方向：

- 预览代理要正确处理 `_next/static`。
- AI 生成项目时要提示静态导出限制。
- 动态路由使用 `generateStaticParams()`。
- `<a href="/xxx">` 在预览路径下需要避免跳到主系统首页。

---

## 16. 面试讲解重点

### 16.1 一句话介绍项目

> 这是一个 AI 对话与代码开发平台。Java 主系统负责用户、对话、模型、记忆、技能、权限和计费；AutoCode Python 子系统负责代码开发任务，通过 Agentic Loop 自主读取项目、修改代码、运行验证，并支持云端和本地 Runner 两种执行模式。

### 16.2 技术亮点

1. **Agentic Loop 替代固定流程**
   Agent 自主 observe/decide/act/verify，而不是被阶段脚本绑死。

2. **SystemContext Epoch**
   用 manifest + sha256 + diff 管理上下文，避免每轮全量读文件。

3. **多层缓存体系**
   从 L0 工具缓存到 L5 解决方案缓存，并用 CacheLedger 统一记录命中率。

4. **本地 Runner**
   用户本机主动 WebSocket 连接服务器，解决云端环境不一致问题。

5. **双层权限**
   业务 RBAC + Agent 工具权限，危险操作可审批、可拒绝、可审计。

6. **分层记忆系统**
   memory_document + memory_index + memory_archive + work_file，支持长期记忆和上下文注入。

7. **统一计费**
   区分上游 Coding Plan 和用户侧套餐/钱包，避免计费绕过。

### 16.3 可以展开讲的难点

- Agent 如何知道读哪些文件，而不是扫全仓库？
  - SystemContext manifest + retrieval plan + tool cache。

- 如何避免 LLM 反复做无意义操作？
  - CacheLedger、tool cache、epoch diff、agentic checkpoint。

- 如何保证 Agent 写代码后可靠？
  - 写后强制验证，失败继续修复，review/CI 作为 guardrail。

- 如何处理高风险命令？
  - PermissionEngine 风险识别，rm/git reset 等 ask/deny。

- 如何解决用户本地环境无法复刻？
  - Local Runner outbound WebSocket。

- 如何避免支付漏洞？
  - 计费前置 preflight、原子钱包扣款、失败不写 success、场景额度隔离。

---

## 17. 面试回答模板

### Q：你这个 AutoCode 和普通 ChatGPT 调代码有什么区别？

普通 ChatGPT 主要是回答问题，而 AutoCode 是一个任务执行系统。它有工作区、有任务状态、有工具权限、有文件读写、有验证命令、有审查和恢复机制。Agent 不是只给建议，而是能完整执行“读项目 -> 改代码 -> 跑测试 -> 修失败 -> 完成”的闭环。

### Q：为什么不用固定阶段流程？

固定阶段适合标准化项目，但真实用户的需求很碎片化，比如直接说“修复 parse_args 的 input_file 属性”。这种需求不需要先写计划、再原型、再分组。固定流程会造成资源浪费和误判失败。所以我改成 Agentic Loop，阶段只作为 guardrail。

### Q：你怎么控制 token 成本？

主要有四层：

1. SystemContext manifest，不全文拼上下文。
2. 工具结果裁剪，长日志落文件。
3. 工具缓存和 Workspace epoch，没变就不重复读。
4. CacheLedger 记录命中率和 cached tokens，支持后续优化。

### Q：怎么保证安全？

安全分两层：业务 RBAC 控制用户能访问哪些功能；AutoCode PermissionEngine 控制 Agent 能执行哪些工具。比如读文件可以自动允许，写文件和命令执行按风险判断，删除、reset、clean 这类高风险命令必须审批或直接拒绝。

### Q：本地 Runner 为什么不用本地开端口？

因为用户本机可能在 NAT、公司网络或没有公网 IP。Runner 主动连服务器 WebSocket，这样不需要开端口，也减少用户配置成本。服务端只通过已认证 session/token 下发工具请求。

### Q：记忆系统怎么做的？

我把记忆拆成文档和索引。文档存完整内容，索引存摘要、标签、重要性。对话时根据当前 query 检索相关记忆注入 system prompt，而不是把所有历史都塞进去。对话完成后自动更新 MEMORY.md、WORK.md、用户画像和知识图谱。

### Q：Coding Plan 怎么适配？

我把上游渠道成本和用户侧计费拆开。Coding Plan 只是上游 `upstreamBillingMode=coding_plan`，不代表用户免费。用户侧仍按 chat/autocode/workflow 场景额度计费，可以配置独立 autocode 额度，也可以显式开启钱包兜底。

---

## 18. 我会如何继续优化

如果继续迭代，我会做：

1. 给场景计费策略补管理 UI，不只靠 features JSON。
2. CacheLedger 做可视化命中率面板。
3. AutoCode preflight 在任务开始前估算成本，避免长任务跑完才扣费失败。
4. 对 SystemContext 增加更强的语义索引，而不仅是文本摘要。
5. 本地 Runner 增加文件变更流式同步和冲突检测。
6. 活动区做更强的搜索、折叠、错误聚合。
7. 技能系统支持依赖隔离和沙箱执行。

---

## 19. 关键文件索引

AutoCode：

- `agent-platform/backend/core/agent_orchestrator.py`
- `agent-platform/backend/runtime/system_context.py`
- `agent-platform/backend/runtime/context_manager.py`
- `agent-platform/backend/runtime/permission_engine.py`
- `agent-platform/backend/runtime/tool_registry.py`
- `agent-platform/backend/runtime/tool_output_store.py`
- `agent-platform/backend/services/cache_ledger_service.py`
- `agent-platform/backend/services/local_runner_manager.py`
- `agent-platform/backend/api/local_runner.py`

Java 主系统：

- `backend/src/main/java/com/aiplatform/backend/controller/ChatController.java`
- `backend/src/main/java/com/aiplatform/backend/service/MemoryService.java`
- `backend/src/main/java/com/aiplatform/backend/controller/MemoryController.java`
- `backend/src/main/java/com/aiplatform/backend/controller/SkillImportController.java`
- `backend/src/main/java/com/aiplatform/backend/controller/RbacController.java`
- `backend/src/main/java/com/aiplatform/backend/service/UsageTrackingService.java`
- `backend/src/main/java/com/aiplatform/backend/billing/*`
- `backend/src/main/resources/schema.sql`

前端：

- `app/src/pages/AutoCodePage.tsx`
- `app/src/pages/ChatPage.tsx`
- `app/src/components/settings/SettingsDialog.tsx`

部署：

- `deploy/deploy.ps1`
- `deploy/nginx-muhugochat.conf`
- `deploy/billing_scene_policy_migration.sql`

