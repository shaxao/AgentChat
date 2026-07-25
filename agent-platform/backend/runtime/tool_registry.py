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

        definitions = []
        for spec in self.agent_specs():
            description = spec.agent_description()
            if spec.name == "spawn_subagent":
                description += (
                    " Set background=true to start it asynchronously; the parent "
                    "agent will receive the result automatically in a later "
                    "iteration, so do not poll or sleep."
                )
            definitions.append(ToolDefinition(
                name=spec.name,
                description=description,
                parameters=spec.parameters or {"type": "object", "properties": {}},
            ))
        return definitions

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
            "- NEVER create or modify files through bash (echo/cat heredoc/printf/sed -i/PowerShell Out-File/Set-Content). Always use write_file or apply_patch instead: shell redirection mangles non-ASCII (e.g. Chinese) content on GBK terminals and wastes tokens on escaping.",
            f"- External tools: {', '.join(external_tools)}. Use bash for validation, tests, builds, and focused workspace commands — not for writing files.",
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
        if name == "code_editor":
            command = str(args.get("command") or "").strip()
            if command == "view":
                action = "查看文件"
            elif command == "undo_edit":
                action = "撤销编辑"
            elif command in {"create", "str_replace", "insert"}:
                action = "编辑文件"
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
    "read_lines": {
        "type": "object",
        "properties": {
            "path": PATH_PARAM,
            "start": {"type": "integer", "description": "1-based first line to read."},
            "end": {"type": "integer", "description": "1-based inclusive last line to read. Maximum span is 240 lines."},
        },
        "required": ["path", "start", "end"],
    },
    "write_file": {
        "type": "object",
        "properties": {
            "path": PATH_PARAM,
            "content": {"type": "string", "description": "Complete file content to write."},
        },
        "required": ["path", "content"],
    },
    "local_write_text_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path inside the authorized local project root."},
            "content": {"type": "string", "description": "Complete text content to write."},
            "encoding": {"type": "string", "description": "utf-8 or utf-8-sig.", "default": "utf-8"},
        },
        "required": ["path", "content"],
    },
    "local_read_text_file": {
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path inside the authorized local project root."},
            "encoding": {"type": "string", "description": "utf-8 or utf-8-sig.", "default": "utf-8"},
        },
        "required": ["path"],
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
    "lsp": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": [
                    "goToDefinition", "findReferences", "hover",
                    "documentSymbol", "workspaceSymbol",
                ],
                "description": "goToDefinition/findReferences/hover need path+line+character; documentSymbol needs path; workspaceSymbol needs path (to pick the server) + query.",
            },
            "path": PATH_PARAM,
            "line": {"type": "integer", "description": "1-based line number (as shown in editors). Required except for workspaceSymbol."},
            "character": {"type": "integer", "description": "1-based column number. Required for goToDefinition/findReferences/hover."},
            "query": {"type": "string", "description": "Symbol name to search for. Required for workspaceSymbol."},
        },
        "required": ["operation", "path"],
    },
    "spawn_subagent": {
        "type": "object",
        "properties": {
            "subagent_type": {
                "type": "string",
                "enum": ["researcher", "reviewer"],
                "description": "Read-only subagent role: 'researcher' for investigation/tech analysis, 'reviewer' for read-only code review. No write access.",
            },
            "prompt": {
                "type": "string",
                "description": "Detailed, self-contained task for the subagent. It starts with a fresh context, so include everything it needs and state exactly what conclusion to return.",
            },
            "description": {
                "type": "string",
                "description": "Short 3-5 word label for this subagent task.",
            },
            "background": {
                "type": "boolean",
                "description": "When true, start the subagent asynchronously and return immediately. The result will be delivered to the parent agent automatically in a later iteration; do not poll or sleep.",
            },
        },
        "required": ["subagent_type", "prompt"],
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
    "code_editor": {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "enum": ["view", "create", "str_replace", "insert", "undo_edit"],
                "description": "Editor command: view (read with line numbers), create (new/overwrite file), str_replace (exact unique replacement), insert (insert at line), undo_edit (revert last edit).",
            },
            "path": PATH_PARAM,
            "file_text": {"type": "string", "description": "Complete file content. Required for create."},
            "old_str": {"type": "string", "description": "Exact existing text to replace; must occur exactly once. Required for str_replace."},
            "new_str": {"type": "string", "description": "Replacement text for str_replace, or text block to insert for insert."},
            "insert_line": {"type": "integer", "description": "1-based line number after which new_str is inserted. Required for insert."},
            "view_range": {
                "type": "array",
                "items": {"type": "integer"},
                "description": "Optional [start_line, end_line] 1-based inclusive range for view.",
            },
        },
        "required": ["command", "path"],
    },
    "request_confirmation": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "description": "Operation type."},
            "path": {"type": "string", "description": "Affected path, if any."},
            "reason": {"type": "string", "description": "Why confirmation is needed."},
            "tool": {"type": "string", "description": "Optional original write tool to execute immediately after approval."},
            "tool_args": {"type": "object", "description": "Optional original write tool arguments to execute immediately after approval."},
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
        ToolSpec("read_lines", "Read a specific line range from a workspace file", "读取行范围", "查看指定行", "读取大文件或已定位文件的指定行范围，返回带行号片段；大 HTML/模板文件优先使用它而不是 shell 临时脚本。", "read", "allow", 1, 20, cacheable=True, output_mode="bounded", parameters=_agent_params("read_lines"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("list_files", "List workspace files", "列出文件", "查看目录", "列出工作区文件结构。", "read", "allow", 1, 20, cacheable=True),
        ToolSpec("search", "Search workspace files (deprecated, use search_code)", "搜索文件", "检索文件", "旧搜索工具，优先使用 search_code。", "read", "allow", 1, 30, cacheable=True),
        ToolSpec("search_code", "Full-text search across workspace files (like ripgrep)", "搜索代码", "检索代码内容", "按函数、属性、错误文本或关键词定位相关代码。", "read", "allow", 1, 30, cacheable=True, parameters=_agent_params("search_code"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("glob", "Find files by glob pattern", "查找文件", "扫描文件结构", "按文件名或模式寻找候选文件。", "read", "allow", 1, 30, cacheable=True, parameters=_agent_params("glob"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("lsp", "Query language-server code intelligence", "代码智能", "查询代码智能", "用语言服务器精确跳转定义、查找引用、查看类型/悬停信息、列出文件或项目符号，比文本搜索更准确。", "read", "allow", 1, 30, parameters=_agent_params("lsp"), agent_enabled=True),
        ToolSpec("write_file", "Create or update a workspace file", "写入文件", "创建/修改文件", "把 Agent 的代码、文档或配置改动写入工作区。", "write", "ask", 2, 30, mutates_workspace=True, requires_confirmation=True, parameters=_agent_params("write_file"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("apply_patch", "Apply a structured patch", "精准修改", "应用补丁", "对已有文件做小范围精确修改。", "write", "allow", 2, 30, mutates_workspace=True, parameters=_agent_params("apply_patch"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("code_editor", "View and edit files with editor commands", "代码编辑器", "编辑文件", "以编辑器方式查看（带行号）、创建、精确替换、插入文件内容，支持撤销，全程 UTF-8 安全，是修改文件的首选工具。", "write", "allow", 2, 30, mutates_workspace=True, parameters=_agent_params("code_editor"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("bash", "Run a command inside the task workspace", "终端命令", "执行命令", "在工作区运行验证、构建、文件查看或脚本命令。", "external", "ask", 3, 300, requires_confirmation=True, output_mode="stream", parameters=_agent_params("bash"), agent_enabled=True, local_runner_enabled=True),
        ToolSpec("run_command", "Run a curated workspace command", "运行命令", "执行命令", "运行用户或系统选择的工作区命令。", "external", "ask", 2, 300, requires_confirmation=True, output_mode="stream"),
        ToolSpec("run_tests", "Run workspace tests", "运行测试", "执行测试", "运行项目测试命令。", "external", "allow", 2, 600, output_mode="stream"),
        ToolSpec("run_build", "Run workspace build", "项目构建", "执行构建", "运行项目构建命令。", "external", "allow", 2, 600, output_mode="stream"),
        ToolSpec("git_status", "Inspect Git status", "Git 状态", "查看变更", "查看工作区 Git 状态。", "read", "allow", 1, 20, cacheable=True),
        ToolSpec("git_diff", "Inspect Git diff", "Git Diff", "查看差异", "查看当前代码差异。", "read", "allow", 1, 30, cacheable=True, local_runner_enabled=True),
        ToolSpec("git_commit", "Create a checkpoint commit", "保存快照", "创建 Git 快照", "保存一组可审查、可回退的自动变更。", "write", "allow", 2, 30, mutates_workspace=True, parameters=_agent_params("git_commit"), agent_enabled=True),
        ToolSpec("rollback", "Rollback to a checkpoint", "回退快照", "回退修改", "将工作区恢复到指定快照或提交。", "write", "ask", 4, 60, mutates_workspace=True, requires_confirmation=True),
        ToolSpec("start_preview", "Start a preview server", "启动预览", "启动服务", "启动项目预览服务。", "external", "ask", 3, 120, requires_confirmation=True),
        ToolSpec("spawn_subagent", "Spawn a read-only research/review subagent", "子 Agent", "启动子任务", "派生一个只读研究/审查子 Agent（researcher 或 reviewer），它只能读取和搜索工作区、返回一段结论文本；用于需要独立调研或代码审查而不希望污染当前上下文时。", "external", "ask", 3, 120, requires_confirmation=True, parameters=_agent_params("spawn_subagent"), agent_enabled=True),
        ToolSpec("ask_user", "Ask the user for approval or clarification", "询问用户", "请求输入", "需要用户补充信息或确认时发起询问。", "none", "allow", 1, 10),
        ToolSpec("generate_prototype", "Generate a UI prototype", "生成原型", "生成 UI 原型", "生成交互式 UI 原型。", "external", "ask", 3, 120, requires_confirmation=True, parameters=_agent_params("generate_prototype"), agent_enabled=True),
        ToolSpec("request_confirmation", "Request user confirmation", "请求确认", "等待人工确认", "高风险操作执行前暂停，等待用户批准或拒绝。", "none", "allow", 1, 10, parameters=_agent_params("request_confirmation"), agent_enabled=True),
        ToolSpec("thinking", "Expose model reasoning progress", "思考过程", "展示思考", "展示 Agent 的阶段性思考进度。", "none", "allow", 1, 10, output_mode="small", max_model_chars=800, max_preview_chars=2000),
    ]
    for spec in defaults:
        tool_registry.register(spec)


_register_defaults()
tool_registry.register(ToolSpec(
    "local_write_text_file",
    "Create or update a text file in the authorized local project",
    "写入本地文本",
    "写入本地文本文件",
    "在 Local Connector 授权的本地项目目录内写入 UTF-8 文本文件。",
    "write",
    "ask",
    2,
    30,
    mutates_workspace=True,
    requires_confirmation=True,
    parameters=_agent_params("local_write_text_file"),
    local_runner_enabled=True,
))
tool_registry.register(ToolSpec(
    "local_read_text_file",
    "Read a text file in the authorized local project",
    "读取本地文本",
    "读取本地文本文件",
    "读取 Local Connector 授权的本地项目目录内 UTF-8 文本文件。",
    "read",
    "allow",
    1,
    20,
    cacheable=True,
    parameters=_agent_params("local_read_text_file"),
    local_runner_enabled=True,
))
