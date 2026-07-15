from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Iterable

from core.git_manager import git_manager


def utc_now() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"


@dataclass
class SnapshotResult:
    hash: str | None
    changed_files: list[str] = field(default_factory=list)
    message: str = ""
    skipped_reason: str | None = None


def create_snapshot(
    *,
    task: dict,
    workspace_root: Path,
    changed_files: Iterable[str] | None,
    message: str,
    agent: str,
    trigger_prompt: str = "",
    phase: str = "tool_batch",
    iteration: int | None = None,
) -> SnapshotResult:
    files = sorted({str(item).replace("\\", "/").lstrip("/") for item in (changed_files or []) if str(item).strip()})
    if not files:
        return SnapshotResult(None, [], message, "no changed files")

    metadata = {
        "autocode_snapshot": True,
        "task_id": task.get("id"),
        "task_title": task.get("title"),
        "agent": agent,
        "phase": phase,
        "iteration": iteration,
        "trigger_prompt": trigger_prompt[:1000],
        "changed_files": files[:100],
        "created_at": utc_now(),
    }
    base_message = message.strip() or "AutoCode snapshot"
    if "Autocode-Metadata:" in base_message:
        full_message = base_message
    else:
        full_message = f"{base_message}\n\nAutocode-Metadata: {json.dumps(metadata, ensure_ascii=False)}"
    commit_hash = git_manager.auto_commit(workspace_root, files or ["."], full_message)
    if not commit_hash:
        return SnapshotResult(None, files, message, "empty git commit")

    snapshot = {
        "hash": commit_hash,
        "agent": agent,
        "phase": phase,
        "iteration": iteration,
        "trigger_prompt": trigger_prompt[:500],
        "changed_files": files[:100],
        "created_at": metadata["created_at"],
        "message": message,
    }
    task.setdefault("auto_snapshots", []).append(snapshot)
    task["auto_snapshots"] = task["auto_snapshots"][-100:]
    task["commit_history"] = git_manager.log(workspace_root, max_count=30)
    return SnapshotResult(commit_hash, files, message)
