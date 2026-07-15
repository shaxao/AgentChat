# -*- coding: utf-8 -*-
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from services.cache_ledger_service import CacheLedgerEvent, cache_ledger_service


router = APIRouter()


class CacheEventRequest(BaseModel):
    cache_layer: str = Field(default="L0")
    cache_key: str = Field(default="")
    status: str = Field(default="miss")
    scene_type: str = Field(default="autocode")
    tenant_id: str = Field(default="")
    user_id: str = Field(default="")
    task_id: str = Field(default="")
    session_id: str = Field(default="")
    workspace_id: str = Field(default="")
    epoch: int = 0
    input_hash: str = Field(default="")
    hit_reason: str = Field(default="")
    miss_reason: str = Field(default="")
    invalidation_reason: str = Field(default="")
    model: str = Field(default="")
    provider: str = Field(default="")
    token_saved_estimate: int = 0
    latency_saved_ms: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    metadata: dict[str, Any] = Field(default_factory=dict)


class PromptContextRequest(BaseModel):
    tenant_id: str = ""
    user_id: str = ""
    session_id: str = ""
    model: str = ""
    provider: str = ""
    context_version: str = ""
    system_prompt: str = ""
    stable_context: dict[str, Any] | str | None = None


class SolutionRequest(BaseModel):
    fingerprint: str = ""
    scene_type: str = "autocode"
    tenant_id: str = ""
    user_id: str = ""
    title: str = ""
    tech_stack: str = ""
    error_excerpt: str = ""
    root_cause: str = ""
    patch_summary: str = ""
    validation_command: str = ""
    validation_result: str = ""
    risk_level: int = 1
    reuse_policy: str = "suggest"
    metadata: dict[str, Any] = Field(default_factory=dict)


class SolutionSearchRequest(BaseModel):
    query: str = ""
    fingerprint: str = ""
    scene_type: str = "autocode"
    tenant_id: str = ""
    limit: int = 5


@router.post("/events")
async def record_cache_event(req: CacheEventRequest):
    data = cache_ledger_service.record(CacheLedgerEvent(**req.model_dump()))
    return {"ok": True, "event": data}


@router.get("/stats")
async def cache_stats(
    scene_type: str = Query(default=""),
    user_id: str = Query(default=""),
    task_id: str = Query(default=""),
    hours: int = Query(default=24, ge=1, le=24 * 90),
):
    return cache_ledger_service.stats(
        scene_type=scene_type,
        user_id=user_id,
        task_id=task_id,
        hours=hours,
    )


@router.post("/prompt-context")
async def build_prompt_context(req: PromptContextRequest):
    return cache_ledger_service.stable_prompt_context(**req.model_dump())


@router.post("/solutions")
async def save_solution(req: SolutionRequest):
    return {"ok": True, "solution": cache_ledger_service.save_solution(req.model_dump())}


@router.post("/solutions/search")
async def search_solutions(req: SolutionSearchRequest):
    return {
        "ok": True,
        "solutions": cache_ledger_service.search_solutions(
            query=req.query,
            fingerprint=req.fingerprint,
            scene_type=req.scene_type,
            tenant_id=req.tenant_id,
            limit=req.limit,
        ),
    }


@router.post("/invalidate")
async def invalidate_cache(req: CacheEventRequest):
    data = req.model_dump()
    data["status"] = "stale"
    if not data.get("invalidation_reason"):
        data["invalidation_reason"] = data.get("miss_reason") or "manual_invalidate"
    event = cache_ledger_service.record(CacheLedgerEvent(**data))
    return {"ok": True, "event": event}
