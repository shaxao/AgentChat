# -*- coding: utf-8 -*-
"""
AutoCode 数据库自动迁移模块

在应用启动时（MySQL 可用时）自动执行：
1. 创建 autocode_model_routing 表（如果不存在）
2. 扩展 model_config 表字段（code_quality, strengths）
3. 插入默认种子数据（路由规则）
4. 更新现有模型的代码质量评分

所有操作都是幂等的——多次执行不会重复插入或报错。
"""
import json
import logging
from datetime import datetime

import pymysql
from pymysql.cursors import DictCursor

from core.config import settings

logger = logging.getLogger("autocode.migrations")

# 已执行的迁移版本号（可用于未来增量迁移）
MIGRATION_VERSION = 1


def _get_conn():
    """获取数据库连接"""
    return pymysql.connect(
        host=settings.muhugochat_db_host,
        port=settings.muhugochat_db_port,
        user=settings.muhugochat_db_user,
        password=settings.muhugochat_db_password,
        database=settings.muhugochat_db_name,
        charset="utf8mb4",
        cursorclass=DictCursor,
        autocommit=True,
    )


def _add_column_if_not_exists(conn, table: str, col_name: str, col_def: str) -> bool:
    """
    安全添加列（MySQL 5.7 兼容）。
    返回 True 表示新增了列，False 表示列已存在。
    """
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COUNT(*) AS cnt
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = %s
          AND TABLE_NAME = %s
          AND COLUMN_NAME = %s
    """, (settings.muhugochat_db_name, table, col_name))
    row = cursor.fetchone()
    if row and row["cnt"] > 0:
        return False

    sql = f"ALTER TABLE `{table}` ADD COLUMN `{col_name}` {col_def}"
    cursor.execute(sql)
    return True


def _table_exists(conn, table: str) -> bool:
    """检查表是否存在"""
    cursor = conn.cursor()
    cursor.execute("""
        SELECT COUNT(*) AS cnt
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = %s
          AND TABLE_NAME = %s
    """, (settings.muhugochat_db_name, table))
    row = cursor.fetchone()
    return row and row["cnt"] > 0


def _has_rows(conn, table: str) -> bool:
    """检查表是否有数据"""
    cursor = conn.cursor()
    cursor.execute(f"SELECT COUNT(*) AS cnt FROM `{table}`")
    row = cursor.fetchone()
    return row and row["cnt"] > 0


def _create_routing_table(conn) -> bool:
    """创建路由规则表（幂等）"""
    if _table_exists(conn, "autocode_model_routing"):
        logger.info("[Migration] autocode_model_routing 表已存在，跳过建表")
        return False

    logger.info("[Migration] 创建 autocode_model_routing 表...")
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE autocode_model_routing (
            id              BIGINT          AUTO_INCREMENT PRIMARY KEY,

            -- 路由匹配条件（'*' 表示通配，匹配所有）
            agent_type      VARCHAR(50)     NOT NULL DEFAULT '*',
            task_phase      VARCHAR(50)     NOT NULL DEFAULT '*',
            content_type    VARCHAR(50)     NOT NULL DEFAULT '*',
            complexity      VARCHAR(20)     NOT NULL DEFAULT '*',

            -- 模型标识（对应 model_config.model_id）
            model_id        VARCHAR(100)    NOT NULL,

            -- 权重与排序
            priority        INT             NOT NULL DEFAULT 100,
            weight_bonus    DECIMAL(3,2)    NOT NULL DEFAULT 0.00 COMMENT '场景亲和度加成(0.00~1.00)',
            failover_order  INT             NOT NULL DEFAULT 0 COMMENT '故障转移优先级，0=不使用',

            -- 管理字段
            enabled         TINYINT(1)      NOT NULL DEFAULT 1,
            created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

            INDEX idx_agent_type   (agent_type),
            INDEX idx_task_phase   (task_phase),
            INDEX idx_content_type (content_type),
            INDEX idx_complexity   (complexity),
            INDEX idx_model_id     (model_id),
            INDEX idx_enabled      (enabled),
            INDEX idx_lookup       (agent_type, task_phase, content_type, complexity, enabled)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AutoCode 智能模型路由规则表'
    """)
    return True


def _extend_model_config(conn) -> list[str]:
    """扩展 model_config 表字段（幂等）"""
    added = []

    if _add_column_if_not_exists(conn, "model_config", "code_quality",
                                 "INT DEFAULT 60 COMMENT '代码质量评分 (0-100)'"):
        added.append("code_quality")

    if _add_column_if_not_exists(conn, "model_config", "strengths",
                                 "JSON DEFAULT NULL COMMENT '擅长领域'"):
        added.append("strengths")

    return added


SEED_RULES = [
    # ── Researcher Agent ──
    ("researcher", "*", "text", "*", "deepseek-v4-pro", 90, 0.15, 1),
    ("researcher", "*", "text", "*", "gpt-oss-120b", 85, 0.10, 2),
    ("researcher", "*", "text", "*", "claude-sonnet-4-20250514", 80, 0.05, 3),
    # ── Frontend Agent ──
    ("frontend", "implementation", "code", "complex", "claude-sonnet-4-20250514", 100, 0.20, 1),
    ("frontend", "implementation", "code", "moderate", "deepseek-v4-pro", 95, 0.15, 1),
    ("frontend", "implementation", "code", "simple", "deepseek-chat", 100, 0.10, 1),
    ("frontend", "debugging", "code", "*", "claude-sonnet-4-20250514", 95, 0.15, 1),
    ("frontend", "planning", "text", "*", "deepseek-v4-pro", 90, 0.10, 1),
    # ── Backend Agent ──
    ("backend", "implementation", "code", "complex", "claude-sonnet-4-20250514", 100, 0.20, 1),
    ("backend", "implementation", "code", "moderate", "deepseek-v4-pro", 95, 0.15, 1),
    ("backend", "implementation", "code", "simple", "deepseek-chat", 100, 0.10, 1),
    ("backend", "debugging", "code", "*", "claude-sonnet-4-20250514", 95, 0.15, 1),
    ("backend", "planning", "text", "*", "deepseek-v4-pro", 90, 0.10, 1),
    # ── DevOps Agent ──
    ("devops", "*", "*", "*", "deepseek-chat", 90, 0.05, 1),
    ("devops", "*", "*", "*", "gpt-oss-120b", 85, 0.05, 2),
    # ── 通配回退 ──
    ("*", "*", "*", "complex", "claude-sonnet-4-20250514", 70, 0.05, 3),
    ("*", "*", "*", "complex", "deepseek-v4-pro", 65, 0.05, 4),
    ("*", "*", "*", "*", "deepseek-chat", 60, 0.00, 5),
    ("*", "*", "*", "*", "gpt-oss-20b", 55, 0.00, 6),
]


def _insert_seed_data(conn) -> int:
    """插入种子数据（幂等，INSERT IGNORE）"""
    if not _table_exists(conn, "autocode_model_routing"):
        return 0

    if _has_rows(conn, "autocode_model_routing"):
        logger.info("[Migration] 路由规则表已有数据，跳过种子数据插入")
        return 0

    cursor = conn.cursor()
    inserted = 0
    for (agent_type, task_phase, content_type, complexity,
         model_id, priority, weight_bonus, failover_order) in SEED_RULES:
        try:
            cursor.execute("""
                INSERT IGNORE INTO autocode_model_routing
                    (agent_type, task_phase, content_type, complexity,
                     model_id, priority, weight_bonus, failover_order, enabled)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 1)
            """, (agent_type, task_phase, content_type, complexity,
                  model_id, priority, weight_bonus, failover_order))
            inserted += cursor.rowcount
        except Exception as e:
            logger.warning(f"[Migration] 插入种子数据失败: {e}")
            continue

    logger.info(f"[Migration] 插入 {inserted} 条种子规则")
    return inserted


MODEL_QUALITY_UPDATES = [
    ("claude-sonnet-4-20250514", 92, ["frontend", "backend", "code_generation", "debugging"]),
    ("deepseek-v4-pro", 88, ["reasoning", "research", "planning", "code_generation"]),
    ("deepseek-chat", 78, ["code_generation", "devops", "general"]),
    ("gpt-oss-120b", 85, ["reasoning", "research", "text_generation"]),
    ("gpt-oss-20b", 72, ["fast_response", "general", "summarization"]),
]


def _update_model_quality(conn) -> int:
    """更新现有模型的代码质量评分（仅更新 NULL 值）"""
    cursor = conn.cursor()
    updated = 0
    for model_id, quality, strengths in MODEL_QUALITY_UPDATES:
        cursor.execute(
            "UPDATE model_config SET code_quality = %s, strengths = %s "
            "WHERE model_id = %s AND (code_quality IS NULL OR code_quality = 0)",
            (quality, json.dumps(strengths, ensure_ascii=False), model_id)
        )
        updated += cursor.rowcount
    if updated:
        logger.info(f"[Migration] 更新 {updated} 个模型的代码质量评分")
    return updated


async def run_migrations() -> bool:
    """
    执行所有数据库迁移（幂等）。

    在应用启动时调用，MySQL 可用时自动运行。
    迁移失败不会阻止应用启动，只会记录警告。

    返回 True 表示有迁移被执行。
    """
    try:
        conn = _get_conn()
    except Exception as e:
        logger.warning(f"[Migration] 无法连接 MySQL，跳过迁移: {e}")
        return False

    try:
        made_changes = False

        # 1. 建表
        if _create_routing_table(conn):
            made_changes = True

        # 2. 扩展 model_config
        added_cols = _extend_model_config(conn)
        if added_cols:
            logger.info(f"[Migration] model_config 新增列: {', '.join(added_cols)}")
            made_changes = True

        # 3. 种子数据
        if _insert_seed_data(conn) > 0:
            made_changes = True

        # 4. 模型质量评分
        if _update_model_quality(conn) > 0:
            made_changes = True

        if made_changes:
            logger.info("[Migration] ✅ 数据库迁移完成")
        else:
            logger.info("[Migration] ✅ 数据库已是最新状态，无需迁移")

        return made_changes

    except Exception as e:
        logger.error(f"[Migration] ❌ 迁移执行失败: {e}", exc_info=True)
        return False
    finally:
        try:
            conn.close()
        except Exception:
            pass
