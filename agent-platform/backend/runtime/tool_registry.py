from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


PermissionDefault = Literal["allow", "ask", "deny"]
SideEffect = Literal["none", "read", "write", "external", "payment"]
OutputMode = Literal["small", "bounded", "stream", "file"]


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    label: str = ""
    action: str = ""
    purpose: str = ""
    side_effect: SideEffect = "none"
    permission_default: PermissionDefault = "ask"
    risk_level: int = 1
    timeout_seconds: int = 60
    allowed_roles: tuple[str, ...] = ("all",)
    cost_tag: str = "autocode"
    cacheable: bool = False
    mutates_workspace: bool = False
    requires_confirmation: bool = False
    output_mode: OutputMode = "bounded"
    max_model_chars: int = 2000
    max_preview_chars: int = 12000
    parameters: dict | None = None
    agent_enabled: bool = False
    local_runner_enabled: bool = False
    metadata: dict = field(default_factory=dict)

    def to_public_dict(self) -> dict:
        return {
            "name": self.name,
            "description": self.description,
            "label": self.label or self.name,
            "action": self.action or self.name,
            "purpose": self.purpose or self.description,
            "side_effect": self.side_effect,
            "permission_default": self.permission_default,
            "risk_level": self.risk_level,
            "timeout_seconds": self.timeout_seconds,
            "allowed_roles": list(self.allowed_roles),
            "cost_tag": self.cost_tag,
            "cacheable": self.cacheable,
            "mutates_workspace": self.mutates_workspace,
            "requires_confirmation": self.requires_confirmation,
            "output_mode": self.output_mode,
            "max_model_chars": self.max_model_chars,
            "max_preview_chars": self.max_preview_chars,
            "parameters": dict(self.parameters or {}),
            "agent_enabled": self.agent_enabled,
            "local_runner_enabled": self.local_runner_enabled,
            "metadata": dict(self.metadata or {}),
        }

    def agent_description(self) -> str:
        return f"{self.action or self.name}: {self.purpose or self.description}"


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def require(self, name: str) -> ToolSpec:
        spec = self.get(name)
        if not spec:
            raise KeyError(f"Unknown AutoCode tool: {name}")
        return spec

    def list(self) -> list[ToolSpec]:
        return sorted(self._tools.values(), key=lambda item: item.name)

    def public_specs(self) -> list[dict]:
        return [spec.to_public_dict() for spec in self.list()]

    def is_cacheable(self, name: str) -> bool:
        spec = self.get(name)
        return bool(spec and spec.cacheable)

    def mutates_workspace(self, name: str) -> bool:
        spec = self.get(name)
        return bool(spec and spec.mutates_workspace)

    def agent_specs(self) -> list[ToolSpec]:
        return [spec for spec in self.list() if spec.agent_enabled]

    def local_runner_specs(self) -> list[ToolSpec]:
        return [spec for spec in self.list() if spec.local_runner_enabled]

    def local_runner_tools(self) -> set[str]:
        return {spec.name for spec in self.local_runner_specs()}

    def can_run_locally(self, name: str) -> bool:
        spec = self.get(name)
        return bool(spec and spec.local_runner_enabled)

    def agent_tool_definitions(self):
        from core.llm_client import ToolDefinition

        return [
            ToolDefinition(
                name=spec.name,
                description=spec.agent_description(),
                parameters=spec.parameters or {"type": "object", "properties": {}},
            )
            for spec in self.agent_specs()
        ]

    def agent_usage_prompt(self) -> str:
        readable_tools = [spec.name for spec in self.agent_specs() if spec.side_effect == "read"]
        write_tools = [spec.name for spec in self.agent_specs() if spec.side_effect == "write"]
        external_tools = [spec.name for spec in self.agent_specs() if spec.side_effect == "external"]
        cacheable_tools = [spec.name for spec in self.agent_specs() if spec.cacheable]
        lines = [
            "## Tool Use Contract",
            "Use the available tools as an autonomous coding agent. Do not follow a fixed phase script when the user's intent is already actionable.",
            f"- Discovery tools: {', '.join(readable_tools)}. Use them to locate relevant files and symbols, not to read the entire project.",
            f"- Edit tools: {', '.join(write_tools)}. Prefer apply_patch for targeted edits to existing files; use write_file mainly for new files or full generated files.",
            f"- External tools: {', '.join(external_tools)}. Use bash for validation, tests, builds, and focused workspace commands.",
            f"- Cacheable tools: {', '.join(cacheable_tools)}. Do not repeat the same cacheable read/search unless the workspace changed or the previous result is insufficient.",
            "- If the user names functions, files, properties, errors, CI output, or concrete review findings, start modifying and validating. Do not ask for the same requirement again.",
            "- Before editing an existing file, inspect the relevant current content. After writing code or config, run an appropriate validation command and fix failures before stopping.",
            "- Keep all paths inside /workspace. Never use parent-directory traversal, host paths, or unrelated workspaces.",
        ]
        return "\n".join(lines)

    def describe_invocation(self, name: str, args: dict | None = None, *, progress: bool = False) -> str:
        args = args or {}
        spec = self.get(name)
        action = (spec.action if spec else "") or name or "tool"
        target = _tool_target(args)
        if spec:
            prefix = f"正在{action}" if progress else action
        else:
            prefix = f"正在执行工具 {name}" if progress else f"执行工具 {name}"
        return f"{prefix}: {target}" if target else prefix


tool_registry = ToolRegistry()


def _compact_value(value: object, limit: int = 80) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    return text if len(text) <= limit else f"{text[:limit]}..."


def _tool_target(args: dict) -> str:
    for key in ("path", "command", "pattern", "message", "description", "action", "target"):
        value = args.get(key)
        if value:
            return _compact_value(value)
    return ""


PATH_PARAM = {
    "type": "string",
    "description": "Workspace-relative path. Do not use .., host paths, or paths outside /workspace.",
}

AGENT_TOOL_PARAMETERS = {
    "read_file": {
        "type": "object",
        "properties": {"path": PATH_PARAM},
        "required": ["path"],
    },
    "write_file": {
        "type": "object",
        "properties": {
            "path": PATH_PARAM,
            "content": {"type": "string", "description": "Complete file content to write."},
        },
        "required": ["path", "content"],
    },
    "bash": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Command to run inside /workspace."},
            "timeout": {"type": "integer", "description": "Optional timeout in seconds."},
        },
        "required": ["command"],
    },
    "glob": {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Glob pattern such as src/**/*.py. Do not use .. or absolute paths."},
        },
        "required": ["pattern"],
    },
    "search_code": {
        "type": "object",
        "properties": {
            "pattern": {"type": "string", "description": "Keyword or regex to search for."},
            "glob": {"type": "string", "description": "Optional file filter such as *.py or src/**."},
        },
        "required": ["pattern"],
    },
    "git_commit": {
        "type": "object",
        "properties": {
            "message": {"type": "string", "description": "Checkpoint commit message."},
        },
        "required": ["message"],
    },
    "apply_patch": {
        "type": "object",
        "properties": {
            "path": PATH_PARAM,
            "search": {"type": "string", "description": "Exact existing text to replace, including indentation and newlines."},
            "replace": {"type": "string", "description": "Replacement text."},
        },
        "required": ["path", "search", "replace"],
    },
    "request_confirmation": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "description": "Operation type."},
            "path": {"type": "string", "description": "Affected path, if any."},
            "reason": {"type": "string", "description": "Why confirmation is needed."},
        },
        "required": ["action", "path", "reason"],
    },
    "generate_prototype": {
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "Natural language UI prototype description."},
        },
        "required": ["description"],
    },
}


def _agent_params(name: str) -> dict | None:
    return AGENT_TOOL_PARAMETERS.get(name)


def _register_defaults() -> None:
    defaults = [
        ToolSpec("read_file", "Read a workspace file", "读取文件", "查看文件", "读取相关源码、配置或记忆文件，帮助 Agent 定位问题。", "read", "allow", 1, 20, cacheable=True, output_mode="bounded", parameters=_agent_params("read_file"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("list_files", "List workspace files", "列出文件", "查看目录", "列出工作区文件结构。", "read", "allow", 1, 20, cacheable=True),
        ToolSpec("search", "Search workspace files (deprecated, use search_code)", "搜索文件", "检索文件", "旧搜索工具，优先使用 search_code。", "read", "allow", 1, 30, cacheable=True),
        ToolSpec("search_code", "Full-text search across workspace files (like ripgrep)", "搜索代码", "检索代码内容", "按函数、属性、错误文本或关键词定位相关代码。", "read", "allow", 1, 30, cacheable=True, parameters=_agent_params("search_code"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("glob", "Find files by glob pattern", "查找文件", "扫描文件结构", "按文件名或模式寻找候选文件。", "read", "allow", 1, 30, cacheable=True, parameters=_agent_params("glob"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("write_file", "Create or update a workspace file", "写入文件", "创建/修改文件", "把 Agent 的代码、文档或配置改动写入工作区。", "write", "ask", 2, 30, mutates_workspace=True, requires_confirmation=True, parameters=_agent_params("write_file"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("apply_patch", "Apply a structured patch", "精准修改", "应用补丁", "对已有文件做小范围精确修改。", "write", "allow", 2, 30, mutates_workspace=True, parameters=_agent_params("apply_patch"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("bash", "Run a command inside the task workspace", "终端命令", "执行命令", "在工作区运行验证、构建、文件查看或脚本命令。", "external", "ask", 3, 300, requires_confirmation=True, output_mode="stream", parameters=_agent_params("bash"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("run_command", "Run a curated workspace command", "运行命令", "执行命令", "运行用户或系统选择的工作区命令。", "external", "ask", 2, 300, requires_confirmation=True, output_mode="stream"),
        ToolSpec("run_tests", "Run workspace tests", "运行测试", "执行测试", "运行项目测试命令。", "external", "allow", 2, 600, output_mode="stream"),
        ToolSpec("run_build", "Run workspace build", "项目构建", "执行构建", "运行项目构建命令。", "external", "allow", 2, 600, output_mode="stream"),
        ToolSpec("git_status", "Inspect Git status", "Git 状态", "查看变更", "查看工作区 Git 状态。", "read", "allow", 1, 20, cacheable=True),
        ToolSpec("git_diff", "Inspect Git diff", "Git Diff", "查看差异", "查看当前代码差异。", "read", "allow", 1, 30, cacheable=True, local_runner_enabled=True),
        ToolSpec("git_commit", "Create a checkpoint commit", "保存快照", "创建 Git 快照", "保存一组可审查、可回退的自动变更。", "write", "allow", 2, 30, mutates_workspace=True, parameters=_agent_params("git_commit"), agent_enabled=True),
        ToolSpec("rollback", "Rollback to a checkpoint", "回退快照", "回退修改", "将工作区恢复到指定快照或提交。", "write", "ask", 4, 60, mutates_workspace=True, requires_confirmation=True),
        ToolSpec("start_preview", "Start a preview server", "启动预览", "启动服务", "启动项目预览服务。", "external", "ask", 3, 120, requires_confirmation=True),
        ToolSpec("spawn_subagent", "Start a subagent with scoped context", "子 Agent", "启动子任务", "启动带作用域上下文的子 Agent。", "external", "ask", 3, 60, requires_confirmation=True),
        ToolSpec("ask_user", "Ask the user for approval or clarification", "询问用户", "请求输入", "需要用户补充信息或确认时发起询问。", "none", "allow", 1, 10),
        ToolSpec("generate_prototype", "Generate a UI prototype", "生成原型", "生成 UI 原型", "生成交互式 UI 原型。", "external", "ask", 3, 120, requires_confirmation=True, parameters=_agent_params("generate_prototype"), agent_enabled=True),
        ToolSpec("request_confirmation", "Request user confirmation", "请求确认", "等待人工确认", "高风险操作执行前暂停，等待用户批准或拒绝。", "none", "allow", 1, 10, parameters=_agent_params("request_confirmation"), agent_enabled=True),
        ToolSpec("thinking", "Expose model reasoning progress", "思考过程", "展示思考", "展示 Agent 的阶段性思考进度。", "none", "allow", 1, 10, output_mode="small", max_model_chars=800, max_preview_chars=2000),
    ]
    for spec in defaults:
        tool_registry.register(spec)


_register_defaults()
