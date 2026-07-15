# -*- coding: utf-8 -*-
"""Dev Server API — Workspace 内置开发服务器管理"""
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from core.docker_manager import docker_manager
from services.dev_server_manager import dev_server_manager
from api.workspace_security import verify_workspace_access

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["DevServer"])


class DevServerStartRequest(BaseModel):
    project_type: str | None = None


class DevServerResponse(BaseModel):
    workspace_id: str
    port: int
    url: str | None
    status: str


@router.post("/dev-server/start", response_model=DevServerResponse)
async def start_dev_server(workspace_id: str, request: Request, body: DevServerStartRequest | None = None):
    """在指定 Workspace 启动开发服务器（npm run dev 等）"""
    ws_path, _ = verify_workspace_access(workspace_id, request)

    project_type = body.project_type if body else None
    result = await dev_server_manager.start_dev_server(workspace_id, str(ws_path), project_type)

    if not result:
        raise HTTPException(status_code=500, detail="Dev server start failed")

    return DevServerResponse(
        workspace_id=workspace_id,
        port=result["port"],
        url=result.get("url"),
        status=result["status"],
    )


@router.post("/dev-server/stop")
async def stop_dev_server(workspace_id: str, request: Request):
    """停止开发服务器"""
    verify_workspace_access(workspace_id, request)
    ok = await dev_server_manager.stop_dev_server(workspace_id)
    return {"ok": ok}


@router.get("/dev-server", response_model=DevServerResponse | None)
async def get_dev_server(workspace_id: str, request: Request):
    """查询 dev server 状态"""
    verify_workspace_access(workspace_id, request)
    session = await dev_server_manager.get_session(workspace_id)
    if not session:
        return None
    return DevServerResponse(
        workspace_id=workspace_id,
        port=session.port,
        url=session.url,
        status=session.status,
    )


@router.get("/dev-server/list")
async def list_dev_servers():
    """列出所有 dev server 会话"""
    return await dev_server_manager.list_sessions()
