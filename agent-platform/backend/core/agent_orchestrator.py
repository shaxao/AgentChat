# -*- coding: utf-8 -*-
"""
Agent Orchestrator 鈥?Provider-agnostic 澶?Agent 鍗忎綔缂栨帓锛堝€熼壌 OpenCode 鏋舵瀯锛?

鏍稿績鏀瑰姩锛坴2.0锛夛細
- LLM 璋冪敤锛欰nthropic SDK 鈫?LLMClient 缁熶竴鎶借薄锛堟敮鎸?DeepSeek/Kimi/Qwen/Claude锛?
- 妯″瀷閫夋嫨锛氱‖缂栫爜 MODEL_PREFERENCES 鈫?channel_service.select_best_tool_model()
- 宸ュ叿鏍煎紡锛欰nthropic MCP (input_schema) 鈫?OpenAI function calling
- 鍝嶅簲瑙ｆ瀽锛歜lock.type == "tool_use" 鈫?response.tool_calls

娴佺▼涓嶅彉锛?
1. 鐞嗚В鐢ㄦ埛闇€姹?鈫?鎷嗚В涓哄瓙浠诲姟
2. 鍚姩瀵瑰簲绫诲瀷鐨?Agent 骞惰鎵ц
3. 鍚?Agent 鍦ㄩ殧绂?Workspace 涓搷浣滐紙鏂囦欢璇诲啓 / bash / git锛?
4. 鍗遍櫓鎿嶄綔锛堝垹闄?瑕嗙洊锛夋殏鍋滐紝绛夊緟鐢ㄦ埛纭
5. 鏋勫缓 鈫?棰勮 鈫?鐢ㄦ埛楠屾敹 鈫?杩唬鎴栭儴缃?
"""
import asyncio
import json
import os
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
    render_retrieval_plan,
    search_workspace_code,
)
from core.state import _tasks, _confirmations
from core.review_agent import ReviewAgent
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


def _read_json_file(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}


def _select_validation_command(ws_path: Path, project_type: str = "") -> tuple[str | None, str]:
    package = _read_json_file(ws_path / "package.json") if (ws_path / "package.json").exists() else {}
    scripts = package.get("scripts") or {}
    if scripts:
        for name in ("build", "test", "lint", "typecheck", "check"):
            if name in scripts:
                return f"npm run {name}", f"package.json script: {name}"
        return "npm install --package-lock=false --dry-run", "package.json dependency dry-run"

    if (ws_path / "pyproject.toml").exists() or (ws_path / "requirements.txt").exists() or any(ws_path.glob("*.py")):
        if (ws_path / "tests").exists() or any(ws_path.glob("test_*.py")):
            return "python -m pytest", "Python tests"
        return "python -m compileall .", "Python syntax compile"

    if (ws_path / "pom.xml").exists():
        return "mvn test", "Maven test"
    if (ws_path / "build.gradle").exists() or (ws_path / "settings.gradle").exists():
        if (ws_path / "gradlew").exists():
            return "./gradlew test", "Gradle wrapper test"
        return "gradle test", "Gradle test"
    if (ws_path / "go.mod").exists():
        return "go test ./...", "Go tests"
    if (ws_path / "Cargo.toml").exists():
        return "cargo test", "Rust tests"

    shell_scripts = list(ws_path.glob("*.sh"))
    if shell_scripts:
        return "bash -n " + " ".join(str(p.name) for p in shell_scripts[:5]), "Shell syntax check"
    ps_scripts = list(ws_path.glob("*.ps1"))
    if ps_scripts:
        return "pwsh -NoProfile -Command \"Get-ChildItem *.ps1 | ForEach-Object { $null = [scriptblock]::Create((Get-Content $_ -Raw)) }\"", "PowerShell syntax check"

    return None, "no validation command detected"


def _has_source_file(files: list[str] | tuple[str, ...] | set[str]) -> bool:
    for raw in files or []:
        path = str(raw).replace("\\", "/").lstrip("/")
        if path.startswith(".autocode/"):
            continue
        if Path(path).suffix.lower() in SOURCE_FILE_SUFFIXES:
            return True
    return False


def _subtask_expects_source(subtask: SubTask, project_type: str = "") -> bool:
    text = " ".join([
        subtask.title or "",
        subtask.description or "",
        " ".join(str(p) for p in (subtask.estimated_files or [])),
    ]).lower()
    # 楠岃瘉/鏂囨。绫婚樁娈碉紙鍐掔儫娴嬭瘯銆佷娇鐢ㄨ鏄庛€丷EADME锛変笉瑕佹眰浜у嚭婧愮爜锛?
    # 鍗充娇 estimated_files 涓垪鍑轰簡婧愮爜鏂囦欢锛堝彲鑳芥槸鍥犱负寮曠敤浜嗗疄鐜伴樁娈电殑鏂囦欢锛夈€?
    doc_phase_tokens = (
        "smoke test", "usage notes", "usage guide", "readme", "document", "docs",
        "鍐掔儫娴嬭瘯", "浣跨敤璇存槑", "浣跨敤鎸囧崡", "璇存槑", "鏂囨。",
    )
    if any(token in text for token in doc_phase_tokens):
        return False
    doc_only_tokens = (
        "濂戠害", "璇存槑", "鏂囨。", "姊崇悊", "鍏ュ彛", "鍘熷瀷", "璁″垝", "瀹℃煡", "浣跨敤璇存槑", "鍐掔儫娴嬭瘯",
        "濂戠害", "contract", "璇存槑", "鏂囨。", "姊崇悊", "map", "鍘熷瀷", "prototype",
        "璁″垝", "plan", "瀹℃煡", "review",
    )
    implementation_tokens = (
        "实现", "开发", "核心行为", "功能", "修复", "改动", "代码", "源码",
        "implement", "build", "fix", "feature",
    )
    if any(Path(str(p)).suffix.lower() in SOURCE_FILE_SUFFIXES for p in (subtask.estimated_files or [])):
        return True
    is_doc_only = any(token in text for token in doc_only_tokens)
    if any(token in text for token in implementation_tokens) and not is_doc_only:
        return True
    if any(token in text for token in ("实现", "核心行为", "源码", "代码", "功能", "implement", "feature")) and not is_doc_only:
        return True
    return False


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
    budget = max(0, int(guard.get("read_budget") or 3))
    if len(read_files) >= budget and not is_candidate:
        append_event(
            task,
            "retrieval_guard_blocked",
            {
                "path": rel_path,
                "read_budget": budget,
                "read_count": len(read_files),
                "candidate": False,
                "candidate_files": list(candidate_files)[:50],
            },
            source="retrieval_guard",
        )
        return (
            "[READ_BUDGET_BLOCKED] 当前增量任务已达到源码读取预算。"
            "请优先基于 .autocode/RETRIEVAL_PLAN.md 的 Candidate Files 修改；"
            f"如必须读取 `{rel_path}`，请先用现有上下文说明原因并收敛目标。"
        )
    read_files.append(rel_path)
    guard["read_files"] = read_files
    append_event(
        task,
        "retrieval_guard_accounted",
        {
            "path": rel_path,
            "read_budget": budget,
            "read_count": len(read_files),
            "candidate": is_candidate,
        },
        source="retrieval_guard",
    )
    return None


def _is_read_only_bash(command: str) -> bool:
    normalized = re.sub(r"\s+", " ", str(command or "").strip())
    if not normalized:
        return False
    lowered = normalized.lower()
    risky_tokens = (
        " >", ">", "| tee", "rm ", "del ", "erase ", "mv ", "move ", "cp ", "copy ",
        "mkdir", "touch", "sed -i", "python -c", "python3 -c", "node -e", "npm ", "pnpm ",
        "yarn ", "pip ", "mvn ", "gradle ", "go test", "go build", "cargo ", "docker ",
    )
    if any(token in lowered for token in risky_tokens):
        return False
    return any(lowered == prefix or lowered.startswith(prefix + " ") for prefix in READ_ONLY_BASH_PREFIXES)


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
        "濂戠害", "璁″垝", "瑙勫垝", "璁捐", "鏋舵瀯", "瑙勮寖", "璇存槑", "鏂囨。",
        "姊崇悊", "鍏ュ彛", "浣跨敤璇存槑", "鍐掔儫娴嬭瘯", "鏄庣‘鑴氭湰濂戠害",
        "濂戠害", "璁″垝", "瑙勫垝", "璁捐", "鏋舵瀯", "瑙勮寖", "璇存槑", "鏂囨。",
        "姊崇悊", "鍏ュ彛", "浣跨敤璇存槑", "鍐掔儫娴嬭瘯", "鏄庣‘鑴氭湰濂戠害",
    )
    implementation_keywords = (
        "implement", "coding", "code", "core script behavior", "fix",
        "feature", "api", "frontend", "backend logic",
        "瀹炵幇", "缂栫爜", "浠ｇ爜", "鏍稿績琛屼负", "淇", "鍔熻兘", "鍓嶇", "鍚庣閫昏緫",
        "瀹炵幇", "缂栫爜", "浠ｇ爜", "鏍稿績琛屼负", "淇", "鍔熻兘", "鍓嶇", "鍚庣閫昏緫",
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


def _agent_iteration_policy(task: dict | None, description: str, has_memory_context: bool) -> tuple[int, int]:
    """Return (max_iterations, context_compress_interval) for an agent run."""
    task = task or {}
    recon = task.get("project_recon") or {}
    complexity = str(recon.get("complexity") or "").upper()
    flow = str(recon.get("recommended_flow") or "")
    desc = (description or "").lower()
    if any(marker in desc for marker in ("ai 助手增量开发请求", "强制续改", "chat continuation", "continue development")):
        continuation_iterations = int(os.getenv("AUTOCODE_CHAT_CONTINUATION_MAX_ITERATIONS", "24"))
        return max(S0_LIGHT_MAX_ITERATIONS, continuation_iterations), 12
    is_s0_light = complexity == "S0" or flow in {"light_script", "light_tool"}
    if is_s0_light:
        is_contract_or_docs = any(
            keyword in desc
            for keyword in (
                "define script contract", "script_contract.md", "contract",
                "usage notes", "smoke test", "readme",
                "鏄庣‘鑴氭湰濂戠害", "浣跨敤璇存槑", "鍐掔儫娴嬭瘯",
            )
        )
        max_iterations = S0_CONTRACT_MAX_ITERATIONS if is_contract_or_docs else S0_LIGHT_MAX_ITERATIONS
        return max(4, max_iterations), max(24, max_iterations + 6)

    max_iterations = DEFAULT_MAX_ITERATIONS
    if has_memory_context:
        max_iterations = int(DEFAULT_MAX_ITERATIONS * 1.5)
    return max_iterations, 12


def _count_source_files(ws_path: Path) -> int:
    count = 0
    if not ws_path.exists():
        return 0
    for path in ws_path.rglob("*"):
        if not path.is_file() or path.suffix not in SOURCE_FILE_SUFFIXES:
            continue
        try:
            rel = path.relative_to(ws_path)
        except ValueError:
            continue
        if any(part in IGNORED_WORKSPACE_PARTS for part in rel.parts):
            continue
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
- 代码审查：{review_line}
- 预览地址：{preview}

主要修改文件：
{file_lines}{more}

你可以在文件面板查看源码，在 Git 面板查看自动快照和 Diff，也可以继续在 AI 助手里要求我运行测试、打开文件或回退到某次提交。"""


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
- 代码审查：{review_line}
- 预览地址：{preview}

主要修改文件：
{file_lines}{more}

你可以在文件面板查看源码，在 Git 面板查看自动快照和 Diff，也可以继续在 AI 助手里要求我运行测试、打开文件或回退到某次提交。"""


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
            content = f"[宸ュ叿璋冪敤: {', '.join(tool_names)}]"
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


# 鈹€鈹€鈹€ 鐜鍙橀噺瑕嗙洊 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
DEFAULT_MODEL = os.getenv("AUTOCODE_MODEL", "")
DEFAULT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_MAX_ITERATIONS", "60"))
S0_CONTRACT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_S0_CONTRACT_MAX_ITERATIONS", "8"))
S0_LIGHT_MAX_ITERATIONS = int(os.getenv("AUTOCODE_S0_LIGHT_MAX_ITERATIONS", "18"))
MAX_INSTALL_RETRIES = int(os.getenv("AUTOCODE_MAX_INSTALL_RETRIES", "3"))


# 鈹€鈹€鈹€ Agent System Prompt 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
AGENT_SYSTEM_PROMPTS = {
    "frontend": """你是一个自主前端开发 Agent。收到任务后按 Agentic Loop 工作：观察项目结构，读取相关文件，做最小必要修改，运行构建或类型检查，失败则继续分析并修复。

关键要求：
- 不要一开始覆盖整个文件；优先 search_code/read_file 定位后再 apply_patch。
- 写入后必须运行合适验证，例如 npm run build、npm test、tsc。
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
}


def _agent_ownership_prompt(agent_type: str) -> str:
    policies = {
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
    policy = policies.get(agent_type, policies["frontend"])
    return (
        "## Agent 鏂囦欢鎵€鏈夋潈杈圭晫\n"
        f"- 褰撳墠瑙掕壊: `{agent_type}`\n"
        f"- 浼樺厛璐熻矗: {', '.join(policy['allowed'])}\n"
        f"- 璺ㄨ竟鐣屼慨鏀瑰墠鍏堣鏄庣悊鐢? {', '.join(policy['ask'])}\n"
        f"- 榛樿閬垮厤淇敼: {', '.join(policy['avoid'])}\n"
        "- 濡傛灉蹇呴』璺ㄨ竟鐣屼慨鏀癸紝璇峰湪鍥炲涓槑纭鏄庡師鍥犮€佹秹鍙婃枃浠跺拰椋庨櫓銆俓n"
    )


def _agent_ownership_prompt(agent_type: str) -> str:
    policies = {
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
    policy = policies.get(agent_type, policies["frontend"])
    return (
        "## Agent 鏂囦欢鎵€鏈夋潈杈圭晫\n"
        f"- 褰撳墠瑙掕壊: `{agent_type}`\n"
        f"- 浼樺厛璐熻矗: {', '.join(policy['allowed'])}\n"
        f"- 璺ㄨ竟鐣屼慨鏀瑰墠鍏堣鏄庣悊鐢? {', '.join(policy['ask'])}\n"
        f"- 榛樿閬垮厤淇敼: {', '.join(policy['avoid'])}\n"
        "- 濡傛灉蹇呴』璺ㄨ竟鐣屼慨鏀癸紝璇峰湪鍥炲涓槑纭鏄庡師鍥犮€佹秹鍙婃枃浠跺拰椋庨櫓銆俓n"
    )


ROLE_FILE_OWNERSHIP = {
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
        parsed = [p.strip().strip("`") for p in re.split(r"[,锛宂", patterns) if p.strip()]
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
        parsed = [p.strip().strip("`") for p in re.split(r"[,锛孿n]", patterns) if p.strip()]
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
            for item in re.split(r"[,锛孿s]+", patterns)
            if item.strip()
        ]
        parsed = [item for item in tokens if item and item not in {"-", "[]"}]
        if parsed:
            rules[role] = parsed
    return rules


def _role_can_write_path(agent_type: str, rel_path: str, ws_path: Path | None = None) -> tuple[bool, str]:
    normalized = rel_path.replace("\\", "/").lstrip("/")
    if normalized.startswith(".autocode/CHAT.md") or normalized.startswith(".autocode/MEMORY.md"):
        return True, ""
    if normalized.startswith(".git/"):
        return False, "Git internal files are never writable by agents"
    workspace_rules = _load_workspace_role_ownership(ws_path)
    allowed = (
        workspace_rules.get(agent_type)
        or workspace_rules.get(agent_type.lower())
        or ROLE_FILE_OWNERSHIP.get(agent_type)
        or ROLE_FILE_OWNERSHIP.get("frontend", [])
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
        "Use the owning role or update .autocode/ROLE_OWNERSHIP.md before crossing boundaries."
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
                "ownership_file": ".autocode/ROLE_OWNERSHIP.md",
            },
            source="security",
        )
        persist(task_id)


WORKSPACE_SECURITY_RULES = """

瀹夊叏杈圭晫锛?
- 鍙兘鎿嶄綔褰撳墠浠诲姟鐨?/workspace 鐩綍銆?
- 绂佹璇诲彇銆佸垪鍑恒€佹悳绱㈡垨淇敼 /workspace/..銆佸涓绘満璺緞銆佸叾浠?workspace銆佺郴缁熺洰褰曞拰鐢ㄦ埛鐩綍銆?
- 鎵€鏈?read_file/write_file/glob 璺緞蹇呴』鏄浉瀵硅矾寰勶紝鎴栦互 /workspace/ 寮€澶淬€?
- bash 鍛戒护涓嶅緱浣跨敤 .. 璺緞绌胯秺锛屼笉寰楁壂鎻?/銆?workspace/..銆?data銆?tmp/autocode-workspaces 绛夌洰褰曘€?
"""

AGENT_SYSTEM_PROMPTS = {
    key: value + WORKSPACE_SECURITY_RULES
    for key, value in AGENT_SYSTEM_PROMPTS.items()
}


# 鈹€鈹€鈹€ Agent 宸ュ叿瀹氫箟锛圤penAI function calling 鏍煎紡锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
# Effective Agent tool schema is generated from the unified registry so model tool use,
# permissions, activity labels, and local-runner capability stay aligned.
AGENT_TOOLS = tool_registry.agent_tool_definitions()


class AgentOrchestrator:
    """
    澶?Agent 缂栨帓鍣紙v2.0 鈥?Provider 鏃犲叧锛夈€?

    - 閫氳繃 channel_service 鍔ㄦ€侀€夋嫨鏈€浣崇殑 tool-capable 妯″瀷
    - 浣跨敤 LLMClient 缁熶竴鎶借薄涓嶅悓 LLM 鎻愪緵鍟?
    - 宸ュ叿瀹氫箟浣跨敤 OpenAI function calling 鏍煎紡
    - 鍙?OpenCode 鏋舵瀯鍚彂
    """

    def __init__(self):
        self._llm: Optional[LLMClient] = None
        self._settings = get_settings()
        self._active_tasks: dict[str, bool] = {}  # task_id -> running
        self._model: Optional[str] = None
        self._channel_config: Optional[dict] = None
        # 瀵硅瘽娑堟伅闃熷垪锛氱敤鎴峰彂閫佺殑娑堟伅锛孉gent 寰幆鍙栬蛋澶勭悊
        self._user_message_queues: dict[str, list[dict]] = {}
        # SSE 鎺ㄩ€侀槦鍒楋細Agent 澶勭悊缁撴灉鎺ㄩ€佺粰鍓嶇鐨勫璇?
        self._chat_sse_queues: dict[str, asyncio.Queue] = {}
        # 绛夊緟娑堟伅鐨勪簨浠讹細Agent 寰幆绛夊緟鐢ㄦ埛娑堟伅鏃朵娇鐢?
        self._message_events: dict[str, asyncio.Event] = {}
        # 鏅鸿兘璺敱锛氭ā鍨嬭矾鐢卞櫒 + FailoverLLMClient 缂撳瓨
        self._router = model_router
        self._failover_clients: dict[str, FailoverLLMClient] = {}
        self._explicit_model_clients: dict[str, LLMClient] = {}
        # 浠诲姟涓婁笅鏂囩紦瀛橈紙閬垮厤閲嶅妫€娴嬪鏉傚害锛?
        self._task_contexts: dict[str, TaskContext] = {}

    async def _ensure_client(self, ctx: TaskContext | None = None, requested_model: str | None = None) -> LLMClient | FailoverLLMClient:
        """
        寤惰繜鍒濆鍖?LLM 瀹㈡埛绔€?

        浼樺厛绾э細
        1. 鐜鍙橀噺锛圓UTOCODE_MODEL锛夆啋 寮€鍙?娴嬭瘯鐜
        2. 鏅鸿兘璺敱锛圡odelRouter锛夆啋 鐢熶骇鐜锛堟湁 TaskContext 鏃朵紭鍏堬級
        3. 鍥為€€閫夋嫨锛坰elect_best_tool_model锛夆啋 鏁版嵁搴撴棤璺敱瑙勫垯鏃?
        """
        requested_model = (requested_model or "").strip()
        if requested_model and ctx is None:
            if requested_model in self._explicit_model_clients:
                self._model = requested_model
                return self._explicit_model_clients[requested_model]

            result = resolve_channel_for_model(requested_model)
            if not result:
                raise RuntimeError(f"鎸囧畾妯″瀷涓嶅彲鐢ㄦ垨鏈厤缃笭閬? {requested_model}")

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
                f"[Orchestrator] 浣跨敤浠诲姟鎸囧畾妯″瀷: {requested_model} "
                f"via {channel.provider}/{channel.name}"
            )
            return client

        # 濡傛灉宸叉湁瀹㈡埛绔笖鏃犳柊涓婁笅鏂囷紝鐩存帴杩斿洖
        if self._llm is not None and ctx is None:
            return self._llm

        # 浼樺厛浣跨敤鐜鍙橀噺閰嶇疆锛堥€傜敤浜庢湰鍦板紑鍙?娴嬭瘯鐜锛?
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
            logger.info(f"[Orchestrator] 浣跨敤鐜鍙橀噺閰嶇疆: model={env_model} provider={env_provider}")
            self._model = env_model
            self._channel_config = {
                "api_key": env_api_key,
                "base_url": env_base_url or None,
                "provider": env_provider,
                "model": env_model,
            }
            self._llm = create_client_from_channel(self._channel_config, timeout=180.0)
            logger.info(f"[Orchestrator] 宸插垵濮嬪寲 LLM 瀹㈡埛绔?(鐜鍙橀噺妯″紡)")
            return self._llm

        # 鈹€鈹€ 鏅鸿兘璺敱妯″紡锛堢敓浜х幆澧冿級鈹€鈹€
        if ctx is not None:
            if requested_model:
                logger.info(
                    "[Orchestrator] task requested model=%s; using routed failover mode for agent execution",
                    requested_model,
                )
            ctx_key = f"{ctx.agent_type}|{ctx.task_phase}|{ctx.complexity}"
            if ctx_key in self._failover_clients:
                cached = self._failover_clients[ctx_key]
                current = cached.current_model or cached._candidates[0].model_id
                self._model = current
                self._channel_config = cached._candidates[0].to_channel_config()
                return cached

            try:
                logger.info(
                    f"[Orchestrator] 馃 鏅鸿兘璺敱: agent={ctx.agent_type} "
                    f"phase={ctx.task_phase} complexity={ctx.complexity} "
                    f"caps={ctx.required_capabilities}"
                )
                candidates = await self._router.select(ctx)

                if not candidates:
                    logger.warning("[Orchestrator] 鏅鸿兘璺敱鏈壘鍒板€欓€夛紝鍥為€€鍒伴粯璁ら€夋嫨")
                else:
                    # 鍒涘缓 FailoverLLMClient锛堜富妯″瀷 + 2 涓閫夛級
                    fclient = FailoverLLMClient(candidates, base_timeout=180.0)
                    self._failover_clients[ctx_key] = fclient

                    best = candidates[0]
                    self._model = best.model_id
                    self._channel_config = best.to_channel_config()
                    self._llm = fclient._get_or_create_client(best)

                    logger.info(
                        f"[Orchestrator] 鉁?鏅鸿兘璺敱閫夊畾: {best.model_id} "
                        f"(score={best.score:.3f} provider={best.provider}) "
                        f"澶囬€? {[c.model_id for c in candidates[1:3]]}"
                    )
                    return fclient

            except Exception as e:
                logger.warning(f"[Orchestrator] 鏅鸿兘璺敱澶辫触锛堝洖閫€鍒伴粯璁ら€夋嫨锛? {e}")

        # 鈹€鈹€ 鍥為€€锛氫粠鏁版嵁搴撻€夋嫨妯″瀷锛堝吋瀹规棫閫昏緫锛夆攢鈹€
        logger.info("[Orchestrator] 姝ｅ湪浠庢暟鎹簱閫夋嫨鏈€浣?tool 妯″瀷...")

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
            f"[Orchestrator] 宸插垵濮嬪寲 LLM 瀹㈡埛绔? "
            f"model={model_name} provider={channel.provider} base_url={channel.base_url}"
        )
        return self._llm

    @property
    def model_name(self) -> str:
        return self._model or DEFAULT_MODEL or "unknown"

    def cancel_task(self, task_id: str):
        self._active_tasks[task_id] = False

    # 鈹€鈹€鈹€ 瀵硅瘽娑堟伅鏈哄埗 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    def receive_user_message(self, task_id: str, message: str) -> asyncio.Queue:
        """鎺ユ敹鐢ㄦ埛鍙戦€佺殑瀵硅瘽娑堟伅锛岃繑鍥?SSE 鎺ㄩ€侀槦鍒椼€?
        
        濡傛灉浠诲姟涓嶅瓨鍦ㄦ垨涓嶅湪杩愯涓紝杩斿洖 None銆?
        娑堟伅浼氭敞鍏ュ埌 Agent 寰幆涓紝Agent 鐨勬枃鏈搷搴斾細鎺ㄩ€佸埌杩斿洖鐨?Queue 涓€?
        """
        if task_id not in _tasks:
            return None
        task = _tasks[task_id]
        if task["status"] not in ("running", "waiting_confirm", "pending"):
            return None

        # 鍒涘缓鎴栬幏鍙?SSE 鎺ㄩ€侀槦鍒?
        if task_id not in self._chat_sse_queues:
            self._chat_sse_queues[task_id] = asyncio.Queue()

        # 灏嗙敤鎴锋秷鎭姞鍏ラ槦鍒?
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

        # 濡傛灉鏈夌瓑寰呬簨浠讹紝瑙﹀彂瀹?
        if task_id in self._message_events:
            self._message_events[task_id].set()

        # 涔熸妸鐢ㄦ埛娑堟伅鎺ㄩ€佸埌 SSE 闃熷垪锛堜綔涓虹‘璁ゅ洖鎵э級
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

        # 鎴柇缁撴灉
        summary = result[:500] if result else "(鏃犺緭鍑?"
        if len(result) > 500:
            summary += "\n... (杈撳嚭杩囬暱锛屽凡鎴柇)"

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
            self._chat_sse_queues[task_id].put_nowait({
                "type": "tool_progress",
                "tool_name": tool_name,
                "description": desc,
                "path": args.get("path", args.get("command", "")),
                "timestamp": datetime.utcnow().isoformat(),
                "result_summary": summary,
                "output_path": (output_meta or {}).get("full_path", ""),
                "output_truncated": bool((output_meta or {}).get("truncated")),
            })
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
        # 娓呯悊璇ヤ换鍔＄浉鍏崇殑璺敱缂撳瓨
        keys_to_del = [k for k in self._failover_clients if k.startswith(f"{task_id}|")]
        for k in keys_to_del:
            self._failover_clients.pop(k, None)

    # 鈹€鈹€鈹€ 宸ヤ綔绌洪棿璁板繂绯荤粺 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

        # 2.1.1 鍚屾鍒颁簲灞傝蹇?L2锛堟俯璁板繂锛? VFS锛堣交閲忔浛浠?ES/Milvus锛?
        # best-effort锛氫换浣曞紓甯搁兘涓嶅奖鍝嶄换鍔′富娴佺▼
        try:
            memory_service.put_workspace_plan(task_id, plan_content)
            memory_service.put_workspace_memory(task_id, memory_content)
            # 鍚屾椂灏嗘枃浠堕暅鍍忓埌 VFS /memory 渚夸簬璺ㄤ换鍔″叏鏂囨绱?
            from services.vfs_service import vfs
            vfs.write(f"/memory/{task_id}/PLAN.md", plan_content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["plan"]})
            vfs.write(f"/memory/{task_id}/MEMORY.md", memory_content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["memory"]})
        except Exception as _e:
            logger.warning(f"[Orchestrator] 璁板繂鍚屾澶辫触锛堝凡蹇界暐锛? {_e}")

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

        # 鏇存柊鐘舵€佽
        import re as _re
        content = _re.sub(
            r'\*\*鐘舵€乗*\*:.*',
            f'**鐘舵€?*: {status}',
            content,
        )
        content = _re.sub(
            r'\*\*褰撳墠闃舵\*\*:.*',
            f'**褰撳墠闃舵**: {phase}',
            content,
        )
        content = _re.sub(
            r'\*\*宸茬敤杩唬\*\*:\s*\d+',
            f'**宸茬敤杩唬**: {iteration} / {DEFAULT_MAX_ITERATIONS}',
            content,
        )

        if completed_items:
            done_section = "\n".join(f"- [x] {item}" for item in completed_items)
            content = _re.sub(
                r'## 宸插畬鎴怽n(?:- \[.\].*\n?)*',
                f'## 宸插畬鎴怽n{done_section}\n',
                content,
            )

        if issues:
            issue_section = "\n".join(f"- {item}" for item in issues)
            content = _re.sub(
                r'## 閬囧埌鐨勯棶棰榎n(?:- .*\n?)*',
                f'## 閬囧埌鐨勯棶棰榎n{issue_section}\n',
                content,
            )

        if decisions:
            dec_section = "\n".join(f"- {item}" for item in decisions)
            content = _re.sub(
                r'## 鍏抽敭鍐崇瓥璁板綍\n(?:- .*\n?)*',
                f'## 鍏抽敭鍐崇瓥璁板綍\n{dec_section}\n',
                content,
            )

        mem_path.write_text(content, encoding="utf-8")

        # 2.1.2 鍚屾鐘舵€佸埌浜斿眰璁板繂 L2锛涘叧閿喅绛?闂钀?L3 鍐疯蹇嗭紙best-effort锛?
        try:
            memory_service.update_workspace_status(task_id, status, phase)
            from services.vfs_service import vfs
            vfs.write(f"/memory/{task_id}/MEMORY.md", content,
                      {"source": "workspace", "scope": "task", "scope_id": task_id,
                       "privacy_level": "project", "tags": ["memory"]})
            if decisions:
                memory_service.archive_cold(
                    title=f"[{task_id[:8]}] 鍏抽敭鍐崇瓥", content="\n".join(f"- {d}" for d in decisions),
                    scope="task", scope_id=task_id, tags=["decision"],
                    related_tasks=[task_id], source="workspace_file")
            if issues:
                memory_service.archive_cold(
                    title=f"[{task_id[:8]}] 遇到的问题", content="\n".join(f"- {i}" for i in issues),
                    scope="task", scope_id=task_id, tags=["issue"],
                    related_tasks=[task_id], source="workspace_file")
        except Exception as _e:
            logger.warning(f"[Orchestrator] 璁板繂鍚屾澶辫触锛堝凡蹇界暐锛? {_e}")

    # 鈹€鈹€鈹€ 鏅鸿兘澶辫触鎭㈠ 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

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

            # 1. 纭繚 LLM 瀹㈡埛绔凡鍒濆鍖栵紙浣跨敤鏅鸿兘璺敱锛?
            task["progress"] = 5
            task["current_step"] = "分析任务复杂度并初始化 LLM"

            # 1.1 妫€娴嬩换鍔″鏉傚害
            exec_agents = [a for a in agent_types if a != "researcher"]
            task_complexity = ModelRouter.detect_complexity(description, len(exec_agents))
            logger.info(
                f"[Orchestrator] 浠诲姟澶嶆潅搴? {task_complexity} "
                f"(agents={len(exec_agents)}, desc='{description[:80]}...')"
            )
            task["complexity"] = task_complexity
            await h_event("planning", "complexity_detected", {
                "complexity": task_complexity,
                "agent_count": len(exec_agents),
            })

            # 1.2 鏋勫缓 TaskContext 骞跺垵濮嬪寲璺敱瀹㈡埛绔?
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

            # 2. 鍒濆鍖?/ 澶嶇敤 Workspace
            if task.get("needs_continuation") or task.get("chat_continuation_message"):
                log("info", f"澶嶇敤 Workspace: {workspace_id}", "orchestrator")
            else:
                log("info", f"鍒涘缓 Workspace: {workspace_id}", "orchestrator")
            await docker_manager.create_workspace(workspace_id, project_type)
            ws_path = self._settings.workspace_base_dir / workspace_id

            # 鈹€鈹€ 鏂偣缁窇锛氭仮澶嶄笂娆′腑鏂殑杩涘害 鈹€鈹€
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

            # 2.1 鍐欏叆宸ヤ綔绌洪棿璁板繂鏂囦欢銆傜画璺?瀵硅瘽澧為噺鎵ц鏃朵繚鐣欏凡鏈夎鍒掍笌璁板繂銆?
            preserve_memory = bool(task.get("needs_continuation") or task.get("chat_continuation_message"))
            if preserve_memory and (ws_path / ".autocode" / "PLAN.md").exists():
                log("info", "保留已有工作空间记忆文件，进入续跑/增量执行模式", "orchestrator")
            else:
                self._init_workspace_memory(ws_path, task_id, description, project_type, agent_types)
                log("success", "工作空间记忆文件已初始化 (.autocode/PLAN.md, MEMORY.md)", "orchestrator")

            # 3. 鍒濆鍖?Git
            git_manager.init(ws_path)
            log("success", "Git 仓库已初始化", "orchestrator")

            # 4. 鍚姩 PTY 缁堢
            terminal_manager.start_session(workspace_id, str(ws_path))
            log("info", "终端会话已启动", "orchestrator")

            # 5. [Researcher 闃舵]
            research_report = None
            if "researcher" in agent_types:
                task["progress"] = 10
                task["current_step"] = "Researcher 调研中"
                log("info", "馃攳 鍚姩 Researcher Agent 璋冪爺闃舵", "orchestrator")

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
                log("success", "馃搵 璋冪爺鎶ュ憡宸茬敓鎴愬苟淇濆瓨", "researcher")
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

            # 6. [Agent 鎵ц 鈥?鏀寔鏅鸿兘浠诲姟瑙勫垝]
            task["progress"] = 25
            task["current_step"] = "启动 Agent 执行"

            exec_agents = [a for a in agent_types if a != "researcher"]

            # 鈹€鈹€ 妫€鏌ユ槸鍚︽湁浠诲姟瑙勫垝 鈹€鈹€
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
                    log("warn", f"鍐欏叆妫€绱㈣鍒掑け璐ワ細{exc}", "orchestrator")
                task["retrieval_plan"] = retrieval_plan.to_dict()
                task["retrieval_guard"] = {
                    "active": True,
                    "candidate_files": retrieval_plan.candidate_files,
                    "index_docs": retrieval_plan.index_docs,
                    "read_budget": retrieval_plan.read_budget,
                    "read_files": [],
                }
                self._persist_task(task_id)
                await h_event("execution", "agentic_loop_start", {
                    "mode": "agentic",
                    "source": "chat_continuation",
                    "actionable": actionable_request,
                    "candidate_files": retrieval_plan.candidate_files,
                    "guardrails": task.get("guardrails"),
                })
                append_event(task, "agentic_loop_start", {
                    "mode": "agentic",
                    "source": "chat_continuation",
                    "actionable": actionable_request,
                    "candidate_files": retrieval_plan.candidate_files,
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
                    log("info", "Agentic Loop 达到单段迭代上限，已交给后台队列自动续跑。", "orchestrator")
                    _set_agentic_finish(
                        task,
                        status="checkpoint",
                        reason="iteration_limited",
                        retryable=True,
                        message="Agentic Loop reached the per-run iteration budget and will continue automatically.",
                    )
                    self._persist_task(task_id)
                    return
                changed_files = _snapshot_changed(before_snapshot, _workspace_file_snapshot(ws_path))
                changed_result_files = _agent_changed_files(changed)
                if changed_result_files:
                    changed_files = list(dict.fromkeys([*changed_files, *changed_result_files]))
                if not changed_files and actionable_request:
                    _mark_agentic_no_change_retryable(task)
                    await h_event("execution", "agentic_loop_no_change_retryable", {
                        "message": chat_continuation_message[:1000],
                        "retrieval_plan": task.get("retrieval_plan"),
                    })
                    append_event(task, "agentic_loop_no_change_retryable", {
                        "message": chat_continuation_message[:1000],
                        "retrieval_plan": task.get("retrieval_plan"),
                    }, source="orchestrator")
                    self._persist_task(task_id)
                    return
                review_ok = await self._review_execution_group(
                    task_id,
                    task,
                    ws_path,
                    log,
                    "AI 鍔╂墜 Agentic 澧為噺淇敼",
                    [],
                    changed_files,
                    guardrail_kind="agentic",
                )
                if not review_ok:
                    _set_agentic_finish(
                        task,
                        status="blocked",
                        reason="guardrail_review_failed",
                        changed_files=changed_files,
                        review_passed=False,
                        blocked=True,
                        message="Agentic changes did not pass the review guardrail.",
                    )
                    await h_fail("chat_continuation_review_failed", "AI 鍔╂墜 Agentic 澧為噺淇敼鏈€氳繃瀹℃煡", "high", {
                        "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                    })
                    self._persist_task(task_id)
                    return
                _set_agentic_finish(
                    task,
                    status="completed",
                    reason="changed_and_guardrails_passed",
                    changed_files=changed_files,
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
                    log("warn", f"鍐欏叆妫€绱㈣鍒掑け璐ワ細{exc}", "orchestrator")
                task["retrieval_plan"] = retrieval_plan.to_dict()
                task["retrieval_guard"] = {
                    "active": True,
                    "candidate_files": retrieval_plan.candidate_files,
                    "index_docs": retrieval_plan.index_docs,
                    "read_budget": retrieval_plan.read_budget,
                    "read_files": [],
                }
                self._persist_task(task_id)
                log(
                    "info",
                    f"妫€绱㈣鍒掑凡鐢熸垚锛氬€欓€夋枃浠?{len(retrieval_plan.candidate_files)} 涓紝璇诲彇棰勭畻 {retrieval_plan.read_budget}",
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
                if not changed_files:
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
                    if not changed_files:
                        if actionable_request:
                            log("error", "鏄庣‘淇敼娓呭崟鎵ц鍚庝粛鏃犳枃浠跺彉鏇达紝鏍囪涓?Agent 鎵ц澶辫触", "orchestrator")
                            task["status"] = "failed"
                            task["current_step"] = "AI 鍔╂墜鏈兘鎵ц鏄庣‘淇敼娓呭崟"
                            task["needs_continuation"] = True
                            if isinstance(task.get("retrieval_guard"), dict):
                                task["retrieval_guard"]["active"] = False
                            self._persist_task(task_id)
                            await h_fail("chat_continuation_no_changes", "AI 鍔╂墜鏈兘鎵ц鏄庣‘淇敼娓呭崟", "medium", {
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
                        log("warn", "AI 鍔╂墜澧為噺鎵ц鏈骇鐢熸枃浠跺彉鏇达紝宸茬瓑寰呮洿鍏蜂綋鍙嶉", "orchestrator")
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
                    "AI 鍔╂墜澧為噺淇敼",
                    [],
                    changed_files,
                )
                if not review_ok:
                    await h_fail("chat_continuation_review_failed", "AI 鍔╂墜澧為噺淇敼鏈€氳繃瀹℃煡", "high", {
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
                    task["current_step"] = "Agentic Loop 达到单段迭代上限，正在自动压缩上下文并继续。"
                    _set_agentic_finish(
                        task,
                        status="checkpoint",
                        reason="iteration_limited",
                        retryable=True,
                        message="Agentic Loop reached the per-run iteration budget and will continue automatically.",
                    )
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                if not changed and is_actionable_development_request(description):
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
                    changed_files=_agent_changed_files(changed),
                    message="Agentic execution finished its active loop; final task guardrails will decide completion.",
                )

            elif task_plan and task_plan.subtasks:
                # 鈹€鈹€ 璁″垝椹卞姩妯″紡锛氭寜鎵ц鍒嗙粍渚濇鎵ц瀛愪换鍔?鈹€鈹€
                log("info", f"进入计划驱动模式：{len(task_plan.subtasks)} 个子任务，{len(task_plan.execution_groups)} 个执行组", "orchestrator")
                await h_event("planning", "plan_ready", {
                    "subtask_count": len(task_plan.subtasks),
                    "group_count": len(task_plan.execution_groups),
                })
                self._push_phase_progress(task_id, "plan_execution", f"开始执行 {len(task_plan.subtasks)} 个子任务...")

                # 鈹€鈹€ 6.0 鍘熷瀷鐢熸垚涓庣‘璁わ紙璁″垝纭鍚庛€佸瓙浠诲姟鎵ц鍓嶏級鈹€鈹€
                # 鍘熷瀷椹卞姩寮€鍙戯細鍏堟牴鎹鍒掔敓鎴?UI 鍘熷瀷锛岀敤鎴风‘璁ゅ悗鍐嶆墽琛屼唬鐮佸紑鍙?
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

                # 妫€鏌ユ槸鍚﹁鍙栨秷鎴栬秴鏃?
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

                    # 鏇存柊瑙勫垝涓殑瀛愪换鍔＄姸鎬?
                    for st in group_subtasks:
                        st.status = SubTaskStatus.running
                        st.progress = 0
                        task["current_subtask_id"] = st.id
                    self._sync_plan_to_task(task_id, task_plan)

                    # 鍚岀粍鍐呭苟琛屾墽琛?
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
                            if isinstance(result, Exception):
                                log("error", f"{group_label} subtask raised: {result}", "orchestrator")
                        completed_count += sum(1 for st in group_subtasks if st.status == SubTaskStatus.completed)

                    if _agent_needs_auto_continuation(task):
                        task["current_step"] = f"{group_label} 杈惧埌鍗曟杩唬涓婇檺锛屾鍦ㄨ嚜鍔ㄥ帇缂╀笂涓嬫枃骞剁画璺?.."
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
                        task["current_step"] = f"{group_label}澶辫触: {', '.join(st.title for st in failed_subtasks)}"
                        await h_fail("subtask_failed", task["current_step"], "high", {
                            "group": group_label,
                            "failed_subtasks": [{"id": st.id, "title": st.title} for st in failed_subtasks],
                        })
                        self._sync_plan_to_task(task_id, task_plan)
                        self._persist_task(task_id)
                        self._push_phase_progress(
                            task_id, "group_failed",
                            f"{group_label}澶辫触: {', '.join(st.title for st in failed_subtasks)}"
                        )
                        return

                    # 鏇存柊杩涘害
                    task["progress"] = 25 + int((completed_count / total_subtasks) * 50)
                    await h_event("execution", "group_complete", {
                        "group": group_label,
                        "completed_count": completed_count,
                        "total_subtasks": total_subtasks,
                    })
                    self._push_phase_progress(
                        task_id, "group_complete",
                        f"鉁?{group_label}瀹屾垚 ({completed_count}/{total_subtasks})"
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
                    if not review_ok:
                        await h_fail("phase_review_failed", f"{group_label} code review failed", "high", {
                            "group": group_label,
                            "review": (task.get("phase_reviews") or [])[-1] if task.get("phase_reviews") else None,
                        })
                        self._persist_task(task_id)
                        return

                task["current_subtask_id"] = None
                log("success", f"馃幆 璁″垝椹卞姩鎵ц瀹屾垚: {completed_count}/{total_subtasks} 涓瓙浠诲姟", "orchestrator")

                # 鈹€鈹€ 瀛愪换鍔℃墽琛屽畬鎴愬悗锛岀洿鎺ヨ繘鍏ユ瀯寤洪樁娈?鈹€鈹€
                # 锛堣鍒掓墽琛屾ā寮忎笉闇€瑕佸啀娆¤皟鐢?Agent锛?

            elif len(exec_agents) == 1:
                # 鈹€鈹€ 鏃犺鍒掞紝鍗?Agent 妯″紡 鈹€鈹€
                changed = await self._run_single_agent(
                    task_id, description, project_type,
                    workspace_id, exec_agents[0], ws_path, log, research_report,
                )
                if _agent_needs_auto_continuation(task):
                    task["current_step"] = "杈惧埌鍗曟杩唬涓婇檺锛屾鍦ㄨ嚜鍔ㄥ帇缂╀笂涓嬫枃骞剁画璺?.."
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                if not changed:
                    raise RuntimeError("Agent produced no file changes; refusing to continue to review/build.")
            else:
                # 鈹€鈹€ 鏃犺鍒掞紝骞惰 Agent 妯″紡 鈹€鈹€
                log("info", f"馃殌 骞惰鍚姩 {len(exec_agents)} 涓?Agent", "orchestrator")
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
                    if isinstance(result, Exception):
                        raise RuntimeError(f"Agent execution failed: {result}") from result
                if _agent_needs_auto_continuation(task):
                    task["current_step"] = "杈惧埌鍗曟杩唬涓婇檺锛屾鍦ㄨ嚜鍔ㄥ帇缂╀笂涓嬫枃骞剁画璺?.."
                    self._persist_task(task_id)
                    self._push_phase_progress(task_id, "auto_continuation_checkpoint", task["current_step"])
                    return
                if not any(bool(result) for result in agent_results):
                    raise RuntimeError("Agents produced no file changes; refusing to continue to review/build.")

                for agent_type in exec_agents:
                    log("info", f"[{agent_type}] Agent 鎵ц瀹屾瘯", "orchestrator")

            # 7. 瀹夎渚濊禆 + 鏋勫缓楠岃瘉锛堟櫤鑳藉け璐ユ仮澶嶏級
            task["progress"] = 80
            task["current_step"] = "瀹夎椤圭洰渚濊禆"
            self._persist_task(task_id)
            self._push_phase_progress(task_id, "install", "姝ｅ湪瀹夎椤圭洰渚濊禆...")

            # 鈹€鈹€ 渚濊禆瀹夎锛堝甫鏅鸿兘璇婃柇鍜屽绛栫暐閲嶈瘯锛夆攢鈹€
            install_ok = False
            install_error = ""
            has_package_json = (ws_path / "package.json").exists()
            validation_command, validation_reason = _select_validation_command(ws_path, project_type)
            if not validation_command:
                install_ok = True
                log("info", "No package.json found; skipping npm install for non-Node project", "devops")
                self._push_phase_progress(task_id, "install_skipped", "No Node dependencies detected; skipping npm install...")

            for install_attempt in range(MAX_INSTALL_RETRIES if has_package_json else 0):
                install_cmd = "npm install --prefer-offline 2>&1" if install_attempt == 0 else \
                              "npm install 2>&1" if install_attempt == 1 else \
                              "npm install --legacy-peer-deps 2>&1"
                log("info", f"安装依赖（尝试 {install_attempt + 1}/{MAX_INSTALL_RETRIES}）: {install_cmd.split(' ')[2] if len(install_cmd.split(' '))>2 else 'npm install'}", "devops")
                install_result = await docker_manager.execute_in_workspace(
                    workspace_id, f"{install_cmd} || echo 'INSTALL_FAILED'"
                )
                install_output = install_result.get("stdout", "") or ""
                if "INSTALL_FAILED" not in install_output and "ERR!" not in install_output:
                    install_ok = True
                    log("success", f"依赖安装完成（第 {install_attempt + 1} 次尝试）", "devops")
                    self._push_phase_progress(task_id, "install_done", "依赖安装完成")
                    break
                install_error = install_output

                # 濡傛灉杩樻湁閲嶈瘯鏈轰細锛屽皾璇曟櫤鑳借瘖鏂慨澶?
                if install_attempt < MAX_INSTALL_RETRIES - 1:
                    fix_ok, fix_output = await self._diagnose_and_fix_install(
                        workspace_id, ws_path, log, install_error, install_attempt,
                    )
                    if fix_ok:
                        install_ok = True
                        break
                    install_error += f"\n--- 诊断结果 ---\n{fix_output}"

            if not install_ok:
                # 瀹夎鏈€缁堝け璐?鈫?璁板綍鍒拌蹇嗘枃浠讹紝鏍囪 needs_fix 鐘舵€?
                self._update_workspace_memory(
                    ws_path, task_id, status="needs_fix",
                    phase="依赖安装失败",
                    issues=[f"npm install 失败: {install_error[-500:]}"],
                )
                log("error", "依赖安装失败（已用尽所有重试策略）", "devops", install_error[-1000:])
                task["status"] = "failed"
                task["error_detail"] = f"依赖安装失败，请查看 .autocode/MEMORY.md 获取详细诊断\n\n{install_error[-1500:]}"
                task["needs_continuation"] = True
                return

            # 鈹€鈹€ 鏋勫缓楠岃瘉锛堝甫鏅鸿兘璇婃柇鍜?LLM 鑷慨澶嶅惊鐜級鈹€鈹€
            task["progress"] = 85
            task["current_step"] = "鏋勫缓椤圭洰"
            self._push_phase_progress(task_id, "build", "姝ｅ湪鏋勫缓椤圭洰 (npm run build)...")
            task["current_step"] = "楠岃瘉椤圭洰"
            self._push_phase_progress(task_id, "validation", f"姝ｅ湪楠岃瘉椤圭洰 ({validation_command or validation_reason})...")
            build_ok = False
            build_error = ""
            if not validation_command:
                build_ok = True
                log("info", f"No validation command detected; skipping validation stage ({validation_reason})", "devops")
                self._push_phase_progress(task_id, "build_skipped", "鏈娴嬪埌鍙敤楠岃瘉鍛戒护锛岀户缁繘鍏ュ鏌?..")
            max_build_retries = 3 if validation_command else 0

            for build_attempt in range(max_build_retries):
                log("info", f"馃敤 鎵ц鏋勫缓 (灏濊瘯 {build_attempt + 1}/{max_build_retries})", "devops")
                log("info", f"馃敤 鎵ц楠岃瘉 (灏濊瘯 {build_attempt + 1}/{max_build_retries}): {validation_command}", "devops")
                build_result = await docker_manager.execute_in_workspace(
                    workspace_id, f"{validation_command} 2>&1 || echo 'BUILD_FAILED'"
                )
                build_output = build_result.get("stdout", "") or ""

                if "BUILD_FAILED" not in build_output:
                    build_ok = True
                    log("success", "鉁?鏋勫缓鎴愬姛", "devops", build_output[-500:])
                    break

                build_error = build_output

                # 灏濊瘯鏅鸿兘淇
                if build_attempt < max_build_retries - 1:
                    diag_ok, diag_msg = await self._diagnose_and_fix_build(
                        workspace_id, ws_path, log, build_error,
                        llm=await self._ensure_client(requested_model=task.get("model")), messages=None,
                    )
                    if diag_ok:
                        build_ok = True
                        break

                    # 濡傛灉鏈?LLM锛屽皾璇曡瀹冭嚜鍔ㄤ慨澶嶆瀯寤洪敊璇?
                    repair_prompt = "\n".join([
                        "## 验证失败自动修复",
                        "",
                        f"验证命令 `{validation_command}` 没有通过。",
                        "你必须基于下面的真实错误输出定位源码或配置问题，修改相关文件，并重新运行同一条验证命令。",
                        "",
                        "要求：",
                        "- 不要只运行 ls/glob 或读取目录后停止。",
                        "- 先从错误输出提取文件、行号、模块名、测试名或关键报错。",
                        "- 读取最相关的源码/配置文件，做最小必要修改。",
                        f"- 修改后必须重跑 `{validation_command}`。",
                        "- 如果无法修复，说明缺少的外部依赖、环境变量或人工信息。",
                        "",
                        "验证输出：",
                        "```text",
                        build_output[-4000:],
                        "```",
                    ])
                    try:
                        changed = await self._run_agentic_loop(
                            task_id=task_id,
                            description=repair_prompt,
                            project_type=project_type,
                            workspace_id=workspace_id,
                            agent_type=agent_types[0] if agent_types else "frontend",
                            ws_path=ws_path,
                            log=log,
                            research_report=research_report,
                            task_plan=task_plan,
                        )
                        log("info", f"Agentic 构建修复已执行，changed={bool(changed)}", "devops")
                        re_result = await docker_manager.execute_in_workspace(
                            workspace_id, f"{validation_command} 2>&1 || echo 'BUILD_FAILED'"
                        )
                        re_output = re_result.get("stdout", "") or ""
                        if "BUILD_FAILED" not in re_output:
                            build_ok = True
                            log("success", "Agentic 自动修复后构建成功", "devops", re_output[-500:])
                            break
                        build_error = re_output
                        continue
                    except Exception as exc:
                        log("warn", f"Agentic 构建修复未完成: {exc}", "devops")

                    llm = await self._ensure_client(requested_model=task.get("model"))
                    log("info", "正在让 Agent 分析并修复构建错误...", "orchestrator")

                    fix_prompt = "\n".join([
                        "构建失败了，请根据以下错误输出修复代码：",
                        "```text",
                        build_output[-2000:],
                        "```",
                        "要求：定位错误原因，修改相关文件，然后运行 npm run build 验证。",
                    ])

                    try:
                        fix_response = await llm.chat(
                            messages=[{"role": "user", "content": fix_prompt}],
                            tools=AGENT_TOOLS,
                            system=AGENT_SYSTEM_PROMPTS.get(
                                agent_types[0] if agent_types else "frontend",
                                AGENT_SYSTEM_PROMPTS["frontend"]
                            ),
                        )

                        if fix_response.has_tool_calls:
                            for tc in fix_response.tool_calls:
                                tool_result = await self._execute_tool(
                                    tc.name, tc.arguments,
                                    workspace_id, ws_path, task_id, log,
                                    agent_types[0] if agent_types else "frontend",
                                )
                                # 鎺ㄩ€佷慨澶嶈繘搴﹀埌瀵硅瘽 SSE
                                self._push_tool_progress(task_id, tc.name, tc.arguments, tool_result)
                                log("info", f"[鑷姩淇] {tc.name}: {tool_result[:200]}", "devops")
                                # 鎵ц瀹屼慨澶嶅悗閲嶆柊鏋勫缓
                                re_result = await docker_manager.execute_in_workspace(
                                    workspace_id, "npm run build 2>&1 || echo 'BUILD_FAILED'"
                                )
                                if "BUILD_FAILED" not in (re_result.get("stdout") or ""):
                                    build_ok = True
                                    log("success", "鉁?Agent 鑷姩淇鍚庢瀯寤烘垚鍔燂紒", "devops")
                                    break
                    except Exception as e:
                        log("warn", f"鈿狅笍 Agent 鑷姩淇寮傚父: {e}", "devops")

            if not build_ok:
                # 鏋勫缓鏈€缁堝け璐?鈫?璁板綍鍒拌蹇嗘枃浠讹紝鏍囪 needs_fix 鐘舵€?
                self._update_workspace_memory(
                    ws_path, task_id, status="needs_fix",
                    phase="鏋勫缓澶辫触",
                    issues=[f"npm run build 澶辫触: {build_error[-500:]}"],
                )
                log("error", "鉂?鏋勫缓澶辫触锛堝凡鐢ㄥ敖鎵€鏈夐噸璇曠瓥鐣ワ級", "devops", build_error[-1000:])
                task["status"] = "failed"
                task["error_detail"] = f"鏋勫缓澶辫触锛岃鏌ョ湅 .autocode/MEMORY.md 鑾峰彇璇︾粏璇婃柇銆俓n\n鍙偣鍑汇€岀户缁€嶆寜閽 Agent 灏濊瘯淇銆俓n\n{build_error[-1500:]}"
                task["needs_continuation"] = True
                return

            # 鈹€鈹€ 鏋勫缓鎴愬姛 鈫?鍚姩棰勮 + 鏍囪瀹屾垚 鈹€鈹€
            task["progress"] = 92
            task["current_step"] = "鍚姩棰勮鏈嶅姟"
            self._push_phase_progress(task_id, "preview", "鉁?鏋勫缓鎴愬姛锛屽惎鍔ㄩ瑙堟湇鍔?..")

            # 鍏堝仠姝㈡棫鐨?dev server锛堥伩鍏嶇鍙ｅ啿绐併€佺‘淇濅娇鐢ㄦ渶鏂版瀯寤轰骇鐗╋級
            try:
                await dev_server_manager.stop_dev_server(workspace_id)
                log("info", "馃攲 宸插仠姝㈡棫鐨?Dev Server锛堝噯澶囬噸鏂板惎鍔級", "orchestrator")
            except Exception as stop_err:
                log("warn", f"鈿狅笍 鍋滄鏃?Dev Server 澶辫触锛堝彲蹇界暐锛? {stop_err}", "orchestrator")

            # 妫€鏌ユ槸鍚︽湁闈欐€佸鍑轰骇鐗╋紙out/ 鎴?dist/锛?
            # 濡傛灉鏈夛紝浼樺厛浣跨敤闈欐€佹枃浠堕瑙堬紙鏇寸ǔ瀹氾紝鏃犻渶 dev server锛?
            has_static_out = (ws_path / "out" / "index.html").exists()
            has_static_dist = (ws_path / "dist" / "index.html").exists()

            if has_static_out or has_static_dist:
                task["preview_url"] = f"/workspaces/{workspace_id}/preview"
                log("success", f"静态文件预览: /workspaces/{workspace_id}/preview", "orchestrator")
            elif not has_package_json:
                task["preview_url"] = None
                log("info", "未发现前端预览产物，非 Node 项目跳过预览服务", "orchestrator")
                self._push_phase_progress(task_id, "preview_skipped", "当前任务不需要页面预览。")
            else:
                preview_info = await dev_server_manager.start_dev_server(workspace_id, str(ws_path), project_type)
                if preview_info and preview_info.get("url"):
                    proxy_path = f"/api/proxy/{workspace_id}/"
                    task["preview_url"] = proxy_path
                    task["dev_server_port"] = preview_info["port"]
                    task["dev_server_internal_url"] = preview_info["url"]
                    log("success", f"预览服务已启动: {preview_info['url']}", "orchestrator")
                else:
                    task["preview_url"] = f"/workspaces/{workspace_id}/preview"
                    err_detail = ""
                    if preview_info:
                        err_detail = f" (status={preview_info.get('status', 'unknown')})"
                        try:
                            ds_session = await dev_server_manager.get_session(workspace_id)
                            if ds_session and ds_session.output:
                                err_detail += f"\nDev Server 输出:\n{ds_session.output[-500:]}"
                        except Exception:
                            pass
                    log("warn", f"Dev server 未启动{err_detail}，使用静态文件预览", "orchestrator")

            task["progress"] = 100
            log("success", "代码开发完成，启动代码审查...", "orchestrator")

            # 鈹€鈹€ 浠ｇ爜瀹℃煡闃舵 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
            task["status"] = "reviewing"
            self._persist_task(task_id)
            self._push_phase_progress(task_id, "reviewing", "正在执行代码审查...")

            review_passed = False
            try:
                # 鑾峰彇 LLM 瀹㈡埛绔敤浜?AI 璇勫锛堝彲閫夛級
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
                    project_type=task.get("project_type", "nextjs"),
                    log=log,
                )
                task["review"] = review_result.to_dict()
                review_passed = review_result.passed
            except Exception as e:
                logger.warning(f"[{task_id}] 浠ｇ爜瀹℃煡寮傚父锛堥樆姝㈠畬鎴愶級: {e}")
                task["review"] = {
                    "passed": False,
                    "score": 0,
                    "summary": f"浠ｇ爜瀹℃煡寮傚父: {e}",
                    "issues": [{
                        "level": "error",
                        "rule": "review/exception",
                        "file": ".",
                        "message": str(e),
                    }],
                    "dimensions": {},
                }
                review_passed = False

            # 鈹€鈹€ 纭棬鎺э細瀹℃煡涓嶉€氳繃 鈫?绛夊緟鐢ㄦ埛纭 鈹€鈹€
            if not review_passed:
                review_score = task["review"].get("score", 0)
                review_summary = task["review"].get("summary", "")
                issue_count = len(task["review"].get("issues", []))

                task["review_confirmed"] = None  # 绛夊緟鐢ㄦ埛纭
                task["status"] = "waiting_review_confirm"
                task["current_step"] = f"代码审查未通过（{review_score} 分 / {issue_count} 个问题），等待您确认..."
                self._persist_task(task_id)

                log("warn", f"代码审查未通过（{review_score} 分 / {issue_count} 个问题），等待用户确认", "orchestrator")
                compacted_this_iteration = True
                self._push_phase_progress(
                    task_id, "review_failed",
                    f"代码审查未通过 - 得分 {review_score}，{issue_count} 个问题"
                )

                # 杞绛夊緟鐢ㄦ埛纭锛堝弬鐓?_generate_and_confirm_prototype 妯″紡锛?
                max_wait_seconds = 3600  # 鏈€澶氱瓑寰?1 灏忔椂
                wait_interval = 2        # 姣?2 绉掓鏌ヤ竴娆?
                waited = 0

                while waited < max_wait_seconds:
                    await asyncio.sleep(wait_interval)
                    waited += wait_interval

                    # 妫€鏌ヤ换鍔℃槸鍚﹁鍙栨秷
                    t_check = _tasks.get(task_id)
                    if not t_check or t_check.get("status") == "cancelled":
                        log("info", "用户取消任务，退出审查等待", "orchestrator")
                        self.cleanup_chat_queue(task_id)
                        self._persist_task(task_id)
                        return

                    # 妫€鏌ョ敤鎴锋槸鍚﹀凡纭/鎷掔粷
                    confirmed = t_check.get("review_confirmed")
                    if confirmed is not None:
                        if confirmed:
                            # 鐢ㄦ埛纭锛氬鏌ヤ笉閫氳繃浣嗕粛缁х画瀹屾垚
                            task["status"] = "completed"
                            task["current_step"] = "用户已确认审查结果，任务完成"
                            log("success", "用户确认审查结果，任务完成", "orchestrator")
                        else:
                            # 鐢ㄦ埛鎷掔粷锛氳涓轰唬鐮佷笉鍚堟牸锛屼换鍔″け璐?
                            task["status"] = "failed"
                            task["current_step"] = "用户拒绝了审查结果，任务标记为失败"
                            log("warn", "用户拒绝审查结果，任务失败", "orchestrator")
                        self._persist_task(task_id)
                        break
                else:
                    # 瓒呮椂鏈‘璁わ細鏍规嵁寰楀垎鍐冲畾
                    if review_score >= 50:
                        log("warn", f"审查确认超时（得分 {review_score} >= 50），自动完成", "orchestrator")
                        task["status"] = "completed"
                        task["current_step"] = "审查确认超时，自动完成"
                    else:
                        log("warn", f"审查确认超时（得分 {review_score} < 50），标记失败", "orchestrator")
                        task["status"] = "failed"
                        task["current_step"] = "审查确认超时且得分过低，标记失败"
                    self._persist_task(task_id)

                # 濡傛灉鐢ㄦ埛鎷掔粷浜嗭紙task["status"] == "failed"锛夛紝璺宠繃鍚庣画瀹屾垚閫昏緫
                if task.get("status") == "failed":
                    await h_fail("review_rejected", task.get("current_step", "Review rejected"), "high", {
                        "review": task.get("review"),
                    })
                    self.cleanup_chat_queue(task_id)
                    self._persist_task(task_id)
                    return
            else:
                # 瀹℃煡閫氳繃锛岀洿鎺ュ畬鎴?
                task["status"] = "completed"
                log("success", "任务全部完成", "orchestrator")

            # 鏇存柊璁板繂鏂囦欢锛氭爣璁板畬鎴?
            agent_iter = task.get("agent_iteration", 60)
            self._update_workspace_memory(
                ws_path, task_id, status="completed",
                phase="任务完成",
                completed_items=["需求分析", "代码实现", "依赖安装", "构建通过", "预览就绪"],
                decisions=[f"共执行 {agent_iter} 轮迭代"],
                iteration=agent_iter,
            )
            self._persist_task(task_id)

            git_manager.auto_commit(ws_path, ["."], f"完成: {task['title']}")
            task["commit_history"] = git_manager.log(ws_path, max_count=10)
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

            # 娓呯悊瀵硅瘽闃熷垪锛堜换鍔＄粨鏉熷悗涓嶅啀闇€瑕侊級
            self.cleanup_chat_queue(task_id)

        except asyncio.CancelledError:
            if task.get("cancel_requested"):
                task["status"] = "cancelled"
                task["execution_active"] = False
                log("warn", "浠诲姟宸茬敱鐢ㄦ埛鍙栨秷", "orchestrator")
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
            self._active_tasks[task_id] = False
            current_task = _tasks.get(task_id)
            if current_task:
                current_task["execution_active"] = False
                self._persist_task(task_id)

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
            label=f"{group_label} CI 楠岃瘉",
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
                    project_type=task.get("project_type", "default"),
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
        task["current_step"] = f"{group_label} guardrail review" if is_agentic_guardrail else f"{group_label} code review"
        task.setdefault("phase_reviews", [])
        self._persist_task(task_id)
        progress_type = "guardrail_review" if is_agentic_guardrail else "phase_review"
        progress_message = f"{group_label}: guardrail review" if is_agentic_guardrail else f"{group_label}: code review"
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
                    "summary": "阶段没有产生任何工作区文件变更，拒绝通过代码审查。",
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
                    "summary": "阶段 CI/验证未通过，拒绝进入代码审查通过状态。",
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
            review_project_type = "docs" if _is_documentation_phase(group_subtasks, changed_files) else task.get("project_type", "nextjs")
            with usage_agent("reviewer"):
                review_result = await reviewer.run(
                    ws_path=ws_path,
                    task_id=task_id,
                    task_title=f"{task.get('title', '')} - {group_label}",
                    project_type=review_project_type,
                    log=log,
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
                "浣跨敤璇存槑", "鍐掔儫娴嬭瘯", "璇存槑", "鏂囨。",
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
            log("success", f"宸茬敓鎴?鏇存柊浣跨敤璇存槑鏂囦欢: {rel}", "orchestrator")
            return rel
        except Exception as exc:
            log("warn", f"鐢熸垚浣跨敤璇存槑鏂囦欢澶辫触: {exc}", "orchestrator")
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
            for token in ("contract", "濂戠害", "璇存槑", "鏂囨。", "姊崇悊", "map", "鍏ュ彛")
        ) or any(path.endswith(".md") for path in estimated)
        if not is_doc_phase:
            return None

        target = next((p for p in estimated if p.endswith(".md")), "")
        if not target:
            if "script" in title or "濂戠害" in title or "contract" in title:
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
            log("warn", f"鐢熸垚鍏滃簳宸ヤ綔鏂囦欢澶辫触: {exc}", "orchestrator")
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

        log("info", f"鈻讹笍 寮€濮嬪瓙浠诲姟 [{subtask.id}] {subtask.title}", "orchestrator")
        phase_record = _append_command_record(
            task,
            f"autocode subtask {subtask.id}",
            "running",
            label=f"瀛愪换鍔?{subtask.id}: {subtask.title}",
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
            f"鈻讹笍 [{subtask.id}] {subtask.title} 鈥?{subtask.agent_type}"
        )

        try:
            # 鏇存柊瀛愪换鍔＄姸鎬?
            subtask.status = SubTaskStatus.running
            task["current_subtask_id"] = subtask.id
            self._sync_plan_to_task(task_id, task_plan)

            # 濡傛灉鏈変緷璧栵紝娉ㄥ叆渚濊禆瀛愪换鍔＄殑涓婁笅鏂?
            dep_context = ""
            if subtask.dependencies:
                if task_plan:
                    dep_info = []
                    for dep_id in subtask.dependencies:
                        dep_st = next((s for s in task_plan.subtasks if s.id == dep_id), None)
                        if dep_st:
                            dep_info.append(f"- {dep_st.title}: {dep_st.description[:100]}")
                    if dep_info:
                        dep_context = f"\n\n馃搸 **鍓嶇疆宸插畬鎴愮殑浠诲姟**锛堣繖浜涗换鍔″凡瀹屾垚锛岃鍩轰簬瀹冧滑鐨勬垚鏋滅户缁級锛歕n" + "\n".join(dep_info)

            # 鏋勫缓瀛愪换鍔′笓鐢ㄦ弿杩?
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
            # 璋冪敤 Agent 鎵ц
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
                "楠岃瘉", "鍐掔儫", "娴嬭瘯", "浣跨敤璇存槑", "validation", "smoke", "test", "usage", "review",
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
                        f"瀛愪换鍔℃湭浜х敓鏂囦欢鍙樻洿锛屽凡鑷姩鐢熸垚鍏滃簳宸ヤ綔鏂囦欢: {fallback_file}",
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

            # 妫€鏌ユ墽琛岀粨鏋?
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
                    f"鉁?[{subtask.id}] {subtask.title} 鈥?瀹屾垚"
                )
            else:
                subtask.status = SubTaskStatus.failed
                self._sync_plan_to_task(task_id, task_plan)
                log("error", f"鉂?瀛愪换鍔″け璐?[{subtask.id}] {subtask.title}", "orchestrator")
                phase_record.update({
                    "status": "failed",
                    "output": f"浠诲姟鐘舵€佸彉涓?{task.get('status') if task else 'unknown'}",
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
                    f"鉂?[{subtask.id}] {subtask.title} 鈥?澶辫触"
                )

        except Exception as e:
            subtask.status = SubTaskStatus.failed
            self._sync_plan_to_task(task_id, task_plan)
            log("error", f"鉂?瀛愪换鍔″紓甯?[{subtask.id}] {subtask.title}: {e}", "orchestrator")
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
                f"鉂?[{subtask.id}] {subtask.title} 鈥?寮傚父: {str(e)[:100]}"
            )

    def _requires_prototype_confirmation(
        self,
        project_type: str,
        task_plan: Optional[TaskPlan] = None,
    ) -> bool:
        normalized_type = (project_type or "").strip().lower()
        ui_project_types = {
            "nextjs", "react", "vue", "nuxt", "vite", "svelte", "astro",
            "website", "frontend", "miniapp", "uniapp", "taro",
        }
        non_ui_project_types = {
            "api", "tool", "script", "python", "go", "java", "node",
            "backend", "fastapi", "express", "spring", "springboot",
            "nestjs", "gin", "default",
        }

        if normalized_type in ui_project_types:
            return True
        if normalized_type in non_ui_project_types:
            return False

        if not task_plan or not task_plan.subtasks:
            return False

        ui_keywords = (
            "ui", "椤甸潰", "鐣岄潰", "鍓嶇", "frontend", "component", "缁勪欢",
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
        task["current_step"] = "馃帹 姝ｅ湪鐢熸垚 UI 鍘熷瀷..."
        self._persist_task(task_id)
        self._push_phase_progress(task_id, "prototyping", "姝ｅ湪鐢熸垚 UI 绾挎鍥?..")

        # 鈹€鈹€ Phase 1: 鐢熸垚 Excalidraw 鍘熷瀷锛堢嫭绔?try/except锛屽け璐ュ垯璺宠繃鍘熷瀷纭锛夆攢鈹€
        prototype_result = None
        try:
            llm_client = await self._ensure_client(requested_model=task.get("model"))
            plan_context = task_plan.model_dump() if task_plan else None

            prototype_result = await generate_prototype_excalidraw(
                description=description,
                plan_context=plan_context,
                llm_client=llm_client,
            )

            # 淇濆瓨鍘熷瀷鍒板伐浣滅┖闂?
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

        # 鈹€鈹€ Phase 2: 璁剧疆绛夊緟纭鐘舵€侊紙涓嶅湪 try/except 涓紝纭繚涓€瀹氶樆濉炵瓑寰咃級鈹€鈹€
        task["prototype"] = prototype_result  # 瀹屾暣缁撴灉锛堝寘鍚?title, description, excalidraw, features锛?
        task["prototype_confirmed"] = None  # 绛夊緟纭
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

        # 鈹€鈹€ Phase 3: 杞绛夊緟鐢ㄦ埛纭锛堢嫭绔嬩簬鐢熸垚闃舵锛屼笉鍙楀紓甯稿奖鍝嶏級鈹€鈹€
        max_wait_seconds = 3600  # 鏈€澶氱瓑寰?1 灏忔椂
        wait_interval = 2  # 姣?2 绉掓鏌ヤ竴娆?
        waited = 0

        while waited < max_wait_seconds:
            await asyncio.sleep(wait_interval)
            waited += wait_interval

            # 妫€鏌ヤ换鍔℃槸鍚﹁鍙栨秷
            t_check = _tasks.get(task_id)
            if not t_check or t_check.get("status") == "cancelled":
                log("info", "用户取消任务，退出", "orchestrator")
                return

            # 妫€鏌ョ敤鎴锋槸鍚﹀凡纭/鎷掔粷
            confirmed = t_check.get("prototype_confirmed")
            if confirmed is not None:
                if confirmed:
                    # 鐢ㄦ埛纭浜嗗師鍨嬶紝缁х画鎵ц
                    task["status"] = "running"
                    task["progress"] = 70
                    task["current_step"] = "用户已确认原型，开始构建项目..."
                    log("success", "用户确认原型，继续执行", "orchestrator")
                else:
                    # 鐢ㄦ埛鎷掔粷鍘熷瀷锛岄噸鏂扮敓鎴?
                    log("info", "用户拒绝原型，继续执行后续流程", "orchestrator")
                    task["status"] = "running"
                    task["progress"] = 70
                    task["current_step"] = "用户拒绝原型，跳过确认继续执行..."
                self._persist_task(task_id)
                return

        # 瓒呮椂鏈‘璁わ紝瑙嗕负缁х画鎵ц
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
        system = AGENT_SYSTEM_PROMPTS.get(agent_type, AGENT_SYSTEM_PROMPTS["frontend"])
        system = system + "\n\n" + _agent_ownership_prompt(agent_type)
        system = system + "\n\n" + tool_registry.agent_usage_prompt()

        # 娉ㄥ叆鐢ㄦ埛鑷畾涔?SPEC.md 瑙勮寖
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

        # 鈹€鈹€ 涓哄綋鍓?Agent 鏋勫缓鐙珛璺敱涓婁笅鏂?+ 閫夋嫨鏈€浼樻ā鍨?鈹€鈹€
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
            llm = await self._ensure_client(requested_model=requested_model)  # 鍥為€€鍒板厹搴曢€夋嫨

        # 娉ㄥ叆璋冪爺鎶ュ憡涓婁笅鏂?
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

        # 妫€鏌ユ槸鍚︽湁鏂偣缁窇璁板繂锛圡EMORY.md 涓褰曚簡涓婃鐘舵€侊級
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
            "- 先观察项目结构，使用 glob/search_code 定位相关文件。",
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
        commands_count = 0
        workspace_version = 0
        validated_after_write = False
        effective_progress_count = 0
        repeated_tool_suppressed = 0
        tool_cache: dict[str, str] = {}
        tool_call_counts: dict[str, int] = {}
        validation_reminded_at_write_count = -1
        validation_failure_reminded_at_command_count = -1
        iteration = 0
        empty_response_retries = 0
        # 鑷€傚簲杩唬涓婇檺锛歋0/杞婚噺鑴氭湰浣跨敤鐭祦绋嬶紝澶嶆潅浠诲姟淇濈暀榛樿闀挎祦绋嬨€?
        max_iterations, compress_interval = _agent_iteration_policy(
            _tasks.get(task_id),
            description,
            bool(memory_context),
        )
        log("info", f"[{agent_type}] 迭代上限: {max_iterations}{' (续跑模式)' if memory_context else ''}", agent_type)
        # 杩涘害鑼冨洿锛氭瘡涓?Agent 鐙珛鎺ㄨ繘 27鈫?7锛?5%鈫?0% 涓棿55%鍒嗛厤缁欏悇Agent锛?
        _base_progress = 27
        _progress_range = 50

        def _update_progress(step_msg: str, sub_step: int = 0):
            """Update global progress and current_step for the frontend."""
            nonlocal iteration
            t = _tasks.get(task_id)
            if not t:
                return
            # 杩唬杩涘害锛氱N娆?/ max_iterations
            pct = _base_progress + min(iteration / max_iterations, 1.0) * _progress_range
            t["progress"] = int(pct)
            t["current_step"] = f"[{agent_type}] {step_msg}"
            # 鍚屾鏇存柊骞惰 Agent 杩涘害杩借釜
            if "agent_progress" in t and agent_type in t["agent_progress"]:
                t["agent_progress"][agent_type] = int(pct)

        while iteration < max_iterations and self._active_tasks.get(task_id, False):
            iteration += 1
            task = _tasks.get(task_id)
            if task and task["status"] == "cancelled":
                break

            _update_progress(f"第 {iteration}/{max_iterations} 轮思考中...")
            log("info", f"Agent [{agent_type}] 第 {iteration} 次迭代", agent_type)

            # 姣?10 杞洿鏂颁竴娆¤蹇嗘枃浠?
            if iteration % 10 == 0:
                self._update_workspace_memory(
                    ws_path, task_id, status="running",
                    phase=f"[{agent_type}] 迭代中 ({iteration}/{max_iterations})",
                    iteration=iteration,
                )

            # 鈹€鈹€ 妫€鏌ョ敤鎴峰彂鏉ョ殑瀵硅瘽娑堟伅 鈹€鈹€
            pending_msgs = self._get_pending_user_messages(task_id)
            if pending_msgs:
                log("info", f"收到 {len(pending_msgs)} 条用户消息，注入 Agent", agent_type)
                for um in pending_msgs:
                    messages.append({
                        "role": "user",
                        "content": um["content"],
                    })
                # 鐢ㄦ埛娑堟伅娉ㄥ叆鍚庨噸缃凯浠ｈ鏁帮紝閬垮厤鍥犱氦浜掓氮璐瑰お澶氳疆娆?
                # 鏈€澶氶澶栫粰 20 杞鐞嗙敤鎴锋寚浠?

            compacted_this_iteration = False
            if iteration > 1 and iteration % compress_interval == 0 and len(messages) > 18:
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
                messages = [
                    messages[0],
                    {
                        "role": "user",
                        "content": (
                            "上下文已压缩到 .autocode/CONTEXT_SUMMARY.md。"
                            "请读取该摘要并结合最近消息继续执行，不要重复已完成的工作。"
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

            # 鈹€鈹€ v2.0: 浣跨敤 LLMClient 鍙戦€佽姹?鈹€鈹€
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
                tools=AGENT_TOOLS,
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

            # 鈹€鈹€ 澶勭悊宸ュ叿璋冪敤 鈹€鈹€
            if response.has_tool_calls:
                iteration_before_snapshot = _workspace_file_snapshot(ws_path)
                iteration_written_files: list[str] = []
                iteration_ran_bash = False
                iteration_bash_exit_code: int | None = None
                iteration_bash_output: str = ""
                for tc in response.tool_calls:
                    tool_name = tc.name
                    tool_args = tc.arguments


                    step_msg = tool_registry.describe_invocation(tool_name, tool_args, progress=True)
                    _update_progress(step_msg)

                    log("info", step_msg, agent_type)

                    cache_key = _tool_cache_key(tool_name, tool_args, workspace_version)
                    stable_tool_key = f"{tool_name}:{_stable_json(tool_args)}"
                    tool_call_counts[stable_tool_key] = tool_call_counts.get(stable_tool_key, 0) + 1
                    if cache_key and cache_key in tool_cache:
                        repeated_tool_suppressed += 1
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

                    if tool_call_counts[stable_tool_key] >= 3 and tool_registry.is_cacheable(tool_name):
                        repeated_tool_suppressed += 1
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
                    if cache_key and result:
                        tool_cache[cache_key] = result
                    if tool_registry.mutates_workspace(tool_name) and tool_name in {"write_file", "apply_patch"}:
                        rel_written = str(tool_args.get("path", "")).strip().replace("\\", "/").lstrip("/")
                        if result.startswith("[OK]") and rel_written:
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
                    elif tool_name == "git_commit":
                        commands_count += 1
                    elif tool_name == "bash":
                        commands_count += 1
                        iteration_ran_bash = True
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

                    # 灏嗗伐鍏锋墽琛岃繘搴︽帹閫佸埌瀵硅瘽 SSE锛堢敤鎴峰彲瑙侊級
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

                    # 浣跨敤 OpenAI-compatible 鏍煎紡杩藉姞娑堟伅
                    # DeepSeek 鎺ㄧ悊妯″瀷闇€瑕佷紶鍥?reasoning_content
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
                        # 娴佸紡鎺ㄩ€佹€濊€冭繃绋嬪埌鍓嶇
                        self._push_tool_progress(task_id, 'thinking', {'content': response.reasoning_content}, '')
                        assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": f"[{tool_name} 鎵ц缁撴灉]\n{result}",
                    })
                    messages[-1]["content"] = f"[{tool_name} result]\n{result_for_model}"

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
                        "content": "你已经写入了文件，但还没有运行验证命令。请立即运行验证命令（如 python -m py_compile、npm run build 等）确认代码没有语法错误。如果验证失败，分析错误并修复，不要停下来等用户。",
                    })
                    log("info", f"[{agent_type}] validation gate: remind Agent to run validation", "orchestrator")
                elif (
                    iteration_ran_bash
                    and iteration_bash_exit_code is not None
                    and iteration_bash_exit_code != 0
                    and validation_failure_reminded_at_command_count != commands_count
                ):
                    validation_failure_reminded_at_command_count = commands_count
                    messages.append({
                        "role": "user",
                        "content": f"验证命令失败（退出码 {iteration_bash_exit_code}）。\n输出内容:\n{iteration_bash_output[:1500]}\n\n请分析上面的错误信息，修复代码中的问题，然后重新运行验证。不要停下来等用户，自己修复直到验证通过。",
                    })
                    log("info", f"[{agent_type}] validation gate: validation failed(exit={iteration_bash_exit_code}), asking Agent to fix", "orchestrator")

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
                # 鍙湁鏂囨湰銆佹棤宸ュ叿璋冪敤鏃讹紝杩藉姞鏅€?assistant 娑堟伅
                if not response.has_tool_calls:
                    assistant_msg = {"role": "assistant", "content": response.content}
                    if response.reasoning_content:
                        # 娴佸紡鎺ㄩ€佹€濊€冭繃绋嬪埌鍓嶇
                        assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)

                log("success", response.content[:200], agent_type)
                # 鏇存柊杩涘害锛氭鍦ㄨ鍒?鐢熸垚
                _update_progress("姝ｅ湪缂栧啓浠ｇ爜鍜岃鍒掓柟妗?..")

                # 鈹€鈹€ 灏?Agent 鍝嶅簲鎺ㄩ€佸埌瀵硅瘽 SSE 闃熷垪锛堜粎鎺ㄩ€侀潪宸ュ叿璋冪敤鐨勬枃鏈唴瀹癸級鈹€鈹€
                if not response.has_tool_calls:
                    self._push_agent_response(task_id, response.content)

                # 妫€鏌ユ槸鍚﹀畬鎴?
                content_lower = response.content.lower()
                if any(kw in content_lower for kw in ["????", "???", "done", "completed", "all done"]):
                    log("success", f"[{agent_type}] ????", agent_type)
                    break

            # 娌℃湁宸ュ叿璋冪敤涔熸病鏈夋枃鏈?鈫?LLM 鍙兘缁撴潫
            if not response.has_tool_calls and not response.content:
                # 鎺ㄧ悊妯″瀷鍙兘鍙繑鍥?reasoning_content 鑰屾棤姝ｆ枃锛屼篃闇€璁板綍
                if response.reasoning_content:
                    # 娴佸紡鎺ㄩ€佹€濊€冭繃绋嬪埌鍓嶇
                    assistant_msg = {"role": "assistant", "content": None}
                    assistant_msg["reasoning_content"] = response.reasoning_content
                    messages.append(assistant_msg)
                else:
                    log("info", f"[{agent_type}] LLM 杩斿洖绌哄搷搴旓紝缁撴潫", agent_type)
                    break

            await asyncio.sleep(0.5)

        # 妫€鏌ユ槸鍚﹀洜杩唬涓婇檺鑰岄€€鍑?
        after_snapshot_for_limit = _workspace_file_snapshot(ws_path)
        changed_files_for_limit = _snapshot_changed(before_snapshot, after_snapshot_for_limit)
        has_meaningful_progress = bool(
            writes_count > 0
            or effective_progress_count > 0
            or _has_meaningful_output_artifact(ws_path, changed_files_for_limit)
        )
        suppress_iteration_limit_continuation = False
        if iteration >= max_iterations and has_meaningful_progress:
            log(
                "info",
                f"[{agent_type}] reached iteration budget after producing artifacts; no auto-continuation needed.",
                "agent_efficiency",
            )
            task.pop("needs_continuation", None)
            task.pop("agent_iteration_limited", None)
            task.pop("agent_iteration_limit_reason", None)
            suppress_iteration_limit_continuation = True

        if iteration >= max_iterations and not suppress_iteration_limit_continuation:
            # 淇濆瓨褰撳墠鐘舵€佸埌 MEMORY.md 鏀寔鏂偣缁窇
            self._update_workspace_memory(
                ws_path, task_id,
                status="needs_continuation",
                phase=f"迭代上限({max_iterations})",
                issues=[f"达到 {max_iterations} 轮迭代上限，任务可能尚未完全完成"],
                decisions=[f"共执行 {iteration} 轮 LLM 迭代"],
                iteration=iteration,
            )
            # 鍚屾椂淇濆瓨娑堟伅鍘嗗彶鎽樿
            summary_file = ws_path / ".autocode" / "SESSION_SUMMARY.md"
            summary_lines = [
                f"# 会话摘要 - {task_id[:8]}",
                "",
                f"> 截断时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
                f"> Agent: {agent_type}",
                f"> 总轮次: {iteration}/{max_iterations}",
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
                f"[{agent_type}] 达到迭代上限 {max_iterations}，状态已保存到 .autocode/"
                f"MEMORY.md + SESSION_SUMMARY.md。系统将自动续跑或等待用户点击继续。",
                "orchestrator")
            task["needs_continuation"] = True

        # 璁板綍杩唬娆℃暟渚?execute_task 浣跨敤
        if task.get("needs_continuation") and iteration >= max_iterations and not suppress_iteration_limit_continuation:
            task["agent_iteration_limited"] = True
            task["agent_iteration_limit_reason"] = "per_run_iteration_budget"
            task["current_step"] = "达到单段迭代上限，正在自动压缩上下文并继续。"
            self._push_phase_progress(
                task_id,
                "auto_continuation_checkpoint",
                task["current_step"],
            )
            log(
                "warn",
                f"[{agent_type}] 达到单段迭代上限 {max_iterations}，后台队列将自动续跑。",
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
        task["last_agent_result"] = {
            "agent_type": agent_type,
            "iterations": iteration,
            "iteration_limited": bool(task.get("agent_iteration_limited")),
            "writes_count": writes_count,
            "commands_count": commands_count,
            "repeated_tool_suppressed": repeated_tool_suppressed,
            "validated_after_write": validated_after_write,
            "changed_files": changed_files[:50],
            "source_files": _count_source_files(ws_path),
        }
        return bool(changed_files or writes_count > 0)

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
            if permission.needs_approval and (spec.requires_confirmation if spec else tool_name in {"bash", "rollback", "start_preview", "spawn_subagent"}):
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

            if tool_name == "read_file":
                task_for_guard = _tasks.get(task_id)
                blocked = _check_retrieval_read_guard(task_for_guard, str(args.get("path", "")))
                if blocked:
                    if task_for_guard is not None:
                        self._persist_task(task_id)
                    log("warn", f"retrieval guard blocked read_file: {args.get('path', '')}", "retrieval_guard")
                    return blocked
                if task_for_guard is not None:
                    self._persist_task(task_id)

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

                if tool_name in {"write_file", "apply_patch"}:
                    rel_path = str(args.get("path", "")).strip().replace("\\", "/").lstrip("/")
                    allowed, reason = _role_can_write_path(agent_type, rel_path, ws_path)
                    if not allowed:
                        await _record_role_write_block(
                            task_id=task_id,
                            agent_type=agent_type,
                            rel_path=rel_path,
                            reason=reason,
                            persist=self._persist_task,
                        )
                        log("warn", f"鏈湴鎵ц鍐欏叆琚鑹叉枃浠惰竟鐣屾嫤鎴? {rel_path}", agent_type, reason)
                        return f"[閿欒] {reason}"

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
                    if tool_name in {"write_file", "apply_patch"} and ok:
                        rel_path = str(local_result.get("path") or args.get("path") or "").strip().replace("\\", "/").lstrip("/")
                        content = local_result.get("content")
                        if rel_path and isinstance(content, str):
                            mirror_path = _safe_workspace_path(ws_path, rel_path, must_exist=False)
                            mirror_path.parent.mkdir(parents=True, exist_ok=True)
                            mirror_path.write_text(content, encoding="utf-8")
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
                            "mirrored_to_workspace": tool_name in {"write_file", "apply_patch"} and ok,
                        },
                        source="local_runner",
                    )
                    self._persist_task(task_id)
                    prefix = "[LOCAL] "
                    exit_marker = f" [exit_code={exit_code}]" if exit_code != 0 else ""
                    if output:
                        output = output_meta["model_preview"]
                    return (prefix + output[:4000] + exit_marker) if output else f"{prefix}[完成]"
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
                    log("warn", f"鏈湴 Runner 鎵ц澶辫触锛屽洖閫€鍒版湇鍔″櫒鎵ц: {tool_name} - {exc}", "local_runner")

            if tool_name == "read_file":
                path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=True)
                if not path.exists():
                    return f"[閿欒] 鏂囦欢涓嶅瓨鍦? {args['path']}"
                if not path.is_file():
                    return f"[閿欒] 涓嶆槸鏂囦欢: {args['path']}"
                return path.read_text(encoding="utf-8")[:3000]

            elif tool_name == "write_file":
                rel_path = str(args.get("path", "")).strip().replace("\\", "/").lstrip("/")
                allowed, reason = _role_can_write_path(agent_type, rel_path, ws_path)
                if not allowed:
                    await _record_role_write_block(
                        task_id=task_id,
                        agent_type=agent_type,
                        rel_path=rel_path,
                        reason=reason,
                        persist=self._persist_task,
                    )
                    log("warn", f"鐟欐帟澹婇弬鍥︽鏉堝湱鏅梼缁橆剾閸愭瑥鍙? {rel_path}", agent_type, reason)
                    return f"[闁挎瑨顕 {reason}"
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
                                "ownership_file": ".autocode/ROLE_OWNERSHIP.md",
                            },
                            source="security",
                        )
                        self._persist_task(task_id)
                    log("warn", f"瑙掕壊鏂囦欢杈圭晫闃绘鍐欏叆: {rel_path}", agent_type, reason)
                    return f"[閿欒] {reason}"
                path = _safe_workspace_path(ws_path, args.get("path", ""), must_exist=False)
                parent = path.parent
                parent.mkdir(parents=True, exist_ok=True)
                if path.exists():
                    path.resolve(strict=True).relative_to(ws_path.resolve())
                    if path.is_dir():
                        return f"[閿欒] 涓嶈兘瑕嗙洊鐩綍: {args['path']}"
                path.write_text(args["content"], encoding="utf-8")
                if not str(path.relative_to(ws_path)).replace("\\", "/").startswith(".autocode/"):
                    invalidate_workspace_index(ws_path)
                log("success", f"宸插啓鍏? {args['path']} ({len(args['content'])} 瀛楃)", agent_type)
                return f"[OK] 鏂囦欢宸插啓鍏? {args['path']}"

            elif tool_name == "bash":
                timeout = args.get("timeout", 120)
                task = _tasks.get(task_id)
                command_record = None
                if task:
                    command_record = _append_command_record(
                        task,
                        args["command"],
                        "running",
                        label=f"{agent_type} 鎵ц鍛戒护",
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
                    log("warn", f"鍛戒护閫€鍑虹爜 {result['exit_code']}: {args.get('command', '')}", agent_type)
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
                return (output[:2000] + exit_marker) or "[鍛戒护鎵ц瀹屾垚锛屾棤杈撳嚭]"

            elif tool_name == "glob":
                import fnmatch
                pattern = _safe_glob_pattern(args["pattern"])
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
                return "\n".join(matches[:100]) or "[鏃犲尮閰嶆枃浠禲"

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
                    return "[閿欒] search_code 闇€瑕?pattern 鍙傛暟"
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

            elif tool_name == "apply_patch":
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
                    # 灏濊瘯鍘婚櫎棣栧熬绌虹櫧鍚庡尮閰?

                    stripped = search_text.strip()
                    if stripped and stripped in original:
                        original = original.replace(stripped, replace_text, 1)
                    else:
                        # 杩斿洖鏂囦欢涓墠鍚?500 瀛楃甯姪瀹氫綅
                        preview = original[:500] if len(original) > 500 else original
                        return f"[错误] search 文本未在文件中找到匹配。文件前 500 字符:\n{preview}"
                else:
                    original = original.replace(search_text, replace_text, 1)
                target_path.write_text(original, encoding="utf-8")
                rel_path = str(target_path.relative_to(ws_path)).replace("\\", "/")
                if not rel_path.startswith(".autocode/"):
                    invalidate_workspace_index(ws_path)
                log("success", f"精确编辑: {rel_path}", agent_type)
                return f"[OK] 已编辑 {rel_path}（search/replace 成功）"

            elif tool_name == "git_commit":
                status = git_manager.status(ws_path)
                if not status.get("dirty"):
                    return "[OK] No changes to commit; the latest automatic snapshot already represents this workspace state."
                message = args.get("message") or "AutoCode update"
                hash_ = git_manager.auto_commit(ws_path, ["."], message)
                if not hash_:
                    return "[OK] No commit created; there were no commit-worthy changes after filtering volatile files."
                log("success", f"Git 鎻愪氦: {message}", agent_type)
                return f"[OK] 鎻愪氦 {str(hash_)[:12]}: {message}"

            elif tool_name == "request_confirmation":
                task = _tasks.get(task_id)
                if task:
                    task["status"] = "waiting_confirm"
                    task["pending_confirmation"] = {
                        "action": args["action"],
                        "path": args["path"],
                        "reason": args["reason"],
                    }
                    log("warn", f"Waiting user confirm: {args['action']} {args['path']}", agent_type)

                for _ in range(300):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and conf.get("confirmed"):
                        _confirmations.pop(task_id, None)
                        task = _tasks.get(task_id)
                        if task:
                            task["status"] = "running"
                        log("success", f"User confirmed: {conf['path']}", agent_type)
                        return f"[CONFIRMED] {args['action']} approved by user"
                    task = _tasks.get(task_id)
                    if task and task["status"] == "cancelled":
                        return "[CANCELLED] Task cancelled by user"

                return "[TIMEOUT] No confirmation in 5 minutes, cancelled"

            elif tool_name == "generate_prototype":
                from core.prototype_generator import generate_prototype, save_prototype
                log("info", f"正在生成 UI 原型: {args.get('description', '')[:60]}...", agent_type)
                result = await generate_prototype(args["description"], llm_client=self._llm)
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
