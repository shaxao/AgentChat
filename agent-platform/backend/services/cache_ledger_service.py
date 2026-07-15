# -*- coding: utf-8 -*-
"""Platform cache ledger shared by AutoCode and external chat systems.

This module is deliberately small and dependency-light: AutoCode writes cache
events directly, while the Java dialogue service can call the HTTP API that
wraps this service. MySQL is used when available; an in-memory fallback keeps
the agent path working during outages.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Any

import pymysql
from loguru import logger
from pymysql.cursors import DictCursor

from core.config import settings


CACHE_LEDGER_TABLE = "autocode_cache_ledger"
SOLVED_PATTERN_TABLE = "autocode_solved_patterns"
MAX_TEXT = 20_000
_mysql_available: bool | None = None
_events_fallback: list[dict[str, Any]] = []
_solutions_fallback: list[dict[str, Any]] = []


def _now() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _sha256(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8", errors="replace")).hexdigest()


def stable_hash(value: Any) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    except Exception:
        text = str(value)
    return _sha256(text)


def _trim(value: Any, limit: int = MAX_TEXT) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + f"\n...[truncated {len(value) - limit} chars]..."
    if isinstance(value, list):
        return [_trim(item, limit) for item in value]
    if isinstance(value, dict):
        return {str(key): _trim(item, limit) for key, item in value.items()}
    return value


def _json_dump(value: Any) -> str:
    return json.dumps(_trim(value), ensure_ascii=False, default=str)


def _json_load(value: Any, default: Any = None) -> Any:
    if value is None or value == "":
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return default


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
        logger.warning(f"[CacheLedger] MySQL unavailable, using memory fallback: {exc}")
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


@dataclass
class CacheLedgerEvent:
    cache_layer: str
    cache_key: str
    status: str
    scene_type: str = "autocode"
    tenant_id: str = ""
    user_id: str = ""
    task_id: str = ""
    session_id: str = ""
    workspace_id: str = ""
    epoch: int = 0
    input_hash: str = ""
    hit_reason: str = ""
    miss_reason: str = ""
    invalidation_reason: str = ""
    model: str = ""
    provider: str = ""
    token_saved_estimate: int = 0
    latency_saved_ms: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    cache_write_tokens: int = 0
    output_tokens: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=_now)

    def normalized(self) -> dict[str, Any]:
        data = asdict(self)
        data["status"] = (self.status or "miss").lower()
        data["cache_layer"] = (self.cache_layer or "unknown").upper()
        data["cache_key"] = self.cache_key or stable_hash(data)
        data["input_hash"] = self.input_hash or stable_hash(self.metadata)
        data["metadata"] = _trim(self.metadata or {})
        return data


class CacheLedgerService:
    def init(self) -> None:
        if not _test_mysql_connection():
            return
        try:
            conn = _get_connection()
            with conn.cursor() as cur:
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS `{CACHE_LEDGER_TABLE}` (
                        `id` BIGINT NOT NULL AUTO_INCREMENT,
                        `cache_layer` VARCHAR(32) NOT NULL,
                        `cache_key` VARCHAR(128) NOT NULL,
                        `status` VARCHAR(24) NOT NULL,
                        `scene_type` VARCHAR(32) NOT NULL DEFAULT 'autocode',
                        `tenant_id` VARCHAR(64) DEFAULT '',
                        `user_id` VARCHAR(64) DEFAULT '',
                        `task_id` VARCHAR(64) DEFAULT '',
                        `session_id` VARCHAR(128) DEFAULT '',
                        `workspace_id` VARCHAR(128) DEFAULT '',
                        `epoch` INT DEFAULT 0,
                        `input_hash` VARCHAR(128) DEFAULT '',
                        `hit_reason` VARCHAR(500) DEFAULT '',
                        `miss_reason` VARCHAR(500) DEFAULT '',
                        `invalidation_reason` VARCHAR(500) DEFAULT '',
                        `model` VARCHAR(128) DEFAULT '',
                        `provider` VARCHAR(128) DEFAULT '',
                        `token_saved_estimate` INT DEFAULT 0,
                        `latency_saved_ms` INT DEFAULT 0,
                        `input_tokens` INT DEFAULT 0,
                        `cached_input_tokens` INT DEFAULT 0,
                        `cache_write_tokens` INT DEFAULT 0,
                        `output_tokens` INT DEFAULT 0,
                        `metadata` JSON DEFAULT NULL,
                        `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (`id`),
                        INDEX `idx_cache_key` (`cache_key`),
                        INDEX `idx_scene_user` (`scene_type`, `user_id`, `created_at`),
                        INDEX `idx_task` (`task_id`, `created_at`),
                        INDEX `idx_layer_status` (`cache_layer`, `status`, `created_at`)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """)
                cur.execute(f"""
                    CREATE TABLE IF NOT EXISTS `{SOLVED_PATTERN_TABLE}` (
                        `id` BIGINT NOT NULL AUTO_INCREMENT,
                        `fingerprint` VARCHAR(128) NOT NULL,
                        `scene_type` VARCHAR(32) NOT NULL DEFAULT 'autocode',
                        `tenant_id` VARCHAR(64) DEFAULT '',
                        `user_id` VARCHAR(64) DEFAULT '',
                        `title` VARCHAR(300) NOT NULL DEFAULT '',
                        `tech_stack` VARCHAR(300) DEFAULT '',
                        `error_excerpt` TEXT,
                        `root_cause` TEXT,
                        `patch_summary` TEXT,
                        `validation_command` VARCHAR(500) DEFAULT '',
                        `validation_result` VARCHAR(32) DEFAULT '',
                        `risk_level` INT DEFAULT 1,
                        `reuse_policy` VARCHAR(32) DEFAULT 'suggest',
                        `metadata` JSON DEFAULT NULL,
                        `hit_count` INT DEFAULT 0,
                        `stale_count` INT DEFAULT 0,
                        `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        PRIMARY KEY (`id`),
                        UNIQUE KEY `uk_fingerprint_scene` (`fingerprint`, `scene_type`, `tenant_id`),
                        INDEX `idx_scene_updated` (`scene_type`, `updated_at`)
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                """)
        except Exception as exc:
            logger.warning(f"[CacheLedger] init failed: {exc}")
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def record(self, event: CacheLedgerEvent | dict[str, Any]) -> dict[str, Any]:
        data = event.normalized() if isinstance(event, CacheLedgerEvent) else CacheLedgerEvent(**event).normalized()
        _events_fallback.append(data)
        if len(_events_fallback) > 5000:
            del _events_fallback[:1000]
        if not _test_mysql_connection():
            return data
        try:
            conn = _get_connection()
            with conn.cursor() as cur:
                cur.execute(f"""
                    INSERT INTO `{CACHE_LEDGER_TABLE}`
                    (cache_layer, cache_key, status, scene_type, tenant_id, user_id, task_id,
                     session_id, workspace_id, epoch, input_hash, hit_reason, miss_reason,
                     invalidation_reason, model, provider, token_saved_estimate, latency_saved_ms,
                     input_tokens, cached_input_tokens, cache_write_tokens, output_tokens, metadata)
                    VALUES
                    (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                     %s, %s, %s, %s, %s, %s, %s)
                """, (
                    data["cache_layer"], data["cache_key"][:128], data["status"], data["scene_type"],
                    data["tenant_id"], data["user_id"], data["task_id"], data["session_id"],
                    data["workspace_id"], int(data["epoch"] or 0), data["input_hash"][:128],
                    data["hit_reason"], data["miss_reason"], data["invalidation_reason"],
                    data["model"], data["provider"], int(data["token_saved_estimate"] or 0),
                    int(data["latency_saved_ms"] or 0), int(data["input_tokens"] or 0),
                    int(data["cached_input_tokens"] or 0), int(data["cache_write_tokens"] or 0),
                    int(data["output_tokens"] or 0), _json_dump(data["metadata"]),
                ))
        except Exception as exc:
            logger.debug(f"[CacheLedger] record failed, kept fallback: {exc}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return data

    def stats(self, *, scene_type: str = "", user_id: str = "", task_id: str = "", hours: int = 24) -> dict[str, Any]:
        since_ts = time.time() - max(1, hours) * 3600
        if not _test_mysql_connection():
            events = [
                item for item in _events_fallback
                if (not scene_type or item.get("scene_type") == scene_type)
                and (not user_id or str(item.get("user_id")) == str(user_id))
                and (not task_id or item.get("task_id") == task_id)
            ]
            return self._aggregate(events)
        try:
            conn = _get_connection()
            with conn.cursor() as cur:
                sql = f"SELECT * FROM `{CACHE_LEDGER_TABLE}` WHERE created_at >= FROM_UNIXTIME(%s)"
                params: list[Any] = [since_ts]
                if scene_type:
                    sql += " AND scene_type=%s"
                    params.append(scene_type)
                if user_id:
                    sql += " AND user_id=%s"
                    params.append(str(user_id))
                if task_id:
                    sql += " AND task_id=%s"
                    params.append(task_id)
                sql += " ORDER BY created_at DESC LIMIT 5000"
                cur.execute(sql, params)
                return self._aggregate(cur.fetchall())
        except Exception as exc:
            logger.warning(f"[CacheLedger] stats failed: {exc}")
            return self._aggregate([])
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _aggregate(self, events: list[dict[str, Any]]) -> dict[str, Any]:
        total = len(events)
        hits = sum(1 for e in events if str(e.get("status")).lower() == "hit")
        by_layer: dict[str, dict[str, Any]] = {}
        for event in events:
            layer = str(event.get("cache_layer") or "UNKNOWN").upper()
            bucket = by_layer.setdefault(layer, {"total": 0, "hits": 0, "misses": 0, "stale": 0, "tokenSaved": 0, "latencySavedMs": 0})
            bucket["total"] += 1
            status = str(event.get("status") or "").lower()
            if status == "hit":
                bucket["hits"] += 1
            elif status == "stale":
                bucket["stale"] += 1
            else:
                bucket["misses"] += 1
            bucket["tokenSaved"] += int(event.get("token_saved_estimate") or 0)
            bucket["latencySavedMs"] += int(event.get("latency_saved_ms") or 0)
        for bucket in by_layer.values():
            bucket["hitRate"] = round(bucket["hits"] / bucket["total"], 4) if bucket["total"] else 0
        return {
            "total": total,
            "hits": hits,
            "misses": total - hits,
            "hitRate": round(hits / total, 4) if total else 0,
            "tokenSaved": sum(int(e.get("token_saved_estimate") or 0) for e in events),
            "latencySavedMs": sum(int(e.get("latency_saved_ms") or 0) for e in events),
            "byLayer": by_layer,
        }

    def stable_prompt_context(
        self,
        *,
        tenant_id: str = "",
        user_id: str = "",
        session_id: str = "",
        model: str = "",
        provider: str = "",
        context_version: str = "",
        system_prompt: str = "",
        stable_context: dict[str, Any] | str | None = None,
    ) -> dict[str, Any]:
        prefix_parts = [system_prompt.strip()]
        if stable_context:
            if isinstance(stable_context, str):
                prefix_parts.append(stable_context.strip())
            else:
                prefix_parts.append(json.dumps(stable_context, ensure_ascii=False, sort_keys=True, default=str))
        stable_prefix = "\n\n".join(part for part in prefix_parts if part)
        key_payload = {
            "tenant": tenant_id,
            "user": user_id,
            "session": session_id,
            "model": model,
            "provider": provider,
            "contextVersion": context_version,
            "prefixHash": _sha256(stable_prefix),
        }
        prompt_cache_key = "pc:" + stable_hash(key_payload)[:32]
        self.record(CacheLedgerEvent(
            cache_layer="L3",
            cache_key=prompt_cache_key,
            status="write",
            scene_type="chat",
            tenant_id=tenant_id,
            user_id=user_id,
            session_id=session_id,
            model=model,
            provider=provider,
            input_hash=key_payload["prefixHash"],
            metadata={"contextVersion": context_version, "prefixChars": len(stable_prefix)},
        ))
        return {"prompt_cache_key": prompt_cache_key, "stable_context_prefix": stable_prefix}

    def save_solution(self, payload: dict[str, Any]) -> dict[str, Any]:
        fingerprint = payload.get("fingerprint") or stable_hash({
            "scene": payload.get("scene_type") or "autocode",
            "error": payload.get("error_excerpt") or "",
            "root": payload.get("root_cause") or "",
            "tech": payload.get("tech_stack") or "",
        })
        data = dict(payload)
        data["fingerprint"] = fingerprint
        _solutions_fallback.append(data)
        if not _test_mysql_connection():
            return data
        try:
            conn = _get_connection()
            with conn.cursor() as cur:
                cur.execute(f"""
                    INSERT INTO `{SOLVED_PATTERN_TABLE}`
                    (fingerprint, scene_type, tenant_id, user_id, title, tech_stack, error_excerpt,
                     root_cause, patch_summary, validation_command, validation_result, risk_level,
                     reuse_policy, metadata)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON DUPLICATE KEY UPDATE
                        title=VALUES(title), tech_stack=VALUES(tech_stack),
                        error_excerpt=VALUES(error_excerpt), root_cause=VALUES(root_cause),
                        patch_summary=VALUES(patch_summary), validation_command=VALUES(validation_command),
                        validation_result=VALUES(validation_result), risk_level=VALUES(risk_level),
                        reuse_policy=VALUES(reuse_policy), metadata=VALUES(metadata), updated_at=NOW()
                """, (
                    fingerprint, data.get("scene_type", "autocode"), data.get("tenant_id", ""),
                    data.get("user_id", ""), data.get("title", "")[:300], data.get("tech_stack", "")[:300],
                    data.get("error_excerpt", ""), data.get("root_cause", ""), data.get("patch_summary", ""),
                    data.get("validation_command", "")[:500], data.get("validation_result", ""),
                    int(data.get("risk_level") or 1), data.get("reuse_policy", "suggest"),
                    _json_dump(data.get("metadata") or {}),
                ))
        except Exception as exc:
            logger.warning(f"[CacheLedger] save solution failed: {exc}")
        finally:
            try:
                conn.close()
            except Exception:
                pass
        return data

    def search_solutions(self, *, query: str = "", fingerprint: str = "", scene_type: str = "autocode", tenant_id: str = "", limit: int = 5) -> list[dict[str, Any]]:
        if not _test_mysql_connection():
            needle = (query or fingerprint).lower()
            return [
                item for item in reversed(_solutions_fallback)
                if (not scene_type or item.get("scene_type", "autocode") == scene_type)
                and (not tenant_id or item.get("tenant_id", "") == tenant_id)
                and (not needle or needle in _json_dump(item).lower())
            ][:limit]
        try:
            conn = _get_connection()
            with conn.cursor() as cur:
                if fingerprint:
                    cur.execute(f"""
                        SELECT * FROM `{SOLVED_PATTERN_TABLE}`
                        WHERE fingerprint=%s AND scene_type=%s AND (%s='' OR tenant_id=%s)
                        LIMIT %s
                    """, (fingerprint, scene_type, tenant_id, tenant_id, limit))
                else:
                    like = f"%{query}%"
                    cur.execute(f"""
                        SELECT * FROM `{SOLVED_PATTERN_TABLE}`
                        WHERE scene_type=%s AND (%s='' OR tenant_id=%s)
                          AND (title LIKE %s OR tech_stack LIKE %s OR error_excerpt LIKE %s OR root_cause LIKE %s)
                        ORDER BY updated_at DESC LIMIT %s
                    """, (scene_type, tenant_id, tenant_id, like, like, like, like, limit))
                rows = cur.fetchall()
                return [self._solution_row(row) for row in rows]
        except Exception as exc:
            logger.warning(f"[CacheLedger] search solution failed: {exc}")
            return []
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def _solution_row(self, row: dict[str, Any]) -> dict[str, Any]:
        out = dict(row)
        out["metadata"] = _json_load(out.get("metadata"), {})
        return out


cache_ledger_service = CacheLedgerService()
