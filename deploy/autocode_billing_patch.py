#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AutoCode 计费与日志功能补丁脚本
在 Server B 上运行: python3 /tmp/autocode_billing_patch.py

功能:
1. 修改 task_repository.py 添加 usage_logs + execution_logs 表
2. 修改 usage_reporter.py 添加本地持久化函数
3. 创建 api/usage.py 用量查询 API
4. 创建 api/logs.py 执行日志 API
5. 修改 main.py 注册新路由
6. 创建 dashboard 仪表盘页面
"""
import os
import sys

AUTOCODE_ROOT = "/opt/autocode"


def patch_task_repository():
    """在 init_table() 中添加两张新表的 CREATE TABLE"""
    path = os.path.join(AUTOCODE_ROOT, "services", "task_repository.py")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    insert_marker = '                    logger.info(f"[TaskRepo] Added \'{column}\' column to autocode_tasks")'
    insert_marker_2 = '                    pass'

    # 在 init_table() 函数最后的 migrations 处理完之后插入新表建表代码
    new_tables_code = '''
            # ================================================
            # autocode_usage_logs --- per-request usage records
            # ================================================
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS autocode_usage_logs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    user_id VARCHAR(64) DEFAULT NULL,
                    task_id VARCHAR(64) DEFAULT NULL,
                    agent_id VARCHAR(64) DEFAULT NULL,
                    model VARCHAR(100) NOT NULL,
                    scene_type VARCHAR(50) NOT NULL DEFAULT 'autocode',
                    input_tokens INT NOT NULL DEFAULT 0,
                    cached_input_tokens INT NOT NULL DEFAULT 0,
                    output_tokens INT NOT NULL DEFAULT 0,
                    latency_ms INT NOT NULL DEFAULT 0,
                    status VARCHAR(20) NOT NULL DEFAULT 'success',
                    error_msg VARCHAR(1000) DEFAULT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_u_uid (user_id),
                    INDEX idx_u_tid (task_id),
                    INDEX idx_u_model (model),
                    INDEX idx_u_ct (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            logger.info("[TaskRepo] autocode_usage_logs table ready")

            # ================================================
            # autocode_execution_logs --- execution step logs
            # ================================================
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS autocode_execution_logs (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    task_id VARCHAR(64) NOT NULL,
                    user_id VARCHAR(64) DEFAULT NULL,
                    agent_id VARCHAR(64) DEFAULT NULL,
                    step VARCHAR(200) DEFAULT NULL,
                    level VARCHAR(20) NOT NULL DEFAULT 'INFO',
                    message TEXT,
                    extra_data JSON DEFAULT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_el_tid (task_id),
                    INDEX idx_el_uid (user_id),
                    INDEX idx_el_level (level),
                    INDEX idx_el_ct (created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            logger.info("[TaskRepo] autocode_execution_logs table ready")'''

    # 找到最后那个 pass（在 for column, definition in migrations 循环最后的 except: pass）
    # 然后在那之后插入新代码
    # 用特征定位：在 init_table 函数中找 except Exception: pass 后面跟着空白和 except Exception:
    # 实际上应该在 for 循环结束后，except Exception: 那行的 pass 之后插入

    # 更简单的方法：找到 init_table 函数中最后一个 pass（在 except Exception: 之后）
    # 然后把新代码插入在这个 pass 和下一个 except Exception 之间

    # 在 init_table 函数内，migrations 循环的最后一个 except: pass 之后插入
    lines = content.split("\n")
    # 找到 init_table 函数定义行
    in_init = False
    insert_line = -1
    for i, line in enumerate(lines):
        if "def init_table()" in line:
            in_init = True
        if in_init and "def " in line and i > 0 and "init_table" not in line:
            break  # 下一个函数开始了
        if in_init and line.strip() == "pass" and i > insert_line:
            # 检查上面几行是否包含 migrations 相关的 except
            prev_lines = "\n".join(lines[max(0, i-10):i])
            if "migrations" in prev_lines and "except Exception" in prev_lines:
                insert_line = i

    if insert_line > 0:
        # 在 pass 之后插入
        lines = lines[:insert_line+1] + new_tables_code.strip().split("\n") + lines[insert_line+1:]
        content = "\n".join(lines)
        print(f"   插入新表创建代码于第 {insert_line+1} 行之后")
    else:
        # 回退方案：在 "harness_trace_id" 相关 pass 后插入
        harness_found = False
        insert_line = -1
        for i, line in enumerate(lines):
            if "harness_trace_id" in line and "BIGINT" in line:
                harness_found = True
            if harness_found and i > insert_line and line.strip() == "pass":
                insert_line = i
                break
        if insert_line > 0:
            lines = lines[:insert_line+1] + new_tables_code.strip().split("\n") + lines[insert_line+1:]
            content = "\n".join(lines)
            print(f"   插入新表创建代码于第 {insert_line+1} 行之后 (harness 回退)")
        else:
            print("   ERROR: 找不到插入位置！")
            return False

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("   ✅ task_repository.py 已更新 (新表创建代码)")
    return True


def patch_usage_reporter():
    """在 usage_reporter.py 末尾添加本地持久化函数"""
    path = os.path.join(AUTOCODE_ROOT, "services", "usage_reporter.py")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 添加两个新函数 + 一个 LoggerAdapter
    new_code = '''

# ═══════════════════════════════════════════════════
# 本地持久化 — 写入 MySQL autocode_usage_logs 表
# ═══════════════════════════════════════════════════

import pymysql
from pymysql import OperationalError

def _get_reporter_db_config():
    """获取数据库连接参数（与 task_repository 共享同一配置）"""
    from core.config import settings
    return {
        "host": settings.muhugochat_db_host,
        "port": settings.muhugochat_db_port,
        "user": settings.muhugochat_db_user,
        "password": settings.muhugochat_db_password,
        "database": settings.muhugochat_db_name,
        "charset": "utf8mb4",
        "connect_timeout": 3,
        "autocommit": True,
    }


async def report_usage_local(
    *,
    model: str,
    input_tokens: int = 0,
    cached_input_tokens: int = 0,
    output_tokens: int = 0,
    latency_ms: int = 0,
    status: str = "success",
    error_msg: str | None = None,
    context: UsageContext | None = None,
) -> bool:
    """将用量数据直接写入本地 MySQL autocode_usage_logs 表。

    与 report_usage() 互补：后者异步上报到 MuhugoChat，
    本函数直接写入共享数据库，为仪表盘提供即时数据。
    """
    ctx = context or current_usage_context()
    if ctx is None or not ctx.user_id:
        return False

    try:
        db_cfg = _get_reporter_db_config()
        conn = await asyncio.to_thread(
            lambda: pymysql.connect(**db_cfg)
        )
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO autocode_usage_logs
                       (user_id, task_id, agent_id, model, scene_type,
                        input_tokens, cached_input_tokens, output_tokens,
                        latency_ms, status, error_msg)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        str(ctx.user_id) if ctx.user_id else None,
                        ctx.task_id,
                        ctx.agent_id,
                        model or "unknown",
                        ctx.scene_type or "autocode",
                        max(0, int(input_tokens or 0)),
                        max(0, int(cached_input_tokens or 0)),
                        max(0, int(output_tokens or 0)),
                        max(0, int(latency_ms or 0)),
                        status or "success",
                        (error_msg or "")[:1000] if error_msg else None,
                    ),
                )
            return True
        finally:
            conn.close()
    except OperationalError:
        logger.debug("[UsageReporter] MySQL write skipped (DB unavailable)")
        return False
    except Exception as exc:
        logger.debug(f"[UsageReporter] Local write error: {exc}")
        return False


async def write_execution_log(
    *,
    task_id: str,
    user_id: str | None = None,
    agent_id: str | None = None,
    step: str | None = None,
    level: str = "INFO",
    message: str = "",
    extra_data: dict | None = None,
) -> bool:
    """写入任务执行日志到 autocode_execution_logs 表。"""
    import json as _json

    try:
        db_cfg = _get_reporter_db_config()
        conn = await asyncio.to_thread(
            lambda: pymysql.connect(**db_cfg)
        )
        try:
            with conn.cursor() as cursor:
                cursor.execute(
                    """INSERT INTO autocode_execution_logs
                       (task_id, user_id, agent_id, step, level, message, extra_data)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                    (
                        task_id,
                        str(user_id) if user_id else None,
                        agent_id,
                        step[:200] if step else None,
                        level or "INFO",
                        message[:5000] if message else "",
                        _json.dumps(extra_data, ensure_ascii=False, default=str) if extra_data else None,
                    ),
                )
            return True
        finally:
            conn.close()
    except OperationalError:
        return False
    except Exception as exc:
        logger.debug(f"[ExecutionLog] Write error: {exc}")
        return False
'''

    content += new_code

    # 确保 asyncio 被导入
    if "import asyncio" not in content:
        content = content.replace("import time\n", "import asyncio\nimport time\n")

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("   ✅ usage_reporter.py 已更新 (本地持久化 + 执行日志)")


def create_usage_api():
    """创建 api/usage.py — 用量查询 API"""
    path = os.path.join(AUTOCODE_ROOT, "api", "usage.py")

    code = '''# -*- coding: utf-8 -*-
"""
用量查询 API — 计费仪表盘数据源

端点:
  GET  /api/usage/stats          — 用户级用量汇总
  GET  /api/usage/logs           — 分页用量明细
  GET  /api/usage/models         — 使用的模型列表
  GET  /api/usage/daily          — 按日汇总
"""
import logging
from datetime import date, datetime, timedelta
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
                    AVG(latency_ms) AS avg_latency_ms,
                    MAX(latency_ms) AS max_latency_ms
                FROM autocode_usage_logs
                {where}
                GROUP BY model, scene_type
                ORDER BY total_tokens DESC
            """, params)
            rows = cur.fetchall()

        # 汇总
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
            # 构建条件
            conditions = ["created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)"]
            params: list = [days]

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

            # 计数
            cur.execute(f"SELECT COUNT(*) AS cnt FROM autocode_usage_logs {where}", params)
            total = cur.fetchone()["cnt"]

            # 分页
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
    """返回曾经使用过的模型列表（用于筛选）"""
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
    days: int = Query(14, ge=1, le=90),
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
'''

    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    print("   ✅ api/usage.py 已创建")


def create_logs_api():
    """创建 api/logs.py — 执行日志 API"""
    path = os.path.join(AUTOCODE_ROOT, "api", "logs.py")

    code = '''# -*- coding: utf-8 -*-
"""
执行日志 API — 任务执行记录查询

端点:
  GET  /api/logs               — 分页执行日志
  GET  /api/logs/{task_id}     — 按任务查询日志
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
'''

    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    print("   ✅ api/logs.py 已创建")


def patch_main_py():
    """修改 main.py 注册新路由"""
    path = os.path.join(AUTOCODE_ROOT, "main.py")
    with open(path, "r", encoding="utf-8") as f:
        content = f.read()

    # 检查是否已注册
    if '"Usage"' in content and '"Logs"' in content:
        print("   ⏭️  main.py 已包含 usage/logs 路由，跳过")
        return

    # 1. 添加 import
    import_line = "from api import tasks, workspaces, git, terminal, agents, dev_servers, deploy, routing, projects, prototype"
    new_import_line = "from api import tasks, workspaces, git, terminal, agents, dev_servers, deploy, routing, projects, prototype, usage, logs"
    content = content.replace(import_line, new_import_line)

    # 2. 添加 router 注册
    router_line = "app.include_router(routing.router, prefix=\"/api/routing\", tags=[\"Routing\"])"
    new_routers = """app.include_router(routing.router, prefix="/api/routing", tags=["Routing"])
app.include_router(usage.router, prefix="/api/usage", tags=["Usage"])
app.include_router(logs.router, prefix="/api/logs", tags=["Logs"])"""
    content = content.replace(router_line, new_routers)

    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print("   ✅ main.py 已注册 usage + logs 路由")


def create_dashboard():
    """创建 Autocode 计费仪表盘 HTML 页面"""
    path = os.path.join(AUTOCODE_ROOT, "dashboard.html")

    html = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Autocode 计费与日志管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.container{max-width:1400px;margin:0 auto;padding:20px}
h1{font-size:1.75rem;font-weight:700;margin-bottom:.25rem;color:#f8fafc}
.subtitle{color:#94a3b8;font-size:.9rem;margin-bottom:1.5rem}

/* Tabs */
.tabs{display:flex;gap:0;margin-bottom:1.5rem;border-bottom:2px solid #1e293b}
.tab{padding:.6rem 1.5rem;cursor:pointer;color:#94a3b8;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .2s;font-weight:500;font-size:.9rem}
.tab:hover{color:#e2e8f0}
.tab.active{color:#60a5fa;border-bottom-color:#60a5fa}

/* Stats cards */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:1rem;margin-bottom:1.5rem}
.stat-card{background:#1e293b;border-radius:.75rem;padding:1.25rem;border:1px solid #334155}
.stat-card .label{font-size:.8rem;color:#94a3b8;margin-bottom:.3rem;text-transform:uppercase;letter-spacing:.5px}
.stat-card .value{font-size:1.75rem;font-weight:700;color:#f1f5f9}
.stat-card .unit{font-size:.8rem;color:#64748b;margin-left:.25rem}

/* Tables */
.card{background:#1e293b;border-radius:.75rem;padding:1.25rem;margin-bottom:1rem;border:1px solid #334155}
.card h2{font-size:1.1rem;font-weight:600;color:#f1f5f9;margin-bottom:1rem}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;padding:.6rem .75rem;color:#94a3b8;font-weight:500;border-bottom:1px solid #334155}
td{padding:.55rem .75rem;border-bottom:1px solid #1e293b;color:#cbd5e1}
tr:hover td{background:#0f172a}
.mono{font-family:'JetBrains Mono',monospace;font-size:.8rem}
.badge{padding:.2rem .5rem;border-radius:.25rem;font-size:.75rem;font-weight:500}
.badge-success{background:#064e3b;color:#34d399}
.badge-error{background:#7f1d1d;color:#fca5a5}
.badge-warn{background:#78350f;color:#fbbf24}
.badge-info{background:#1e3a5f;color:#93c5fd}

/* Filter bar */
.filters{display:flex;gap:.75rem;margin-bottom:1rem;flex-wrap:wrap;align-items:center}
.filters select,.filters input{padding:.4rem .75rem;background:#0f172a;border:1px solid #334155;border-radius:.375rem;color:#e2e8f0;font-size:.85rem}
.filters button{padding:.4rem 1rem;background:#2563eb;color:#fff;border:none;border-radius:.375rem;cursor:pointer;font-size:.85rem;transition:background .2s}
.filters button:hover{background:#1d4ed8}
.pagination{display:flex;gap:.5rem;align-items:center;margin-top:1rem;font-size:.85rem;color:#94a3b8}

/* Chart area */
.chart-container{background:#1e293b;border-radius:.75rem;padding:1.25rem;margin-bottom:1rem;border:1px solid #334155;height:300px;display:flex;align-items:center;justify-content:center}
.chart-container canvas{width:100%;height:100%}

.loading{text-align:center;padding:3rem;color:#94a3b8}
.error{background:#7f1d1d;color:#fca5a5;padding:1rem;border-radius:.5rem;margin-bottom:1rem}
.empty{text-align:center;padding:2rem;color:#64748b;font-size:.9rem}
</style>
</head>
<body>
<div class="container">
<h1>Autocode 计费与日志</h1>
<p class="subtitle">用量统计 · 执行日志 · 计费管理</p>

<div class="tabs">
  <div class="tab active" onclick="switchTab('overview')">概览</div>
  <div class="tab" onclick="switchTab('usage')">用量明细</div>
  <div class="tab" onclick="switchTab('daily')">每日趋势</div>
  <div class="tab" onclick="switchTab('logs')">执行日志</div>
</div>

<!-- Overview tab -->
<div id="tab-overview" class="tab-content">
  <div id="overview-stats" class="stats"></div>
  <div class="card"><h2>按模型汇总</h2><div id="model-table"></div></div>
</div>

<!-- Usage tab -->
<div id="tab-usage" class="tab-content" style="display:none">
  <div class="card">
    <div class="filters">
      <select id="usage-model" onchange="loadUsageLogs()"><option value="all">全部模型</option></select>
      <select id="usage-status" onchange="loadUsageLogs()">
        <option value="all">全部状态</option>
        <option value="success">成功</option>
        <option value="error">失败</option>
      </select>
      <select id="usage-days" onchange="loadUsageLogs()">
        <option value="1">最近1天</option>
        <option value="7" selected>最近7天</option>
        <option value="30">最近30天</option>
      </select>
      <button onclick="loadUsageLogs()">刷新</button>
    </div>
    <div id="usage-table"></div>
    <div id="usage-pagination" class="pagination"></div>
  </div>
</div>

<!-- Daily trend tab -->
<div id="tab-daily" class="tab-content" style="display:none">
  <div class="chart-container" id="daily-chart-container">
    <span id="daily-chart-loading" class="loading">加载中...</span>
  </div>
  <div class="card"><h2>每日数据</h2><div id="daily-table"></div></div>
</div>

<!-- Logs tab -->
<div id="tab-logs" class="tab-content" style="display:none">
  <div class="card">
    <div class="filters">
      <input type="text" id="logs-taskid" placeholder="任务 ID（可选）" style="width:200px">
      <select id="logs-level" onchange="loadLogs()">
        <option value="all">全部级别</option>
        <option value="INFO">INFO</option>
        <option value="WARN">WARNING</option>
        <option value="ERROR">ERROR</option>
      </select>
      <select id="logs-days" onchange="loadLogs()">
        <option value="1">最近1天</option>
        <option value="7" selected>最近7天</option>
        <option value="30">最近30天</option>
      </select>
      <button onclick="loadLogs()">刷新</button>
    </div>
    <div id="logs-table"></div>
    <div id="logs-pagination" class="pagination"></div>
  </div>
</div>

</div>

<script>
const API = '/api';
let currentTab = 'overview';
let usagePage = 1;
let logsPage = 1;

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.querySelector(`[onclick="switchTab('${tab}')"]`).classList.add('active');
  document.getElementById(`tab-${tab}`).style.display = 'block';
  if (tab === 'overview') loadOverview();
  if (tab === 'usage') loadUsageLogs();
  if (tab === 'daily') loadDaily();
  if (tab === 'logs') loadLogs();
}

// ── Overview ──
async function loadOverview() {
  try