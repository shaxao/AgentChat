# -*- coding: utf-8 -*-
"""
Provider-agnostic AutoCode Agent orchestrator.

The orchestrator coordinates AI planning, bounded tool execution, artifact
validation, continuation context, review, and task completion events.
"""
import asyncio
import difflib
import json
import os
import posixpath
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from loguru import logger

from core.config import get_settings
from core.docker_manager import docker_manager
from core.git_manager import git_manager
from core.llm_client import LLMClient, ToolDefinition, LLMResponse, ToolCall, create_client_from_channel
from core.model_router import (
    ModelRouter, TaskContext, FailoverLLMClient, model_router, failure_tracker,
)
from core.workspace_index import (
    glob_workspace_files,
    invalidate_workspace_index,
    load_workspace_index,
    is_actionable_development_request,
    plan_retrieval,
    RetrievalPlan,
    render_retrieval_plan,
    search_workspace_code,
)
from core.state import _tasks, _confirmations
from core.review_agent import ReviewAgent
from core.execution_protocol import build_task_capability_profile, is_auxiliary_artifact
from schemas.task import SubTask, SubTaskStatus, TaskPlan
from services.channel_service import select_best_tool_model, fetch_all_channels, resolve_channel_for_model
from services.dev_server_manager import dev_server_manager
from services import harness_repository
from services.researcher_agent import researcher_agent
from services.terminal_manager import terminal_manager
from services.usage_reporter import usage_agent, UsageContext, _usage_context
from services.local_runner_manager import local_runner_manager
from services.cache_ledger_service import CacheLedgerEvent, cache_ledger_service, stable_hash
from runtime.agent_loop import agent_loop
from runtime.session_events import append_event
from runtime.checkpoints import create_snapshot
from runtime.tool_output_store import bound_tool_output
from runtime.tool_registry import tool_registry
from services.memory_service import memory_service
SOURCE_FILE_SUFFIXES = {
    ".js", ".jsx", ".ts", ".tsx", ".vue", ".svelte", ".astro", ".html", ".css", ".scss",
    ".py", ".go", ".java", ".kt", ".rs", ".php", ".rb", ".cs",
}
IGNORED_WORKSPACE_PARTS = {
    ".git", ".autocode", "node_modules", "dist", "build", ".next", "__pycache__",
}


class AgentWaitingForUserInput(Exception):
    """Stop the current execution stack while preserving a structured user question."""


def _read_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}


def _plan_steps(execution_plan: dict[str, Any] | None) -> list[dict[str, Any]]:
    return [step for step in ((execution_plan or {}).get("validation_plan") or []) if isinstance(step, dict)]


def _planned_command(execution_plan: dict[str, Any] | None, kinds: set[str]) -> tuple[str | None, str]:
    for step in _plan_steps(execution_plan):
        command = str(step.get("command") or "").strip()
        kind = str(step.get("kind") or "command").strip().lower()
        if command and kind in kinds:
            return command, str(step.get("description") or f"execution plan: {kind}")
    return None, ""


def _select_validation_command(
    ws_path: Path,
    project_type: str = "",
    execution_plan: dict[str, Any] | None = None,
    changed_files: list[str] | None = None,
) -> tuple[str | None, str]:
    planned, reason = _planned_command(
        execution_plan,
        {"command", "validate", "validation", "test", "build", "lint", "typecheck", "check"},
    )
    if planned:
        return planned, reason

    package = _read_json_file(ws_path / "package.json") if (ws_path / "package.json").exists() else {}
    scripts = package.get("scripts") or {}
    if scripts:
        for name in ("test", "build", "lint", "typecheck", "check"):
            if name in scripts:
                if (ws_path / "pnpm-lock.yaml").exists():
                    return f"pnpm run {name}", f"package.json script: {name}"
                if (ws_path / "yarn.lock").exists():
                    return f"yarn {name}", f"package.json script: {name}"
                if (ws_path / "bun.lockb").exists() or (ws_path / "bun.lock").exists():
                    return f"bun run {name}", f"package.json script: {name}"
                return f"npm run {name}", f"package.json script: {name}"

    changed_python = [path for path in (changed_files or []) if Path(path).suffix.lower() == ".py"]
    if (ws_path / "pyproject.toml").exists() or (ws_path / "requirements.txt").exists() or changed_python or any(ws_path.glob("*.py")):
        if (ws_path / "tests").exists() or any(ws_path.glob("test_*.py")):
            return "python -m pytest", "Python tests"
        return "python -m compileall -q .", "Python syntax compile"
    if (ws_path / "pom.xml").exists():
        return "mvn test", "Maven tests"
    if (ws_path / "gradlew").exists():
        return "./gradlew test", "Gradle wrapper tests"
    if (ws_path / "build.gradle").exists() or (ws_path / "settings.gradle").exists():
        return "gradle test", "Gradle tests"
    if (ws_path / "go.mod").exists():
        return "go test ./...", "Go tests"
    if (ws_path / "Cargo.toml").exists():
        return "cargo test", "Rust tests"
    if any(ws_path.glob("*.sln")) or any(ws_path.glob("*.csproj")) or any(ws_path.glob("*.fsproj")):
        return "dotnet test", ".NET tests"
    if (ws_path / "Makefile").exists() or (ws_path / "makefile").exists():
        return "make test", "Make test target"
    if (ws_path / "composer.json").exists():
        return "composer test", "Composer test script"
    if (ws_path / "Gemfile").exists():
        return "bundle exec rake test", "Ruby test task"
    if (ws_path / "mix.exs").exists():
        return "mix test", "Elixir tests"
    if (ws_path / "pubspec.yaml").exists():
        return "dart analyze", "Dart analysis"
    if (ws_path / "Package.swift").exists():
        return "swift test", "Swift tests"
    if (ws_path / "deno.json").exists() or (ws_path / "deno.jsonc").exists():
        return "deno test", "Deno tests"

    shell_scripts = list(ws_path.glob("*.sh"))
    if shell_scripts:
        return "bash -n " + " ".join(path.name for path in shell_scripts[:5]), "Shell syntax check"
    ps_scripts = list(ws_path.glob("*.ps1"))
    if ps_scripts:
        return 'pwsh -NoProfile -Command "Get-ChildItem *.ps1 | ForEach-Object { $null = [scriptblock]::Create((Get-Content $_ -Raw)) }"', "PowerShell syntax check"
    return None, "artifact validation only; no command declared or inferred"

def _is_implementation_file(raw_path: str) -> bool:
    normalized = str(raw_path or "").replace("\\", "/").strip("/")
    if not normalized or is_auxiliary_artifact(normalized):
        return False
    name = normalized.rsplit("/", 1)[-1].lower()
    if name.startswith(("readme", "changelog", "license", "contributing", "code_of_conduct")):
        return False
    # Exclude known delivery/data assets instead of trying to enumerate every
    # programming language. An unfamiliar extension remains a valid code target.
    non_implementation_suffixes = {
        ".md", ".mdx", ".rst", ".txt", ".pdf", ".doc", ".docx",
        ".ppt", ".pptx", ".xls", ".xlsx", ".csv", ".tsv",
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico",
        ".mp3", ".wav", ".mp4", ".mov", ".avi", ".zip", ".tar", ".gz",
    }
    return Path(name).suffix.lower() not in non_implementation_suffixes


def _has_source_file(files: list[str] | tuple[str, ...] | set[str]) -> bool:
    return any(_is_implementation_file(raw) for raw in (files or []))


def _subtask_expects_source(subtask: SubTask, project_type: str = "") -> bool:
    semantic_text = " ".join([subtask.title or "", subtask.description or ""]).lower()
    explicitly_non_implementation = (
        "不实现", "无需实现", "不修改源码", "不产出代码", "只定义契约", "仅定义契约",
        "do not implement", "without implementation", "no code changes", "contract only",
    )
    if any(token in semantic_text for token in explicitly_non_implementation):
        return False

    implementation_tokens = (
        "实现", "开发", "核心行为", "功能改动", "修复", "修改源码", "代码改动", "真实源码",
        "implement", "develop", "fix", "modify source", "code change", "feature",
    )
    if any(token in semantic_text for token in implementation_tokens):
        return True

    documentation_or_validation_tokens = (
        "冒烟测试", "使用说明", "使用指南", "仅验证", "验证阶段", "代码审查", "产物审查",
        "契约", "文档", "项目地图", "原型", "规划",
        "smoke test", "usage notes", "usage guide", "validation only", "review only",
        "contract", "documentation", "project map", "prototype", "planning",
    )
    if any(token in semantic_text for token in documentation_or_validation_tokens):
        return False

    return any(_is_implementation_file(raw) for raw in (subtask.estimated_files or []))

def _normalize_agent_path(raw_path: str) -> str:
    raw = (raw_path or "").strip().replace("\\", "/")
    if raw in ("", ".", "/workspace", "/workspace/"):
        return "."
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    elif raw.startswith("workspace/"):
        raw = raw[len("workspace/"):]
    elif raw.startswith("/"):
        raise PermissionError("absolute paths outside /workspace are not allowed")
    while raw.startswith("./"):
        raw = raw[2:]
    return raw


def _safe_workspace_path(ws_path: Path, raw_path: str, *, must_exist: bool = False) -> Path:
    root = ws_path.resolve()
    rel = _normalize_agent_path(raw_path)
    if any(part == ".." for part in Path(rel).parts):
        raise PermissionError("parent-directory traversal is not allowed")
    target = (root / rel).resolve(strict=must_exist)
    try:
        target.relative_to(root)
    except ValueError:
        raise PermissionError("path escapes the current task workspace")
    return target


def _read_lines_result(path: Path, rel_path: str, start: int, end: int, *, max_lines: int = 240) -> str:
    if start < 1:
        start = 1
    if end < start:
        end = start
    if end - start + 1 > max_lines:
        end = start + max_lines - 1
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    total = len(lines)
    selected = lines[start - 1:min(end, total)]
    width = max(len(str(min(end, total))), len(str(start)), 3)
    body = "\n".join(
        f"{idx:>{width}} | {line}"
        for idx, line in enumerate(selected, start=start)
    )
    if not body:
        body = "(no lines in requested range)"
    display_end = min(end, total) if total else 0
    if start > total:
        display_end = total
    return f"[OK] {rel_path} lines {start}-{display_end} of {total}\n{body}"


def _surface_map_candidates_for_task(ws_path: Path, task: dict | None) -> list[str]:
    if not task:
        return []
    profile_path = ws_path / ".autocode" / "PROJECT_PROFILE.json"
    surface_map: dict[str, list[str]] = {}
    try:
        data = json.loads(profile_path.read_text(encoding="utf-8", errors="replace"))
        raw = data.get("surface_map") if isinstance(data, dict) else {}
        if isinstance(raw, dict):
            for key, values in raw.items():
                if isinstance(values, list):
                    surface_map[str(key)] = [str(value) for value in values if value]
    except Exception:
        return []
    if not surface_map:
        return []
    task_text = " ".join(
        str(task.get(key) or "")
        for key in ("title", "description", "original_request", "user_request", "current_step")
    ).lower()
    buckets: list[str] = []
    if any(term in task_text for term in ("页面", "界面", "软件", "看不到", "gui", "ui", "view", "screen", "frontend")):
        buckets.append("app_gui")
    if any(term in task_text for term in ("官网", "文档", "docs", "documentation", "site")):
        buckets.append("docs_site")
    if any(term in task_text for term in ("api", "接口", "后端", "server", "backend", "flask")):
        buckets.append("backend_api")
    if any(term in task_text for term in ("配置", "设置", "config", "settings")):
        buckets.append("config_store")
    if any(term in task_text for term in ("包", "库", "源码", "package", "source", "library")):
        buckets.append("package_source")
    if not buckets:
        return []
    candidates: list[str] = []
    seen: set[str] = set()
    for bucket in buckets:
        for rel_path in surface_map.get(bucket) or []:
            normalized = str(rel_path).replace("\\", "/").lstrip("/")
            if normalized and normalized not in seen:
                candidates.append(normalized)
                seen.add(normalized)
    return candidates


# ── code_editor 工具辅助：原子写入、撤销栈、unified diff ──
_CODE_EDITOR_UNDO: dict[str, list[str | None]] = {}
_CODE_EDITOR_UNDO_LIMIT = 20
_CODE_EDITOR_DIFF_LIMIT = 4000


def _code_editor_push_undo(key: str, old_text: str | None) -> None:
    stack = _CODE_EDITOR_UNDO.setdefault(key, [])
    stack.append(old_text)
    if len(stack) > _CODE_EDITOR_UNDO_LIMIT:
        del stack[0]


def _atomic_write_text(path: Path, text: str) -> None:
    """原子写入文本（同目录临时文件 + os.replace），全程 UTF-8。"""
    tmp = path.with_name(path.name + ".tmp-autocode")
    tmp.write_text(text, encoding="utf-8", newline="")
    os.replace(tmp, path)


def _unified_diff_text(old: str, new: str, rel_path: str) -> str:
    diff_lines = list(difflib.unified_diff(
        old.splitlines(), new.splitlines(),
        fromfile=f"a/{rel_path}", tofile=f"b/{rel_path}", lineterm="", n=3,
    ))
    if not diff_lines:
        return "(无内容差异)"
    out = "\n".join(diff_lines)
    if len(out) > _CODE_EDITOR_DIFF_LIMIT:
        out = out[:_CODE_EDITOR_DIFF_LIMIT] + "\n... (diff 已截断)"
    return out


def code_editor_undo_for_workspace(workspace_id: str, rel_path: str) -> str | None:
    """供 API 调用：弹出 code_editor 撤销栈顶并恢复文件内容。

    返回恢复结果描述文本；没有可撤销的编辑时返回 None。
    """
    settings = get_settings()
    ws_path = settings.workspace_base_dir / workspace_id
    normalized = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
    undo_key = f"{ws_path}::{normalized}"
    stack = _CODE_EDITOR_UNDO.get(undo_key)
    if not stack:
        return None
    previous = stack.pop()
    path = _safe_workspace_path(ws_path, normalized, must_exist=False)
    if previous is None:
        path.unlink(missing_ok=True)
        return f"[OK] 已撤销创建，文件已删除: {normalized}"
    _atomic_write_text(path, previous)
    return f"[OK] 已恢复上次编辑前的内容: {normalized}"


def _normalize_local_bash_command(command: str) -> str:
    """Translate container-style /workspace paths before sending commands to Local Runner."""
    normalized = str(command or "").strip()
    if not normalized:
        return normalized
    for prefix in ("cd /workspace && ", "cd /workspace &&", "cd /workspace/ && ", "cd /workspace/ &&"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):].lstrip()
            break
    normalized = re.sub(r"(?<![\w./-])/workspace/+", "./", normalized)
    normalized = re.sub(r"(?<![\w./-])/workspace(?![\w./-])", ".", normalized)
    return normalized


def _safe_glob_pattern(pattern: str) -> str:
    normalized = (pattern or "").strip().replace("\\", "/")
    if normalized.startswith("/workspace/"):
        normalized = normalized[len("/workspace/"):]
    elif normalized.startswith("/"):
        raise PermissionError("absolute glob paths outside /workspace are not allowed")
    if any(part == ".." for part in normalized.split("/")):
        raise PermissionError("parent-directory traversal is not allowed in glob patterns")
    return normalized or "**/*"


def _workspace_file_snapshot(ws_path: Path) -> dict[str, tuple[int, int]]:
    snapshot: dict[str, tuple[int, int]] = {}
    if not ws_path.exists():
        return snapshot
    index = load_workspace_index(ws_path, force=True)
    for item in index.get("files") or []:
        rel = str(item.get("path") or "")
        if not rel or rel.startswith(".autocode/"):
            continue
        snapshot[rel] = (int(item.get("mtime_ns") or 0), int(item.get("size") or 0))
    return snapshot


def _snapshot_changed(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[str]:
    return [path for path, meta in after.items() if before.get(path) != meta]


def _agent_changed_files(result: Any) -> list[str]:
    """Normalize legacy/new agent return values to a changed-file list."""
    if isinstance(result, (list, tuple, set)):
        return [str(p) for p in result if str(p).strip()]
    if isinstance(result, dict):
        files = result.get("changed_files") or result.get("files") or []
        if isinstance(files, (list, tuple, set)):
            return [str(p) for p in files if str(p).strip()]
    return []


def _tool_result_indicates_write_success(result: str) -> bool:
    text = str(result or "").lstrip()
    return text.startswith("[OK]") or text.startswith("[LOCAL] [OK]")


def _agent_needs_auto_continuation(task: dict | None) -> bool:
    """True when the current agent segment stopped only because of the per-run budget."""
    return bool(task and task.get("agent_iteration_limited") and task.get("needs_continuation"))


def _execution_mode(task: dict | None) -> str:
    configured = str((task or {}).get("execution_mode") or os.getenv("AUTOCODE_EXECUTION_MODE", "agentic")).strip().lower()
    return "planned" if configured in {"planned", "phase", "legacy"} else "agentic"


def _should_use_agentic_execution(task: dict | None, description: str, project_type: str = "") -> bool:
    if _execution_mode(task) == "planned":
        return False
    if task and task.get("force_planned_execution"):
        return False
    return True


def _set_agentic_finish(
    task: dict,
    *,
    status: str,
    reason: str,
    changed_files: list[str] | tuple[str, ...] | set[str] | None = None,
    validated: bool | None = None,
    review_passed: bool | None = None,
    retryable: bool = False,
    blocked: bool = False,
    message: str = "",
) -> dict[str, Any]:
    """Record a stable Agentic Loop checkpoint for resume/UI/test logic."""
    payload = {
        "status": status,
        "reason": reason,
        "changed_files": [str(path) for path in (changed_files or []) if str(path).strip()],
        "validated": validated,
        "review_passed": review_passed,
        "retryable": bool(retryable),
        "blocked": bool(blocked),
        "message": message,
        "system_context_epoch": task.get("system_context_epoch"),
        "updated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    task["agentic_finish"] = payload
    append_event(
        task,
        "agentic_loop_checkpoint" if retryable or blocked else "agentic_loop_finished",
        payload,
        source="orchestrator",
    )
    return payload


def _mark_agentic_no_change_retryable(task: dict, message: str = "") -> None:
    task["needs_continuation"] = True
    task["agent_iteration_limited"] = True
    task["agent_iteration_limit_reason"] = "agentic_no_change_retry"
    task["current_step"] = message or "Agentic Loop 尚未产生变更，已保留上下文并交给后台自动续跑。"
    _set_agentic_finish(
        task,
        status="retryable",
        reason="no_change_retryable",
        retryable=True,
        message=message or "Agentic Loop did not produce changes yet; queued for continuation.",
    )


def _normalize_session_input_text(value: str) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().lower()


def _review_is_passed(review: Any) -> bool:
    if not isinstance(review, dict):
        return False
    if review.get("passed") is True:
        return True
    score = review.get("score")
    issues = review.get("issues") or []
    return isinstance(score, (int, float)) and score >= 80 and not issues


def _review_subtask_ids(review: Any) -> set[str]:
    if not isinstance(review, dict):
        return set()
    ids: set[str] = set()
    for item in review.get("subtasks") or []:
        if isinstance(item, dict) and item.get("id"):
            ids.add(str(item["id"]))
    return ids


def _group_review_passed(task: dict, group_label: str, group_idx: int, group_subtasks: list[SubTask]) -> bool:
    expected_ids = {str(st.id) for st in group_subtasks}
    for review in task.get("phase_reviews") or []:
        if not _review_is_passed(review):
            continue
        phase = str(review.get("phase") or "")
        review_ids = _review_subtask_ids(review)
        if phase == group_label:
            return True
        if expected_ids and expected_ids.issubset(review_ids):
            return True
        if not review_ids and f"{group_idx + 1}/" in phase:
            return True
    return False


def _snapshot_deleted(before: dict[str, tuple[int, int]], after: dict[str, tuple[int, int]]) -> list[str]:
    return [path for path in before.keys() if path not in after]


READ_ONLY_BASH_PREFIXES = (
    "pwd", "ls", "dir", "find", "rg", "grep", "cat", "type", "head", "tail", "wc",
    "git status", "git log", "git diff", "git show", "git ls-files", "python -m py_compile",
    "python3 -m py_compile", "python -m compileall", "python3 -m compileall",
)


def _stable_json(value: Any) -> str:
    try:
        return json.dumps(value or {}, sort_keys=True, ensure_ascii=False, default=str)
    except Exception:
        return str(value or {})


def _tool_cache_key(tool_name: str, args: dict, workspace_version: int) -> str | None:
    """Return a cache key for idempotent/read-only tool calls within one agent segment."""
    if tool_registry.is_cacheable(tool_name):
        return f"v{workspace_version}:{tool_name}:{_stable_json(args)}"
    if tool_name == "bash" and _is_read_only_bash(args.get("command", "")):
        return f"v{workspace_version}:bash:{str(args.get('command', '')).strip()}"
    return None


def _normalize_workspace_rel_path(raw_path: str) -> str:
    rel = str(raw_path or "").strip().replace("\\", "/")
    rel = re.sub(r"^/?workspace/", "", rel)
    return rel.lstrip("/")


def _check_retrieval_read_guard(task: dict | None, rel_path: str) -> str | None:
    if not task or not (task.get("retrieval_guard") or {}).get("active"):
        return None
    guard = task.setdefault("retrieval_guard", {})
    rel_path = _normalize_workspace_rel_path(rel_path)
    if not rel_path:
        return None
    index_docs = set(guard.get("index_docs") or [])
    candidate_files = set(guard.get("candidate_files") or [])
    read_files = guard.setdefault("read_files", [])
    is_index_doc = rel_path.startswith(".autocode/") or rel_path in index_docs
    if is_index_doc or rel_path in read_files:
        return None
    is_candidate = rel_path in candidate_files
    budget = max(0, int(guard.get("read_budget") or 12))
    # 记账但不阻断：读取始终放行，超预算只附一条软提示。
    read_files.append(rel_path)
    guard["read_files"] = read_files
    over_budget = len(read_files) > budget and not is_candidate
    append_event(
        task,
        "retrieval_guard_accounted",
        {
            "path": rel_path,
            "read_budget": budget,
            "read_count": len(read_files),
            "candidate": is_candidate,
            "over_budget": over_budget,
        },
        source="retrieval_guard",
    )
    if over_budget:
        return (
            f"[READ_BUDGET_SOFT] 已读取 {len(read_files)} 个文件（软上限 {budget}）。"
            "建议基于现有上下文与 .autocode/RETRIEVAL_PLAN.md 的 Candidate Files 收敛改动；"
            "如确有必要可继续读取，此提示不阻断。"
        )
    return None


def _retrieval_plan_epoch(task: dict | None) -> int:
    if not isinstance(task, dict):
        return 0
    plan = task.get("retrieval_plan")
    if isinstance(plan, dict):
        try:
            return int(plan.get("system_context_epoch") or 0)
        except (TypeError, ValueError):
            return 0
    return 0


def _can_reuse_retrieval_plan(task: dict | None) -> bool:
    if not isinstance(task, dict):
        return False
    plan = task.get("retrieval_plan")
    if not isinstance(plan, dict) or not plan.get("candidate_files"):
        return False
    current_epoch = int(task.get("system_context_epoch") or 0)
    plan_epoch = _retrieval_plan_epoch(task)
    return plan_epoch == 0 or current_epoch == 0 or plan_epoch == current_epoch


def _reuse_retrieval_plan(task: dict, *, source: str) -> dict | None:
    if not _can_reuse_retrieval_plan(task):
        return None
    plan = dict(task.get("retrieval_plan") or {})
    previous_guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
    task["retrieval_guard"] = {
        "active": True,
        "candidate_files": list(plan.get("candidate_files") or []),
        "index_docs": list(plan.get("index_docs") or []),
        "read_budget": int(plan.get("read_budget") or max(12, len(plan.get("candidate_files") or []) + 8)),
        "read_files": list(previous_guard.get("read_files") or []),
    }
    append_event(
        task,
        "retrieval_plan_reused",
        {
            "source": source,
            "candidate_files": task["retrieval_guard"]["candidate_files"],
            "read_budget": task["retrieval_guard"]["read_budget"],
            "read_files": task["retrieval_guard"]["read_files"],
            "system_context_epoch": task.get("system_context_epoch"),
        },
        source="agent_efficiency",
    )
    return plan


def _is_read_only_bash(command: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(command or "").strip())
    if not normalized:
        return False
    normalized = re.sub(r"\s+2>\s*(nul|/dev/null)", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s+\|\|\s+echo\s+.*$", "", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"\s+\|\s+head\s+-?\d+\s*$", "", normalized, flags=re.IGNORECASE)
    lowered = normalized.lower()
    risky_tokens = (
        " >", ">", "| tee", "rm ", "del ", "erase ", "mv ", "move ", "cp ", "copy ",
        "mkdir", "touch", "sed -i", "python -c", "python3 -c", "node -e", "npm ", "pnpm ",
        "yarn ", "pip ", "mvn ", "gradle ", "go test", "go build", "cargo ", "docker ",
    )
    if any(token in lowered for token in risky_tokens):
        return False
    return any(lowered == prefix or lowered.startswith(prefix + " ") for prefix in READ_ONLY_BASH_PREFIXES)


def _assistant_content_says_complete(content: str) -> bool:
    text = (content or "").strip().lower()
    if not text:
        return False
    markers = (
        "done",
        "completed",
        "all done",
        "task completed",
        "任务完成",
        "任务已完成",
        "已完成",
        "已经完成",
        "无需进一步操作",
        "无须进一步操作",
    )
    return any(marker in text for marker in markers)


def _assistant_content_promises_edit_without_tool(content: str) -> bool:
    text = (content or "").strip().lower()
    if not text or _assistant_content_says_complete(text):
        return False
    edit_markers = (
        "开始编辑", "开始修改", "现在修改", "现在开始修改", "现在开始编辑",
        "我将修改", "我会修改", "马上修改", "需要修改", "需要补全",
        "修改这", "编辑这", "补全这", "添加到", "写入",
        "start editing", "start modifying", "i will edit", "i will modify",
        "i'll edit", "i'll update", "let me edit", "let me update",
    )
    target_markers = (
        "apply_patch", "write_file", "code_editor", "文件", "源码", "代码",
        "ui/", "src/", ".py", ".js", ".ts", ".tsx", ".html", ".css",
    )
    return any(marker in text for marker in edit_markers) and any(marker in text for marker in target_markers)


def _assistant_content_requests_blocking_input(content: str) -> bool:
    text = (content or "").strip()
    if not text or _assistant_content_says_complete(text):
        return False
    if _is_hard_blocking_input(text):
        return True
    lowered = text.lower()
    ask_markers = (
        "请你", "请直接回复", "需要你确认", "需要一个明确", "拿到", "目标页面",
        "目标界面", "源码路径", "组件路径", "允许我", "如果你不清楚", "二选一",
        "which page", "which file", "confirm", "choose one", "blocking",
    )
    blocking_markers = (
        "阻塞", "无法继续", "没法", "不能安全", "没有找到", "缺少", "还没有拿到",
        "blocked", "cannot continue", "missing", "need your input",
    )
    return any(marker in lowered for marker in ask_markers) and any(marker in lowered for marker in blocking_markers)


def _autonomy_mode(task: dict | None) -> str:
    value = str((task or {}).get("autonomy_mode") or "strong").strip().lower()
    return value if value in {"strong", "balanced", "conservative"} else "strong"


def _is_hard_blocking_input(content: str) -> bool:
    text = (content or "").strip().lower()
    if not text:
        return False
    hard_markers = (
        "凭证", "密钥", "授权码", "验证码", "登录", "账号", "密码", "支付", "生产",
        "真实设备", "外部账号", "无法访问本地目录", "本地目录不可访问", "连接器未连接",
        "credential", "secret", "api key", "login", "password", "2fa", "captcha",
        "production", "payment", "destructive", "dangerous",
    )
    destructive_markers = (
        "删除大量", "清空", "重置", "回滚", "推送", "发布到生产",
        "rm -rf", "git reset", "git push", "drop database",
    )
    explicit_pause = ("先暂停", "暂停", "停止等待", "stop", "pause")
    return (
        any(marker in text for marker in hard_markers)
        or any(marker in text for marker in destructive_markers)
        or any(marker in text for marker in explicit_pause)
    )


def _is_soft_entry_blocker(content: str) -> bool:
    text = (content or "").strip()
    if not text:
        return False
    soft_markers = (
        "目标页面", "目标界面", "源码路径", "组件路径", "前端源码入口", "入口",
        "run_ui.py", "ui 入口", "界面入口", "没有找到实际", "缺少明确入口",
        "which page", "which file", "component path", "source entry", "entrypoint",
    )
    blocking_markers = (
        "阻塞", "无法继续", "没法", "没有找到", "缺少", "还没有拿到",
        "blocked", "cannot continue", "missing", "need your input",
    )
    lowered = text.lower()
    return any(marker.lower() in lowered for marker in soft_markers) and any(marker in lowered for marker in blocking_markers)


def _intervention_payload(
    *,
    intervention_type: str,
    severity: str,
    content: str,
    choices: list[dict[str, str]],
    default_action: str,
    auto_resolved: bool,
    agent_type: str,
    iteration: int,
    signature: str,
) -> dict:
    file_evidence = sorted(set(re.findall(
        r"(?:^|[\s`'\"(（])((?:\.autocode|src|app|pages|components|lib|ui|backend|frontend|agent-platform|tests)/[A-Za-z0-9_./@()+\-]+\.[A-Za-z0-9]+|[A-Za-z0-9_.-]+\.py)",
        content or "",
    )))[:12]
    summary = re.sub(r"\s+", " ", (content or "").strip())
    return {
        "type": intervention_type,
        "severity": severity,
        "question": summary[:300],
        "full_text": content,
        "evidence": {
            "files": file_evidence,
            "agent": agent_type,
            "iteration": iteration,
        },
        "options": choices,
        "default_action": default_action,
        "auto_resolved": auto_resolved,
        "signature": signature,
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }


def _auto_decision_for_soft_blocker(task: dict, *, task_id: str, agent_type: str, iteration: int, content: str) -> str:
    normalized_content = re.sub(r"\s+", " ", (content or "").strip())[:2000]
    signature = stable_hash({
        "kind": "auto_decision",
        "content": normalized_content,
        "mode": _autonomy_mode(task),
    })
    choices = _blocking_input_choices(content)
    default_action = (
        "请基于现有上下文继续实现；缺少明确入口时按最合理位置新建或接入。"
        "不要再次询问入口；先检查 .autocode/PROJECT_MAP.md、.autocode/SURFACE_MAP.md、"
        "SESSION_SUMMARY.md 和已有候选文件。若没有现成入口，就按项目技术栈新建最接近的管理/风控入口，"
        "完成后运行验证并在总结中写明入口位置。"
    )
    intervention = _intervention_payload(
        intervention_type="soft_blocker",
        severity="advisory",
        content=content,
        choices=choices,
        default_action=default_action,
        auto_resolved=True,
        agent_type=agent_type,
        iteration=iteration,
        signature=signature,
    )
    task.setdefault("interventions", []).append(intervention)
    append_event(
        task,
        "agent_auto_decision",
        {
            "agent": agent_type,
            "iteration": iteration,
            "reason": "soft_blocker_auto_resolved",
            "signature": signature,
            "intervention": intervention,
            "default_action": default_action,
        },
        source="agent_autonomy",
    )
    task["autonomy_mode"] = _autonomy_mode(task)
    task["current_step"] = "遇到软阻塞，已按强自主策略自动选择最合理入口继续。"
    return f"[AGENT_AUTO_DECISION]\n{default_action}\n\n原始阻塞内容：\n{content[:1600]}"


def _blocking_input_choices(content: str) -> list[dict[str, str]]:
    text = content or ""
    choices: list[dict[str, str]] = []
    if re.search(r"(目标页面|目标界面|源码路径|组件路径|前端源码|page|component|source)", text, re.I):
        contextual = (
            ("群组列表页", "这个功能放在群组列表页；如果没有现成页面，请新建或接入最接近的群组管理入口。"),
            ("群组详情页", "这个功能放在群组详情页；请接入现有详情入口，没有就按项目结构新建。"),
            ("审核/风控页", "这个功能属于审核/风控页；请优先定位现有风控或管理入口，没有就新建。"),
            ("后台管理页", "这个功能放在后台管理页；请按现有技术栈接入，没有对应入口就新建。"),
        )
        choices.append({
            "label": "允许新建管理页",
            "message": "允许你新建必要的群组管理/风控页面，并按现有项目技术栈接入入口和交互。",
        })
        choices.extend({"label": label, "message": message} for label, message in contextual)
    if not choices:
        choices.extend([
            {"label": "继续并自行决定", "message": "请基于现有上下文继续实现；缺少明确入口时按最合理位置新建或接入。"},
            {"label": "允许新建", "message": "允许你新建必要的文件或页面来完成这个功能。"},
            {"label": "先暂停", "message": "先暂停，我稍后补充更多信息。"},
        ])
    return choices[:6]


def _open_blocking_input_request(task: dict, *, task_id: str, agent_type: str, iteration: int, content: str) -> bool:
    normalized_content = re.sub(r"\s+", " ", (content or "").strip())[:2000]
    signature = stable_hash({
        "kind": "user_input",
        "content": normalized_content,
    })
    pending = task.get("pending_user_input") if isinstance(task.get("pending_user_input"), dict) else {}
    if pending.get("signature") == signature:
        return False

    choices = _blocking_input_choices(content)
    intervention = _intervention_payload(
        intervention_type="hard_blocker",
        severity="blocking",
        content=content,
        choices=choices,
        default_action=choices[0]["message"] if choices else "",
        auto_resolved=False,
        agent_type=agent_type,
        iteration=iteration,
        signature=signature,
    )
    event = append_event(
        task,
        "intervention_opened",
        {
            "agent": agent_type,
            "iteration": iteration,
            "question": content,
            "message": content,
            "signature": signature,
            "options": choices,
            "allow_free_text": True,
            "intervention": intervention,
        },
        source="agent_blocker",
    )
    append_event(
        task,
        "user_input_requested",
        {
            "agent": agent_type,
            "iteration": iteration,
            "question": content,
            "message": content,
            "signature": signature,
            "options": choices,
            "allow_free_text": True,
            "intervention": intervention,
        },
        source="agent_blocker",
    )
    event_id = event.get("id") if isinstance(event, dict) else f"user-input-{task_id}-{signature[:12]}"
    task["status"] = "waiting_user_input"
    task["execution_active"] = False
    task["needs_continuation"] = False
    task["current_step"] = "等待用户选择处理方式或补充信息。"
    task["pending_user_input"] = {
        "event_id": event_id,
        "question": content,
        "message": content,
        "signature": signature,
        "options": choices,
        "allow_free_text": True,
        "intervention": intervention,
        "requested_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    task.setdefault("interventions", []).append(intervention)
    return True

def _is_validation_command(command: str) -> bool:
    lowered = str(command or "").lower()
    markers = (
        "py_compile", "compileall", "npm run build", "pnpm build", "yarn build",
        "pytest", "unittest", "go test", "cargo test", "mvn", "gradle", "tsc", "eslint",
    )
    return any(marker in lowered for marker in markers)


def _is_meaningless_post_write_check(tool_name: str, args: dict) -> bool:
    if tool_name in {"git_commit"}:
        return True
    if tool_name != "bash":
        return False
    lowered = str(args.get("command", "")).lower()
    return any(token in lowered for token in ("git status", "git log", "git diff", "git ls-files", "wc -l", "head ", "cat ", "ls -la"))


def _has_meaningful_output_artifact(ws_path: Path, changed_files: list[str]) -> bool:
    for rel in changed_files:
        normalized = str(rel).replace("\\", "/").lstrip("/")
        if not normalized or normalized.startswith(".autocode/"):
            continue
        path = ws_path / normalized
        if path.exists() and path.is_file() and path.stat().st_size > 0:
            return True
    return False


def _is_documentation_phase(group_subtasks: list[Any], changed_files: list[str]) -> bool:
    """Allow contract/planning/documentation phases to be reviewed as docs.

    Implementation phases still require code artifacts through ReviewAgent.
    """
    if not group_subtasks:
        return False
    title_text = " ".join(str(getattr(st, "title", "") or "") for st in group_subtasks).lower()
    desc_text = " ".join(str(getattr(st, "description", "") or "") for st in group_subtasks).lower()
    text = f"{title_text} {desc_text}"
    estimated_files = [
        str(path or "").replace("\\", "/")
        for st in group_subtasks
        for path in (getattr(st, "estimated_files", []) or [])
    ]
    doc_keywords = (
        "contract", "plan", "planning", "design", "architecture", "spec",
        "map existing", "entrypoint", "usage notes", "document", "docs",
        "readme", "define script contract", "smoke test and usage notes",
        "smoke test", "usage", "usage guide",
        "契约", "计划", "规划", "设计", "架构", "规范", "说明", "文档",
        "梳理", "入口", "使用说明", "冒烟测试", "明确脚本契约",
    )
    implementation_keywords = (
        "implement", "coding", "code", "core script behavior", "fix",
        "feature", "api", "frontend", "backend logic",
        "实现", "编码", "代码", "核心行为", "修复", "功能", "前端", "后端逻辑",
    )
    if any(keyword in title_text for keyword in implementation_keywords):
        return False
    has_doc_signal = (
        any(keyword in text for keyword in doc_keywords)
        or any(path.endswith((".md", ".txt", ".json", ".yaml", ".yml")) for path in estimated_files)
    )
    if not has_doc_signal:
        return False
    return all(
        path.endswith((".md", ".txt", ".json", ".yaml", ".yml"))
        or path.startswith(".autocode/")
        for path in changed_files
    )


def _phase_expected_artifacts(ws_path: Path, group_subtasks: list[Any]) -> list[str]:
    artifacts: list[str] = []
    for st in group_subtasks or []:
        for raw in getattr(st, "estimated_files", []) or []:
            rel = str(raw or "").replace("\\", "/").lstrip("/")
            if not rel or rel.endswith("/"):
                continue
            try:
                path = _safe_workspace_path(ws_path, rel, must_exist=False)
            except Exception:
                continue
            if path.exists() and path.is_file() and path.stat().st_size > 0:
                artifacts.append(path.resolve().relative_to(ws_path.resolve()).as_posix())
    seen: set[str] = set()
    result: list[str] = []
    for item in artifacts:
        if item not in seen:
            seen.add(item)
            result.append(item)
    return result


def _absolute_iteration_cap() -> int:
    """Hard safety ceiling on total agent iterations within one continuation window.

    Progress-aware auto-continuation grants each segment its full requested budget
    until this ceiling is reached; only then is human confirmation required. The
    window resets (via ``auto_continuation_budget_base``) whenever the user manually
    approves continuation, so a genuinely-progressing task is never throttled.
    """
    try:
        cap = int(os.getenv("AUTOCODE_ABSOLUTE_ITERATION_CAP", "10000"))
    except (TypeError, ValueError):
        cap = 10000
    return max(1, cap)


def _env_int(name: str, default: int, *, minimum: int = 0) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        value = default
    return max(minimum, value)


def _env_bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {"0", "false", "no", "off"}


def _unrestricted_dev_mode(task: dict | None = None) -> bool:
    if isinstance(task, dict) and "unrestricted_dev_mode" in task:
        return bool(task.get("unrestricted_dev_mode"))
    return _env_bool("AUTOCODE_UNRESTRICTED_DEV_MODE", True)


def _remaining_absolute_iteration_budget(task: dict | None) -> int:
    task = task or {}
    cap = _absolute_iteration_cap()
    try:
        base = int(task.get("auto_continuation_budget_base") or 0)
    except (TypeError, ValueError):
        base = 0
    try:
        used = int(task.get("total_agent_iterations") or task.get("agent_iteration") or 0)
    except (TypeError, ValueError):
        used = 0
    consumed_in_window = max(0, used - base)
    return max(1, cap - consumed_in_window)


def _cap_agent_iteration_budget(task: dict, requested: int) -> int:
    remaining = _remaining_absolute_iteration_budget(task)
    return max(1, min(requested, max(1, remaining)))


def _progress_fingerprint(task: dict) -> tuple[int, int, int]:
    """Cross-segment progress signal: (completed_subtasks, total_subtasks, changed_file_count).

    Read from durable task state (``task['plan']`` and accumulated change snapshots),
    so it is stable across auto-continuation segments and context compaction.
    """
    plan = task.get("plan") if isinstance(task.get("plan"), dict) else {}
    subtasks = plan.get("subtasks") if isinstance(plan.get("subtasks"), list) else []
    completed = 0
    total = 0
    for st in subtasks:
        if not isinstance(st, dict):
            continue
        total += 1
        if str(st.get("status") or "") == "completed":
            completed += 1
    try:
        changed = len(_collect_completion_changed_files(task))
    except Exception:
        changed = 0
    return completed, total, changed


def _progress_watchdog_signature(
    task: dict | None,
    *,
    changed_files: list[str] | None = None,
    written_files: list[str] | None = None,
    validation_command: str = "",
    validation_exit_code: int | None = None,
    validation_output: str = "",
    pending_user_messages: int = 0,
) -> dict[str, Any]:
    task = task or {}
    completed, total_subtasks, changed_count = _progress_fingerprint(task)
    guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
    candidate_files = [
        str(path).replace("\\", "/")
        for path in (guard.get("candidate_files") or [])
        if str(path).strip()
    ][:100]
    changed = sorted({str(path).replace("\\", "/") for path in (changed_files or []) if str(path).strip()})[:200]
    written = sorted({str(path).replace("\\", "/") for path in (written_files or []) if str(path).strip()})[:100]
    validation_sig = ""
    if validation_command:
        validation_sig = stable_hash({
            "command": validation_command,
            "exit_code": validation_exit_code,
            "output": (validation_output or "")[:4000],
        })
    return {
        "completed_subtasks": completed,
        "total_subtasks": total_subtasks,
        "changed_file_count": max(changed_count, len(changed)),
        "changed_files": changed,
        "written_files": written,
        "validation": validation_sig,
        "candidate_files": candidate_files,
        "pending_user_messages": int(pending_user_messages or 0),
    }


def _discovery_result_signature(result: str) -> str:
    normalized_lines: list[str] = []
    for raw in str(result or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        normalized_lines.append(line[:500])
        if len(normalized_lines) >= 120:
            break
    return stable_hash({"discovery_result": "\n".join(normalized_lines)})


def _apply_progress_watchdog(
    task: dict,
    signature: dict[str, Any],
    *,
    iteration: int,
    agent_type: str,
    duplicate_discovery: bool = False,
    discovery_progress: bool = False,
    action_progress: bool = False,
) -> dict[str, Any]:
    watchdog = task.setdefault("progress_watchdog", {})
    if not isinstance(watchdog, dict):
        watchdog = {}
        task["progress_watchdog"] = watchdog
    previous = watchdog.get("last_signature") if isinstance(watchdog.get("last_signature"), dict) else None
    made_progress = previous is None or previous != signature or bool(discovery_progress) or bool(action_progress)
    was_forced = bool(watchdog.get("force_transition_pending"))

    if made_progress:
        watchdog["no_progress_iterations"] = 0
        watchdog["no_progress_after_force"] = 0
        if action_progress:
            watchdog["force_transition_pending"] = False
            watchdog["targeted_discovery_after_force"] = 0
        elif was_forced and discovery_progress:
            watchdog["targeted_discovery_after_force"] = int(watchdog.get("targeted_discovery_after_force") or 0) + 1
            watchdog["force_transition_pending"] = True
        else:
            watchdog["force_transition_pending"] = False
            watchdog["targeted_discovery_after_force"] = 0
        watchdog.pop("stop_reason", None)
    else:
        watchdog["no_progress_iterations"] = int(watchdog.get("no_progress_iterations") or 0) + 1
        if was_forced:
            watchdog["no_progress_after_force"] = int(watchdog.get("no_progress_after_force") or 0) + 1

    if duplicate_discovery:
        watchdog["duplicate_discovery_streak"] = int(watchdog.get("duplicate_discovery_streak") or 0) + 1
    elif made_progress:
        watchdog["duplicate_discovery_streak"] = 0

    no_progress_limit = _env_int("AUTOCODE_NO_PROGRESS_ITERATIONS", 2, minimum=1)
    stop_after_force = _env_int("AUTOCODE_NO_PROGRESS_STOP_AFTER_FORCE", 2, minimum=1)
    duplicate_limit = _env_int("AUTOCODE_DUPLICATE_DISCOVERY_LIMIT", 2, minimum=1)
    targeted_discovery_limit = _env_int("AUTOCODE_TARGETED_DISCOVERY_AFTER_FORCE", 6, minimum=1)
    force_transition = (
        int(watchdog.get("no_progress_iterations") or 0) >= no_progress_limit
        or duplicate_discovery
        or int(watchdog.get("duplicate_discovery_streak") or 0) >= duplicate_limit
        or bool(
            was_forced
            and discovery_progress
            and not action_progress
            and int(watchdog.get("targeted_discovery_after_force") or 0) > targeted_discovery_limit
        )
    )
    stop = bool(
        was_forced
        and not made_progress
        and int(watchdog.get("no_progress_after_force") or 0) >= stop_after_force
    )
    if _unrestricted_dev_mode(task):
        stop = False
    if force_transition and not stop:
        if not watchdog.get("force_transition_pending"):
            watchdog["forced_transition_count"] = int(watchdog.get("forced_transition_count") or 0) + 1
        watchdog["force_transition_pending"] = True
    if stop:
        watchdog["stop_reason"] = "blocked_by_no_progress"
        watchdog["force_transition_pending"] = False

    watchdog["last_signature"] = signature
    watchdog["last_iteration"] = iteration
    watchdog["last_agent"] = agent_type
    watchdog["last_progress_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    return {
        "made_progress": made_progress,
        "force_transition": force_transition and not stop,
        "stop": stop,
        "reason": watchdog.get("stop_reason") or ("duplicate_discovery" if duplicate_discovery else "no_progress"),
        "watchdog": dict(watchdog),
    }


def _agent_iteration_policy(task: dict | None, description: str, has_memory_context: bool) -> tuple[int, int]:
    """Return (max_iterations, context_compress_interval) for an agent run."""
    task = task or {}
    recon = task.get("project_recon") or {}
    complexity = str(recon.get("complexity") or "").upper()
    flow = str(recon.get("recommended_flow") or "")
    desc = (description or "").lower()
    if any(marker in desc for marker in ("ai 助手增量开发请求", "强制续改", "chat continuation", "continue development")):
        continuation_iterations = int(os.getenv("AUTOCODE_CHAT_CONTINUATION_MAX_ITERATIONS", "18"))
        return _cap_agent_iteration_budget(task, max(S0_LIGHT_MAX_ITERATIONS, continuation_iterations)), 12
    is_s0_light = complexity == "S0" or flow in {"light_script", "light_tool"}
    if is_s0_light:
        is_contract_or_docs = any(
            keyword in desc
            for keyword in (
                "define script contract", "script_contract.md", "contract",
                "usage notes", "smoke test", "readme",
                "明确脚本契约", "使用说明", "冒烟测试",
            )
        )
        max_iterations = S0_CONTRACT_MAX_ITERATIONS if is_contract_or_docs else S0_LIGHT_MAX_ITERATIONS
        return _cap_agent_iteration_budget(task, max(4, max_iterations)), max(24, max_iterations + 6)

    max_iterations = DEFAULT_MAX_ITERATIONS
    if has_memory_context:
        max_iterations = min(DEFAULT_MAX_ITERATIONS, 24)
    return _cap_agent_iteration_budget(task, max_iterations), 12


def _count_source_files(ws_path: Path) -> int:
    count = 0
    if not ws_path.exists():
        return 0
    for path in ws_path.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(ws_path)
        except ValueError:
            continue
        if any(part in IGNORED_WORKSPACE_PARTS for part in rel.parts):
            continue
        if _is_implementation_file(rel.as_posix()):
            count += 1
    return count


def _append_workspace_chat(ws_path: Path, role: str, content: str, *, agent: str | None = None) -> None:
    autocode_dir = ws_path / ".autocode"
    autocode_dir.mkdir(parents=True, exist_ok=True)
    chat_path = autocode_dir / "CHAT.md"
    if not chat_path.exists():
        chat_path.write_text("# AutoCode Chat\n\n", encoding="utf-8")
    timestamp = datetime.utcnow().isoformat(timespec="seconds") + "Z"
    label = role if not agent else f"{role} / {agent}"
    safe_content = (content or "").strip()
    try:
        existing_tail = chat_path.read_text(encoding="utf-8")[-5000:]
        if f" - {label}\n\n{safe_content}\n\n" in existing_tail:
            return
    except Exception:
        pass
    with chat_path.open("a", encoding="utf-8") as fh:
        fh.write(f"## {timestamp} - {label}\n\n")
        fh.write(safe_content if safe_content else "(empty)")
        fh.write("\n\n")


def _latest_user_prompt(task: dict, fallback: str = "") -> str:
    for entry in reversed(task.get("logs") or []):
        if entry.get("level") == "chat_user" and entry.get("message"):
            return str(entry.get("message"))
    return fallback or str(task.get("description") or task.get("title") or "")


def _format_snapshot_message(
    task: dict,
    *,
    agent_type: str,
    iteration: int,
    changed_files: list[str],
    user_prompt: str,
    phase: str = "tool_batch",
) -> str:
    title = str(task.get("title") or "AutoCode task")[:80]
    prompt = (user_prompt or "").replace("\r", " ").replace("\n", " ").strip()[:240]
    body = {
        "autocode_snapshot": True,
        "task_id": task.get("id"),
        "task_title": task.get("title"),
        "agent": agent_type,
        "phase": phase,
        "iteration": iteration,
        "trigger_prompt": prompt,
        "changed_files": changed_files[:80],
        "created_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    return (
        f"Auto snapshot: {title}\n\n"
        f"Agent: {agent_type}\n"
        f"Iteration: {iteration}\n"
        f"Triggered by: {prompt or '(initial task)'}\n\n"
        f"Autocode-Metadata: {json.dumps(body, ensure_ascii=False)}"
    )


def _append_command_record(
    task: dict,
    command: str,
    status: str,
    *,
    label: str = "",
    output: str = "",
    exit_code: int | None = None,
    source: str = "agent",
    output_meta: dict | None = None,
) -> dict:
    bounded_output = output
    meta = output_meta or {}
    if output and not output_meta:
        bounded_output = output[-12000:]
    record = {
        "id": f"cmd-{uuid.uuid4().hex[:12]}",
        "command": command,
        "label": label or command,
        "status": status,
        "source": source,
        "output": bounded_output if bounded_output else "",
        "output_truncated": bool(meta.get("truncated")),
        "output_path": meta.get("full_path") or "",
        "output_sha256": meta.get("sha256") or "",
        "output_chars": meta.get("chars") or (len(output) if output else 0),
        "output_lines": meta.get("lines") or (output.count("\n") + 1 if output else 0),
        "exit_code": exit_code,
        "started_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "finished_at": (
            datetime.utcnow().isoformat(timespec="seconds") + "Z"
            if status in ("success", "failed")
            else None
        ),
    }
    task.setdefault("command_history", []).append(record)
    task["command_history"] = task["command_history"][-100:]
    return record


def _is_safe_phase_command(command: str) -> bool:
    compact = re.sub(r"\s+", " ", command or "").strip()
    if not compact or len(compact) > 2000:
        return False
    if re.search(r"[;&|`$<>]", compact):
        return False
    allowed = (
        r"^(npm|pnpm|yarn) (run )?[A-Za-z0-9:_-]+$",
        r"^(npm|pnpm|yarn) (test|build|lint)$",
        r"^(python|python3) -m (py_compile|compileall)( [A-Za-z0-9_./\\-]+)*$",
        r"^pytest( -q)?$",
        r"^mvn( -DskipTests)? (test|package)$",
        r"^go (test|build) \./\.\.\.$",
    )
    return any(re.match(pattern, compact) for pattern in allowed)


def _classify_ci_failure(command: str, exit_code: int | None, output: str) -> dict:
    """Classify validation failures for review and auto-repair."""
    text = (output or "").lower()
    compact_command = re.sub(r"\s+", " ", command or "").strip()
    if exit_code == 126 or "blocked unsafe workspace command" in text or "unsafe validation command" in text:
        return {
            "category": "command_policy",
            "severity": "system",
            "summary": "验证命令被安全策略拦截，这属于系统命令策略问题，不应直接判定为代码错误。",
            "suggestion": "检查验证命令是否包含越权路径、shell 控制字符或未允许的执行形式；必要时调整 CI 命令生成策略。",
        }
    if exit_code == 127 or "command not found" in text or "not recognized" in text:
        return {
            "category": "missing_tool",
            "severity": "environment",
            "summary": "验证工具或运行时不存在。",
            "suggestion": "检查工作区镜像是否安装对应运行时，或切换到项目可用的验证命令。",
        }
    if "syntaxerror" in text or "indentationerror" in text or "compileerror" in text or "tsc" in compact_command:
        return {
            "category": "syntax_or_type_error",
            "severity": "code",
            "summary": "代码存在语法或类型检查错误。",
            "suggestion": "读取 CI 输出定位文件和行号，优先做最小修复后重新验证。",
        }
    if "modulenotfounderror" in text or "cannot find module" in text or "no module named" in text:
        return {
            "category": "missing_dependency",
            "severity": "code_or_env",
            "summary": "存在缺失依赖或导入路径问题。",
            "suggestion": "优先检查项目内模块结构和相对导入；确属第三方依赖时更新依赖清单。",
        }
    if exit_code == -1 or "timeout" in text or "timed out" in text:
        return {
            "category": "timeout_or_exception",
            "severity": "environment",
            "summary": "验证过程超时或执行异常。",
            "suggestion": "缩小验证范围，检查命令是否卡住，或提高超时配置。",
        }
    return {
        "category": "validation_failed",
        "severity": "code",
        "summary": "验证命令返回失败。",
        "suggestion": "根据 CI 输出定位失败原因，修复后重新运行验证。",
    }


def _package_script_command(ws_path: Path, script_name: str) -> str:
    package_json = ws_path / "package.json"
    if not package_json.exists():
        return ""
    try:
        package = json.loads(package_json.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return ""
    scripts = package.get("scripts") or {}
    if script_name not in scripts:
        return ""
    if (ws_path / "pnpm-lock.yaml").exists():
        return f"pnpm run {script_name}"
    if (ws_path / "yarn.lock").exists():
        return f"yarn {script_name}"
    return f"npm run {script_name}"


def _build_completion_summary(task: dict, ws_path: Path) -> str:
    result = task.get("last_agent_result") or {}
    review = task.get("review") or {}
    snapshots = task.get("auto_snapshots") or []
    changed_files = result.get("changed_files") or []
    if not changed_files and snapshots:
        seen: list[str] = []
        for snapshot in snapshots[-5:]:
            for path in snapshot.get("changed_files") or []:
                if path not in seen:
                    seen.append(path)
        changed_files = seen

    file_lines = "\n".join(f"- `{path}`" for path in changed_files[:20]) or "- 暂无可归纳的文件变更"
    more = "" if len(changed_files) <= 20 else f"\n- 另有 {len(changed_files) - 20} 个文件未展开显示"
    preview = task.get("preview_url") or "暂无"
    review_line = "未运行"
    if review:
        review_line = f"{'通过' if review.get('passed', True) else '未通过'}，评分 {review.get('score', '-')}"

    return f"""任务已完成：{task.get("title") or task.get("description") or task.get("id")}

完成情况：
- 状态：{task.get("status")}
- Agent 迭代：{result.get("iterations", task.get("agent_iteration", "-"))}
- 自动快照：{len(snapshots)}
- 产物审查：{review_line}
- 预览地址：{preview}

主要产物或修改文件：
{file_lines}{more}

你可以在文件面板查看产物，在活动面板查看验证依据；代码任务还可以在 Git 面板查看自动快照和 Diff。"""


def _collect_completion_changed_files(task: dict) -> list[str]:
    result = task.get("last_agent_result") or {}
    changed_files = list(result.get("changed_files") or [])
    for snapshot in task.get("auto_snapshots") or []:
        for path in snapshot.get("changed_files") or []:
            if path and path not in changed_files:
                changed_files.append(path)
    for review in (task.get("phase_reviews") or []) + ([task.get("review")] if task.get("review") else []):
        if not isinstance(review, dict):
            continue
        artifacts = ((review.get("dimensions") or {}).get("phase_artifacts") or {})
        for path in artifacts.get("changed_files") or []:
            if path and path not in changed_files:
                changed_files.append(path)
    return changed_files


def _meaningful_changed_file_list(changed_files: list[str] | tuple[str, ...] | set[str]) -> list[str]:
    meaningful: list[str] = []
    for raw in changed_files or []:
        rel = str(raw or "").replace("\\", "/").lstrip("/")
        if rel and not is_auxiliary_artifact(rel) and rel not in meaningful:
            meaningful.append(rel)
    return meaningful


def _meaningful_completion_changed_files(task: dict) -> list[str]:
    return _meaningful_changed_file_list(_collect_completion_changed_files(task))


def _requires_real_change_for_completion(task: dict, execution_plan: dict | None, description: str = "") -> bool:
    plan = execution_plan or {}
    intent = str(plan.get("intent") or "").strip().lower()
    if intent == "code_development":
        return True
    if intent in {"answer_only", "review_only", "run_command", "ide_action"}:
        return False
    if _execution_mode(task) == "agentic":
        prompt = " ".join([
            str(description or ""),
            str(task.get("last_chat_continuation_message") or ""),
            str(task.get("title") or ""),
        ])
        return is_actionable_development_request(prompt)
    return False


def _build_completion_summary(task: dict, ws_path: Path) -> str:
    result = task.get("last_agent_result") or {}
    review = task.get("review") or {}
    snapshots = task.get("auto_snapshots") or []
    changed_files = _collect_completion_changed_files(task)
    file_lines = "\n".join(f"- `{path}`" for path in changed_files[:20]) or "- 暂无可归纳的文件变更"
    more = "" if len(changed_files) <= 20 else f"\n- 另有 {len(changed_files) - 20} 个文件未展开显示"
    preview = task.get("preview_url") or "暂无"
    review_line = "未运行"
    if review:
        review_line = f"{'通过' if review.get('passed', True) else '未通过'}，评分 {review.get('score', '-')}"

    return f"""任务已完成：{task.get("title") or task.get("description") or task.get("id")}

完成情况：
- 状态：{task.get("status")}
- Agent 迭代：{result.get("iterations", task.get("agent_iteration", "-"))}
- 自动快照：{len(snapshots)}
- 产物审查：{review_line}
- 预览地址：{preview}

主要产物或修改文件：
{file_lines}{more}

你可以在文件面板查看产物，在活动面板查看验证依据；代码任务还可以在 Git 面板查看自动快照和 Diff。"""


def _build_completion_report(task: dict, ws_path: Path) -> dict:
    result = task.get("last_agent_result") or {}
    review = task.get("review") if isinstance(task.get("review"), dict) else {}
    changed_files = _collect_completion_changed_files(task)
    meaningful_changed_files = _meaningful_changed_file_list(changed_files)
    phase_reviews = task.get("phase_reviews") or []
    events = task.get("events") or []
    validation_events = [
        event for event in events
        if str(event.get("type") or "") in {"artifact_verified", "local_snapshot_synced", "phase_ci_done", "tool_result"}
        and isinstance(event.get("payload"), dict)
    ]
    validation_commands: list[str] = []
    for record in task.get("command_history") or []:
        command = str((record or {}).get("command") or "").strip()
        if command and command not in validation_commands:
            validation_commands.append(command)
    for event in validation_events:
        payload = event.get("payload") or {}
        command = str(payload.get("command") or (payload.get("args") or {}).get("command") or "").strip()
        if command and command not in validation_commands:
            validation_commands.append(command)

    review_score = review.get("score") if review else None
    review_passed = bool(review.get("passed", True)) if review else None
    advisory_risk = bool(review and not review.get("passed", True))
    unresolved_items: list[str] = []
    risk_items: list[str] = []
    if not meaningful_changed_files and _requires_real_change_for_completion(task, task.get("active_execution_plan"), str(task.get("description") or "")):
        unresolved_items.append("未检测到真实业务/源码文件变更。")
    if review and not review.get("passed", True):
        risk_items.append(f"产物审查未通过，评分 {review.get('score', '-')}，已作为 advisory 风险记录。")
    if result and not result.get("validated_after_write") and result.get("writes_count"):
        risk_items.append("检测到写入后未记录明确验证通过标记，请人工复核验证事件。")

    report = {
        "status": task.get("status"),
        "autonomy_mode": _autonomy_mode(task),
        "goal": task.get("title") or task.get("description") or task.get("id"),
        "requirement_coverage": {
            "summary": "已按当前任务目标执行；具体覆盖以变更文件、验证记录和审查结果为准。",
            "changed_file_count": len(meaningful_changed_files),
            "has_ui_entry_evidence": any(re.search(r"(ui|page|component|run_ui|app|src)", path, re.I) for path in meaningful_changed_files),
        },
        "ui_entry": {
            "candidates": [path for path in meaningful_changed_files if re.search(r"(run_ui|ui|page|component|app|src)", path, re.I)][:10],
            "note": "若任务涉及界面，优先在这些候选入口复现。",
        },
        "changed_files": meaningful_changed_files[:100],
        "validation": {
            "validated_after_write": bool(result.get("validated_after_write")),
            "commands": validation_commands[:20],
            "event_count": len(validation_events),
        },
        "review": {
            "passed": review_passed,
            "score": review_score,
            "issue_count": len(review.get("issues") or []) if review else 0,
            "phase_review_count": len(phase_reviews),
            "advisory": advisory_risk,
        },
        "unresolved_items": unresolved_items,
        "risks": risk_items,
        "reproduce_steps": [
            "打开文件面板查看 changed_files 中的主要改动。",
            "按 validation.commands 中记录的命令复跑验证；若为空，请按项目 manifest 选择最小验证。",
            "如果是本地导入项目，在本机运行对应 UI 入口确认功能可见。",
        ],
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
    }
    return report



def _build_compact_context_state(task_snapshot: dict) -> dict:
    """Build the durable state injected after context compaction."""
    active_route = task_snapshot.get("active_intent_route") if isinstance(task_snapshot.get("active_intent_route"), dict) else {}
    active_execution_plan = task_snapshot.get("active_execution_plan") if isinstance(task_snapshot.get("active_execution_plan"), dict) else {}
    retrieval_guard = task_snapshot.get("retrieval_guard") if isinstance(task_snapshot.get("retrieval_guard"), dict) else {}
    command_history = task_snapshot.get("command_history") if isinstance(task_snapshot.get("command_history"), list) else []
    last_failed_command = next((
        item for item in reversed(command_history)
        if isinstance(item, dict) and str(item.get("status") or "").lower() in {"failed", "error"}
    ), None)
    last_agent_result = task_snapshot.get("last_agent_result") if isinstance(task_snapshot.get("last_agent_result"), dict) else {}
    # 子任务进度：让 agent 压缩/续跑后一眼看到哪些子任务已完成、还剩哪些，避免重复劳动。
    _plan = task_snapshot.get("plan") if isinstance(task_snapshot.get("plan"), dict) else {}
    _subtasks = _plan.get("subtasks") if isinstance(_plan.get("subtasks"), list) else []
    subtask_progress = [
        {
            "id": st.get("id"),
            "title": st.get("title"),
            "status": st.get("status") or "pending",
        }
        for st in _subtasks
        if isinstance(st, dict)
    ]
    return {
        "active_intent_route": active_route,
        "active_execution_plan": active_execution_plan,
        "current_target": active_execution_plan.get("target") or active_route.get("target"),
        "candidate_files": list(retrieval_guard.get("candidate_files") or []),
        "read_budget": retrieval_guard.get("read_budget"),
        "read_files": list(retrieval_guard.get("read_files") or []),
        "changed_files": list(last_agent_result.get("changed_files") or []),
        "last_failed_command": last_failed_command,
        "subtask_progress": subtask_progress,
        "next_step": task_snapshot.get("current_step") or "",
        "system_context_epoch": task_snapshot.get("system_context_epoch"),
    }


def _write_context_summary(ws_path: Path, task_id: str, agent_type: str, iteration: int, messages: list[dict]) -> str:
    autocode_dir = ws_path / ".autocode"
    autocode_dir.mkdir(parents=True, exist_ok=True)
    summary_path = autocode_dir / "CONTEXT_SUMMARY.md"
    recent_lines: list[str] = []
    for msg in messages[-10:]:
        role = msg.get("role", "unknown")
        content = (msg.get("content") or "").strip()
        if msg.get("tool_calls"):
            tool_names = []
            for tc in msg.get("tool_calls") or []:
                function = tc.get("function") or {}
                tool_names.append(function.get("name") or tc.get("name") or "?")
            content = f"[工具调用: {', '.join(tool_names)}]"
        content = re.sub(r"\s+", " ", content)[:500] if content else "(empty)"
        recent_lines.append(f"- **{role}**: {content}")

    changed = []
    task = _tasks.get(task_id) or {}
    for snapshot in (task.get("auto_snapshots") or [])[-5:]:
        changed.extend(snapshot.get("changed_files") or [])
    changed_unique = []
    for path in changed:
        if path not in changed_unique:
            changed_unique.append(path)

    recent_text = "\n".join(recent_lines) if recent_lines else "- 暂无"
    changed_text = "\n".join(f"- `{path}`" for path in changed_unique[:30]) if changed_unique else "- 暂无"
    target_text = task.get("description") or task.get("title") or "(unknown)"
    summary = "\n".join([
        "# AutoCode Context Summary",
        "",
        f"> 更新时间：{datetime.utcnow().isoformat(timespec='seconds')}Z",
        f"> Task: {task_id}",
        f"> Agent: {agent_type}",
        f"> Iteration: {iteration}",
        "",
        "## 当前目标",
        "",
        target_text,
        "",
        "## 最近上下文",
        "",
        recent_text,
        "",
        "## 最近自动快照涉及文件",
        "",
        changed_text,
    ])
    summary_path.write_text(summary, encoding="utf-8")
    return summary


# ─── 环境变量覆盖 ─────────────────────────────────────────────
DEFAULT_MODEL = os.getenv("AUTOCODE_MODEL", "")
DEFAULT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_MAX_ITERATIONS", "36"))
S0_CONTRACT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_S0_CONTRACT_MAX_ITERATIONS", "8"))
S0_LIGHT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_S0_LIGHT_MAX_ITERATIONS", "18"))
MAX_INSTALL_RETRIES = int(os.getenv("AUTOCODE_MAX_INSTALL_RETRIES", "3"))


# ─── Agent System Prompt ──────────────────────────────────────────
AGENT_SYSTEM_PROMPTS = {
    "general": """你是 AutoCode 通用执行 Agent。你根据当前 ExecutionPlan 完成代码、文档、电子表格、演示文稿、PDF、图片、数据或混合产物任务。

关键要求：
- 不使用有限项目类型或语言白名单；先读取执行计划、产物合同和候选上下文，再选择可用工具。
- 只执行计划要求的阶段。不要因为存在或缺少某个 manifest 就擅自进入依赖安装、构建、预览或产物审查。
- 代码任务使用与实际 manifest 和环境匹配的验证命令；非代码产物使用对应结构化工具和格式验证。
- 达到 artifact_contracts 与 completion_checks 后立即总结并停止。缺少能力时明确报告 capability_unavailable。
- 续跑或压缩恢复时复用已有 ExecutionPlan、PROJECT_PROFILE、RETRIEVAL_PLAN、MEMORY 和已读文件状态，不重新全量探索。
- 使用中文简要汇报真实进展和验证结果。""",

    "frontend": """你是一个自主前端开发 Agent。收到任务后按 Agentic Loop 工作：观察项目结构，读取相关文件，做最小必要修改，运行构建或类型检查，失败则继续分析并修复。

关键要求：
- 不要一开始覆盖整个文件；优先 search_code/read_file 定位后再 apply_patch。
- 写入后必须运行与 ExecutionPlan、真实 manifest 和产物格式匹配的验证；没有依据时不要猜测命令。
- Next.js 静态导出项目必须避免不可导出的动态路由；动态路由需要 generateStaticParams。
- 使用中文简要汇报真实进展。""",

    "backend": """你是一个自主后端开发 Agent。收到任务后按 Agentic Loop 工作：观察项目结构，读取相关文件，做最小必要修改，运行编译或测试，失败则继续分析并修复。

关键要求：
- 用户列出函数、文件、属性、错误点或 CI 输出时，必须进入修改和验证。
- 不要只写契约或说明；需要可运行入口和真实代码改动时必须实现。
- 写入后必须运行合适验证，例如 python -m py_compile、pytest、mvn test、go test。
- 使用中文简要汇报真实进展。""",

    "devops": """你是一个自主 DevOps Agent。优先读取项目命令和部署配置，做最小必要修改，执行验证命令，失败则继续诊断。不要越权访问工作区外路径。""",
    "researcher": """你是一个技术调研 Agent。优先检索项目内索引和相关文件，输出清晰的技术判断、风险和建议。""",
    "reviewer": """你是一个只读代码审查 Agent。你只做审查，不做修改。

关键要求：
- 只能使用只读工具（read_file / search_code / glob / lsp）定位并阅读相关代码，禁止任何写入或命令执行。
- 聚焦被要求审查的范围：正确性、边界条件、错误处理、安全隐患、与需求的偏差。
- 输出结构化结论：发现的问题（按严重度排序）、涉及的文件与行号、具体修改建议。
- 不要泛泛而谈；没有确凿依据的猜测要标注为推测。
- 用中文简要汇报审查结论。""",
}


def _agent_ownership_prompt(agent_type: str) -> str:
    policies = {
        "general": {
            "allowed": ["执行计划声明的目标及其必要依赖"],
            "ask": ["工作区外或高风险目标"],
            "avoid": ["与执行计划无关的文件"],
        },
        "frontend": {
            "allowed": ["app/", "pages/", "src/", "components/", "styles/", "public/", "*.css", "*.tsx", "*.jsx", "*.vue"],
            "ask": ["API contract files", "package.json dependencies", "routing config"],
            "avoid": ["database migrations", "server-only auth/payment logic", "deployment secrets"],
        },
        "backend": {
            "allowed": ["api/", "server/", "backend/", "src/main*", "src/**/controller*", "src/**/service*", "migrations/", "*.sql"],
            "ask": ["shared types used by frontend", "environment config", "OpenAPI/API_SPEC changes"],
            "avoid": ["visual styling", "page layout files", "frontend-only components"],
        },
        "devops": {
            "allowed": ["Dockerfile", "docker-compose*.yml", ".github/", ".gitlab-ci.yml", "deploy/", "nginx*", ".env.example"],
            "ask": ["runtime entrypoints", "build scripts", "infrastructure credentials"],
            "avoid": ["business logic rewrites", "UI redesigns", "database data changes"],
        },
        "tester": {
            "allowed": ["tests/", "__tests__/", "*.test.*", "*.spec.*", "playwright.config.*", "pytest.ini"],
            "ask": ["small testability hooks", "fixtures"],
            "avoid": ["feature implementation beyond minimal fixes"],
        },
        "architect": {
            "allowed": [".autocode/ARCHITECTURE.md", ".autocode/API_SPEC.md", ".autocode/DB_SCHEMA.md", ".autocode/PROJECT_MAP.md"],
            "ask": ["code changes"],
            "avoid": ["direct feature coding unless explicitly assigned"],
        },
        "product": {
            "allowed": [".autocode/PRD.md", ".autocode/UI_SPEC.md", ".autocode/PLAN.md"],
            "ask": ["implementation files"],
            "avoid": ["code changes"],
        },
    }
    policy = policies.get(agent_type, policies.get("general", policies["frontend"]))
    return (
        "## Agent 文件所有权边界\n"
        f"- 当前角色: `{agent_type}`\n"
        f"- 优先负责: {', '.join(policy['allowed'])}\n"
        f"- 跨边界修改前先说明理由: {', '.join(policy['ask'])}\n"
        f"- 默认避免修改: {', '.join(policy['avoid'])}\n"
        "- 如果必须跨边界修改，请在回复中明确说明原因、涉及文件和风险。\n"
    )


def _agent_ownership_prompt(agent_type: str) -> str:
    policies = {
        "general": {
            "allowed": ["执行计划声明的目标及其必要依赖"],
            "ask": ["工作区外或高风险目标"],
            "avoid": ["与执行计划无关的文件"],
        },
        "frontend": {
            "allowed": ["app/", "pages/", "src/", "components/", "styles/", "public/", "*.css", "*.tsx", "*.jsx", "*.vue"],
            "ask": ["API contract files", "package.json dependencies", "routing config"],
            "avoid": ["database migrations", "server-only auth/payment logic", "deployment secrets"],
        },
        "backend": {
            "allowed": ["api/", "server/", "backend/", "src/main*", "src/**/controller*", "src/**/service*", "migrations/", "*.sql"],
            "ask": ["shared types used by frontend", "environment config", "OpenAPI/API_SPEC changes"],
            "avoid": ["visual styling", "page layout files", "frontend-only components"],
        },
        "devops": {
            "allowed": ["Dockerfile", "docker-compose*.yml", ".github/", ".gitlab-ci.yml", "deploy/", "nginx*", ".env.example"],
            "ask": ["runtime entrypoints", "build scripts", "infrastructure credentials"],
            "avoid": ["business logic rewrites", "UI redesigns", "database data changes"],
        },
        "tester": {
            "allowed": ["tests/", "__tests__/", "*.test.*", "*.spec.*", "playwright.config.*", "pytest.ini"],
            "ask": ["small testability hooks", "fixtures"],
            "avoid": ["feature implementation beyond minimal fixes"],
        },
        "architect": {
            "allowed": [".autocode/ARCHITECTURE.md", ".autocode/API_SPEC.md", ".autocode/DB_SCHEMA.md", ".autocode/PROJECT_MAP.md"],
            "ask": ["code changes"],
            "avoid": ["direct feature coding unless explicitly assigned"],
        },
        "product": {
            "allowed": [".autocode/PRD.md", ".autocode/UI_SPEC.md", ".autocode/PLAN.md"],
            "ask": ["implementation files"],
            "avoid": ["code changes"],
        },
    }
    policy = policies.get(agent_type, policies.get("general", policies["frontend"]))
    return (
        "## Agent 文件所有权边界\n"
        f"- 当前角色: `{agent_type}`\n"
        f"- 优先负责: {', '.join(policy['allowed'])}\n"
        f"- 跨边界修改前先说明理由: {', '.join(policy['ask'])}\n"
        f"- 默认避免修改: {', '.join(policy['avoid'])}\n"
        "- 如果必须跨边界修改，请在回复中明确说明原因、涉及文件和风险。\n"
    )


ROLE_FILE_OWNERSHIP = {
    "general": ["*"],
    "frontend": [
        "app/", "pages/", "src/", "components/", "styles/", "public/",
        "package.json", "vite.config.", "next.config.", "tailwind.config.",
        ".css", ".scss", ".tsx", ".jsx", ".vue",
    ],
    "backend": [
        "api/", "server/", "backend/", "src/main/", "migrations/", "schema/",
        "pom.xml", "build.gradle", "README.md", "SCRIPT_CONTRACT.md",
        ".sql", ".java", ".kt", ".go", ".py", ".md",
    ],
    "devops": [
        "Dockerfile", "docker-compose", ".github/", ".gitlab-ci", "deploy/",
        "nginx", ".env.example", "start.sh", "package.json",
    ],
    "tester": [
        "tests/", "__tests__/", "test/", "spec/", "playwright.config",
        "pytest.ini", ".test.", ".spec.",
    ],
    "architect": [
        ".autocode/ARCHITECTURE.md", ".autocode/API_SPEC.md",
        ".autocode/DB_SCHEMA.md", ".autocode/PROJECT_MAP.md",
        ".autocode/ROLE_OWNERSHIP.md",
    ],
    "product": [
        ".autocode/PRD.md", ".autocode/UI_SPEC.md", ".autocode/PLAN.md",
    ],
    "ui": [
        ".autocode/UI_SPEC.md", ".autocode/prototype/", ".autocode/prototypes/",
        "public/", "assets/", "styles/", ".css", ".scss",
    ],
}


def _pattern_matches_path(pattern: str, normalized_path: str) -> bool:
    p = (pattern or "").strip().replace("\\", "/").lstrip("/")
    if not p:
        return False
    if p.endswith("/"):
        return normalized_path.startswith(p)
    if "*" in p:
        regex = "^" + re.escape(p).replace("\\*", ".*") + "$"
        return re.match(regex, normalized_path) is not None
    if p.startswith(".") and "/" not in p:
        return normalized_path.endswith(p)
    return normalized_path == p or normalized_path.startswith(p.rstrip("/") + "/") or p in normalized_path


def _load_workspace_role_ownership(ws_path: Path | None) -> dict[str, list[str]]:
    if not ws_path:
        return {}
    path = ws_path / ".autocode" / "ROLE_OWNERSHIP.md"
    if not path.exists() or not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    rules: dict[str, list[str]] = {}
    in_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            lang = line.strip("`").strip().lower()
            if not in_block and lang in ("ownership", "yaml", "yml", ""):
                in_block = True
                continue
            if in_block:
                in_block = False
                continue
        if not line or line.startswith("#") or line.startswith("|"):
            continue
        if ":" not in line:
            continue
        role, patterns = line.split(":", 1)
        role = role.strip().lower()
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", role):
            continue
        parsed = [p.strip().strip("`") for p in re.split(r"[,，\n]", patterns) if p.strip()]
        if parsed:
            rules[role] = parsed
    return rules


def _load_workspace_role_ownership(ws_path: Path | None) -> dict[str, list[str]]:
    if not ws_path:
        return {}
    path = ws_path / ".autocode" / "ROLE_OWNERSHIP.md"
    if not path.exists() or not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    rules: dict[str, list[str]] = {}
    in_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            lang = line.strip("`").strip().lower()
            if not in_block and lang in ("ownership", "yaml", "yml", ""):
                in_block = True
                continue
            if in_block:
                in_block = False
                continue
        if not line or line.startswith("#") or line.startswith("|"):
            continue
        if ":" not in line:
            continue
        role, patterns = line.split(":", 1)
        role = role.strip().lower()
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", role):
            continue
        parsed = [p.strip().strip("`") for p in re.split(r"[,，\n]", patterns) if p.strip()]
        if parsed:
            rules[role] = parsed
    return rules


def _load_workspace_role_ownership(ws_path: Path | None) -> dict[str, list[str]]:
    """Load configurable role ownership rules from .autocode/ROLE_OWNERSHIP.md."""
    if not ws_path:
        return {}
    path = ws_path / ".autocode" / "ROLE_OWNERSHIP.md"
    if not path.exists() or not path.is_file():
        return {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return {}

    rules: dict[str, list[str]] = {}
    in_fenced_block = False
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("```"):
            lang = line.strip("`").strip().lower()
            if not in_fenced_block:
                in_fenced_block = lang in ("", "ownership", "yaml", "yml")
            else:
                in_fenced_block = False
            continue
        if not line or line.startswith("#") or line.startswith("|"):
            continue
        line = re.sub(r"^[-*]\s+", "", line)
        if ":" not in line:
            continue
        role, patterns = line.split(":", 1)
        role = role.strip().lower()
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", role):
            continue
        tokens = [
            item.strip().strip("`").strip("'\"")
            for item in re.split(r"[,，\s]+", patterns)
            if item.strip()
        ]
        parsed = [item for item in tokens if item and item not in {"-", "[]"}]
        if parsed:
            rules[role] = parsed
    return rules


def _normalize_role_write_path(rel_path: str) -> str:
    raw = str(rel_path or "").strip().replace("\\", "/")
    if raw.startswith("/workspace/"):
        raw = raw[len("/workspace/"):]
    elif raw == "/workspace":
        raw = ""
    elif raw.startswith("workspace/"):
        raw = raw[len("workspace/"):]
    raw = raw.lstrip("/")
    while raw.startswith("./"):
        raw = raw[2:]
    normalized = posixpath.normpath(raw) if raw else ""
    if normalized == ".":
        return ""
    return normalized.lstrip("/")


def _role_can_write_path(agent_type: str, rel_path: str, ws_path: Path | None = None) -> tuple[bool, str]:
    normalized = _normalize_role_write_path(rel_path)
    if normalized.startswith(".autocode/CHAT.md") or normalized.startswith(".autocode/MEMORY.md"):
        return True, ""
    # scratch 豁免：临时/调试脚本（如探测换行符、验证片段）不受角色边界限制，
    # 任何角色都可写 .autocode/scratch/ 下的文件，避免 agent 卡在文件所有权检查上。
    if normalized.startswith(".autocode/scratch/"):
        return True, ""
    if normalized.startswith(".git/"):
        return False, "Git internal files are never writable by agents"
    if _env_bool("AUTOCODE_DISABLE_ROLE_OWNERSHIP", _unrestricted_dev_mode()):
        return True, ""
    workspace_rules = _load_workspace_role_ownership(ws_path)
    allowed = (
        workspace_rules.get(agent_type)
        or workspace_rules.get(agent_type.lower())
        or ROLE_FILE_OWNERSHIP.get(agent_type)
        or ROLE_FILE_OWNERSHIP.get("general", [])
    )
    if any(_pattern_matches_path(p, normalized) for p in allowed):
        return True, ""
    shared_docs = (
        ".autocode/CI_REPORT.md",
        ".autocode/REVIEW.md",
        ".autocode/CONTEXT_SUMMARY.md",
        ".autocode/PIPELINE.md",
    )
    if normalized in shared_docs:
        return True, ""
    return False, (
        f"Role `{agent_type}` is not allowed to write `{normalized}`. "
        "Ask the user to approve this cross-boundary write or use the owning role; do not edit .autocode/ROLE_OWNERSHIP.md just to bypass the boundary. "
        "临时调试脚本请写到 .autocode/scratch/ 下（任意角色可写）。"
    )


def _consume_role_write_grant(task: dict | None, agent_type: str, rel_path: str) -> bool:
    if task is None:
        return False
    normalized = _normalize_role_write_path(rel_path)
    grants = task.get("role_write_grants")
    if not isinstance(grants, list):
        return False
    for grant in grants:
        if not isinstance(grant, dict):
            continue
        if str(grant.get("agent_type") or "") != str(agent_type):
            continue
        if _normalize_role_write_path(str(grant.get("path") or "")) != normalized:
            continue
        uses_remaining = int(grant.get("uses_remaining") or 0)
        if uses_remaining <= 0:
            continue
        grant["uses_remaining"] = uses_remaining - 1
        grant["used"] = grant["uses_remaining"] <= 0
        grant["used_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        return True
    return False


def _grant_role_write_once(task: dict | None, agent_type: str, rel_path: str) -> None:
    if task is None:
        return
    normalized = _normalize_role_write_path(rel_path)
    if not normalized:
        return
    grants = task.setdefault("role_write_grants", [])
    if not isinstance(grants, list):
        grants = []
        task["role_write_grants"] = grants
    for grant in grants:
        if not isinstance(grant, dict):
            continue
        if str(grant.get("agent_type") or "") == str(agent_type) and _normalize_role_write_path(str(grant.get("path") or "")) == normalized:
            grant["uses_remaining"] = max(int(grant.get("uses_remaining") or 0), 10)
            grant["used"] = False
            grant["granted_at"] = datetime.utcnow().isoformat(timespec="seconds") + "Z"
            return
    grants.append({
        "agent_type": str(agent_type),
        "path": normalized,
        "granted_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "used": False,
        "uses_remaining": 10,
    })


def _should_auto_grant_local_role_write(task: dict | None, rel_path: str) -> bool:
    if not task or not task.get("local_execution_enabled"):
        return False
    if str(os.getenv("AUTOCODE_AUTO_GRANT_LOCAL_ROLE_WRITES", "true")).strip().lower() in {"0", "false", "no", "off"}:
        return False
    normalized = _normalize_role_write_path(rel_path)
    if not normalized or normalized.startswith(".git/") or normalized.startswith(".autocode/"):
        return False
    blocked_prefixes = ("dist/", "build/", ".next/", "node_modules/", "__pycache__/")
    if normalized.startswith(blocked_prefixes):
        return False
    return True


def _is_generated_artifact_path(rel_path: str) -> bool:
    normalized = _normalize_role_write_path(rel_path).lower()
    parts = [part for part in normalized.split("/") if part]
    generated = {"dist", "build", ".next", "out", "target", "node_modules", "__pycache__"}
    return any(part in generated or part.startswith("dist ") for part in parts)


def _generated_artifact_read_block(task: dict | None, rel_path: str) -> str:
    if not task or not _is_generated_artifact_path(rel_path):
        return ""
    guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
    candidates = [
        str(path).replace("\\", "/")
        for path in (guard.get("candidate_files") or [])
        if str(path).strip() and not _is_generated_artifact_path(str(path))
    ][:20]
    if not candidates:
        return ""
    return (
        "[GENERATED_ARTIFACT_SUPPRESSED] 该路径位于 dist/build 等生成产物中。"
        "当前任务已有源码候选文件，请回到源码文件修改，不要分析打包产物。\n"
        + "\n".join(candidates)
    )


def _fast_edit_read_block(task: dict | None, tool_name: str, rel_path: str) -> str:
    if not _unrestricted_dev_mode(task):
        return ""
    if tool_name not in {"read_file", "read_lines", "glob", "search_code"}:
        return ""
    guard = task.get("retrieval_guard") if isinstance(task, dict) and isinstance(task.get("retrieval_guard"), dict) else {}
    candidate_files = [
        _normalize_role_write_path(str(path))
        for path in (guard.get("candidate_files") or [])
        if str(path).strip()
    ]
    read_files = [
        _normalize_role_write_path(str(path))
        for path in (guard.get("read_files") or [])
        if str(path).strip()
    ]
    limit = _env_int("AUTOCODE_FAST_EDIT_FILE_READ_LIMIT", 5, minimum=1)
    if len(set(read_files)) < limit or not candidate_files:
        return ""
    normalized = _normalize_role_write_path(rel_path)
    if normalized in candidate_files:
        return ""
    if tool_name == "read_lines" and normalized in candidate_files:
        return ""
    return (
        "[FAST_EDIT_MODE_ENTERED] 已读取足够多关键文件，极速模式要求停止扩散 discovery。"
        "请基于候选文件直接编辑、验证，或给出具体阻塞原因。\n"
        + "\n".join(candidate_files[:30])
    )


async def _record_role_write_block(
    *,
    task_id: str,
    agent_type: str,
    rel_path: str,
    reason: str,
    persist,
) -> None:
    task = _tasks.get(task_id)
    await asyncio.to_thread(
        harness_repository.add_event,
        task.get("harness_trace_id") if task else None,
        "security",
        "role_write_blocked",
        {
            "agent_type": agent_type,
            "path": rel_path,
            "reason": reason,
        },
    )
    if task is not None:
        append_event(
            task,
            "role_write_blocked",
            {
                "agent": agent_type,
                "path": rel_path,
                "reason": reason,
                "recoverable": True,
                "resolution": "request_user_approval_or_use_owning_role",
            },
            source="security",
        )
        persist(task_id)


async def _await_role_write_confirmation(
    *,
    task_id: str,
    agent_type: str,
    rel_path: str,
    reason: str,
    tool_name: str,
    tool_args: dict[str, Any],
    persist,
    log,
    timeout_seconds: int = 300,
) -> bool:
    task = _tasks.get(task_id)
    normalized = _normalize_role_write_path(rel_path)
    if not task or not normalized:
        return False
    approval_id = f"approval-{uuid.uuid4().hex[:12]}"
    approval_event = append_event(
        task,
        "approval_requested",
        {
            "approval_id": approval_id,
            "tool": tool_name,
            "action": "cross_boundary_write",
            "path": normalized,
            "agent": agent_type,
            "reason": reason,
            "message": reason,
            "payload": {
                "kind": "role_write_grant",
                "action": "cross_boundary_write",
                "path": normalized,
                "tool": tool_name,
                "tool_args": dict(tool_args or {}),
            },
            "auto_approve_after_seconds": 0,
            "manual_required": True,
            "high_risk": False,
        },
        source="security",
    )
    event_id = str(approval_event.get("id") or "")
    task["status"] = "waiting_confirm"
    task["pending_confirmation"] = {
        "kind": "role_write_grant",
        "action": "cross_boundary_write",
        "path": normalized,
        "reason": reason,
        "event_id": event_id,
        "approval_id": approval_id,
        "payload": {
            "tool": tool_name,
            "tool_args": dict(tool_args or {}),
            "path": normalized,
        },
        "manual_required": True,
        "high_risk": False,
        "auto_approve_after_seconds": 0,
    }
    persist(task_id)
    log("warn", f"Waiting user confirm: cross-boundary-write {normalized}", agent_type)

    waited = 0
    while waited < timeout_seconds:
        await asyncio.sleep(1)
        waited += 1
        conf = _confirmations.get(task_id)
        if conf and (conf.get("approval_id") == approval_id or conf.get("event_id") == event_id):
            _confirmations.pop(task_id, None)
            task = _tasks.get(task_id)
            approved = bool(conf.get("approved") or conf.get("confirmed"))
            if task:
                if approved:
                    task["status"] = "running"
                    task.pop("pending_confirmation", None)
                    _grant_role_write_once(task, agent_type, normalized)
                    persist(task_id)
                    log("success", f"User approved cross-boundary write: {normalized}; executing original write", agent_type)
                    return True
                task["status"] = "cancelled"
                task["current_step"] = "用户拒绝了跨角色写入"
                task.pop("pending_confirmation", None)
                persist(task_id)
            return False
        task = _tasks.get(task_id)
        if task and task.get("status") == "cancelled":
            return False

    task = _tasks.get(task_id)
    if task:
        task.pop("pending_confirmation", None)
        persist(task_id)
    return False


WORKSPACE_SECURITY_RULES = """

安全边界：
- 只能操作当前任务工作区，或 Local Connector 已授权且执行计划明确指定的本地目录。
- workspace 文件使用 workspace 工具；本地文件使用结构化 Local Connector 工具，不得混用或伪造路径。
- 禁止目录穿越、扫描系统目录、访问其他任务工作区或未授权用户目录。
- 高风险命令、越界路径和不可逆操作必须由权限引擎确认。
"""

AGENT_SYSTEM_PROMPTS = {
    key: value + WORKSPACE_SECURITY_RULES
    for key, value in AGENT_SYSTEM_PROMPTS.items()
}


# ─── Agent 工具定义（OpenAI function calling 格式）──────────
# Effective Agent tool schema is generated from the unified registry so model tool use,
# permissions, activity labels, and local-runner capability stay aligned.
AGENT_TOOLS = tool_registry.agent_tool_definitions()


def _effective_agent_tools(task: dict | None):
    """Return the tool set exposed to the current agent run.

    Default is the full ``AGENT_TOOLS`` set (parent runs are unaffected). When a
    task dict carries an ``allowed_tools`` allowlist (used by read-only spawned
    subagents), the set is narrowed to that subset. An empty/absent allowlist
    means "no restriction". Names not present in the registry are ignored.
    """
    if not isinstance(task, dict):
        return AGENT_TOOLS
    allowed = task.get("allowed_tools")
    if not allowed:
        return AGENT_TOOLS
    allowed_set = {str(name) for name in allowed}
    filtered = [tool for tool in AGENT_TOOLS if getattr(tool, "name", None) in allowed_set]
    return filtered or AGENT_TOOLS


class AgentOrchestrator:
    """
    Provider-agnostic Agent 编排器。

    - 通过 channel_service 动态选择最佳的 tool-capable 模型
    - 使用 LLMClient 统一抽象不同 LLM 提供商
    - 工具定义使用 OpenAI function calling 格式
    - 参考 OpenCode 架构设计
    """

    def __init__(self):
        self._llm: Optional[LLMClient] = None
        self._settings = get_settings()
        self._active_tasks: dict[str, bool] = {}  # task_id -> running
        self._model: Optional[str] = None
        self._channel_config: Optional[dict] = None
        # 对话消息队列：用户发送的消息，Agent 循环取走处理
        self._user_message_queues: dict[str, list[dict]] = {}
        # SSE 推送队列：Agent 处理结果推送给前端的对话
        self._chat_sse_queues: dict[str, asyncio.Queue] = {}
        # 等待消息的事件：Agent 循环等待用户消息时使用
        self._message_events: dict[str, asyncio.Event] = {}
        # 智能路由：模型路由器 + FailoverLLMClient 缓存
        self._router = model_router
        self._failover_clients: dict[str, FailoverLLMClient] = {}
        self._explicit_model_clients: dict[str, LLMClient] = {}
        # 任务上下文缓存（避免重复检测复杂度）
        self._task_contexts: dict[str, TaskContext] = {}
        # Background read-only subagents keyed by parent task id.
        self._background_subagents: dict[str, list[asyncio.Task]] = {}

    async def _ensure_client(self, ctx: TaskContext | None = None, requested_model: str | None = None) -> LLMClient | FailoverLLMClient:
        """
        延迟初始化 LLM 客户端。

        优先级：
        1. 任务/用户显式指定模型：UI 选择的模型必须优先于智能路由
        2. 环境变量 AUTOCODE_MODEL：用于开发和测试环境
        3. ModelRouter 智能路由：未显式指定模型时使用 TaskContext
        4. select_best_tool_model 回退：数据库没有路由规则时使用
        """
        requested_model = (requested_model or "").strip()
        if requested_model and requested_model.lower() != "auto":
            if requested_model in self._explicit_model_clients:
                self._model = requested_model
                return self._explicit_model_clients[requested_model]

            result = resolve_channel_for_model(requested_model)
            if not result:
                raise RuntimeError(f"指定模型不可用或未配置渠道: {requested_model}")

            channel, channel_model = result
            self._model = requested_model
            self._channel_config = {
                "api_key": channel.api_key,
                "base_url": channel.base_url,
                "provider": channel.provider,
                "model": channel_model,
                "billing_model": requested_model,
                "channel_id": channel.uuid or str(channel.id),
            }
            client = create_client_from_channel(self._channel_config, timeout=180.0)
            self._explicit_model_clients[requested_model] = client
            logger.info(
                f"[Orchestrator] 使用任务指定模型并跳过智能路由: {requested_model} "
                f"via {channel.provider}/{channel.name}"
            )
            return client

        # 如果已有客户端且无新上下文，直接返回
        if self._llm is not None and ctx is None:
            return self._llm

        # 优先使用环境变量配置（适用于本地开发/测试环境）
        env_model = os.getenv("AUTOCODE_MODEL", "").strip()
        env_api_key = os.getenv("AUTOCODE_API_KEY", "").strip()
        env_base_url = os.getenv("AUTOCODE_BASE_URL", "").strip()
        env_provider = os.getenv("AUTOCODE_PROVIDER", "openai").strip()
        via_muhugochat = os.getenv("AUTOCODE_LLM_VIA_MUHUGOCHAT", "false").lower() in (
            "1",
            "true",
            "yes",
            "on",
        )

        if env_model and env_api_key and not via_muhugochat:
            logger.info(f"[Orchestrator] 使用环境变量配置: model={env_model} provider={env_provider}")
            self._model = env_model
            self._channel_config = {
                "api_key": env_api_key,
                "base_url": env_base_url or None,
                "provider": env_provider,
                "model": env_model,
            }
            self._llm = create_client_from_channel(self._channel_config, timeout=180.0)
            logger.info("[Orchestrator] 已初始化 LLM 客户端（环境变量模式）")
            return self._llm

        # ── 智能路由模式（生产环境）──
        if ctx is not None:
            ctx_key = f"{ctx.agent_type}|{ctx.task_phase}|{ctx.complexity}"
            if ctx_key in self._failover_clients:
                cached = self._failover_clients[ctx_key]
                current = cached.current_model or cached._candidates[0].model_id
                self._model = current
                self._channel_config = cached._candidates[0].to_channel_config()
                return cached

            try:
                logger.info(
                    f"[Orchestrator] 智能路由: agent={ctx.agent_type} "
                    f"phase={ctx.task_phase} complexity={ctx.complexity} "
                    f"caps={ctx.required_capabilities}"
                )
                candidates = await self._router.select(ctx)

                if not candidates:
                    logger.warning("[Orchestrator] 智能路由未找到候选，回退到默认选择")
                else:
                    # 创建 FailoverLLMClient（主模型 + 2 个备选）
                    fclient = FailoverLLMClient(candidates, base_timeout=180.0)
                    self._failover_clients[ctx_key] = fclient

                    best = candidates[0]
                    self._model = best.model_id
                    self._channel_config = best.to_channel_config()
                    self._llm = fclient._get_or_create_client(best)

                    logger.info(
                        f"[Orchestrator] ✅ 智能路由选定: {best.model_id} "
                        f"(score={best.score:.3f} provider={best.provider}) "
                        f"备选: {[c.model_id for c in candidates[1:3]]}"
                    )
                    return fclient

            except Exception as e:
                logger.warning(f"[Orchestrator] 智能路由失败（回退到默认选择）: {e}")

        # ── 回退：从数据库选择模型（兼容旧逻辑）──
        logger.info("[Orchestrator] 正在从数据库选择最佳工具模型...")

        result = select_best_tool_model()
        if not result:
            raise RuntimeError(
                "未找到可用的 tool-calling 模型。\n"
                "请设置 AUTOCODE_MODEL + AUTOCODE_API_KEY [+ AUTOCODE_BASE_URL]，\n"
                "或在 MuhugoChat 管理后台添加渠道并配置 model_config。"
            )

        channel, model_name = result
        self._model = model_name
        self._channel_config = {
            "api_key": channel.api_key,
            "base_url": channel.base_url,
            "provider": channel.provider,
            "model": model_name,
            "channel_id": channel.uuid or str(channel.id),
        }

        self._llm = create_client_from_channel(self._channel_config, timeout=180.0)
        logger.info(
            f"[Orchestrator] 已初始化 LLM 客户端: "
            f"model={model_name} provider={channel.provider} base_url={channel.base_url}"
        )
        return self._llm

    @property
    def model_name(self) -> str:
        return self._model or DEFAULT_MODEL or "unknown"

    def cancel_task(self, task_id: str):
        self._active_tasks[task_id] = False

    # ─── 对话消息机制 ──────────────────────────────────────────

    def receive_user_message(self, task_id: str, message: str) -> asyncio.Queue:
        """接收用户发送的对话消息，返回 SSE 推送队列。
        
        如果任务不存在或不在运行中，返回 None。
        消息会注入到 Agent 循环中，Agent 的文本响应会推送到返回的 Queue 中。
        """
        if task_id not in _tasks:
            return None
        task = _tasks[task_id]
        if task["status"] not in ("running", "waiting_confirm", "waiting_user_input", "pending"):
            return None

        # 创建或获取 SSE 推送队列
        if task_id not in self._chat_sse_queues:
            self._chat_sse_queues[task_id] = asyncio.Queue()

        # 将用户消息加入队列
        input_id = f"input-{uuid.uuid4().hex[:16]}"
        admitted_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        if task_id not in self._user_message_queues:
            self._user_message_queues[task_id] = []
        normalized_message = _normalize_session_input_text(message)
        existing_inputs = [
            item
            for item in [
                *self._user_message_queues.get(task_id, []),
                *task.get("session_inputs", []),
            ]
            if not item.get("promoted")
        ]
        duplicate = next(
            (
                item for item in reversed(existing_inputs)
                if _normalize_session_input_text(str(item.get("content") or "")) == normalized_message
            ),
            None,
        )
        if duplicate:
            duplicate["merged_count"] = int(duplicate.get("merged_count") or 1) + 1
            duplicate["last_merged_at"] = admitted_at
            for item in task.get("session_inputs") or []:
                if item.get("id") == duplicate.get("id"):
                    item["merged_count"] = duplicate["merged_count"]
                    item["last_merged_at"] = admitted_at
            task["session_wake_requested"] = True
            task["latest_session_input_at"] = admitted_at
            append_event(
                task,
                "session_input_merged",
                {
                    "input_id": duplicate.get("id"),
                    "merged_count": duplicate.get("merged_count"),
                    "message": message[:1200],
                    "active": bool(self._active_tasks.get(task_id)),
                    "status": task.get("status"),
                },
                source="session_input",
            )
            self._persist_task(task_id)
            if task_id in self._message_events:
                self._message_events[task_id].set()
            self._chat_sse_queues[task_id].put_nowait({
                "type": "confirm",
                "content": "已合并重复指令，Agent 会按最新会话状态继续处理。",
                "timestamp": datetime.utcnow().isoformat(),
            })
            return self._chat_sse_queues[task_id]
        input_item = {
            "id": input_id,
            "content": message,
            "timestamp": admitted_at,
            "delivery": "chat",
            "promoted": False,
        }
        self._user_message_queues[task_id].append(input_item)
        task.setdefault("session_inputs", []).append(dict(input_item))
        task["session_inputs"] = task["session_inputs"][-100:]
        task["session_wake_requested"] = True
        task["latest_session_input_at"] = admitted_at
        append_event(
            task,
            "session_input_admitted",
            {
                "input_id": input_id,
                "message": message[:1200],
                "active": bool(self._active_tasks.get(task_id)),
                "status": task.get("status"),
            },
            source="session_input",
        )

        task.setdefault("logs", []).append({
            "timestamp": datetime.utcnow().isoformat(),
            "agent": "user",
            "level": "chat_user",
            "message": message,
            "detail": "",
        })
        try:
            workspace_id = task.get("workspace_id")
            if workspace_id:
                _append_workspace_chat(self._settings.workspace_base_dir / workspace_id, "user", message)
        except Exception as exc:
            logger.debug(f"[Chat] Failed to append user message to CHAT.md: {exc}")
        self._persist_task(task_id)
        try:
            trace_id = task.get("harness_trace_id")
            if trace_id:
                asyncio.create_task(asyncio.to_thread(
                    harness_repository.add_event,
                    trace_id,
                    "chat",
                    "user_intervention",
                    {
                        "message": message[:1200],
                        "status": task.get("status"),
                        "current_step": task.get("current_step"),
                    },
                ))
        except Exception as e:
            logger.debug(f"[Harness] Failed to add trace event: {e}")

        # 如果有等待事件，触发它
        if task_id in self._message_events:
            self._message_events[task_id].set()

        # 也把用户消息推送到 SSE 队列（作为确认回执）
        self._chat_sse_queues[task_id].put_nowait({
            "type": "confirm",
            "content": "已收到你的指令，Agent 会根据当前任务状态处理。",
            "timestamp": datetime.utcnow().isoformat(),
        })

        return self._chat_sse_queues[task_id]

    def _get_pending_user_messages(self, task_id: str) -> list[dict]:
        """Return and clear pending user messages."""
        task = _tasks.get(task_id)
        pending: list[dict] = []
        seen: set[str] = set()

        for item in list((task or {}).get("session_inputs") or []):
            if item.get("promoted"):
                continue
            input_id = str(item.get("id") or "")
            if input_id and input_id in seen:
                continue
            if input_id:
                seen.add(input_id)
            pending.append(item)

        if task_id in self._user_message_queues:
            for item in self._user_message_queues[task_id]:
                input_id = str(item.get("id") or "")
                if input_id and input_id in seen:
                    continue
                if input_id:
                    seen.add(input_id)
                pending.append(item)
            self._user_message_queues[task_id] = []

        if task and pending:
            promoted_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
            promoted_ids = {str(item.get("id") or "") for item in pending if item.get("id")}
            for item in task.get("session_inputs") or []:
                if str(item.get("id") or "") in promoted_ids:
                    item["promoted"] = True
                    item["promoted_at"] = promoted_at
            task["session_wake_requested"] = False
            append_event(
                task,
                "session_input_promoted",
                {
                    "count": len(pending),
                    "input_ids": sorted(promoted_ids),
                },
                source="session_input",
            )
            self._persist_task(task_id)

        return pending

    def has_pending_session_inputs(self, task_id: str) -> bool:
        task = _tasks.get(task_id)
        if not task:
            return False
        if self._user_message_queues.get(task_id):
            return True
        return any(not item.get("promoted") for item in task.get("session_inputs") or [])

    def prepare_wake_continuation(self, task_id: str) -> bool:
        task = _tasks.get(task_id)
        if not task or not self.has_pending_session_inputs(task_id):
            return False
        pending = [item for item in task.get("session_inputs") or [] if not item.get("promoted")]
        if self._user_message_queues.get(task_id):
            known = {str(item.get("id") or "") for item in pending if item.get("id")}
            for item in self._user_message_queues.get(task_id) or []:
                input_id = str(item.get("id") or "")
                if input_id and input_id in known:
                    continue
                pending.append(item)
        messages = [str(item.get("content") or "").strip() for item in pending if str(item.get("content") or "").strip()]
        if not messages:
            return False
        promoted_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        promoted_ids = {str(item.get("id") or "") for item in pending if item.get("id")}
        for item in task.get("session_inputs") or []:
            if str(item.get("id") or "") in promoted_ids:
                item["promoted"] = True
                item["promoted_at"] = promoted_at
        self._user_message_queues[task_id] = []
        task["chat_continuation_message"] = "\n\n".join(messages[-10:])
        task["last_chat_continuation_message"] = task["chat_continuation_message"]
        task["session_wake_requested"] = False
        task["session_wake_pending"] = True
        task["needs_continuation"] = True
        task["status"] = "pending"
        task["execution_active"] = False
        task["current_step"] = "收到新的对话输入，已合并到同一 Agent 会话继续执行。"
        append_event(
            task,
            "session_wake_scheduled",
            {
                "pending_count": len(messages),
                "message_preview": task["chat_continuation_message"][:1200],
            },
            source="session_input",
        )
        self._persist_task(task_id)
        return True

    def _push_agent_response(self, task_id: str, content: str):
        """Push Agent text response to the SSE queue."""
        if task_id in _tasks and content:
            _tasks[task_id].setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(),
                "agent": "assistant",
                "level": "chat_assistant",
                "message": content,
                "detail": "",
            })
            task = _tasks[task_id]
            append_event(
                task,
                "assistant_message",
                {"content": content, "source": "agent_response"},
                source="assistant",
            )
            if task.get("status") == "completed":
                append_event(
                    task,
                    "task_completed_summary",
                    {
                        "content": content,
                        "changed_files": _collect_completion_changed_files(task)[:50],
                        "commit_count": len(task.get("commit_history") or []),
                        "phase_review_count": len(task.get("phase_reviews") or []),
                        "preview_url": task.get("preview_url"),
                    },
                    source="orchestrator",
                )
            try:
                workspace_id = _tasks[task_id].get("workspace_id")
                if workspace_id:
                    _append_workspace_chat(
                        self._settings.workspace_base_dir / workspace_id,
                        "assistant",
                        content,
                    )
            except Exception as exc:
                logger.debug(f"[Chat] Failed to append assistant message to CHAT.md: {exc}")
            self._persist_task(task_id)

        if task_id in self._chat_sse_queues:
            try:
                self._chat_sse_queues[task_id].put_nowait({
                    "type": "agent_response",
                    "content": content,
                    "timestamp": datetime.utcnow().isoformat(),
                })
            except asyncio.QueueFull:
                pass

    def _push_tool_progress(self, task_id: str, tool_name: str, args: dict, result: str):
        """Push tool execution progress to the SSE queue."""
        if task_id not in self._chat_sse_queues:
            return

        task = _tasks.get(task_id)
        output_meta = None
        if task and result:
            workspace_id = task.get("workspace_id")
            if workspace_id:
                output_meta = bound_tool_output(
                    self._settings.workspace_base_dir / workspace_id,
                    result,
                    tool_name=tool_name,
                    max_preview_chars=2000,
                    max_model_chars=800,
                    max_lines=120,
                )
                result = output_meta["preview"]

        desc = tool_registry.describe_invocation(tool_name, args)

        # 截断结果
        summary = result[:500] if result else "(无输出)"
        if len(result) > 500:
            summary += "\n...（输出过长，已截断）"

        if task_id in _tasks:
            _tasks[task_id].setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(),
                "agent": "tool",
                "level": "tool_progress",
                "message": desc,
                "detail": summary,
                "tool_name": tool_name,
                "output_path": (output_meta or {}).get("full_path", ""),
                "output_truncated": bool((output_meta or {}).get("truncated")),
            })
            self._persist_task(task_id)

        try:
            event_payload = {
                "type": "tool_progress",
                "tool_name": tool_name,
                "description": desc,
                "path": args.get("path", args.get("command", "")),
                "timestamp": datetime.utcnow().isoformat(),
                "result_summary": summary,
                "output_path": (output_meta or {}).get("full_path", ""),
                "output_truncated": bool((output_meta or {}).get("truncated")),
            }
            if tool_name == "code_editor" and result and "\n" in result:
                # code_editor 结果格式为 "[OK] 摘要\n{diff}"，diff 单独下发供前端渲染编辑卡片
                _, diff_text = result.split("\n", 1)
                if diff_text.strip():
                    event_payload["diff"] = diff_text[:4000]
                    event_payload["edit_command"] = str((args or {}).get("command") or "")
            self._chat_sse_queues[task_id].put_nowait(event_payload)
        except asyncio.QueueFull:
            pass

    def _push_phase_progress(self, task_id: str, phase: str, detail: str = ""):
        """Push phase progress to the SSE queue."""
        if task_id in _tasks:
            _tasks[task_id].setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(),
                "agent": "system",
                "level": "phase_progress",
                "message": detail or phase,
                "detail": detail,
                "phase": phase,
            })
            self._persist_task(task_id)

        if task_id not in self._chat_sse_queues:
            return
        try:
            self._chat_sse_queues[task_id].put_nowait({
                "type": "phase_progress",
                "phase": phase,
                "detail": detail,
                "timestamp": datetime.utcnow().isoformat(),
            })
        except asyncio.QueueFull:
            pass

    def cleanup_chat_queue(self, task_id: str):
        """Cleanup chat queue state for a task."""
        self._chat_sse_queues.pop(task_id, None)
        self._user_message_queues.pop(task_id, None)
        self._message_events.pop(task_id, None)
        self._task_contexts.pop(task_id, None)
        # 清理该任务相关的路由缓存
        keys_to_del = [k for k in self._failover_clients if k.startswith(f"{task_id}|")]
        for k in keys_to_del:
            self._failover_clients.pop(k, None)

    # ─── 工作空间记忆系统 ──────────────────────────────────────

    def _init_workspace_memory(
        self, ws_path: Path, task_id: str,
        description: str, project_type: str, agent_types: list[str],
    ):
        """Initialize workspace memory files when a task starts."""
        autocode_dir = ws_path / ".autocode"
        autocode_dir.mkdir(parents=True, exist_ok=True)

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        agent_types_text = ", ".join(agent_types)
        plan_content = "\n".join([
            f"# AutoCode 项目计划 - {task_id[:8]}",
            "",
            f"> 生成时间：{now}",
            "",
            "## 项目目标",
            "",
            description,
            "",
            "## 技术配置",
            "",
            f"- 项目类型：{project_type}",
            f"- Agent 类型：{agent_types_text}",
            f"- 工作空间：{ws_path.name}",
            "",
            "## 执行计划",
            "",
            "- [ ] 分析需求并确认技术栈",
            "- [ ] 创建或修改核心代码",
            "- [ ] 运行验证命令",
            "- [ ] 根据验证结果继续修复",
            "",
            "## 执行日志",
            "",
            "| 时间 | Agent | 操作 | 结果 |",
            "|------|-------|------|------|",
            f"| {now} | orchestrator | 任务初始化 | 已启动 |",
        ])
        (autocode_dir / "PLAN.md").write_text(plan_content, encoding="utf-8")

        memory_content = "\n".join([
            f"# AutoCode 执行记忆 - {task_id[:8]}",
            "",
            f"> 最后更新：{now}",
            "",
            "## 当前状态",
            "- 状态：running",
            "- 当前阶段：初始化",
            f"- 已用迭代：0 / {DEFAULT_MAX_ITERATIONS}",
            "",
            "## 已完成",
            "- 暂无",
            "",
            "## 待完成",
            "- [ ] 分析需求并确认技术栈",
            "- [ ] 创建或修改项目代码",
            "- [ ] 运行验证命令",
            "- [ ] 根据验证结果继续修复",
            "",
            "## 遇到的问题",
            "- 暂无",
            "",
            "## 关键决策记录",
            "- 暂无",
        ])
        (autocode_dir / "MEMORY.md").write_text(memory_content, encoding="utf-8")

        # 2.1.1 同步到五层记忆 L2（温记忆）/ VFS（轻量替代 ES/Milvus）
        # best-effort：任何异常都不影响任务主流程
        try:
            memory_service.put_workspace_plan(task_id, plan_content)
            memory_service.put_workspace_memory(task_id, memory_content)
            # 同时将文件镜像到 VFS /memory 便于跨任务全文检索
            from services.vfs_service import vfs
            vfs.write(f"/memory/{task_id}/PLAN.md", plan_content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["plan"]})
            vfs.write(f"/memory/{task_id}/MEMORY.md", memory_content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["memory"]})
        except Exception as _e:
            logger.warning(f"[Orchestrator] 记忆同步失败（已忽略）: {_e}")

    def _update_workspace_memory(
        self, ws_path: Path, task_id: str,
        status: str, phase: str,
        completed_items: list[str] | None = None,
        issues: list[str] | None = None,
        decisions: list[str] | None = None,
        iteration: int = 0,
    ):
        """Update MEMORY.md with current execution state."""
        mem_path = ws_path / ".autocode" / "MEMORY.md"
        if not mem_path.exists():
            return

        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        content = mem_path.read_text(encoding="utf-8")

        # 更新状态行
        import re as _re
        content = _re.sub(
            r'\*\*状态\*\*:.*',
            f'**状态**: {status}',
            content,
        )
        content = _re.sub(
            r'\*\*当前阶段\*\*:.*',
            f'**当前阶段**: {phase}',
            content,
        )
        content = _re.sub(
            r'\*\*已用迭代\*\*:\s*\d+',
            f'**已用迭代**: {iteration} / {DEFAULT_MAX_ITERATIONS}',
            content,
        )

        if completed_items:
            done_section = "\n".join(f"- [x] {item}" for item in completed_items)
            content = _re.sub(
                r'## 已完成\n(?:- \[.\].*\n?)*',
                f'## 已完成\n{done_section}\n',
                content,
            )

        if issues:
            issue_section = "\n".join(f"- {item}" for item in issues)
            content = _re.sub(
                r'## 遇到的问题\n(?:- .*\n?)*',
                f'## 遇到的问题\n{issue_section}\n',
                content,
            )

        if decisions:
            dec_section = "\n".join(f"- {item}" for item in decisions)
            content = _re.sub(
                r'## 关键决策记录\n(?:- .*\n?)*',
                f'## 关键决策记录\n{dec_section}\n',
                content,
            )

        mem_path.write_text(content, encoding="utf-8")

        # 2.1.2 同步状态到五层记忆 L2；关键决策/问题落 L3 冷记忆（best-effort）
        try:
            memory_service.update_workspace_status(task_id, status, phase)
            from services.vfs_service import vfs
            vfs.write(f"/memory/{task_id}/MEMORY.md", content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["memory"]})
            if decisions:
                memory_service.archive_cold(
                    title=f"[{task_id[:8]}] 关键决策", content="\n".join(f"- {d}" for d in decisions),
                    scope="task", scope_id=task_id, tags=["decision"],
                    related_tasks=[task_id], source="workspace_file")
            if issues:
                memory_service.archive_cold(
                    title=f"[{task_id[:8]}] 遇到的问题", content="\n".join(f"- {i}" for i in issues),
                    scope="task", scope_id=task_id, tags=["issue"],
                    related_tasks=[task_id], source="workspace_file")
        except Exception as _e:
            logger.warning(f"[Orchestrator] 记忆同步失败（已忽略）: {_e}")

    # ─── 智能失败恢复 ──────────────────────────────────────────

    async def _diagnose_and_fix_install(
        self, workspace_id: str, ws_path: Path, log,
        last_error: str, retry_count: int = 0,
    ) -> tuple[bool, str]:
        """Diagnose dependency installation failure."""
        pkg_json = ws_path / "package.json"
        if not pkg_json.exists():
            diagnosis = "package.json 不存在，项目代码可能尚未生成完整。"
            log("error", diagnosis, "devops")
            return False, diagnosis
        diagnosis_lines = [
            "依赖安装失败。",
            f"重试次数：{retry_count}",
            "请根据 npm/pnpm/yarn 输出检查依赖版本、lockfile、registry 或网络问题。",
        ]
        if last_error:
            diagnosis_lines.append(last_error[-2000:])
        diagnosis = "\n".join(diagnosis_lines)
        log("warn", "依赖安装失败，已生成诊断信息。", "devops")
        return False, diagnosis


    async def _diagnose_and_fix_build(
        self, workspace_id: str, ws_path: Path, log,
        last_error: str, llm=None, messages=None,
    ) -> tuple[bool, str]:
        """Diagnose build failure and return a concise report."""
        important: list[str] = []
        for line in (last_error or "").splitlines():
            lower = line.lower()
            if any(kw in lower for kw in ("error", "failed", "cannot find", "unexpected token", "type error", "syntax error", "module not found")):
                important.append(line.strip())
            if len(important) >= 30:
                break
        diagnosis = "\n".join(important) or (last_error or "构建失败，但没有捕获到详细输出。")[-2000:]
        log("warn", "构建失败，已生成诊断信息。", "devops")
        return False, diagnosis


    def _persist_task(self, task_id: str):
        """Persist task state."""
        try:
            from services.task_repository import save_task
            task = _tasks.get(task_id)
            if task:
                if task.get("status") in {"completed", "failed", "cancelled", "stopped"}:
                    task.pop("pending_confirmation", None)
                    _confirmations.pop(task_id, None)
                save_task(task)
        except Exception as e:
            logger.debug(f"[Task] persist failed for {task_id}: {e}")

    async def execute_task(
        self,
        task_id: str,
        description: str,
        project_type: str,
        workspace_id: str,
        agent_types: list[str],
    ):
        """Execute a complete AutoCode task."""
        self._active_tasks[task_id] = True
        task = _tasks.get(task_id)
        if not task:
            return

        def log(level: str, message: str, agent: str = "orchestrator", detail: str = ""):
            entry = {
                "timestamp": datetime.utcnow().isoformat(),
                "agent": agent,
                "level": level,
                "message": message,
                "detail": detail,
            }
            task["logs"].append(entry)
            logger.info(f"[{agent.upper()}] {message}")
            if level in {"error", "warn", "success"} or len(task["logs"]) % 5 == 0:
                self._persist_task(task_id)

        if task.get("execution_active"):
            log("warn", "Duplicate execute_task call ignored: task is already running", "orchestrator")
            return

        trace_id = task.get("harness_trace_id")
        if not trace_id:
            trace_id = await asyncio.to_thread(
                harness_repository.start_trace,
                user_id=task.get("user_id"),
                task_id=task_id,
                model=task.get("model") or self._model,
                input_summary=description,
                request={
                    "title": task.get("title"),
                    "project_type": project_type,
                    "agents": agent_types,
                },
                context={"workspace_id": workspace_id},
            )
            task["harness_trace_id"] = trace_id

        async def h_event(event_type: str, name: str, payload: Optional[dict] = None):
            await asyncio.to_thread(harness_repository.add_event, trace_id, event_type, name, payload or {})

        async def h_complete(output_summary: str, metrics: Optional[dict] = None, quality: Optional[dict] = None):
            await asyncio.to_thread(
                harness_repository.complete_trace,
                trace_id,
                output_summary=output_summary,
                metrics=metrics or {},
                quality=quality or {},
            )

        async def h_fail(failure_type: str, error_msg: str, severity: str = "medium", evidence: Optional[dict] = None):
            await asyncio.to_thread(
                harness_repository.fail_trace,
                trace_id,
                failure_type,
                error_msg,
                severity,
                evidence or {},
            )

        task["execution_active"] = True
        task.pop("agent_iteration_limited", None)
        task.pop("agent_iteration_limit_reason", None)
        self._persist_task(task_id)


        usage_token = _usage_context.set(UsageContext(
            user_id=str(task.get("user_id")) if task.get("user_id") else None,
            task_id=task_id,
            scene_type="autocode",
            agent_id="orchestrator",
            request_ip=task.get("request_ip"),
        ))

        try:
            await h_event("lifecycle", "execution_start", {
                "workspace_id": workspace_id,
                "project_type": project_type,
                "agents": agent_types,
            })
            task["status"] = "running"
            task["progress"] = 5
            task["current_step"] = "初始化工作空间"
            self._persist_task(task_id)

            # 1. 确保 LLM 客户端已初始化（使用智能路由）
            task["progress"] = 5
            task["current_step"] = "分析任务复杂度并初始化 LLM"

            # 1.1 检测任务复杂度
            exec_agents = [a for a in agent_types if a != "researcher"]
            task_complexity = ModelRouter.detect_complexity(description, len(exec_agents))
            logger.info(
                f"[Orchestrator] 任务复杂度: {task_complexity} "
                f"(agents={len(exec_agents)}, desc='{description[:80]}...')"
            )
            task["complexity"] = task_complexity
            await h_event("planning", "complexity_detected", {
                "complexity": task_complexity,
                "agent_count": len(exec_agents),
            })

            # 1.2 构建 TaskContext 并初始化路由客户端
            primary_agent = exec_agents[0] if exec_agents else agent_types[0]
            global_ctx = TaskContext(
                agent_type=primary_agent,
                task_phase="planning",
                content_types=["code", "text"],
                complexity=task_complexity,
                required_capabilities=["tool"],
            )
            self._task_contexts[task_id] = global_ctx
            await self._ensure_client(global_ctx, requested_model=task.get("model"))
            self._persist_task(task_id)

            # 2. 初始化 / 复用 Workspace
            if task.get("needs_continuation") or task.get("chat_continuation_message"):
                log("info", f"复用 Workspace: {workspace_id}", "orchestrator")
            else:
                log("info", f"创建 Workspace: {workspace_id}", "orchestrator")
            await docker_manager.create_workspace(workspace_id, project_type)
            ws_path = self._settings.workspace_base_dir / workspace_id

            # ── 断点续跑：恢复上次中断的进度 ──
            last_session_path = ws_path / ".autocode" / "SESSION_SUMMARY.md"
            if task.get("needs_continuation") and last_session_path.exists():
                try:
                    last_summary = last_session_path.read_text(encoding="utf-8", errors="replace")
                    log("info", f"续跑任务：上次执行记录：{last_summary[:500]}", "orchestrator")
                    task["last_session_summary"] = last_summary
                    last_step = "未知步骤"
                    for entry in reversed(task.get("logs", [])):
                        if entry.get("level") in ("tool_progress", "phase_progress"):
                            last_step = entry.get("message", "")
                            break
                    task["current_step"] = f"[续跑] 从 {last_step} 继续执行"
                    task["progress"] = max(task.get("progress", 0), 20)
                    self._persist_task(task_id)
                except Exception as e:
                    log("warn", f"读取上次会话记录失败：{e}", "orchestrator")
            await h_event("workspace", "workspace_ready", {
                "workspace_id": workspace_id,
                "project_type": project_type,
            })

            # 2.1 写入工作空间记忆文件。跨轮对话增量执行时保留已有计划与记忆。
            preserve_memory = bool(task.get("needs_continuation") or task.get("chat_continuation_message"))
            if preserve_memory and (ws_path / ".autocode" / "PLAN.md").exists():
                log("info", "保留已有工作空间记忆文件，进入续跑/增量执行模式", "orchestrator")
            else:
                self._init_workspace_memory(ws_path, task_id, description, project_type, agent_types)
                log("success", "工作空间记忆文件已初始化 (.autocode/PLAN.md, MEMORY.md)", "orchestrator")

            # 3. 初始化 Git
            git_manager.init(ws_path)
            log("success", "Git 仓库已初始化", "orchestrator")

            # 4. 启动 PTY 终端
            terminal_manager.start_session(workspace_id, str(ws_path))
            log("info", "终端会话已启动", "orchestrator")

            # 5. [Researcher 阶段]
            research_report = None
            if "researcher" in agent_types:
                task["progress"] = 10
                task["current_step"] = "Researcher 调研中"
                log("info", "启动 Researcher Agent 调研阶段", "orchestrator")

                # 灏?LLM 瀹㈡埛绔厤缃紶缁?Researcher
                researcher_agent.set_llm_config(self._llm, self._model)
                with usage_agent("researcher"):
                    research_report = await researcher_agent.research(
                        task_id=task_id,
                        description=description,
                        project_type=project_type,
                        workspace_id=workspace_id,
                        log_fn=log,
                    )

                report_path = ws_path / "RESEARCH_REPORT.md"
                report_path.write_text(
                    self._format_research_report(research_report),
                    encoding="utf-8",
                )
                log("success", "调研报告已生成并保存", "researcher")
                task["research_report"] = research_report

                if len(agent_types) == 1 and agent_types[0] == "researcher":
                    task["progress"] = 100
                    task["status"] = "completed"
                    task["current_step"] = "调研完成"
                    log("success", "仅调研任务完成", "orchestrator")
                    await h_complete("Research-only task completed", {
                        "progress": 100,
                        "mode": "researcher_only",
                    }, {"completed": True})
                    return

            # 6. [Agent 执行 — 支持智能任务规划]
            task["progress"] = 25
            task["current_step"] = "启动 Agent 执行"

            exec_agents = [a for a in agent_types if a != "researcher"]

            # ── 检查是否有任务规划 ──
            chat_continuation_message = str(task.pop("chat_continuation_message", "") or "").strip()
            if chat_continuation_message:
                task["last_chat_continuation_message"] = chat_continuation_message
                self._persist_task(task_id)
            task_plan_raw = task.get("plan")
            task_plan = TaskPlan.model_validate(task_plan_raw) if isinstance(task_plan_raw, dict) else task_plan_raw

            if chat_continuation_message and _should_use_agentic_execution(task, chat_continuation_message, project_type):
                task["execution_mode"] = "agentic"
                task["guardrails"] = {
                    "review": True,
                    "ci": True,
                    "prototype": False,
                }
                log("info", "AI 助手增量执行进入 Agentic Loop：由 Agent 自主检索、修改、验证。", "orchestrator")
                self._push_phase_progress(
                    task_id,
                    "agentic_chat_continuation",
                    "AI 助手正在以 Agentic Loop 继续：自主检索、修改、验证。",
                )
                actionable_request = is_actionable_development_request(chat_continuation_message)
                reused_retrieval_plan = _reuse_retrieval_plan(task, source="chat_continuation")
                if reused_retrieval_plan:
                    retrieval_plan_dict = reused_retrieval_plan
                else:
                    retrieval_plan = plan_retrieval(
                        ws_path,
                        chat_continuation_message,
                        task,
                        max_files=8 if actionable_request else 3,
                    )
                    retrieval_plan_text = render_retrieval_plan(retrieval_plan)
                    try:
                        autocode_dir = ws_path / ".autocode"
                        autocode_dir.mkdir(parents=True, exist_ok=True)
                        (autocode_dir / "RETRIEVAL_PLAN.md").write_text(retrieval_plan_text, encoding="utf-8")
                    except Exception as exc:
                        log("warn", f"写入检索计划失败：{exc}", "orchestrator")
                    retrieval_plan_dict = retrieval_plan.to_dict()
                    retrieval_plan_dict["system_context_epoch"] = task.get("system_context_epoch")
                    task["retrieval_plan"] = retrieval_plan_dict
                    previous_guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
                    task["retrieval_guard"] = {
                        "active": True,
                        "candidate_files": retrieval_plan.candidate_files,
                        "index_docs": retrieval_plan.index_docs,
                        "read_budget": retrieval_plan.read_budget,
                        "read_files": list(previous_guard.get("read_files") or []),
                    }
                self._persist_task(task_id)
                await h_event("execution", "agentic_loop_start", {
                    "mode": "agentic",
                    "source": "chat_continuation",
                    "actionable": actionable_request,
                    "candidate_files": task.get("retrieval_guard", {}).get("candidate_files") or [],
                    "retrieval_plan_reused": bool(reused_retrieval_plan),
                    "guardrails": task.get("guardrails"),
                })
                append_event(task, "agentic_loop_start", {
                    "mode": "agentic",
                    "source": "chat_continuation",
                    "actionable": actionable_request,
                    "candidate_files": task.get("retrieval_guard", {}).get("candidate_files") or [],
                    "retrieval_plan_reused": bool(reused_retrieval_plan),
                    "guardrails": task.get("guardrails"),
                }, source="orchestrator")
                before_snapshot = _workspace_file_snapshot(ws_path)
                changed = await self._run_agentic_loop(
                    task_id=task_id,
                    description=chat_continuation_message,
                    project_type=project_type,
                    workspace_id=workspace_id,
                    agent_type=primary_agent,
                    ws_path=ws_path,
                    log=log,
                    research_report=research_report,
                    task_plan=task_plan,
                )
                if _agent_needs_auto_continuation(task):
                    log("info", "Agentic Loop 达到续跑保险丝，已交给后台队列处理。", "orchestrator")
                    _set_agentic_finish(
                        task,
                        status="checkpoint",
                        reason="iteration_limited",
                        retryable=True,
                        message="Agentic Loop reached the hard continuation safety gate and will continue through the queue.",
                    )
                    self._persist_task(task_id)
                    return
                changed_files = _snapshot_changed(before_snapshot, _workspace_file_snapshot(ws_path))
                changed_result_files = _agent_changed_files(changed)
                if changed_result_files:
                    changed_files = list(dict.fromkeys([*changed_files, *changed_result_files]))
                meaningful_changed_files = _meaningful_changed_file_list(changed_files)
                if not meaningful_changed_files and actionable_request:
                    _mark_agentic_no_change_retryable(task)
                    await h_event("execution", "agentic_loop_no_change_retryable", {
                        "message": chat_continuation_message[:1000],
                        "retrieval_plan": task.get("retrieval_plan"),
                        "ignored_auxiliary_changes": changed_files[:100],
                    })
                    append_event(task, "agentic_loop_no_change_retryable", {
                        "message": chat_continuation_message[:1000],
                        "retrieval_plan": task.get("retrieval_plan"),
                        "ignored_auxiliary_changes": changed_files[:100],
                    }, source="orchestrator")
                    self._persist_task(task_id)
                    return
                review_ok = await self._review_execution_group(
                    task_id,
                    task,
                    ws_path,
                    log,
                    "AI 助手 Agentic 增量修改",
                    [],
                    meaningful_changed_files,
                    guardrail_kind="agentic",
                )
                if not review_ok and _unrestricted_dev_mode(task):
                    append_event(task, "review_advisory_finished", {
                        "phase": "AI 助手 Agentic 增量修改",
                        "blocking": False,
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    }, source="reviewer")
                elif not review_ok:
                    _set_agentic_finish(
                        task,
                        status="blocked",
                        reason="guardrail_review_failed",
                        changed_files=meaningful_changed_files,
                        review_passed=False,
                        blocked=True,
                        message="Agentic changes did not pass the review guardrail.",
                    )
                    await h_fail("chat_continuation_review_failed", "AI 助手增量修改未通过产物审查", "high", {
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    })
                    self._persist_task(task_id)
                    return
                _set_agentic_finish(
                    task,
                    status="completed",
                    reason="changed_and_guardrails_passed",
                    changed_files=meaningful_changed_files,
                    review_passed=True,
                    message="Agentic continuation produced changes and passed guardrail review.",
                )
                if isinstance(task.get("retrieval_guard"), dict):
                    task["retrieval_guard"]["active"] = False
                    self._persist_task(task_id)

            elif chat_continuation_message:
                log("info", "AI 助手增量执行：基于当前工作区和用户最新指令继续修改。", "orchestrator")
                self._push_phase_progress(task_id, "chat_continuation", "AI 助手正在基于当前工作区增量执行...")
                actionable_request = is_actionable_development_request(chat_continuation_message)
                reused_retrieval_plan = _reuse_retrieval_plan(task, source="single_agent_chat_continuation")
                if reused_retrieval_plan:
                    retrieval_plan_text = render_retrieval_plan(RetrievalPlan(
                        intent=str(reused_retrieval_plan.get("intent") or "continue_development"),
                        search_terms=list(reused_retrieval_plan.get("search_terms") or []),
                        candidate_files=list(reused_retrieval_plan.get("candidate_files") or []),
                        index_docs=list(reused_retrieval_plan.get("index_docs") or []),
                        read_budget=int(reused_retrieval_plan.get("read_budget") or 12),
                        rationale=list(reused_retrieval_plan.get("rationale") or []),
                        total_files=int(reused_retrieval_plan.get("total_files") or 0),
                    ))
                else:
                    retrieval_plan = plan_retrieval(
                        ws_path,
                        chat_continuation_message,
                        task,
                        max_files=8 if actionable_request else 3,
                    )
                    retrieval_plan_text = render_retrieval_plan(retrieval_plan)
                    try:
                        autocode_dir = ws_path / ".autocode"
                        autocode_dir.mkdir(parents=True, exist_ok=True)
                        (autocode_dir / "RETRIEVAL_PLAN.md").write_text(retrieval_plan_text, encoding="utf-8")
                    except Exception as exc:
                        log("warn", f"写入检索计划失败：{exc}", "orchestrator")
                    retrieval_plan_dict = retrieval_plan.to_dict()
                    retrieval_plan_dict["system_context_epoch"] = task.get("system_context_epoch")
                    task["retrieval_plan"] = retrieval_plan_dict
                    previous_guard = task.get("retrieval_guard") if isinstance(task.get("retrieval_guard"), dict) else {}
                    task["retrieval_guard"] = {
                        "active": True,
                        "candidate_files": retrieval_plan.candidate_files,
                        "index_docs": retrieval_plan.index_docs,
                        "read_budget": retrieval_plan.read_budget,
                        "read_files": list(previous_guard.get("read_files") or []),
                    }
                self._persist_task(task_id)
                log(
                    "info",
                    f"检索计划已{'复用' if reused_retrieval_plan else '生成'}：候选文件 {len((task.get('retrieval_guard') or {}).get('candidate_files') or [])} 个，读取预算 {(task.get('retrieval_guard') or {}).get('read_budget')}",
                    "orchestrator",
                    retrieval_plan_text,
                )
                request_kind = "明确的代码修改清单" if actionable_request else "普通增量反馈"
                continuation_prompt = "\n".join([
                    "## AI 助手增量开发请求",
                    "",
                    "用户最新指令：",
                    chat_continuation_message,
                    "",
                    "## 后端检索计划（必须遵守）",
                    retrieval_plan_text,
                    "",
                    "要求：",
                    "1. 基于当前工作区、记忆、最近会话、审查和 CI 状态继续处理，不要重新创建项目。",
                    "2. 优先使用项目地图和候选文件，按需读取相关文件，避免全量扫描。",
                    "3. 如果用户列出具体函数、文件、属性、错误点或修改清单，必须进入修改和验证。",
                    "4. 写入后必须运行合适的验证命令；验证失败要继续分析并修复。",
                    "5. 如果无法继续，必须给出具体阻塞原因，而不是笼统要求用户重新说明。",
                    f"6. 当前请求类型：{request_kind}。",
                ])
                before_snapshot = _workspace_file_snapshot(ws_path)
                changed = await self._run_single_agent(
                    task_id,
                    continuation_prompt,
                    project_type,
                    workspace_id,
                    primary_agent,
                    ws_path,
                    log,
                    research_report,
                )
                if _agent_needs_auto_continuation(task):
                    log("info", "AI 助手已达到单段迭代上限，已保存上下文并交给后台队列自动续跑。", "orchestrator")
                    self._persist_task(task_id)
                    return
                changed_files = _snapshot_changed(before_snapshot, _workspace_file_snapshot(ws_path))
                changed_result_files = _agent_changed_files(changed)
                if changed_result_files:
                    changed_files = list(dict.fromkeys([*changed_files, *changed_result_files]))
                meaningful_changed_files = _meaningful_changed_file_list(changed_files)
                if not meaningful_changed_files:
                    if actionable_request:
                        retry_prompt = continuation_prompt + "\n\n" + "\n".join([
                            "## 强制续改",
                            "上一轮 Agent 没有产生文件变更，但用户消息包含明确的代码修改清单。",
                            "不要回复目标不明确，必须执行：",
                            "1. 使用 search_code 定位用户提到的函数、属性和文件。",
                            "2. 读取定位到的源代码文件。",
                            "3. 使用 apply_patch 或 write_file 做最小修改。",
                            "4. 运行验证命令。",
                            "如果仍无法修改，必须说明缺少哪个具体文件或符号。",
                        ])
                        retry_snapshot = _workspace_file_snapshot(ws_path)
                        changed = await self._run_single_agent(
                            task_id,
                            retry_prompt,
                            project_type,
                            workspace_id,
                            primary_agent,
                            ws_path,
                            log,
                            research_report,
                        )
                        if _agent_needs_auto_continuation(task):
                            log("info", "强制续改达到单段迭代上限，已保存上下文并交给后台队列自动续跑。", "orchestrator")
                            self._persist_task(task_id)
                            return
                        changed_files = _snapshot_changed(retry_snapshot, _workspace_file_snapshot(ws_path))
                        changed_result_files = _agent_changed_files(changed)
                        if changed_result_files:
                            changed_files = list(dict.fromkeys([*changed_files, *changed_result_files]))
                        meaningful_changed_files = _meaningful_changed_file_list(changed_files)
                    if not meaningful_changed_files:
                        if actionable_request:
                            log("error", "执行明确修改清单后仍无文件变更，标记为 Agent 执行失败", "orchestrator")
                            task["status"] = "failed"
                            task["current_step"] = "AI 助手未能执行明确修改清单"
                            task["needs_continuation"] = True
                            if isinstance(task.get("retrieval_guard"), dict):
                                task["retrieval_guard"]["active"] = False
                            self._persist_task(task_id)
                            await h_fail("chat_continuation_no_changes", "AI 助手未能执行明确修改清单", "medium", {
                                "reason": "actionable_request_produced_no_changes",
                                "message": chat_continuation_message[:1000],
                                "retrieval_plan": task.get("retrieval_plan"),
                            })
                            self.cleanup_chat_queue(task_id)
                            return
                        clarification = (
                            "我检查了当前工作区记忆、项目地图和最近会话，但这次没有得到足够明确的修改目标，"
                            "因此没有强行改文件。请直接描述具体想改变的行为、报错、输出格式或页面效果，我会继续基于当前项目处理。"
                        )
                        log("warn", "AI 助手增量执行未产生文件变更，已等待更具体的反馈", "orchestrator")
                        self._push_agent_response(task_id, clarification)
                        task["status"] = "completed"
                        task["progress"] = max(task.get("progress", 0), 100)
                        task["current_step"] = "等待更具体的修改目标"
                        task["needs_continuation"] = False
                        if isinstance(task.get("retrieval_guard"), dict):
                            task["retrieval_guard"]["active"] = False
                        self._persist_task(task_id)
                        await h_complete("Chat continuation needs clarification", {
                            "status": task.get("status"),
                            "progress": task.get("progress"),
                            "reason": "no_changes_from_ambiguous_feedback",
                        }, {
                            "completed": True,
                            "needs_user_clarification": True,
                        })
                        self.cleanup_chat_queue(task_id)
                        return
                review_ok = await self._review_execution_group(
                    task_id,
                    task,
                    ws_path,
                    log,
                    "AI 助手增量修改",
                    [],
                    meaningful_changed_files,
                )
                if not review_ok and _unrestricted_dev_mode(task):
                    append_event(task, "review_advisory_finished", {
                        "phase": "AI 助手增量修改",
                        "blocking": False,
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    }, source="reviewer")
                elif not review_ok:
                    await h_fail("chat_continuation_review_failed", "AI 助手增量修改未通过产物审查", "high", {
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    })
                    self._persist_task(task_id)
                    return
                if isinstance(task.get("retrieval_guard"), dict):
                    task["retrieval_guard"]["active"] = False
                    self._persist_task(task_id)

            elif _should_use_agentic_execution(task, description, project_type):
                task["execution_mode"] = "agentic"
                task["guardrails"] = {
                    "review": True,
                    "ci": True,
                    "prototype": bool(task.get("prototype_required")),
                }
                self._persist_task(task_id)
                await h_event("execution", "agentic_loop_start", {
                    "mode": "agentic",
                    "planned_subtasks": len(task_plan.subtasks) if task_plan and task_plan.subtasks else 0,
                    "guardrails": task.get("guardrails"),
                })
                append_event(task, "agentic_loop_start", {
                    "mode": "agentic",
                    "source": "task_execution",
                    "planned_subtasks": len(task_plan.subtasks) if task_plan and task_plan.subtasks else 0,
                    "guardrails": task.get("guardrails"),
                }, source="orchestrator")
                log("info", "Agentic Loop mode: stages are guardrails, not the execution driver.", "orchestrator")
                self._push_phase_progress(
                    task_id,
                    "agentic_loop_start",
                    "Agentic Loop 已启动：AI 将自主检索、修改并验证，阶段仅作为护栏。",
                )
                changed = await self._run_agentic_loop(
                    task_id=task_id,
                    description=description,
                    project_type=project_type,
                    workspace_id=workspace_id,
                    agent_type=primary_agent,
                    ws_path=ws_path,
                    log=log,
                    research_report=research_report,
                    task_plan=task_plan,
                )
                if _agent_needs_auto_continuation(task):
                    task["current_step"] = "Agentic Loop 达到续跑保险丝，正在保存上下文并交给后台队列。"
                    _set_agentic_finish(
                        task,
                        status="checkpoint",
                        reason="iteration_limited",
                        retryable=True,
                        message="Agentic Loop reached the hard continuation safety gate and will continue through the queue.",
                    )
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                agentic_changed_files = _meaningful_changed_file_list(_agent_changed_files(changed))
                if not agentic_changed_files and is_actionable_development_request(description):
                    _mark_agentic_no_change_retryable(task)
                    await h_event("execution", "agentic_loop_no_change_retryable", {
                        "message": description[:1000],
                        "source": "task_execution",
                    })
                    append_event(task, "agentic_loop_no_change_retryable", {
                        "message": description[:1000],
                        "source": "task_execution",
                    }, source="orchestrator")
                    self._persist_task(task_id)
                    return
                _set_agentic_finish(
                    task,
                    status="checkpoint",
                    reason="agentic_run_completed_pending_final_guardrails",
                    changed_files=agentic_changed_files,
                    message="Agentic execution finished its active loop; final task guardrails will decide completion.",
                )

            elif task_plan and task_plan.subtasks:
                # ── 计划驱动模式：按执行分组依次执行子任务 ──
                log("info", f"进入计划驱动模式：{len(task_plan.subtasks)} 个子任务，{len(task_plan.execution_groups)} 个执行组", "orchestrator")
                await h_event("planning", "plan_ready", {
                    "subtask_count": len(task_plan.subtasks),
                    "group_count": len(task_plan.execution_groups),
                })
                self._push_phase_progress(task_id, "plan_execution", f"开始执行 {len(task_plan.subtasks)} 个子任务...")

                # ── 6.0 原型生成与确认（计划确认后、子任务执行前）──
                # 原型驱动开发：先根据计划生成 UI 原型，用户确认后再执行代码开发
                recon_requires_prototype = task.get("prototype_required")
                requires_prototype = (
                    bool(recon_requires_prototype)
                    if recon_requires_prototype is not None
                    else self._requires_prototype_confirmation(project_type, task_plan)
                )
                if requires_prototype:
                    with usage_agent("prototype"):
                        await self._generate_and_confirm_prototype(
                            task_id, task, description, workspace_id, ws_path, log, task_plan,
                        )
                else:
                    task["prototype_required"] = False
                    task["prototype_confirmed"] = True
                    task["status"] = "running"
                    task["progress"] = 25
                    task["current_step"] = "当前任务不需要 UI 原型，继续进入开发。"
                    self._persist_task(task_id)
                    log("info", f"非 UI 项目跳过原型确认，project_type={project_type}", "orchestrator")
                    self._push_phase_progress(
                        task_id, "prototype_skipped",
                        "当前任务不需要 UI 原型，继续进入开发。"
                    )

                # 检查是否被取消或超时
                if task.get("status") == "cancelled":
                    return

                subtask_map = {st.id: st for st in task_plan.subtasks}
                total_subtasks = len(task_plan.subtasks)
                completed_count = sum(1 for st in task_plan.subtasks if st.status == SubTaskStatus.completed)

                for group_idx, group in enumerate(task_plan.execution_groups):
                    if task.get("status") == "cancelled":
                        break

                    group_subtasks = [subtask_map[sid] for sid in group if sid in subtask_map]
                    if not group_subtasks:
                        continue

                    group_label = f"第 {group_idx + 1}/{len(task_plan.execution_groups)} 组"
                    log("info", f"执行 {group_label}: {[s.title for s in group_subtasks]}", "orchestrator")
                    if (
                        all(st.status == SubTaskStatus.completed for st in group_subtasks)
                        and _group_review_passed(task, group_label, group_idx, group_subtasks)
                    ):
                        log("info", f"跳过已完成执行组 {group_label}: {[s.title for s in group_subtasks]}", "orchestrator")
                        await h_event("execution", "group_resume_skip", {
                            "group": group_label,
                            "subtasks": [{"id": s.id, "title": s.title, "agent_type": s.agent_type} for s in group_subtasks],
                        })
                        self._push_phase_progress(
                            task_id,
                            "group_resume_skip",
                            f"{group_label} 已完成且审查通过，续跑时跳过",
                        )
                        task["progress"] = 25 + int((completed_count / total_subtasks) * 50)
                        self._sync_plan_to_task(task_id, task_plan)
                        self._persist_task(task_id)
                        continue

                    await h_event("execution", "group_start", {
                        "group": group_label,
                        "subtasks": [{"id": s.id, "title": s.title, "agent_type": s.agent_type} for s in group_subtasks],
                    })
                    self._push_phase_progress(task_id, "group_start", f"{group_label}: {', '.join(s.title for s in group_subtasks)}")
                    group_before_snapshot = _workspace_file_snapshot(ws_path)

                    # 更新规划中的子任务状态
                    for st in group_subtasks:
                        st.status = SubTaskStatus.running
                        st.progress = 0
                        task["current_subtask_id"] = st.id
                    self._sync_plan_to_task(task_id, task_plan)

                    # 同组内并行执行
                    if len(group_subtasks) == 1:
                        st = group_subtasks[0]
                        await self._execute_subtask(
                            task_id, st, description, project_type,
                            workspace_id, ws_path, log, research_report,
                            task_plan=task_plan,
                        )
                        if st.status == SubTaskStatus.completed:
                            completed_count += 1
                    else:
                        results = await asyncio.gather(
                            *[
                                self._execute_subtask(
                                    task_id, st, description, project_type,
                                    workspace_id, ws_path, log, research_report,
                                    task_plan=task_plan,
                                )
                                for st in group_subtasks
                            ],
                            return_exceptions=True,
                        )
                        for result in results:
                            if isinstance(result, AgentWaitingForUserInput):
                                raise result
                            if isinstance(result, Exception):
                                log("error", f"{group_label} subtask raised: {result}", "orchestrator")
                        completed_count += sum(1 for st in group_subtasks if st.status == SubTaskStatus.completed)

                    if _agent_needs_auto_continuation(task):
                        task["current_step"] = f"{group_label} 达到单段迭代上限，正在自动压缩上下文并续跑..."
                        self._sync_plan_to_task(task_id, task_plan)
                        self._persist_task(task_id)
                        self._push_phase_progress(
                            task_id,
                            "auto_continuation_checkpoint",
                            task["current_step"],
                        )
                        return

                    failed_subtasks = [st for st in group_subtasks if st.status == SubTaskStatus.failed]
                    if failed_subtasks:
                        task["status"] = "failed"
                        task["current_subtask_id"] = failed_subtasks[0].id
                        task["current_step"] = f"{group_label} 失败: {', '.join(st.title for st in failed_subtasks)}"
                        await h_fail("subtask_failed", task["current_step"], "high", {
                            "group": group_label,
                            "failed_subtasks": [{"id": st.id, "title": st.title} for st in failed_subtasks],
                        })
                        self._sync_plan_to_task(task_id, task_plan)
                        self._persist_task(task_id)
                        self._push_phase_progress(
                            task_id, "group_failed",
                            f"{group_label} 失败: {', '.join(st.title for st in failed_subtasks)}"
                        )
                        return

                    # 更新进度
                    task["progress"] = 25 + int((completed_count / total_subtasks) * 50)
                    await h_event("execution", "group_complete", {
                        "group": group_label,
                        "completed_count": completed_count,
                        "total_subtasks": total_subtasks,
                    })
                    self._push_phase_progress(
                        task_id, "group_complete",
                        f"{group_label} 完成 ({completed_count}/{total_subtasks})"
                    )
                    group_changed_files = _snapshot_changed(group_before_snapshot, _workspace_file_snapshot(ws_path))

                    review_ok = await self._review_execution_group(
                        task_id, task, ws_path, log, group_label, group_subtasks, group_changed_files,
                    )
                    await h_event("review", "group_review_done", {
                        "group": group_label,
                        "passed": review_ok,
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    })
                    if not review_ok and _unrestricted_dev_mode(task):
                        append_event(task, "review_advisory_finished", {
                            "phase": group_label,
                            "blocking": False,
                            "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                        }, source="reviewer")
                    elif not review_ok:
                        await h_fail("phase_review_failed", f"{group_label} code review failed", "high", {
                            "group": group_label,
                            "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                        })
                        self._persist_task(task_id)
                        return

                task["current_subtask_id"] = None
                log("success", f"计划驱动执行完成: {completed_count}/{total_subtasks} 个子任务", "orchestrator")

                # ── 子任务执行完成后，直接进入构建阶段 ──
                # （计划执行模式不需要再次调用 Agent）

            elif len(exec_agents) == 1:
                # ── 无规划，单 Agent 模式 ──
                changed = await self._run_single_agent(
                    task_id, description, project_type,
                    workspace_id, exec_agents[0], ws_path, log, research_report,
                )
                if _agent_needs_auto_continuation(task):
                    task["current_step"] = "达到单段迭代上限，正在自动压缩上下文并续跑..."
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                if not changed:
                    raise RuntimeError("Agent produced no file changes; refusing to continue to review/build.")
            else:
                # ── 无规划，并行 Agent 模式 ──
                log("info", f"并行启动 {len(exec_agents)} 个 Agent", "orchestrator")
                task_obj = _tasks.get(task_id)
                if task_obj:
                    task_obj["agent_progress"] = {a: 0 for a in exec_agents}
                    task_obj["agent_active"] = {a: True for a in exec_agents}

                agent_results = await asyncio.gather(
                    *[
                        self._run_single_agent(
                            task_id, description, project_type,
                            workspace_id, agent_type, ws_path, log, research_report,
                        )
                        for agent_type in exec_agents
                    ],
                    return_exceptions=True,
                )

                for result in agent_results:
                    if isinstance(result, AgentWaitingForUserInput):
                        raise result
                    if isinstance(result, Exception):
                        raise RuntimeError(f"Agent execution failed: {result}") from result
                if _agent_needs_auto_continuation(task):
                    task["current_step"] = "达到单段迭代上限，正在自动压缩上下文并续跑..."
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                if not any(bool(result) for result in agent_results):
                    raise RuntimeError("Agents produced no file changes; refusing to continue to review/build.")

                for agent_type in exec_agents:
                    log("info", f"[{agent_type}] Agent 执行完毕", "orchestrator")

            # 7. Execute only the stages selected by the universal ExecutionPlan.
            execution_plan = task.get("active_execution_plan") or {}
            capability_profile = task.get("task_capability_profile") or build_task_capability_profile(
                task,
                ws_path,
                execution_plan,
                available_tools=[spec.name for spec in tool_registry.list()],
            )
            task["task_capability_profile"] = capability_profile
            stage_policy = capability_profile.get("stage_policy") or {}
            artifact_source = str(capability_profile.get("artifact_source") or "workspace")
            changed_files = _collect_completion_changed_files(task)
            requires_validation = bool(stage_policy.get("requires_validation"))
            requires_preview = bool(stage_policy.get("requires_preview"))
            requires_review = bool(stage_policy.get("requires_review"))

            install_command, install_reason = _planned_command(
                execution_plan, {"install", "dependency", "dependencies", "dependency_install"}
            )
            if install_command and artifact_source != "local_connector":
                task["progress"] = 80
                task["current_step"] = "安装执行计划声明的依赖"
                self._persist_task(task_id)
                self._push_phase_progress(task_id, "install", f"正在执行依赖步骤：{install_reason}")
                install_result = await docker_manager.execute_in_workspace(
                    workspace_id, f"{install_command} 2>&1 || echo '__AUTOCODE_INSTALL_FAILED__'"
                )
                install_output = install_result.get("stdout", "") or ""
                if "__AUTOCODE_INSTALL_FAILED__" in install_output:
                    task["status"] = "failed"
                    task["error_detail"] = f"依赖步骤失败：{install_command}\n\n{install_output[-1500:]}"
                    task["needs_continuation"] = True
                    append_event(task, "task_stop_guard_triggered", {
                        "reason": "planned_dependency_step_failed", "command": install_command,
                    }, source="orchestrator")
                    self._persist_task(task_id)
                    return
                self._push_phase_progress(task_id, "install_done", "依赖步骤已完成")

            validation_command, validation_reason = _select_validation_command(
                ws_path, project_type, execution_plan, changed_files
            )
            validation_ok = True
            validation_output = ""
            if requires_validation and validation_command and artifact_source != "local_connector":
                task["progress"] = 85
                task["current_step"] = "验证任务产物"
                self._push_phase_progress(
                    task_id, "validation", f"正在验证任务产物：{validation_command}"
                )
                max_validation_attempts = 3 if str(execution_plan.get("intent") or "") in {"code_development", "pipeline"} else 1
                validation_ok = False
                for validation_attempt in range(max_validation_attempts):
                    log(
                        "info",
                        f"执行验证（{validation_attempt + 1}/{max_validation_attempts}）：{validation_command}",
                        "devops",
                    )
                    validation_result = await docker_manager.execute_in_workspace(
                        workspace_id, f"{validation_command} 2>&1 || echo '__AUTOCODE_VALIDATION_FAILED__'"
                    )
                    validation_output = validation_result.get("stdout", "") or ""
                    if "__AUTOCODE_VALIDATION_FAILED__" not in validation_output:
                        validation_ok = True
                        log("success", "验证通过", "devops", validation_output[-500:])
                        break
                    if validation_attempt >= max_validation_attempts - 1:
                        break
                    repair_prompt = "\n".join([
                        "## 验证失败自动修复",
                        f"验证命令 {validation_command} 未通过。",
                        "根据真实错误输出定位并最小化修复相关文件，然后重新运行同一条验证命令。",
                        "如果缺少外部能力或环境，请明确报告 capability_unavailable，不要改用无关工具。",
                        "",
                        validation_output[-4000:],
                    ])
                    await self._run_agentic_loop(
                        task_id=task_id,
                        description=repair_prompt,
                        project_type=project_type,
                        workspace_id=workspace_id,
                        agent_type=agent_types[0] if agent_types else "general",
                        ws_path=ws_path,
                        log=log,
                        research_report=research_report,
                        task_plan=task_plan,
                    )
                task["validation_result"] = {
                    "status": "passed" if validation_ok else "failed",
                    "command": validation_command,
                    "reason": validation_reason,
                    "output": validation_output[-2000:],
                }
                if not validation_ok:
                    self._update_workspace_memory(
                        ws_path, task_id, status="needs_fix", phase="产物验证失败",
                        issues=[f"{validation_command} 失败: {validation_output[-500:]}"],
                    )
                    task["status"] = "failed"
                    task["error_detail"] = f"产物验证失败：{validation_command}\n\n{validation_output[-1500:]}"
                    task["needs_continuation"] = True
                    append_event(task, "task_stop_guard_triggered", {
                        "reason": "validation_failed", "command": validation_command,
                    }, source="orchestrator")
                    self._persist_task(task_id)
                    return
            elif requires_validation:
                reason = (
                    "本地产物由 Local Connector 验证"
                    if artifact_source == "local_connector"
                    else validation_reason
                )
                task["validation_result"] = {
                    "status": "artifact_review_pending", "command": None, "reason": reason,
                }
                self._push_phase_progress(task_id, "validation_deferred", f"命令验证不适用：{reason}")

            task["preview_url"] = None
            if requires_preview:
                task["progress"] = 92
                task["current_step"] = "准备执行计划要求的预览"
                self._push_phase_progress(task_id, "preview", "正在准备产物预览...")
                has_static_out = (ws_path / "out" / "index.html").exists()
                has_static_dist = (ws_path / "dist" / "index.html").exists()
                has_root_html = (ws_path / "index.html").exists()
                if has_static_out or has_static_dist or has_root_html:
                    task["preview_url"] = f"/workspaces/{workspace_id}/preview"
                    log("success", f"静态产物预览：{task['preview_url']}", "orchestrator")
                elif (ws_path / "package.json").exists():
                    preview_info = await dev_server_manager.start_dev_server(
                        workspace_id, str(ws_path), project_type or "unknown"
                    )
                    if preview_info and preview_info.get("url"):
                        task["preview_url"] = f"/api/proxy/{workspace_id}/"
                        task["dev_server_port"] = preview_info["port"]
                        task["dev_server_internal_url"] = preview_info["url"]
                        log("success", f"预览服务已启动：{preview_info['url']}", "orchestrator")
                    else:
                        log("warn", "执行计划要求预览，但预览服务未能启动", "orchestrator")
                else:
                    log("info", "执行计划要求格式或渲染验证，但当前没有页面预览入口", "orchestrator")
                    self._push_phase_progress(task_id, "preview_unavailable", "未发现可启动的页面预览入口")

            task["progress"] = 100
            review_passed = True
            if requires_review:
                log("success", "执行阶段完成，开始按产物合同审查...", "orchestrator")
                task["status"] = "reviewing"
                self._persist_task(task_id)
                self._push_phase_progress(task_id, "reviewing", "正在执行通用产物审查...")
                try:
                    review_llm = None
                    try:
                        review_llm = await self._ensure_client(requested_model=task.get("model"))
                    except Exception:
                        pass
                    reviewer = ReviewAgent(llm_client=review_llm)
                    review_result = await reviewer.run(
                        ws_path=ws_path,
                        task_id=task_id,
                        task_title=task.get("title", ""),
                        project_type=task.get("project_type", "unknown"),
                        log=log,
                        execution_plan=execution_plan,
                        capability_profile=capability_profile,
                        changed_files=changed_files,
                        artifact_sources=task.get("artifact_sources") or {},
                    )
                    task["review"] = review_result.to_dict()
                    review_passed = review_result.passed
                    append_event(task, "artifact_verified", {
                        "passed": review_passed,
                        "score": review_result.score,
                        "task_family": execution_plan.get("task_family"),
                        "artifact_contracts": execution_plan.get("artifact_contracts") or [],
                        "dimensions": review_result.dimensions,
                    }, source="reviewer")
                except Exception as exc:
                    logger.warning(f"[{task_id}] 产物审查异常：{exc}")
                    task["review"] = {
                        "passed": False,
                        "score": 0,
                        "summary": f"产物审查异常：{exc}",
                        "issues": [{
                            "level": "error", "rule": "review/exception", "file": ".", "message": str(exc),
                        }],
                        "dimensions": {},
                    }
                    review_passed = False
            else:
                task["review"] = {
                    "passed": True,
                    "score": 100,
                    "summary": "执行计划未要求产物审查。",
                    "issues": [],
                    "dimensions": {"status": "not_required"},
                }
                append_event(task, "artifact_verified", {
                    "passed": True, "status": "not_required", "task_family": execution_plan.get("task_family"),
                }, source="orchestrator")

            if not review_passed and _unrestricted_dev_mode(task):
                append_event(task, "review_advisory_finished", {
                    "passed": False,
                    "score": (task.get("review") or {}).get("score"),
                    "issues": len((task.get("review") or {}).get("issues") or []),
                    "blocking": False,
                }, source="reviewer")
                log("warn", "产物审查未通过，但极速开发模式下作为 advisory 记录，不阻塞完成", "orchestrator")
                review_passed = True

            if review_passed and _requires_real_change_for_completion(task, execution_plan, description):
                meaningful_changed_files = _meaningful_completion_changed_files(task)
                if not meaningful_changed_files:
                    task["status"] = "failed"
                    task["current_step"] = "代码开发任务没有产生真实文件变更，拒绝标记完成"
                    task["needs_continuation"] = True
                    task["agent_iteration_limited"] = True
                    task["agent_iteration_limit_reason"] = "development_no_meaningful_changes"
                    task["review"] = {
                        "passed": False,
                        "score": 0,
                        "summary": "代码开发任务没有产生真实业务/源码变更，不能完成。",
                        "issues": [{
                            "level": "error",
                            "rule": "completion/no-meaningful-changes",
                            "file": ".",
                            "message": "Code-development requests must modify at least one non-AutoCode artifact before completion.",
                        }],
                        "dimensions": {
                            "completion_gate": {
                                "status": "fail",
                                "changed_files": _collect_completion_changed_files(task)[:100],
                            },
                        },
                    }
                    append_event(task, "completion_gate_failed", {
                        "reason": "development_no_meaningful_changes",
                        "changed_files": _collect_completion_changed_files(task)[:100],
                        "execution_intent": execution_plan.get("intent"),
                    }, source="orchestrator")
                    log("error", "代码开发任务没有产生真实文件变更，拒绝标记完成", "orchestrator")
                    await h_fail("completion_no_meaningful_changes", task["current_step"], "high", {
                        "review": task.get("review"),
                        "execution_plan": execution_plan,
                    })
                    self._persist_task(task_id)
                    self.cleanup_chat_queue(task_id)
                    return

            # ── 确认门控：审查不通过 → 等待用户确认 ──
            if not review_passed:
                review_score = task["review"].get("score", 0)
                review_summary = task["review"].get("summary", "")
                issue_count = len(task["review"].get("issues", []))

                task["review_confirmed"] = None  # 等待用户确认
                task["status"] = "waiting_review_confirm"
                task["current_step"] = f"产物审查未通过（{review_score} 分 / {issue_count} 个问题），等待您确认..."
                self._persist_task(task_id)

                log("warn", f"产物审查未通过（{review_score} 分 / {issue_count} 个问题），等待用户确认", "orchestrator")
                compacted_this_iteration = True
                self._push_phase_progress(
                    task_id, "review_failed",
                    f"产物审查未通过 - 得分 {review_score}，{issue_count} 个问题"
                )

                # 轮询等待用户确认（参照 _generate_and_confirm_prototype 模式）
                max_wait_seconds = 3600  # 最多等待 1 小时
                wait_interval = 2        # 每 2 秒检查一次
                waited = 0

                while waited < max_wait_seconds:
                    await asyncio.sleep(wait_interval)
                    waited += wait_interval

                    # 检查任务是否被取消
                    t_check = _tasks.get(task_id)
                    if not t_check or t_check.get("status") == "cancelled":
                        log("info", "用户取消任务，退出审查等待", "orchestrator")
                        self.cleanup_chat_queue(task_id)
                        self._persist_task(task_id)
                        return

                    # 检查用户是否已确认/拒绝
                    confirmed = t_check.get("review_confirmed")
                    if confirmed is not None:
                        if confirmed:
                            # 用户确认：审查不通过但仍继续完成
                            task["status"] = "completed"
                            task["current_step"] = "用户已确认审查结果，任务完成"
                            log("success", "用户确认审查结果，任务完成", "orchestrator")
                        else:
                            # 用户拒绝：认为代码不合格，任务失败
                            task["status"] = "failed"
                            task["current_step"] = "用户拒绝了审查结果，任务标记为失败"
                            log("warn", "用户拒绝审查结果，任务失败", "orchestrator")
                        self._persist_task(task_id)
                        break
                else:
                    # 超时未确认：根据得分决定
                    if review_score >= 50:
                        log("warn", f"审查确认超时（得分 {review_score} >= 50），自动完成", "orchestrator")
                        task["status"] = "completed"
                        task["current_step"] = "审查确认超时，自动完成"
                    else:
                        log("warn", f"审查确认超时（得分 {review_score} < 50），标记失败", "orchestrator")
                        task["status"] = "failed"
                        task["current_step"] = "审查确认超时且得分过低，标记失败"
                    self._persist_task(task_id)

                # 如果用户拒绝了（task["status"] == "failed"），跳过后续完成逻辑
                if task.get("status") == "failed":
                    await h_fail("review_rejected", task.get("current_step", "Review rejected"), "high", {
                        "review": task.get("review"),
                    })
                    self.cleanup_chat_queue(task_id)
                    self._persist_task(task_id)
                    return
            else:
                # 审查通过，直接完成
                task["status"] = "completed"
                log("success", "任务全部完成", "orchestrator")

            # 更新记忆文件：标记完成
            agent_iter = task.get("agent_iteration", 60)
            self._update_workspace_memory(
                ws_path, task_id, status="completed",
                phase="任务完成",
                completed_items=["需求理解", "执行计划", "产物生成", "计划内验证", "产物审查"],
                decisions=[f"共执行 {agent_iter} 轮迭代"],
                iteration=agent_iter,
            )
            self._persist_task(task_id)

            git_manager.auto_commit(ws_path, ["."], f"完成: {task['title']}")
            task["commit_history"] = git_manager.log(ws_path, max_count=10)
            append_event(task, "self_check_started", {
                "changed_files": _collect_completion_changed_files(task)[:100],
                "review_score": (task.get("review") or {}).get("score"),
            }, source="orchestrator")
            completion_report = _build_completion_report(task, ws_path)
            task["completion_report"] = completion_report
            append_event(task, "self_check_completed", completion_report, source="orchestrator")
            append_event(task, "completion_report_generated", completion_report, source="orchestrator")
            completion_summary = _build_completion_summary(task, ws_path)
            task["completion_summary"] = completion_summary
            if _execution_mode(task) == "agentic":
                prior_agentic_finish = task.get("agentic_finish") if isinstance(task.get("agentic_finish"), dict) else {}
                _set_agentic_finish(
                    task,
                    status="completed",
                    reason="task_completed",
                    changed_files=prior_agentic_finish.get("changed_files") or [],
                    validated=True if task.get("ci_status") == "passed" else None,
                    review_passed=bool((task.get("review") or {}).get("passed", True)),
                    message="Task completed after Agentic Loop execution and final guardrails.",
                )
            self._push_agent_response(task_id, completion_summary)
            await h_complete("AutoCode task completed", {
                "status": task.get("status"),
                "progress": task.get("progress"),
                "commit_count": len(task.get("commit_history") or []),
                "phase_review_count": len(task.get("phase_reviews") or []),
                "preview_url": task.get("preview_url"),
            }, {
                "completed": task.get("status") == "completed",
                "final_review_passed": bool((task.get("review") or {}).get("passed", True)),
            })

            # 清理对话队列（任务结束后不再需要）
            self.cleanup_chat_queue(task_id)

        except AgentWaitingForUserInput:
            task = _tasks.get(task_id) or task
            task["status"] = "waiting_user_input"
            task["execution_active"] = False
            task["needs_continuation"] = False
            log("info", "任务已暂停，等待用户选择或补充信息", "agent_blocker")
            self._persist_task(task_id)
            return
        except asyncio.CancelledError:
            if task.get("cancel_requested"):
                task["status"] = "cancelled"
                task["execution_active"] = False
                log("warn", "任务已由用户取消", "orchestrator")
                await h_fail("cancelled", "Task was cancelled by user", "medium", {
                    "workspace_id": workspace_id,
                    "current_step": task.get("current_step"),
                })
            else:
                task["status"] = "pending"
                task["execution_active"] = False
                task["current_step"] = "后端服务重启或执行被中断，任务已保存并等待续跑"
                log("warn", "后端服务重启或执行被中断，任务已保存并等待续跑", "orchestrator")
                await h_fail("interrupted", "Task execution was interrupted by backend shutdown", "medium", {
                    "workspace_id": workspace_id,
                    "current_step": task.get("current_step"),
                })
            self.cleanup_chat_queue(task_id)
            self._persist_task(task_id)
            raise
        except Exception as e:
            task["status"] = "failed"
            log("error", f"任务异常: {e}", "orchestrator", str(e))
            await h_fail("runtime_error", str(e), "high", {
                "workspace_id": workspace_id,
                "current_step": task.get("current_step"),
            })
            self.cleanup_chat_queue(task_id)
            self._persist_task(task_id)
        finally:
            _usage_context.reset(usage_token)
            try:
                await self._cancel_background_subagents(task_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"[spawn_subagent] background cleanup skipped for {task_id}: {exc}")
            self._active_tasks[task_id] = False
            current_task = _tasks.get(task_id)
            if current_task:
                current_task["execution_active"] = False
                self._persist_task(task_id)
            # Tear down any language servers spawned for this workspace so we do
            # not leak subprocesses across tasks. Best-effort; never raises.
            try:
                from runtime.lsp.lsp_manager import lsp_registry
                await lsp_registry.shutdown(workspace_id)
            except Exception as exc:  # noqa: BLE001
                logger.debug(f"[LSP] shutdown skipped for {workspace_id}: {exc}")

    def _format_research_report(self, report: dict) -> str:
        """Format a technology research report as Markdown."""
        tech_stack = report.get("tech_stack", {}) if isinstance(report.get("tech_stack"), dict) else {}
        lines = [
            "# 技术调研报告",
            "",
            "**技术栈推荐**:",
            f"- 前端: {tech_stack.get('frontend', 'N/A')}",
            f"- 后端: {tech_stack.get('backend', 'N/A')}",
            f"- 数据库: {tech_stack.get('database', 'N/A')}",
            f"- 部署: {tech_stack.get('deploy', 'N/A')}",
            "",
            "**推荐库**:",
        ]
        for lib in report.get("key_libraries", []):
            lines.append(f"- {lib}")
        lines.extend(["", "**最佳实践**:"])
        for bp in report.get("best_practices", []):
            lines.append(f"- {bp}")
        lines.extend(["", "**常见风险**:"])
        for p in report.get("pitfalls", []):
            lines.append(f"- {p}")
        lines.extend(["", "**参考项目**:"])
        for ref in report.get("reference_projects", []):
            lines.append(f"- [{ref.get('name', '')}]({ref.get('url', '')}) - {ref.get('why', '')}")
        lines.extend(["", f"**置信度**: {report.get('confidence', '?')}"])
        return "\n".join(lines)

    def _sync_plan_to_task(self, task_id: str, task_plan: TaskPlan | None):
        """Sync a TaskPlan object back to the task dict for SSE updates."""
        if not task_plan:
            return
        task = _tasks.get(task_id)
        if task:
            task["plan"] = task_plan.model_dump()

    def _ci_event_payload(self, report: dict) -> dict:
        failure = report.get("failure") if isinstance(report.get("failure"), dict) else {}
        return {
            "report": report,
            "phase": report.get("phase"),
            "status": report.get("status"),
            "command": report.get("command"),
            "exit_code": report.get("exit_code"),
            "changed_files": report.get("changed_files") or [],
            "failure": failure,
            "failure_summary": failure.get("summary") or "",
            "summary": failure.get("summary") or report.get("output") or "",
        }

    async def _run_phase_ci(
        self,
        task_id: str,
        task: dict,
        ws_path: Path,
        group_label: str,
        changed_files: list[str],
        log,
    ) -> dict:
        """Run the fastest available validation command and write CI_REPORT.md."""
        command = self._select_phase_ci_command(ws_path, task, changed_files)
        report = {
            "phase": group_label,
            "status": "skipped",
            "command": command,
            "exit_code": None,
            "output": "",
            "changed_files": changed_files[:100],
            "created_at": datetime.utcnow().isoformat(),
        }

        self._push_phase_progress(task_id, "phase_ci", f"{group_label}: running validation")
        append_event(
            task,
            "ci_started",
            {"phase": group_label, "command": command, "changed_files": changed_files[:100]},
            source="ci",
        )
        if not command:
            report["output"] = "No suitable validation command detected."
            self._write_ci_report(ws_path, report)
            task.setdefault("ci_runs", []).append(report)
            task["ci_runs"] = task["ci_runs"][-30:]
            append_event(task, "ci_finished", self._ci_event_payload(report), source="ci")
            return report
        if not _is_safe_phase_command(command):
            report.update({
                "status": "failed",
                "exit_code": 126,
                "output": f"Unsafe validation command rejected: {command}",
            })
            report["failure"] = _classify_ci_failure(command, report.get("exit_code"), report.get("output") or "")
            self._write_ci_report(ws_path, report)
            task.setdefault("ci_runs", []).append(report)
            task["ci_runs"] = task["ci_runs"][-30:]
            log("warn", f"{group_label} CI rejected unsafe command: {command}", "ci")
            append_event(task, "ci_finished", self._ci_event_payload(report), source="ci")
            self._persist_task(task_id)
            return report

        record = _append_command_record(
            task,
            command,
            "running",
            label=f"{group_label} CI 验证",
            source="phase_ci",
        )
        self._persist_task(task_id)

        try:
            result = await docker_manager.execute_in_workspace(
                task["workspace_id"],
                command,
                timeout=180,
                strict_symlink_scan=False,
            )
            if result.get("exit_code") in (126, 127) and command.startswith("python "):
                fallback_command = "python3 " + command[len("python "):]
                fallback_result = await docker_manager.execute_in_workspace(
                    task["workspace_id"],
                    fallback_command,
                    timeout=180,
                    strict_symlink_scan=False,
                )
                fallback_output = "\n".join([
                    fallback_result.get("stdout") or "",
                    fallback_result.get("stderr") or "",
                ]).strip()
                if fallback_result.get("exit_code") == 0 or fallback_output:
                    command = fallback_command
                    result = fallback_result
                    record["command"] = fallback_command
            output = "\n".join([result.get("stdout") or "", result.get("stderr") or ""]).strip()
            exit_code = result.get("exit_code", -1)
            output_meta = bound_tool_output(ws_path, output, tool_name="ci")
            preview_output = output_meta["preview"]
            model_output = output_meta["model_preview"]
            report.update({
                "status": "passed" if exit_code == 0 else "failed",
                "exit_code": exit_code,
                "output": preview_output,
                "output_truncated": output_meta["truncated"],
                "output_path": output_meta["full_path"],
                "output_sha256": output_meta["sha256"],
                "output_chars": output_meta["chars"],
                "output_lines": output_meta["lines"],
            })
            if report["status"] == "failed":
                report["failure"] = _classify_ci_failure(command, exit_code, output)
            record.update({
                "status": "success" if exit_code == 0 else "failed",
                "output": preview_output,
                "output_truncated": output_meta["truncated"],
                "output_path": output_meta["full_path"],
                "output_sha256": output_meta["sha256"],
                "output_chars": output_meta["chars"],
                "output_lines": output_meta["lines"],
                "exit_code": exit_code,
                "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            })
            level = "success" if exit_code == 0 else "warn"
            log(level, f"{group_label} CI {report['status']}: {command}", "ci", model_output[-1200:])
        except Exception as exc:
            report.update({
                "status": "failed",
                "exit_code": -1,
                "output": str(exc),
            })
            report["failure"] = _classify_ci_failure(command, report.get("exit_code"), report.get("output") or "")
            record.update({
                "status": "failed",
                "output": str(exc)[-12000:],
                "exit_code": -1,
                "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            })
            log("warn", f"{group_label} CI failed: {exc}", "ci")

        self._write_ci_report(ws_path, report)
        task.setdefault("ci_runs", []).append(report)
        task["ci_runs"] = task["ci_runs"][-30:]
        append_event(task, "ci_finished", self._ci_event_payload(report), source="ci")
        self._persist_task(task_id)
        return report

    def _select_phase_ci_command(self, ws_path: Path, task: dict, changed_files: list[str]) -> str:
        if (ws_path / "package.json").exists():
            for script in ("test", "build", "lint"):
                command = _package_script_command(ws_path, script)
                if command:
                    return command
        py_changed = [p for p in changed_files if p.endswith(".py")]
        if py_changed:
            safe_files = [
                p.replace("\\", "/")
                for p in py_changed[:30]
                if re.match(r"^[A-Za-z0-9_./-]+\.py$", p.replace("\\", "/"))
                and ".." not in p.replace("\\", "/").split("/")
            ]
            if safe_files:
                roots: list[str] = []
                for path in safe_files:
                    parts = path.split("/")
                    root = parts[0] if len(parts) > 1 else path
                    if root and root not in roots:
                        roots.append(root)
                root_args = " ".join(roots[:8])
                if root_args:
                    return "python -m compileall " + root_args
                return "python -m py_compile " + " ".join(safe_files)
        if (ws_path / "pom.xml").exists():
            return "mvn test"
        if (ws_path / "go.mod").exists():
            return "go test ./..."
        return ""

    def _write_ci_report(self, ws_path: Path, report: dict):
        autocode = ws_path / ".autocode"
        autocode.mkdir(parents=True, exist_ok=True)
        failure = report.get("failure") or {}
        lines = [
            "# CI Report",
            "",
            f"- Phase: {report.get('phase')}",
            f"- Status: {report.get('status')}",
            f"- Command: `{report.get('command') or '(none)'}`",
            f"- Exit code: {report.get('exit_code')}",
            f"- Time: {report.get('created_at')}",
            f"- Failure category: `{failure.get('category') or '-'}`",
            f"- Failure severity: `{failure.get('severity') or '-'}`",
            f"- Failure summary: {failure.get('summary') or '-'}",
            f"- Suggested action: {failure.get('suggestion') or '-'}",
            "",
            "## Changed Files",
            "",
            *[f"- `{path}`" for path in (report.get("changed_files") or [])[:100]],
            "",
            "## Output",
            "",
            "```text",
            str(report.get("output") or "")[:8000],
            "```",
            "",
        ]
        (autocode / "CI_REPORT.md").write_text("\n".join(lines), encoding="utf-8")

    async def _attempt_ci_repair(
        self,
        task_id: str,
        task: dict,
        ws_path: Path,
        log,
        group_label: str,
        group_subtasks: list[SubTask],
        changed_files: list[str],
        ci_report: dict,
        max_attempts: int = 2,
    ) -> dict:
        """Try to fix phase CI failures before failing the review gate."""
        repair_records: list[dict] = []
        current_ci = ci_report
        current_changed = list(dict.fromkeys(changed_files or []))
        primary_agent = next((st.agent_type for st in group_subtasks if st.agent_type), "backend")
        task["status"] = "running"
        initial_failure = current_ci.get("failure") or _classify_ci_failure(
            current_ci.get("command") or "",
            current_ci.get("exit_code"),
            current_ci.get("output") or "",
        )
        if initial_failure.get("severity") in {"system", "environment"}:
            append_event(
                task,
                "ci_repair_skipped",
                {
                    "phase": group_label,
                    "reason": "non_code_failure",
                    "failure": initial_failure,
                    "command": current_ci.get("command"),
                    "exit_code": current_ci.get("exit_code"),
                },
                source="ci",
            )
            return {
                "repaired": False,
                "attempts": 0,
                "records": [],
                "changed_files": current_changed,
                "ci_report": current_ci,
                "summary": initial_failure.get("summary") or "CI 失败原因不是代码修改可直接修复的问题。",
                "skipped": True,
                "failure": initial_failure,
            }

        for attempt in range(1, max_attempts + 1):
            output = (current_ci.get("output") or "").strip()
            command = current_ci.get("command") or ""
            failure = current_ci.get("failure") or _classify_ci_failure(command, current_ci.get("exit_code"), output)
            append_event(
                task,
                "ci_repair_started",
                {
                    "phase": group_label,
                    "attempt": attempt,
                    "max_attempts": max_attempts,
                    "command": command,
                    "output": bound_tool_output(ws_path, output, tool_name="ci_repair")["preview"],
                    "failure": failure,
                },
                source="ci",
            )
            log("warn", f"{group_label} CI 未通过，开始第 {attempt}/{max_attempts} 次自动修复", "ci", output[-1200:])
            task["current_step"] = f"{group_label} CI 自动修复 {attempt}/{max_attempts}"
            task.setdefault("logs", []).append({
                "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                "agent": "ci",
                "level": "warn",
                "message": f"{group_label} CI 未通过，正在自动修复（{attempt}/{max_attempts}）",
                "detail": (output or command)[-2000:],
            })
            self._persist_task(task_id)

            changed_text = "\n".join(f"- {p}" for p in current_changed[:80]) or "- 暂无明确文件，请先读取 .autocode/CI_REPORT.md"
            repair_prompt = "\n".join([
                "## CI 自动修复任务",
                "",
                f"当前阶段：{group_label}",
                f"负责角色：{primary_agent}",
                "",
                "CI 命令：",
                "```bash",
                command,
                "```",
                "",
                "CI 输出：",
                "```text",
                output[-5000:] if output else "（无输出，可能被执行安全层拒绝或命令环境异常）",
                "```",
                "",
                f"失败分类：{failure.get('category')}",
                f"严重性：{failure.get('severity')}",
                f"摘要：{failure.get('summary')}",
                f"建议：{failure.get('suggestion')}",
                "",
                "相关文件：",
                changed_text,
                "",
                "请只修复导致 CI/验证失败的最小问题，修复后让后续 CI 重新验证。",
            ])
            before = _workspace_file_snapshot(ws_path)
            try:
                await self._run_single_agent(
                    task_id=task_id,
                    description=repair_prompt,
                    project_type=task.get("project_type") or "unknown",
                    workspace_id=task["workspace_id"],
                    agent_type=primary_agent,
                    ws_path=ws_path,
                    log=log,
                    research_report=None,
                )
            except Exception as exc:
                repair_records.append({
                    "attempt": attempt,
                    "status": "agent_error",
                    "error": str(exc),
                })
                log("warn", f"{group_label} CI 自动修复 Agent 异常: {exc}", "ci")

            changed_now = _snapshot_changed(before, _workspace_file_snapshot(ws_path))
            for path in changed_now:
                if path not in current_changed:
                    current_changed.append(path)

            current_ci = await self._run_phase_ci(
                task_id, task, ws_path, f"{group_label} 修复验证 {attempt}", current_changed, log
            )
            repair_records.append({
                "attempt": attempt,
                "status": current_ci.get("status"),
                "changed_files": changed_now[:100],
                "command": current_ci.get("command"),
                "exit_code": current_ci.get("exit_code"),
            })
            append_event(
                task,
                "ci_repair_finished",
                {
                    "phase": group_label,
                    "attempt": attempt,
                    "status": current_ci.get("status"),
                    "changed_files": changed_now[:100],
                    "command": current_ci.get("command"),
                    "exit_code": current_ci.get("exit_code"),
                },
                source="ci",
            )
            if current_ci.get("status") != "failed":
                return {
                    "repaired": True,
                    "attempts": attempt,
                    "records": repair_records,
                    "changed_files": current_changed,
                    "ci_report": current_ci,
                    "summary": f"第 {attempt} 次自动修复后 CI 通过。",
                }

        append_event(
            task,
            "ci_repair_exhausted",
            {
                "phase": group_label,
                "attempts": max_attempts,
                "records": repair_records,
                "last_status": current_ci.get("status"),
                "last_command": current_ci.get("command"),
                "last_exit_code": current_ci.get("exit_code"),
            },
            source="ci",
        )
        return {
            "repaired": False,
            "attempts": max_attempts,
            "records": repair_records,
            "changed_files": current_changed,
            "ci_report": current_ci,
            "summary": "已尝试自动修复，但 CI/验证仍未通过。",
        }

    async def _review_execution_group(
        self,
        task_id: str,
        task: dict,
        ws_path: Path,
        log,
        group_label: str,
        group_subtasks: list[SubTask],
        changed_files: list[str] | None = None,
        guardrail_kind: str = "phase",
    ) -> bool:
        """Run a scoped guardrail review after an execution segment."""
        is_agentic_guardrail = guardrail_kind == "agentic"
        review_event_payload = {
            "guardrail_kind": guardrail_kind,
            "label": group_label,
            "changed_count": len(changed_files or []),
            "changed_files": (changed_files or [])[:100],
        }
        append_event(
            task,
            "guardrail_review_started" if is_agentic_guardrail else "phase_review_started",
            review_event_payload,
            source="reviewer",
        )
        task["status"] = "reviewing"
        task["current_step"] = f"{group_label} guardrail review" if is_agentic_guardrail else f"{group_label} artifact review"
        task.setdefault("phase_reviews", [])
        self._persist_task(task_id)
        progress_type = "guardrail_review" if is_agentic_guardrail else "phase_review"
        progress_message = f"{group_label}: guardrail review" if is_agentic_guardrail else f"{group_label}: artifact review"
        self._push_phase_progress(task_id, progress_type, progress_message)

        try:
            changed_files = changed_files or []
            if not changed_files:
                existing_artifacts = _phase_expected_artifacts(ws_path, group_subtasks)
                if existing_artifacts and _is_documentation_phase(group_subtasks, existing_artifacts):
                    changed_files = existing_artifacts
                    log(
                        "warn",
                        f"{group_label} 本轮没有新 diff，但检测到已有阶段产物，改为审查产物: {', '.join(existing_artifacts[:10])}",
                        "reviewer",
                    )
            if not changed_files:
                review_dict = {
                    "phase": group_label,
                    "guardrail_kind": guardrail_kind,
                    "passed": False,
                    "score": 0,
                    "summary": "阶段没有产生任何目标产物或可验证文件变更，拒绝通过产物审查。",
                    "issues": [{
                        "level": "error",
                        "rule": "review/no-phase-changes",
                        "file": ".",
                        "message": "该执行组没有产生工作区文件变更，也没有找到可复用的阶段产物，不能通过审查。",
                    }],
                    "dimensions": {
                        "guardrail": {
                            "kind": guardrail_kind,
                            "agentic": is_agentic_guardrail,
                        },
                        "phase_artifacts": {
                            "changed_count": 0,
                            "changed_files": [],
                        },
                    },
                    "subtasks": [
                        {"id": st.id, "title": st.title, "agent_type": st.agent_type}
                        for st in group_subtasks
                    ],
                    "reviewed_at": datetime.utcnow().isoformat(),
                }
                task.setdefault("phase_reviews", []).append(review_dict)
                task["review"] = review_dict
                task["status"] = "failed"
                task["current_step"] = f"{group_label} 审查失败：没有文件变更"
                log("error", f"{group_label} 审查失败：没有文件变更", "reviewer")
                append_event(
                    task,
                    "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                    {
                        **review_event_payload,
                        "passed": False,
                        "score": 0,
                        "reason": "no_changes",
                    },
                    source="reviewer",
                )
                return False

            ci_report = await self._run_phase_ci(task_id, task, ws_path, group_label, changed_files, log)
            if ci_report.get("status") == "failed":
                repair_result = await self._attempt_ci_repair(
                    task_id, task, ws_path, log, group_label, group_subtasks, changed_files, ci_report,
                )
                if repair_result.get("repaired"):
                    changed_files = repair_result.get("changed_files") or changed_files
                    ci_report = repair_result.get("ci_report") or ci_report
                if ci_report.get("status") != "failed":
                    log("success", f"{group_label} CI 修复后通过", "ci")
                else:
                    repair_attempts = repair_result.get("attempts", 0)
                    repair_summary = repair_result.get("summary") or "自动修复未能通过 CI。"
                    ci_output = (ci_report.get("output") or "").strip()
                    ci_message = f"Validation command failed after {repair_attempts} repair attempt(s): {ci_report.get('command')}"
                    if repair_summary:
                        ci_message += "\n\n" + repair_summary
                    if ci_output:
                        ci_message += "\n\n" + ci_output[-2000:]
                    review_dict = {
                        "phase": group_label,
                        "guardrail_kind": guardrail_kind,
                        "passed": False,
                        "score": 20,
                        "summary": "阶段 CI/验证未通过，自动修复后仍未通过，暂停等待人工确认或继续修复。",
                        "issues": [{
                            "level": "error",
                            "rule": "ci/failed",
                            "file": ".autocode/CI_REPORT.md",
                            "message": ci_message,
                        }],
                        "dimensions": {
                            "guardrail": {
                                "kind": guardrail_kind,
                                "agentic": is_agentic_guardrail,
                            },
                            "phase_artifacts": {
                                "changed_count": len(changed_files),
                                "changed_files": changed_files[:100],
                            },
                            "ci": ci_report,
                            "ci_repair": repair_result,
                        },
                        "subtasks": [
                            {"id": st.id, "title": st.title, "agent_type": st.agent_type}
                            for st in group_subtasks
                        ],
                        "reviewed_at": datetime.utcnow().isoformat(),
                    }
                    task.setdefault("phase_reviews", []).append(review_dict)
                    task["review"] = review_dict
                    task["status"] = "failed"
                    task["current_step"] = f"{group_label} CI 修复后仍失败"
                    log("error", f"{group_label} CI 修复后仍失败: {ci_report.get('command')}", "ci")
                    append_event(
                        task,
                        "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                        {
                            **review_event_payload,
                            "passed": False,
                            "score": 20,
                            "reason": "ci_failed_after_repair",
                            "ci_status": ci_report.get("status"),
                        },
                        source="reviewer",
                    )
                    return False

            if ci_report.get("status") == "failed":
                ci_output = (ci_report.get("output") or "").strip()
                ci_message = f"Validation command failed: {ci_report.get('command')}"
                if ci_output:
                    ci_message += "\n\n" + ci_output[-2000:]
                review_dict = {
                    "phase": group_label,
                    "guardrail_kind": guardrail_kind,
                    "passed": False,
                    "score": 20,
                    "summary": "阶段 CI/验证未通过，拒绝进入产物审查通过状态。",
                    "issues": [{
                        "level": "error",
                        "rule": "ci/failed",
                        "file": ".autocode/CI_REPORT.md",
                        "message": ci_message,
                    }],
                    "dimensions": {
                        "guardrail": {
                            "kind": guardrail_kind,
                            "agentic": is_agentic_guardrail,
                        },
                        "phase_artifacts": {
                            "changed_count": len(changed_files),
                            "changed_files": changed_files[:100],
                        },
                        "ci": ci_report,
                    },
                    "subtasks": [
                        {"id": st.id, "title": st.title, "agent_type": st.agent_type}
                        for st in group_subtasks
                    ],
                    "reviewed_at": datetime.utcnow().isoformat(),
                }
                task.setdefault("phase_reviews", []).append(review_dict)
                task["review"] = review_dict
                task["status"] = "failed"
                task["current_step"] = f"{group_label} CI failed"
                log("error", f"{group_label} CI failed: {ci_report.get('command')}", "ci")
                append_event(
                    task,
                    "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                    {
                        **review_event_payload,
                        "passed": False,
                        "score": 20,
                        "reason": "ci_failed",
                        "ci_status": ci_report.get("status"),
                    },
                    source="reviewer",
                )
                return False

            review_llm = None
            try:
                review_llm = await self._ensure_client(requested_model=task.get("model"))
            except Exception:
                pass
            reviewer = ReviewAgent(llm_client=review_llm)
            active_plan = task.get("active_execution_plan") or {}
            changed_names = {
                str(path).replace("\\", "/").lower().rsplit("/", 1)[-1]
                for path in changed_files
            }
            phase_contracts = [
                contract for contract in (active_plan.get("artifact_contracts") or [])
                if str(contract.get("path") or "").replace("\\", "/").lower().rsplit("/", 1)[-1] in changed_names
            ]
            phase_plan = {**active_plan, "artifact_contracts": phase_contracts}
            with usage_agent("reviewer"):
                review_result = await reviewer.run(
                    ws_path=ws_path,
                    task_id=task_id,
                    task_title=f"{task.get('title', '')} - {group_label}",
                    project_type=task.get("project_type", "unknown"),
                    log=log,
                    execution_plan=phase_plan,
                    capability_profile=task.get("task_capability_profile") or {},
                    changed_files=changed_files,
                    artifact_sources=task.get("artifact_sources") or {},
                )
            review_dict = review_result.to_dict()
            review_dict["phase"] = group_label
            review_dict["guardrail_kind"] = guardrail_kind
            review_dict["subtasks"] = [
                {"id": st.id, "title": st.title, "agent_type": st.agent_type}
                for st in group_subtasks
            ]
            review_dict.setdefault("dimensions", {})
            review_dict["dimensions"]["guardrail"] = {
                "kind": guardrail_kind,
                "agentic": is_agentic_guardrail,
            }
            review_dict["dimensions"]["phase_artifacts"] = {
                "changed_count": len(changed_files),
                "changed_files": changed_files[:100],
            }
            review_dict["dimensions"]["ci"] = ci_report
            if _is_documentation_phase(group_subtasks, changed_files) and ci_report.get("status") == "skipped":
                review_dict["passed"] = True
                review_dict["score"] = min(int(review_dict.get("score") or 90), 90)
                review_dict["summary"] = (
                    "文档/契约阶段审查通过；本阶段未产生可执行代码，CI/运行时验证不适用。"
                )
                review_dict.setdefault("issues", [])
                review_dict["issues"].append({
                    "level": "info",
                    "rule": "ci/not-applicable",
                    "file": ".autocode/CI_REPORT.md",
                    "message": "本阶段仅包含文档或契约产物，未执行编译/测试；后续代码阶段仍需通过 CI。",
                })
            review_dict["reviewed_at"] = datetime.utcnow().isoformat()
            task.setdefault("phase_reviews", []).append(review_dict)

            issues = review_dict.get("issues") or []
            severe = [
                i for i in issues
                if i.get("level") == "error"
                or str(i.get("severity", "")).lower() in ("critical", "high")
            ]
            score = int(review_dict.get("score") or 0)
            if (not review_dict.get("passed", True)) and (score < 60 or severe):
                task["status"] = "failed"
                task["current_step"] = f"{group_label} review failed"
                task["review"] = review_dict
                log("error", f"{group_label} review failed: score={score}, severe={len(severe)}", "reviewer")
                append_event(
                    task,
                    "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                    {
                        **review_event_payload,
                        "passed": False,
                        "score": score,
                        "reason": "review_failed",
                        "severe_count": len(severe),
                    },
                    source="reviewer",
                )
                return False

            task["status"] = "running"
            task["current_step"] = f"{group_label} guardrail review passed" if is_agentic_guardrail else f"{group_label} review passed"
            log("success", f"{group_label} code review passed: score={score}", "reviewer")
            append_event(
                task,
                "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                {
                    **review_event_payload,
                    "passed": True,
                    "score": score,
                    "reason": "passed",
                    "ci_status": ci_report.get("status"),
                },
                source="reviewer",
            )
            return True
        except Exception as e:
            task["status"] = "failed"
            review_dict = {
                "phase": group_label,
                "guardrail_kind": guardrail_kind,
                "passed": False,
                "score": 0,
                "summary": f"Phase review failed with exception: {e}",
                "issues": [{
                    "level": "error",
                    "rule": "review/exception",
                    "file": ".",
                    "message": str(e),
                }],
                "reviewed_at": datetime.utcnow().isoformat(),
            }
            task.setdefault("phase_reviews", []).append(review_dict)
            task["review"] = review_dict
            task["current_step"] = f"{group_label} review failed"
            log("error", f"{group_label} code review failed with exception: {e}", "reviewer")
            append_event(
                task,
                "guardrail_review_finished" if is_agentic_guardrail else "phase_review_finished",
                {
                    **review_event_payload,
                    "passed": False,
                    "score": 0,
                    "reason": "exception",
                    "error": str(e),
                },
                source="reviewer",
            )
            return False
        finally:
            self._persist_task(task_id)

    @staticmethod
    def _is_usage_or_smoke_doc_phase(title: str, desc: str) -> bool:
        text = f"{title} {desc}".lower()
        return any(
            token in text
            for token in (
                "usage", "smoke", "readme", "document", "docs",
                "使用说明", "冒烟测试", "说明", "文档",
            )
        )

    def _write_usage_notes_artifact(
        self,
        ws_path: Path,
        subtask: SubTask,
        original_description: str,
        log,
    ) -> str | None:
        try:
            path = _safe_workspace_path(ws_path, "README.md", must_exist=False)
            path.parent.mkdir(parents=True, exist_ok=True)
            existing = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
            section = "\n".join([
                "",
                f"## {subtask.title}",
                "",
                "### 使用方式",
                "",
                "- 先安装项目依赖，再按入口文件或命令行参数运行脚本。",
                "- 输入、输出和配置以 SCRIPT_CONTRACT.md 以及源码中的 CLI 参数为准。",
                f"- 当前需求：{original_description}",
                "",
                "### 冒烟测试",
                "",
                "- 最终验证阶段应运行项目检测命令，例如 python -m compileall、python -m py_compile 或最小 CLI 示例。",
                "- 如果验证失败，Agent 必须先分析错误并修复，再进入审查。",
                "",
                "### 交付说明",
                "",
                "- 本节由 AutoCode 在冒烟测试与使用说明阶段生成，作为最终阶段可审查产物。",
            ])
            if existing.strip():
                path.write_text(existing.rstrip() + "\n" + section, encoding="utf-8")
            else:
                path.write_text(f"# {subtask.title}\n{section}", encoding="utf-8")
            rel = path.resolve().relative_to(ws_path.resolve()).as_posix()
            log("success", f"已生成或更新使用说明文件: {rel}", "orchestrator")
            return rel
        except Exception as exc:
            log("warn", f"生成使用说明文件失败: {exc}", "orchestrator")
            return None

    def _materialize_documentation_subtask(
        self,
        ws_path: Path,
        subtask: SubTask,
        original_description: str,
        log,
    ) -> str | None:
        """Create a minimal work file for documentation/contract phases when the agent stalls."""
        title = (subtask.title or "").lower()
        desc = (subtask.description or "").lower()
        estimated = [str(p).replace("\\", "/").lstrip("/") for p in (subtask.estimated_files or [])]
        if self._is_usage_or_smoke_doc_phase(title, desc):
            return self._write_usage_notes_artifact(ws_path, subtask, original_description, log)
        is_doc_phase = any(
            token in title or token in desc
            for token in ("contract", "契约", "说明", "文档", "梳理", "map", "入口")
        ) or any(path.endswith(".md") for path in estimated)
        if not is_doc_phase:
            return None

        target = next((p for p in estimated if p.endswith(".md")), "")
        if not target:
            if "script" in title or "契约" in title or "contract" in title:
                target = "SCRIPT_CONTRACT.md"
            else:
                return None
        if target.startswith(".autocode/") and target.endswith("WORK_NOTE.md"):
            return None
        try:
            path = _safe_workspace_path(ws_path, target, must_exist=False)
            path.parent.mkdir(parents=True, exist_ok=True)
            if path.exists() and path.read_text(encoding="utf-8", errors="replace").strip():
                return None
            content = "\n".join([
                f"# {subtask.title}",
                "",
                "## 目标",
                "",
                subtask.description or original_description,
                "",
                "## 原始需求",
                "",
                original_description,
                "",
                "## 输入",
                "",
                "- 待根据实现进一步确认。",
                "",
                "## 处理流程",
                "",
                "- 先读取现有项目结构和入口文件。",
                "- 按本子任务边界完成最小必要修改。",
                "- 完成后运行可用的验证命令。",
                "",
                "## 输出",
                "",
                "- 产出与本子任务相关的代码、配置或文档。",
                "",
                "## 边界与风险",
                "",
                "- 不修改与本子任务无关的文件。",
                "- 不访问当前工作空间以外的路径。",
                "- 如发现需求不清晰，应在对话中说明并等待用户确认。",
            ])
            path.write_text(content, encoding="utf-8")
            rel = path.resolve().relative_to(ws_path.resolve()).as_posix()
            log("success", f"已生成兜底工作文件: {rel}", "orchestrator")
            return rel
        except Exception as exc:
            log("warn", f"生成兜底工作文件失败: {exc}", "orchestrator")
            return None

    async def _execute_subtask(
        self,
        task_id: str,
        subtask: SubTask,
        description: str,
        project_type: str,
        workspace_id: str,
        ws_path: Path,
        log,
        research_report: dict | None = None,
        task_plan: TaskPlan | None = None,
    ):
        """Run a single planned subtask."""
        task = _tasks.get(task_id)
        if not task:
            return

        log("info", f"开始子任务 [{subtask.id}] {subtask.title}", "orchestrator")
        phase_record = _append_command_record(
            task,
            f"autocode subtask {subtask.id}",
            "running",
            label=f"子任务 {subtask.id}: {subtask.title}",
            source="agent_phase",
        )
        self._persist_task(task_id)
        trace_id = task.get("harness_trace_id")
        await asyncio.to_thread(harness_repository.add_event, trace_id, "execution", "subtask_start", {
            "id": subtask.id,
            "title": subtask.title,
            "agent_type": subtask.agent_type,
            "estimated_files": subtask.estimated_files,
        })
        self._push_phase_progress(
            task_id, "subtask_start",
            f"[{subtask.id}] {subtask.title} - {subtask.agent_type}"
        )

        try:
            # 更新子任务状态
            subtask.status = SubTaskStatus.running
            task["current_subtask_id"] = subtask.id
            self._sync_plan_to_task(task_id, task_plan)

            # 如果有依赖，注入依赖子任务的上下文
            dep_context = ""
            if subtask.dependencies:
                if task_plan:
                    dep_info = []
                    for dep_id in subtask.dependencies:
                        dep_st = next((s for s in task_plan.subtasks if s.id == dep_id), None)
                        if dep_st:
                            dep_info.append(f"- {dep_st.title}: {dep_st.description[:100]}")
                    if dep_info:
                        dep_context = f"\n\n**前置已完成的任务**（请基于这些任务的成果继续）：\n" + "\n".join(dep_info)

            # 构建子任务专用描述
            estimated_files_text = ", ".join(subtask.estimated_files) if subtask.estimated_files else "根据需求确定"
            subtask_desc = "\n".join([
                f"## 子任务：{subtask.title}",
                "",
                subtask.description or "",
                dep_context,
                "",
                f"预计产生的文件：{estimated_files_text}",
                "",
                _agent_ownership_prompt(subtask.agent_type),
                "",
                "注意：这是整个项目的一部分。请专注此子任务；需要代码时必须修改真实文件并运行验证。",
            ])
            # 调用 Agent 执行
            before_snapshot = _workspace_file_snapshot(ws_path)
            command_count_before = len((_tasks.get(task_id) or {}).get("command_history") or [])
            changed_by_agent = await self._run_single_agent(
                task_id=task_id,
                description=subtask_desc + "\n\n原始需求：" + description,
                project_type=project_type,
                workspace_id=workspace_id,
                agent_type=subtask.agent_type,
                ws_path=ws_path,
                log=log,
                research_report=research_report,
            )
            changed_files = _snapshot_changed(before_snapshot, _workspace_file_snapshot(ws_path))
            changed_files = list(dict.fromkeys([*changed_files, *_agent_changed_files(changed_by_agent)]))
            command_count_after = len((_tasks.get(task_id) or {}).get("command_history") or [])
            subtask_text = f"{subtask.title or ''} {subtask.description or ''}".lower()
            validation_only_phase = any(token in subtask_text for token in (
                "验证", "冒烟", "测试", "使用说明", "validation", "smoke", "test", "usage", "review",
            ))
            if (
                not changed_files
                and command_count_after > command_count_before
                and validation_only_phase
            ):
                changed_by_agent = {"changed_files": []}
                log(
                    "info",
                    f"子任务 {subtask.id} 已执行验证/检查命令且未发现需要落盘的修复，允许无文件变更完成。",
                    "orchestrator",
                )
            if _agent_needs_auto_continuation(_tasks.get(task_id)):
                phase_record.update({
                    "status": "paused",
                    "output": f"子任务达到单段迭代上限，已保存上下文并等待自动续跑: {subtask.id} {subtask.title}",
                    "exit_code": 0,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
                self._sync_plan_to_task(task_id, task_plan)
                self._persist_task(task_id)
                self._push_phase_progress(
                    task_id,
                    "subtask_auto_continuation_checkpoint",
                    f"[{subtask.id}] {subtask.title} 达到单段迭代上限，正在自动续跑。",
                )
                return
            expects_source = _subtask_expects_source(subtask, project_type)
            if expects_source and changed_files and not _has_source_file(changed_files):
                required_files_text = ", ".join(subtask.estimated_files) if subtask.estimated_files else "按需求创建最小可运行入口和核心模块"
                retry_prompt = "\n".join([
                    subtask_desc,
                    "",
                    "## 上一轮执行问题",
                    "上一轮只产生了文档、记忆或其他非源码变更，但本阶段是实现类子任务，不能算完成。",
                    "",
                    "硬性要求：",
                    f"1. 必须创建或修改真实源码文件：{required_files_text}。",
                    "2. 脚本/工具项目至少提供可运行入口、核心处理逻辑、参数解析或配置读取、错误处理。",
                    "3. README 可以更新，但不能作为本阶段唯一产物。",
                    "4. 完成后运行可用的语法检查或最小验证，并保存进度。",
                    "",
                    f"原始需求：{description}",
                ])
                log("warn", f"子任务 {subtask.id} 只产生非源码变更，执行源码聚焦重试。", "orchestrator")
                retry_before_snapshot = _workspace_file_snapshot(ws_path)
                retry_changed = await self._run_single_agent(
                    task_id=task_id,
                    description=retry_prompt,
                    project_type=project_type,
                    workspace_id=workspace_id,
                    agent_type=subtask.agent_type,
                    ws_path=ws_path,
                    log=log,
                    research_report=research_report,
                )
                retry_files = _snapshot_changed(retry_before_snapshot, _workspace_file_snapshot(ws_path))
                changed_files = list(dict.fromkeys([*changed_files, *retry_files]))
                retry_result_files = _agent_changed_files(retry_changed)
                if retry_result_files:
                    changed_files = list(dict.fromkeys([*changed_files, *retry_result_files]))
                    changed_by_agent = retry_changed
                if _agent_needs_auto_continuation(_tasks.get(task_id)):
                    phase_record.update({
                        "status": "paused",
                        "output": f"源码聚焦重试达到单段迭代上限，已保存上下文并等待自动续跑: {subtask.id} {subtask.title}",
                        "exit_code": 0,
                        "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    })
                    self._sync_plan_to_task(task_id, task_plan)
                    self._persist_task(task_id)
                    self._push_phase_progress(
                        task_id,
                        "subtask_auto_continuation_checkpoint",
                        f"[{subtask.id}] {subtask.title} 达到单段迭代上限，正在自动续跑。",
                    )
                    return
            if not changed_by_agent and not changed_files:
                required_files_text = ", ".join(subtask.estimated_files) if subtask.estimated_files else "根据需求创建最小可运行入口和模块"
                retry_prompt = "\n".join([
                    subtask_desc,
                    "",
                    "## 上一轮执行问题",
                    "上一轮没有产生任何工作区文件变更。现在必须聚焦完成本子任务的真实产物。",
                    "",
                    "硬性要求：",
                    "1. 如果这是实现类子任务，必须创建或修改真实源码/测试/README 文件，不能只输出文字说明。",
                    f"2. 优先使用预计文件：{required_files_text}。",
                    "3. 脚本/工具项目至少提供可运行入口、核心逻辑和 README 使用方式，并运行可用验证。",
                    "4. 完成后保存进度。",
                    "",
                    f"原始需求：{description}",
                ])
                log("warn", f"子任务 {subtask.id} 第一轮未产生变更，执行聚焦重试。", "orchestrator")
                retry_before_snapshot = _workspace_file_snapshot(ws_path)
                retry_changed = await self._run_single_agent(
                    task_id=task_id,
                    description=retry_prompt,
                    project_type=project_type,
                    workspace_id=workspace_id,
                    agent_type=subtask.agent_type,
                    ws_path=ws_path,
                    log=log,
                    research_report=research_report,
                )
                changed_files = _snapshot_changed(retry_before_snapshot, _workspace_file_snapshot(ws_path))
                retry_result_files = _agent_changed_files(retry_changed)
                if retry_result_files:
                    changed_files = list(dict.fromkeys([*changed_files, *retry_result_files]))
                    changed_by_agent = retry_changed
                if _agent_needs_auto_continuation(_tasks.get(task_id)):
                    phase_record.update({
                        "status": "paused",
                        "output": f"聚焦重试达到单段迭代上限，已保存上下文并等待自动续跑: {subtask.id} {subtask.title}",
                        "exit_code": 0,
                        "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    })
                    self._sync_plan_to_task(task_id, task_plan)
                    self._persist_task(task_id)
                    self._push_phase_progress(
                        task_id,
                        "subtask_auto_continuation_checkpoint",
                        f"[{subtask.id}] {subtask.title} 达到单段迭代上限，正在自动续跑。",
                    )
                    return
            if expects_source and changed_files and not _has_source_file(changed_files):
                phase_record.update({
                    "status": "failed",
                    "output": f"实现类子任务没有产生源码文件变更: {subtask.id} {subtask.title}",
                    "exit_code": 1,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
                self._persist_task(task_id)
                self._push_phase_progress(
                    task_id,
                    "subtask_no_source_changes",
                    f"[{subtask.id}] {subtask.title} 没有产生源码文件变更，已停止进入审查。",
                )
                self._push_agent_response(
                    task_id,
                    f"子任务 {subtask.title} 需要真实源码变更，但本轮只产生了文档或非源码文件。我已停止进入审查，避免把无效工作标记为完成。",
                )
                raise RuntimeError(
                    f"Implementation subtask produced no source changes: {subtask.id} {subtask.title}."
                )
            if not changed_by_agent and not changed_files:
                fallback_file = None if expects_source else self._materialize_documentation_subtask(
                    ws_path, subtask, description, log,
                )
                if fallback_file:
                    changed_files = [fallback_file]
                    changed_by_agent = True
                    log(
                        "warn",
                        f"子任务未产生文件变更，已自动生成兜底工作文件: {fallback_file}",
                        "orchestrator",
                    )
                    await asyncio.to_thread(harness_repository.add_event, trace_id, "execution", "subtask_fallback_file", {
                        "id": subtask.id,
                        "title": subtask.title,
                        "file": fallback_file,
                    })
                else:
                    phase_record.update({
                        "status": "failed",
                        "output": f"子任务没有产生文件变更: {subtask.id} {subtask.title}",
                        "exit_code": 1,
                        "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    })
                    self._persist_task(task_id)
                    self._push_phase_progress(
                        task_id,
                        "subtask_no_changes",
                        f"[{subtask.id}] {subtask.title} 没有产生文件变更，已停止进入审查。",
                    )
                    self._push_agent_response(
                        task_id,
                        f"子任务 {subtask.title} 没有产生任何文件变更，因此我已停止继续执行。请调整需求或点击重试。",
                    )
                    raise RuntimeError(
                        f"Subtask produced no file changes: {subtask.id} {subtask.title}. "
                        "Agent returned text/empty response without writing files."
                    )

            if not changed_by_agent and not changed_files:
                raise RuntimeError(
                    f"Subtask produced no file changes: {subtask.id} {subtask.title}. "
                    "Agent returned text/empty response without writing files."
                )

            # 检查执行结果
            task = _tasks.get(task_id)
            if task and task.get("status") not in ("failed", "cancelled"):
                subtask.status = SubTaskStatus.completed
                subtask.progress = 100
                self._sync_plan_to_task(task_id, task_plan)
                log("success", f"子任务完成 [{subtask.id}] {subtask.title}", "orchestrator")
                phase_record.update({
                    "status": "success",
                    "output": "\n".join(changed_files[:50]) or "子任务已完成",
                    "exit_code": 0,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
                await asyncio.to_thread(harness_repository.add_event, trace_id, "execution", "subtask_complete", {
                    "id": subtask.id,
                    "title": subtask.title,
                    "changed_files": changed_files[:50],
                    "changed_count": len(changed_files),
                })
                self._push_phase_progress(
                    task_id, "subtask_complete",
                    f"[{subtask.id}] {subtask.title} - 完成"
                )
            else:
                subtask.status = SubTaskStatus.failed
                self._sync_plan_to_task(task_id, task_plan)
                log("error", f"子任务失败 [{subtask.id}] {subtask.title}", "orchestrator")
                phase_record.update({
                    "status": "failed",
                    "output": f"任务状态变为 {task.get('status') if task else 'unknown'}",
                    "exit_code": 1,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
                await asyncio.to_thread(harness_repository.add_event, trace_id, "execution", "subtask_failed", {
                    "id": subtask.id,
                    "title": subtask.title,
                    "task_status": task.get("status") if task else None,
                })
                self._push_phase_progress(
                    task_id, "subtask_failed",
                    f"[{subtask.id}] {subtask.title} - 失败"
                )

        except AgentWaitingForUserInput:
            phase_record.update({
                "status": "paused",
                "output": "等待用户选择或补充信息。",
                "exit_code": 0,
                "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            })
            self._sync_plan_to_task(task_id, task_plan)
            self._persist_task(task_id)
            raise
        except Exception as e:
            subtask.status = SubTaskStatus.failed
            self._sync_plan_to_task(task_id, task_plan)
            log("error", f"子任务异常 [{subtask.id}] {subtask.title}: {e}", "orchestrator")
            try:
                phase_record.update({
                    "status": "failed",
                    "output": str(e),
                    "exit_code": 1,
                    "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                })
            except Exception:
                pass
            await asyncio.to_thread(harness_repository.add_event, trace_id, "execution", "subtask_error", {
                "id": subtask.id,
                "title": subtask.title,
                "error": str(e),
            })
            self._push_phase_progress(
                task_id, "subtask_error",
                f"[{subtask.id}] {subtask.title} - 异常: {str(e)[:100]}"
            )

    def _requires_prototype_confirmation(
        self,
        project_type: str,
        task_plan: Optional[TaskPlan] = None,
    ) -> bool:
        if not task_plan or not task_plan.subtasks:
            return False

        ui_keywords = (
            "ui", "页面", "界面", "前端", "frontend", "component", "组件",
            "view", "page", "screen", "layout", "style", "css",
        )
        ui_file_suffixes = (
            ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".css", ".scss",
            ".html",
        )

        for subtask in task_plan.subtasks:
            text = " ".join([
                subtask.agent_type or "",
                subtask.title or "",
                subtask.description or "",
            ]).lower()
            if any(keyword in text for keyword in ui_keywords):
                return True
            if any(
                str(path).lower().endswith(ui_file_suffixes)
                for path in (subtask.estimated_files or [])
            ):
                return True

        return False

    async def _run_agentic_loop(
        self,
        *,
        task_id: str,
        description: str,
        project_type: str,
        workspace_id: str,
        agent_type: str,
        ws_path: Path,
        log,
        research_report: dict | None = None,
        task_plan: Optional[TaskPlan] = None,
    ) -> bool:
        """Run the default autonomous execution path.

        TaskPlan remains useful context, but it is a guardrail instead of the
        driver. The single-agent runtime owns observe -> act -> verify.
        """
        plan_hint = ""
        if task_plan and task_plan.subtasks:
            plan_hint = "\n".join(
                f"- {st.id}: {st.title} ({st.agent_type}) -> {', '.join(st.estimated_files or [])}"
                for st in task_plan.subtasks[:12]
            )
        prompt = f"""## Agentic Loop Execution

User request:
{description}

Project type: {project_type}

Execution mode: agentic. The plan/subtasks below are guardrails and context only; do not execute them as a fixed phase pipeline.
{plan_hint or "- No prior TaskPlan; infer the smallest useful path from the workspace."}

Required behavior:
1. Observe the SystemContext manifest, retrieval/index files, current workspace, recent review/CI state, and pending user messages.
2. Decide the next useful tool call yourself: search, read, edit, validate, answer, or ask only when blocked by missing product intent.
3. If the request is actionable, produce real code/docs/config/test changes. Do not stop after only writing SCRIPT_CONTRACT/SPEC unless the user explicitly asked only for docs.
4. After any write, run an appropriate validation command. If validation fails, analyze the output, fix the code, and validate again.
5. Finish only when the requested behavior is implemented, validation has passed or is explicitly not applicable, and there is no pending user input.
"""
        return bool(await self._run_single_agent(
            task_id,
            prompt,
            project_type,
            workspace_id,
            agent_type,
            ws_path,
            log,
            research_report,
        ))

    async def _generate_and_confirm_prototype(
        self,
        task_id: str,
        task: dict,
        description: str,
        workspace_id: str,
        ws_path: Path,
        log,
        task_plan: Optional[TaskPlan] = None,
    ):
        """Run prototype generation and confirmation flow."""
        from core.prototype_generator import (
            generate_prototype_excalidraw,
            save_prototype_excalidraw,
            save_prototype_record,
        )

        task["progress"] = 60
        task["current_step"] = "正在生成 UI 原型..."
        self._persist_task(task_id)
        self._push_phase_progress(task_id, "prototyping", "正在生成 UI 线框图...")

        # ── Phase 1: 生成 Excalidraw 原型（独立 try/except，失败则跳过原型确认）──
        prototype_result = None
        try:
            llm_client = await self._ensure_client(requested_model=task.get("model"))
            plan_context = task_plan.model_dump() if task_plan else None

            prototype_result = await generate_prototype_excalidraw(
                description=description,
                plan_context=plan_context,
                llm_client=llm_client,
            )

            # 保存原型到工作空间
            excalidraw_data = prototype_result.get("excalidraw", {})
            save_prototype_excalidraw(ws_path, excalidraw_data)
            prototype_record = save_prototype_record(
                ws_path,
                prototype_result,
                source="initial",
                kind="excalidraw",
            )
            prototype_result["prototype_id"] = prototype_record["id"]

        except Exception as e:
            log("warn", f"原型生成失败，跳过原型确认环节: {e}", "orchestrator")
            task["progress"] = 70
            task["current_step"] = "原型生成失败，继续构建..."
            self._persist_task(task_id)
            return

        # ── Phase 2: 设置等待确认状态（不在 try/except 中，确保一定阻塞等待）──
        task["prototype"] = prototype_result  # 完整结果包含 title、description、excalidraw 和 features
        task["prototype_confirmed"] = None  # 等待确认
        task["status"] = "waiting_prototype_confirm"
        task["progress"] = 65
        prototype_title = prototype_result.get("title", "UI 线框图")
        task["current_step"] = f"原型已生成《{prototype_title}》，等待确认..."
        self._persist_task(task_id)

        excalidraw_data = prototype_result.get("excalidraw", {})
        log("info", f"Excalidraw 原型已生成: {prototype_result.get('title', '')}, "
                   f"elements={len(excalidraw_data.get('elements', []))}", "orchestrator")
        self._push_phase_progress(
            task_id, "prototype_ready",
            f"原型已生成: {prototype_result.get('title', '')}"
        )

        # ── Phase 3: 轮询等待用户确认（独立于生成阶段，不受异常影响）──
        max_wait_seconds = 3600  # 最多等待 1 小时
        wait_interval = 2  # 每 2 秒检查一次
        waited = 0

        while waited < max_wait_seconds:
            await asyncio.sleep(wait_interval)
            waited += wait_interval

            # 检查任务是否被取消
            t_check = _tasks.get(task_id)
            if not t_check or t_check.get("status") == "cancelled":
                log("info", "用户取消任务，退出", "orchestrator")
                return

            # 检查用户是否已确认/拒绝
            confirmed = t_check.get("prototype_confirmed")
            if confirmed is not None:
                if confirmed:
                    # 用户确认了原型，继续执行
                    task["status"] = "running"
                    task["progress"] = 70
                    task["current_step"] = "用户已确认原型，继续执行计划..."
                    log("success", "用户确认原型，继续执行", "orchestrator")
                else:
                    # 用户拒绝原型，重新生成
                    log("info", "用户拒绝原型，继续执行后续流程", "orchestrator")
                    task["status"] = "running"
                    task["progress"] = 70
                    task["current_step"] = "用户拒绝原型，跳过确认继续执行..."
                self._persist_task(task_id)
                return

        # 超时未确认，视为继续执行
        log("warn", "原型确认超时，继续执行", "orchestrator")
        task["status"] = "running"
        task["progress"] = 70
        task["current_step"] = "原型确认超时，继续构建..."
        self._persist_task(task_id)

    async def _run_single_agent(
        self,
        task_id: str,
        description: str,
        project_type: str,
        workspace_id: str,
        agent_type: str,
        ws_path: Path,
        log,
        research_report: dict | None = None,
    ):
        """Run a single Agent until completion."""
        with usage_agent(agent_type):
            return await self._run_single_agent_with_usage(
                task_id, description, project_type, workspace_id,
                agent_type, ws_path, log, research_report,
            )

    async def _run_single_agent_with_usage(
        self,
        task_id: str,
        description: str,
        project_type: str,
        workspace_id: str,
        agent_type: str,
        ws_path: Path,
        log,
        research_report: dict | None = None,
    ):
        system = AGENT_SYSTEM_PROMPTS.get(agent_type, AGENT_SYSTEM_PROMPTS["general"])
        system = system + "\n\n" + _agent_ownership_prompt(agent_type)
        system = system + "\n\n" + tool_registry.agent_usage_prompt()

        # 注入用户自定义 SPEC.md 规范
        try:
            from core.spec_manager import build_spec_prompt
            spec_prompt = build_spec_prompt(ws_path)
            if spec_prompt:
                system = system + "\n\n" + spec_prompt
                log("info", "已注入 SPEC.md 开发规范", agent_type)
        except Exception as e:
            logger.warning(f"[SPEC] 注入失败: {e}")

        try:
            active_harness = await asyncio.to_thread(harness_repository.get_active_harness, "autocode")
            harness_guidance = (active_harness or {}).get("guidance")
            if harness_guidance:
                system = system + "\n\n" + harness_guidance
                log("info", f"已注入 Harness 版本: {(active_harness or {}).get('version', 'unknown')}", agent_type)
        except Exception as e:
            logger.warning(f"[Harness] 注入失败: {e}")

        # ── 为当前 Agent 构建独立路由上下文 + 选择最优模型 ──
        task_ctx = self._task_contexts.get(task_id)
        if task_ctx is None:
            task_ctx = TaskContext(agent_type=agent_type, task_phase="implementation",
                                   content_types=["code"], complexity="moderate",
                                   required_capabilities=["tool"])
        else:
            task_ctx = TaskContext(
                agent_type=agent_type,
                task_phase="implementation",
                content_types=task_ctx.content_types,
                complexity=task_ctx.complexity,
                required_capabilities=task_ctx.required_capabilities,
            )

        try:
            requested_model = _tasks.get(task_id, {}).get("model")
            llm = await self._ensure_client(task_ctx, requested_model=requested_model)
        except Exception as e:
            logger.warning(f"[{agent_type}] 智能路由失败，使用默认模型: {e}")
            llm = await self._ensure_client(requested_model=requested_model)  # 回退到兜底选择

        task = _tasks.get(task_id)
        if task is not None:
            routing_mode = "explicit" if requested_model and str(requested_model).lower() != "auto" else "auto"
            if isinstance(llm, FailoverLLMClient):
                candidate = next(
                    (item for item in llm._candidates if item.model_id == llm.current_model),
                    llm._candidates[0] if llm._candidates else None,
                )
                resolved_model = candidate.model_id if candidate else None
                api_model = (candidate.api_model or candidate.model_id) if candidate else None
                provider = candidate.provider if candidate else None
                channel_id = None
            else:
                resolved_model = getattr(llm, "billing_model", None) or requested_model or getattr(llm, "model", None)
                api_model = getattr(llm, "model", None)
                provider = getattr(llm, "source_provider", None) or getattr(llm, "provider", None)
                channel_id = getattr(llm, "channel_id", None)
            append_event(
                task,
                "model_execution_selected",
                {
                    "agent": agent_type,
                    "requested_model": requested_model,
                    "resolved_model": resolved_model,
                    "api_model": api_model,
                    "provider": provider,
                    "channel_id": channel_id,
                    "routing_mode": routing_mode,
                },
                source=agent_type,
            )
            self._persist_task(task_id)

        # 注入调研报告上下文
        research_context = ""
        if research_report:
            tech_stack = research_report.get("tech_stack", {})
            key_libraries_text = ", ".join(research_report.get("key_libraries", [])[:5])
            best_practices_text = "; ".join(research_report.get("best_practices", [])[:3])
            pitfalls_text = "; ".join(research_report.get("pitfalls", [])[:2])
            research_context = "\n".join([
                "",
                "技术调研报告摘要（由 Researcher Agent 生成）：",
                f"- 推荐前端: {tech_stack.get('frontend', 'N/A')}",
                f"- 推荐后端: {tech_stack.get('backend', 'N/A')}",
                f"- 推荐数据库: {tech_stack.get('database', 'N/A')}",
                f"- 推荐部署: {tech_stack.get('deploy', 'N/A')}",
                f"- 关键库: {key_libraries_text}",
                f"- 最佳实践: {best_practices_text}",
                f"- 常见风险: {pitfalls_text}",
                "完整报告见 /workspace/RESEARCH_REPORT.md",
            ])

        # 检查是否有断点续跑记忆（MEMORY.md 中记录了上次状态）
        memory_context = ""
        mem_file = ws_path / ".autocode" / "MEMORY.md"
        if mem_file.exists():
            prev_memory = mem_file.read_text(encoding="utf-8")
            if "已完成" in prev_memory and "暂无" not in prev_memory:
                memory_context = "\n".join([
                    "",
                    "续跑模式：检测到之前的执行记忆，请基于以下状态继续：",
                    "",
                    prev_memory,
                    "",
                    "请先读取 .autocode/MEMORY.md 了解当前进度，然后从断点继续工作。",
                    "跳过已完成步骤，专注未完成部分。",
                ])
                log("info", "检测到已有执行记忆，进入续跑模式。", agent_type)

        system_context_prompt = ""
        try:
            runtime_context = agent_loop.build_context(_tasks.get(task_id, {}), ws_path)
            system_context_prompt = "\n\n" + runtime_context.to_prompt(max_chars=12000)
            task_for_context = _tasks.get(task_id)
            if task_for_context is not None:
                task_for_context["system_context_epoch"] = runtime_context.epoch
        except Exception as exc:
            logger.debug(f"[SystemContext] build failed for {task_id}: {exc}")

        solution_context = ""
        try:
            cached_solutions = cache_ledger_service.search_solutions(
                query=description,
                scene_type="autocode",
                tenant_id=str((_tasks.get(task_id) or {}).get("tenant_id") or ""),
                limit=3,
            )
            if cached_solutions:
                compact_solutions = []
                for item in cached_solutions:
                    compact_solutions.append({
                        "title": item.get("title"),
                        "tech_stack": item.get("tech_stack"),
                        "root_cause": item.get("root_cause"),
                        "patch_summary": item.get("patch_summary"),
                        "validation_command": item.get("validation_command"),
                        "validation_result": item.get("validation_result"),
                        "risk_level": item.get("risk_level"),
                        "reuse_policy": item.get("reuse_policy"),
                    })
                solution_context = (
                    "\n\n## Historical Solution Cache\n"
                    "The following previously verified solutions may be relevant. "
                    "Use them as guidance only; inspect current files and validate before finishing.\n"
                    + json.dumps(compact_solutions, ensure_ascii=False, indent=2)
                )
                task_for_context = _tasks.get(task_id)
                if task_for_context is not None:
                    append_event(
                        task_for_context,
                        "cache_solution_suggested",
                        {
                            "count": len(compact_solutions),
                            "titles": [item.get("title") for item in compact_solutions],
                        },
                        source="cache",
                    )
                    cache_ledger_service.record(CacheLedgerEvent(
                        cache_layer="L5",
                        cache_key=stable_hash({"task": task_id, "query": description, "solutions": compact_solutions}),
                        status="hit",
                        scene_type="autocode",
                        user_id=str(task_for_context.get("user_id") or ""),
                        task_id=str(task_for_context.get("id") or task_id),
                        session_id=str(task_for_context.get("id") or task_id),
                        workspace_id=str(workspace_id or task_for_context.get("workspace_id") or ""),
                        epoch=int(task_for_context.get("system_context_epoch") or 0),
                        input_hash=stable_hash(description),
                        hit_reason="historical_solution_cache_suggested",
                        token_saved_estimate=1200,
                        metadata={"solutionCount": len(compact_solutions)},
                    ))
        except Exception as exc:
            logger.debug(f"[CacheLedger] solution lookup skipped for {task_id}: {exc}")

        prompt_content = "\n".join([
            f"请完成以下 {agent_type} 开发任务：",
            "",
            f"项目类型：{project_type}",
            f"任务描述：{description}",
            "工作目录：/workspace。只能读取、搜索、创建和修改当前任务工作区内文件。",
            research_context,
            memory_context,
            system_context_prompt,
            solution_context,
            "",
            "## 工作方式：Agentic Loop",
            "- 先读取/利用 .autocode/SURFACE_MAP.md 和 PROJECT_MAP.md；用户说“页面/软件界面/看不到功能”时默认定位运行时 GUI(app_gui)，只有明确说官网/文档页才改 docs。",
            "- 先观察项目结构，使用 glob/search_code 定位相关文件。",
            "- 已有明确 candidate_files 或 SURFACE_MAP 命中时，不要继续全量 glob **/*；直接读取目标文件附近内容。",
            "- 大 HTML/模板/长源码文件优先用 search_code + read_lines(path,start,end)，不要用 shell 临时脚本数行或切片。",
            "- 只读取与当前任务相关的文件，不要全量读取项目。",
            "- 优先用 apply_patch 精准修改已有文件；需要新文件时再用 write_file。",
            "- 写入后必须运行合适验证命令；失败则继续分析并修复。",
            "- 用户列出函数、文件、属性、错误点、CI 输出或具体改动清单时，必须进入修改和验证。",
            "- 脚本/工具项目必须提供可运行入口和最小验证。",
            "- 完成后用中文简要汇报改动文件和验证结果。",
        ])
        messages = [{"role": "user", "content": prompt_content}]

        before_snapshot = _workspace_file_snapshot(ws_path)
        writes_count = 0
        aggregate_written_files: list[str] = []
        commands_count = 0
        workspace_version = 0
        validated_after_write = False
        effective_progress_count = 0
        repeated_tool_suppressed = 0
        tool_cache: dict[str, str] = {}
        tool_call_counts: dict[str, int] = {}
        discovery_result_counts: dict[str, int] = {}
        pending_user_messages_seen = 0
        validation_reminded_at_write_count = -1
        validation_failure_reminded_at_command_count = -1
        discovery_only_streak = 0
        edit_intent_without_tool_count = 0
        iteration = 0
        empty_response_retries = 0
        # 上次压缩时的消息条数：用于按体积触发压缩后，避免体积持续超阈值时每轮重复压缩。
        last_compaction_iteration = 0
        # 自适应迭代上限：S0/轻量脚本使用短流程，复杂任务保留默认长流程。
        max_iterations, compress_interval = _agent_iteration_policy(
            _tasks.get(task_id),
            description,
            bool(memory_context),
        )
        hard_iteration_cap = _remaining_absolute_iteration_budget(_tasks.get(task_id))
        log(
            "info",
            f"[{agent_type}] 迭代参考: {max_iterations}，硬安全上限: {hard_iteration_cap}{' (续跑模式)' if memory_context else ''}",
            agent_type,
        )
        if _unrestricted_dev_mode(_tasks.get(task_id)):
            task_for_event = _tasks.get(task_id)
            if task_for_event is not None:
                append_event(
                    task_for_event,
                    "unrestricted_mode_enabled",
                    {
                        "agent": agent_type,
                        "mode": "unrestricted_dev",
                        "permissions": ["write_file", "apply_patch", "code_editor", "bash"],
                    },
                    source="agent_efficiency",
                )
        # 进度范围：每个 Agent 独立进度映射到全局进度中段（中间 55% 分配给各 Agent）
        _base_progress = 27
        _progress_range = 50

        def _update_progress(step_msg: str, sub_step: int = 0):
            """Update global progress and current_step for the frontend."""
            nonlocal iteration
            t = _tasks.get(task_id)
            if not t:
                return
            # 迭代进度使用原策略作为 UI 参考；真正停止由 watchdog/hard cap 决定。
            pct = _base_progress + min(iteration / max_iterations, 1.0) * _progress_range
            t["progress"] = int(pct)
            t["current_step"] = f"[{agent_type}] {step_msg}"
            # 同步更新并行 Agent 进度追踪
            if "agent_progress" in t and agent_type in t["agent_progress"]:
                t["agent_progress"][agent_type] = int(pct)

        while iteration < hard_iteration_cap and self._active_tasks.get(task_id, False):
            iteration += 1
            task = _tasks.get(task_id)
            if task and task["status"] == "cancelled":
                break

            _update_progress(f"第 {iteration} 轮思考中（参考 {max_iterations}，硬上限 {hard_iteration_cap}）...")
            log("info", f"Agent [{agent_type}] 第 {iteration} 次迭代", agent_type)

            # 每 10 轮更新一次记忆文件
            if iteration % 10 == 0:
                self._update_workspace_memory(
                    ws_path, task_id, status="running",
                    phase=f"[{agent_type}] 迭代中 ({iteration}，参考 {max_iterations})",
                    iteration=iteration,
                )

            # ── 检查用户发来的对话消息 ──
            pending_msgs = self._get_pending_user_messages(task_id)
            if pending_msgs:
                pending_user_messages_seen += len(pending_msgs)
                log("info", f"收到 {len(pending_msgs)} 条用户消息，注入 Agent", agent_type)
                for um in pending_msgs:
                    messages.append({
                        "role": "user",
                        "content": um["content"],
                    })
                # 用户消息注入后重置迭代计数，避免因交互浪费太多轮次
                # 最多额外给 20 轮处理用户指令

            compacted_this_iteration = False
            # 按上下文体积触发压缩（而非固定轮次）：累计字符数超阈值才压，
            # 且距上次压缩至少间隔 compress_interval 轮，避免体积持续超阈值时每轮重压。
            _compact_threshold = int(os.getenv("AUTOCODE_COMPACT_THRESHOLD_CHARS", "80000"))
            _context_chars = sum(len(str(m.get("content") or "")) for m in messages)
            _compact_cooldown_passed = (iteration - last_compaction_iteration) >= compress_interval
            if (
                iteration > 1
                and len(messages) > 18
                and _context_chars >= _compact_threshold
                and _compact_cooldown_passed
            ):
                task_for_event = _tasks.get(task_id)
                if task_for_event is not None:
                    append_event(
                        task_for_event,
                        "context_compaction_started",
                        {
                            "agent": agent_type,
                            "iteration": iteration,
                            "message_count": len(messages),
                            "target": ".autocode/CONTEXT_SUMMARY.md",
                        },
                        source="context",
                    )
                summary = _write_context_summary(ws_path, task_id, agent_type, iteration, messages)
                task_snapshot = _tasks.get(task_id) or {}
                compact_state = _build_compact_context_state(task_snapshot)
                summary_excerpt = ""
                try:
                    summary_excerpt = (ws_path / ".autocode" / "CONTEXT_SUMMARY.md").read_text(encoding="utf-8", errors="replace")[:2500]
                except Exception:
                    summary_excerpt = str(summary or "")[:2500]
                messages = [
                    messages[0],
                    {
                        "role": "user",
                        "content": (
                            "上下文已压缩，下面直接给出恢复状态；不要重新扫描项目结构，"
                            "不要重新读取已读文件，继续当前目标。\n\n"
                            "## 压缩摘要\n"
                            f"{summary_excerpt}\n\n"
                            "## 保留执行状态\n"
                            f"{json.dumps(compact_state, ensure_ascii=False, indent=2)}\n\n"
                            "请优先使用 candidate_files 和 read_files 中已有上下文；"
                            "只有项目上下文 epoch 变化或候选文件不足以完成任务时，才做新的搜索。"
                        ),
                    },
                    *messages[-8:],
                ]
                log("info", f"[{agent_type}] 上下文已压缩到 .autocode/CONTEXT_SUMMARY.md", "orchestrator")
                self._push_phase_progress(
                    task_id,
                    "context_compress",
                    f"正在压缩上下文，保留最近状态继续执行（第 {iteration} 轮）",
                )
                compacted_this_iteration = True
                last_compaction_iteration = iteration

            # ── v2.0: 使用 LLMClient 发送请求 ──
            task_for_event = _tasks.get(task_id)
            if task_for_event is not None and compacted_this_iteration:
                append_event(
                    task_for_event,
                    "context_compaction_finished",
                    {
                        "agent": agent_type,
                        "iteration": iteration,
                        "summary_file": ".autocode/CONTEXT_SUMMARY.md",
                        "remaining_messages": len(messages),
                    },
                    source="context",
                )

            response: LLMResponse = await llm.chat(
                messages=messages,
                tools=_effective_agent_tools(_tasks.get(task_id)),
                system=system,
            )
            if isinstance(llm, FailoverLLMClient) and llm.current_model:
                self._model = llm.current_model

            if not response.has_tool_calls and not response.content:
                empty_response_retries += 1
                log(
                    "warn",
                    f"[{agent_type}] LLM returned an empty assistant message "
                    f"(retry {empty_response_retries}/2, finish={getattr(response, 'finish_reason', '')}).",
                    agent_type,
                )
                if response.reasoning_content:
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "reasoning_content": response.reasoning_content,
                    })
                if empty_response_retries <= 2:
                    messages.append({
                        "role": "user",
                        "content": (
                            "上一轮模型响应为空：没有正文，也没有工具调用。"
                            "这不是完成信号。请继续执行任务：必须选择一个工具读取/修改/验证，"
                            "或者用简短正文说明具体阻塞原因。不要返回空消息。"
                        ),
                    })
                    continue
                raise RuntimeError(
                    f"LLM returned empty response {empty_response_retries} times "
                    f"for agent={agent_type}, model={getattr(response, 'model', '')}, "
                    f"finish={getattr(response, 'finish_reason', '')}"
                )

            # ── 处理工具调用 ──
            if response.has_tool_calls:
                edit_intent_without_tool_count = 0
                iteration_before_snapshot = _workspace_file_snapshot(ws_path)
                iteration_written_files: list[str] = []
                iteration_ran_bash = False
                iteration_bash_exit_code: int | None = None
                iteration_bash_output: str = ""
                iteration_had_discovery_tool = False
                iteration_had_new_discovery = False
                iteration_duplicate_discovery = False
                iteration_validation_command = ""
                iteration_failed_writes: list[dict[str, str]] = []
                for tc in response.tool_calls:
                    tool_name = tc.name
                    tool_args = tc.arguments


                    step_msg = tool_registry.describe_invocation(tool_name, tool_args, progress=True)
                    _update_progress(step_msg)

                    log("info", step_msg, agent_type)

                    cache_key = _tool_cache_key(tool_name, tool_args, workspace_version)
                    stable_tool_key = f"{tool_name}:{_stable_json(tool_args)}"
                    tool_call_counts[stable_tool_key] = tool_call_counts.get(stable_tool_key, 0) + 1
                    is_discovery_tool = tool_name in {"read_file", "read_lines", "glob", "search_code"} or (
                        tool_name == "bash" and _is_read_only_bash(str(tool_args.get("command", "")))
                    ) or (
                        tool_name == "code_editor" and str(tool_args.get("command") or "").strip() == "view"
                    )
                    if is_discovery_tool:
                        iteration_had_discovery_tool = True
                        if tool_call_counts[stable_tool_key] == 1:
                            iteration_had_new_discovery = True
                    if cache_key and cache_key in tool_cache:
                        repeated_tool_suppressed += 1
                        if is_discovery_tool:
                            iteration_duplicate_discovery = True
                        result = tool_cache[cache_key]
                        task_for_event = _tasks.get(task_id)
                        if task_for_event is not None:
                            append_event(
                                task_for_event,
                                "tool_cache_hit",
                                {
                                    "tool": tool_name,
                                    "args": tool_args,
                                    "agent": agent_type,
                                    "workspace_version": workspace_version,
                                    "count": tool_call_counts[stable_tool_key],
                                },
                                source="agent_efficiency",
                            )
                            try:
                                cache_ledger_service.record(CacheLedgerEvent(
                                    cache_layer="L0",
                                    cache_key=stable_hash({"tool": tool_name, "args": tool_args, "workspaceVersion": workspace_version}),
                                    status="hit",
                                    scene_type="autocode",
                                    user_id=str(task_for_event.get("user_id") or ""),
                                    task_id=str(task_for_event.get("id") or task_id),
                                    session_id=str(task_for_event.get("id") or task_id),
                                    workspace_id=str(workspace_id or task_for_event.get("workspace_id") or ""),
                                    epoch=int(task_for_event.get("system_context_epoch") or 0),
                                    input_hash=stable_hash(tool_args),
                                    hit_reason="same_read_only_tool_call_in_workspace_state",
                                    token_saved_estimate=max(1, min(len(result) // 4, 4000)),
                                    metadata={"tool": tool_name, "agent": agent_type, "count": tool_call_counts[stable_tool_key]},
                                ))
                            except Exception:
                                pass
                        log("info", f"suppressed repeated read-only tool call: {tool_name}", "agent_efficiency")
                        messages.append({
                            "role": "assistant",
                            "content": response.content or None,
                            "tool_calls": [{
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                                },
                            }],
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": f"[{tool_name} cached result]\n{result[:2000]}\n\n[agent_efficiency] Same read-only tool call already ran in this workspace state. Use this result and proceed to edit or validate instead of repeating discovery.",
                        })
                        continue

                    duplicate_limit = _env_int("AUTOCODE_DUPLICATE_DISCOVERY_LIMIT", 2, minimum=1)
                    if tool_call_counts[stable_tool_key] >= duplicate_limit and tool_registry.is_cacheable(tool_name):
                        repeated_tool_suppressed += 1
                        if is_discovery_tool:
                            iteration_duplicate_discovery = True
                        result = (
                            "[DUPLICATE_TOOL_SUPPRESSED] This same discovery tool was requested repeatedly. "
                            "The workspace has not changed in a way that requires re-reading it. Proceed with the known context, edit the target files, or run validation."
                        )
                        task_for_event = _tasks.get(task_id)
                        if task_for_event is not None:
                            append_event(
                                task_for_event,
                                "tool_duplicate_suppressed",
                                {
                                    "tool": tool_name,
                                    "args": tool_args,
                                    "agent": agent_type,
                                    "count": tool_call_counts[stable_tool_key],
                                },
                                source="agent_efficiency",
                            )
                            try:
                                cache_ledger_service.record(CacheLedgerEvent(
                                    cache_layer="L0",
                                    cache_key=stable_hash({"tool": tool_name, "args": tool_args, "duplicate": True}),
                                    status="hit",
                                    scene_type="autocode",
                                    user_id=str(task_for_event.get("user_id") or ""),
                                    task_id=str(task_for_event.get("id") or task_id),
                                    session_id=str(task_for_event.get("id") or task_id),
                                    workspace_id=str(workspace_id or task_for_event.get("workspace_id") or ""),
                                    epoch=int(task_for_event.get("system_context_epoch") or 0),
                                    input_hash=stable_hash(tool_args),
                                    hit_reason="duplicate_discovery_tool_suppressed",
                                    token_saved_estimate=500,
                                    metadata={"tool": tool_name, "agent": agent_type, "count": tool_call_counts[stable_tool_key]},
                                ))
                            except Exception:
                                pass
                        messages.append({
                            "role": "assistant",
                            "content": response.content or None,
                            "tool_calls": [{
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                                },
                            }],
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": result,
                        })
                        continue

                    if writes_count > 0 and not validated_after_write and _is_meaningless_post_write_check(tool_name, tool_args):
                        repeated_tool_suppressed += 1
                        result = (
                            "[POST_WRITE_CHECK_SUPPRESSED] Files were already changed in this agent segment. "
                            "Do not spend more rounds on git status, cat/head/wc, or manual git_commit. "
                            "Run the appropriate validation command now; if validation fails, fix the code and validate again."
                        )
                        task_for_event = _tasks.get(task_id)
                        if task_for_event is not None:
                            append_event(
                                task_for_event,
                                "tool_duplicate_suppressed",
                                {
                                    "tool": tool_name,
                                    "args": tool_args,
                                    "agent": agent_type,
                                    "reason": "post_write_non_validation_check",
                                },
                                source="agent_efficiency",
                            )
                            try:
                                cache_ledger_service.record(CacheLedgerEvent(
                                    cache_layer="L0",
                                    cache_key=stable_hash({"tool": tool_name, "args": tool_args, "postWrite": True}),
                                    status="hit",
                                    scene_type="autocode",
                                    user_id=str(task_for_event.get("user_id") or ""),
                                    task_id=str(task_for_event.get("id") or task_id),
                                    session_id=str(task_for_event.get("id") or task_id),
                                    workspace_id=str(workspace_id or task_for_event.get("workspace_id") or ""),
                                    epoch=int(task_for_event.get("system_context_epoch") or 0),
                                    input_hash=stable_hash(tool_args),
                                    hit_reason="post_write_non_validation_check_suppressed",
                                    token_saved_estimate=500,
                                    metadata={"tool": tool_name, "agent": agent_type},
                                ))
                            except Exception:
                                pass
                        messages.append({
                            "role": "assistant",
                            "content": response.content or None,
                            "tool_calls": [{
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                                },
                            }],
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": result,
                        })
                        continue

                    if tool_registry.mutates_workspace(tool_name):
                        task_for_event = _tasks.get(task_id)
                        if task_for_event is not None:
                            try:
                                git_status = git_manager.status(ws_path)
                            except Exception:
                                git_status = {}
                            append_event(
                                task_for_event,
                                "pre_edit_checkpoint",
                                {
                                    "tool": tool_name,
                                    "path": tool_args.get("path") or tool_args.get("target") or "",
                                    "agent": agent_type,
                                    "iteration": iteration,
                                    "head": git_status.get("head") or "",
                                },
                                source="git",
                                snapshot_hash=git_status.get("head") or None,
                            )

                    result = await self._execute_tool(
                        tool_name, tool_args, workspace_id, ws_path, task_id, log, agent_type,
                    )
                    if is_discovery_tool and result:
                        result_sig = _discovery_result_signature(result)
                        discovery_result_counts[result_sig] = discovery_result_counts.get(result_sig, 0) + 1
                        if discovery_result_counts[result_sig] >= _env_int("AUTOCODE_DUPLICATE_DISCOVERY_LIMIT", 2, minimum=1):
                            iteration_duplicate_discovery = True
                            task_for_event = _tasks.get(task_id)
                            if task_for_event is not None:
                                append_event(
                                    task_for_event,
                                    "duplicate_fact_detected",
                                    {
                                        "agent": agent_type,
                                        "iteration": iteration,
                                        "tool": tool_name,
                                        "args": tool_args,
                                        "signature": result_sig,
                                        "count": discovery_result_counts[result_sig],
                                    },
                                    source="agent_efficiency",
                                )
                            result += (
                                "\n\n[DUPLICATE_FACT_DETECTED] 已重复得到相同发现。"
                                "停止继续读取/搜索，必须基于现有上下文进入编辑、验证，或提出一个具体阻塞问题。"
                            )
                    if cache_key and result:
                        tool_cache[cache_key] = result
                    is_mutating_edit = tool_name in {"write_file", "apply_patch"} or (
                        tool_name == "code_editor"
                        and str(tool_args.get("command") or "").strip() in {"create", "str_replace", "insert", "undo_edit"}
                    )
                    if tool_registry.mutates_workspace(tool_name) and is_mutating_edit:
                        rel_written = str(tool_args.get("path", "")).strip().replace("\\", "/").lstrip("/")
                        if _tool_result_indicates_write_success(result) and rel_written:
                            writes_count += 1
                            effective_progress_count += 1
                            workspace_version += 1
                            validated_after_write = False
                            tool_cache.clear()
                            try:
                                task_for_event = _tasks.get(task_id) or {}
                                cache_ledger_service.record(CacheLedgerEvent(
                                    cache_layer="L0",
                                    cache_key=stable_hash({"workspace": workspace_id, "version": workspace_version, "path": rel_written}),
                                    status="stale",
                                    scene_type="autocode",
                                    user_id=str(task_for_event.get("user_id") or ""),
                                    task_id=str(task_for_event.get("id") or task_id),
                                    session_id=str(task_for_event.get("id") or task_id),
                                    workspace_id=str(workspace_id or task_for_event.get("workspace_id") or ""),
                                    epoch=int(task_for_event.get("system_context_epoch") or 0),
                                    invalidation_reason="workspace_mutated_by_agent",
                                    metadata={"tool": tool_name, "path": rel_written, "workspaceVersion": workspace_version},
                                ))
                            except Exception:
                                pass
                            iteration_written_files.append(rel_written)
                            if rel_written not in aggregate_written_files:
                                aggregate_written_files.append(rel_written)
                            task_for_write_event = _tasks.get(task_id)
                            if task_for_write_event is not None and _unrestricted_dev_mode(task_for_write_event):
                                append_event(
                                    task_for_write_event,
                                    "workspace_write_unrestricted",
                                    {
                                        "agent": agent_type,
                                        "tool": tool_name,
                                        "path": rel_written,
                                        "iteration": iteration,
                                    },
                                    source="agent_efficiency",
                                )
                        elif rel_written:
                            iteration_failed_writes.append({
                                "tool": tool_name,
                                "path": rel_written,
                                "result": result[:1600],
                            })
                    elif tool_name == "git_commit":
                        commands_count += 1
                    elif tool_name == "bash":
                        commands_count += 1
                        iteration_ran_bash = True
                        iteration_validation_command = str(tool_args.get("command", ""))
                        if "[exit_code=" in result:
                            try:
                                idx = result.rfind("[exit_code=")
                                code_str = result[idx + 11:].rstrip("]")
                                iteration_bash_exit_code = int(code_str)
                            except (ValueError, IndexError):
                                iteration_bash_exit_code = 0
                        else:
                            iteration_bash_exit_code = 0
                        iteration_bash_output = result
                        if iteration_bash_exit_code == 0 and _is_validation_command(str(tool_args.get("command", ""))):
                            validated_after_write = writes_count > 0
                            if validated_after_write:
                                try:
                                    task_for_cache = _tasks.get(task_id) or {}
                                    prompt_for_cache = _latest_user_prompt(task_for_cache, description)
                                    cache_ledger_service.save_solution({
                                        "scene_type": "autocode",
                                        "tenant_id": str(task_for_cache.get("tenant_id") or ""),
                                        "user_id": str(task_for_cache.get("user_id") or ""),
                                        "title": str(task_for_cache.get("title") or prompt_for_cache)[:300],
                                        "tech_stack": str(task_for_cache.get("tech_stack") or task_for_cache.get("project_type") or project_type or ""),
                                        "error_excerpt": str(iteration_bash_output or "")[:2000],
                                        "root_cause": "Agent changes validated successfully after user request.",
                                        "patch_summary": f"Changed files in this iteration: {', '.join(iteration_written_files) if iteration_written_files else 'workspace changes'}",
                                        "validation_command": str(tool_args.get("command") or "")[:500],
                                        "validation_result": "passed",
                                        "risk_level": 1,
                                        "reuse_policy": "verify_before_apply",
                                        "metadata": {
                                            "taskId": task_id,
                                            "workspaceId": workspace_id,
                                            "agent": agent_type,
                                            "prompt": prompt_for_cache[:1000],
                                        },
                                    })
                                    cache_ledger_service.record(CacheLedgerEvent(
                                        cache_layer="L5",
                                        cache_key=stable_hash({"task": task_id, "validation": tool_args.get("command"), "files": iteration_written_files}),
                                        status="write",
                                        scene_type="autocode",
                                        user_id=str(task_for_cache.get("user_id") or ""),
                                        task_id=str(task_for_cache.get("id") or task_id),
                                        session_id=str(task_for_cache.get("id") or task_id),
                                        workspace_id=str(workspace_id or task_for_cache.get("workspace_id") or ""),
                                        epoch=int(task_for_cache.get("system_context_epoch") or 0),
                                        hit_reason="validated_solution_cached",
                                        metadata={"command": tool_args.get("command"), "changedFiles": iteration_written_files},
                                    ))
                                except Exception as exc:
                                    logger.debug(f"[CacheLedger] save validated solution skipped for {task_id}: {exc}")

                    # 将工具执行进度推送到对话 SSE（用户可见）
                    output_meta = bound_tool_output(ws_path, result, tool_name=tool_name)
                    result_for_event = output_meta["preview"]
                    result_for_model = output_meta["model_preview"]

                    self._push_tool_progress(task_id, tool_name, tool_args, result_for_event)
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        append_event(
                            task_for_event,
                            "tool_result",
                            {
                                "tool": tool_name,
                                "args": tool_args,
                                "agent": agent_type,
                                "result": result_for_event,
                                "output_truncated": output_meta["truncated"],
                                "output_path": output_meta["full_path"],
                                "output_sha256": output_meta["sha256"],
                                "output_chars": output_meta["chars"],
                                "output_lines": output_meta["lines"],
                            },
                            source=agent_type,
                        )

                    # 使用 OpenAI-compatible 格式追加消息
                    # DeepSeek 推理模型需要传回 reasoning_content
                    assistant_msg = {
                        "role": "assistant",
                        "content": response.content or None,
                        "tool_calls": [{
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": json.dumps(tc.arguments, ensure_ascii=False),
                            },
                        }],
                    }
                    if response.reasoning_content:
                        # 流式推送思考过程到前端
                        self._push_tool_progress(task_id, 'thinking', {'content': response.reasoning_content}, '')
                        assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": f"[{tool_name} 执行结果]\n{result}",
                    })
                    messages[-1]["content"] = f"[{tool_name} result]\n{result_for_model}"

                if iteration_failed_writes:
                    failure_lines = "\n\n".join(
                        f"- {item['tool']} `{item['path']}`:\n{item['result']}"
                        for item in iteration_failed_writes[:5]
                    )
                    messages.append({
                        "role": "user",
                        "content": (
                            "[WRITE_TOOL_FAILED]\n"
                            "上一轮写入工具没有产生成功写入。不要结束任务，也不要进入审查。\n"
                            f"{failure_lines}\n\n"
                            "请立即读取目标附近内容，修正 search/replace，或改用 code_editor 的 "
                            "str_replace/insert/create 完成实际写入；写入后再运行验证。"
                        ),
                    })

                if iteration_written_files:
                    try:
                        runtime_context = agent_loop.build_context(_tasks.get(task_id, {}), ws_path)
                        task_for_context = _tasks.get(task_id)
                        if task_for_context is not None:
                            task_for_context["system_context_epoch"] = runtime_context.epoch
                    except Exception as exc:
                        logger.debug(f"[SystemContext] reconcile after write failed for {task_id}: {exc}")
                    iteration_after_snapshot = _workspace_file_snapshot(ws_path)
                    changed_now = _snapshot_changed(iteration_before_snapshot, iteration_after_snapshot)
                    deleted_now = _snapshot_deleted(iteration_before_snapshot, iteration_after_snapshot)
                    changed_for_commit = sorted(set(changed_now + deleted_now + iteration_written_files))
                    if changed_for_commit:
                        task_for_commit = _tasks.get(task_id, {})
                        prompt = _latest_user_prompt(task_for_commit, description)
                        commit_message = _format_snapshot_message(
                            task_for_commit,
                            agent_type=agent_type,
                            iteration=iteration,
                            changed_files=changed_for_commit,
                            user_prompt=prompt,
                        )
                        try:
                            snapshot = create_snapshot(
                                task=task_for_commit,
                                workspace_root=ws_path,
                                changed_files=changed_for_commit,
                                message=commit_message,
                                agent=agent_type,
                                trigger_prompt=prompt,
                                phase="tool_batch",
                                iteration=iteration,
                            )
                            commit_hash = snapshot.hash
                            if commit_hash:
                                append_event(
                                    task_for_commit,
                                    "checkpoint_created",
                                    {
                                        "hash": commit_hash,
                                        "agent": agent_type,
                                        "iteration": iteration,
                                        "changed_files": changed_for_commit[:100],
                                        "trigger_prompt": prompt[:500],
                                    },
                                    source="git",
                                    snapshot_hash=commit_hash,
                                )
                                log("success", f"Auto snapshot {commit_hash}: {len(changed_for_commit)} files", "git")
                                self._push_tool_progress(
                                    task_id,
                                    "git_commit",
                                    {"message": f"Auto snapshot {commit_hash}"},
                                    f"Snapshot commit {commit_hash}\nTriggered by: {prompt[:240]}\nFiles:\n" + "\n".join(changed_for_commit[:30]),
                                )
                                self._persist_task(task_id)
                        except Exception as exc:
                            log("warn", f"Auto snapshot failed: {exc}", "git")

                # -- closed-loop validation gate: must self-validate after writes --
                if (
                    iteration_written_files
                    and not iteration_ran_bash
                    and validation_reminded_at_write_count != writes_count
                ):
                    validation_reminded_at_write_count = writes_count
                    messages.append({
                        "role": "user",
                        "content": "你已经写入了文件，但还没有完成验证。请根据当前 ExecutionPlan、真实 manifest 和目标产物格式选择匹配的验证方式；没有依据时不要猜测 npm 或其他构建命令。验证失败时分析真实错误并修复。",
                    })
                    log("info", f"[{agent_type}] validation gate: remind Agent to run validation", "orchestrator")
                elif (
                    iteration_ran_bash
                    and iteration_bash_exit_code is not None
                    and iteration_bash_exit_code != 0
                    and _is_validation_command(iteration_validation_command)
                    and validation_failure_reminded_at_command_count != commands_count
                ):
                    validation_failure_reminded_at_command_count = commands_count
                    messages.append({
                        "role": "user",
                        "content": f"验证命令失败（退出码 {iteration_bash_exit_code}）。\n输出内容:\n{iteration_bash_output[:1500]}\n\n请分析上面的错误信息，修复代码中的问题，然后重新运行验证。不要停下来等用户，自己修复直到验证通过。",
                    })
                    log("info", f"[{agent_type}] validation gate: validation failed(exit={iteration_bash_exit_code}), asking Agent to fix", "orchestrator")

                current_snapshot_for_watchdog = _workspace_file_snapshot(ws_path)
                changed_for_watchdog = _snapshot_changed(before_snapshot, current_snapshot_for_watchdog)
                repeated_discovery_without_progress = (
                    iteration_had_discovery_tool
                    and not iteration_written_files
                    and not validated_after_write
                    and not iteration_ran_bash
                    and (not iteration_had_new_discovery or iteration_duplicate_discovery)
                )
                if repeated_discovery_without_progress:
                    discovery_only_streak += 1
                elif iteration_written_files or validated_after_write or pending_msgs:
                    discovery_only_streak = 0
                signature = _progress_watchdog_signature(
                    _tasks.get(task_id),
                    changed_files=changed_for_watchdog,
                    written_files=iteration_written_files,
                    validation_command=iteration_validation_command if _is_validation_command(iteration_validation_command) else "",
                    validation_exit_code=iteration_bash_exit_code,
                    validation_output=iteration_bash_output,
                    pending_user_messages=pending_user_messages_seen,
                )
                watchdog_result = _apply_progress_watchdog(
                    _tasks.get(task_id) or {},
                    signature,
                    iteration=iteration,
                    agent_type=agent_type,
                    duplicate_discovery=iteration_duplicate_discovery or discovery_only_streak >= _env_int("AUTOCODE_DUPLICATE_DISCOVERY_LIMIT", 2, minimum=1),
                    discovery_progress=bool(
                        iteration_had_discovery_tool
                        and iteration_had_new_discovery
                        and not iteration_duplicate_discovery
                    ),
                    action_progress=bool(
                        iteration_written_files
                        or validated_after_write
                        or pending_msgs
                        or (iteration_ran_bash and _is_validation_command(iteration_validation_command))
                    ),
                )
                task_for_event = _tasks.get(task_id)
                if task_for_event is not None:
                    event_type = "progress_watchdog_progress" if watchdog_result["made_progress"] else "progress_watchdog_tick"
                    append_event(
                        task_for_event,
                        event_type,
                        {
                            "agent": agent_type,
                            "iteration": iteration,
                            "signature": signature,
                            "no_progress_iterations": watchdog_result["watchdog"].get("no_progress_iterations"),
                            "duplicate_discovery_streak": watchdog_result["watchdog"].get("duplicate_discovery_streak"),
                            "discovery_progress": bool(
                                iteration_had_discovery_tool
                                and iteration_had_new_discovery
                                and not iteration_duplicate_discovery
                            ),
                            "action_progress": bool(
                                iteration_written_files
                                or validated_after_write
                                or pending_msgs
                                or (iteration_ran_bash and _is_validation_command(iteration_validation_command))
                            ),
                        },
                        source="agent_efficiency",
                    )
                if watchdog_result["force_transition"]:
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        append_event(
                            task_for_event,
                            "forced_transition_requested",
                            {
                                "agent": agent_type,
                                "iteration": iteration,
                                "reason": watchdog_result["reason"],
                                "discovery_only_streak": discovery_only_streak,
                                "watchdog": watchdog_result["watchdog"],
                            },
                            source="agent_efficiency",
                        )
                        self._persist_task(task_id)
                    messages.append({
                        "role": "user",
                        "content": (
                            "[FORCED_TRANSITION_REQUIRED]\n"
                            "你已经重复读取/搜索或连续没有产生新进展。下一轮禁止继续做相同 discovery。"
                            "必须三选一：1) 基于已知目标文件直接编辑；2) 运行或修复验证；3) 提出一个具体阻塞问题。"
                        ),
                    })
                    log("warn", f"[{agent_type}] progress watchdog requested forced transition", "agent_efficiency")
                if watchdog_result["stop"]:
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        task_for_event["needs_continuation"] = False
                        task_for_event["agent_iteration_limited"] = False
                        task_for_event["agent_iteration_limit_reason"] = "blocked_by_no_progress"
                        append_event(
                            task_for_event,
                            "agent_paused_no_progress",
                            {
                                "agent": agent_type,
                                "iteration": iteration,
                                "reason": watchdog_result["reason"],
                                "watchdog": watchdog_result["watchdog"],
                            },
                            source="agent_efficiency",
                        )
                        self._persist_task(task_id)
                    log("warn", f"[{agent_type}] paused by progress watchdog: no progress after forced transition", "agent_efficiency")
                    break

                if iteration_written_files:
                    current_snapshot = _workspace_file_snapshot(ws_path)
                    changed_so_far = _snapshot_changed(before_snapshot, current_snapshot)
                    has_artifact = _has_meaningful_output_artifact(ws_path, changed_so_far + iteration_written_files)
                    if has_artifact and (validated_after_write or (writes_count > 0 and not _has_source_file(changed_so_far + iteration_written_files))):
                        task_for_event = _tasks.get(task_id)
                        if task_for_event is not None:
                            append_event(
                                task_for_event,
                                "agent_efficiency_guard",
                                {
                                    "agent": agent_type,
                                    "iteration": iteration,
                                    "reason": "artifact_ready_early_stop",
                                    "writes_count": writes_count,
                                    "validated_after_write": validated_after_write,
                                    "changed_files": (changed_so_far + iteration_written_files)[:50],
                                },
                                source="agent_efficiency",
                            )
                        log("info", f"[{agent_type}] stopping early after meaningful artifact/progress", "agent_efficiency")
                        break

                if validated_after_write and writes_count > 0 and iteration_ran_bash and iteration_bash_exit_code == 0:
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        append_event(
                            task_for_event,
                            "agent_efficiency_guard",
                            {
                                "agent": agent_type,
                                "iteration": iteration,
                                "reason": "validation_passed_after_write",
                                "writes_count": writes_count,
                                "commands_count": commands_count,
                            },
                            source="agent_efficiency",
                        )
                    log("info", f"[{agent_type}] stopping early after validation passed", "agent_efficiency")
                    break

            if response.content:
                # 只有文本、无工具调用时，追加普通 assistant 消息
                if not response.has_tool_calls:
                    assistant_msg = {"role": "assistant", "content": response.content}
                    if response.reasoning_content:
                        # 流式推送思考过程到前端
                        assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)

                log("success", response.content[:200], agent_type)
                # 更新进度：正在规划/生成
                _update_progress("正在整理执行结果和下一步...")

                # ── 将 Agent 响应推送到对话 SSE 队列（仅推送非工具调用的文本内容）──
                if not response.has_tool_calls:
                    self._push_agent_response(task_id, response.content)

                if not response.has_tool_calls and _assistant_content_requests_blocking_input(response.content):
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        if (
                            _autonomy_mode(task_for_event) == "strong"
                            and _is_soft_entry_blocker(response.content)
                            and not _is_hard_blocking_input(response.content)
                        ):
                            messages.append({
                                "role": "user",
                                "content": _auto_decision_for_soft_blocker(
                                    task_for_event,
                                    task_id=task_id,
                                    agent_type=agent_type,
                                    iteration=iteration,
                                    content=response.content,
                                ),
                            })
                            self._persist_task(task_id)
                            log("warn", f"[{agent_type}] soft blocker auto-resolved by strong autonomy", "agent_autonomy")
                            continue
                        opened = _open_blocking_input_request(
                            task_for_event,
                            task_id=task_id,
                            agent_type=agent_type,
                            iteration=iteration,
                            content=response.content,
                        )
                        self._persist_task(task_id)
                        if opened:
                            log("warn", f"[{agent_type}] waiting for structured user input", "agent_blocker")
                        raise AgentWaitingForUserInput(response.content[:500])
                    break

                if not response.has_tool_calls and _assistant_content_promises_edit_without_tool(response.content):
                    edit_intent_without_tool_count += 1
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        append_event(
                            task_for_event,
                            "edit_tool_required",
                            {
                                "agent": agent_type,
                                "iteration": iteration,
                                "count": edit_intent_without_tool_count,
                                "message": response.content[:1000],
                            },
                            source="agent_efficiency",
                        )
                        self._persist_task(task_id)
                    messages.append({
                        "role": "user",
                        "content": (
                            "[EDIT_TOOL_REQUIRED]\n"
                            "你刚才说要开始编辑/修改文件，但这一轮没有发出任何编辑工具调用。"
                            "下一轮禁止继续笼统分析或重复读取；必须三选一："
                            "1) 调用 apply_patch/code_editor/write_file 完成实际写入；"
                            "2) 如果已经写入，运行验证；"
                            "3) 给出一个具体阻塞原因（缺哪个文件、哪个符号、哪段内容匹配不上）。"
                        ),
                    })
                    log("warn", f"[{agent_type}] assistant promised edits without tool call; forcing edit tool next", "agent_efficiency")
                    if edit_intent_without_tool_count <= 1:
                        continue
                    break

                # 检查是否完成
                if _assistant_content_says_complete(response.content):
                    task_for_event = _tasks.get(task_id)
                    if task_for_event is not None:
                        append_event(
                            task_for_event,
                            "task_stop_guard_triggered",
                            {
                                "reason": "assistant_reported_completion",
                                "agent": agent_type,
                                "iteration": iteration,
                                "message": response.content[:1000],
                            },
                            source="agent_guardrail",
                        )
                    log("success", f"[{agent_type}] 已报告完成，触发停止护栏", agent_type)
                    break

            # 没有工具调用也没有文本 → LLM 可能结束
            if not response.has_tool_calls and not response.content:
                # 推理模型可能只返回 reasoning_content 而无正文，也需记录
                if response.reasoning_content:
                    # 流式推送思考过程到前端
                    assistant_msg = {"role": "assistant", "content": None}
                    assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)
                else:
                    log("info", f"[{agent_type}] LLM 返回空响应，结束本轮", agent_type)
                    break

            await asyncio.sleep(0.5)

        task = _tasks.get(task_id) or task or {}
        # 只有硬安全上限会触发 continuation/人工确认保险丝；低轮次策略仅作 UI 参考。
        after_snapshot_for_limit = _workspace_file_snapshot(ws_path)
        changed_files_for_limit = _snapshot_changed(before_snapshot, after_snapshot_for_limit)
        has_meaningful_progress = bool(
            writes_count > 0
            or effective_progress_count > 0
            or _has_meaningful_output_artifact(ws_path, changed_files_for_limit)
        )
        hit_hard_iteration_cap = iteration >= hard_iteration_cap
        if iteration >= max_iterations and has_meaningful_progress and not hit_hard_iteration_cap:
            log(
                "info",
                f"[{agent_type}] passed iteration reference after producing progress; continuing under watchdog.",
                "agent_efficiency",
            )
            task.pop("needs_continuation", None)
            task.pop("agent_iteration_limited", None)
            task.pop("agent_iteration_limit_reason", None)

        if hit_hard_iteration_cap:
            # 保存当前状态到 MEMORY.md 支持断点续跑
            self._update_workspace_memory(
                ws_path, task_id,
                status="needs_continuation",
                phase=f"硬安全上限({hard_iteration_cap})",
                issues=[f"达到 {hard_iteration_cap} 轮硬安全上限，任务可能尚未完全完成"],
                decisions=[f"共执行 {iteration} 轮 LLM 迭代"],
                iteration=iteration,
            )
            # 同时保存消息历史摘要
            summary_file = ws_path / ".autocode" / "SESSION_SUMMARY.md"
            summary_lines = [
                f"# 会话摘要 - {task_id[:8]}",
                "",
                f"> 截断时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                f"> Agent: {agent_type}",
                f"> 总轮次: {iteration}/{hard_iteration_cap}",
                "",
                "## 最后几条消息",
                "",
            ]
            for msg in messages[-6:]:
                role = msg.get("role", "unknown")
                content = (msg.get("content") or "")[:300]
                if msg.get("tool_calls"):
                    tc_names = [tc.get("name","?") for tc in msg["tool_calls"]]
                    content = f"[工具调用: {', '.join(tc_names)}]"
                summary_lines.extend([f"- **{role}**: {content}", ""])
            summary_content = "\n".join(summary_lines)

            summary_file.write_text(summary_content, encoding="utf-8")

            log("warn",
                f"[{agent_type}] 达到硬安全上限 {hard_iteration_cap}，状态已保存到 .autocode/"
                f"MEMORY.md + SESSION_SUMMARY.md。系统将自动续跑保险丝或等待用户点击继续。",
                "orchestrator")
            task["needs_continuation"] = True

        # 记录迭代次数供 execute_task 使用
        if task.get("needs_continuation") and hit_hard_iteration_cap:
            task["agent_iteration_limited"] = True
            task["agent_iteration_limit_reason"] = "absolute_iteration_cap"
            task["current_step"] = "达到硬安全上限，正在保存上下文并请求续跑确认。"
            self._push_phase_progress(
                task_id,
                "auto_continuation_checkpoint",
                task["current_step"],
            )
            log(
                "warn",
                f"[{agent_type}] 达到硬安全上限 {hard_iteration_cap}，后台队列将进入续跑保险丝。",
                "orchestrator",
            )
        task["agent_iteration"] = iteration
        try:
            task["total_agent_iterations"] = int(task.get("total_agent_iterations") or 0) + int(iteration)
        except (TypeError, ValueError):
            task["total_agent_iterations"] = int(iteration)
        try:
            runtime_context = agent_loop.build_context(_tasks.get(task_id, {}), ws_path)
            task["system_context_epoch"] = runtime_context.epoch
        except Exception as exc:
            logger.debug(f"[SystemContext] final reconcile failed for {task_id}: {exc}")
        after_snapshot = _workspace_file_snapshot(ws_path)
        changed_files = _snapshot_changed(before_snapshot, after_snapshot)
        if aggregate_written_files:
            changed_files = list(dict.fromkeys([*changed_files, *aggregate_written_files]))
        meaningful_changed_files = _meaningful_changed_file_list(changed_files)
        task["last_agent_result"] = {
            "agent_type": agent_type,
            "iterations": iteration,
            "iteration_limited": bool(task.get("agent_iteration_limited")),
            "writes_count": writes_count,
            "commands_count": commands_count,
            "repeated_tool_suppressed": repeated_tool_suppressed,
            "validated_after_write": validated_after_write,
            "changed_files": meaningful_changed_files[:50],
            "raw_changed_files": changed_files[:50],
            "source_files": _count_source_files(ws_path),
        }
        return bool(meaningful_changed_files)

    # Read-only subagent types the parent may spawn. Kept intentionally small:
    # both are research/review roles with no write mandate, so a spawned run
    # cannot mutate the workspace beyond what its read-only tool set allows.
    _SPAWN_SUBAGENT_TYPES = {"researcher", "reviewer"}
    # Tool subset a spawned subagent is allowed to use. Read/search/intelligence
    # only — no write_file/apply_patch/code_editor/bash, and no spawn_subagent
    # (prevents recursive spawning).
    _SPAWN_SUBAGENT_TOOLS = ["read_file", "read_lines", "list_files", "search_code", "glob", "lsp", "thinking"]
    _MAX_BACKGROUND_SUBAGENTS = 3

    async def _execute_spawn_subagent(
        self, args: dict, workspace_id: str, ws_path: Path,
        parent_task_id: str, project_type: str, log,
    ) -> str:
        """Spawn a read-only research/review subagent.

        Foreground mode preserves the existing blocking behavior. Background
        mode starts an isolated child task and injects its result into the
        parent's pending message queue when it finishes.
        """
        subagent_type = str(args.get("subagent_type") or "").strip().lower()
        prompt = str(args.get("prompt") or "").strip()
        description = str(args.get("description") or "").strip() or "subagent task"
        background = bool(args.get("background"))

        if subagent_type not in self._SPAWN_SUBAGENT_TYPES:
            allowed = ", ".join(sorted(self._SPAWN_SUBAGENT_TYPES))
            return f"[错误] 不支持的 subagent_type: {subagent_type or '(空)'}。仅允许只读研究/审查类型：{allowed}。"
        if not prompt:
            return "[错误] spawn_subagent 需要 prompt 参数（要交给子 Agent 的任务描述）。"

        if background:
            return self._start_background_subagent(
                subagent_type, prompt, description,
                workspace_id, ws_path, parent_task_id, project_type, log,
            )

        sub_task_id = f"{parent_task_id}::sub-{uuid.uuid4().hex[:8]}"
        log("info", f"派生只读子 Agent（{subagent_type}）：{description}", "orchestrator")
        return await self._run_isolated_subagent(
            sub_task_id, subagent_type, prompt,
            workspace_id, ws_path, parent_task_id, project_type, log,
        )

    def _start_background_subagent(
        self,
        subagent_type: str,
        prompt: str,
        description: str,
        workspace_id: str,
        ws_path: Path,
        parent_task_id: str,
        project_type: str,
        log,
    ) -> str:
        live = self._prune_background_subagents(parent_task_id)
        if live >= self._MAX_BACKGROUND_SUBAGENTS:
            return (
                f"[错误] 后台子 Agent 已达到并发上限 "
                f"{self._MAX_BACKGROUND_SUBAGENTS}，请等待已有子 Agent 完成。"
            )

        sub_task_id = f"{parent_task_id}::sub-{uuid.uuid4().hex[:8]}"
        log("info", f"后台派生只读子 Agent（{subagent_type}）：{description}", "orchestrator")
        task = asyncio.create_task(
            self._run_background_subagent(
                sub_task_id, subagent_type, prompt,
                workspace_id, ws_path, parent_task_id, project_type, log,
            )
        )
        task.add_done_callback(lambda _task: self._prune_background_subagents(parent_task_id))
        self._background_subagents.setdefault(parent_task_id, []).append(task)
        return (
            f'<subagent type="{subagent_type}" state="running">\n'
            "后台子 agent 已启动，完成后结果会自动送达，不要轮询。\n"
            "</subagent>"
        )

    def _prune_background_subagents(self, parent_task_id: str) -> int:
        tasks = self._background_subagents.get(parent_task_id) or []
        live = [task for task in tasks if not task.done()]
        if live:
            self._background_subagents[parent_task_id] = live
        else:
            self._background_subagents.pop(parent_task_id, None)
        return len(live)

    async def _run_background_subagent(
        self,
        sub_task_id: str,
        subagent_type: str,
        prompt: str,
        workspace_id: str,
        ws_path: Path,
        parent_task_id: str,
        project_type: str,
        log,
    ) -> None:
        try:
            envelope = await self._run_isolated_subagent(
                sub_task_id, subagent_type, prompt,
                workspace_id, ws_path, parent_task_id, project_type, log,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[spawn_subagent:background] {subagent_type} failed: {exc}")
            envelope = f'<subagent type="{subagent_type}" state="error">\n子 Agent 执行失败：{exc}\n</subagent>'
        finally:
            self._prune_background_subagents(parent_task_id)

        self._inject_background_subagent_result(parent_task_id, envelope)

    def _inject_background_subagent_result(self, parent_task_id: str, envelope: str) -> None:
        message = {
            "id": f"background-subagent-{uuid.uuid4().hex[:12]}",
            "content": envelope,
            "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "source": "background_subagent",
        }
        self._user_message_queues.setdefault(parent_task_id, []).append(message)
        if parent_task_id in self._message_events:
            self._message_events[parent_task_id].set()

    async def _cancel_background_subagents(self, parent_task_id: str) -> None:
        tasks = self._background_subagents.pop(parent_task_id, [])
        pending = [task for task in tasks if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _run_isolated_subagent(
        self,
        sub_task_id: str,
        subagent_type: str,
        prompt: str,
        workspace_id: str,
        ws_path: Path,
        parent_task_id: str,
        project_type: str,
        log,
    ) -> str:
        parent_task = _tasks.get(parent_task_id) or {}
        # Minimal isolated task dict: shares workspace + model, but all loop
        # state (iterations, messages, continuation) starts clean and is thrown
        # away when the subagent finishes.
        _tasks[sub_task_id] = {
            "id": sub_task_id,
            "parent_task_id": parent_task_id,
            "workspace_id": workspace_id,
            "project_type": project_type,
            "model": parent_task.get("model"),
            "user_id": parent_task.get("user_id"),
            "tenant_id": parent_task.get("tenant_id"),
            "is_subagent": True,
            # Read-only tool subset — enforced in the chat loop via _effective_agent_tools.
            "allowed_tools": list(self._SPAWN_SUBAGENT_TOOLS),
            "logs": [],
            "events": [],
        }
        self._active_tasks[sub_task_id] = True

        sub_prompt = "\n".join([
            f"## 子 Agent 任务（{subagent_type}，只读模式）",
            "",
            "你是被主 Agent 派生的只读子 Agent。严格约束：",
            "- 只能使用 read_file / read_lines / list_files / search_code / glob / lsp 等只读工具。",
            "- 禁止任何写入或命令执行（没有 write_file/apply_patch/code_editor/bash 权限）。",
            "- 不要尝试修改工作区；你的产出是一份结论文本，交回主 Agent。",
            "",
            "## 主 Agent 交给你的任务",
            prompt,
            "",
            "## 输出要求",
            "完成调查后，用中文输出简明、可执行的结论：关键发现、依据文件/位置、风险与建议。",
            "这段结论就是你的最终返回值，主 Agent 会据此继续工作。",
        ])

        try:
            result = await self._run_single_agent_with_usage(
                sub_task_id, sub_prompt, project_type, workspace_id,
                subagent_type, ws_path, log, None,
            )
            summary = ""
            if isinstance(result, dict):
                summary = str(result.get("summary") or "").strip()
            if not summary:
                summary = "（子 Agent 未产生结论文本）"
            state = "completed" if (isinstance(result, dict) and result.get("success")) else "error"
            return (
                f'<subagent type="{subagent_type}" state="{state}">\n'
                f"{summary}\n"
                f"</subagent>"
            )
        except Exception as exc:  # noqa: BLE001 — never propagate into the parent loop
            logger.warning(f"[spawn_subagent] {subagent_type} failed: {exc}")
            return f'<subagent type="{subagent_type}" state="error">\n子 Agent 执行失败：{exc}\n</subagent>'
        finally:
            self._active_tasks.pop(sub_task_id, None)
            _tasks.pop(sub_task_id, None)

    async def _execute_lsp_tool(self, args: dict, workspace_id: str, ws_path: Path) -> str:
        """Handle the ``lsp`` agent tool: query language-server code intelligence.

        Best-effort and fully bounded — any missing server / disabled feature
        returns a marker string instead of raising into the agent loop.
        """
        from runtime.lsp.lsp_manager import lsp_registry

        operation = str(args.get("operation") or "").strip()
        rel_path = str(args.get("filePath") or args.get("path") or "").strip()
        if not operation:
            return "[错误] lsp 需要 operation 参数"
        if not rel_path:
            return "[错误] lsp 需要 filePath 参数"
        try:
            target = _safe_workspace_path(ws_path, rel_path, must_exist=True)
        except (PermissionError, FileNotFoundError) as exc:
            return f"[错误] {exc}"

        mgr = await lsp_registry.get(workspace_id, str(ws_path))
        if mgr is None:
            return "[LSP_DISABLED] LSP 已禁用（AUTOCODE_LSP_ENABLED=0）。"
        file_abs = str(target)
        if not await mgr.has_clients(file_abs):
            return "[LSP_UNAVAILABLE] 该文件类型没有可用的语言服务器（可能未安装对应 LSP，或非受支持语言）。"

        # line/character arrive 1-based from the model; LSP wants 0-based.
        line = max(0, int(args.get("line") or 1) - 1)
        character = max(0, int(args.get("character") or 1) - 1)

        if operation == "goToDefinition":
            res = await mgr.definition(file_abs, line, character)
        elif operation == "findReferences":
            res = await mgr.references(file_abs, line, character)
        elif operation == "hover":
            res = await mgr.hover(file_abs, line, character)
        elif operation == "goToImplementation":
            res = await mgr.implementation(file_abs, line, character)
        elif operation == "documentSymbol":
            res = await mgr.document_symbol(file_abs)
        elif operation == "workspaceSymbol":
            res = await mgr.workspace_symbol(file_abs, str(args.get("query") or ""))
        else:
            return f"[错误] 不支持的 lsp operation: {operation}"

        if not res:
            return f"[无结果] {operation} 未返回任何结果"
        import json as _json
        return f"[OK] {operation} 结果:\n" + _json.dumps(res, ensure_ascii=False, indent=2)[:4000]

    async def _diagnostics_feedback(self, workspace_id: str, ws_path: Path, rel_path: str) -> str:
        """After a successful edit, open the file in its language server and return
        a compact ``<diagnostics>`` block for any errors it introduced.

        Best-effort and fully bounded: returns an empty string when LSP is
        disabled, no server matches the file type, the wait times out, or
        anything goes wrong. Never raises into the tool dispatch path. The
        returned string (when non-empty) is meant to be appended to the edit
        tool's success message so the model sees its own compile/type errors on
        the next turn.
        """
        try:
            rel = str(rel_path or "").strip().replace("\\", "/").lstrip("/")
            # Skip internal bookkeeping files — never worth diagnosing.
            if not rel or rel.startswith(".autocode/"):
                return ""
            from runtime.lsp.lsp_manager import lsp_registry
            from runtime.lsp import format_diagnostics

            mgr = await lsp_registry.get(workspace_id, str(ws_path))
            if mgr is None:
                return ""
            file_abs = str((ws_path / rel).resolve())
            if not await mgr.has_clients(file_abs):
                return ""
            diags_map = await mgr.touch_file(file_abs, wait_diagnostics=True)
            diagnostics = diags_map.get(file_abs) or []
            block = format_diagnostics(rel, diagnostics)
            if not block:
                return ""
            return "\n\n" + block
        except Exception as exc:  # noqa: BLE001 — diagnostics must never break edits
            logger.debug(f"[LSP] diagnostics feedback skipped for {rel_path}: {exc}")
            return ""

    async def _execute_tool(
        self,
        tool_name: str,
        args: dict,
        workspace_id: str,
        ws_path: Path,
        task_id: str,
        log,
        agent_type: str,
    ) -> str:
        # Execute a tool requested by an Agent.
        try:
            task_for_event = _tasks.get(task_id)
            if task_for_event is not None:
                agent_loop.begin_tool_call(
                    task=task_for_event,
                    tool_name=tool_name,
                    args=args,
                    role=agent_type,
                )

            permission = agent_loop.check_tool_permission(
                task=task_for_event or {"id": task_id, "workspace_id": workspace_id},
                tool_name=tool_name,
                args=args,
                role=agent_type,
                workspace_root=ws_path,
            )
            if permission.decision == "deny":
                if task_for_event is not None:
                    self._persist_task(task_id)
                log("warn", f"Tool blocked by permission engine: {tool_name} - {permission.reason}", "security")
                return f"[ERROR] Tool blocked: {permission.reason}"
            spec = tool_registry.get(tool_name)
            read_only_bash = tool_name == "bash" and _is_read_only_bash(str(args.get("command", "")))
            unrestricted_workspace_tool = (
                _unrestricted_dev_mode(task_for_event)
                and tool_name in {"write_file", "apply_patch", "code_editor", "bash"}
            )
            if (
                permission.needs_approval
                and not read_only_bash
                and not unrestricted_workspace_tool
                and (spec.requires_confirmation if spec else tool_name in {"bash", "rollback", "start_preview", "spawn_subagent"})
            ):
                approval_id = f"approval-{uuid.uuid4().hex[:12]}"
                auto_approve_after = int((permission.approval_payload or {}).get("auto_approve_after_seconds") or 0)
                manual_required = bool((permission.approval_payload or {}).get("manual_required"))
                high_risk = bool((permission.approval_payload or {}).get("high_risk") or (permission.approval_payload or {}).get("destructive"))
                if task_for_event is not None:
                    approval_event = append_event(
                        task_for_event,
                        "approval_requested",
                        {
                            "approval_id": approval_id,
                            "tool": tool_name,
                            "args": args,
                            "agent": agent_type,
                            "reason": permission.reason,
                            "payload": permission.approval_payload,
                            "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                            "manual_required": manual_required,
                            "high_risk": high_risk,
                        },
                        source="permission",
                    )
                    task_for_event["status"] = "waiting_confirm"
                    task_for_event["pending_confirmation"] = {
                        "action": tool_name,
                        "path": args.get("path") or "",
                        "reason": permission.reason,
                        "event_id": approval_event.get("id"),
                        "approval_id": approval_id,
                        "payload": permission.approval_payload,
                        "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                        "manual_required": manual_required,
                        "high_risk": high_risk,
                    }
                    self._persist_task(task_id)
                log("warn", f"Tool requires approval: {tool_name} - {permission.reason}", "security")
                approved_by_countdown = False
                for waited_seconds in range(600):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and conf.get("approval_id") == approval_id:
                        _confirmations.pop(task_id, None)
                        task_after_confirm = _tasks.get(task_id)
                        if not conf.get("approved", conf.get("confirmed")):
                            if task_after_confirm is not None:
                                task_after_confirm["status"] = "cancelled"
                                task_after_confirm["current_step"] = "用户拒绝了待确认操作"
                                task_after_confirm.pop("pending_confirmation", None)
                                self._persist_task(task_id)
                            log("warn", f"User rejected tool execution: {tool_name}", "security")
                            return f"[CANCELLED] User rejected {tool_name}: {permission.reason}"
                        if task_after_confirm is not None:
                            task_after_confirm["status"] = "running"
                            task_after_confirm.pop("pending_confirmation", None)
                            self._persist_task(task_id)
                        log("success", f"User approved tool execution: {tool_name}", "security")
                        break
                    if auto_approve_after and not manual_required and not high_risk and waited_seconds + 1 >= auto_approve_after:
                        task_after_confirm = _tasks.get(task_id)
                        if task_after_confirm is not None:
                            append_event(
                                task_after_confirm,
                                "approval_resolved",
                                {
                                    "approval_id": approval_id,
                                    "event_id": approval_event.get("id") if task_for_event is not None else "",
                                    "approved": True,
                                    "auto_approved": True,
                                    "reason": f"{auto_approve_after}s countdown elapsed",
                                },
                                source="permission",
                            )
                            task_after_confirm["status"] = "running"
                            task_after_confirm.pop("pending_confirmation", None)
                            self._persist_task(task_id)
                        approved_by_countdown = True
                        log("success", f"Auto-approved tool execution after countdown: {tool_name}", "security")
                        break
                    current_task = _tasks.get(task_id)
                    if current_task and current_task.get("status") == "cancelled":
                        return "[CANCELLED] Task cancelled by user"
                else:
                    if task_for_event is not None:
                        task_for_event["status"] = "cancelled"
                        task_for_event["current_step"] = "待确认操作超时，任务已停止"
                        task_for_event.pop("pending_confirmation", None)
                        append_event(
                            task_for_event,
                            "approval_timeout",
                            {"approval_id": approval_id, "tool": tool_name, "reason": permission.reason},
                            source="permission",
                        )
                        self._persist_task(task_id)
                    return f"[TIMEOUT] Approval timed out for {tool_name}: {permission.reason}"

            read_guard_hint = ""
            if tool_name in {"read_file", "read_lines"}:
                task_for_guard = _tasks.get(task_id)
                read_guard_hint = _check_retrieval_read_guard(task_for_guard, str(args.get("path", ""))) or ""
                if read_guard_hint:
                    log("info", f"retrieval guard soft hint for {tool_name}: {args.get('path', '')}", "retrieval_guard")
                if task_for_guard is not None:
                    self._persist_task(task_id)
            artifact_probe_path = ""
            if tool_name in {"read_file", "read_lines"}:
                artifact_probe_path = str(args.get("path") or "")
            elif tool_name == "code_editor" and str(args.get("command") or "").strip() == "view":
                artifact_probe_path = str(args.get("path") or "")
            elif tool_name == "glob":
                artifact_probe_path = str(args.get("pattern") or "")
            elif tool_name == "search_code":
                artifact_probe_path = str(args.get("glob") or args.get("pattern") or "")
            artifact_block = _generated_artifact_read_block(_tasks.get(task_id), artifact_probe_path)
            if artifact_block:
                return artifact_block
            fast_edit_block = _fast_edit_read_block(_tasks.get(task_id), tool_name, artifact_probe_path)
            if fast_edit_block:
                task_for_fast_edit = _tasks.get(task_id)
                if task_for_fast_edit is not None:
                    append_event(
                        task_for_fast_edit,
                        "fast_edit_mode_entered",
                        {
                            "agent": agent_type,
                            "tool": tool_name,
                            "target": artifact_probe_path,
                        },
                        source="agent_efficiency",
                    )
                    append_event(
                        task_for_fast_edit,
                        "discovery_suppressed_fast_mode",
                        {
                            "agent": agent_type,
                            "tool": tool_name,
                            "target": artifact_probe_path,
                        },
                        source="agent_efficiency",
                    )
                    self._persist_task(task_id)
                return fast_edit_block

            task_for_local = _tasks.get(task_id)
            local_session = local_runner_manager.get_by_task(task_id)
            if (
                task_for_local
                and task_for_local.get("local_execution_enabled")
                and tool_registry.can_run_locally(tool_name)
            ):
                if not local_session:
                    local_session = await local_runner_manager.ensure_task_binding(
                        task_id,
                        str(task_for_local.get("local_runner_session_id") or ""),
                    )
                local_status = local_runner_manager.status_for_task_or_session(
                    task_id,
                    str(task_for_local.get("local_runner_session_id") or ""),
                )
                if not local_session or not local_status.get("connected"):
                    message = (
                        "本地 Runner 未连接或心跳已超时。请保持 autocode-local-runner.py 运行，"
                        "Runner 重连后点击继续。为避免本地项目与服务器镜像不一致，本次不会回退到服务器执行。"
                    )
                    append_event(
                        task_for_local,
                        "local_runner_tool_failed",
                        {
                            "tool": tool_name,
                            "args": args,
                            "error": message,
                            "connection_state": local_status.get("connection_state", "disconnected"),
                        },
                        source="local_runner",
                    )
                    self._persist_task(task_id)
                    return f"[LOCAL_RUNNER_UNAVAILABLE] {message}"

                if tool_name in {"write_file", "apply_patch"} or (
                    tool_name == "code_editor"
                    and str(args.get("command") or "").strip() in {"create", "str_replace", "insert"}
                ):
                    rel_path = _normalize_role_write_path(str(args.get("path", "")))
                    allowed, reason = _role_can_write_path(agent_type, rel_path, ws_path)
                    if not allowed:
                        task_for_grant = _tasks.get(task_id)
                        if _consume_role_write_grant(task_for_grant, agent_type, rel_path):
                            allowed = True
                            self._persist_task(task_id)
                        elif _should_auto_grant_local_role_write(task_for_grant, rel_path):
                            _grant_role_write_once(task_for_grant, agent_type, rel_path)
                            append_event(
                                task_for_grant,
                                "role_write_auto_granted",
                                {"agent": agent_type, "path": rel_path, "tool": tool_name},
                                source="security",
                            )
                            allowed = True
                            self._persist_task(task_id)
                        else:
                            await _record_role_write_block(
                                task_id=task_id,
                                agent_type=agent_type,
                                rel_path=rel_path,
                                reason=reason,
                                persist=self._persist_task,
                            )
                            allowed = await _await_role_write_confirmation(
                                task_id=task_id,
                                agent_type=agent_type,
                                rel_path=rel_path,
                                reason=reason,
                                tool_name=tool_name,
                                tool_args=args,
                                persist=self._persist_task,
                                log=log,
                            )
                            if not allowed:
                                log("warn", f"本地执行写入被角色文件边界阻止: {rel_path}", agent_type, reason)
                                return f"[错误] {reason}"
                local_args = dict(args)
                if tool_name == "bash":
                    local_args["command"] = _normalize_local_bash_command(str(local_args.get("command") or ""))

                command_record = None
                if tool_name == "bash":
                    command_record = _append_command_record(
                        task_for_local,
                        local_args.get("command", ""),
                        "running",
                        label=f"{agent_type} 本地执行命令",
                        source="local_runner",
                    )
                    self._persist_task(task_id)
                try:
                    local_result = await local_runner_manager.execute_tool(
                        task_id,
                        tool_name,
                        local_args,
                        timeout=int(local_args.get("timeout", 120) or 120) + 10,
                    )
                    output = str(local_result.get("result") or "")
                    ok = bool(local_result.get("ok", True))
                    exit_code = int(local_result.get("exit_code", 0 if ok else 1) or 0)
                    output_meta = bound_tool_output(ws_path, output, tool_name=tool_name)
                    if command_record is not None:
                        command_record.update({
                            "status": "success" if ok and exit_code == 0 else "failed",
                            "output": output_meta["preview"],
                            "output_truncated": output_meta["truncated"],
                            "output_path": output_meta["full_path"],
                            "output_sha256": output_meta["sha256"],
                            "output_chars": output_meta["chars"],
                            "output_lines": output_meta["lines"],
                            "exit_code": exit_code,
                            "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                        })
                    mirrored = False
                    if tool_name in {"write_file", "apply_patch", "code_editor"} and ok:
                        rel_path = str(local_result.get("path") or args.get("path") or "").strip().replace("\\", "/").lstrip("/")
                        content = local_result.get("content")
                        if rel_path and isinstance(content, str):
                            mirror_path = _safe_workspace_path(ws_path, rel_path, must_exist=False)
                            mirror_path.parent.mkdir(parents=True, exist_ok=True)
                            mirror_path.write_text(content, encoding="utf-8")
                            mirrored = True
                        elif rel_path and local_result.get("deleted"):
                            mirror_path = _safe_workspace_path(ws_path, rel_path, must_exist=False)
                            mirror_path.unlink(missing_ok=True)
                            mirrored = True
                    append_event(
                        task_for_local,
                        "local_runner_tool_result",
                        {
                            "tool": tool_name,
                            "args": args,
                            "ok": ok,
                            "exit_code": exit_code,
                            "result": output_meta["preview"],
                            "output_truncated": output_meta["truncated"],
                            "output_path": output_meta["full_path"],
                            "output_sha256": output_meta["sha256"],
                            "output_chars": output_meta["chars"],
                            "output_lines": output_meta["lines"],
                            "mirrored_to_workspace": mirrored,
                        },
                        source="local_runner",
                    )
                    self._persist_task(task_id)
                    prefix = "[LOCAL] "
                    exit_marker = f" [exit_code={exit_code}]" if exit_code != 0 else ""
                    if output:
                        output = output_meta["model_preview"]
                    local_result_text = (prefix + output[:4000] + exit_marker) if output else f"{prefix}[完成]"
                    # 读取预算软提示（若有）附加到读取结果末尾，不替代内容。
                    if read_guard_hint:
                        local_result_text += "\n\n" + read_guard_hint
                    return local_result_text
                except Exception as exc:
                    message = (
                        f"本地 Runner 执行失败：{exc}。为避免本地项目与服务器镜像不一致，"
                        "本地模式不会自动回退到服务器执行。请确认 Runner 已重连后继续。"
                    )
                    append_event(
                        task_for_local,
                        "local_runner_tool_failed",
                        {"tool": tool_name, "args": args, "error": str(exc), "message": message},
                        source="local_runner",
                    )
                    self._persist_task(task_id)
                    return f"[LOCAL_RUNNER_ERROR] {message}"
                    log("warn", f"本地 Runner 执行失败，回退到服务器执行: {tool_name} - {exc}", "local_runner")

            if tool_name == "read_file":
                path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                if not path.exists():
                    return f"[错误] 文件不存在: {args['path']}"
                if not path.is_file():
                    return f"[错误] 不是文件: {args['path']}"
                read_text = path.read_text(encoding="utf-8")[:3000]
                # 读取预算软提示（若有）附加到读取结果末尾，不替代内容。
                if read_guard_hint:
                    read_text += "\n\n" + read_guard_hint
                return read_text

            if tool_name == "read_lines":
                path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                if not path.exists():
                    return f"[错误] 文件不存在: {args['path']}"
                if not path.is_file():
                    return f"[错误] 不是文件: {args['path']}"
                rel_path = str(path.relative_to(ws_path)).replace("\\", "/")
                try:
                    start = int(args.get("start") or 1)
                    end = int(args.get("end") or start)
                except (TypeError, ValueError):
                    return "[错误] read_lines 需要整数 start/end 参数"
                result = _read_lines_result(path, rel_path, start, end)
                if read_guard_hint:
                    result += "\n\n" + read_guard_hint
                return result

            elif tool_name == "write_file":
                rel_path = _normalize_role_write_path(str(args.get("path", "")))
                allowed, reason = _role_can_write_path(agent_type, rel_path, ws_path)
                if not allowed:
                    task_for_grant = _tasks.get(task_id)
                    if _consume_role_write_grant(task_for_grant, agent_type, rel_path):
                        allowed = True
                        self._persist_task(task_id)
                    elif _should_auto_grant_local_role_write(task_for_grant, rel_path):
                        _grant_role_write_once(task_for_grant, agent_type, rel_path)
                        append_event(
                            task_for_grant,
                            "role_write_auto_granted",
                            {"agent": agent_type, "path": rel_path, "tool": tool_name},
                            source="security",
                        )
                        allowed = True
                        self._persist_task(task_id)
                    else:
                        await _record_role_write_block(
                            task_id=task_id,
                            agent_type=agent_type,
                            rel_path=rel_path,
                            reason=reason,
                            persist=self._persist_task,
                        )
                        allowed = await _await_role_write_confirmation(
                            task_id=task_id,
                            agent_type=agent_type,
                            rel_path=rel_path,
                            reason=reason,
                            tool_name=tool_name,
                            tool_args=args,
                            persist=self._persist_task,
                            log=log,
                        )
                        if not allowed:
                            log("warn", f"角色文件边界阻止写入: {rel_path}", agent_type, reason)
                            return f"[错误] {reason}"
                path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=False)
                parent = path.parent
                parent.mkdir(parents=True, exist_ok=True)
                if path.exists():
                    path.resolve(strict=True).relative_to(ws_path.resolve())
                    if path.is_dir():
                        return f"[错误] 不能覆盖目录: {args['path']}"
                path.write_text(args["content"], encoding="utf-8")
                if not str(path.relative_to(ws_path)).replace("\\", "/").startswith(".autocode/"):
                    invalidate_workspace_index(ws_path)
                log("success", f"已写入 {args['path']} ({len(args['content'])} 字符)", agent_type)
                feedback = await self._diagnostics_feedback(workspace_id, ws_path, args.get("path", ""))
                return f"[OK] 文件已写入: {args['path']}" + feedback

            elif tool_name == "bash":
                timeout = args.get("timeout", 120)
                task = _tasks.get(task_id)
                command_record = None
                if task:
                    command_record = _append_command_record(
                        task,
                        args["command"],
                        "running",
                        label=f"{agent_type} 执行命令",
                        source="agent",
                    )
                    self._persist_task(task_id)
                result = await docker_manager.execute_in_workspace(
                    workspace_id, args["command"], timeout=timeout,
                )
                output = result.get("stdout") or result.get("stderr") or ""
                exit_code = int(result.get("exit_code", 0) or 0)
                output_meta = bound_tool_output(ws_path, output, tool_name="bash")
                if command_record is not None:
                    command_record.update({
                        "status": "success" if exit_code == 0 else "failed",
                        "output": output_meta["preview"],
                        "output_truncated": output_meta["truncated"],
                        "output_path": output_meta["full_path"],
                        "output_sha256": output_meta["sha256"],
                        "output_chars": output_meta["chars"],
                        "output_lines": output_meta["lines"],
                        "exit_code": exit_code,
                        "finished_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
                    })
                    self._persist_task(task_id)
                if result.get("exit_code", 0) != 0:
                    log("warn", f"命令退出码 {result['exit_code']}: {args.get('command', '')}", agent_type)
                    if result.get("exit_code") == 126 or "Blocked unsafe workspace command" in output:
                        task = _tasks.get(task_id)
                        await asyncio.to_thread(harness_repository.add_event, task.get("harness_trace_id") if task else None,
                                                "security", "unsafe_command_blocked", {
                                                    "agent_type": agent_type,
                                                    "command": args.get("command", ""),
                                                    "output": output_meta["model_preview"][:500],
                                                })
                exit_marker = f" [exit_code={exit_code}]" if exit_code != 0 else ""
                if output:
                    output = output_meta["model_preview"]
                return (output[:2000] + exit_marker) or "[命令执行完成，无输出]"

            elif tool_name == "glob":
                import fnmatch
                pattern = _safe_glob_pattern(args["pattern"])
                task_for_guard = _tasks.get(task_id)
                guard = task_for_guard.get("retrieval_guard") if isinstance(task_for_guard, dict) and isinstance(task_for_guard.get("retrieval_guard"), dict) else {}
                candidate_files = list((guard or {}).get("candidate_files") or [])
                surface_candidates = _surface_map_candidates_for_task(ws_path, task_for_guard)
                broad_patterns = {"**/*", "**/*.py", "src/**/*.py", "src/**/*", "src/features/**/*.py"}
                focused_files = candidate_files or surface_candidates
                if focused_files and pattern.replace("\\", "/") in broad_patterns:
                    append_event(
                        task_for_guard,
                        "efficiency_guard_triggered",
                        {
                            "agent": agent_type,
                            "tool": "glob",
                            "pattern": pattern,
                            "reason": "broad_glob_suppressed_after_target_files",
                            "candidate_files": candidate_files[:50],
                            "surface_candidates": surface_candidates[:50],
                        },
                        source="agent_efficiency",
                    )
                    self._persist_task(task_id)
                    return (
                        "[BROAD_GLOB_SUPPRESSED] 已有明确候选文件或产品表面映射命中，续跑时不要重新全量扫描项目。\n"
                        + "\n".join(focused_files[:100])
                    )
                indexed_matches = glob_workspace_files(ws_path, pattern, limit=100)
                return "\n".join(indexed_matches[:100]) or "[no matching files]"
                skip_dirs = {".git", "node_modules", "__pycache__", ".next", "dist", "build", "venv", ".venv"}
                matches = [
                    str(p.relative_to(ws_path))
                    for p in ws_path.rglob("*")
                    if p.is_file()
                    and not any(part in skip_dirs for part in p.relative_to(ws_path).parts)
                    and fnmatch.fnmatch(str(p.relative_to(ws_path)), pattern)
                ]
                return "\n".join(matches[:100]) or "[无匹配文件]"

            elif tool_name == "search_code":
                import fnmatch as _fn
                pattern = args.get("pattern", "")
                glob_filter = args.get("glob", "")
                indexed_results = search_workspace_code(ws_path, pattern, glob_filter=glob_filter, limit=50) if pattern else []
                if pattern:
                    if not indexed_results:
                        return "[no matches]"
                    return f"found {len(indexed_results)} matches" + (" (truncated to 50)" if len(indexed_results) >= 50 else "") + "\n" + "\n".join(indexed_results)
                if not pattern:
                    return "[错误] search_code 需要 pattern 参数"
                try:
                    regex = re.compile(pattern, re.IGNORECASE)
                except re.error:
                    regex = re.compile(re.escape(pattern), re.IGNORECASE)
                skip_dirs = {".git", "node_modules", "__pycache__", ".next", "dist", "build", ".autocode", "venv", ".venv"}
                results: list[str] = []
                total_matches = 0
                max_results = 50
                for root, dirs, files in os.walk(ws_path):
                    dirs[:] = [d for d in dirs if d not in skip_dirs]
                    for fname in files:
                        if total_matches >= max_results:
                            break
                        rel = os.path.relpath(os.path.join(root, fname), ws_path).replace("\\", "/")
                        if glob_filter and not _fn.fnmatch(rel, glob_filter):
                            continue
                        fpath = os.path.join(root, fname)
                        try:
                            with open(fpath, "r", encoding="utf-8", errors="ignore") as f:
                                for line_no, line in enumerate(f, 1):
                                    if regex.search(line):
                                        snippet = line.rstrip()[:200]
                                        results.append(f"{rel}:{line_no}: {snippet}")
                                        total_matches += 1
                                        if total_matches >= max_results:
                                            break
                        except (OSError, UnicodeDecodeError):
                            continue
                    if total_matches >= max_results:
                        break
                if not results:
                    return "[无匹配结果]"
                header = f"找到 {total_matches} 个匹配" + ("（已截断至 50 条）" if total_matches >= max_results else "")
                return header + "\n" + "\n".join(results)

            elif tool_name == "lsp":
                return await self._execute_lsp_tool(args, workspace_id, ws_path)

            elif tool_name == "spawn_subagent":
                parent_project_type = str((_tasks.get(task_id) or {}).get("project_type") or "unknown")
                return await self._execute_spawn_subagent(
                    args, workspace_id, ws_path, task_id, parent_project_type, log,
                )

            elif tool_name == "apply_patch":
                rel_input = _normalize_role_write_path(str(args.get("path", "")))
                allowed, reason = _role_can_write_path(agent_type, rel_input, ws_path)
                if not allowed:
                    task_for_grant = _tasks.get(task_id)
                    if _consume_role_write_grant(task_for_grant, agent_type, rel_input):
                        self._persist_task(task_id)
                    elif _should_auto_grant_local_role_write(task_for_grant, rel_input):
                        _grant_role_write_once(task_for_grant, agent_type, rel_input)
                        append_event(
                            task_for_grant,
                            "role_write_auto_granted",
                            {"agent": agent_type, "path": rel_input, "tool": tool_name},
                            source="security",
                        )
                        allowed = True
                        self._persist_task(task_id)
                    else:
                        await _record_role_write_block(
                            task_id=task_id,
                            agent_type=agent_type,
                            rel_path=rel_input,
                            reason=reason,
                            persist=self._persist_task,
                        )
                        allowed = await _await_role_write_confirmation(
                            task_id=task_id,
                            agent_type=agent_type,
                            rel_path=rel_input,
                            reason=reason,
                            tool_name=tool_name,
                            tool_args=args,
                            persist=self._persist_task,
                            log=log,
                        )
                        if not allowed:
                            log("warn", f"角色文件边界阻止补丁: {rel_input}", agent_type, reason)
                            return f"[错误] {reason}"
                target_path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                if not target_path.exists():
                    return f"[错误] 文件不存在: {args['path']}"
                if not target_path.is_file():
                    return f"[错误] 不是文件: {args['path']}"
                original = target_path.read_text(encoding="utf-8")
                search_text = args.get("search", "")
                replace_text = args.get("replace", "")
                if not search_text:
                    return "[错误] search 参数不能为空"
                if search_text not in original:
                    # 尝试去除首尾空白后匹配

                    stripped = search_text.strip()
                    if stripped and stripped in original:
                        original = original.replace(stripped, replace_text, 1)
                    else:
                        # 返回文件中前后 500 字符帮助定位
                        preview = original[:500] if len(original) > 500 else original
                        return f"[错误] search 文本未在文件中找到匹配。文件前 500 字符:\n{preview}"
                else:
                    original = original.replace(search_text, replace_text, 1)
                target_path.write_text(original, encoding="utf-8")
                rel_path = str(target_path.relative_to(ws_path)).replace("\\", "/")
                if not rel_path.startswith(".autocode/"):
                    invalidate_workspace_index(ws_path)
                log("success", f"精确编辑: {rel_path}", agent_type)
                return f"[OK] 已编辑 {rel_path}（search/replace 成功）" + await self._diagnostics_feedback(workspace_id, ws_path, rel_path)

            elif tool_name == "code_editor":
                command = str(args.get("command") or "").strip()
                rel_input = _normalize_role_write_path(str(args.get("path", "")))
                if command in ("create", "str_replace", "insert"):
                    allowed, reason = _role_can_write_path(agent_type, rel_input, ws_path)
                    if not allowed:
                        task_for_grant = _tasks.get(task_id)
                        if _consume_role_write_grant(task_for_grant, agent_type, rel_input):
                            allowed = True
                            self._persist_task(task_id)
                        elif _should_auto_grant_local_role_write(task_for_grant, rel_input):
                            _grant_role_write_once(task_for_grant, agent_type, rel_input)
                            append_event(
                                task_for_grant,
                                "role_write_auto_granted",
                                {"agent": agent_type, "path": rel_input, "tool": tool_name},
                                source="security",
                            )
                            allowed = True
                            self._persist_task(task_id)
                        else:
                            await _record_role_write_block(
                                task_id=task_id,
                                agent_type=agent_type,
                                rel_path=rel_input,
                                reason=reason,
                                persist=self._persist_task,
                            )
                            allowed = await _await_role_write_confirmation(
                                task_id=task_id,
                                agent_type=agent_type,
                                rel_path=rel_input,
                                reason=reason,
                                tool_name=tool_name,
                                tool_args=args,
                                persist=self._persist_task,
                                log=log,
                            )
                            if not allowed:
                                log("warn", f"角色文件边界阻止编辑器写入: {rel_input}", agent_type, reason)
                                return f"[错误] {reason}"
                undo_key = f"{ws_path}::{rel_input}"

                if command == "view":
                    target = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                    if not target.is_file():
                        return f"[错误] 不是文件: {args['path']}"
                    all_lines = target.read_text(encoding="utf-8").splitlines()
                    start, end = 1, len(all_lines)
                    view_range = args.get("view_range")
                    if isinstance(view_range, (list, tuple)) and len(view_range) == 2:
                        start = max(1, int(view_range[0]))
                        end = min(len(all_lines), int(view_range[1]))
                    numbered = "\n".join(f"{i:>6}\t{all_lines[i - 1]}" for i in range(start, end + 1))
                    return f"[OK] {rel_input} 第 {start}-{end} 行（共 {len(all_lines)} 行）:\n{numbered}"

                if command == "create":
                    path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=False)
                    path.parent.mkdir(parents=True, exist_ok=True)
                    if path.exists() and path.is_dir():
                        return f"[错误] 不能覆盖目录: {args['path']}"
                    old_text = path.read_text(encoding="utf-8") if path.is_file() else None
                    new_text = str(args.get("file_text", ""))
                    _atomic_write_text(path, new_text)
                    _code_editor_push_undo(undo_key, old_text)
                    rel_path = str(path.relative_to(ws_path)).replace("\\", "/")
                    if not rel_path.startswith(".autocode/"):
                        invalidate_workspace_index(ws_path)
                    diff = _unified_diff_text(old_text or "", new_text, rel_path)
                    log("success", f"编辑器写入: {rel_path} ({len(new_text)} 字符)", agent_type)
                    diagnostics = await self._diagnostics_feedback(workspace_id, ws_path, rel_path)
                    return f"[OK] 文件已写入: {rel_path}\n{diff}{diagnostics}"

                if command == "str_replace":
                    target = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                    if not target.is_file():
                        return f"[错误] 不是文件: {args['path']}"
                    # newline="" 关闭通用换行翻译，保留文件真实的 \r\n，供下方检测换行风格与撤销还原。
                    with open(target, "r", encoding="utf-8", newline="") as _fh:
                        original = _fh.read()
                    old_str = str(args.get("old_str", ""))
                    new_str = str(args.get("new_str", ""))
                    if not old_str:
                        return "[错误] old_str 参数不能为空"
                    # 换行符容错：文件可能是 CRLF，而 old_str 经传输被规范化为 LF（反之亦然）。
                    # 统一到 LF 空间做匹配与替换，写回时保留文件原本的换行风格。
                    uses_crlf = "\r\n" in original
                    work = original.replace("\r\n", "\n")
                    old_norm = old_str.replace("\r\n", "\n")
                    new_norm = new_str.replace("\r\n", "\n")
                    occurrences = work.count(old_norm)
                    if occurrences == 0:
                        preview = original[:500]
                        return f"[错误] old_str 未在文件中找到匹配。文件前 500 字符:\n{preview}"
                    if occurrences > 1:
                        return f"[错误] old_str 匹配到 {occurrences} 处，必须唯一匹配，请扩大上下文范围"
                    replaced = work.replace(old_norm, new_norm, 1)
                    updated = replaced.replace("\n", "\r\n") if uses_crlf else replaced
                    _atomic_write_text(target, updated)
                    _code_editor_push_undo(undo_key, original)
                    rel_path = str(target.relative_to(ws_path)).replace("\\", "/")
                    if not rel_path.startswith(".autocode/"):
                        invalidate_workspace_index(ws_path)
                    diff = _unified_diff_text(original, updated, rel_path)
                    log("success", f"编辑器替换: {rel_path}", agent_type)
                    diagnostics = await self._diagnostics_feedback(workspace_id, ws_path, rel_path)
                    return f"[OK] 已替换 {rel_path} 中唯一匹配段\n{diff}{diagnostics}"

                if command == "insert":
                    target = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                    if not target.is_file():
                        return f"[错误] 不是文件: {args['path']}"
                    # newline="" 关闭通用换行翻译，保留文件真实的 \r\n。
                    with open(target, "r", encoding="utf-8", newline="") as _fh:
                        original = _fh.read()
                    new_str = str(args.get("new_str", ""))
                    if not new_str:
                        return "[错误] new_str 参数不能为空"
                    insert_line = int(args.get("insert_line", -1))
                    # 保留文件原本的换行风格：CRLF 文件插入后仍写回 CRLF。
                    newline = "\r\n" if "\r\n" in original else "\n"
                    work = original.replace("\r\n", "\n")
                    new_norm = new_str.replace("\r\n", "\n")
                    lines = work.split("\n")
                    trailing_newline = work.endswith("\n")
                    if trailing_newline:
                        lines.pop()
                    if insert_line < 0 or insert_line > len(lines):
                        return f"[错误] insert_line 超出范围（0-{len(lines)}，0 表示插入到文件开头）"
                    lines.insert(insert_line, new_norm)
                    updated = newline.join(lines) + (newline if trailing_newline else "")
                    _atomic_write_text(target, updated)
                    _code_editor_push_undo(undo_key, original)
                    rel_path = str(target.relative_to(ws_path)).replace("\\", "/")
                    if not rel_path.startswith(".autocode/"):
                        invalidate_workspace_index(ws_path)
                    diff = _unified_diff_text(original, updated, rel_path)
                    log("success", f"编辑器插入: {rel_path} 第 {insert_line} 行后", agent_type)
                    return f"[OK] 已在 {rel_path} 第 {insert_line} 行后插入内容\n{diff}" + await self._diagnostics_feedback(workspace_id, ws_path, rel_path)

                if command == "undo_edit":
                    stack = _CODE_EDITOR_UNDO.get(undo_key)
                    if not stack:
                        return f"[错误] 没有可撤销的编辑: {rel_input}"
                    previous = stack.pop()
                    path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=False)
                    if previous is None:
                        path.unlink(missing_ok=True)
                        log("success", f"编辑器撤销: 删除新建文件 {rel_input}", agent_type)
                        return f"[OK] 已撤销创建，文件已删除: {rel_input}"
                    _atomic_write_text(path, previous)
                    rel_path = str(path.relative_to(ws_path)).replace("\\", "/")
                    if not rel_path.startswith(".autocode/"):
                        invalidate_workspace_index(ws_path)
                    log("success", f"编辑器撤销: {rel_path}", agent_type)
                    return f"[OK] 已恢复上次编辑前的内容: {rel_path}"

                return f"[错误] 未知 code_editor 命令: {command}"

            elif tool_name == "git_commit":
                status = git_manager.status(ws_path)
                if not status.get("dirty"):
                    return "[OK] No changes to commit; the latest automatic snapshot already represents this workspace state."
                message = args.get("message") or "AutoCode update"
                hash_ = git_manager.auto_commit(ws_path, ["."], message)
                if not hash_:
                    return "[OK] No commit created; there were no commit-worthy changes after filtering volatile files."
                log("success", f"Git 提交: {message}", agent_type)
                return f"[OK] 提交 {str(hash_)[:12]}: {message}"

            elif tool_name == "request_confirmation":
                task = _tasks.get(task_id)
                approval_id = f"approval-{uuid.uuid4().hex[:12]}"
                event_id = ""
                confirm_path = _normalize_role_write_path(str(args.get("path") or ""))
                confirm_reason = str(args.get("reason") or "需要用户确认后继续。")
                if task:
                    approval_event = append_event(
                        task,
                        "approval_requested",
                        {
                            "approval_id": approval_id,
                            "tool": "request_confirmation",
                            "action": args.get("action") or "manual_confirmation",
                            "path": confirm_path,
                            "agent": agent_type,
                            "reason": confirm_reason,
                            "message": confirm_reason,
                            "payload": dict(args),
                            "auto_approve_after_seconds": 0,
                            "manual_required": True,
                            "high_risk": bool(args.get("high_risk", False)),
                        },
                        source="agent",
                    )
                    event_id = str(approval_event.get("id") or "")
                    task["status"] = "waiting_confirm"
                    task["pending_confirmation"] = {
                        "action": args.get("action") or "manual_confirmation",
                        "path": confirm_path,
                        "reason": confirm_reason,
                        "event_id": event_id,
                        "approval_id": approval_id,
                        "payload": dict(args),
                        "manual_required": True,
                        "high_risk": bool(args.get("high_risk", False)),
                        "auto_approve_after_seconds": 0,
                    }
                    self._persist_task(task_id)
                    log("warn", f"Waiting user confirm: {args.get('action')} {confirm_path}", agent_type)

                for _ in range(300):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and (conf.get("approved") or conf.get("confirmed")):
                        _confirmations.pop(task_id, None)
                        task = _tasks.get(task_id)
                        if task:
                            task["status"] = "running"
                            task.pop("pending_confirmation", None)
                            if confirm_path:
                                _grant_role_write_once(task, agent_type, confirm_path)
                            self._persist_task(task_id)
                        log("success", f"User confirmed: {confirm_path}", agent_type)
                        original_tool = str(args.get("tool") or "").strip()
                        original_args = args.get("tool_args") if isinstance(args.get("tool_args"), dict) else None
                        if original_tool in {"apply_patch", "code_editor", "write_file"} and original_args:
                            original_path = _normalize_role_write_path(str(original_args.get("path") or confirm_path))
                            if original_path == confirm_path:
                                executed = await self._execute_tool(
                                    original_tool,
                                    dict(original_args),
                                    workspace_id,
                                    ws_path,
                                    task_id,
                                    log,
                                    agent_type,
                                )
                                return (
                                    f"[CONFIRMED_AND_EXECUTED] {args.get('action') or 'manual_confirmation'} approved by user.\n"
                                    f"[{original_tool} result]\n{executed}"
                                )
                        return f"[CONFIRMED] {args.get('action') or 'manual_confirmation'} approved by user"
                    task = _tasks.get(task_id)
                    if task and task["status"] == "cancelled":
                        return "[CANCELLED] Task cancelled by user"

                return "[TIMEOUT] No confirmation in 5 minutes, cancelled"

            elif tool_name == "generate_prototype":
                from core.prototype_generator import generate_prototype, save_prototype
                log("info", f"正在生成 UI 原型: {args.get('description', '')[:60]}...", agent_type)
                prototype_model = _tasks.get(task_id, {}).get("model")
                prototype_llm = await self._ensure_client(requested_model=prototype_model)
                result = await generate_prototype(args["description"], llm_client=prototype_llm)
                html = result.get("html", "")
                if html:
                    saved_path = save_prototype(ws_path, html)
                    preview_url = f"/workspaces/{workspace_id}/preview/.autocode/prototype/index.html"
                    log("success", f"UI 原型已生成: {result.get('title', '')} -> {preview_url}", agent_type)
                    return f"[OK] UI 原型已生成并保存。标题: {result.get('title', '')}。特性: {', '.join(result.get('features', []))}。预览地址: {preview_url}。"
                return "[错误] 原型生成失败：未获得 HTML 代码"

        except Exception as e:
            log("error", f"工具执行失败: {tool_name} -> {e}", agent_type)
            return f"[错误] {e}"

        return "[未知工具]"


agent_orchestrator = AgentOrchestrator()
