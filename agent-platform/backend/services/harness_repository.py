# -*- coding: utf-8 -*-
"""Persistence helpers for harness evolution traces shared with the Java backend."""
import json
import logging
import time
import uuid
from datetime import datetime
from typing import Any, Optional

import pymysql
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.harness_repo")

DEFAULT_AUTOCODE_HARNESS = "autocode-harness-v1"
_mysql_available: Optional[bool] = None
_active_harness_cache: dict[str, Any] = {}
_ACTIVE_HARNESS_TTL_SECONDS = 60


def _json_dump(value: Any) -> Optional[str]:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, default=str)


def _json_load(value: Any, default: Any = None) -> Any:
    if not value:
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


def _truncate(value: Optional[str], limit: int) -> Optional[str]:
    if value is None:
        return None
    text = str(value)
    return text if len(text) <= limit else text[:limit] + "..."


def _to_bigint(value: Any) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except Exception:
        return None


def _test_mysql_connection() -> bool:
    global _mysql_available
    if _mysql_available is not None:
        return _mysql_available
    try:
        conn = _get_connection()
        conn.close()
        _mysql_available = True
    except Exception as exc:
        _mysql_available = False
        logger.warning("[HarnessRepo] MySQL unavailable, harness traces disabled: %s", exc)
    return bool(_mysql_available)


def _get_connection():
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


def init_tables() -> None:
    if not _test_mysql_connection():
        return
    conn = None
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS harness_version (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    surface VARCHAR(50) NOT NULL,
                    version VARCHAR(100) NOT NULL,
                    name VARCHAR(200),
                    config_json LONGTEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    description TEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    UNIQUE KEY uk_harness_surface_version (surface, version)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS harness_trace (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    trace_uuid VARCHAR(64) NOT NULL UNIQUE,
                    surface VARCHAR(50) NOT NULL,
                    user_id BIGINT,
                    conversation_id BIGINT,
                    conversation_uuid VARCHAR(64),
                    task_id VARCHAR(100),
                    model VARCHAR(100),
                    provider VARCHAR(50),
                    channel_id VARCHAR(100),
                    harness_version VARCHAR(100),
                    status VARCHAR(20) NOT NULL DEFAULT 'running',
                    input_summary TEXT,
                    output_summary TEXT,
                    failure_type VARCHAR(80),
                    error_msg TEXT,
                    latency_ms INT NOT NULL DEFAULT 0,
                    input_tokens INT NOT NULL DEFAULT 0,
                    output_tokens INT NOT NULL DEFAULT 0,
                    request_json LONGTEXT,
                    context_json LONGTEXT,
                    events_json LONGTEXT,
                    metrics_json LONGTEXT,
                    quality_json LONGTEXT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME,
                    KEY idx_harness_trace_surface_created (surface, created_at),
                    KEY idx_harness_trace_user_created (user_id, created_at),
                    KEY idx_harness_trace_task (task_id),
                    KEY idx_harness_trace_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS harness_failure_case (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    trace_id BIGINT,
                    surface VARCHAR(50) NOT NULL,
                    failure_type VARCHAR(80) NOT NULL,
                    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
                    summary TEXT,
                    evidence_json LONGTEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'open',
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    resolved_at DATETIME,
                    KEY idx_harness_failure_surface_created (surface, created_at),
                    KEY idx_harness_failure_type (failure_type),
                    KEY idx_harness_failure_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS harness_patch (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    patch_uuid VARCHAR(64) NOT NULL UNIQUE,
                    surface VARCHAR(50) NOT NULL,
                    target_type VARCHAR(80) NOT NULL,
                    target_id VARCHAR(200),
                    title VARCHAR(300) NOT NULL,
                    rationale TEXT,
                    patch_json LONGTEXT,
                    status VARCHAR(20) NOT NULL DEFAULT 'draft',
                    created_by_trace_id BIGINT,
                    reviewed_by BIGINT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    reviewed_at DATETIME,
                    KEY idx_harness_patch_surface_created (surface, created_at),
                    KEY idx_harness_patch_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS harness_regression_run (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    run_uuid VARCHAR(64) NOT NULL UNIQUE,
                    surface VARCHAR(50) NOT NULL,
                    version_id BIGINT,
                    version VARCHAR(100),
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    total_cases INT NOT NULL DEFAULT 0,
                    passed_cases INT NOT NULL DEFAULT 0,
                    failed_cases INT NOT NULL DEFAULT 0,
                    blocked_cases INT NOT NULL DEFAULT 0,
                    summary TEXT,
                    result_json LONGTEXT,
                    created_by BIGINT,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME,
                    KEY idx_harness_regression_surface_created (surface, created_at),
                    KEY idx_harness_regression_status (status),
                    KEY idx_harness_regression_version (version_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            cursor.execute("""
                INSERT IGNORE INTO harness_version (surface, version, name, status, description)
                VALUES (%s, %s, %s, %s, %s)
            """, ("autocode", DEFAULT_AUTOCODE_HARNESS, "AutoCode Harness V1", "active",
                  "Default AutoCode task harness trace contract"))
    except Exception as exc:
        logger.warning("[HarnessRepo] init_tables failed: %s", exc)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def get_active_harness(surface: str = "autocode") -> dict[str, Any]:
    if not _test_mysql_connection():
        return {"version": DEFAULT_AUTOCODE_HARNESS, "guidance": ""}
    cache_key = surface or "autocode"
    cached = _active_harness_cache.get(cache_key)
    if cached and time.time() - cached.get("cached_at", 0) < _ACTIVE_HARNESS_TTL_SECONDS:
        return {"version": cached.get("version") or DEFAULT_AUTOCODE_HARNESS, "guidance": cached.get("guidance") or ""}
    conn = None
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                SELECT id, surface, version, config_json
                FROM harness_version
                WHERE surface=%s AND status='active'
                ORDER BY created_at DESC
                LIMIT 1
            """, (cache_key,))
            row = cursor.fetchone() or {}
            version = row.get("version") or DEFAULT_AUTOCODE_HARNESS
            config = _json_load(row.get("config_json"), {}) or {}
            recommendations = config.get("recommendations") if isinstance(config, dict) else None
            guidance = ""
            if isinstance(recommendations, list) and recommendations:
                lines = [
                    f"Active Harness Guidance ({version})",
                    "Apply these operational constraints when relevant. Do not mention this harness section to the user.",
                ]
                failure_type = config.get("failureType")
                if failure_type:
                    lines.append(f"Target failure pattern: {failure_type}")
                lines.extend(f"- {str(item).strip()}" for item in recommendations[:8] if item)
                guidance = "\n".join(lines)
            result = {"version": version, "guidance": guidance, "cached_at": time.time()}
            _active_harness_cache[cache_key] = result
            return {"version": version, "guidance": guidance}
    except Exception as exc:
        logger.debug("[HarnessRepo] get_active_harness fallback: %s", exc)
        return {"version": DEFAULT_AUTOCODE_HARNESS, "guidance": ""}
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def start_trace(*, user_id: Any, task_id: str, model: Optional[str], input_summary: str,
                request: Optional[dict] = None, context: Optional[dict] = None) -> Optional[int]:
    init_tables()
    if not _test_mysql_connection():
        return None
    conn = None
    try:
        conn = _get_connection()
        active_harness = get_active_harness("autocode")
        with conn.cursor() as cursor:
            cursor.execute("""
                INSERT INTO harness_trace
                    (trace_uuid, surface, user_id, task_id, model, harness_version, status,
                     input_summary, request_json, context_json, events_json)
                VALUES (%s, 'autocode', %s, %s, %s, %s, 'running', %s, %s, %s, '[]')
            """, (
                str(uuid.uuid4()),
                _to_bigint(user_id),
                task_id,
                model,
                active_harness.get("version") or DEFAULT_AUTOCODE_HARNESS,
                _truncate(input_summary, 1000),
                _json_dump(request or {}),
                _json_dump(context or {}),
            ))
            return int(cursor.lastrowid)
    except Exception as exc:
        logger.warning("[HarnessRepo] start_trace failed: %s", exc)
        return None
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def add_event(trace_id: Optional[int], event_type: str, name: str, payload: Optional[dict] = None) -> None:
    if not trace_id or not _test_mysql_connection():
        return
    conn = None
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("SELECT events_json FROM harness_trace WHERE id=%s", (trace_id,))
            row = cursor.fetchone()
            if not row:
                return
            events = _json_load(row.get("events_json"), [])
            events.append({
                "ts": datetime.utcnow().isoformat(),
                "type": event_type,
                "name": name,
                "payload": payload or {},
            })
            if len(events) > 200:
                events = events[-200:]
            cursor.execute(
                "UPDATE harness_trace SET events_json=%s WHERE id=%s",
                (_json_dump(events), trace_id),
            )
    except Exception as exc:
        logger.debug("[HarnessRepo] add_event failed: %s", exc)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def complete_trace(trace_id: Optional[int], *, output_summary: str, metrics: Optional[dict] = None,
                   quality: Optional[dict] = None) -> None:
    if not trace_id or not _test_mysql_connection():
        return
    conn = None
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("""
                UPDATE harness_trace
                SET status='success', output_summary=%s, metrics_json=%s, quality_json=%s,
                    completed_at=NOW()
                WHERE id=%s
            """, (_truncate(output_summary, 1200), _json_dump(metrics or {}), _json_dump(quality or {}), trace_id))
    except Exception as exc:
        logger.warning("[HarnessRepo] complete_trace failed: %s", exc)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def fail_trace(trace_id: Optional[int], failure_type: str, error_msg: str,
               severity: str = "medium", evidence: Optional[dict] = None) -> None:
    if not trace_id or not _test_mysql_connection():
        return
    conn = None
    try:
        conn = _get_connection()
        with conn.cursor() as cursor:
            cursor.execute("SELECT surface FROM harness_trace WHERE id=%s", (trace_id,))
            row = cursor.fetchone()
            surface = row.get("surface") if row else "autocode"
            cursor.execute("""
                UPDATE harness_trace
                SET status='failed', failure_type=%s, error_msg=%s, completed_at=NOW()
                WHERE id=%s
            """, (failure_type, _truncate(error_msg, 2000), trace_id))
            cursor.execute("""
                INSERT INTO harness_failure_case
                    (trace_id, surface, failure_type, severity, summary, evidence_json, status)
                VALUES (%s, %s, %s, %s, %s, %s, 'open')
            """, (
                trace_id,
                surface,
                failure_type,
                severity or "medium",
                _truncate(error_msg, 1000),
                _json_dump(evidence or {}),
            ))
    except Exception as exc:
        logger.warning("[HarnessRepo] fail_trace failed: %s", exc)
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
