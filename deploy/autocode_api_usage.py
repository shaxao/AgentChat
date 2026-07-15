# -*- coding: utf-8 -*-
"""
用量查询 API — 计费仪表盘数据源

端点:
  GET  /api/usage/stats          — 用户级用量汇总
  GET  /api/usage/logs           — 分页用量明细
  GET  /api/usage/models         — 使用的模型列表
  GET  /api/usage/daily          — 按日汇总
"""
import logging
from datetime import date, datetime
from typing import Optional

import pymysql
from fastapi import APIRouter, Query
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.api.usage")

router = APIRouter()


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


@router.get("/stats")
async def usage_stats(
    user_id: Optional[str] = Query(None, description="按用户过滤"),
    days: int = Query(30, ge=1, le=365, description="统计最近 N 天"),
):
    """按模型维度汇总用量"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            where = "WHERE created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)"
            params = [days]
            if user_id:
                where += " AND user_id = %s"
                params.append(user_id)

            cur.execute(f"""
                SELECT
                    model,
                    scene_type,
                    COUNT(*) AS request_count,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
                    SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS fail_count,
                    SUM(input_tokens) AS total_input_tokens,
                    SUM(cached_input_tokens) AS total_cached_input_tokens,
                    SUM(output_tokens) AS total_output_tokens,
                    SUM(input_tokens + output_tokens) AS total_tokens,
                    ROUND(AVG(latency_ms), 0) AS avg_latency_ms,
                    MAX(latency_ms) AS max_latency_ms
                FROM autocode_usage_logs
                {where}
                GROUP BY model, scene_type
                ORDER BY total_tokens DESC
            """, params)
            rows = cur.fetchall()

        grand_total = {
            "total_requests": sum(r["request_count"] for r in rows),
            "total_tokens": sum(r["total_tokens"] for r in rows),
            "total_success": sum(r["success_count"] for r in rows),
            "total_fail": sum(r["fail_count"] for r in rows),
        }

        return {
            "models": rows,
            "summary": grand_total,
            "period_days": days,
        }
    finally:
        conn.close()


@router.get("/logs")
async def usage_logs(
    user_id: Optional[str] = Query(None),
    model: Optional[str] = Query(None),
    task_id: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=200),
    days: int = Query(30, ge=1, le=365),
):
    """分页查询用量明细记录"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            conditions = ["created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)"]
            params = [days]

            if user_id:
                conditions.append("user_id = %s")
                params.append(user_id)
            if model:
                conditions.append("model = %s")
                params.append(model)
            if task_id:
                conditions.append("task_id = %s")
                params.append(task_id)
            if status:
                conditions.append("status = %s")
                params.append(status)

            where = "WHERE " + " AND ".join(conditions)

            cur.execute(f"SELECT COUNT(*) AS cnt FROM autocode_usage_logs {where}", params)
            total = cur.fetchone()["cnt"]

            offset = (page - 1) * page_size
            cur.execute(f"""
                SELECT id, user_id, task_id, agent_id, model, scene_type,
                       input_tokens, cached_input_tokens, output_tokens,
                       latency_ms, status, error_msg, created_at
                FROM autocode_usage_logs
                {where}
                ORDER BY created_at DESC
                LIMIT %s OFFSET %s
            """, params + [page_size, offset])
            rows = cur.fetchall()

        for r in rows:
            if isinstance(r["created_at"], datetime):
                r["created_at"] = r["created_at"].isoformat()

        return {
            "list": rows,
            "total": total,
            "page": page,
            "page_size": page_size,
        }
    finally:
        conn.close()


@router.get("/models")
async def usage_models():
    """返回曾经使用过的模型列表"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT model, COUNT(*) AS cnt
                FROM autocode_usage_logs
                GROUP BY model
                ORDER BY cnt DESC
                LIMIT 50
            """)
            rows = cur.fetchall()
        return rows
    finally:
        conn.close()


@router.get("/daily")
async def usage_daily(
    user_id: Optional[str] = Query(None),
    days: int = Query(30, ge=1, le=90),
):
    """按天汇总的用量趋势数据"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            where = "WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL %s DAY)"
            params = [days]
            if user_id:
                where += " AND user_id = %s"
                params.append(user_id)

            cur.execute(f"""
                SELECT
                    DATE(created_at) AS stat_date,
                    COUNT(*) AS request_count,
                    SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
                    SUM(input_tokens + output_tokens) AS total_tokens,
                    ROUND(AVG(latency_ms), 0) AS avg_latency_ms
                FROM autocode_usage_logs
                {where}
                GROUP BY stat_date
                ORDER BY stat_date ASC
            """, params)
            rows = cur.fetchall()

        for r in rows:
            if isinstance(r["stat_date"], (date, datetime)):
                r["stat_date"] = r["stat_date"].isoformat()

        return {
            "daily": rows,
            "days": days,
        }
    finally:
        conn.close()
