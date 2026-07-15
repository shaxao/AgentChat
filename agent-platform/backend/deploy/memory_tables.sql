-- ============================================================
-- 五层记忆模型 — L2 / L3 数据表（轻量替代 ES / Milvus）
-- 库: MuHuoAi  |  引擎: InnoDB  |  字符集: utf8mb4
-- 说明:
--   * agent_memory  = L2 温记忆（任务/用户/项目级工作记忆，热点缓存到 Redis）
--   * memory_search = L3 冷记忆（长期语义检索库，FULLTEXT ngram 支持中文分词）
-- 幂等：可重复执行（CREATE TABLE IF NOT EXISTS）。
-- 应用启动时也会通过 services.memory_service.init() 自动建表，本文件供手动/CI 使用。
-- ============================================================

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
  COMMENT='L2 温记忆：工作记忆条目';

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
  COMMENT='L3 冷记忆：长期语义检索库（MySQL FULLTEXT 替代 ES/Milvus）';
