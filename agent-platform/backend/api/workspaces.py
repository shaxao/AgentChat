# -*- coding: utf-8 -*-
"""Workspace 管理 API"""
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.docker_manager import docker_manager
from core.config import get_settings
from schemas.task import WorkspaceCreate, WorkspaceResponse
from api.workspace_security import verify_workspace_access

router = APIRouter()
_workspaces: dict[str, dict] = {}


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(payload: WorkspaceCreate):
    ws_id = f"ws-{uuid.uuid4().hex[:12]}"
    result = await docker_manager.create_workspace(ws_id, payload.project_type)
    result["created_at"] = datetime.utcnow().isoformat()
    _workspaces[ws_id] = result
    return WorkspaceResponse(**result)


@router.get("")
async def list_workspaces():
    return list(_workspaces.values())


@router.get("/{workspace_id}")
async def get_workspace(workspace_id: str):
    if workspace_id not in _workspaces:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return _workspaces[workspace_id]


@router.delete("/{workspace_id}")
async def destroy_workspace(workspace_id: str):
    if workspace_id not in _workspaces:
        raise HTTPException(status_code=404, detail="Workspace not found")
    await docker_manager.destroy_workspace(workspace_id)
    del _workspaces[workspace_id]
    return {"ok": True}


# ─── SPEC.md 规范文件 ─────────────────────────────────────────────

@router.get("/{workspace_id}/spec/template")
async def get_spec_template(workspace_id: str, project_name: str = ""):
    """返回 SPEC.md 模板"""
    from core.spec_manager import get_default_spec
    return {"content": get_default_spec(project_name or workspace_id)}


@router.get("/{workspace_id}/spec")
async def get_spec(workspace_id: str, request: Request):
    """读取 SPEC.md"""
    ws_path, _ = verify_workspace_access(workspace_id, request)

    from core.spec_manager import read_spec
    content = read_spec(ws_path)
    return {
        "content": content,
        "has_spec": content is not None,
        "workspace_id": workspace_id,
    }


@router.put("/{workspace_id}/spec")
async def update_spec(workspace_id: str, body: dict, request: Request):
    """保存 SPEC.md"""
    ws_path, _ = verify_workspace_access(workspace_id, request)
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="content 不能为空")

    from core.spec_manager import write_spec
    success = write_spec(ws_path, content)
    if not success:
        raise HTTPException(status_code=500, detail="写入失败")
    return {"ok": True, "workspace_id": workspace_id}
