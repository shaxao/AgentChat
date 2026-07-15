# -*- coding: utf-8 -*-
"""
智能模型路由管理 API — 路由规则 CRUD + 统计看板

端点:
  GET    /api/routing/rules          — 查询路由规则（支持过滤）
  POST   /api/routing/rules          — 新增规则
  PUT    /api/routing/rules/{id}     — 更新规则
  DELETE /api/routing/rules/{id}     — 删除规则
  GET    /api/routing/stats          — 路由统计（候选模型、熔断状态）
  POST   /api/routing/test           — 测试路由（给定场景返回推荐模型）
"""
import json
import logging
from typing import Optional

import pymysql
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field
from pymysql.cursors import DictCursor

from core.config import settings
from core.model_router import (
    ModelRouter, TaskContext, model_router, failure_tracker,
)

logger = logging.getLogger("autocode.api.routing")

router = APIRouter()


# ═══════════════════════════════════════════════════════════════
# 数据模型
# ═══════════════════════════════════════════════════════════════

class RoutingRuleCreate(BaseModel):
    agent_type: str = Field(default="*", description="Agent 类型: frontend/backend/devops/researcher/*")
    task_phase: str = Field(default="*", description="任务阶段: planning/implementation/debugging/review/deployment/*")
    content_type: str = Field(default="*", description="内容类型: text/code/image/file/*")
    complexity: str = Field(default="*", description="复杂度: simple/moderate/complex/*")
    model_id: str = Field(..., description="模型 ID（对应 model_config.model_id）")
    priority: int = Field(default=100, ge=1, le=200, description="优先级 (1-200)")
    weight_bonus: float = Field(default=0.00, ge=0.0, le=1.0, description="场景亲和度加成 (0-1)")
    failover_order: int = Field(default=0, ge=0, description="故障转移优先级 (0=不使用)")
    enabled: bool = Field(default=True)


class RoutingRuleUpdate(BaseModel):
    agent_type: Optional[str] = None
    task_phase: Optional[str] = None
    content_type: Optional[str] = None
    complexity: Optional[str] = None
    model_id: Optional[str] = None
    priority: Optional[int] = None
    weight_bonus: Optional[float] = None
    failover_order: Optional[int] = None
    enabled: Optional[bool] = None


class RouteTestRequest(BaseModel):
    agent_type: str = Field(default="frontend", description="Agent 类型")
    task_phase: str = Field(default="implementation", description="任务阶段")
    content_types: list[str] = Field(default=["code"], description="内容类型列表")
    complexity: str = Field(default="moderate", description="复杂度")
    required_capabilities: list[str] = Field(default=["tool"], description="所需能力")


# ═══════════════════════════════════════════════════════════════
# 数据库帮助函数
# ═══════════════════════════════════════════════════════════════

def _get_conn():
    return pymysql.connect(
        host=settings.muhugochat_db_host,
        port=settings.muhugochat_db_port,
        user=settings.muhugochat_db_user,
        password=settings.muhugochat_db_password,
        database=settings.muhugochat_db_name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        connect_timeout=5,
    )


# ═══════════════════════════════════════════════════════════════
# 路由规则 CRUD
# ═══════════════════════════════════════════════════════════════

@router.get("/rules")
async def list_rules(
    agent_type: Optional[str] = Query(None, description="按 Agent 类型过滤"),
    task_phase: Optional[str] = Query(None, description="按任务阶段过滤"),
    content_type: Optional[str] = Query(None, description="按内容类型过滤"),
    complexity: Optional[str] = Query(None, description="按复杂度过滤"),
    model_id: Optional[str] = Query(None, description="按模型 ID 过滤"),
    enabled: Optional[bool] = Query(None, description="是否启用"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
):
    """
    查询路由规则列表，支持多条件过滤和分页。

    示例:
      GET /api/routing/rules?agent_type=frontend&complexity=complex
      GET /api/routing/rules?enabled=true&page=1&page_size=20
    """
    conn = None
    try:
        conn = _get_conn()
        with conn.cursor() as cursor:
            # 构建动态查询
            conditions = ["1=1"]
            params = []

            if agent_type:
                conditions.append("agent_type = %s")
                params.append(agent_type)
            if task_phase:
                conditions.append("task_phase = %s")
                params.append(task_phase)
            if content_type:
                conditions.append("content_type = %s")
                params.append(content_type)
            if complexity:
                conditions.append("complexity = %s")
                params.append(complexity)
            if model_id:
                conditions.append("model_id = %s")
                params.append(model_id)
            if enabled is not None:
                conditions.append("enabled = %s")
                params.append(1 if enabled else 0)

            where = " AND ".join(conditions)

            # 计数
            cursor.execute(f"SELECT COUNT(*) as total FROM autocode_model_routing WHERE {where}", params)
            total = cursor.fetchone()["total"]

            # 分页查询
            offset = (page - 1) * page_size
            cursor.execute(
                f"""SELECT * FROM autocode_model_routing
                   WHERE {where}
                   ORDER BY
                     (CASE WHEN agent_type != '*' THEN 1 ELSE 0 END) +
                     (CASE WHEN task_phase != '*' THEN 1 ELSE 0 END) +
                     (CASE WHEN content_type != '*' THEN 1 ELSE 0 END) +
                     (CASE WHEN complexity != '*' THEN 1 ELSE 0 END) DESC,
                     priority DESC, weight_bonus DESC, id ASC
                   LIMIT %s OFFSET %s""",
                params + [page_size, offset],
            )
            rows = cursor.fetchall()

            # 转换 datetime 为字符串
            for row in rows:
                for key in ("created_at", "updated_at"):
                    if row.get(key):
                        row[key] = row[key].strftime("%Y-%m-%d %H:%M:%S")

            return {
                "success": True,
                "data": rows,
                "pagination": {
                    "page": page,
                    "page_size": page_size,
                    "total": total,
                    "total_pages": (total + page_size - 1) // page_size,
                },
            }

    except Exception as e:
        logger.error(f"[Routing API] 查询规则失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.post("/rules")
async def create_rule(rule: RoutingRuleCreate):
    """创建新的路由规则"""
    conn = None
    try:
        conn = _get_conn()
        with conn.cursor() as cursor:
            cursor.execute(
                """INSERT INTO autocode_model_routing
                   (agent_type, task_phase, content_type, complexity,
                    model_id, priority, weight_bonus, failover_order, enabled)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (
                    rule.agent_type,
                    rule.task_phase,
                    rule.content_type,
                    rule.complexity,
                    rule.model_id,
                    rule.priority,
                    rule.weight_bonus,
                    rule.failover_order,
                    1 if rule.enabled else 0,
                ),
            )
            conn.commit()
            new_id = cursor.lastrowid

        # 清除路由缓存
        model_router._routing_cache.clear()

        return {
            "success": True,
            "data": {"id": new_id, **rule.model_dump()},
            "message": "路由规则创建成功",
        }

    except Exception as e:
        logger.error(f"[Routing API] 创建规则失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: int, updates: RoutingRuleUpdate):
    """更新路由规则（部分更新）"""
    conn = None
    try:
        conn = _get_conn()
        with conn.cursor() as cursor:
            # 检查是否存在
            cursor.execute("SELECT id FROM autocode_model_routing WHERE id = %s", (rule_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="路由规则不存在")

            # 构建 SET 子句
            set_parts = []
            params = []
            update_fields = updates.model_dump(exclude_unset=True)

            field_map = {
                "agent_type": "agent_type",
                "task_phase": "task_phase",
                "content_type": "content_type",
                "complexity": "complexity",
                "model_id": "model_id",
                "priority": "priority",
                "weight_bonus": "weight_bonus",
                "failover_order": "failover_order",
                "enabled": "enabled",
            }

            for py_field, value in update_fields.items():
                db_field = field_map.get(py_field, py_field)
                if db_field == "enabled":
                    value = 1 if value else 0
                set_parts.append(f"{db_field} = %s")
                params.append(value)

            if not set_parts:
                raise HTTPException(status_code=400, detail="没有提供更新字段")

            params.append(rule_id)
            cursor.execute(
                f"UPDATE autocode_model_routing SET {', '.join(set_parts)} WHERE id = %s",
                params,
            )
            conn.commit()

        # 清除路由缓存
        model_router._routing_cache.clear()

        return {
            "success": True,
            "message": f"路由规则 #{rule_id} 更新成功",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Routing API] 更新规则失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


@router.delete("/rules/{rule_id}")
async def delete_rule(rule_id: int):
    """删除路由规则"""
    conn = None
    try:
        conn = _get_conn()
        with conn.cursor() as cursor:
            cursor.execute("SELECT id FROM autocode_model_routing WHERE id = %s", (rule_id,))
            if not cursor.fetchone():
                raise HTTPException(status_code=404, detail="路由规则不存在")

            cursor.execute("DELETE FROM autocode_model_routing WHERE id = %s", (rule_id,))
            conn.commit()

        # 清除路由缓存
        model_router._routing_cache.clear()

        return {
            "success": True,
            "message": f"路由规则 #{rule_id} 已删除",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"[Routing API] 删除规则失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if conn:
            conn.close()


# ═══════════════════════════════════════════════════════════════
# 统计与诊断
# ═══════════════════════════════════════════════════════════════

@router.get("/stats")
async def routing_stats():
    """
    获取路由统计信息：
    - 熔断状态 (circuit_breaker)
    - 路由缓存概要
    - 规则总数
    """
    conn = None
    try:
        conn = _get_conn()

        with conn.cursor() as cursor:
            # 规则总数
            cursor.execute("SELECT COUNT(*) as total FROM autocode_model_routing WHERE enabled = 1")
            total_rules = cursor.fetchone()["total"]

            # 按 agent_type 分组
            cursor.execute(
                """SELECT agent_type, COUNT(*) as cnt
                   FROM autocode_model_routing WHERE enabled = 1
                   GROUP BY agent_type ORDER BY cnt DESC"""
            )
            by_agent = {row["agent_type"]: row["cnt"] for row in cursor.fetchall()}

            # 按 model_id 分组
            cursor.execute(
                """SELECT model_id, COUNT(*) as cnt
                   FROM autocode_model_routing WHERE enabled = 1
                   GROUP BY model_id ORDER BY cnt DESC"""
            )
            by_model = {row["model_id"]: row["cnt"] for row in cursor.fetchall()}

        # 熔断状态
        breaker_stats = failure_tracker.get_stats()

        return {
            "success": True,
            "data": {
                "rules": {
                    "total": total_rules,
                    "by_agent_type": by_agent,
                    "by_model": by_model,
                },
                "circuit_breaker": {
                    "broken": breaker_stats.get("circuit_broken", {}),
                    "failure_counts": breaker_stats.get("failure_counts", {}),
                },
                "cache": {
                    "entries": len(model_router._routing_cache),
                },
            },
        }

    except Exception as e:
        logger.error(f"[Routing API] 统计查询失败: {e}")
        # 即使数据库查询失败，仍然返回熔断信息
        return {
            "success": True,
            "data": {
                "rules": {"total": 0, "by_agent_type": {}, "by_model": {}},
                "circuit_breaker": {
                    "broken": failure_tracker.get_stats().get("circuit_broken", {}),
                    "failure_counts": failure_tracker.get_stats().get("failure_counts", {}),
                },
                "cache": {"entries": len(model_router._routing_cache)},
            },
        }
    finally:
        if conn:
            conn.close()


@router.get("/stats/candidates")
async def list_candidates():
    """
    获取所有候选模型及其元数据（用于前端配置参考）。
    包含代码质量评分、擅长的 strengths、价格等。
    """
    try:
        from services.channel_service import fetch_all_channels, fetch_models_with_capability

        channels = fetch_all_channels()
        models = fetch_models_with_capability(min_context_length=0)

        channel_by_model = {}
        for ch in channels:
            if not ch.models:
                continue
            for m in ch.models:
                channel_by_model[m] = {
                    "provider": ch.provider,
                    "channel_name": ch.name,
                    "tags": ch.tags,
                }

        candidates = []
        for mi in models:
            ch_info = channel_by_model.get(mi.model_id) or channel_by_model.get(mi.name)
            if not ch_info:
                for m_key, ch_val in channel_by_model.items():
                    if mi.model_id in m_key or m_key in mi.model_id:
                        ch_info = ch_val
                        break

            is_available = failure_tracker.is_available(mi.model_id)
            fail_count = len(failure_tracker._failures.get(mi.model_id, []))

            candidates.append({
                "id": mi.id,
                "model_id": mi.model_id,
                "name": mi.name or mi.model_id,
                "provider": ch_info["provider"] if ch_info else "",
                "channel_name": ch_info["channel_name"] if ch_info else "",
                "capabilities": mi.capabilities,
                "strengths": mi.strengths,
                "code_quality": mi.code_quality,
                "input_price": mi.input_price,
                "output_price": mi.output_price,
                "context_length": mi.context_length,
                "status": {
                    "available": is_available,
                    "failures": fail_count,
                },
            })

        candidates.sort(key=lambda c: c["code_quality"], reverse=True)

        return {
            "success": True,
            "data": candidates,
            "total": len(candidates),
        }

    except Exception as e:
        logger.error(f"[Routing API] 获取候选模型失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/stats/reset-circuit-breaker")
async def reset_circuit_breaker(model_id: Optional[str] = None):
    """
    强制重置熔断状态。

    参数:
      model_id: 指定模型 ID（不指定则重置全部）
    """
    failure_tracker.force_reset(model_id)
    if model_id:
        return {"success": True, "message": f"已重置 {model_id} 的熔断状态"}
    return {"success": True, "message": "已重置所有模型的熔断状态"}


# ═══════════════════════════════════════════════════════════════
# 路由测试（模拟）
# ═══════════════════════════════════════════════════════════════

@router.post("/test")
async def test_route(req: RouteTestRequest):
    """
    测试路由：给定一个场景，返回评分最高的推荐模型列表。

    示例:
      POST /api/routing/test
      {
        "agent_type": "frontend",
        "task_phase": "implementation",
        "content_types": ["code"],
        "complexity": "complex",
        "required_capabilities": ["tool", "code"]
      }
    """
    try:
        ctx = TaskContext(
            agent_type=req.agent_type,
            task_phase=req.task_phase,
            content_types=req.content_types,
            complexity=req.complexity,
            required_capabilities=req.required_capabilities,
        )

        candidates = await model_router.select(ctx)

        result = []
        for i, c in enumerate(candidates[:10]):  # 最多返回 10 个
            result.append({
                "rank": i + 1,
                "model_id": c.model_id,
                "provider": c.provider,
                "api_key": c.api_key[:8] + "***" if c.api_key else "",
                "score": c.score,
                "score_detail": c.score_detail,
                "code_quality": c.code_quality,
                "input_price": c.input_price,
                "capabilities": c.capabilities,
                "strengths": c.strengths,
                "context_length": c.context_length,
                "weight_bonus": c.weight_bonus,
                "failover_order": c.failover_order,
                "available": failure_tracker.is_available(c.model_id),
            })

        return {
            "success": True,
            "data": {
                "context": req.model_dump(),
                "candidates": result,
                "total": len(candidates),
            },
        }

    except Exception as e:
        logger.error(f"[Routing API] 路由测试失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
