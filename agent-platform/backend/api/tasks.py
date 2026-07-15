# -*- coding: utf-8 -*-
"""Task  ? SSE ?+ MySQL ?"""
import asyncio
import hashlib
import io
import re
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse, FileResponse, Response
from pydantic import BaseModel, Field
import json

from core.agent_orchestrator import _execution_mode, agent_orchestrator
from core.redis import publish_task_event, subscribe_task_events
from core.config import get_settings
from core.docker_manager import docker_manager
from core.project_recon import run_project_recon
from core.state import _tasks, _confirmations
from schemas.task import TaskCreate, TaskResponse, TaskStatusResponse, AgentLogEntry
from services.task_repository import init_table, load_all_tasks, save_task, delete_task as repo_delete_task
from services import harness_repository
from services.task_queue import task_queue
from services.local_runner_manager import local_runner_manager
from services.usage_reporter import UsageContext, _usage_context
from runtime.agent_loop import agent_loop
from runtime.session_events import append_event, events_since
from runtime.tool_output_store import bound_tool_output
from runtime.tool_registry import tool_registry


router = APIRouter()


def _get_user_id(request: Request) -> Optional[str]:
    """ X-User-Id  ID?"""
    user_id = request.headers.get("X-User-Id")
    if user_id:
        return user_id.strip()
    return None


def _get_request_ip(request: Request) -> Optional[str]:
    forwarded = request.headers.get("X-Forwarded-For") or request.headers.get("x-forwarded-for")
    if forwarded:
        first = forwarded.split(",")[0].strip()
        if first:
            return first
    real_ip = request.headers.get("X-Real-IP") or request.headers.get("x-real-ip")
    if real_ip and real_ip.strip():
        return real_ip.strip()
    return request.client.host if request.client else None


def _verify_task_ownership(task: dict, request: Request, user_id: Optional[str] = None):
    """?"
    
    Args:
        task: 
        request: FastAPI Request?X-User-Id?
        user_id:  userId?EventSource ?
    
    ?
    -  user_id
    - ?
    -  userId 
    """
    task_user_id = task.get("user_id")
    if not task_user_id:
        return  #  userId?
    request_user_id = user_id or _get_user_id(request)
    if not request_user_id:
        raise HTTPException(status_code=401, detail="?")
    if str(task_user_id) != str(request_user_id):
        raise HTTPException(status_code=403, detail="?")


#  ?
TERMINAL_TASK_STATUSES = {"completed", "failed", "cancelled"}
WAITING_TASK_STATUSES = {"waiting_confirm", "waiting_plan_confirm", "waiting_prototype_confirm", "waiting_review_confirm"}
TOOL_POLICIES = {"ask", "auto_safe", "full_access"}


class ToolPolicyUpdateRequest(BaseModel):
    tool_policy: str = Field(default="full_access")


class TaskUpdateRequest(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    description: Optional[str] = None


def _normalize_tool_policy(value: Optional[str]) -> str:
    raw = str(value or "full_access").strip().lower()
    aliases = {
        "ask": "ask",
        "manual": "ask",
        "request_approval": "ask",
        "auto": "auto_safe",
        "auto_safe": "auto_safe",
        "approve_safe": "auto_safe",
        "risk_only": "auto_safe",
        "full": "full_access",
        "full_access": "full_access",
        "yolo": "full_access",
    }
    return aliases.get(raw, "full_access")


def _now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


def _workspace_root_for_task(task: dict) -> Path | None:
    ws_id = task.get("workspace_id")
    if not ws_id:
        return None
    return get_settings().workspace_base_dir / ws_id


def _bound_task_output(task: dict, output: str, *, tool_name: str = "bash") -> dict | None:
    workspace_root = _workspace_root_for_task(task)
    if not workspace_root:
        return None
    return bound_tool_output(workspace_root, output, tool_name=tool_name)


def _append_task_log(task: dict, level: str, message: str, *, agent: str = "system", detail: str | None = None, **extra):
    entry = {
        "timestamp": _now_iso(),
        "agent": agent,
        "level": level,
        "message": message,
    }
    if detail:
        entry["detail"] = detail
    entry.update({k: v for k, v in extra.items() if v is not None})
    task.setdefault("logs", []).append(entry)
    return entry


def _append_command_record(
    task: dict,
    command: str,
    status: str,
    *,
    label: str = "",
    output: str = "",
    exit_code: int | None = None,
    source: str = "manual",
    output_meta: dict | None = None,
):
    meta = output_meta or {}
    record = {
        "id": f"cmd-{uuid.uuid4().hex[:12]}",
        "command": command,
        "label": label or command,
        "status": status,
        "source": source,
        "output": meta.get("preview") if output_meta else (output[-12000:] if output else ""),
        "output_truncated": bool(meta.get("truncated")),
        "output_path": meta.get("full_path") or "",
        "output_sha256": meta.get("sha256") or "",
        "output_chars": meta.get("chars") or (len(output) if output else 0),
        "output_lines": meta.get("lines") or (output.count("\n") + 1 if output else 0),
        "exit_code": exit_code,
        "started_at": _now_iso(),
        "finished_at": _now_iso() if status in ("success", "failed") else None,
    }
    task.setdefault("command_history", []).append(record)
    task["command_history"] = task["command_history"][-80:]
    return record


_LEGACY_PLAN_TITLE_MAP = {
    "Define script contract": "",
    "Implement core script behavior": "",
    "Smoke test and usage notes": "?",
    "Map existing project entrypoints": "",
    "Implement focused change": "",
    "Validate and document result": "?",
}

_LEGACY_PLAN_DESC_REPLACEMENTS = {
    "Create a concise SCRIPT_CONTRACT.md in the project root. Clarify inputs, outputs, configuration options, edge cases, and the planned entrypoint. Do not implement code in this phase.": " SCRIPT_CONTRACT.md?",
    "Implement the requested behavior:": "",
    "Include validation, error handling, and safe file operations where applicable.": "?",
    "Run validation": "",
    "add or update usage examples, and summarize the command needed to use the script.": "?",
    "Read PROJECT_PROFILE.md, PROJECT_MAP.md, and the detected entrypoints. Identify the smallest set of files needed for the requested change.": " PROJECT_PROFILE.mdROJECT_MAP.md ?",
    "Implement the requested change without rewriting unrelated project structure:": "?",
    "Run available validation": "",
    "fix failures, and document what changed.": "?",
}


def _normalize_plan_for_resume(task: dict, *, reset_status: bool = True) -> None:
    """Normalize persisted old plans before retry/chat continuation."""
    plan = task.get("plan")
    if not isinstance(plan, dict):
        return
    completed_subtask_ids: set[str] = set()
    for review in task.get("phase_reviews") or []:
        if not isinstance(review, dict):
            continue
        passed = review.get("passed") is True or (
            isinstance(review.get("score"), (int, float))
            and review.get("score") >= 80
            and not review.get("issues")
        )
        if not passed:
            continue
        for st in review.get("subtasks") or []:
            if isinstance(st, dict) and st.get("id"):
                completed_subtask_ids.add(str(st["id"]))
    for st in plan.get("subtasks") or []:
        if isinstance(st, dict) and st.get("status") == "completed" and st.get("id"):
            completed_subtask_ids.add(str(st["id"]))
    if isinstance(plan.get("overall_approach"), str):
        plan["overall_approach"] = plan["overall_approach"].replace(
            "Use a lightweight script flow: contract, implementation, smoke test, usage notes.",
            "?",
        ).replace(
            "Use a lightweight imported-project flow: map entrypoints, make a focused change, validate.",
            "?",
        )
    if isinstance(plan.get("architecture"), str):
        plan["architecture"] = plan["architecture"].replace(
            "Project Recon classified this task as",
            "?",
        ).replace(
            "Heavy PRD, architecture, database, and UI prototype gates are skipped unless explicitly needed.",
            " PRD?UI ?",
        )
    for st in plan.get("subtasks") or []:
        if not isinstance(st, dict):
            continue
        title = str(st.get("title") or "")
        if title in _LEGACY_PLAN_TITLE_MAP:
            st["title"] = _LEGACY_PLAN_TITLE_MAP[title]
        desc = str(st.get("description") or "")
        for old, new in _LEGACY_PLAN_DESC_REPLACEMENTS.items():
            desc = desc.replace(old, new)
        desc = desc.replace("Use detected entrypoints:", "").replace("none", "")
        st["description"] = desc
        if reset_status:
            if str(st.get("id") or "") in completed_subtask_ids:
                st["status"] = "completed"
                st["progress"] = 100
            elif st.get("status") in ("running", "failed", "skipped", "completed"):
                st["status"] = "pending"
                st["progress"] = 0
    task["current_subtask_id"] = None


def _is_safe_custom_command(command: str) -> tuple[bool, str]:
    compact = re.sub(r"\s+", " ", command or "").strip()
    if not compact:
        return False, "命令不能为空"
    if len(compact) > 240:
        return False, "命令过长，请拆分后执行"
    if re.search(r"[;&|`$<>]", compact):
        return False, "命令包含不允许的 shell 控制字符"
    if re.search(r"(^|\s)(rm|del|rmdir|mkfs|shutdown|reboot|curl|wget|scp|ssh|sudo)\b", compact, re.I):
        return False, "命令包含危险操作、网络访问或远程连接指令"
    allowed = (
        r"^(npm|pnpm|yarn) (run )?[A-Za-z0-9:_-]+$",
        r"^(npm|pnpm|yarn) (test|build|lint|install)$",
        r"^python -m (py_compile|compileall|pytest)( [A-Za-z0-9_./\\-]+)*$",
        r"^pytest( -q)?$",
        r"^mvn( -DskipTests)? (test|package|compile)$",
        r"^go (test|build) \./\.\.\.$",
        r"^node [A-Za-z0-9_./\\-]+\.(js|mjs|cjs)$",
        r"^python [A-Za-z0-9_./\\-]+\.py$",
    )
    if not any(re.match(pattern, compact) for pattern in allowed):
        return False, "命令不在安全白名单内"
    if ".." in compact.replace("\\", "/").split("/"):
        return False, "命令路径不能包含上级目录跳转"
    return True, ""


def _refresh_git_history(task: dict, message: str, files: list[str] | None = None) -> str | None:
    try:
        from core.config import get_settings
        from core.git_manager import git_manager
        ws_id = task.get("workspace_id")
        if not ws_id:
            return None
        ws_path = get_settings().workspace_base_dir / ws_id
        hash_ = git_manager.auto_commit(ws_path, files or ["."], message)
        if hash_:
            task["commit_history"] = git_manager.log(ws_path, max_count=30)
            _append_task_log(task, "success", f"Snapshot committed: {message}", agent="git", detail=hash_)
        return hash_
    except Exception as e:
        _append_task_log(task, "warn", "Snapshot commit failed", agent="git", detail=str(e))
        return None

def _is_development_request(message: str) -> bool:
    """Fallback only: identify requests that clearly ask the agent to change work."""
    text = (message or "").strip()
    if not text:
        return False
    lower = text.lower()
    non_dev_markers = (
        "怎么用", "如何使用", "使用方法", "用法", "怎么运行", "如何运行",
        "解释", "说明", "是什么", "为什么", "how to use", "usage", "what is", "why",
    )
    change_markers = (
        "修改", "修复", "新增", "增加", "添加", "删除", "移除", "实现", "支持",
        "开发", "继续", "重试", "重新执行", "优化", "调整", "改成", "补充", "生成",
        "完善", "重构", "接入", "适配", "升级", "扩展", "新功能", "不对", "不行",
        "不好", "有问题", "还是这样", "没变化", "效果不好", "报错", "失败", "异常",
        "错误", "缺少", "不显示", "无法", "不能", "fix", "change", "modify", "add",
        "remove", "delete", "implement", "develop", "retry", "rerun", "refactor", "support",
        "optimize", "optimise",
    )
    concrete_code_markers = re.search(
        r"(`[^`]+`|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*|"
        r"[A-Za-z_][A-Za-z0-9_]*\(|\.(?:py|js|ts|tsx|java|go|rs|sh|ps1|sql|yml|yaml|json|md)\b)",
        text,
    )
    has_change = any(marker in lower for marker in change_markers)
    has_non_dev = any(marker in lower for marker in non_dev_markers)
    if has_change or (concrete_code_markers and not has_non_dev):
        return True
    if has_non_dev:
        return False
    pure_question = bool(re.search(r"(怎么|如何|为什么|是什么|说明|解释|介绍|使用|用法|how|why|what)", text, re.I))
    change_intent = re.search(
        r"(修改|修复|新增|增加|添加|加上|删除|移除|实现|支持|开发|继续|重试|重新执行|优化|调整|改成|"
        r"补充|生成|完善|重构|接入|适配|升级|扩展|新增功能|新功能|"
        r"不对|不行|不好|有问题|还是这样|没变化|效果不好|报错|失败|异常|错误|缺少|不显示|无法|不能|"
        r"fix|change|modify|add|remove|delete|implement|develop|retry|rerun|refactor|support|optimi[sz]e)",
        text,
        flags=re.I,
    )
    imperative = re.search(r"(请|帮我|给我|把|将|需要|要求|让|直接|现在|继续|开始|做|改|实现)", text, re.I)
    return bool(change_intent and (imperative or not pure_question))


def _looks_like_noop_menu_answer(answer: str) -> bool:
    text = (answer or "").strip()
    if not text:
        return True
    menu_markers = [
        "你可以让我解释用法",
        "打开文件、运行测试、查看 Git Diff",
        "明确说明要继续修改的内容",
        "you can ask me to",
    ]
    return any(marker.lower() in text.lower() for marker in menu_markers)


def _controller_decision_needs_fallback(decision: dict | None) -> bool:
    if not isinstance(decision, dict):
        return True
    action = str(decision.get("action") or "").strip()
    answer = str(decision.get("answer") or "").strip()
    if not action:
        return True
    if action == "answer" and (
        not answer
        or any(marker in answer for marker in ("�", "閹", "瀹", "閺", "閻", "鍛", "浠"))
        or _looks_like_noop_menu_answer(answer)
    ):
        return True
    return False


def _fallback_chat_decision(message: str, task: dict | None = None) -> dict:
    """Local fallback only when the AI controller fails or returns an unusable answer."""
    local_action = _detect_chat_action(message)
    if local_action:
        return {"action": local_action.get("type"), **local_action}
    if _is_development_request(message) or not _is_clear_non_development_question(message):
        return {
            "action": "continue_development",
            "answer": "我会基于当前工作区分析你的需求，继续修改、验证并生成新的快照。",
            "reason": "local_fallback_controller_unusable",
        }
    return {
        "action": "answer",
        "answer": "我会结合当前工作区回答这个问题。",
        "reason": "local_fallback_controller_unusable",
    }


def _is_clear_non_development_question(message: str) -> bool:
    text = (message or "").strip()
    if not text:
        return False
    if _detect_chat_action(text):
        return True
    if _is_development_request(text):
        return False
    lower = text.lower()
    if any(marker in lower for marker in (
        "怎么用", "如何使用", "使用方法", "用法", "怎么运行", "如何运行",
        "解释", "说明", "是什么", "为什么", "状态", "总结",
        "how to use", "usage", "what is", "why",
    )):
        return True
    return bool(re.search(r"(鎬庝箞鐢▅濡備綍浣跨敤|浣跨敤鏂规硶|鐢ㄦ硶|鎬庝箞杩愯|濡備綍杩愯|瑙ｉ噴|璇存槑|鏄粈涔坾涓轰粈涔坾鐘舵€亅鎬荤粨|how to use|usage|what is|why)", text, re.I))


def _is_vague_continue_confirmation(message: str) -> bool:
    text = re.sub(r"\s+", "", message or "")
    return text in {
        "继续", "继续修改", "继续开发", "继续任务", "继续修改当前项目",
        "是", "是的", "对", "确认", "按你说的继续", "就这样继续",
    }


def _build_chat_continuation_message(task: dict, current_message: str) -> str:
    current = (current_message or "").strip()
    if not _is_vague_continue_confirmation(current):
        return current

    recent_user_messages: list[str] = []
    for entry in reversed(task.get("logs") or []):
        if entry.get("level") != "chat_user":
            continue
        msg = str(entry.get("message") or "").strip()
        if not msg or msg == current or msg in recent_user_messages:
            continue
        recent_user_messages.append(msg)
        if len(recent_user_messages) >= 3:
            break

    if not recent_user_messages:
        return current

    context = "\n".join(f"- {msg}" for msg in reversed(recent_user_messages))
    return (
        f"用户当前确认继续修改当前项目：{current}\n\n"
        f"请结合用户刚才的反馈继续处理，不要把这句话当成独立需求。\n\n"
        f"最近用户反馈：\n{context}"
    )


def _prepare_task_for_chat_continuation(task: dict, continuation_message: str) -> None:
    """Move any terminal task back to a runnable incremental-development state."""
    previous_status = str(task.get("status") or "")
    task["last_terminal_status"] = previous_status if previous_status else task.get("last_terminal_status", "")
    task["chat_continuation_message"] = _build_chat_continuation_message(task, continuation_message)
    task["needs_continuation"] = True
    task["status"] = "pending"
    task["execution_active"] = False
    task.pop("completed_at", None)
    task.pop("error", None)
    task.pop("failure_type", None)
    task.pop("pending_confirmation", None)
    task["current_step"] = "AI 助手已接管，等待后台增量执行"
    append_event(
        task,
        "chat_continuation_queued",
        {
            "message": continuation_message[:1000],
            "from_status": previous_status,
        },
        source="chat_controller",
    )

def _read_workspace_note(task_id: str, rel_path: str, limit: int = 5000) -> str:
    try:
        path = _resolve_workspace_path(task_id, rel_path)
        if not path.exists() or not path.is_file() or not _is_text_file(path):
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")[:limit]
    except Exception:
        return ""

def _extract_usage_commands(*texts: str) -> list[str]:
    commands: list[str] = []
    seen: set[str] = set()
    patterns = [
        r"`([^`\n]*(?:python|pytest|npm|pnpm|yarn|node|mvn|go run|go test)[^`\n]*)`",
        r"(?m)^\s*((?:python|pytest|npm|pnpm|yarn|node|mvn|go run|go test)\s+[^\n\r]+)",
    ]
    for text in texts:
        for pattern in patterns:
            for match in re.findall(pattern, text or "", flags=re.I):
                command = re.sub(r"\s+", " ", str(match)).strip()
                if command and command not in seen:
                    seen.add(command)
                    commands.append(command)
    return commands[:8]

def _build_usage_help_message(task_id: str, task: dict) -> str:
    profile = _read_workspace_note(task_id, ".autocode/PROJECT_PROFILE.md", 3000)
    commands_md = _read_workspace_note(task_id, ".autocode/COMMANDS.md", 4000)
    contract = _read_workspace_note(task_id, "SCRIPT_CONTRACT.md", 6000)
    readme = _read_workspace_note(task_id, "README.md", 6000) or _read_workspace_note(task_id, "readme.md", 6000)
    ci_report = _read_workspace_note(task_id, ".autocode/CI_REPORT.md", 3000)
    commands = _extract_usage_commands(readme, contract, commands_md, ci_report)

    if not commands:
        try:
            ws_root = _resolve_workspace_path(task_id, "/")
            candidates = [
                "main.py", "app.py", "cli.py",
                *[str(p.relative_to(ws_root)).replace("\\", "/") for p in ws_root.glob("*/cli.py")],
                *[str(p.relative_to(ws_root)).replace("\\", "/") for p in ws_root.glob("*/__main__.py")],
            ]
            for candidate in candidates:
                if (ws_root / candidate).exists():
                    commands.append(f"python {candidate} --help")
                    break
        except Exception:
            pass
    if not commands:
        commands.append("python -m compileall .")

    changed_files: list[str] = []
    for review in (task.get("phase_reviews") or []) + ([task.get("review")] if task.get("review") else []):
        if not isinstance(review, dict):
            continue
        artifacts = ((review.get("dimensions") or {}).get("phase_artifacts") or {})
        for file in artifacts.get("changed_files") or []:
            if file and file not in changed_files:
                changed_files.append(str(file))

    lines = [
        "### 使用说明",
        "",
        f"任务：{task.get('title') or 'AutoCode 项目'}",
        "",
        "我会根据当前工作区已有文件、契约文档和命令记录给出可执行的使用方式。",
        "",
        "#### 推荐命令",
    ]
    for command in commands:
        lines.append(f"- `{command}`")

    if changed_files:
        lines.extend(["", "#### 主要文件"])
        for file in changed_files[:12]:
            lines.append(f"- `{file}`")

    if contract:
        snippet = re.sub(r"\n{3,}", "\n\n", contract.strip())[:1200]
        lines.extend(["", "#### 契约摘要", snippet])
    elif readme:
        snippet = re.sub(r"\n{3,}", "\n\n", readme.strip())[:1200]
        lines.extend(["", "#### README 摘要", snippet])
    elif profile:
        snippet = re.sub(r"\n{3,}", "\n\n", profile.strip())[:800]
        lines.extend(["", "#### 项目摘要", snippet])

    lines.extend([
        "",
        "你也可以继续让我打开文件、运行测试、查看 Git Diff、回退某次快照，或者基于当前结果继续修改。",
    ])
    return "\n".join(lines)

def _build_chat_controller_context(task_id: str, task: dict) -> str:
    plan = task.get("plan") or {}
    subtasks = []
    if isinstance(plan, dict):
        for st in plan.get("subtasks") or []:
            if isinstance(st, dict):
                subtasks.append(
                    f"- {st.get('id', '')} {st.get('title', '')}: {st.get('status', 'pending')} "
                    f"({st.get('agent_type', '-')})"
                )
    reviews = []
    for idx, review in enumerate(task.get("phase_reviews") or [], start=1):
        if isinstance(review, dict):
            reviews.append(
                f"- ?{idx} ? {'' if review.get('passed') else ''}, "
                f"score={review.get('score')}, summary={review.get('summary', '')}"
            )
    commands = []
    for cmd in (task.get("command_history") or [])[-8:]:
        if isinstance(cmd, dict):
            commands.append(
                f"- {cmd.get('status', '')}: {cmd.get('command', '')} "
                f"exit={cmd.get('exit_code')}"
            )

    docs = []
    for label, path, limit in [
        ("PROJECT_PROFILE", ".autocode/PROJECT_PROFILE.md", 1800),
        ("COMMANDS", ".autocode/COMMANDS.md", 1600),
        ("SCRIPT_CONTRACT", "SCRIPT_CONTRACT.md", 2200),
        ("README", "README.md", 2200),
        ("CI_REPORT", ".autocode/CI_REPORT.md", 1600),
        ("PROJECT_MAP", ".autocode/PROJECT_MAP.md", 1600),
    ]:
        text = _read_workspace_note(task_id, path, limit)
        if text:
            docs.append(f"## {label}\n{text}")

    changed_files: list[str] = []
    for review in (task.get("phase_reviews") or []) + ([task.get("review")] if task.get("review") else []):
        if not isinstance(review, dict):
            continue
        artifacts = ((review.get("dimensions") or {}).get("phase_artifacts") or {})
        for file in artifacts.get("changed_files") or []:
            file = str(file)
            if file and file not in changed_files:
                changed_files.append(file)

    return "\n\n".join([
        "## Task",
        f"id={task.get('id')}",
        f"title={task.get('title')}",
        f"status={task.get('status')}",
        f"current_step={task.get('current_step')}",
        f"project_type={task.get('project_type')}",
        f"complexity={task.get('complexity')}",
        f"recommended_flow={task.get('recommended_flow')}",
        f"model={task.get('model')}",
        "## Subtasks\n" + ("\n".join(subtasks) if subtasks else "none"),
        "## Reviews\n" + ("\n".join(reviews) if reviews else "none"),
        "## Recent Commands\n" + ("\n".join(commands) if commands else "none"),
        "## Changed Files\n" + ("\n".join(f"- {f}" for f in changed_files[:40]) if changed_files else "none"),
        *docs,
    ])

async def _run_chat_controller(task_id: str, task: dict, message: str, request: Request) -> dict:
    """Use the runtime AgentLoop as the IDE control brain."""
    token = _usage_context.set(UsageContext(
        user_id=str(task.get("user_id")) if task.get("user_id") else None,
        task_id=task_id,
        scene_type="autocode",
        agent_id="chat_controller",
        request_ip=_get_request_ip(request),
    ))
    try:
        llm = await agent_orchestrator._ensure_client(requested_model=task.get("model"))
        try:
            workspace_root = _resolve_workspace_path(task_id, "/")
        except Exception:
            workspace_root = None
        decision = await agent_loop.decide_chat_action(
            task=task,
            message=message,
            llm=llm,
            workspace_root=workspace_root,
            request_ip=_get_request_ip(request),
        )
    finally:
        _usage_context.reset(token)
    data = decision.raw or {}
    data.update({
        "action": decision.action,
        "confidence": decision.confidence,
        "answer": decision.answer,
    })
    if decision.path:
        data["path"] = decision.path
    if decision.line:
        data["line"] = decision.line
    if decision.command:
        data["command"] = decision.command
    if decision.target:
        data["target"] = decision.target
    return data

def _detect_chat_action(message: str) -> dict | None:
    text = (message or "").strip()
    if not text:
        return None

    if re.search(r"(鎬庝箞鐢▅濡備綍浣跨敤|浣跨敤鏂规硶|鐢ㄦ硶|how to use|usage)", text, flags=re.I):
        return {"type": "answer_usage"}

    file_line_match = re.search(
        r"(?:|||open|show)\s*(?:)?\s*([A-Za-z0-9_.@()+\-/\\]+?\.(?:tsx|ts|jsx|js|mjs|cjs|vue|css|scss|html|md|json|py|java|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|txt))(?:[:#L\s]+(\d+))?",
        text,
        flags=re.I,
    )
    if file_line_match:
        action = {"type": "open_file", "path": file_line_match.group(1).replace("\\", "/").lstrip("/")}
        if file_line_match.group(2):
            action["line"] = int(file_line_match.group(2))
        return action

    file_match = re.search(
        r"(?:鎵撳紑|鏌ョ湅|open|show)\s*(?:鏂囦欢)?\s*([A-Za-z0-9_.@()+\-/\\]+?\.(?:tsx|ts|jsx|js|mjs|cjs|vue|css|scss|html|md|json|py|java|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|txt))",
        text,
        flags=re.I,
    )
    if file_match:
        return {"type": "open_file", "path": file_match.group(1).replace("\\", "/").lstrip("/")}

    if re.search(r"(pipeline|ci|娴佹按绾縷瀹屾暣楠岃瘉)", text, flags=re.I):
        return {"type": "run_pipeline"}

    command_match = re.search(r"(?:run command|execute command|杩愯鍛戒护|鎵ц鍛戒护)\s*[:锛歖?\s*(.+)$", text, flags=re.I)
    if command_match:
        command = command_match.group(1).strip()
        if command:
            return {"type": "run_command", "command": command}

    if re.search(r"(杩愯|鎵ц|璺?.{0,8}(test|tests|娴嬭瘯|build|鏋勫缓)", text, flags=re.I):
        if re.search(r"(build|鏋勫缓)", text, flags=re.I):
            return {"type": "run_command", "command": "build"}
        return {"type": "run_command", "command": "test"}

    if re.search(r"(鏌ョ湅|鎵撳紑|鏄剧ず).{0,8}(diff|鍙樻洿|git)", text, flags=re.I):
        return {"type": "show_git", "target": "working"}

    rollback_confirm_match = re.search(r"(?:纭鍥為€€|纭鎾ら攢).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_confirm_match:
        target = rollback_confirm_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    rollback_match = re.search(r"(?:鍥為€€|鎾ら攢|rollback|revert).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_match:
        target = rollback_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    return None


def _detect_chat_action(message: str) -> dict | None:
    text = (message or "").strip()
    if not text:
        return None

    if re.search(r"(鎬庝箞鐢▅濡備綍浣跨敤|浣跨敤鏂规硶|鐢ㄦ硶|how to use|usage)", text, flags=re.I):
        return {"type": "answer_usage"}

    file_match = re.search(
        r"(?:鎵撳紑|鏌ョ湅|瀹氫綅|open|show)\s*(?:鏂囦欢)?\s*([A-Za-z0-9_.@()+\-/\\]+?\.(?:tsx|ts|jsx|js|mjs|cjs|vue|css|scss|html|md|json|py|java|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|txt))(?:[:#L\s]+(\d+))?",
        text,
        flags=re.I,
    )
    if file_match:
        action = {"type": "open_file", "path": file_match.group(1).replace("\\", "/").lstrip("/")}
        if file_match.group(2):
            action["line"] = int(file_match.group(2))
        return action

    if re.search(r"(pipeline|ci|娴佹按绾縷瀹屾暣楠岃瘉|绔埌绔獙璇?", text, flags=re.I):
        return {"type": "run_pipeline"}

    command_match = re.search(r"(?:run command|execute command|杩愯鍛戒护|鎵ц鍛戒护)\s*[:锛歖?\s*(.+)$", text, flags=re.I)
    if command_match:
        command = command_match.group(1).strip()
        if command:
            return {"type": "run_command", "command": command}

    if re.search(r"(杩愯|鎵ц).{0,8}(test|tests|娴嬭瘯|build|鏋勫缓)", text, flags=re.I):
        return {"type": "run_command", "command": "build" if re.search(r"(build|鏋勫缓)", text, flags=re.I) else "test"}

    if re.search(r"(鏌ョ湅|鎵撳紑|鏄剧ず).{0,8}(diff|鍙樻洿|git|鎻愪氦)", text, flags=re.I):
        return {"type": "show_git", "target": "working"}

    rollback_confirm_match = re.search(r"(?:纭鍥為€€|纭鎾ら攢).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_confirm_match:
        target = rollback_confirm_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    rollback_match = re.search(r"(?:鍥為€€|鎾ら攢|rollback|revert).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_match:
        target = rollback_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    return None


def _sse(event: str, data: dict, task_id: str | None = None) -> str:
    if task_id:
        try:
            asyncio.create_task(publish_task_event(task_id, event, data))
        except Exception:
            pass
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _publish_task_update(task_id: str, event: str, data: dict) -> None:
    """Best-effort live update for panel actions that are not themselves SSE streams."""
    try:
        asyncio.create_task(publish_task_event(task_id, event, data))
    except Exception:
        pass


def _publish_command_history(task_id: str, task: dict) -> None:
    _publish_task_update(task_id, "command_history", {"commands": task.get("command_history", [])[-100:]})

def _infer_workspace_command(task_id: str, kind: str | None) -> str:
    ws_root = _resolve_workspace_path(task_id, "/")
    package_json = ws_root / "package.json"
    if package_json.exists():
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = pkg.get("scripts") or {}
            if kind == "build" and "build" in scripts:
                return "npm run build"
            if kind == "test":
                for script in ("test", "unit", "test:unit", "vitest"):
                    if script in scripts:
                        return f"npm run {script}"
                if "build" in scripts:
                    return "npm run build"
        except Exception:
            pass
    if (ws_root / "pytest.ini").exists() or (ws_root / "pyproject.toml").exists():
        return "pytest -q" if kind == "test" else "python -m compileall ."
    if (ws_root / "pom.xml").exists():
        return "mvn test" if kind == "test" else "mvn -DskipTests package"
    if (ws_root / "go.mod").exists():
        return "go test ./..." if kind == "test" else "go build ./..."
    return "npm test" if kind == "test" else "npm run build"


def _command_label_for_kind(kind: str | None, command: str) -> str:
    if kind == "test":
        return "运行测试"
    if kind == "build":
        return "运行构建"
    if kind == "pipeline":
        return "流水线命令"
    return command


def _is_local_only_task(task: dict) -> bool:
    if not task.get("local_execution_enabled"):
        return False
    if task.get("cloud_snapshot_enabled"):
        return False
    return str(task.get("cloud_snapshot_status") or "").lower() in {"", "not_synced", "disabled", "none"}


async def _execute_workspace_command_record(
    task_id: str,
    task: dict,
    command: str,
    *,
    kind: str | None = "custom",
    source: str = "manual",
    timeout: int = 300,
) -> dict:
    """Execute one workspace-scoped command with persisted status and events."""
    command = re.sub(r"\s+", " ", command or "").strip()
    if not command:
        raise HTTPException(status_code=400, detail="命令不能为空")

    try:
        workspace_root = _resolve_workspace_path(task_id, "/")
    except Exception:
        workspace_root = None

    permission = agent_loop.check_tool_permission(
        task=task,
        tool_name="run_command",
        args={"command": command, "kind": kind, "source": source},
        role="user",
        workspace_root=workspace_root,
    )

    if permission.decision == "deny":
        record = _append_command_record(
            task,
            command,
            "failed",
            label=_command_label_for_kind(kind, command),
            output=f"命令已被安全策略拦截：{permission.reason}",
            exit_code=126,
            source=source,
        )
        event = append_event(
            task,
            "command_blocked",
            {
                "command": command,
                "record_id": record["id"],
                "reason": permission.reason,
                "risk_level": permission.risk_level,
            },
            source="permission",
        )
        _append_task_log(task, "warn", f"命令被拦截: {command}", agent="terminal", detail=permission.reason, tool_name="bash")
        save_task(task)
        _publish_task_update(task_id, "runtime_event", event)
        _publish_command_history(task_id, task)
        return record

    if permission.needs_approval:
        # Manual terminal actions are an explicit user gesture.  Keep the
        # permission event for auditability, but do not require a second modal.
        event = append_event(
            task,
            "permission_manual_approved",
            {
                "tool": "run_command",
                "command": command,
                "reason": permission.reason,
                "risk_level": permission.risk_level,
            },
            source="permission",
        )
        _publish_task_update(task_id, "runtime_event", event)

    record = _append_command_record(
        task,
        command,
        "running",
        label=_command_label_for_kind(kind, command),
        source=source,
    )
    started_event = append_event(
        task,
        "command_started",
        {"command": command, "record_id": record["id"], "kind": kind, "source": source},
        source="terminal",
    )
    _append_task_log(task, "tool_progress", f"执行命令: {command}", agent="terminal", tool_name="bash")
    save_task(task)
    _publish_task_update(task_id, "runtime_event", started_event)
    _publish_command_history(task_id, task)

    try:
        if _is_local_only_task(task):
            local_status = local_runner_manager.status_for_task(task_id)
            if not local_status.get("connected"):
                raise RuntimeError("本地项目未连接。请先打开 AutoCode Local Connector 并完成本地项目连接。")
            result = await local_runner_manager.execute_tool(
                task_id,
                "bash",
                {"command": command, "timeout": timeout, "command_timeout": timeout, "max_output": 20000},
                timeout=timeout + 10,
            )
            output = str(result.get("result") or "").strip()
            exit_code = int(result.get("exit_code", 0 if result.get("ok") else -1))
            ok = bool(result.get("ok")) and exit_code == 0
        else:
            result = await docker_manager.execute_in_workspace(task["workspace_id"], command, timeout=timeout)
            output = "\n".join([result.get("stdout") or "", result.get("stderr") or ""]).strip()
            exit_code = result.get("exit_code", -1)
            ok = exit_code == 0
    except Exception as exc:
        output = str(exc)
        exit_code = -1
        ok = False

    output_meta = _bound_task_output(task, output, tool_name="bash")
    preview_output = output_meta["preview"] if output_meta else (output[-12000:] if output else "")
    model_output = output_meta["model_preview"] if output_meta else (output[-4000:] if output else "")

    record.update({
        "status": "success" if ok else "failed",
        "output": preview_output,
        "output_truncated": bool((output_meta or {}).get("truncated")),
        "output_path": (output_meta or {}).get("full_path", ""),
        "output_sha256": (output_meta or {}).get("sha256", ""),
        "output_chars": (output_meta or {}).get("chars", len(output) if output else 0),
        "output_lines": (output_meta or {}).get("lines", output.count("\n") + 1 if output else 0),
        "exit_code": exit_code,
        "finished_at": _now_iso(),
    })
    finished_event = append_event(
        task,
        "command_finished",
        {
            "command": command,
            "record_id": record["id"],
            "status": record["status"],
            "exit_code": exit_code,
            "output": model_output,
            "output_truncated": bool((output_meta or {}).get("truncated")),
            "output_path": (output_meta or {}).get("full_path", ""),
            "output_sha256": (output_meta or {}).get("sha256", ""),
            "output_chars": (output_meta or {}).get("chars", len(output) if output else 0),
            "output_lines": (output_meta or {}).get("lines", output.count("\n") + 1 if output else 0),
        },
        source="terminal",
    )
    _append_task_log(
        task,
        "success" if ok else "warn",
        f"命令完成: {command}",
        agent="terminal",
        detail=model_output or "(no output)",
        tool_name="bash",
        exit_code=exit_code,
    )
    save_task(task)
    _publish_task_update(task_id, "runtime_event", finished_event)
    _publish_command_history(task_id, task)
    return record


def _command_result_chat_message(record: dict) -> str:
    command = str(record.get("command") or "").strip()
    exit_code = record.get("exit_code")
    status_text = "成功" if str(record.get("status") or "") == "success" else "失败"
    output = str(record.get("output") or "").strip()
    truncated = bool(record.get("output_truncated"))
    output_path = str(record.get("output_path") or "").strip()
    if not output:
        return f"命令 `{command}` 执行{status_text}，退出码：{exit_code}。没有输出内容。"
    preview = output[-3000:]
    suffix = ""
    if truncated or output_path:
        suffix = "\n\n输出较长，完整内容已保存到活动记录，可点击查看。"
    return f"命令 `{command}` 执行{status_text}，退出码：{exit_code}。\n\n```text\n{preview}\n```{suffix}"


def _rollback_task_to_target(task_id: str, task: dict, target: str | None) -> dict:
    from core.config import get_settings
    from core.git_manager import git_manager

    ws_id = task.get("workspace_id")
    if not ws_id:
        raise HTTPException(status_code=400, detail="Task has no workspace")
    ws_path = get_settings().workspace_base_dir / ws_id
    commits = git_manager.log(ws_path, max_count=50)
    if not commits:
        raise HTTPException(status_code=400, detail="No git commits available")

    normalized = (target or "previous").strip()
    if normalized in {"上一版", "上一次", "上一条", "上个版本"}:
        normalized = "previous"
    if normalized in {"previous", "上一版", "上一次", ""}:
        if len(commits) < 2:
            raise HTTPException(status_code=400, detail="No previous commit available")
        commit_hash = commits[1]["hash"]
    else:
        match = next((item for item in commits if str(item.get("hash", "")).startswith(normalized)), None)
        commit_hash = match["hash"] if match else normalized

    append_event(
        task,
        "rollback_started",
        {"target": normalized, "commit_hash": commit_hash},
        source="git",
        snapshot_hash=commit_hash,
    )
    commit_hash = git_manager.reset_to_commit(ws_path, commit_hash)
    task["commit_history"] = git_manager.log(ws_path, max_count=30)
    append_event(
        task,
        "rollback_finished",
        {"target": normalized, "commit_hash": commit_hash},
        source="git",
        snapshot_hash=commit_hash,
    )
    _append_task_log(task, "success", f"Rolled back to {commit_hash}", agent="git")
    save_task(task)
    return {"commit_hash": commit_hash, "target": normalized}


async def _stream_chat_action(task_id: str, task: dict, message: str, action: dict):
    try:
        _append_task_log(task, "chat_user", message, agent="user")
        append_event(task, "chat_action", {"message": message, "action": action}, source="chat_controller")
        if action["type"] in ("usage_help", "answer_usage"):
            content = _build_usage_help_message(task_id, task)
            _append_task_log(task, "chat_assistant", content, agent="assistant")
            append_event(task, "assistant_message", {"content": content}, source="assistant")
            save_task(task)
            yield _sse("message", {
                "content": content,
                "timestamp": _now_iso(),
            })
        elif action["type"] == "open_file":
            rel_path = action["path"]
            _resolve_workspace_path(task_id, rel_path)
            _append_task_log(task, "chat_assistant", f"Opened file: {rel_path}", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "open_file",
                "path": rel_path,
                "line": action.get("line"),
                "message": f" `{rel_path}`?",
                "timestamp": _now_iso(),
            })
        elif action["type"] == "continue_from_diff":
            queue = agent_orchestrator.receive_user_message(task_id, message)
            if queue is None:
                task["status"] = "pending"
                save_task(task)
                task_queue.enqueue(task_id, "continue from diff")
            _append_task_log(task, "chat_assistant", "Continuing from current Git diff", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": "working",
                "message": "?Git Diff?Agent ?",
                "timestamp": _now_iso(),
            })
        elif action["type"] == "show_git":
            _append_task_log(task, "chat_assistant", "Switched to Git changes", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": action.get("target", "working"),
                "message": " Git ?",
                "timestamp": _now_iso(),
            })
        elif action["type"] == "rollback_confirm":
            target = action.get("target", "previous")
            explicit_confirm = bool(re.search(r"(纭鍥為€€|纭鎾ら攢|confirm rollback|confirm revert)", message, flags=re.I))
            if explicit_confirm:
                result = _rollback_task_to_target(task_id, task, target)
                yield _sse("runtime_event", (task.get("events") or [])[-1], task_id)
                yield _sse("action", {
                    "type": "show_git",
                    "target": result["commit_hash"],
                    "message": f"已回退到 `{result['commit_hash']}`。",
                    "timestamp": _now_iso(),
                }, task_id)
                yield _sse("message", {
                    "content": f"已完成回退：`{result['commit_hash']}`。你可以在 Git 面板查看当前版本和 Diff。",
                    "timestamp": _now_iso(),
                }, task_id)
                yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})
                return
            _append_task_log(task, "chat_assistant", f"Rollback confirmation requested: {target}", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": target,
                "message": f"准备回退到 `{target}`。如确认执行，请输入：确认回退 {target}",
                "timestamp": _now_iso(),
            })
        elif action["type"] == "rollback":
            target = action.get("target", "previous")
            result = _rollback_task_to_target(task_id, task, target)
            yield _sse("runtime_event", (task.get("events") or [])[-1], task_id)
            yield _sse("action", {
                "type": "show_git",
                "target": result["commit_hash"],
                "message": f"已回退到 `{result['commit_hash']}`。",
                "timestamp": _now_iso(),
            })
            yield _sse("message", {
                "content": f"已完成回退：`{result['commit_hash']}`。你可以在 Git 面板查看当前版本和 Diff。",
                "timestamp": _now_iso(),
            }, task_id)
            yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})
            return
        elif action["type"] == "run_command":
            command_key = str(action.get("command") or "").strip()
            if command_key in {"test", "tests", "build", ""}:
                command = _infer_workspace_command(task_id, "test" if command_key in {"test", "tests"} else "build")
                command_label = command_key or "build"
            else:
                command = command_key
                command_label = "custom"
            try:
                workspace_root = _resolve_workspace_path(task_id, "/")
            except Exception:
                workspace_root = None
            permission = agent_loop.check_tool_permission(
                task=task,
                tool_name="run_command",
                args={"command": command, "kind": command_key},
                role="user",
                workspace_root=workspace_root,
            )
            if permission.decision == "deny":
                save_task(task)
                yield _sse("message", {
                    "content": f"Command blocked: {permission.reason}",
                    "timestamp": _now_iso(),
                }, task_id)
                return
            if permission.needs_approval:
                approval_id = f"approval-{uuid.uuid4().hex[:12]}"
                auto_approve_after = int((permission.approval_payload or {}).get("auto_approve_after_seconds") or 0)
                manual_required = bool((permission.approval_payload or {}).get("manual_required"))
                high_risk = bool((permission.approval_payload or {}).get("high_risk") or (permission.approval_payload or {}).get("destructive"))
                approval_event = append_event(
                    task,
                    "approval_requested",
                    {
                        "approval_id": approval_id,
                        "tool": "run_command",
                        "command": command,
                        "reason": permission.reason,
                        "payload": permission.approval_payload,
                        "scope": "chat_command",
                        "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                        "manual_required": manual_required,
                        "high_risk": high_risk,
                    },
                    source="permission",
                )
                save_task(task)
                yield _sse("runtime_event", approval_event, task_id)
                yield _sse("action", {
                    "type": "approval_requested",
                    "message": f"命令需要确认后执行：{command}",
                    "reason": permission.reason,
                    "event_id": approval_event.get("id"),
                    "approval_id": approval_id,
                    "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                    "manual_required": manual_required,
                    "high_risk": high_risk,
                    "timestamp": _now_iso(),
                }, task_id)
                for waited_seconds in range(600):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and conf.get("approval_id") == approval_id:
                        _confirmations.pop(task_id, None)
                        if not conf.get("approved", conf.get("confirmed")):
                            save_task(task)
                            yield _sse("message", {
                                "content": f"已拒绝执行命令：`{command}`",
                                "timestamp": _now_iso(),
                            }, task_id)
                            return
                        break
                    if auto_approve_after and not manual_required and not high_risk and waited_seconds + 1 >= auto_approve_after:
                        append_event(
                            task,
                            "approval_resolved",
                            {
                                "approval_id": approval_id,
                                "event_id": approval_event.get("id"),
                                "approved": True,
                                "auto_approved": True,
                                "reason": f"{auto_approve_after}s countdown elapsed",
                            },
                            source="permission",
                        )
                        save_task(task)
                        break
                else:
                    append_event(task, "approval_timeout", {"approval_id": approval_id, "command": command}, source="permission")
                    save_task(task)
                    yield _sse("message", {
                        "content": f"等待确认超时，未执行命令：`{command}`",
                        "timestamp": _now_iso(),
                    }, task_id)
                    return
            record = await _execute_workspace_command_record(
                task_id,
                task,
                command,
                kind=command_label,
                source="chat",
                timeout=300,
            )
            yield _sse("command", record)
            yield _sse("action", {
                "type": "show_terminal",
                "message": f"命令执行完成，退出码：{record.get('exit_code')}",
                "timestamp": _now_iso(),
            })
        elif action["type"] == "run_pipeline":
            yield _sse("action", {
                "type": "show_terminal",
                "message": "?",
                "timestamp": _now_iso(),
            })
            async for event in _execute_pipeline(task_id, task):
                if event.get("type") == "command":
                    yield _sse("command", event.get("record") or {})
                elif event.get("type") == "pipeline_done":
                    yield _sse("message", {
                        "content": f"Pipeline {event.get('status')}: {len(event.get('steps') or [])} steps",
                        "timestamp": _now_iso(),
                    })
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})
    except HTTPException as e:
        yield _sse("message", {"content": f": {e.detail}", "timestamp": _now_iso()})
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})
    except Exception as e:
        _append_task_log(task, "error", f"Chat action failed: {e}", agent="system")
        save_task(task)
        yield _sse("message", {"content": f": {str(e)}", "timestamp": _now_iso()})
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})


async def _stream_chat_answer(task_id: str, task: dict, message: str, content: str):
    _append_task_log(task, "chat_user", message, agent="user")
    _append_task_log(task, "chat_assistant", content, agent="assistant")
    append_event(task, "assistant_message", {"content": content, "reply_to": message[:500]}, source="assistant")
    save_task(task)
    yield _sse("message", {"content": content, "timestamp": _now_iso()})
    yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")})


def _detect_chat_action(message: str) -> dict | None:
    """Clean local fallback for AutoCode chat control actions."""
    text = (message or "").strip()
    if not text:
        return None

    file_match = re.search(
        r"(?:打开|查看|定位|open|show)\s*(?:文件)?\s*([A-Za-z0-9_.@()+\-/\\]+?\.(?:tsx|ts|jsx|js|mjs|cjs|vue|css|scss|html|md|json|py|java|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|txt))(?:[:#L\s]+(\d+))?",
        text,
        flags=re.I,
    )
    if file_match:
        action = {"type": "open_file", "path": file_match.group(1).replace("\\", "/").lstrip("/")}
        if file_match.group(2):
            action["line"] = int(file_match.group(2))
        return action

    if re.search(r"(娴佹按绾縷瀹屾暣楠岃瘉|绔埌绔獙璇亅鍏ㄩ噺楠岃瘉|pipeline|ci)", text, flags=re.I):
        return {"type": "run_pipeline"}

    command_match = re.search(r"(?:杩愯鍛戒护|鎵ц鍛戒护|run command|execute command)\s*[:锛歖?\s*(.+)$", text, flags=re.I)
    if command_match:
        command = command_match.group(1).strip()
        if command:
            return {"type": "run_command", "command": command}

    if re.search(r"(杩愯|鎵ц).{0,8}(娴嬭瘯|test|tests)", text, flags=re.I):
        return {"type": "run_command", "command": "test"}
    if re.search(r"(杩愯|鎵ц).{0,8}(鏋勫缓|build)", text, flags=re.I):
        return {"type": "run_command", "command": "build"}

    if re.search(r"(鏌ョ湅|鎵撳紑|鏄剧ず).{0,8}(diff|鍙樻洿|git|鎻愪氦)", text, flags=re.I):
        return {"type": "show_git", "target": "working"}

    rollback_confirm_match = re.search(r"(?:纭鍥為€€|纭鎾ら攢).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_confirm_match:
        target = rollback_confirm_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    rollback_match = re.search(r"(?:鍥為€€|鎾ら攢|rollback|revert).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆??", text, flags=re.I)
    if rollback_match:
        target = rollback_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in ("上一版", "上一次") else target}

    return None


async def _stream_chat_action(task_id: str, task: dict, message: str, action: dict):
    """Clean AutoCode chat action stream. Overrides the legacy mojibake fallback above."""
    try:
        _append_task_log(task, "chat_user", message, agent="user")
        append_event(task, "chat_action", {"message": message, "action": action}, source="chat_controller")

        if action["type"] in ("usage_help", "answer_usage"):
            content = _build_usage_help_message(task_id, task)
            _append_task_log(task, "chat_assistant", content, agent="assistant")
            append_event(task, "assistant_message", {"content": content}, source="assistant")
            save_task(task)
            yield _sse("message", {"content": content, "timestamp": _now_iso()}, task_id)

        elif action["type"] == "open_file":
            rel_path = str(action.get("path") or "").replace("\\", "/").lstrip("/")
            _resolve_workspace_path(task_id, rel_path)
            _append_task_log(task, "chat_assistant", f"Opened file: {rel_path}", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "open_file",
                "path": rel_path,
                "line": action.get("line"),
                "message": f"宸叉墦寮€ `{rel_path}`",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "continue_from_diff":
            queue = agent_orchestrator.receive_user_message(task_id, message)
            if queue is None:
                task["status"] = "pending"
                save_task(task)
                task_queue.enqueue(task_id, "continue from diff")
            _append_task_log(task, "chat_assistant", "Continuing from current Git diff", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": "working",
                "message": "已打开当前 Git Diff，Agent 将基于现有变更继续处理。",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "show_git":
            _append_task_log(task, "chat_assistant", "Switched to Git changes", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": action.get("target", "working"),
                "message": "已打开 Git 变更面板。",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] in ("rollback_confirm", "rollback"):
            target = action.get("target", "previous")
            explicit_confirm = action["type"] == "rollback" or bool(
                re.search(r"(纭鍥為€€|纭鎾ら攢|confirm rollback|confirm revert)", message, flags=re.I)
            )
            if not explicit_confirm:
                _append_task_log(task, "chat_assistant", f"Rollback confirmation requested: {target}", agent="assistant")
                save_task(task)
                yield _sse("action", {
                    "type": "show_git",
                    "target": target,
                    "message": f"准备回退到 `{target}`。如确认执行，请输入：确认回退 {target}",
                    "timestamp": _now_iso(),
                }, task_id)
            else:
                result = _rollback_task_to_target(task_id, task, target)
                yield _sse("runtime_event", (task.get("events") or [])[-1], task_id)
                yield _sse("action", {
                    "type": "show_git",
                    "target": result["commit_hash"],
                    "message": f"已回退到 `{result['commit_hash']}`。",
                    "timestamp": _now_iso(),
                }, task_id)
                yield _sse("message", {
                    "content": f"已完成回退：`{result['commit_hash']}`。你可以在 Git 面板查看当前版本和 Diff。",
                    "timestamp": _now_iso(),
                }, task_id)

        elif action["type"] == "run_command":
            command_key = str(action.get("command") or "").strip()
            if command_key in {"test", "tests", "build", ""}:
                kind = "test" if command_key in {"test", "tests"} else "build"
                command = _infer_workspace_command(task_id, kind)
            else:
                kind = "custom"
                command = command_key

            try:
                workspace_root = _resolve_workspace_path(task_id, "/")
            except Exception:
                workspace_root = None
            permission = agent_loop.check_tool_permission(
                task=task,
                tool_name="run_command",
                args={"command": command, "kind": kind},
                role="user",
                workspace_root=workspace_root,
            )
            if permission.decision == "deny":
                save_task(task)
                yield _sse("message", {
                    "content": f"命令已被安全策略拦截：{permission.reason}",
                    "timestamp": _now_iso(),
                }, task_id)
                return
            if permission.needs_approval:
                approval_id = f"approval-{uuid.uuid4().hex[:12]}"
                auto_approve_after = int((permission.approval_payload or {}).get("auto_approve_after_seconds") or 0)
                manual_required = bool((permission.approval_payload or {}).get("manual_required"))
                high_risk = bool((permission.approval_payload or {}).get("high_risk") or (permission.approval_payload or {}).get("destructive"))
                approval_event = append_event(
                    task,
                    "approval_requested",
                    {
                        "approval_id": approval_id,
                        "tool": "run_command",
                        "command": command,
                        "reason": permission.reason,
                        "payload": permission.approval_payload,
                        "scope": "chat_command",
                        "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                        "manual_required": manual_required,
                        "high_risk": high_risk,
                    },
                    source="permission",
                )
                save_task(task)
                yield _sse("runtime_event", approval_event, task_id)
                yield _sse("action", {
                    "type": "approval_requested",
                    "message": f"命令需要确认后执行：`{command}`",
                    "reason": permission.reason,
                    "event_id": approval_event.get("id"),
                    "approval_id": approval_id,
                    "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                    "manual_required": manual_required,
                    "high_risk": high_risk,
                    "timestamp": _now_iso(),
                }, task_id)
                for waited_seconds in range(600):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and conf.get("approval_id") == approval_id:
                        _confirmations.pop(task_id, None)
                        if not conf.get("approved", conf.get("confirmed")):
                            save_task(task)
                            yield _sse("message", {
                                "content": f"宸叉嫆缁濇墽琛屽懡浠わ細`{command}`",
                                "timestamp": _now_iso(),
                            }, task_id)
                            return
                        break
                    if auto_approve_after and not manual_required and not high_risk and waited_seconds + 1 >= auto_approve_after:
                        append_event(
                            task,
                            "approval_resolved",
                            {
                                "approval_id": approval_id,
                                "event_id": approval_event.get("id"),
                                "approved": True,
                                "auto_approved": True,
                                "reason": f"{auto_approve_after}s countdown elapsed",
                            },
                            source="permission",
                        )
                        save_task(task)
                        break
                else:
                    append_event(task, "approval_timeout", {"approval_id": approval_id, "command": command}, source="permission")
                    save_task(task)
                    yield _sse("message", {
                        "content": f"等待确认超时，未执行命令：`{command}`",
                        "timestamp": _now_iso(),
                    }, task_id)
                    return

            record = await _execute_workspace_command_record(task_id, task, command, kind=kind, source="chat", timeout=300)
            yield _sse("command", record, task_id)
            yield _sse("action", {
                "type": "show_terminal",
                "message": f"命令执行完成，退出码：{record.get('exit_code')}",
                "timestamp": _now_iso(),
            }, task_id)
            yield _sse("message", {
                "content": _command_result_chat_message(record),
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "run_pipeline":
            yield _sse("action", {
                "type": "show_terminal",
                "message": "正在运行项目流水线。",
                "timestamp": _now_iso(),
            }, task_id)
            async for event in _execute_pipeline(task_id, task):
                if event.get("type") == "command":
                    yield _sse("command", event.get("record") or {}, task_id)
                elif event.get("type") == "pipeline_done":
                    yield _sse("message", {
                        "content": f"流水线 {event.get('status')}：共 {len(event.get('steps') or [])} 步",
                        "timestamp": _now_iso(),
                    }, task_id)

        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)
    except HTTPException as e:
        yield _sse("message", {"content": f"操作失败：{e.detail}", "timestamp": _now_iso()}, task_id)
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)
    except Exception as e:
        _append_task_log(task, "error", f"Chat action failed: {e}", agent="system")
        save_task(task)
        yield _sse("message", {"content": f"操作失败：{str(e)}", "timestamp": _now_iso()}, task_id)
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)


def _detect_chat_action(message: str) -> dict | None:
    """UTF-8 AutoCode chat control fallback.

    This final definition intentionally overrides earlier legacy fallback blocks.
    """
    text = (message or "").strip()
    if not text:
        return None
    lower = text.lower()

    if any(marker in lower for marker in ("怎么用", "如何使用", "使用方法", "用法", "怎么运行", "如何运行", "how to use", "usage")):
        return {"type": "answer_usage"}

    if re.search(r"(鎬庝箞鐢▅濡備綍浣跨敤|浣跨敤鏂规硶|鐢ㄦ硶|鎬庝箞杩愯|濡備綍杩愯|how to use|usage)", text, flags=re.I):
        return {"type": "answer_usage"}

    file_match = re.search(
        r"(?:鎵撳紑|鏌ョ湅|瀹氫綅|open|show)\s*(?:鏂囦欢)?\s*([A-Za-z0-9_.@()+\-/\\]+?\.(?:tsx|ts|jsx|js|mjs|cjs|vue|css|scss|html|md|json|py|java|go|rs|php|rb|sh|ps1|sql|yml|yaml|toml|xml|txt))(?:[:#L\s]+(\d+))?",
        text,
        flags=re.I,
    )
    if file_match:
        action = {"type": "open_file", "path": file_match.group(1).replace("\\", "/").lstrip("/")}
        if file_match.group(2):
            action["line"] = int(file_match.group(2))
        return action

    if re.search(r"(根据|基于).{0,8}(diff|变更|改动).{0,12}(继续|修改|修复|调整)", text, flags=re.I):
        return {"type": "continue_from_diff"}

    if re.search(r"(流水线|完整验证|端到端验证|全量验证|pipeline|ci)", text, flags=re.I):
        return {"type": "run_pipeline"}

    command_match = re.search(r"(?:运行命令|执行命令|run command|execute command)\s*[:：]?\s*(.+)$", text, flags=re.I)
    if command_match:
        command = command_match.group(1).strip()
        if command:
            return {"type": "run_command", "command": command}

    if re.search(r"(运行|执行).{0,8}(测试|test|tests)", text, flags=re.I):
        return {"type": "run_command", "command": "test"}
    if re.search(r"(运行|执行).{0,8}(构建|build)", text, flags=re.I):
        return {"type": "run_command", "command": "build"}

    if re.search(r"(查看|打开|显示).{0,8}(diff|变更|改动|git|提交)", text, flags=re.I):
        return {"type": "show_git", "target": "working"}

    rollback_confirm_match = re.search(
        r"(?:纭鍥為€€|纭鎾ら攢|confirm rollback|confirm revert).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆涓婁竴鏉涓婁釜鐗堟湰)?",
        text,
        flags=re.I,
    )
    rollback_confirm_real = re.search(r"(?:确认回退|确认撤销|confirm rollback|confirm revert).{0,12}([0-9a-f]{7,40}|上一版|上一次|上一条|上个版本)?", text, flags=re.I)
    if rollback_confirm_real:
        target = rollback_confirm_real.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in {"上一版", "上一次", "上一条", "上个版本"} else target}

    if rollback_confirm_match:
        target = rollback_confirm_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in {"上一版", "上一次", "上一条", "上个版本"} else target}

    rollback_match = re.search(
        r"(?:鍥為€€|鎾ら攢|rollback|revert).{0,12}([0-9a-f]{7,40}|涓婁竴鐗坾涓婁竴娆涓婁竴鏉涓婁釜鐗堟湰)?",
        text,
        flags=re.I,
    )
    rollback_real = re.search(r"(?:回退|撤销|rollback|revert).{0,12}([0-9a-f]{7,40}|上一版|上一次|上一条|上个版本)?", text, flags=re.I)
    if rollback_real:
        target = rollback_real.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in {"上一版", "上一次", "上一条", "上个版本"} else target}

    if rollback_match:
        target = rollback_match.group(1)
        return {"type": "rollback_confirm", "target": "previous" if not target or target in {"上一版", "上一次", "上一条", "上个版本"} else target}

    return None


async def _stream_chat_action(task_id: str, task: dict, message: str, action: dict):
    """UTF-8 AutoCode chat action stream. Overrides legacy mojibake blocks."""
    try:
        _append_task_log(task, "chat_user", message, agent="user")
        append_event(task, "chat_action", {"message": message, "action": action}, source="chat_controller")

        if action["type"] in ("usage_help", "answer_usage"):
            content = _build_usage_help_message(task_id, task)
            _append_task_log(task, "chat_assistant", content, agent="assistant")
            append_event(task, "assistant_message", {"content": content}, source="assistant")
            save_task(task)
            yield _sse("message", {"content": content, "timestamp": _now_iso()}, task_id)

        elif action["type"] == "open_file":
            rel_path = str(action.get("path") or "").replace("\\", "/").lstrip("/")
            _resolve_workspace_path(task_id, rel_path)
            _append_task_log(task, "chat_assistant", f"Opened file: {rel_path}", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "open_file",
                "path": rel_path,
                "line": action.get("line"),
                "message": f"已打开 `{rel_path}`。",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "continue_from_diff":
            queue = agent_orchestrator.receive_user_message(task_id, message)
            if queue is None:
                task["status"] = "pending"
                save_task(task)
                task_queue.enqueue(task_id, "continue from diff")
            _append_task_log(task, "chat_assistant", "Continuing from current Git diff", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": "working",
                "message": "已打开当前 Git Diff，Agent 会基于现有变更继续处理。",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "show_git":
            _append_task_log(task, "chat_assistant", "Switched to Git changes", agent="assistant")
            save_task(task)
            yield _sse("action", {
                "type": "show_git",
                "target": action.get("target", "working"),
                "message": "已打开 Git 变更面板。",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] in ("rollback_confirm", "rollback"):
            target = action.get("target", "previous")
            explicit_confirm = action["type"] == "rollback" or bool(
                re.search(r"(纭鍥為€€|纭鎾ら攢|confirm rollback|confirm revert)", message, flags=re.I)
            )
            if not explicit_confirm:
                _append_task_log(task, "chat_assistant", f"Rollback confirmation requested: {target}", agent="assistant")
                save_task(task)
                yield _sse("action", {
                    "type": "show_git",
                    "target": target,
                    "message": f"准备回退到 `{target}`。如确认执行，请输入：确认回退 {target}",
                    "timestamp": _now_iso(),
                }, task_id)
            else:
                result = _rollback_task_to_target(task_id, task, target)
                yield _sse("runtime_event", (task.get("events") or [])[-1], task_id)
                yield _sse("action", {
                    "type": "show_git",
                    "target": result["commit_hash"],
                    "message": f"已回退到 `{result['commit_hash']}`。",
                    "timestamp": _now_iso(),
                }, task_id)
                yield _sse("message", {
                    "content": f"已完成回退：`{result['commit_hash']}`。你可以在 Git 面板查看当前版本和 Diff。",
                    "timestamp": _now_iso(),
                }, task_id)

        elif action["type"] == "run_command":
            command_key = str(action.get("command") or "").strip()
            if command_key in {"test", "tests", "build", ""}:
                kind = "test" if command_key in {"test", "tests"} else "build"
                command = _infer_workspace_command(task_id, kind)
            else:
                kind = "custom"
                command = command_key

            try:
                workspace_root = _resolve_workspace_path(task_id, "/")
            except Exception:
                workspace_root = None
            permission = agent_loop.check_tool_permission(
                task=task,
                tool_name="run_command",
                args={"command": command, "kind": kind},
                role="user",
                workspace_root=workspace_root,
            )
            if permission.decision == "deny":
                save_task(task)
                yield _sse("message", {
                    "content": f"命令已被安全策略拦截：{permission.reason}",
                    "timestamp": _now_iso(),
                }, task_id)
                return
            if permission.needs_approval:
                approval_id = f"approval-{uuid.uuid4().hex[:12]}"
                auto_approve_after = int((permission.approval_payload or {}).get("auto_approve_after_seconds") or 0)
                manual_required = bool((permission.approval_payload or {}).get("manual_required"))
                high_risk = bool((permission.approval_payload or {}).get("high_risk") or (permission.approval_payload or {}).get("destructive"))
                approval_event = append_event(
                    task,
                    "approval_requested",
                    {
                        "approval_id": approval_id,
                        "tool": "run_command",
                        "command": command,
                        "reason": permission.reason,
                        "payload": permission.approval_payload,
                        "scope": "chat_command",
                        "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                        "manual_required": manual_required,
                        "high_risk": high_risk,
                    },
                    source="permission",
                )
                save_task(task)
                yield _sse("runtime_event", approval_event, task_id)
                yield _sse("action", {
                    "type": "approval_requested",
                    "message": f"命令需要确认后执行：`{command}`",
                    "reason": permission.reason,
                    "event_id": approval_event.get("id"),
                    "approval_id": approval_id,
                    "auto_approve_after_seconds": 0 if manual_required or high_risk else auto_approve_after,
                    "manual_required": manual_required,
                    "high_risk": high_risk,
                    "timestamp": _now_iso(),
                }, task_id)
                for waited_seconds in range(600):
                    await asyncio.sleep(1)
                    conf = _confirmations.get(task_id)
                    if conf and conf.get("approval_id") == approval_id:
                        _confirmations.pop(task_id, None)
                        if not conf.get("approved", conf.get("confirmed")):
                            save_task(task)
                            yield _sse("message", {
                                "content": f"宸叉嫆缁濇墽琛屽懡浠わ細`{command}`",
                                "timestamp": _now_iso(),
                            }, task_id)
                            return
                        break
                    if auto_approve_after and not manual_required and not high_risk and waited_seconds + 1 >= auto_approve_after:
                        append_event(
                            task,
                            "approval_resolved",
                            {
                                "approval_id": approval_id,
                                "event_id": approval_event.get("id"),
                                "approved": True,
                                "auto_approved": True,
                                "reason": f"{auto_approve_after}s countdown elapsed",
                            },
                            source="permission",
                        )
                        save_task(task)
                        break
                else:
                    append_event(task, "approval_timeout", {"approval_id": approval_id, "command": command}, source="permission")
                    save_task(task)
                    yield _sse("message", {
                        "content": f"等待确认超时，未执行命令：`{command}`",
                        "timestamp": _now_iso(),
                    }, task_id)
                    return

            record = await _execute_workspace_command_record(task_id, task, command, kind=kind, source="chat", timeout=300)
            yield _sse("command", record, task_id)
            yield _sse("action", {
                "type": "show_terminal",
                "message": f"命令执行完成，退出码：{record.get('exit_code')}",
                "timestamp": _now_iso(),
            }, task_id)

        elif action["type"] == "run_pipeline":
            yield _sse("action", {
                "type": "show_terminal",
                "message": "正在运行项目流水线。",
                "timestamp": _now_iso(),
            }, task_id)
            async for event in _execute_pipeline(task_id, task):
                if event.get("type") == "command":
                    yield _sse("command", event.get("record") or {}, task_id)
                elif event.get("type") == "pipeline_done":
                    yield _sse("message", {
                        "content": f"流水线 {event.get('status')}，共 {len(event.get('steps') or [])} 步。",
                        "timestamp": _now_iso(),
                    }, task_id)

        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)
    except HTTPException as e:
        yield _sse("message", {"content": f"操作失败：{e.detail}", "timestamp": _now_iso()}, task_id)
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)
    except Exception as e:
        _append_task_log(task, "error", f"Chat action failed: {e}", agent="system")
        save_task(task)
        yield _sse("message", {"content": f"操作失败：{str(e)}", "timestamp": _now_iso()}, task_id)
        yield _sse("done", {"status": task.get("status", "unknown"), "preview_url": task.get("preview_url")}, task_id)


def _runtime_fields(task: dict) -> dict:
    task_id = task.get("id")
    status = task.get("status", "pending")
    active = bool(task.get("execution_active")) and bool(agent_orchestrator._active_tasks.get(task_id, False))
    if status in TERMINAL_TASK_STATUSES:
        return {
            "runtime_status": status,
            "is_running": False,
            "can_retry": status in {"failed", "cancelled"},
            "can_stop": False,
            "execution_active": False,
            "runtime_state": status,
            "runtime_note": "",
        }
    return {
        "runtime_status": "running" if active else status,
        "is_running": active or status in {"running", "pending", "reviewing"},
        "can_retry": status in {"failed", "cancelled"},
        "can_stop": active or status in {"running", "pending", "reviewing"},
        "execution_active": active,
        "runtime_state": "running" if active else status,
        "runtime_note": task.get("current_step", ""),
    }

def _task_response_payload(task: dict) -> dict:
    payload = dict(task)
    if payload.get("status") in TERMINAL_TASK_STATUSES or payload.get("status") == "stopped":
        payload.pop("pending_confirmation", None)
    payload.update(_runtime_fields(task))
    payload.setdefault("command_history", task.get("command_history", []))
    payload.setdefault("pipeline_runs", task.get("pipeline_runs", []))
    payload.setdefault("events", task.get("events", []))
    payload.setdefault("pipeline_status", task.get("pipeline_status"))
    payload.setdefault("preview_status", task.get("preview_status"))
    payload.setdefault("preview_error", task.get("preview_error"))
    payload.setdefault("queued_at", task.get("queued_at"))
    payload["tool_policy"] = _normalize_tool_policy(task.get("tool_policy"))
    payload["local_execution_enabled"] = bool(task.get("local_execution_enabled"))
    payload["local_runner"] = local_runner_manager.status_for_task_or_session(
        str(task.get("id") or ""),
        str(task.get("local_runner_session_id") or ""),
    )
    return payload


def _task_list_payload(task: dict) -> dict:
    """Return a lightweight task payload for the task list page."""
    payload = _task_response_payload(task)
    logs = payload.get("logs") or []
    payload["logs"] = logs[-8:] if isinstance(logs, list) else []
    payload["commit_history"] = []
    payload["events"] = (payload.get("events") or [])[-3:]
    payload["command_history"] = (payload.get("command_history") or [])[-8:]
    payload["pipeline_runs"] = (payload.get("pipeline_runs") or [])[-3:]
    payload["phase_reviews"] = (payload.get("phase_reviews") or [])[-2:]
    review = payload.get("review")
    if isinstance(review, dict):
        payload["review"] = {
            "passed": review.get("passed"),
            "score": review.get("score"),
            "summary": review.get("summary") or review.get("message") or "",
            "issues": (review.get("issues") or [])[:5],
        }
    plan = payload.get("plan")
    if isinstance(plan, dict):
        payload["plan"] = {
            "overall_approach": plan.get("overall_approach", ""),
            "architecture": plan.get("architecture", ""),
            "tech_stack": plan.get("tech_stack") or {},
            "subtasks": plan.get("subtasks") or [],
            "execution_groups": plan.get("execution_groups") or [],
        }
    return payload


def _ensure_task_queue_running() -> None:
    try:
        settings = get_settings()
        restarted = task_queue.ensure_started(worker_count=max(1, min(settings.max_concurrent_tasks, 3)))
        if restarted:
            runnable = [
                task for task in _tasks.values()
                if task.get("status") in {"pending", "running", "reviewing"}
            ]
            task_queue.requeue_many(runnable, "闃熷垪鑷剤鎭㈠")
    except RuntimeError:
        # No running event loop; queue will be started during app lifespan.
        return

def restore_tasks():
    """Restore historical tasks from DB into memory on service startup."

    Waiting states remain waiting for explicit user confirmation. Runnable
    states are moved back to pending and requeued so a backend restart does not
    silently kill long AutoCode jobs.
    """
    init_table()
    historical = load_all_tasks()
    recoverable: list[dict] = []
    for t in historical:
        should_recover_cancelled = (
            t.get("status") == "cancelled"
            and not t.get("cancel_requested")
            and (
                bool(t.get("execution_active"))
                or bool(t.get("current_subtask_id"))
                or bool(t.get("phase_reviews"))
            )
        )
        if t.get("status") in ("running", "pending", "reviewing") or should_recover_cancelled:
            previous_step = t.get("current_step") or ""
            t["status"] = "pending"
            t["execution_active"] = False
            t["current_step"] = "..."
            t.setdefault("logs", []).append({
                "timestamp": _now_iso(),
                "agent": "queue",
                "level": "warn",
                "message": "Backend restarted; task was requeued for recovery.",
                "detail": previous_step,
            })
            try:
                save_task(dict(t))
            except Exception:
                pass
            recoverable.append(t)
        else:
            t["execution_active"] = False
        _tasks[t["id"]] = t
    queued_count = task_queue.requeue_many(recoverable, "")
    if queued_count > 0:
        from loguru import logger
        logger.warning(f"[AutoCode] Requeued {queued_count} interrupted task(s) on startup")
    return len(historical)

@router.post("", response_model=TaskResponse, status_code=201)
async def create_task(payload: TaskCreate, request: Request):
    """ Agent """
    from loguru import logger

    task_id = f"task-{uuid.uuid4().hex[:12]}"
    user_id = _get_user_id(request) or payload.user_id

    task = {
        "id": task_id,
        "title": payload.title,
        "description": payload.description,
        "project_type": payload.project_type,
        "status": "pending",
        "created_at": datetime.utcnow().isoformat(),
        "workspace_id": f"ws-{uuid.uuid4().hex[:12]}",
        "user_id": str(user_id) if user_id else None,
        "request_ip": _get_request_ip(request),
        "agents": payload.agent_types or ["frontend"],
        "logs": [],
        "commit_history": [],
        "preview_url": None,
        "plan": None,
        "current_subtask_id": None,
        "enable_smart_planning": payload.enable_smart_planning,
        "model": payload.model,
        "tool_policy": _normalize_tool_policy(getattr(payload, "tool_policy", None)),
        "spec": payload.spec,
        "plan_confirmed": None,       # 
        "prototype": None,            # Excalidraw JSON 
        "prototype_confirmed": None,  # 
        "review": None,               # 
        "phase_reviews": [],
        "review_confirmed": None,     # 
        "events": [],
    }
    append_event(
        task,
        "task_created",
        {
            "title": payload.title,
            "project_type": payload.project_type,
            "agents": payload.agent_types or ["frontend"],
            "model": payload.model,
            "tool_policy": _normalize_tool_policy(getattr(payload, "tool_policy", None)),
        },
        source="api",
    )
    task["harness_trace_id"] = await asyncio.to_thread(
        harness_repository.start_trace,
        user_id=user_id,
        task_id=task_id,
        model=payload.model,
        input_summary=payload.description,
        request={
            "title": payload.title,
            "project_type": payload.project_type,
            "agents": payload.agent_types or ["frontend"],
            "smart_planning": payload.enable_smart_planning,
        },
        context={"workspace_id": task["workspace_id"]},
    )
    _tasks[task_id] = task
    #  DB?asyncio ?
    try:
        await asyncio.to_thread(save_task, task)
    except Exception:
        pass  # DB ?

    # ?asyncio.create_task  BackgroundTasks
    async def _safe_execute():
        usage_token = _usage_context.set(UsageContext(
            user_id=str(task.get("user_id")) if task.get("user_id") else None,
            task_id=task_id,
            scene_type="autocode",
            agent_id="planner",
            request_ip=task.get("request_ip"),
        ))
        try:
            #  SPEC.md ?
            if payload.spec:
                try:
                    from core.config import get_settings
                    workspace_path = get_settings().workspace_base_dir / task["workspace_id"]
                    workspace_path.mkdir(parents=True, exist_ok=True)
                    spec_path = workspace_path / "SPEC.md"
                    spec_path.write_text(payload.spec, encoding="utf-8")
                    logger.info(f"[Task {task_id}] SPEC.md ? {spec_path}")
                except Exception as spec_err:
                    logger.warning(f"[Task {task_id}]  SPEC.md : {spec_err}")

            #  LLM ?
            try:
                from core.config import get_settings
                workspace_path = get_settings().workspace_base_dir / task["workspace_id"]
                workspace_path.mkdir(parents=True, exist_ok=True)
                recon = await asyncio.to_thread(
                    run_project_recon,
                    workspace_path,
                    declared_type=payload.project_type,
                    description=payload.description,
                )
                _tasks[task_id]["project_recon"] = recon
                _tasks[task_id]["complexity"] = recon.get("complexity")
                _tasks[task_id]["recommended_flow"] = recon.get("recommended_flow")
                _tasks[task_id]["prototype_required"] = bool(recon.get("should_generate_prototype"))
                _tasks[task_id]["logs"].append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "agent": "recon",
                    "level": "info",
                    "message": (
                        f"项目侦察: {recon.get('project_kind')} / "
                        f"{recon.get('complexity')} / {recon.get('recommended_flow')}"
                    ),
                    "detail": json.dumps(recon, ensure_ascii=False),
                })
                save_task(dict(_tasks[task_id]))
            except Exception as recon_err:
                logger.warning(f"[Task {task_id}] : {recon_err}")

            try:
                _ = await agent_orchestrator._ensure_client(requested_model=payload.model)
                logger.info(f"[Task {task_id}] LLM : {agent_orchestrator._model}")
            except RuntimeError as e:
                logger.error(f"[Task {task_id}] LLM : {e}")
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["progress"] = 0
                _tasks[task_id]["current_step"] = ""
                _tasks[task_id]["logs"].append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "agent": "system",
                    "level": "error",
                    "message": str(e),
                })
                save_task(_tasks[task_id])
                return

            #   
            if payload.enable_smart_planning and payload.description:
                try:
                    from core.task_planner import plan_task

                    logger.info(f"[Task {task_id}] ?..")
                    _tasks[task_id]["current_step"] = "..."
                    _tasks[task_id]["progress"] = 2

                    recon_for_plan = _tasks[task_id].get("project_recon") or {}
                    recon_summary = ""
                    if recon_for_plan:
                        recon_summary = (
                            "\n\n项目侦察结果：\n"
                            f"- 项目类型: {recon_for_plan.get('project_kind')}\n"
                            f"- 复杂度: {recon_for_plan.get('complexity')}\n"
                            f"- 推荐流程: {recon_for_plan.get('recommended_flow')}\n"
                            f"- 技术栈: {', '.join(recon_for_plan.get('likely_stack') or [])}\n"
                            f"- 入口文件: {', '.join((recon_for_plan.get('entrypoints') or [])[:10])}\n"
                            f"- 可用命令: {json.dumps(recon_for_plan.get('commands') or {}, ensure_ascii=False)}\n"
                            f"- 规划建议: {'; '.join(recon_for_plan.get('plan_guidance') or [])}\n"
                        )

                    plan_result = await plan_task(
                        description=payload.description + recon_summary,
                        project_type=payload.project_type,
                        agent_types=payload.agent_types or ["frontend"],
                        llm_client=await agent_orchestrator._ensure_client(requested_model=payload.model),
                        model=payload.model or agent_orchestrator._model or "default",
                        project_recon=recon_for_plan,
                    )

                    agentic_mode = _execution_mode(_tasks[task_id]) != "planned"

                    # ?dict 
                    _tasks[task_id]["plan"] = plan_result.model_dump()
                    _tasks[task_id]["progress"] = 5
                    if agentic_mode:
                        _tasks[task_id]["current_step"] = f"Agentic Loop plan hint ready: {len(plan_result.subtasks)} subtasks"
                        _tasks[task_id]["plan_confirmed"] = True
                        _tasks[task_id]["status"] = "running"
                        _tasks[task_id]["execution_mode"] = "agentic"
                        append_event(_tasks[task_id], "agentic_plan_hint_ready", {
                            "subtask_count": len(plan_result.subtasks),
                            "mode": "agentic",
                            "message": "计划已作为上下文提示生成，不阻塞 Agentic Loop 执行。",
                        }, source="planner")
                    else:
                        _tasks[task_id]["current_step"] = f": {len(plan_result.subtasks)} ?.."
                        _tasks[task_id]["plan_confirmed"] = None  # 
                        _tasks[task_id]["status"] = "waiting_plan_confirm"  # ?
                    save_task(dict(_tasks[task_id]))  # 

                    logger.info(
                        f"[Task {task_id}] ? "
                        f"{len(plan_result.subtasks)} "
                    )

                    if not agentic_mode:
                        #  ?plan_confirmed 
                        max_wait_seconds = 3600  # ?1 
                        wait_interval = 2  # ?2 ?
                        waited = 0
                        while waited < max_wait_seconds:
                            await asyncio.sleep(wait_interval)
                            waited += wait_interval

                            # 
                            t_check = _tasks.get(task_id)
                            if not t_check or t_check.get("status") == "cancelled":
                                logger.info(f"[Task {task_id}] ?")
                                return

                            # /
                            confirmed = t_check.get("plan_confirmed")
                            if confirmed is not None:
                                if not confirmed:
                                    # 
                                    logger.info(f"[Task {task_id}] ?")
                                    return
                                # 
                                logger.info(f"[Task {task_id}] ?")
                                break
                        else:
                            # 
                            logger.warning(f"[Task {task_id}] ?")
                            _tasks[task_id]["status"] = "cancelled"
                            _tasks[task_id]["current_step"] = "?"
                            save_task(_tasks[task_id])
                            return

                except Exception as plan_err:
                    logger.warning(f"[Task {task_id}] ? {plan_err}")
                    _tasks[task_id]["logs"].append({
                        "timestamp": datetime.utcnow().isoformat(),
                        "agent": "planner",
                        "level": "warn",
                        "message": f"? {plan_err}",
                    })

            await agent_orchestrator.execute_task(
                task_id,
                payload.description,
                payload.project_type,
                task["workspace_id"],
                payload.agent_types or ["frontend"],
            )
            #  DB
            if task_id in _tasks:
                save_task(_tasks[task_id])
        except Exception as e:
            logger.error(f"[Task {task_id}] : {e}")
            if task_id in _tasks:
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["logs"].append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "agent": "system",
                    "level": "error",
                    "message": f": {e}",
                    "detail": str(e),
                })
                save_task(_tasks[task_id])
        finally:
            _usage_context.reset(usage_token)

    task_queue.enqueue(task_id, "created")

    return TaskResponse(**_task_response_payload(task))

#  GET /api/tasks ?
@router.get("", response_model=list[TaskResponse])
async def list_tasks(request: Request):
    """
    ?X-User-Id ?
    commit_history MB?
    ?logs ?50 ?
     logs ?5  SSE ?
    """
    _ensure_task_queue_running()
    user_id = _get_user_id(request)
    result = []
    for t in _tasks.values():
        # ?userId ?
        if not user_id:
            continue  # ?
        if t.get("user_id") and str(t["user_id"]) != str(user_id):
            continue  # ?
        if not t.get("user_id"):
            continue  #  user_id X-User-Id ?
        t_copy = dict(t)
        logs = t_copy.get("logs", [])
        status = t_copy.get("status", "pending")
        if status in ("completed", "failed", "cancelled"):
            # ?50 
            t_copy["logs"] = logs[-50:] if len(logs) > 50 else logs
        else:
            # ?SSE ?
            t_copy["logs"] = logs[-5:] if len(logs) > 5 else logs
        t_copy["commit_history"] = []  # commit_history ?
        # plan  SubTask  dict
        if t_copy.get("plan") and hasattr(t_copy["plan"], 'model_dump'):
            t_copy["plan"] = t_copy["plan"].model_dump()
        result.append(TaskResponse(**_task_list_payload(t_copy)))
    return result

#  GET /api/tasks/models ? 
@router.get("/queue/status")
async def get_task_queue_status(request: Request):
    _ensure_task_queue_running()
    user_id = _get_user_id(request)
    tasks = list(_tasks.values())
    if user_id:
        tasks = [t for t in tasks if not t.get("user_id") or str(t.get("user_id")) == str(user_id)]
    runnable = [t for t in tasks if t.get("status") in ("pending", "running", "reviewing")]
    waiting = [t for t in tasks if t.get("status") in WAITING_TASK_STATUSES]
    snapshot = task_queue.snapshot()
    active_task_ids = sorted(
        task_id for task_id, active in getattr(agent_orchestrator, "_active_tasks", {}).items()
        if active and any(str(t.get("id")) == str(task_id) for t in tasks)
    )
    recent_tasks = sorted(
        tasks,
        key=lambda item: str(item.get("updated_at") or item.get("created_at") or item.get("queued_at") or ""),
        reverse=True,
    )[:20]
    return {
        "total": len(tasks),
        "runnable": len(runnable),
        "waiting": len(waiting),
        "workers": snapshot.get("workers", 0),
        "queue_size": snapshot.get("queue_size", 0),
        "queued_count": snapshot.get("queued_count", 0),
        "queued_task_ids": [
            task_id for task_id in (snapshot.get("queued_task_ids") or [])
            if any(str(t.get("id")) == str(task_id) for t in tasks)
        ],
        "active_task_ids": active_task_ids,
        "tasks": [
            {
                "id": item.get("id"),
                "title": item.get("title"),
                "status": item.get("status"),
                "current_step": item.get("current_step"),
                "progress": item.get("progress"),
                "queued_at": item.get("queued_at"),
                "execution_active": item.get("execution_active"),
                "runtime": _runtime_fields(item),
            }
            for item in recent_tasks
        ],
    }

@router.get("/tools")
async def list_autocode_tools(request: Request):
    """Return the unified AutoCode tool registry for UI labels and policy display."""
    return {"tools": tool_registry.public_specs()}


@router.get("/models")
async def list_models(capability: str = "tool"):
    """
    ?

    - capability='tool' ? function calling ?
    """
    from services.channel_service import fetch_all_channels, fetch_models_with_capability

    channels = fetch_all_channels()
    models = fetch_models_with_capability(capability)

    result = []
    for mi in models:
        # 
        ch_info = None
        for ch in channels:
            if not ch.models:
                continue
            if mi.model_id in ch.models or mi.name in ch.models:
                ch_info = ch
                break

        result.append({
            "model_id": mi.model_id,
            "name": mi.name or mi.model_id,
            "provider": mi.provider or (ch_info.provider if ch_info else "unknown"),
            "capabilities": mi.capabilities,
            "input_price": mi.input_price,
            "output_price": mi.output_price,
            "context_length": mi.context_length,
            "code_quality": mi.code_quality,
        })

    return result

#  GET /api/tasks/{task_id} ??
@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(task_id: str, request: Request):
    """?"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)
    return TaskResponse(**_task_response_payload(t))


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(task_id: str, payload: TaskUpdateRequest, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)

    changed: dict[str, object] = {}
    if payload.title is not None:
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="Task title cannot be empty")
        if title != t.get("title"):
            t["title"] = title
            changed["title"] = title
    if payload.description is not None and payload.description != t.get("description"):
        t["description"] = payload.description
        changed["description"] = payload.description

    if changed:
        append_event(
            t,
            "task_metadata_updated",
            {"changed": changed, "request_ip": _get_request_ip(request)},
            source="api",
        )
        _append_task_log(t, "info", "任务信息已更新", agent="system", **changed)
        await asyncio.to_thread(save_task, dict(t))
        _publish_task_update(task_id, "task_updated", _task_list_payload(t))

    return TaskResponse(**_task_response_payload(t))


@router.post("/{task_id}/smart-planning", response_model=TaskResponse)
async def enable_task_smart_planning(task_id: str, request: Request):
    """Generate a smart plan for an existing task without restarting completed work."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)

    body: dict[str, object] = {}
    try:
        body = await request.json()
        if not isinstance(body, dict):
            body = {}
    except Exception:
        body = {}

    objective = str(body.get("objective") or body.get("description") or "").strip()
    context = str(body.get("context") or "").strip()
    description = (objective or t.get("description") or t.get("title") or "").strip()
    if not description:
        raise HTTPException(status_code=400, detail="Task description is empty")

    try:
        from core.task_planner import plan_task

        recon_for_plan = t.get("project_recon") or {}
        recon_summary = ""
        if recon_for_plan:
            recon_summary = (
                "\n\n项目侦察结果：\n"
                f"- 项目类型: {recon_for_plan.get('project_kind')}\n"
                f"- 复杂度: {recon_for_plan.get('complexity')}\n"
                f"- 推荐流程: {recon_for_plan.get('recommended_flow')}\n"
                f"- 技术栈: {', '.join(recon_for_plan.get('likely_stack') or [])}\n"
                f"- 入口文件: {', '.join((recon_for_plan.get('entrypoints') or [])[:10])}\n"
                f"- 可用命令: {json.dumps(recon_for_plan.get('commands') or {}, ensure_ascii=False)}\n"
                f"- 规划建议: {'; '.join(recon_for_plan.get('plan_guidance') or [])}\n"
            )

        t["enable_smart_planning"] = True
        if objective:
            t["planning_objective"] = objective
        if context:
            t["planning_context"] = context
        t["current_step"] = "正在生成智能计划..."
        _append_task_log(
            t,
            "info",
            "正在为已创建任务生成智能计划",
            agent="planner",
            objective=objective,
        )
        save_task(dict(t))

        plan_description = description
        if context:
            plan_description += f"\n\n用户补充上下文：\n{context}"

        plan_result = await plan_task(
            description=plan_description + recon_summary,
            project_type=t.get("project_type") or "nextjs",
            agent_types=t.get("agents") or ["frontend"],
            llm_client=await agent_orchestrator._ensure_client(requested_model=t.get("model")),
            model=t.get("model") or agent_orchestrator._model or "default",
            project_recon=recon_for_plan,
        )

        t["plan"] = plan_result.model_dump()
        t["plan_confirmed"] = True
        t["execution_mode"] = t.get("execution_mode") or "agentic"
        t["current_step"] = f"智能计划已生成：{len(plan_result.subtasks)} 个子任务"
        append_event(t, "agentic_plan_hint_ready", {
            "subtask_count": len(plan_result.subtasks),
            "mode": t.get("execution_mode"),
            "objective": objective,
            "message": "已为现有任务生成智能计划，可在计划视图查看。",
        }, source="planner")
        _append_task_log(t, "success", f"智能计划已生成：{len(plan_result.subtasks)} 个子任务", agent="planner")
        await asyncio.to_thread(save_task, dict(t))
        _publish_task_update(task_id, "task_updated", _task_response_payload(t))
        return TaskResponse(**_task_response_payload(t))
    except HTTPException:
        raise
    except Exception as exc:
        _append_task_log(t, "error", f"智能计划生成失败：{exc}", agent="planner", detail=str(exc))
        await asyncio.to_thread(save_task, dict(t))
        raise HTTPException(status_code=500, detail=f"智能计划生成失败：{exc}") from exc


@router.patch("/{task_id}/tool-policy", response_model=TaskResponse)
async def update_task_tool_policy(task_id: str, payload: ToolPolicyUpdateRequest, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)
    policy = _normalize_tool_policy(payload.tool_policy)
    old_policy = _normalize_tool_policy(t.get("tool_policy"))
    t["tool_policy"] = policy
    append_event(
        t,
        "tool_policy_updated",
        {
            "old_policy": old_policy,
            "tool_policy": policy,
            "request_ip": _get_request_ip(request),
        },
        source="api",
    )
    _append_task_log(
        t,
        "info",
        f"宸ュ叿鏉冮檺绛栫暐宸插垏鎹负 {policy}",
        agent="system",
        tool_policy=policy,
    )
    await asyncio.to_thread(save_task, dict(t))
    return TaskResponse(**_task_response_payload(t))

#  DELETE /api/tasks/{task_id} ? 
@router.delete("/{task_id}")
async def remove_task(task_id: str, request: Request):
    """?"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)
    del _tasks[task_id]
    repo_delete_task(task_id)
    return {"ok": True}

#  GET /api/tasks/{task_id}/status ?
@router.get("/{task_id}/status", response_model=TaskStatusResponse)
async def get_task_status(task_id: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    t = _tasks[task_id]
    _verify_task_ownership(t, request)
    runtime = _runtime_fields(t)
    return TaskStatusResponse(
        task_id=task_id,
        status=t.get("status", "pending"),
        progress=t.get("progress", 0),
        current_step=t.get("current_step", ""),
        preview_url=t.get("preview_url"),
        workspace_id=t.get("workspace_id"),
        model=t.get("model"),
        tool_policy=_normalize_tool_policy(t.get("tool_policy")),
        pending_confirmation=t.get("pending_confirmation"),
        plan=t.get("plan"),
        review=t.get("review"),
        phase_reviews=t.get("phase_reviews", []),
        prototype=t.get("prototype"),
        plan_confirmed=t.get("plan_confirmed"),
        prototype_confirmed=t.get("prototype_confirmed"),
        review_confirmed=t.get("review_confirmed"),
        queued_at=t.get("queued_at"),
        command_history=t.get("command_history", []),
        pipeline_runs=t.get("pipeline_runs", []),
        project_recon=t.get("project_recon"),
        complexity=t.get("complexity"),
        recommended_flow=t.get("recommended_flow"),
        prototype_required=t.get("prototype_required"),
        pipeline_status=t.get("pipeline_status"),
        preview_status=t.get("preview_status"),
        preview_error=t.get("preview_error"),
        **{k: v for k, v in runtime.items() if k in {"execution_active", "runtime_state", "runtime_note"}},
    )

#  GET /api/tasks/{task_id}/stream ?SSE ?
@router.get("/{task_id}/stream")
async def stream_task_events(task_id: str, request: Request, user_id: Optional[str] = Query(default=None, alias="userId")):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    if not user_id:
        user_id = _get_user_id(request)
    _verify_task_ownership(_tasks[task_id], request, user_id)

    async def event_generator():
        published_logs = 0
        last_status = ""
        last_progress = -1
        last_subtask_id = None
        last_plan_hash = ""
        last_command_hash = ""
        published_event_ids = set()

        while True:
            await asyncio.sleep(1.5)

            t = _tasks.get(task_id)
            if not t:
                yield "event: error\ndata: Task not found\n\n"
                break

            #  ?
            status = t.get("status", "pending")
            progress = t.get("progress", 0)
            current_step = t.get("current_step", "")
            preview_url = t.get("preview_url")

            if status != last_status or progress != last_progress:
                runtime = _runtime_fields(t)
                payload = {
                    "status": status,
                    "progress": progress,
                    "current_step": current_step,
                    "preview_url": preview_url,
                    "workspace_id": t.get("workspace_id"),
                    "model": t.get("model"),
                    "plan": t.get("plan"),
                    "current_subtask_id": t.get("current_subtask_id"),
                    "review": t.get("review"),
                    "phase_reviews": t.get("phase_reviews", []),
                    "prototype": t.get("prototype"),      # Excalidraw JSON
                    "plan_confirmed": t.get("plan_confirmed"),
                    "prototype_confirmed": t.get("prototype_confirmed"),
                    "review_confirmed": t.get("review_confirmed"),
                    "execution_active": runtime.get("execution_active"),
                    "runtime_state": runtime.get("runtime_state"),
                    "runtime_note": runtime.get("runtime_note"),
                    "project_recon": t.get("project_recon"),
                    "complexity": t.get("complexity"),
                    "recommended_flow": t.get("recommended_flow"),
                    "prototype_required": t.get("prototype_required"),
                }
                yield f"event: status\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last_status = status
                last_progress = progress

            #  ?
            current_subtask_id = t.get("current_subtask_id")
            if current_subtask_id != last_subtask_id:
                plan_obj = t.get("plan")
                if plan_obj and plan_obj.get("subtasks"):
                    for st in plan_obj["subtasks"]:
                        if st["id"] == current_subtask_id:
                            yield f"event: subtask\ndata: {json.dumps(st, ensure_ascii=False)}\n\n"
                            break
                last_subtask_id = current_subtask_id

            #  ?plan  status/progress 
            plan_data = t.get("plan")
            plan_hash = hashlib.md5(
                json.dumps(plan_data, sort_keys=True, default=str).encode()
            ).hexdigest() if plan_data else ""
            if plan_hash != last_plan_hash:
                if last_plan_hash:
                    runtime = _runtime_fields(t)
                    payload = {
                        "status": t.get("status", ""),
                        "progress": t.get("progress", 0),
                        "current_step": t.get("current_step", ""),
                        "preview_url": t.get("preview_url"),
                        "workspace_id": t.get("workspace_id"),
                        "model": t.get("model"),
                        "plan": plan_data,
                        "current_subtask_id": t.get("current_subtask_id"),
                        "phase_reviews": t.get("phase_reviews", []),
                        "execution_active": runtime.get("execution_active"),
                        "runtime_state": runtime.get("runtime_state"),
                        "runtime_note": runtime.get("runtime_note"),
                        "project_recon": t.get("project_recon"),
                        "complexity": t.get("complexity"),
                        "recommended_flow": t.get("recommended_flow"),
                        "prototype_required": t.get("prototype_required"),
                    }
                    yield f"event: status\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
                last_plan_hash = plan_hash

            #  ?
            logs = t.get("logs", [])
            if len(logs) > published_logs:
                new_logs = logs[published_logs:]
                for lg in new_logs:
                    yield f"event: log\ndata: {json.dumps(lg, ensure_ascii=False)}\n\n"
                published_logs = len(logs)

            runtime_events = t.get("events", [])
            if runtime_events:
                for event in runtime_events:
                    event_id = event.get("id")
                    if event_id in published_event_ids:
                        continue
                    yield f"event: runtime_event\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
                    if event_id:
                        published_event_ids.add(event_id)
                if len(published_event_ids) > 1200:
                    published_event_ids = set(list(published_event_ids)[-1000:])

            command_history = t.get("command_history", [])[-100:]
            command_hash = hashlib.md5(
                json.dumps(command_history, sort_keys=True, default=str).encode()
            ).hexdigest() if command_history else ""
            if command_hash != last_command_hash:
                if command_history:
                    yield f"event: command_history\ndata: {json.dumps({'commands': command_history}, ensure_ascii=False)}\n\n"
                last_command_hash = command_hash

            #  eviewing / waiting_*_confirm 
            if status in ("completed", "failed", "cancelled"):
                yield f"event: done\ndata: {json.dumps({'status': status, 'preview_url': preview_url}, ensure_ascii=False)}\n\n"
                break

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

#  GET /api/tasks/{task_id}/logs ? 
@router.get("/{task_id}/logs")
async def get_task_logs(task_id: str, request: Request, since: int = 0):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    logs = _tasks[task_id]["logs"]
    return {"logs": logs[since:], "total": len(logs)}


@router.get("/{task_id}/events")
async def get_task_events(
    task_id: str,
    request: Request,
    after: Optional[str] = Query(default=None),
    limit: int = Query(default=200, ge=1, le=1000),
):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    return {"events": events_since(_tasks[task_id], after, limit), "total": len(_tasks[task_id].get("events") or [])}


class ApprovalResolvePayload(BaseModel):
    approved: bool = Field(..., description="true=approve, false=reject")
    note: Optional[str] = Field(default=None, description="Optional user note")


def _ensure_waiting_confirm_approval_event(task: dict, event_id: str) -> dict | None:
    if task.get("status") != "waiting_confirm":
        return None
    pending = task.get("pending_confirmation") if isinstance(task.get("pending_confirmation"), dict) else {}
    approval_id = str(pending.get("approval_id") or event_id or f"continue-{task.get('id')}")
    message = str(
        pending.get("reason")
        or task.get("current_step")
        or "任务正在等待人工确认，确认后将继续执行。"
    )
    payload = pending.get("payload") if isinstance(pending.get("payload"), dict) else {}
    if not payload:
        payload = {"kind": pending.get("kind") or "manual_continue"}
    approval_event = append_event(
        task,
        "approval_requested",
        {
            "approval_id": approval_id,
            "tool": pending.get("action") or "continue_task",
            "action": pending.get("action") or "continue_task",
            "reason": message,
            "message": message,
            "payload": payload,
            "manual_required": True,
            "high_risk": bool(pending.get("high_risk", False)),
            "auto_approve_after_seconds": 0,
        },
        source="queue",
        publish=publish_task_event,
    )
    if event_id.startswith("fallback-confirm-"):
        approval_event["id"] = event_id
    task["pending_confirmation"] = {
        "kind": payload.get("kind") or "manual_continue",
        "action": pending.get("action") or "continue_task",
        "reason": message,
        "event_id": approval_event.get("id"),
        "approval_id": approval_id,
        "payload": payload,
        "manual_required": True,
        "high_risk": bool(pending.get("high_risk", False)),
        "auto_approve_after_seconds": 0,
    }

    return approval_event


@router.post("/{task_id}/approvals/{event_id}")
async def resolve_task_approval(task_id: str, event_id: str, payload: ApprovalResolvePayload, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    task = _tasks[task_id]
    _verify_task_ownership(task, request)

    events = task.get("events") or []
    approval_event = next((event for event in events if event.get("id") == event_id), None)
    if not approval_event or approval_event.get("type") != "approval_requested":
        approval_event = _ensure_waiting_confirm_approval_event(task, event_id)
    if not approval_event or approval_event.get("type") != "approval_requested":
        raise HTTPException(status_code=404, detail="Approval request not found")
    events = task.get("events") or []

    approval_payload = approval_event.get("payload") or {}
    nested_payload = approval_payload.get("payload") if isinstance(approval_payload.get("payload"), dict) else {}
    pending_confirmation = task.get("pending_confirmation") if isinstance(task.get("pending_confirmation"), dict) else {}
    is_auto_continuation_budget = (
        pending_confirmation.get("kind") == "auto_continuation_budget"
        or nested_payload.get("kind") == "auto_continuation_budget"
    )
    is_continue_task = (
        is_auto_continuation_budget
        or pending_confirmation.get("action") == "continue_task"
        or approval_payload.get("action") == "continue_task"
    )
    approval_id = approval_payload.get("approval_id") or event_id
    resolved_event = next((
        event
        for event in events
        if event.get("type") == "approval_resolved"
        and ((event.get("payload") or {}).get("approval_id") == approval_id or (event.get("payload") or {}).get("event_id") == event_id)
    ), None)
    already_resolved = resolved_event is not None
    if already_resolved:
        resolved_payload = (resolved_event or {}).get("payload") or {}
        resolved_approved = bool(resolved_payload.get("approved"))
        if task.get("status") == "waiting_confirm":
            if resolved_approved:
                if is_continue_task:
                    task["status"] = "pending"
                    task["execution_active"] = False
                    task["needs_continuation"] = True
                    task["current_step"] = "已批准继续执行，任务已重新进入队列。"
                    task_queue.enqueue(task_id, "manual confirmation: continue task")
                else:
                    task["status"] = "running"
                    task["current_step"] = "已批准操作，继续执行..."
            else:
                task["status"] = "cancelled"
                task["current_step"] = "用户拒绝了待确认操作"
            task.pop("pending_confirmation", None)
            save_task(task)
            _publish_task_update(task_id, "runtime_event", resolved_event)
            _publish_task_update(task_id, "status", _task_response_payload(task))
        return {"ok": True, "approved": resolved_approved, "already_resolved": True}

    _confirmations[task_id] = {
        "event_id": event_id,
        "approval_id": approval_id,
        "confirmed_at": datetime.utcnow().isoformat(),
        "confirmed": bool(payload.approved),
        "approved": bool(payload.approved),
        "note": payload.note,
        "payload": approval_payload,
    }
    if payload.approved and task.get("status") == "waiting_confirm":
        if is_continue_task:
            task["status"] = "pending"
            task["execution_active"] = False
            task["needs_continuation"] = True
            task["current_step"] = "已批准继续执行，任务已重新进入队列。"
        else:
            task["status"] = "running"
            task["current_step"] = "已批准操作，继续执行..."
        task.pop("pending_confirmation", None)
    elif not payload.approved:
        if task.get("status") == "waiting_confirm":
            task["status"] = "cancelled"
        task.pop("pending_confirmation", None)
        task["current_step"] = "用户拒绝了待确认操作"
    append_event(
        task,
        "approval_resolved",
        {
            "approval_id": approval_id,
            "event_id": event_id,
            "approved": bool(payload.approved),
            "note": payload.note,
        },
        source="user",
    )
    save_task(task)
    _publish_task_update(task_id, "runtime_event", (task.get("events") or [])[-1])
    _publish_task_update(task_id, "status", _task_response_payload(task))
    if payload.approved and is_continue_task:
        task_queue.enqueue(task_id, "manual confirmation: continue task")
    return {"ok": True, "approved": bool(payload.approved)}

#  POST /api/tasks/{task_id}/confirm-destructive ?
@router.post("/{task_id}/confirm-destructive")
async def confirm_destructive(task_id: str, request: Request, path: str):
    """/"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    _confirmations[task_id] = {
        "path": path,
        "confirmed_at": datetime.utcnow().isoformat(),
        "confirmed": True,
    }
    return {"ok": True, "confirmed_path": path}

#  POST /api/tasks/{task_id}/confirm-plan ??
class PlanConfirmPayload(BaseModel):
    confirmed: bool = Field(..., description="true=confirm, false=reject")
    modified_plan: Optional[dict] = Field(default=None, description="Optional modified plan JSON")


@router.post("/{task_id}/confirm-plan")
async def confirm_plan(task_id: str, payload: PlanConfirmPayload, request: Request):
    """Confirm or reject the AI-generated plan."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]
    if t.get("status") != "waiting_plan_confirm":
        raise HTTPException(status_code=400, detail=f"Current status does not require plan confirmation: {t.get('status')}")

    if payload.confirmed:
        if payload.modified_plan:
            t["plan"] = payload.modified_plan
        t["plan_confirmed"] = True
        t["status"] = "running"
        t["current_step"] = "计划已确认，继续执行。"
        t["logs"].append({
            "timestamp": datetime.utcnow().isoformat(),
            "agent": "system",
            "level": "success",
            "message": "计划已确认",
        })
        save_task(dict(t))
        task_queue.enqueue(task_id, "plan confirmed")
        return {"ok": True, "message": "计划已确认，任务已继续执行"}
    t["plan_confirmed"] = False
    t["status"] = "cancelled"
    t["current_step"] = "用户拒绝了开发计划"
    save_task(dict(t))
    return {"ok": True, "message": "计划已拒绝，任务已取消"}

#  POST /api/tasks/{task_id}/confirm-prototype ? 
class PrototypeConfirmPayload(BaseModel):
    confirmed: bool = Field(..., description="true=confirm, false=reject")
    modified_prototype: Optional[dict] = Field(default=None, description="Optional modified Excalidraw JSON")


@router.post("/{task_id}/confirm-prototype")
async def confirm_prototype(task_id: str, payload: PrototypeConfirmPayload, request: Request):
    """Confirm or reject the generated UI prototype."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]
    if t.get("status") != "waiting_prototype_confirm":
        raise HTTPException(status_code=400, detail=f"Current status does not require prototype confirmation: {t.get('status')}")

    if payload.confirmed:
        if payload.modified_prototype:
            t["prototype"] = payload.modified_prototype
            try:
                from core.config import settings
                from core.prototype_generator import save_prototype_record
                workspace_id = t.get("workspace_id")
                if workspace_id:
                    record = save_prototype_record(
                        settings.workspace_base_dir / workspace_id,
                        payload.modified_prototype,
                        prototype_id=payload.modified_prototype.get("prototype_id"),
                        source="confirm-edit",
                        kind="excalidraw",
                    )
                    t["prototype"]["prototype_id"] = record["id"]
            except Exception:
                pass
        t["prototype_confirmed"] = True
        t["status"] = "running"
        t["current_step"] = "UI 原型已确认，继续执行。"
        t["logs"].append({
            "timestamp": datetime.utcnow().isoformat(),
            "agent": "system",
            "level": "success",
            "message": "UI 原型已确认",
        })
        save_task(dict(t))
        task_queue.enqueue(task_id, "prototype confirmed")
        return {"ok": True, "message": "UI 原型已确认，任务已继续执行"}
    t["prototype_confirmed"] = False
    t["status"] = "cancelled"
    t["current_step"] = "用户拒绝了 UI 原型"
    save_task(dict(t))
    return {"ok": True, "message": "UI 原型已拒绝，任务已取消"}

#  POST /api/tasks/{task_id}/confirm-review ? 
class ReviewConfirmPayload(BaseModel):
    confirmed: bool = Field(..., description="true=confirm, false=reject")


@router.post("/{task_id}/confirm-review")
async def confirm_review(task_id: str, payload: ReviewConfirmPayload, request: Request):
    """Confirm or reject the final review gate."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]
    if t.get("status") != "waiting_review_confirm":
        raise HTTPException(status_code=400, detail=f"Current status does not require review confirmation: {t.get('status')}")

    review = t.get("review", {})
    review_score = review.get("score", 0)
    issue_count = len(review.get("issues", []))

    if payload.confirmed:
        t["review_confirmed"] = True
        t["status"] = "running"
        t["current_step"] = "代码审查已确认，继续执行。"
        t["logs"].append({
            "timestamp": datetime.utcnow().isoformat(),
            "agent": "system",
            "level": "success",
            "message": f"代码审查已确认：评分 {review_score}，问题 {issue_count} 个",
        })
        save_task(dict(t))
        task_queue.enqueue(task_id, "review confirmed")
        return {"ok": True, "message": "代码审查已确认，任务已继续执行"}
    t["review_confirmed"] = False
    t["status"] = "cancelled"
    t["current_step"] = "用户拒绝了代码审查"
    save_task(dict(t))
    return {"ok": True, "message": "代码审查已拒绝，任务已取消"}

#  POST /api/tasks/{task_id}/stop ? 
@router.post("/{task_id}/stop")
async def stop_task(task_id: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    _tasks[task_id]["cancel_requested"] = True
    _tasks[task_id]["status"] = "cancelled"
    asyncio.create_task(asyncio.to_thread(save_task, dict(_tasks[task_id])))
    agent_orchestrator.cancel_task(task_id)
    return {"ok": True}

#  POST /api/tasks/{task_id}/retry ? 
@router.post("/{task_id}/retry", response_model=TaskResponse)
async def retry_task(task_id: str, request: Request):
    """/?"""
    from loguru import logger as _logger

    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]
    if t["status"] not in ("failed", "cancelled"):
        raise HTTPException(status_code=400, detail=f"?{t['status']} ?failed/cancelled ?")

    # ?
    previous_status = t.get("status")
    previous_step = t.get("current_step") or ""
    _normalize_plan_for_resume(t, reset_status=True)

    t["status"] = "pending"
    t["progress"] = 0
    t["current_step"] = "..."
    t["logs"] = t.get("logs", [])[-5:]  # ?5 ?
    t["preview_url"] = None
    t["error_detail"] = None
    t["review_confirmed"] = None
    t["execution_active"] = False
    _append_task_log(
        t,
        "warn",
        "?",
        agent="queue",
        detail=f"? {previous_status}; ? {previous_step}",
    )
    _append_command_record(
        t,
        f"autocode retry {task_id}",
        "running",
        label="",
        output=f"? {previous_status}\n? {previous_step}",
        source="system",
    )

    # Retry must continue from the existing workspace. Recreating the workspace
    # after a phase failure loses completed artifacts and makes group 1 run again.
    needs_cont = True
    old_workspace_id = t["workspace_id"]

    if needs_cont:
        # EMORY.md  Agent 
        _logger.info(f"[Task {task_id}] ? {old_workspace_id}")
        new_workspace_id = old_workspace_id
        t.pop("needs_continuation", None)  # 
    else:
        # ?workspace_id
        new_workspace_id = f"ws-{uuid.uuid4().hex[:12]}"
        t["workspace_id"] = new_workspace_id

        # ?
        try:
            await docker_manager.destroy_workspace(old_workspace_id)
        except Exception:
            pass
        try:
            from core.dev_server_manager import dev_server_manager
            if hasattr(dev_server_manager, '_servers') and old_workspace_id in dev_server_manager._servers:
                await dev_server_manager.stop_dev_server(old_workspace_id)
        except Exception:
            pass

    # ?
    await asyncio.to_thread(save_task, dict(t))

    # 
    async def _safe_execute():
        try:
            #  SPEC.md ?
            spec_content = t.get("spec")
            if spec_content:
                try:
                    from core.config import get_settings
                    workspace_path = get_settings().workspace_base_dir / t["workspace_id"]
                    workspace_path.mkdir(parents=True, exist_ok=True)
                    spec_path = workspace_path / "SPEC.md"
                    spec_path.write_text(spec_content, encoding="utf-8")
                    logger.info(f"[Task {task_id}] SPEC.md ? {spec_path}")
                except Exception as spec_err:
                    logger.warning(f"[Task {task_id}]  SPEC.md : {spec_err}")

            #  LLM ?
            try:
                _ = await agent_orchestrator._ensure_client(requested_model=t.get("model"))
                _logger.info(f"[Task {task_id} retry] LLM : {agent_orchestrator._model}")
            except RuntimeError as e:
                _logger.error(f"[Task {task_id} retry] LLM : {e}")
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["current_step"] = ""
                _tasks[task_id]["logs"].append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "agent": "system",
                    "level": "error",
                    "message": str(e),
                })
                save_task(_tasks[task_id])
                return

            await agent_orchestrator.execute_task(
                task_id,
                t.get("description", t["title"]),
                t.get("project_type", "website"),
                t["workspace_id"],
                t.get("agents", ["frontend"]),
            )
            if task_id in _tasks:
                save_task(_tasks[task_id])
        except Exception as e:
            _logger.error(f"[Task {task_id} retry] : {e}")
            if task_id in _tasks:
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["logs"].append({
                    "timestamp": datetime.utcnow().isoformat(),
                    "agent": "system",
                    "level": "error",
                    "message": f": {e}",
                    "detail": str(e),
                })
                save_task(_tasks[task_id])

    task_queue.enqueue(task_id, "")
    return TaskResponse(**_task_response_payload(t))

#  GET /api/tasks/{task_id}/memory ? 
@router.get("/{task_id}/memory")
async def get_task_memory(task_id: str, request: Request):
    """?PLAN.md ?MEMORY.md ?"""
    from core.config import get_settings as _get_settings

    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]
    ws_id = t.get("workspace_id", "")
    ws_base = _get_settings().workspace_base_dir
    autocode_dir = ws_base / ws_id / ".autocode"

    result = {
        "task_id": task_id,
        "workspace_id": ws_id,
        "plan": None,
        "memory": None,
        "chat": None,
        "session_summary": None,
    }

    # ?
    for key, filename in [
        ("plan", "PLAN.md"),
        ("memory", "MEMORY.md"),
        ("chat", "CHAT.md"),
        ("session_summary", "SESSION_SUMMARY.md"),
    ]:
        fpath = autocode_dir / filename
        if fpath.exists():
            result[key] = fpath.read_text(encoding="utf-8")

    return result

#  POST /api/tasks/{task_id}/chat ?SE 
from pydantic import BaseModel as PydanticBaseModel

class ChatFileAttachment(PydanticBaseModel):
    name: str
    url: str
    type: str = ""
    size: int = 0
    content: str = ""

class ChatMessageRequest(PydanticBaseModel):
    message: str
    files: list[ChatFileAttachment] = []

@router.post("/{task_id}/chat")
async def chat_with_agent(task_id: str, payload: ChatMessageRequest, request: Request):
    """Chat with the AutoCode IDE controller."""
    from loguru import logger as _logger

    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    t = _tasks[task_id]

    full_message = payload.message
    if payload.files:
        file_descriptions = []
        for f in payload.files:
            file_info = f"- [{f.name}]({f.url}) ({f.type}, {f.size} bytes)"
            file_descriptions.append(file_info)
        full_message = f"{payload.message}\n\n闄勪欢锛歕n" + "\n".join(file_descriptions)

    controller_decision: dict | None = None
    try:
        controller_decision = await _run_chat_controller(task_id, t, full_message, request)
        _append_task_log(
            t,
            "info",
            f"AI controller action: {controller_decision.get('action')}",
            agent="chat_controller",
            detail=json.dumps(controller_decision, ensure_ascii=False)[:2000],
        )
        save_task(t)
        if _controller_decision_needs_fallback(controller_decision):
            fallback_decision = _fallback_chat_decision(payload.message, t)
            controller_decision = {
                **fallback_decision,
                "controller_fallback": True,
                "controller_raw": controller_decision,
            }
            _append_task_log(
                t,
                "warn",
                f"AI controller unusable, local fallback action: {controller_decision.get('action')}",
                agent="chat_controller",
                detail=json.dumps(controller_decision, ensure_ascii=False)[:2000],
            )
            save_task(t)
    except Exception as controller_err:
        _logger.warning(f"[ChatController] AI decision failed, fallback to local detector: {controller_err}")
        controller_decision = {
            **_fallback_chat_decision(payload.message, t),
            "controller_fallback": True,
            "controller_error": str(controller_err),
        }

    decided_action = str(controller_decision.get("action") or "answer")
    if decided_action == "continue_development":
        controller_decision["answer"] = str(
            controller_decision.get("answer")
            or "我会基于当前工作区、计划、审查结果和 Git 快照继续分析并执行修改。"
        )
    if decided_action == "answer_usage":
        decided_action = "answer"
        controller_decision["answer"] = _build_usage_help_message(task_id, t)

    if decided_action != "continue_development":
        if decided_action == "answer":
            answer = str(controller_decision.get("answer") or "").strip()
            if not answer:
                answer = _build_usage_help_message(task_id, t)
            return StreamingResponse(
                _stream_chat_answer(task_id, t, full_message, answer),
                media_type="text/event-stream",
            )
        action = dict(controller_decision)
        action["type"] = decided_action
        return StreamingResponse(
            _stream_chat_action(task_id, t, full_message, action),
            media_type="text/event-stream",
        )

    queue = agent_orchestrator.receive_user_message(task_id, full_message)
    if queue is None:
        _prepare_task_for_chat_continuation(t, full_message)
        save_task(t)
        if not task_queue.enqueue(task_id, "chat continue development"):
            queue_state = task_queue.snapshot()
            already_waiting = task_id in set(queue_state.get("queued_task_ids") or []) or bool(agent_orchestrator._active_tasks.get(task_id))
            if not already_waiting:
                raise HTTPException(status_code=409, detail="任务已转入续跑状态，但后台队列暂时未接收；请稍后重试或刷新页面。")
    else:
        queue_state = task_queue.snapshot()
        already_waiting = task_id in set(queue_state.get("queued_task_ids") or []) or bool(agent_orchestrator._active_tasks.get(task_id))
        if not already_waiting and t.get("status") not in WAITING_TASK_STATUSES:
            if t.get("status") not in TERMINAL_TASK_STATUSES:
                t["status"] = "pending"
                t["execution_active"] = False
                t["current_step"] = "收到新的对话输入，已唤醒 Agent 继续执行。"
                append_event(
                    t,
                    "session_wake_scheduled",
                    {"reason": "chat_message_on_idle_task", "message_preview": full_message[:1200]},
                    source="chat_controller",
                )
                task_queue.enqueue(task_id, "chat wake: idle task has pending input")
        save_task(t)
    return StreamingResponse(
        _stream_chat_answer(
            task_id,
            t,
            full_message,
            str(controller_decision.get("answer") or "已收到开发指令，Agent 会基于当前工作区、计划、审查结果和 Git 快照继续执行。"),
        ),
        media_type="text/event-stream",
    )

#  POST /api/tasks/{task_id}/rollback ??commit 
@router.post("/{task_id}/rollback")
async def rollback_task(task_id: str, commit_hash: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    task = _tasks[task_id]
    _verify_task_ownership(task, request)
    result = _rollback_task_to_target(task_id, task, commit_hash)
    return {"ok": True, "rolled_back_to": result["commit_hash"]}

#  GET /api/tasks/{task_id}/dev-server ?Dev Server ?
@router.get("/{task_id}/dev-server")
async def get_dev_server_status(task_id: str, request: Request):
    """?Dev Server """
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    ws_id = _tasks[task_id].get("workspace_id")
    if not ws_id:
        return {"status": "no_workspace", "url": None, "output": "", "error_detail": ""}
    from services.dev_server_manager import dev_server_manager
    session = getattr(dev_server_manager, "_sessions", {}).get(ws_id)
    if not session:
        return {"status": "stopped", "url": None, "output": "", "error_detail": ""}
    return {
        "status": getattr(session, "status", "unknown"),
        "url": getattr(session, "url", None),
        "port": getattr(session, "port", None),
        "output": getattr(session, "output", ""),
        "error_detail": getattr(session, "error_detail", ""),
    }

#  POST /api/tasks/{task_id}/dev-server/restart ? Dev Server 
@router.post("/{task_id}/dev-server/restart")
async def restart_dev_server(task_id: str, request: Request):
    """?Dev Server"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    t = _tasks[task_id]
    ws_id = t.get("workspace_id")
    if not ws_id:
        raise HTTPException(status_code=400, detail="")

    from services.dev_server_manager import dev_server_manager
    from core.config import get_settings
    cfg = get_settings()
    ws_path = str(cfg.workspace_base_dir / ws_id)

    await dev_server_manager.stop_dev_server(ws_id)

    project_type = t.get("project_type", "default")
    result = await dev_server_manager.start_dev_server(ws_id, ws_path, project_type)

    if result and result.get("url"):
        t["preview_url"] = f"/api/proxy/{ws_id}/"
        t["dev_server_port"] = result["port"]
        save_task(t)
        return {"ok": True, "url": result["url"], "port": result["port"]}

#  POST /api/tasks/{task_id}/dev-server/stop ? Dev Server 
@router.post("/{task_id}/dev-server/stop")
async def stop_dev_server(task_id: str, request: Request):
    """?Dev Server"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    t = _tasks[task_id]
    ws_id = t.get("workspace_id")
    if not ws_id:
        raise HTTPException(status_code=400, detail="")

    from services.dev_server_manager import dev_server_manager
    await dev_server_manager.stop_dev_server(ws_id)

    #  URL
    t.pop("preview_url", None)
    t.pop("dev_server_port", None)
    save_task(t)

    return {"ok": True}

#  GET /api/tasks/{task_id}/files ? workspace  
@router.get("/{task_id}/files")
async def list_workspace_files(task_id: str, request: Request, path: str = "/"):
    """ workspace ?"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    ws_id = _tasks[task_id].get("workspace_id")
    if not ws_id:
        raise HTTPException(status_code=400, detail="")

    ws_path = _resolve_workspace_path(task_id, path).resolve()

    if not ws_path.exists():
        return {"files": [], "path": path}
    if not ws_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    ws_root = _resolve_workspace_path(task_id, "/").resolve()
    files = []
    for item in sorted(ws_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())):
        if item.name == ".git":
            continue
        try:
            rel_path = item.relative_to(ws_root).as_posix()
            stat = item.stat()
            files.append({
                "name": item.name,
                "path": rel_path,
                "type": "dir" if item.is_dir() else "file",
                "size": 0 if item.is_dir() else stat.st_size,
                "modified": datetime.utcfromtimestamp(stat.st_mtime).isoformat() + "Z",
                "is_text": False if item.is_dir() else _is_text_file(item),
            })
        except (OSError, ValueError):
            continue
    try:
        display_path = "/" if ws_path == ws_root else "/" + ws_path.relative_to(ws_root).as_posix()
    except ValueError:
        display_path = path or "/"
    return {"files": files, "path": display_path}

#   
_TEXT_EXTENSIONS = {
    ".txt", ".md", ".py", ".js", ".jsx", ".ts", ".tsx", ".html", ".css", ".scss",
    ".json", ".yaml", ".yml", ".xml", ".csv", ".sh", ".bat", ".ps1", ".ini", ".cfg",
    ".toml", ".env", ".gitignore", ".dockerignore", ".editorconfig", ".sql",
    ".java", ".kt", ".swift", ".go", ".rs", ".c", ".cpp", ".h", ".hpp",
    ".rb", ".php", ".pl", ".r", ".lua", ".dart", ".graphql", ".vue", ".svelte",
    ".mjs", ".cjs", ".astro",
}

def _is_text_file(filepath: Path) -> bool:
    """?"""
    return filepath.suffix.lower() in _TEXT_EXTENSIONS

def _resolve_workspace_path(task_id: str, rel_path: str = "/") -> Path:
    """?"""
    from core.config import get_settings
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    ws_id = _tasks[task_id].get("workspace_id")
    if not ws_id:
        raise HTTPException(status_code=400, detail="")
    cfg = get_settings()
    ws_root = cfg.workspace_base_dir / ws_id
    if not ws_root.exists():
        raise HTTPException(status_code=404, detail="?")
    # ?
    if not rel_path or rel_path == "/":
        return ws_root.resolve(strict=False)
    normalized = str(rel_path).replace("\\", "/").strip()
    if normalized.startswith("/workspace/"):
        normalized = normalized[len("/workspace/"):]
    normalized = normalized.lstrip("/")
    target = (ws_root / normalized).resolve(strict=False)
    try:
        target.relative_to(ws_root.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Path escapes workspace")
    return target

#  GET /api/tasks/{task_id}/files/content ? 
class FileEditRequest(BaseModel):
    path: str = Field(..., description=" /src/App.tsx")
    content: str = Field(..., description="")

class FileRunRequest(BaseModel):
    path: str = Field(..., description="script path relative to workspace")

class CommandRunRequest(BaseModel):
    kind: str = Field(default="test", description="test/build/custom")
    command: Optional[str] = Field(default=None, description="custom command, workspace-scoped")


def _pipeline_commands(task_id: str) -> list[tuple[str, str]]:
    ws_root = _resolve_workspace_path(task_id, "/")
    commands: list[tuple[str, str]] = []
    package_json = ws_root / "package.json"
    if package_json.exists():
        try:
            pkg = json.loads(package_json.read_text(encoding="utf-8"))
            scripts = pkg.get("scripts") or {}
        except Exception:
            scripts = {}
        commands.append(("install", "npm install"))
        if "lint" in scripts:
            commands.append(("lint", "npm run lint"))
        if "test" in scripts:
            commands.append(("test", "npm test"))
        elif "build" in scripts:
            commands.append(("test", "npm run build"))
        if "build" in scripts:
            commands.append(("build", "npm run build"))
        return commands

def _write_pipeline_report(task: dict, reports: list[dict]) -> None:
    try:
        ws_root = _resolve_workspace_path(task["id"], "/")
        autocode = ws_root / ".autocode"
        autocode.mkdir(parents=True, exist_ok=True)
        lines = [
            "# CI Report",
            ","
            f"- Pipeline status: {'passed' if all(r.get('status') == 'success' for r in reports) else 'failed'}",
            f"- Time: {_now_iso()}",
            ","
            "## Steps",
            ","
        ]
        for r in reports:
            lines.extend([
                f"### {r.get('label') or r.get('command')}",
                "",
                f"- Status: {r.get('status')}",
                f"- Command: `{r.get('command')}`",
                f"- Exit code: {r.get('exit_code')}",
                "",
                "```text",
                str(r.get("output") or "")[:8000],
                "```",
                "",
            ])
        (autocode / "CI_REPORT.md").write_text("\n".join(lines), encoding="utf-8")
    except Exception:
        pass


async def _execute_pipeline(task_id: str, task: dict):
    commands = _pipeline_commands(task_id)
    if not commands:
        raise HTTPException(status_code=400, detail="No runnable pipeline detected for this workspace")

    reports: list[dict] = []
    for label, command in commands:
        ok_safe, reason = _is_safe_custom_command(command)
        if not ok_safe:
            report = {
                "label": label,
                "command": command,
                "status": "failed",
                "exit_code": 126,
                "output": reason,
            }
            reports.append(report)
            break

        record = _append_command_record(task, command, "running", label=f"Pipeline: {label}", source="pipeline")
        save_task(task)
        yield {"type": "command", "record": record}

        result = await docker_manager.execute_in_workspace(task["workspace_id"], command, timeout=600)
        output = "\n".join([result.get("stdout") or "", result.get("stderr") or ""]).strip()
        exit_code = result.get("exit_code", -1)
        status = "success" if exit_code == 0 else "failed"
        output_meta = _bound_task_output(task, output, tool_name="pipeline")
        preview_output = output_meta["preview"] if output_meta else (output[-12000:] if output else "")
        model_output = output_meta["model_preview"] if output_meta else (output[-2000:] if output else "")
        record.update({
            "status": status,
            "output": preview_output,
            "output_truncated": bool((output_meta or {}).get("truncated")),
            "output_path": (output_meta or {}).get("full_path", ""),
            "output_sha256": (output_meta or {}).get("sha256", ""),
            "output_chars": (output_meta or {}).get("chars", len(output) if output else 0),
            "output_lines": (output_meta or {}).get("lines", output.count("\n") + 1 if output else 0),
            "exit_code": exit_code,
            "finished_at": _now_iso(),
        })
        report = {
            "label": label,
            "command": command,
            "status": status,
            "exit_code": exit_code,
            "output": preview_output,
            "output_truncated": bool((output_meta or {}).get("truncated")),
            "output_path": (output_meta or {}).get("full_path", ""),
            "output_sha256": (output_meta or {}).get("sha256", ""),
            "output_chars": (output_meta or {}).get("chars", len(output) if output else 0),
            "output_lines": (output_meta or {}).get("lines", output.count("\n") + 1 if output else 0),
        }
        reports.append(report)
        _append_task_log(
            task,
            "success" if status == "success" else "warn",
            f"?{label}: {status}",
            agent="ci",
            detail=model_output or "(no output)",
        )
        save_task(task)
        yield {"type": "command", "record": record}
        if status != "success":
            break

    pipeline_status = "passed" if reports and all(r.get("status") == "success" for r in reports) else "failed"
    preview_status = "skipped"
    preview_url = task.get("preview_url")
    preview_error = ""
    if pipeline_status == "passed":
        try:
            ws_id = task.get("workspace_id")
            if ws_id:
                from core.config import get_settings
                cfg = get_settings()
                project_type = task.get("project_type", "default")
                await dev_server_manager.stop_dev_server(ws_id)
                result = await dev_server_manager.start_dev_server(
                    ws_id,
                    str(cfg.workspace_base_dir / ws_id),
                    project_type,
                )
                if result and result.get("url"):
                    preview_status = "running"
                    preview_url = f"/api/proxy/{ws_id}/"
                    task["preview_url"] = preview_url
                    task["dev_server_port"] = result.get("port")
                else:
                    preview_status = "failed"
                    preview_error = str((result or {}).get("error_detail") or (result or {}).get("status") or "preview failed")
        except Exception as exc:
            preview_status = "failed"
            preview_error = str(exc)
    else:
        task.pop("preview_url", None)

    task["pipeline_status"] = pipeline_status
    task["preview_status"] = preview_status
    if preview_error:
        task["preview_error"] = preview_error[:1000]
    elif "preview_error" in task:
        task.pop("preview_error", None)

    run = {
        "status": pipeline_status,
        "steps": reports,
        "created_at": _now_iso(),
        "preview_status": preview_status,
        "preview_url": preview_url,
        "preview_error": preview_error[:1000] if preview_error else None,
    }
    task["pipeline_runs"] = (task.get("pipeline_runs") or [])[-9:] + [run]
    _write_pipeline_report(task, reports)
    save_task(task)
    yield {"type": "pipeline_done", **run}


@router.get("/{task_id}/commands")
async def list_task_commands(task_id: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    return {"commands": _tasks[task_id].get("command_history", [])[-80:]}

@router.post("/{task_id}/commands/run")
async def run_task_command(task_id: str, payload: CommandRunRequest, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    t = _tasks[task_id]
    kind = (payload.kind or "test").strip()
    command = payload.command if kind == "custom" and payload.command else _infer_workspace_command(task_id, kind)
    if kind == "custom":
        ok, reason = _is_safe_custom_command(command)
        if not ok:
            raise HTTPException(status_code=400, detail=reason or "命令不在安全白名单内")
    return await _execute_workspace_command_record(task_id, t, command, kind=kind, source="manual", timeout=300)

@router.post("/{task_id}/commands/pipeline")
async def run_task_pipeline(task_id: str, request: Request):
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    t = _tasks[task_id]
    final = None
    async for event in _execute_pipeline(task_id, t):
        if event.get("type") == "pipeline_done":
            final = event
    if not final:
        raise HTTPException(status_code=500, detail="Pipeline did not finish")
    return {
        "status": final.get("status"),
        "steps": final.get("steps") or [],
        "preview_url": final.get("preview_url"),
        "preview_status": final.get("preview_status"),
        "preview_error": final.get("preview_error"),
    }

@router.get("/{task_id}/files/content")
async def read_workspace_file(task_id: str, request: Request, path: str = Query(..., description="")):
    """?"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    filepath = _resolve_workspace_path(task_id, path)
    
    if filepath.is_dir():
        raise HTTPException(status_code=400, detail="")
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="?")
    
    if not _is_text_file(filepath):
        raise HTTPException(status_code=400, detail="")
    
    try:
        content = filepath.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        try:
            content = filepath.read_text(encoding="gbk")
        except Exception:
            raise HTTPException(status_code=400, detail="")
    
    return {
        "path": path,
        "content": content,
        "size": filepath.stat().st_size,
        "mtime": filepath.stat().st_mtime,
    }

#  PUT /api/tasks/{task_id}/files/content ?/ 
@router.put("/{task_id}/files/content")
async def save_workspace_file(task_id: str, payload: FileEditRequest, request: Request):
    """/"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    filepath = _resolve_workspace_path(task_id, payload.path)
    
    if filepath.is_dir():
        raise HTTPException(status_code=400, detail="")
    
    # ?
    filepath.parent.mkdir(parents=True, exist_ok=True)
    
    try:
        filepath.write_text(payload.content, encoding="utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f": {str(e)}")
    
    rel = payload.path.lstrip("/").replace("\\", "/")
    _refresh_git_history(_tasks[task_id], f"Manual edit: {rel}", [rel])
    save_task(_tasks[task_id])

    return {
        "ok": True,
        "path": rel,
        "size": filepath.stat().st_size,
        "mtime": filepath.stat().st_mtime,
    }

#  GET /api/tasks/{task_id}/files/download ? 
@router.post("/{task_id}/files/run")
async def run_workspace_file(task_id: str, payload: FileRunRequest, request: Request):
    """Run a script file with a strict extension whitelist."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    filepath = _resolve_workspace_path(task_id, payload.path)
    if filepath.is_dir():
        raise HTTPException(status_code=400, detail="")
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="?")

    suffix = filepath.suffix.lower()
    rel = payload.path.lstrip("/").replace("\\", "/")
    commands = {
        ".py": f"python {json.dumps(rel)}",
        ".js": f"node {json.dumps(rel)}",
        ".mjs": f"node {json.dumps(rel)}",
        ".cjs": f"node {json.dumps(rel)}",
        ".sh": f"bash {json.dumps(rel)}",
        ".ps1": f"pwsh -NoProfile -File {json.dumps(rel)}",
    }
    command = commands.get(suffix)
    if not command:
        raise HTTPException(status_code=400, detail="?.py/.js/.mjs/.cjs/.sh/.ps1 ")

    ws_id = _tasks[task_id].get("workspace_id")
    record = _append_command_record(_tasks[task_id], command, "running", label=f" {rel}")
    save_task(_tasks[task_id])
    result = await docker_manager.execute_in_workspace(ws_id, command, timeout=30)
    output = "\n".join([result.get("stdout") or "", result.get("stderr") or ""]).strip()
    ok = result.get("exit_code", 0) == 0
    output_meta = _bound_task_output(_tasks[task_id], output, tool_name="run_file")
    preview_output = output_meta["preview"] if output_meta else (output[-12000:] if output else "")
    model_output = output_meta["model_preview"] if output_meta else (output[-2000:] if output else "")
    record.update({
        "status": "success" if ok else "failed",
        "output": preview_output,
        "output_truncated": bool((output_meta or {}).get("truncated")),
        "output_path": (output_meta or {}).get("full_path", ""),
        "output_sha256": (output_meta or {}).get("sha256", ""),
        "output_chars": (output_meta or {}).get("chars", len(output) if output else 0),
        "output_lines": (output_meta or {}).get("lines", output.count("\n") + 1 if output else 0),
        "exit_code": result.get("exit_code", -1),
        "finished_at": _now_iso(),
    })
    _append_task_log(
        _tasks[task_id],
        "success" if ok else "warn",
        f": {command}",
        agent="terminal",
        detail=model_output or "(no output)",
        tool_name="bash",
    )
    save_task(_tasks[task_id])
    return {

        "command": command,
        "stdout": (result.get("stdout") or "")[-8000:],
        "stderr": (result.get("stderr") or "")[-8000:],
        "exit_code": result.get("exit_code", -1),
    }


@router.get("/{task_id}/files/download")
async def download_workspace_file(task_id: str, request: Request, path: str = Query(..., description="")):
    """Download a workspace file."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    filepath = _resolve_workspace_path(task_id, path)
    
    if filepath.is_dir():
        raise HTTPException(status_code=400, detail="")
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="?")
    
    # ?
    media_type = "application/octet-stream"
    if _is_text_file(filepath):
        media_type = "text/plain; charset=utf-8"
    
    return FileResponse(
        filepath,
        media_type=media_type,
        filename=filepath.name,
    )

#  GET /api/tasks/{task_id}/files/download-project ? 
@router.get("/{task_id}/files/download-project")
async def download_workspace_project(task_id: str, request: Request):
    """ ZIP """
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)
    ws_root = _resolve_workspace_path(task_id, "/")
    
    #  ZIP
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for filepath in ws_root.rglob("*"):
            if filepath.is_dir():
                continue
            # ?
            parts = filepath.parts
            skip = False
            for skip_dir in ("node_modules", ".git", ".next", "__pycache__", ".venv", "dist", ".cache", "build"):
                if skip_dir in parts:
                    skip = True
                    break
            if skip:
                continue
            # ?ws_root ?
            arcname = str(filepath.relative_to(ws_root))
            try:
                zf.write(filepath, arcname)
            except Exception:
                continue  # ?
    
    buffer.seek(0)
    ws_id = _tasks[task_id].get("workspace_id", task_id[:8])
    
    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{ws_id}.zip"'},
    )

#  GET /api/tasks/{task_id}/spec ??
@router.get("/{task_id}/spec")
async def get_task_spec(task_id: str, request: Request):
    """SPEC.md ?"""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    from core.config import get_settings
    settings = get_settings()
    ws_id = _tasks[task_id].get("workspace_id", "")
    spec_path = settings.workspace_base_dir / ws_id / "SPEC.md"
    legacy_spec_path = settings.workspace_base_dir / ws_id / ".autocode" / "SPEC.md"

    if not spec_path.exists() and legacy_spec_path.exists():
        spec_path = legacy_spec_path

    if not spec_path.exists():
        return {"spec": None, "exists": False}
    return {"spec": spec_path.read_text(encoding="utf-8"), "exists": True}

#  PUT /api/tasks/{task_id}/spec ??
class SpecUpdateRequest(BaseModel):
    spec: str = Field(..., description=" SPEC.md ")

@router.put("/{task_id}/spec")
async def update_task_spec(task_id: str, payload: SpecUpdateRequest, request: Request):
    """Update SPEC.md."""
    if task_id not in _tasks:
        raise HTTPException(status_code=404, detail="Task not found")
    _verify_task_ownership(_tasks[task_id], request)

    from core.config import get_settings
    settings = get_settings()
    ws_id = _tasks[task_id].get("workspace_id", "")
    spec_path = settings.workspace_base_dir / ws_id / "SPEC.md"
    spec_path.parent.mkdir(parents=True, exist_ok=True)
    spec_path.write_text(payload.spec, encoding="utf-8")

    #  spec 
    _tasks[task_id]["spec"] = payload.spec
    try:
        await asyncio.to_thread(save_task, dict(_tasks[task_id]))
    except Exception:
        pass

    return {"ok": True, "spec": payload.spec}
