# Permission Engine

Agent 能自己写文件、跑 bash，这很强大，也很危险。Permission Engine 是套在工具执行之前的一道闸门：每次调用工具，都要先问它"这个能放行吗"。这一章讲这套分层防御怎么设计。

## 三种决策

引擎的输出是一个 `PermissionDecision`，核心是三选一：

| 决策 | 含义 | 典型场景 |
|------|------|----------|
| `allow` | 直接放行 | 只读工具（读文件、搜索） |
| `ask` | 需要用户确认 | bash 命令、写文件 |
| `deny` | 直接拒绝 | 越权、路径穿越、毁灭性命令 |

`decision` 之外还带 `reason`（为什么）、`risk_level`（风险分级）、`approval_payload`（要用户确认时给前端展示的信息）。

## check：分层防御的主流程

这是整个引擎的核心，一层层往下过，任何一层拦下就立即返回：

<SourceExplainer
  file="agent-platform/backend/runtime/permission_engine.py"
  :notes="[
    { lines: '1-11', text: '第一层：工具是否存在。未知工具不直接拒绝，而是 ask——留一个人工判断的余地，同时给中等风险分。' },
    { lines: '13-15', text: '第二层：角色校验。基于 ToolSpec.allowed_roles，当前角色无权使用就直接 deny。' },
    { lines: '17-27', text: '第三层（仅 bash）：先查毁灭性命令黑名单。命中 FORBIDDEN 的（如 rm -rf /）即使用户想确认也直接 deny——这类操作不可恢复，不给确认机会。' },
    { lines: '28-38', text: '第三层续：非毁灭但需审查的 bash，返回 ask，并把命令和是否高危放进 approval_payload 给前端展示。' }
  ]">

```python
def check(self, tool_name, args=None, *, role="agent", workspace_root=None):
    spec = tool_registry.get(tool_name)
    args = args or {}
    if spec is None:
        return PermissionDecision(
            decision="ask",
            reason=f"unknown tool {tool_name}",
            tool_name=tool_name,
            permission_default="ask",
            risk_level=3,
        )

    role_decision = self._check_role(spec, role)
    if role_decision is not None:
        return role_decision

    if tool_name == "bash":
        command = str(args.get("command", ""))
        if is_forbidden_destructive_command(command):
            return PermissionDecision(
                decision="deny",
                reason="forbidden destructive command",
                tool_name=tool_name,
                permission_default="deny",
                risk_level=max(spec.risk_level, 4),
                approval_payload={"command": command, "high_risk": True, "destructive": True},
            )
        if spec.permission_default != "allow" or is_destructive_command(command):
            return PermissionDecision(
                decision="ask",
                reason="bash command requires review",
                tool_name=tool_name,
                permission_default=spec.permission_default,
                risk_level=max(spec.risk_level, 4) if is_destructive_command(command) else spec.risk_level,
                approval_payload={"command": command, "high_risk": is_destructive_command(command)},
            )

    path_decision = self._check_workspace_path(spec, args, workspace_root)
    if path_decision is not None:
        return path_decision

    configured = self.tool_policy.get(tool_name, spec.permission_default)
    if configured not in ("allow", "ask", "deny"):
        configured = spec.permission_default
    return PermissionDecision(
        decision=configured,
        reason="policy decision",
        tool_name=tool_name,
        permission_default=spec.permission_default,
        risk_level=spec.risk_level,
    )
```

</SourceExplainer>

防御层次自上而下：**存在性 → 角色 → bash 命令安全 → 路径安全 → 策略默认值**。这是典型的"快速失败"——最危险、最容易判断的先拦。

## 两级命令黑名单

bash 命令的安全判断靠两个模式列表：

<SourceExplainer
  file="agent-platform/backend/runtime/permission_engine.py"
  :notes="[
    { lines: '1-6', text: 'is_destructive_command：命中即视为危险，走 ask（要用户确认）。覆盖 rm -rf、git push、drop table、truncate、shutdown 等。' },
    { lines: '8-13', text: 'is_forbidden_destructive_command：真正不可恢复的，即使确认也 deny。这是黑名单里的黑名单。' }
  ]">

```python
DESTRUCTIVE_PATTERNS = (
    "rm -rf", "rm -r", "git push", "drop table", "drop database",
    "truncate", "shutdown", "reboot", "mkfs", ":(){", "dd if=",
)

FORBIDDEN_PATTERNS = (
    "rm -rf /", "rm -rf /*", ":(){ :|:& };:",
    "mkfs", "> /dev/sda", "dd if=/dev/zero of=/dev/",
)
```

</SourceExplainer>

两级设计的意义：`git push` 是危险但合理的操作（用户确认后可以做），而 `rm -rf /` 或 fork 炸弹 `:(){ :|:& };:` 没有任何合理的确认场景，直接封死。

## 路径穿越防护

写文件类工具还要过路径校验，防止 Agent 写到工作区外面：

<SourceExplainer
  file="agent-platform/backend/runtime/permission_engine.py"
  :notes="[
    { lines: '1-6', text: '从参数里取路径（兼容 path/file/file_path 三种键）。含 .. 段的直接 deny——防目录穿越。' },
    { lines: '8-16', text: '有工作区根目录时，把路径 resolve 成绝对路径，检查它是否仍在工作区内。逃逸出去就 deny。resolve 会解开符号链接和 .. ，是防穿越的可靠做法。' }
  ]">

```python
def _check_workspace_path(self, spec, args, workspace_root):
    raw_path = args.get("path") or args.get("file") or args.get("file_path")
    if not raw_path:
        return None
    if ".." in str(raw_path).split("/"):
        return PermissionDecision(decision="deny",
            reason="parent directory traversal is not allowed",
            tool_name=spec.name, risk_level=spec.risk_level)
    if workspace_root:
        try:
            resolved = (Path(workspace_root) / raw_path).resolve()
            if not str(resolved).startswith(str(Path(workspace_root).resolve())):
                return PermissionDecision(decision="deny",
                    reason="path escapes current workspace",
                    tool_name=spec.name, risk_level=spec.risk_level)
        except Exception as exc:
            return PermissionDecision(decision="deny",
                reason=f"path validation failed: {exc}",
                tool_name=spec.name, risk_level=spec.risk_level)
    return None
```

</SourceExplainer>

## 与 Docker 隔离的关系

Permission Engine 是**应用层**的防护（不让 Agent 发出危险调用），[Docker 隔离](/autocode/docker-isolation) 是**系统层**的防护（就算发出了也跑在隔离容器里）。两层是纵深防御：应用层拦大多数，系统层兜底。任何一层单独都不够，合起来才稳。

## 相关源码

- `agent-platform/backend/runtime/permission_engine.py` — PermissionEngine、命令黑名单、路径校验

下一章 [Docker 隔离执行](/autocode/docker-isolation) 讲系统层这道防线怎么建。
