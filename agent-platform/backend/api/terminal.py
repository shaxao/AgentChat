# -*- coding: utf-8 -*-
"""Terminal WebSocket API."""

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from api.workspace_security import find_task_by_workspace
from services.terminal_manager import terminal_manager

router = APIRouter()


class TerminalInput(BaseModel):
    data: str


class ResizePayload(BaseModel):
    cols: int
    rows: int


@router.websocket("/{workspace_id}")
async def terminal_websocket(ws: WebSocket, workspace_id: str):
    """Attach the browser terminal to the current user's workspace session."""
    task = find_task_by_workspace(workspace_id)
    if not task:
        await ws.close(code=1008)
        return

    task_user_id = task.get("user_id")
    request_user_id = ws.headers.get("x-user-id") or ws.query_params.get("user_id")
    if task_user_id and str(task_user_id) != str(request_user_id or ""):
        await ws.close(code=1008)
        return

    await terminal_manager.connect(ws, workspace_id)
    try:
        while True:
            raw = await ws.receive_text()
            if raw.startswith("\x1b[") and "R" in raw:
                continue
            await terminal_manager.handle_input(workspace_id, raw)
    except WebSocketDisconnect:
        await terminal_manager.disconnect(workspace_id)
