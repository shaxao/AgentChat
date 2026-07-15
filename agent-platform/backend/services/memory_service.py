# -*- coding: utf-8 -*-
"""
Memory Service — 五层记忆模型落地（轻量替代 ES / Milvus）

设计原则（依据 Agent记忆与文件分层管理_合并方案.md + 2026-07-07 决策）：
- 放弃 Elasticsearch / Milvus，改用 MySQL FULLTEXT + Redis 缓存 + 文件系统。
- L2 温记忆  -> `agent_memory` 表：任务/用户/项目级工作记忆，自动注入、容量受控。
- L3 冷记忆  -> `memory_search` 表：长期语义检索库，FULLTEXT(ngram) 全文索引，永久留存。
- L1 热数据  -> Redis 缓存高频记忆条目与热门检索结果（真正启用，原 rq 已依赖 redis）。
- 全部读写均优雅降级：MySQL 不可用时回退内存字典；Redis 不可用时跳过缓存。

与 task_repository.py 一致的模式：写穿透 + 启动建表（幂等）+ 不可用时内存回退。
"""
import json
import logging
import hashlib
from datetime import datetime
from typing import Optional

import pymysql
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.memory")

# ─── 全局状态 ───────────────────────────────────────────────────
_mysql_available: Optional[bool] = None
_redis_client = None
_redis_available: Optional[bool] = None

# MySQL 不可用时内存回退（仅 agent_memory 热数据；memory_search 冷库不回退）
_memory_fallback: dict[str, dict] = {}


# ─── JSON 辅助 ──────────────────────────────────────────────────
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
    if isinstance(value, str):
        return value
    return json.dumps(value, ensure_ascii=False, default=str)


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ─── MySQL 连接（沿用 task_repository 模式）───────────────────────
def _test_mysql_connection() -> bool:
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
        logger.info("[Memory] MySQL connected "
                    f"({settings.muhugochat_db_host}:{settings.muhugochat_db_port})")
    except Exception as e:
        _mysql_available = False
        logger.warning(f"[Memory] MySQL unavailable: {e} — falling back to memory dict")
    return _mysql_available or False


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


# ─── Redis 连接（懒加载 + 优雅降级）──────────────────────────────
def _get_redis():
    """返回 Redis 客户端；不可用时返回 None。"""
    global _redis_client, _redis_available
    if _redis_available is False:
        return None
    if _redis_client is not None:
        return _redis_client
    try:
        import redis  # redis>=5.2.0 已在 requirements
        client = redis.Redis.from_url(
            settings.redis_dsn,
            socket_connect_timeout=2,
            socket_timeout=2,
            decode_responses=True,
        )
        client.ping()
        _redis_client = client
        _redis_available = True
        logger.info(f"[Memory] Redis connected ({settings.redis_dsn})")
    except Exception as e:
        _redis_client = None
        _redis_available = False
        logger.warning(f"[Memory] Redis unavailable ({settings.redis_dsn}): {e} — cache disabled")
    return _redis_client


def _redis_key_memory(scope: str, scope_id: str, mem_key: str) -> str:
    return f"autocode:memory:{scope}:{scope_id}:{mem_key}"


def _redis_key_search(query: str, scope: str, scope_id: str) -> str:
    h = hashlib.md5(f"{scope}|{scope_id}|{query}".encode("utf-8")).hexdigest()[:12]
    return f"autocode:search:{h}"


# ─── 建表（幂等，启动时调用）────────────────────────────────────
def init_table():
    """创建 L2 agent_memory 与 L3 memory_search 表（幂等）。同时建 FULLTEXT 索引。"""
    if not _test_mysql_connection():
        logger.warning("[Memory] init_table skipped — MySQL unavailable")
        return

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            # ── L2 温记忆 ──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS `agent_memory` (
                    `id`            BIGINT          NOT NULL AUTO_INCREMENT,
                    `scope`         VARCHAR(32)     NOT NULL DEFAULT 'task'
                                    COMMENT 'task | user | project | global',
                    `scope_id`      VARCHAR(64)     NOT NULL DEFAULT ''
                                    COMMENT 'task_id / user_id / project_id',
                    `mem_key`       VARCHAR(128)    NOT NULL COMMENT '记忆条目键/路径',
                    `title`         VARCHAR(200)    DEFAULT '' COMMENT '检索主题',
                    `content`       MEDIUMTEXT      NOT NULL COMMENT '记忆内容',
                    `content_type`  VARCHAR(32)     DEFAULT 'text' COMMENT 'text|json|code',
                    `privacy_level` VARCHAR(16)     DEFAULT 'public'
                                    COMMENT 'public|personal|sensitive|project',
                    `tags`          VARCHAR(500)    DEFAULT '' COMMENT '逗号分隔标签',
                    `related_tasks` VARCHAR(500)    DEFAULT '' COMMENT '关联任务ID',
                    `access_count`  INT             DEFAULT 0,
                    `last_accessed` DATETIME        DEFAULT NULL,
                    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (`id`),
                    UNIQUE KEY `uk_scope_key` (`scope`, `scope_id`, `mem_key`),
                    INDEX `idx_scope` (`scope`, `scope_id`),
                    INDEX `idx_updated` (`updated_at`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                  COMMENT='L2 温记忆：工作记忆条目'
            """)

            # ── L3 冷记忆（FULLTEXT ngram 支持中文分词）──
            cur.execute("""
                CREATE TABLE IF NOT EXISTS `memory_search` (
                    `id`            BIGINT          NOT NULL AUTO_INCREMENT,
                    `scope`         VARCHAR(32)     NOT NULL DEFAULT 'global',
                    `scope_id`      VARCHAR(64)     NOT NULL DEFAULT '',
                    `title`         VARCHAR(200)    NOT NULL DEFAULT '' COMMENT '检索主题',
                    `content`       MEDIUMTEXT      NOT NULL COMMENT '记忆内容',
                    `content_type`  VARCHAR(32)     DEFAULT 'text',
                    `privacy_level` VARCHAR(16)     DEFAULT 'public',
                    `tags`          VARCHAR(500)    DEFAULT '' COMMENT '逗号分隔标签',
                    `related_tasks` VARCHAR(500)    DEFAULT '' COMMENT '关联任务ID',
                    `source`        VARCHAR(64)     DEFAULT ''
                                    COMMENT '来源: workspace_file|chat|tool|manual',
                    `embedding_ref` VARCHAR(64)     DEFAULT ''
                                    COMMENT '预留: 轻量方案下为空（未用向量）',
                    `access_count`  INT             DEFAULT 0,
                    `last_accessed` DATETIME        DEFAULT NULL,
                    `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
                                    ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (`id`),
                    FULLTEXT INDEX `ft_content` (`title`, `content`, `tags`) WITH PARSER ngram,
                    INDEX `idx_scope` (`scope`, `scope_id`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
                  COMMENT='L3 冷记忆：长期语义检索库（MySQL FULLTEXT 替代 ES/Milvus）'
            """)
        logger.info("[Memory] agent_memory / memory_search tables ready")
    except Exception as e:
        logger.warning(f"[Memory] init_table failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─── L2 温记忆 CRUD ─────────────────────────────────────────────
def save_memory(
    scope: str, scope_id: str, mem_key: str, content,
    title: str = "", content_type: str = "text",
    privacy_level: str = "public", tags: list[str] | str = None,
    related_tasks: list[str] | str = None,
) -> dict:
    """写入/更新一条 L2 温记忆（UPSERT）。内容可为 str 或 dict/list（自动 JSON 化）。"""
    tags_s = ",".join(tags) if isinstance(tags, (list, tuple)) else (tags or "")
    rel_s = ",".join(related_tasks) if isinstance(related_tasks, (list, tuple)) else (related_tasks or "")
    content_s = _json_dump(content)
    title = title or (mem_key if isinstance(mem_key, str) else str(mem_key))
    entry = {
        "scope": scope, "scope_id": scope_id, "mem_key": mem_key,
        "title": title, "content": content_s, "content_type": content_type,
        "privacy_level": privacy_level, "tags": tags_s, "related_tasks": rel_s,
    }
    _memory_fallback[f"{scope}:{scope_id}:{mem_key}"] = entry

    if not _test_mysql_connection():
        return entry

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO agent_memory
                    (scope, scope_id, mem_key, title, content, content_type,
                     privacy_level, tags, related_tasks, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
                ON DUPLICATE KEY UPDATE
                    title=VALUES(title), content=VALUES(content),
                    content_type=VALUES(content_type), privacy_level=VALUES(privacy_level),
                    tags=VALUES(tags), related_tasks=VALUES(related_tasks),
                    updated_at=NOW()
            """, (scope, scope_id, mem_key, title, content_s, content_type,
                  privacy_level, tags_s, rel_s))
        # 写穿透 Redis
        r = _get_redis()
        if r:
            try:
                r.set(_redis_key_memory(scope, scope_id, mem_key),
                      json.dumps(entry, ensure_ascii=False), ex=3600)
            except Exception:
                pass
    except Exception as e:
        logger.warning(f"[Memory] save_memory failed (kept in memory): {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    return entry


def get_memory(scope: str, scope_id: str, mem_key: str) -> Optional[dict]:
    """读取一条 L2 温记忆：Redis → MySQL → 内存回退。命中后访问计数 +1。"""
    cache_key = _redis_key_memory(scope, scope_id, mem_key)
    r = _get_redis()
    if r:
        try:
            raw = r.get(cache_key)
            if raw:
                _bump_access(scope, scope_id, mem_key)
                return json.loads(raw)
        except Exception:
            pass

    if not _test_mysql_connection():
        return _memory_fallback.get(f"{scope}:{scope_id}:{mem_key}")

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT scope, scope_id, mem_key, title, content, content_type,
                       privacy_level, tags, related_tasks, access_count,
                       last_accessed, created_at, updated_at
                FROM agent_memory
                WHERE scope=%s AND scope_id=%s AND mem_key=%s
            """, (scope, scope_id, mem_key))
            row = cur.fetchone()
        if not row:
            return None
        entry = _row_to_entry(row)
        _bump_access(scope, scope_id, mem_key)
        if r:
            try:
                r.set(cache_key, json.dumps(entry, ensure_ascii=False), ex=3600)
            except Exception:
                pass
        return entry
    except Exception as e:
        logger.warning(f"[Memory] get_memory failed: {e}")
        return _memory_fallback.get(f"{scope}:{scope_id}:{mem_key}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _bump_access(scope: str, scope_id: str, mem_key: str):
    """异步式访问计数自增（best-effort，失败忽略）"""
    try:
        if not _test_mysql_connection():
            return
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                UPDATE agent_memory
                SET access_count = access_count + 1, last_accessed = NOW()
                WHERE scope=%s AND scope_id=%s AND mem_key=%s
            """, (scope, scope_id, mem_key))
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def delete_memory(scope: str, scope_id: str, mem_key: str):
    _memory_fallback.pop(f"{scope}:{scope_id}:{mem_key}", None)
    r = _get_redis()
    if r:
        try:
            r.delete(_redis_key_memory(scope, scope_id, mem_key))
        except Exception:
            pass
    if not _test_mysql_connection():
        return
    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                DELETE FROM agent_memory
                WHERE scope=%s AND scope_id=%s AND mem_key=%s
            """, (scope, scope_id, mem_key))
    except Exception as e:
        logger.warning(f"[Memory] delete_memory failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass


def list_memory(scope: str, scope_id: str, limit: int = 50) -> list[dict]:
    """列出某作用域下最近的 L2 温记忆条目（按 updated_at 倒序）。"""
    if not _test_mysql_connection():
        items = [v for k, v in _memory_fallback.items()
                 if k.startswith(f"{scope}:{scope_id}:")]
        return sorted(items, key=lambda x: x.get("updated_at", ""), reverse=True)[:limit]

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT scope, scope_id, mem_key, title, content, content_type,
                       privacy_level, tags, related_tasks, access_count, updated_at
                FROM agent_memory
                WHERE scope=%s AND scope_id=%s
                ORDER BY updated_at DESC
                LIMIT %s
            """, (scope, scope_id, limit))
            rows = cur.fetchall()
        return [_row_to_entry(r) for r in rows]
    except Exception as e:
        logger.warning(f"[Memory] list_memory failed: {e}")
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─── L3 冷记忆（语义检索库）─────────────────────────────────────
def save_cold(
    title: str, content, scope: str = "global", scope_id: str = "",
    content_type: str = "text", privacy_level: str = "public",
    tags: list[str] | str = None, related_tasks: list[str] | str = None,
    source: str = "manual",
) -> dict:
    """写入一条 L3 冷记忆（长期留存，可全文检索）。返回插入行。"""
    tags_s = ",".join(tags) if isinstance(tags, (list, tuple)) else (tags or "")
    rel_s = ",".join(related_tasks) if isinstance(related_tasks, (list, tuple)) else (related_tasks or "")
    content_s = _json_dump(content)
    if not _test_mysql_connection():
        logger.warning("[Memory] save_cold skipped — MySQL unavailable (cold store needs DB)")
        return {}

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO memory_search
                    (scope, scope_id, title, content, content_type, privacy_level,
                     tags, related_tasks, source, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
            """, (scope, scope_id, title, content_s, content_type,
                  privacy_level, tags_s, rel_s, source))
            new_id = cur.lastrowid
        return {
            "id": new_id, "scope": scope, "scope_id": scope_id, "title": title,
            "content": content_s, "tags": tags_s, "related_tasks": rel_s,
            "source": source,
        }
    except Exception as e:
        logger.warning(f"[Memory] save_cold failed: {e}")
        return {}
    finally:
        try:
            conn.close()
        except Exception:
            pass


def search(
    query: str, scope: str = None, scope_id: str = None,
    limit: int = 10, use_cache: bool = True,
) -> list[dict]:
    """
    L3 全文检索。优先 MySQL FULLTEXT(ngram) 自然语言模式；
    无结果时回退 LIKE 模糊匹配（兼容单字/短查询）。
    热门查询结果缓存到 Redis（5 分钟）。
    """
    if not query or not query.strip():
        return []

    q = query.strip()
    cache_key = _redis_key_search(q, scope or "*", scope_id or "*")
    r = _get_redis()
    if use_cache and r:
        try:
            raw = r.get(cache_key)
            if raw:
                return json.loads(raw)
        except Exception:
            pass

    if not _test_mysql_connection():
        logger.warning("[Memory] search skipped — MySQL unavailable")
        return []

    results: list[dict] = []
    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            # 1) FULLTEXT 自然语言模式（ngram 已支持中文）
            sql = """
                SELECT id, scope, scope_id, title, content, content_type,
                       privacy_level, tags, related_tasks, source,
                       MATCH(title, content, tags) AGAINST (%s IN NATURAL LANGUAGE MODE) AS score
                FROM memory_search
                WHERE MATCH(title, content, tags) AGAINST (%s IN NATURAL LANGUAGE MODE)
            """
            params = [q, q]
            if scope:
                sql += " AND scope=%s"
                params.append(scope)
            if scope_id:
                sql += " AND scope_id=%s"
                params.append(scope_id)
            sql += " ORDER BY score DESC LIMIT %s"
            params.append(limit)
            cur.execute(sql, params)
            rows = cur.fetchall()

            # 2) 回退 LIKE（FULLTEXT 对极短查询可能无匹配）
            if not rows:
                like = f"%{q}%"
                sql2 = """
                    SELECT id, scope, scope_id, title, content, content_type,
                           privacy_level, tags, related_tasks, source, 1.0 AS score
                    FROM memory_search
                    WHERE (title LIKE %s OR content LIKE %s OR tags LIKE %s)
                """
                params2 = [like, like, like]
                if scope:
                    sql2 += " AND scope=%s"
                    params2.append(scope)
                if scope_id:
                    sql2 += " AND scope_id=%s"
                    params2.append(scope_id)
                sql2 += " ORDER BY updated_at DESC LIMIT %s"
                params2.append(limit)
                cur.execute(sql2, params2)
                rows = cur.fetchall()

            results = [_cold_row_to_entry(r) for r in rows]
            # 访问计数自增
            if rows:
                ids = [r["id"] for r in rows]
                fmt = ",".join(["%s"] * len(ids))
                cur.execute(
                    f"UPDATE memory_search SET access_count=access_count+1, "
                    f"last_accessed=NOW() WHERE id IN ({fmt})", ids)
    except Exception as e:
        logger.warning(f"[Memory] search failed: {e}")
    finally:
        try:
            conn.close()
        except Exception:
            pass

    if use_cache and r and results:
        try:
            r.set(cache_key, json.dumps(results, ensure_ascii=False), ex=300)
        except Exception:
            pass
    return results


def search_warm(
    query: str, scope: str = None, scope_id: str = None,
    limit: int = 10, user_id: str = None,
) -> list[dict]:
    """
    L2 温记忆跨任务检索（LIKE 模糊匹配）。
    隐私过滤：默认仅返回 public/project 级别；若提供 user_id，额外返回该用户
    拥有的 personal/sensitive 记忆（scope=user 且 scope_id=user_id）。
    MySQL 不可用时回退内存字典子串匹配。
    """
    if not query or not query.strip():
        return []
    q = query.strip()

    def _matched(entry: dict) -> bool:
        blob = " ".join(str(entry.get(k, "")) for k in ("title", "content", "tags"))
        return q in blob

    def _allowed(entry: dict) -> bool:
        pl = entry.get("privacy_level", "public")
        if pl in ("public", "project"):
            return True
        if user_id and entry.get("scope") == "user" and str(entry.get("scope_id")) == str(user_id):
            return True
        return False

    if not _test_mysql_connection():
        items = [v for v in _memory_fallback.values() if _matched(v) and _allowed(v)]
        out = []
        for v in items:
            e = dict(v)
            e["score"] = 1.0
            e["layer"] = "warm"
            out.append(e)
        return out[:limit]

    like = f"%{q}%"
    clauses = ["(title LIKE %s OR content LIKE %s OR tags LIKE %s)"]
    params = [like, like, like]
    if user_id:
        clauses.append("(privacy_level IN ('public', 'project') "
                       "OR (scope='user' AND scope_id=%s))")
        params.append(str(user_id))
    else:
        clauses.append("privacy_level IN ('public', 'project')")
    where = " AND ".join(clauses)

    sql = f"""
        SELECT scope, scope_id, mem_key, title, content, content_type,
               privacy_level, tags, related_tasks, access_count, updated_at, 1.0 AS score
        FROM agent_memory
        WHERE {where}
    """
    if scope:
        sql += " AND scope=%s"
        params.append(scope)
    if scope_id:
        sql += " AND scope_id=%s"
        params.append(scope_id)
    sql += " ORDER BY updated_at DESC LIMIT %s"
    params.append(limit)

    try:
        conn = _get_connection()
        with conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        out = []
        for r in rows:
            e = _row_to_entry(r)
            e["score"] = round(float(r.get("score", 1.0) or 1.0), 4)
            e["layer"] = "warm"
            out.append(e)
        return out
    except Exception as e:
        logger.warning(f"[Memory] search_warm failed: {e}")
        return []
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─── 行 -> dict 转换 ────────────────────────────────────────────
def _row_to_entry(row: dict) -> dict:
    return {
        "scope": row["scope"],
        "scope_id": row["scope_id"],
        "mem_key": row["mem_key"],
        "title": row.get("title", ""),
        "content": _json_load(row["content"], row["content"]),
        "content_type": row.get("content_type", "text"),
        "privacy_level": row.get("privacy_level", "public"),
        "tags": row.get("tags", "") or "",
        "related_tasks": row.get("related_tasks", "") or "",
        "access_count": row.get("access_count", 0) or 0,
        "updated_at": row.get("updated_at"),
    }


def _cold_row_to_entry(row: dict) -> dict:
    return {
        "id": row["id"],
        "scope": row["scope"],
        "scope_id": row["scope_id"],
        "title": row.get("title", ""),
        "content": _json_load(row["content"], row["content"]),
        "content_type": row.get("content_type", "text"),
        "privacy_level": row.get("privacy_level", "public"),
        "tags": row.get("tags", "") or "",
        "related_tasks": row.get("related_tasks", "") or "",
        "source": row.get("source", ""),
        "score": round(float(row.get("score", 0.0) or 0.0), 4),
    }


# ─── 模块级单例（orchestrator / main 直接 import 使用）───────────
class MemoryService:
    """面向编排层的轻量封装（语义化方法名）"""

    def init(self):
        init_table()

    def put_workspace_plan(self, task_id: str, plan_md: str, title: str = ""):
        """任务启动：写入 L2 工作记忆（PLAN）。"""
        return save_memory("task", task_id, "PLAN", plan_md,
                           title=title or "项目计划", content_type="text",
                           privacy_level="project", tags=["plan"])

    def put_workspace_memory(self, task_id: str, memory_md: str, title: str = ""):
        """任务启动：写入 L2 执行记忆（MEMORY.md）。"""
        return save_memory("task", task_id, "MEMORY", memory_md,
                           title=title or "执行记忆", content_type="text",
                           privacy_level="project", tags=["memory"])

    def update_workspace_status(self, task_id: str, status: str, phase: str):
        """状态变更：更新 L2 记忆中的状态字段（增量，不覆盖全文）。"""
        existing = get_memory("task", task_id, "MEMORY")
        if not existing:
            return None
        content = existing["content"]
        if isinstance(content, str):
            import re as _re
            content = _re.sub(r'\*\*状态\*\*:.*', f'**状态**: {status}', content)
            content = _re.sub(r'\*\*当前阶段\*\*:.*', f'**当前阶段**: {phase}', content)
        return save_memory("task", task_id, "MEMORY", content,
                           title=existing.get("title", "执行记忆"),
                           content_type="text", privacy_level="project",
                           tags=["memory"])

    def archive_cold(self, title: str, content, scope: str = "global",
                     scope_id: str = "", tags: list[str] = None,
                     related_tasks: list[str] = None, source: str = "workspace_file"):
        """将值得长期留存的内容写入 L3 冷记忆。"""
        return save_cold(title, content, scope=scope, scope_id=scope_id,
                         tags=tags, related_tasks=related_tasks, source=source)

    def recall(self, query: str, scope: str = None, scope_id: str = None,
               limit: int = 10) -> list[dict]:
        return search(query, scope=scope, scope_id=scope_id, limit=limit)

    def recall_all(self, query: str, scope: str = None, scope_id: str = None,
                   limit: int = 10, user_id: str = None) -> list[dict]:
        """跨任务召回：合并 L3 冷记忆(recall) 与 L2 温记忆(search_warm)，按 score 降序。"""
        cold = search(query, scope=scope, scope_id=scope_id, limit=limit)
        for r in cold:
            r.setdefault("layer", "cold")
        warm = search_warm(query, scope=scope, scope_id=scope_id, limit=limit, user_id=user_id)
        for r in warm:
            r.setdefault("layer", "warm")
        merged = cold + warm
        merged.sort(key=lambda x: float(x.get("score", 0.0)), reverse=True)
        return merged[:limit]


# 全局单例
memory_service = MemoryService()
