# -*- coding: utf-8 -*-
"""
执行日志 API — 任务执行记录查询

端点:
  GET  /api/logs               — 分页执行日志
  GET  /api/logs/{task_id}     — 按任务查询日志
  GET  /api/logs/summary/tasks — 近期任务汇总
"""
import logging
from datetime import datetime
from typing import Optional

import pymysql
from fastapi import APIRouter, Query
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.api.logs")

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


@router.get("")
async def execution_logs(
    user_id: Optional[str] = Query(None),
    task_id: Optional[str] = Query(None),
    level: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(30, ge=1, le=200),
    days: int = Query(30, ge=1, le=365),
):
    """分页查询执行日志"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            conditions = ["created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)"]
            params = [days]

            if user_id:
                conditions.append("user_id = %s")
                params.append(user_id)
            if task_id:
                conditions.append("task_id = %s")
                params.append(task_id)
            if level:
                conditions.append("level = %s")
                params.append(level)

            where = "WHERE " + " AND ".join(conditions)

            cur.execute(f"SELECT COUNT(*) AS cnt FROM autocode_execution_logs {where}", params)
            total = cur.fetchone()["cnt"]

            offset = (page - 1) * page_size
            cur.execute(f"""
                SELECT id, task_id, user_id, agent_id, step, level, message, created_at
                FROM autocode_execution_logs
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


@router.get("/{task_id}")
async def task_execution_logs(
    task_id: str,
    level: Optional[str] = Query(None),
):
    """查询指定任务的完整执行日志"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            where = "WHERE task_id = %s"
            params = [task_id]
            if level:
                where += " AND level = %s"
                params.append(level)

            cur.execute(f"""
                SELECT id, task_id, user_id, agent_id, step, level, message, extra_data, created_at
                FROM autocode_execution_logs
                {where}
                ORDER BY id ASC
                LIMIT 500
            """, params)
            rows = cur.fetchall()

        for r in rows:
            if isinstance(r["created_at"], datetime):
                r["created_at"] = r["created_at"].isoformat()

        return {
            "task_id": task_id,
            "logs": rows,
            "count": len(rows),
        }
    finally:
        conn.close()


@router.get("/summary/tasks")
async def recent_task_summary(
    days: int = Query(7, ge=1, le=30),
):
    """最近执行的任务列表（从执行日志聚合）"""
    conn = _get_conn()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    task_id,
                    MAX(user_id) AS user_id,
                    COUNT(*) AS log_count,
                    COUNT(DISTINCT step) AS step_count,
                    MIN(created_at) AS started_at,
                    MAX(created_at) AS last_activity
                FROM autocode_execution_logs
                WHERE created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)
                GROUP BY task_id
                ORDER BY last_activity DESC
                LIMIT 100
            """, (days,))
            rows = cur.fetchall()

        for r in rows:
            for f in ("started_at", "last_activity"):
                if isinstance(r.get(f), datetime):
                    r[f] = r[f].isoformat()

        return {"tasks": rows, "days": days}
    finally:
        conn.close()
