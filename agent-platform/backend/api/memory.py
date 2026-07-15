# -*- coding: utf-8 -*-
"""跨任务记忆召回 API — 将 MemoryService.recall() 暴露给前端。

端点：
    GET /api/memory/search?q=...&scope=...&scope_id=...&limit=...&layer=...

- layer=cold（默认）：调用 recall() → MySQL FULLTEXT(ngram) 检索 L3 冷记忆库（跨任务语义召回）。
- layer=warm        ：跨任务检索 L2 温记忆（仅 public/project，或当前用户自己的个人/敏感记忆）。
- layer=all         ：合并 cold + warm，按 score 降序返回。
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Query, Request

from services.memory_service import memory_service, search_warm
from api.workspace_security import request_user_id

router = APIRouter()  # prefix 由 main.py 统一添加


@router.get("/search")
async def memory_search(
    request: Request,
    q: str = Query(..., min_length=1, description="检索关键词或自然语言片段"),
    scope: Optional[str] = Query(None, description="作用域过滤: task|user|project|global"),
    scope_id: Optional[str] = Query(None, description="作用域 ID 过滤，如 task_id"),
    limit: int = Query(10, ge=1, le=50, description="返回条数上限"),
    layer: str = Query("cold", description="cold=L3冷记忆召回 | warm=L2温记忆 | all=两者合并"),
):
    """
    跨任务记忆召回。所有读写均优雅降级（MySQL/Redis 不可用时返回空或内存回退结果）。
    """
    if layer not in ("cold", "warm", "all"):
        layer = "cold"

    if layer == "warm":
        uid = request_user_id(request)
        results = search_warm(q, scope=scope, scope_id=scope_id, limit=limit, user_id=uid)
        for r in results:
            r.setdefault("layer", "warm")
        return {"query": q, "layer": "warm", "count": len(results), "results": results}

    if layer == "all":
        uid = request_user_id(request)
        merged = memory_service.recall_all(q, scope=scope, scope_id=scope_id, limit=limit, user_id=uid)
        return {"query": q, "layer": "all", "count": len(merged), "results": merged}

    # 默认 cold —— 直接暴露 recall()
    results = memory_service.recall(q, scope=scope, scope_id=scope_id, limit=limit)
    for r in results:
        r.setdefault("layer", "cold")
    return {"query": q, "layer": "cold", "count": len(results), "results": results}
