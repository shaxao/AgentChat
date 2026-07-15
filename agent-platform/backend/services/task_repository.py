# -*- coding: utf-8 -*-
"""
Task Repository — 任务持久化层

将任务数据存储到 MySQL (MuHuoAi.autocode_tasks)，
解决内存存储重启/刷新即丢失的问题。

策略：写穿透 + 启动回填
- 创建/更新任务时同步写 DB
- 服务启动时从 DB 加载历史任务到内存
- 内存作为主缓存，DB 作为持久化保障
- MySQL 不可用时自动回退到内存存储（数据在服务重启后丢失，但运行时可用）
"""
import json
import logging
import socket
import os
from datetime import datetime
from typing import Optional
from pathlib import Path

import pymysql
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.task_repo")

# ─── 内存回退存储（MySQL 不可用时使用）──
_memory_fallback: dict[str, dict] = {}
_mysql_available: Optional[bool] = None
LEASE_OWNER = f"{socket.gethostname()}:{os.getpid()}"


PERSISTED_JSON_FIELDS = (
    "agents",
    "logs",
    "commit_history",
    "command_history",
    "plan",
    "review",
    "phase_reviews",
    "prototype",
    "project_recon",
    "pipeline_runs",
    "events",
)

MAX_LOG_ENTRIES = int(os.getenv("AUTOCODE_TASK_DB_MAX_LOG_ENTRIES", "500"))
MAX_EVENT_ENTRIES = int(os.getenv("AUTOCODE_TASK_DB_MAX_EVENT_ENTRIES", "1000"))
MAX_COMMAND_ENTRIES = int(os.getenv("AUTOCODE_TASK_DB_MAX_COMMAND_ENTRIES", "200"))
MAX_COMMIT_ENTRIES = int(os.getenv("AUTOCODE_TASK_DB_MAX_COMMIT_ENTRIES", "120"))
MAX_PIPELINE_RUNS = int(os.getenv("AUTOCODE_TASK_DB_MAX_PIPELINE_RUNS", "80"))
MAX_PHASE_REVIEWS = int(os.getenv("AUTOCODE_TASK_DB_MAX_PHASE_REVIEWS", "80"))
MAX_JSON_STRING_CHARS = int(os.getenv("AUTOCODE_TASK_DB_MAX_STRING_CHARS", "12000"))
TASK_ARCHIVE_DIR = Path(os.getenv("AUTOCODE_TASK_ARCHIVE_DIR", "/var/log/autocode/task-archives"))


def _json_load(value, default=None):
    if value is None or value == "":
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _json_dump(value):
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, default=str)


def _bool_or_none(value):
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    return bool(value)


def _archive_overflow(task_id: str, field: str, items: list) -> None:
    if not items:
        return
    try:
        TASK_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        archive_path = TASK_ARCHIVE_DIR / f"{task_id}-{field}.overflow.json"
        archived_at = datetime.utcnow().isoformat(timespec="seconds") + "Z"
        archive_path.write_text(json.dumps({
            "archived_at": archived_at,
            "field": field,
            "count": len(items),
            "items": items,
        }, ensure_ascii=False, default=str), encoding="utf-8")
    except Exception as exc:
        logger.debug(f"[TaskRepo] archive overflow failed for {task_id}.{field}: {exc}")


def _trim_list(task_id: str, field: str, value, limit: int):
    if not isinstance(value, list) or limit <= 0 or len(value) <= limit:
        return value
    overflow = value[:-limit]
    _archive_overflow(task_id, field, overflow)
    kept = value[-max(0, limit - 1):] if limit > 1 else []
    return [{
        "timestamp": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "agent": "storage",
        "level": "info",
        "message": (
            f"{len(overflow)} older {field} entr"
            f"{'y' if len(overflow) == 1 else 'ies'} archived outside MySQL"
        ),
        "archive": str(TASK_ARCHIVE_DIR / f"{task_id}-{field}.overflow.json"),
    }] + kept


def _truncate_strings(value):
    if isinstance(value, str):
        if len(value) <= MAX_JSON_STRING_CHARS:
            return value
        omitted = len(value) - MAX_JSON_STRING_CHARS
        return value[:MAX_JSON_STRING_CHARS] + f"\n...[truncated {omitted} chars for MySQL storage]..."
    if isinstance(value, list):
        return [_truncate_strings(item) for item in value]
    if isinstance(value, dict):
        return {key: _truncate_strings(item) for key, item in value.items()}
    return value


def _compact_task_for_persistence(task: dict) -> dict:
    compacted = dict(task)
    task_id = str(task.get("id") or "unknown")
    limits = {
        "logs": MAX_LOG_ENTRIES,
        "events": MAX_EVENT_ENTRIES,
        "command_history": MAX_COMMAND_ENTRIES,
        "commit_history": MAX_COMMIT_ENTRIES,
        "pipeline_runs": MAX_PIPELINE_RUNS,
        "phase_reviews": MAX_PHASE_REVIEWS,
    }
    for field, limit in limits.items():
        compacted[field] = _trim_list(task_id, field, compacted.get(field), limit)
    for field in PERSISTED_JSON_FIELDS:
        compacted[field] = _truncate_strings(compacted.get(field))
    compacted["preview_error"] = _truncate_strings(compacted.get("preview_error"))
    compacted["current_step"] = _truncate_strings(compacted.get("current_step"))
    if isinstance(compacted.get("current_step"), str) and len(compacted["current_step"]) > 480:
        compacted["current_step"] = compacted["current_step"][:480] + "...[truncated]"
    if isinstance(compacted.get("title"), str) and len(compacted["title"]) > 190:
        compacted["title"] = compacted["title"][:190] + "...[truncated]"
    return compacted


def _test_mysql_connection() -> bool:
    """测试 MySQL 是否可达"""
    global _mysql_available
    if _mysql_available is not None:
        return _mysql_available
    try:
        conn = pymysql.connect(
            host=settings.muhugochat_db_host,
            port=settings.muhugochat_db_port,
            user=settings.muhugochat_db_user,
            password=settings.muhugochat_db_password,
            database=settings.muhugochat_db_name,
            charset="utf8mb4",
            connect_timeout=3,
        )
        conn.close()
        _mysql_available = True
        logger.info("[TaskRepo] MySQL connected: "
                    f"{settings.muhugochat_db_host}:{settings.muhugochat_db_port}")
    except Exception as e:
        _mysql_available = False
        logger.warning(
            f"[TaskRepo] MySQL unavailable ({settings.muhugochat_db_host}:"
            f"{settings.muhugochat_db_port}): {e}"
        )
        logger.warning("[TaskRepo] Falling back to in-memory storage. "
                      "Tasks will be lost on service restart.")
    return _mysql_available or False


def _get_connection():
    """获取数据库连接（仅在 MySQL 可用时调用）"""
    return pymysql.connect(
        host=settings.muhugochat_db_host,
        port=settings.muhugochat_db_port,
        user=settings.muhugochat_db_user,
        password=settings.muhugochat_db_password,
        database=settings.muhugochat_db_name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        connect_timeout=5,
        autocommit=True,
    )


def init_table():
    """启动时自动建表（如果不存在）"""
    if not _test_mysql_connection():
        return  # 依赖 _memory_fallback

    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS `autocode_tasks` (
                    `id` VARCHAR(64) NOT NULL,
                    `title` VARCHAR(200) NOT NULL,
                    `description` TEXT NOT NULL,
                    `project_type` VARCHAR(50) NOT NULL DEFAULT 'nextjs',
                    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
                    `progress` INT NOT NULL DEFAULT 0,
                    `current_step` VARCHAR(500) DEFAULT '',
                    `workspace_id` VARCHAR(64) DEFAULT NULL,
                    `user_id` VARCHAR(64) DEFAULT NULL,
                    `harness_trace_id` BIGINT DEFAULT NULL,
                    `model` VARCHAR(100) DEFAULT NULL,
                    `tool_policy` VARCHAR(32) NOT NULL DEFAULT 'full_access',
                    `agents` JSON DEFAULT NULL,
                    `preview_url` VARCHAR(500) DEFAULT NULL,
                    `logs` JSON DEFAULT NULL,
                    `commit_history` JSON DEFAULT NULL,
                    `plan` JSON DEFAULT NULL,
                    `review` JSON DEFAULT NULL,
                    `phase_reviews` JSON DEFAULT NULL,
                    `prototype` JSON DEFAULT NULL,
                    `plan_confirmed` TINYINT(1) DEFAULT NULL,
                    `prototype_confirmed` TINYINT(1) DEFAULT NULL,
                    `review_confirmed` TINYINT(1) DEFAULT NULL,
                    `current_subtask_id` VARCHAR(64) DEFAULT NULL,
                    `project_recon` JSON DEFAULT NULL,
                    `complexity` VARCHAR(20) DEFAULT NULL,
                    `recommended_flow` VARCHAR(80) DEFAULT NULL,
                    `prototype_required` TINYINT(1) DEFAULT NULL,
                    `needs_continuation` TINYINT(1) DEFAULT NULL,
                    `pipeline_status` VARCHAR(20) DEFAULT NULL,
                    `preview_status` VARCHAR(20) DEFAULT NULL,
                    `preview_error` TEXT DEFAULT NULL,
                    `command_history` JSON DEFAULT NULL,
                    `pipeline_runs` JSON DEFAULT NULL,
                    `events` JSON DEFAULT NULL,
                    `queued_at` VARCHAR(40) DEFAULT NULL,
                    `lease_owner` VARCHAR(128) DEFAULT NULL,
                    `lease_until` DATETIME DEFAULT NULL,
                    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (`id`),
                    INDEX `idx_status` (`status`),
                    INDEX `idx_user_id` (`user_id`),
                    INDEX `idx_created_at` (`created_at`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            """)
            logger.info("[TaskRepo] autocode_tasks table ready")

            # 迁移：为已有表添加 user_id 列（如果不存在）
            try:
                cursor.execute(
                    "ALTER TABLE autocode_tasks ADD COLUMN `user_id` VARCHAR(64) DEFAULT NULL"
                )
                logger.info("[TaskRepo] Added 'user_id' column to autocode_tasks")
            except Exception:
                pass

            try:
                cursor.execute(
                    "ALTER TABLE autocode_tasks ADD COLUMN `plan` JSON DEFAULT NULL"
                )
                logger.info("[TaskRepo] Added 'plan' column to autocode_tasks")
            except Exception:
                pass

            migrations = [
                ("model", "VARCHAR(100) DEFAULT NULL"),
                ("tool_policy", "VARCHAR(32) NOT NULL DEFAULT 'full_access'"),
                ("review", "JSON DEFAULT NULL"),
                ("phase_reviews", "JSON DEFAULT NULL"),
                ("prototype", "JSON DEFAULT NULL"),
                ("plan_confirmed", "TINYINT(1) DEFAULT NULL"),
                ("prototype_confirmed", "TINYINT(1) DEFAULT NULL"),
                ("review_confirmed", "TINYINT(1) DEFAULT NULL"),
                ("current_subtask_id", "VARCHAR(64) DEFAULT NULL"),
                ("harness_trace_id", "BIGINT DEFAULT NULL"),
                ("project_recon", "JSON DEFAULT NULL"),
                ("complexity", "VARCHAR(20) DEFAULT NULL"),
                ("recommended_flow", "VARCHAR(80) DEFAULT NULL"),
                ("prototype_required", "TINYINT(1) DEFAULT NULL"),
                ("needs_continuation", "TINYINT(1) DEFAULT NULL"),
                ("pipeline_status", "VARCHAR(20) DEFAULT NULL"),
                ("preview_status", "VARCHAR(20) DEFAULT NULL"),
                ("preview_error", "TEXT DEFAULT NULL"),
                ("command_history", "JSON DEFAULT NULL"),
                ("pipeline_runs", "JSON DEFAULT NULL"),
                ("events", "JSON DEFAULT NULL"),
                ("queued_at", "VARCHAR(40) DEFAULT NULL"),
                ("lease_owner", "VARCHAR(128) DEFAULT NULL"),
                ("lease_until", "DATETIME DEFAULT NULL"),
            ]
            for column, definition in migrations:
                try:
                    cursor.execute(
                        f"ALTER TABLE autocode_tasks ADD COLUMN `{column}` {definition}"
                    )
                    logger.info(f"[TaskRepo] Added '{column}' column to autocode_tasks")
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"[TaskRepo] Failed to create table: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def load_all_tasks(user_id: Optional[str] = None) -> list[dict]:
    """从 DB 加载任务，返回字典列表。
    
    Args:
        user_id: 可选，按用户ID过滤。None 表示加载所有任务（用于启动恢复）。
    """
    if not _test_mysql_connection():
        logger.info(f"[TaskRepo] Loaded {len(_memory_fallback)} tasks from memory fallback")
        tasks = list(_memory_fallback.values())
        if user_id:
            tasks = [t for t in tasks if t.get("user_id") == user_id]
        return tasks

    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            if user_id:
                cursor.execute("""
                    SELECT id, title, description, project_type, status,
                           progress, current_step, workspace_id, user_id,
                           harness_trace_id, model, tool_policy,
                           agents, preview_url, logs, commit_history, plan,
                           review, phase_reviews, prototype,
                           plan_confirmed, prototype_confirmed, review_confirmed,
                           current_subtask_id, project_recon, complexity,
                           recommended_flow, prototype_required,
                           needs_continuation, pipeline_status, preview_status, preview_error,
                           command_history, pipeline_runs, queued_at,
                           events,
                           lease_owner, lease_until, created_at
                    FROM autocode_tasks
                    WHERE user_id = %s
                    ORDER BY created_at DESC
                """, (user_id,))
            else:
                cursor.execute("""
                    SELECT id, title, description, project_type, status,
                           progress, current_step, workspace_id, user_id,
                           harness_trace_id, model, tool_policy,
                           agents, preview_url, logs, commit_history, plan,
                           review, phase_reviews, prototype,
                           plan_confirmed, prototype_confirmed, review_confirmed,
                           current_subtask_id, project_recon, complexity,
                           recommended_flow, prototype_required,
                           needs_continuation, pipeline_status, preview_status, preview_error,
                           command_history, pipeline_runs, queued_at,
                           events,
                           lease_owner, lease_until, created_at
                    FROM autocode_tasks
                    ORDER BY created_at DESC
                """)
            rows = cursor.fetchall()

        tasks = []
        for row in rows:
            task = {
                "id": row["id"],
                "title": row["title"],
                "description": row["description"],
                "project_type": row["project_type"],
                "status": row["status"],
                "progress": row["progress"] or 0,
                "current_step": row["current_step"] or "",
                "workspace_id": row["workspace_id"],
                "user_id": row.get("user_id"),
                "harness_trace_id": row.get("harness_trace_id"),
                "model": row.get("model"),
                "tool_policy": row.get("tool_policy") or "full_access",
                "agents": _json_load(row["agents"], []),
                "preview_url": row["preview_url"],
                "logs": _json_load(row["logs"], []),
                "commit_history": _json_load(row["commit_history"], []),
                "plan": _json_load(row.get("plan"), None),
                "review": _json_load(row.get("review"), None),
                "phase_reviews": _json_load(row.get("phase_reviews"), []),
                "prototype": _json_load(row.get("prototype"), None),
                "plan_confirmed": _bool_or_none(row.get("plan_confirmed")),
                "prototype_confirmed": _bool_or_none(row.get("prototype_confirmed")),
                "review_confirmed": _bool_or_none(row.get("review_confirmed")),
                "current_subtask_id": row.get("current_subtask_id"),
                "project_recon": _json_load(row.get("project_recon"), None),
                "complexity": row.get("complexity"),
                "recommended_flow": row.get("recommended_flow"),
                "prototype_required": _bool_or_none(row.get("prototype_required")),
                "needs_continuation": _bool_or_none(row.get("needs_continuation")),
                "pipeline_status": row.get("pipeline_status"),
                "preview_status": row.get("preview_status"),
                "preview_error": row.get("preview_error"),
                "command_history": _json_load(row.get("command_history"), []),
                "pipeline_runs": _json_load(row.get("pipeline_runs"), []),
                "events": _json_load(row.get("events"), []),
                "queued_at": row.get("queued_at"),
                "lease_owner": row.get("lease_owner"),
                "lease_until": row.get("lease_until").isoformat() if isinstance(row.get("lease_until"), datetime) else row.get("lease_until"),
                "created_at": row["created_at"].isoformat() if isinstance(row["created_at"], datetime) else str(row["created_at"]),
            }
            tasks.append(task)
            # 同步到内存回退存储
            _memory_fallback[task["id"]] = task

        logger.info(f"[TaskRepo] Loaded {len(tasks)} tasks from MySQL" + (f" (user={user_id})" if user_id else ""))
        return tasks

    except Exception as e:
        logger.warning(f"[TaskRepo] MySQL load failed, using memory fallback: {e}")
        return list(_memory_fallback.values())
    finally:
        try:
            conn.close()
        except Exception:
            pass


def save_task(task: dict):
    """创建或更新任务到 DB"""
    # 总是先写到内存回退存储
    _memory_fallback[task["id"]] = dict(task, created_at=task.get("created_at", datetime.now().isoformat()))
    db_task = _compact_task_for_persistence(task)

    if not _test_mysql_connection():
        return

    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            values = {
                field: _json_dump(db_task.get(field))
                for field in PERSISTED_JSON_FIELDS
            }
            if values["agents"] is None:
                values["agents"] = _json_dump([])
            if values["logs"] is None:
                values["logs"] = _json_dump([])
            if values["commit_history"] is None:
                values["commit_history"] = _json_dump([])
            if values["command_history"] is None:
                values["command_history"] = _json_dump([])
            if values["phase_reviews"] is None:
                values["phase_reviews"] = _json_dump([])
            if values["pipeline_runs"] is None:
                values["pipeline_runs"] = _json_dump([])
            if values["events"] is None:
                values["events"] = _json_dump([])

            # 使用 UPSERT (INSERT ... ON DUPLICATE KEY UPDATE)
            cursor.execute("""
                INSERT INTO autocode_tasks
                    (id, title, description, project_type, status, progress,
                     current_step, workspace_id, user_id, harness_trace_id, model, tool_policy, agents, preview_url,
                     logs, commit_history, plan, review, phase_reviews, prototype,
                     plan_confirmed, prototype_confirmed, review_confirmed, current_subtask_id,
                     project_recon, complexity, recommended_flow, prototype_required,
                     needs_continuation, pipeline_status, preview_status, preview_error,
                      command_history, pipeline_runs, queued_at, events)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    title = VALUES(title),
                    description = VALUES(description),
                    project_type = VALUES(project_type),
                    status = VALUES(status),
                    progress = VALUES(progress),
                    current_step = VALUES(current_step),
                    workspace_id = VALUES(workspace_id),
                    user_id = VALUES(user_id),
                    harness_trace_id = VALUES(harness_trace_id),
                    model = VALUES(model),
                    tool_policy = VALUES(tool_policy),
                    agents = VALUES(agents),
                    preview_url = VALUES(preview_url),
                    logs = VALUES(logs),
                    commit_history = VALUES(commit_history),
                    plan = VALUES(plan),
                    review = VALUES(review),
                    phase_reviews = VALUES(phase_reviews),
                    prototype = VALUES(prototype),
                    plan_confirmed = VALUES(plan_confirmed),
                    prototype_confirmed = VALUES(prototype_confirmed),
                    review_confirmed = VALUES(review_confirmed),
                    current_subtask_id = VALUES(current_subtask_id),
                    project_recon = VALUES(project_recon),
                    complexity = VALUES(complexity),
                    recommended_flow = VALUES(recommended_flow),
                    prototype_required = VALUES(prototype_required),
                    needs_continuation = VALUES(needs_continuation),
                    pipeline_status = VALUES(pipeline_status),
                    preview_status = VALUES(preview_status),
                    preview_error = VALUES(preview_error),
                    command_history = VALUES(command_history),
                    pipeline_runs = VALUES(pipeline_runs),
                    queued_at = VALUES(queued_at),
                    events = VALUES(events)
            """, (
                db_task["id"],
                db_task["title"],
                db_task["description"],
                db_task["project_type"],
                db_task["status"],
                db_task.get("progress", 0),
                db_task.get("current_step", ""),
                db_task.get("workspace_id"),
                db_task.get("user_id"),
                db_task.get("harness_trace_id"),
                db_task.get("model"),
                db_task.get("tool_policy") or "full_access",
                values["agents"],
                db_task.get("preview_url"),
                values["logs"],
                values["commit_history"],
                values["plan"],
                values["review"],
                values["phase_reviews"],
                values["prototype"],
                db_task.get("plan_confirmed"),
                db_task.get("prototype_confirmed"),
                db_task.get("review_confirmed"),
                db_task.get("current_subtask_id"),
                values["project_recon"],
                db_task.get("complexity"),
                db_task.get("recommended_flow"),
                db_task.get("prototype_required"),
                db_task.get("needs_continuation"),
                db_task.get("pipeline_status"),
                db_task.get("preview_status"),
                db_task.get("preview_error"),
                values["command_history"],
                values["pipeline_runs"],
                db_task.get("queued_at"),
                values["events"],
            ))
    except Exception as e:
        logger.warning(f"[TaskRepo] MySQL save failed (data kept in memory): {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def acquire_task_lease(task_id: str, ttl_seconds: int = 600) -> bool:
    """Try to acquire a task execution lease for this process.

    This is the multi-instance guard: only one worker whose conditional UPDATE
    succeeds may run a task. If MySQL is unavailable we allow local execution so
    development mode still works, but production should keep MySQL enabled.
    """
    if not _test_mysql_connection():
        return True
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute(
                """
                UPDATE autocode_tasks
                SET lease_owner=%s, lease_until=DATE_ADD(UTC_TIMESTAMP(), INTERVAL %s SECOND)
                WHERE id=%s
                  AND status NOT IN ('completed','failed','cancelled',
                                     'waiting_confirm','waiting_plan_confirm',
                                     'waiting_prototype_confirm','waiting_review_confirm')
                  AND (lease_owner IS NULL OR lease_owner=%s OR lease_until IS NULL OR lease_until < UTC_TIMESTAMP())
                """,
                (LEASE_OWNER, int(ttl_seconds), task_id, LEASE_OWNER),
            )
            return cursor.rowcount == 1
    except Exception as e:
        logger.warning(f"[TaskRepo] acquire lease failed for {task_id}: {e}")
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def renew_task_lease(task_id: str, ttl_seconds: int = 600) -> bool:
    if not _test_mysql_connection():
        return True
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute(
                """
                UPDATE autocode_tasks
                SET lease_until=DATE_ADD(UTC_TIMESTAMP(), INTERVAL %s SECOND)
                WHERE id=%s AND lease_owner=%s
                """,
                (int(ttl_seconds), task_id, LEASE_OWNER),
            )
            return cursor.rowcount == 1
    except Exception as e:
        logger.debug(f"[TaskRepo] renew lease failed for {task_id}: {e}")
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass


def release_task_lease(task_id: str) -> None:
    if not _test_mysql_connection():
        return
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute(
                "UPDATE autocode_tasks SET lease_owner=NULL, lease_until=NULL WHERE id=%s AND lease_owner=%s",
                (task_id, LEASE_OWNER),
            )
    except Exception as e:
        logger.debug(f"[TaskRepo] release lease failed for {task_id}: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def delete_task(task_id: str):
    """从 DB 删除任务"""
    _memory_fallback.pop(task_id, None)

    if not _test_mysql_connection():
        return

    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("DELETE FROM autocode_tasks WHERE id = %s", (task_id,))
    except Exception as e:
        logger.warning(f"[TaskRepo] MySQL delete failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
