# -*- coding: utf-8 -*-
"""
原型生成 API

POST /api/prototype/generate  — 根据描述生成 HTML 原型
POST /api/prototype/refine    — 迭代修改已有原型
GET  /api/prototype/{workspace_id} — 获取工作空间中的原型
"""
import uuid
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.config import settings
from core.prototype_generator import (
    generate_prototype,
    refine_prototype,
    save_prototype,
    load_prototype,
    save_prototype_record,
    list_prototype_records,
    load_prototype_record,
    set_active_prototype_record,
)
from api.workspace_security import verify_workspace_access

router = APIRouter(prefix="/api/prototype", tags=["Prototype"])


# ─── 请求/响应模型 ──────────────────────────────────────────────

class GenerateRequest(BaseModel):
    description: str = Field(..., description="UI 需求描述，如 '请生成一个登录页面，包含邮箱和密码输入框，渐变色背景'")
    workspace_id: str = Field(..., description="目标工作空间 ID")


class RefineRequest(BaseModel):
    workspace_id: str = Field(..., description="目标工作空间 ID")
    modification: str = Field(..., description="修改需求描述，如 '把按钮颜色改成蓝色'，'添加一个导航栏'")


class PrototypeResponse(BaseModel):
    ok: bool
    prototype_id: str = ""
    title: str = ""
    description: str = ""
    features: list[str] = []
    tech_notes: str = ""
    preview_url: str = ""
    html_preview: str = ""  # 前 2000 字符预览
    generated_at: str = ""


class PrototypeUpdateRequest(BaseModel):
    title: str = ""
    description: str = ""
    kind: str = "excalidraw"
    excalidraw: dict | None = None
    html: str | None = None
    features: list[str] = []
    tech_notes: str = ""


# ─── 端点 ───────────────────────────────────────────────────────

@router.get("/workspace/{workspace_id}/items")
async def api_list_prototypes(workspace_id: str, request: Request):
    """List all saved prototypes for a workspace."""
    workspace_path, _ = verify_workspace_access(workspace_id, request)
    return {"ok": True, "items": list_prototype_records(workspace_path)}


@router.get("/workspace/{workspace_id}/items/{prototype_id}")
async def api_get_prototype_record(workspace_id: str, prototype_id: str, request: Request):
    """Get one saved prototype and its editable content."""
    workspace_path, _ = verify_workspace_access(workspace_id, request)
    record = load_prototype_record(workspace_path, prototype_id)
    if not record:
        raise HTTPException(status_code=404, detail="Prototype not found")
    return {"ok": True, "item": record}


@router.post("/workspace/{workspace_id}/items/{prototype_id}/activate")
async def api_activate_prototype_record(workspace_id: str, prototype_id: str, request: Request):
    """Mark a saved prototype as the active design reference for future Agent work."""
    workspace_path, _ = verify_workspace_access(workspace_id, request)
    record = set_active_prototype_record(workspace_path, prototype_id)
    if not record:
        raise HTTPException(status_code=404, detail="Prototype not found")
    return {"ok": True, "item": record}


@router.put("/workspace/{workspace_id}/items/{prototype_id}")
async def api_update_prototype_record(workspace_id: str, prototype_id: str, req: PrototypeUpdateRequest, request: Request):
    """Update a saved prototype from the workspace UI prototype editor."""
    workspace_path, _ = verify_workspace_access(workspace_id, request)

    kind = req.kind if req.kind == "html" else "excalidraw"
    result = {
        "title": req.title,
        "description": req.description,
        "features": req.features,
        "tech_notes": req.tech_notes,
    }
    if kind == "html":
        result["html"] = req.html or ""
    else:
        result["excalidraw"] = req.excalidraw or {"type": "excalidraw", "version": 2, "elements": []}

    record = save_prototype_record(workspace_path, result, prototype_id=prototype_id, source="edit", kind=kind)
    loaded = load_prototype_record(workspace_path, record["id"]) or record
    return {"ok": True, "item": loaded}

@router.post("/generate", response_model=PrototypeResponse)
async def api_generate_prototype(req: GenerateRequest, request: Request):
    """
    根据自然语言描述生成 UI 原型 HTML，保存到 workspace 并返回预览 URL。
    """
    workspace_path, _ = verify_workspace_access(req.workspace_id, request)

    if not req.description.strip():
        raise HTTPException(status_code=400, detail="描述不能为空")

    try:
        result = await generate_prototype(req.description)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成原型失败: {str(e)}")

    html = result.get("html", "")
    if not html:
        raise HTTPException(status_code=500, detail="生成的 HTML 为空")

    # 保存到 workspace
    save_prototype(workspace_path, html)
    record = save_prototype_record(workspace_path, result, source="manual", kind="html")

    # 构建预览 URL
    preview_url = record.get("preview_url") or f"/workspaces/{req.workspace_id}/preview/.autocode/prototype/index.html"

    now = datetime.utcnow().isoformat()

    return PrototypeResponse(
        ok=True,
        prototype_id=record["id"],
        title=result.get("title", "UI 原型"),
        description=result.get("description", ""),
        features=result.get("features", []),
        tech_notes=result.get("tech_notes", ""),
        preview_url=preview_url,
        html_preview=html[:2000],
        generated_at=now,
    )


@router.post("/refine", response_model=PrototypeResponse)
async def api_refine_prototype(req: RefineRequest, request: Request):
    """
    迭代修改已有的原型。读取当前原型，根据修改需求生成新版本。
    """
    workspace_path, _ = verify_workspace_access(req.workspace_id, request)

    current = load_prototype(workspace_path)
    if not current:
        raise HTTPException(status_code=404, detail="该工作空间中没有原型，请先生成")

    try:
        result = await refine_prototype(current["html"], req.modification)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"修改原型失败: {str(e)}")

    html = result.get("html", "")
    if not html:
        raise HTTPException(status_code=500, detail="修改后的 HTML 为空")

    # 保存新版本
    save_prototype(workspace_path, html)
    record = save_prototype_record(workspace_path, result, source="refine", kind="html")

    preview_url = record.get("preview_url") or f"/workspaces/{req.workspace_id}/preview/.autocode/prototype/index.html"

    now = datetime.utcnow().isoformat()

    return PrototypeResponse(
        ok=True,
        prototype_id=record["id"],
        title=result.get("title", "UI 原型"),
        description=result.get("description", ""),
        features=result.get("features", []),
        tech_notes=result.get("tech_notes", ""),
        preview_url=preview_url,
        html_preview=html[:2000],
        generated_at=now,
    )


@router.get("/{workspace_id}")
async def api_get_prototype(workspace_id: str, request: Request):
    """
    获取工作空间中的当前原型状态。
    """
    workspace_path, _ = verify_workspace_access(workspace_id, request)

    current = load_prototype(workspace_path)

    if not current:
        return {"ok": True, "exists": False}

    preview_url = f"/workspaces/{workspace_id}/preview/.autocode/prototype/index.html"

    return {
        "ok": True,
        "exists": True,
        "title": current["title"],
        "html": current["html"],
        "html_preview": current["html"][:2000],
        "preview_url": preview_url,
        "generated_at": current["generated_at"],
    }

