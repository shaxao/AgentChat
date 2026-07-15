# -*- coding: utf-8 -*-
"""Shared workspace access checks for AutoCode APIs."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

from fastapi import HTTPException, Request

from core.config import get_settings
from core.state import _tasks


_WORKSPACE_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{2,80}$")


def request_user_id(request: Request) -> Optional[str]:
    user_id = request.headers.get("X-User-Id")
    if user_id and user_id.strip():
        return user_id.strip()
    for key in ("user_id", "userId"):
        value = request.query_params.get(key)
        if value and value.strip():
            return value.strip()
    referer = request.headers.get("referer") or request.headers.get("referrer") or ""
    if referer:
        parsed = parse_qs(urlparse(referer).query)
        for key in ("user_id", "userId"):
            values = parsed.get(key)
            if values and values[0].strip():
                return values[0].strip()
    return None


def find_task_by_workspace(workspace_id: str) -> Optional[dict]:
    for task in _tasks.values():
        if str(task.get("workspace_id") or "") == workspace_id:
            return task
    return None


def verify_workspace_access(
    workspace_id: str,
    request: Request,
    *,
    require_task_binding: bool = True,
) -> tuple[Path, Optional[dict]]:
    """Return the workspace path after checking id shape, existence and ownership."""
    if not _WORKSPACE_ID_RE.match(workspace_id or ""):
        raise HTTPException(status_code=400, detail="Invalid workspace id")

    task = find_task_by_workspace(workspace_id)
    if require_task_binding and not task:
        raise HTTPException(status_code=404, detail="Workspace is not bound to a task")

    if task and task.get("user_id"):
        current_user = request_user_id(request)
        if not current_user:
            raise HTTPException(status_code=401, detail="Not logged in")
        if str(task.get("user_id")) != str(current_user):
            raise HTTPException(status_code=403, detail="No permission for this workspace")

    root = (get_settings().workspace_base_dir / workspace_id).resolve()
    if not root.exists():
        raise HTTPException(status_code=404, detail="Workspace not found")
    return root, task


def verify_workspace_user(
    workspace_id: str,
    user_id: Optional[str],
    *,
    require_task_binding: bool = True,
) -> tuple[Path, Optional[dict]]:
    """Workspace access check for WebSocket routes that do not have Request."""
    if not _WORKSPACE_ID_RE.match(workspace_id or ""):
        raise HTTPException(status_code=400, detail="Invalid workspace id")

    task = find_task_by_workspace(workspace_id)
    if require_task_binding and not task:
        raise HTTPException(status_code=404, detail="Workspace is not bound to a task")

    if task and task.get("user_id"):
        if not user_id:
            raise HTTPException(status_code=401, detail="Not logged in")
        if str(task.get("user_id")) != str(user_id):
            raise HTTPException(status_code=403, detail="No permission for this workspace")

    root = (get_settings().workspace_base_dir / workspace_id).resolve()
    if not root.exists():
        raise HTTPException(status_code=404, detail="Workspace not found")
    return root, task


def safe_child_path(root: Path, rel_path: str = "") -> Path:
    """Resolve a path under root and reject traversal."""
    rel = (rel_path or "").replace("\\", "/").lstrip("/")
    target = (root / rel).resolve()
    if root not in (target, *target.parents):
        raise HTTPException(status_code=403, detail="Path traversal blocked")
    return target
