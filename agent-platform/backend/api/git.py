# -*- coding: utf-8 -*-
"""Git 操作 API — 基于 GitPython"""
import asyncio
import re
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from core.git_manager import git_manager
from schemas.task import GitCommit
from api.workspace_security import verify_workspace_access

router = APIRouter(prefix="/workspaces/{workspace_id}", tags=["Git"])


def _ws_path(workspace_id: str, request: Request) -> Path:
    ws, _ = verify_workspace_access(workspace_id, request)
    return ws


@router.post("/init")
async def init_repo(workspace_id: str, request: Request):
    ws = _ws_path(workspace_id, request)
    ws.mkdir(parents=True, exist_ok=True)
    git_manager.init(ws)
    return {"ok": True, "workspace_id": workspace_id}


@router.get("/log", response_model=list[GitCommit])
async def get_log(
    workspace_id: str,
    request: Request,
    limit: int = Query(default=20, le=100),
):
    ws = _ws_path(workspace_id, request)
    commits = await asyncio.to_thread(git_manager.log, ws, limit)
    return [GitCommit(**c) for c in commits]


@router.get("/status")
async def get_status(workspace_id: str, request: Request):
    ws = _ws_path(workspace_id, request)
    return await asyncio.to_thread(git_manager.status, ws)


@router.get("/diff-working")
async def get_working_diff(
    workspace_id: str,
    request: Request,
    staged: bool = Query(default=False),
):
    ws = _ws_path(workspace_id, request)
    try:
        diff = await asyncio.to_thread(git_manager.working_diff, ws, staged)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Working diff failed: {e}") from e
    return {"diff": diff}


@router.get("/diff/{commit_hash}")
async def get_diff(workspace_id: str, commit_hash: str, request: Request):
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit_hash):
        raise HTTPException(status_code=400, detail="Invalid commit hash")
    ws = _ws_path(workspace_id, request)
    try:
        diff = await asyncio.to_thread(git_manager.diff, ws, commit_hash)
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Commit diff not available: {commit_hash}") from e
    return {"diff": diff}


@router.post("/checkout/{commit_hash}")
async def checkout(workspace_id: str, commit_hash: str, request: Request):
    if not re.fullmatch(r"[0-9a-fA-F]{7,40}", commit_hash):
        raise HTTPException(status_code=400, detail="Invalid commit hash")
    ws = _ws_path(workspace_id, request)
    await asyncio.to_thread(git_manager.checkout, ws, commit_hash)
    return {"ok": True, "commit": commit_hash}


@router.get("/files")
async def list_files(workspace_id: str, request: Request, commit_hash: Optional[str] = None):
    ws = _ws_path(workspace_id, request)
    files = await asyncio.to_thread(git_manager.list_files, ws, commit_hash)
    return {"files": files}


@router.post("/commit")
async def create_commit(workspace_id: str, message: str, request: Request):
    ws = _ws_path(workspace_id, request)
    hash_ = await asyncio.to_thread(git_manager.commit, ws, message)
    return {"ok": True, "commit": hash_}
