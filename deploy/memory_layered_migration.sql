-- ============================================================================
-- 记忆分层管理迁移（轻量级：MySQL 原生，不引入 ES / Milvus）
-- 对应 docs/memory_layered_architecture.md
-- 幂等：可重复执行（基于 information_schema 判定，兼容不支持 ADD COLUMN IF NOT EXISTS 的 MySQL 版本）
-- 通过 deploy.ps1 的 migrate-db 执行
-- ============================================================================

SET @db_name = DATABASE();

-- ----------------------------------------------------------------------------
-- 1. memory_document 新增分层字段
-- ----------------------------------------------------------------------------
SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND column_name = 'layer'),
    'ALTER TABLE memory_document ADD COLUMN layer VARCHAR(8) NOT NULL DEFAULT ''L1'' COMMENT ''记忆层级 L1热/L2温/L3冷/L4归档'' AFTER status',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND column_name = 'virtual_path'),
    'ALTER TABLE memory_document ADD COLUMN virtual_path VARCHAR(512) COMMENT ''VFS 虚拟路径，如 /memory/hot/USER.md'' AFTER layer',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND column_name = 'access_count'),
    'ALTER TABLE memory_document ADD COLUMN access_count INT NOT NULL DEFAULT 0 COMMENT ''访问计数，用于归档决策'' AFTER virtual_path',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND column_name = 'last_accessed_at'),
    'ALTER TABLE memory_document ADD COLUMN last_accessed_at DATETIME COMMENT ''最近访问时间'' AFTER access_count',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----------------------------------------------------------------------------
-- 2. memory_index 新增分层字段
-- ----------------------------------------------------------------------------
SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_index' AND column_name = 'layer'),
    'ALTER TABLE memory_index ADD COLUMN layer VARCHAR(8) NOT NULL DEFAULT ''L2'' COMMENT ''记忆层级'' AFTER deleted',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_index' AND column_name = 'virtual_path'),
    'ALTER TABLE memory_index ADD COLUMN virtual_path VARCHAR(512) COMMENT ''VFS 虚拟路径'' AFTER layer',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_index' AND column_name = 'access_count'),
    'ALTER TABLE memory_index ADD COLUMN access_count INT NOT NULL DEFAULT 0 COMMENT ''访问计数'' AFTER virtual_path',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = @db_name AND table_name = 'memory_index' AND column_name = 'last_accessed_at'),
    'ALTER TABLE memory_index ADD COLUMN last_accessed_at DATETIME COMMENT ''最近访问时间'' AFTER access_count',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----------------------------------------------------------------------------
-- 3. 新增 L4 归档表（内容下沉，原表仅留摘要指针）
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_archive (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    source_doc_id   BIGINT       COMMENT '来源 memory_document.id',
    title           VARCHAR(300) NOT NULL,
    doc_type        VARCHAR(30),
    category        VARCHAR(100),
    content         MEDIUMTEXT   COMMENT '下沉的完整内容',
    summary         VARCHAR(500),
    tags            VARCHAR(500),
    layer_from      VARCHAR(8)   COMMENT '归档前层级',
    archived_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    restore_key     VARCHAR(64)  COMMENT '恢复密钥，便于从归档拉回',
    KEY idx_ma_user_id (user_id),
    KEY idx_ma_source_doc (source_doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='L4 归档记忆（内容下沉）';

-- ----------------------------------------------------------------------------
-- 4. 普通索引（归档/压缩任务用）
-- ----------------------------------------------------------------------------
SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.statistics
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND index_name = 'idx_md_layer'),
    'ALTER TABLE memory_document ADD INDEX idx_md_layer (layer)',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (SELECT 1 FROM information_schema.statistics
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND index_name = 'idx_md_last_accessed'),
    'ALTER TABLE memory_document ADD INDEX idx_md_last_accessed (last_accessed_at)',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----------------------------------------------------------------------------
-- 5. 轻量级语义搜索：MySQL FULLTEXT + ngram 解析器（中文分词）
--    仅当 MySQL >= 5.7.6（ngram 内置）时创建；否则跳过（LIKE 兜底仍可用）
-- ----------------------------------------------------------------------------
SET @mysql_ver = (SELECT SUBSTRING_INDEX(VERSION(), '-', 1));
SET @ngram_ok = (SELECT IF(@mysql_ver >= '5.7.6', 1, 0));

-- memory_document: title + content
SET @sql = (
  SELECT IF(
    @ngram_ok = 1 AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
                WHERE table_schema = @db_name AND table_name = 'memory_document' AND index_name = 'ft_doc_content'),
    'ALTER TABLE memory_document ADD FULLTEXT INDEX ft_doc_content (title, content) WITH PARSER ngram',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- memory_index: summary + tags
SET @sql = (
  SELECT IF(
    @ngram_ok = 1 AND NOT EXISTS (SELECT 1 FROM information_schema.statistics
                WHERE table_schema = @db_name AND table_name = 'memory_index' AND index_name = 'ft_idx_summary'),
    'ALTER TABLE memory_index ADD FULLTEXT INDEX ft_idx_summary (summary, tags) WITH PARSER ngram',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ----------------------------------------------------------------------------
-- 6. 历史数据回填（layer + virtual_path），幂等可重复执行
--    注意：layer 列定义为 NOT NULL DEFAULT 'L1'，新增后所有历史行已为 'L1'，
--    WHERE layer IS NULL 永不命中，因此改为按 doc_type 直接定级。
--    文档层：work_file_meta→L4、user_profile/secret/SOUL.md 保持 L1、其余→L2。
-- ----------------------------------------------------------------------------

-- 6.1 memory_document 定级（从 L1 默认值重映射到正确层级）
-- Step 1: work_file_meta → L4（文件元数据，仅索引不注入）
UPDATE memory_document SET layer = 'L4' WHERE doc_type = 'work_file_meta';
-- Step 2: user_profile / secret / SOUL.md 保持 L1（已是默认值，无需改动）
-- Step 3: 其余类型 → L2（温记忆：对话摘要 / 项目记忆等）
UPDATE memory_document
   SET layer = 'L2'
 WHERE layer = 'L1'
   AND doc_type NOT IN ('user_profile', 'secret', 'memory_setting')
   AND NOT (doc_type = 'conversation_summary' AND title = 'SOUL.md');

-- 6.2 memory_document virtual_path（按对话隔离；全局归到 /global/）
UPDATE memory_document
   SET virtual_path = CONCAT('/memory/', LOWER(layer), '/', CAST(conversation_id AS CHAR), '/', REPLACE(title, ' ', '_'))
 WHERE virtual_path IS NULL AND conversation_id IS NOT NULL;

UPDATE memory_document
   SET virtual_path = CONCAT('/memory/', LOWER(layer), '/global/', REPLACE(title, ' ', '_'))
 WHERE virtual_path IS NULL AND conversation_id IS NULL;

-- 6.3 memory_index 继承所属文档的 layer / virtual_path
--     索引层初始 DEFAULT 'L2'，JOIN 后始终按父文档同步（幂等）
UPDATE memory_index mi
  JOIN memory_document md ON mi.doc_id = md.id
   SET mi.layer = md.layer;

UPDATE memory_index mi
  JOIN memory_document md ON mi.doc_id = md.id
   SET mi.virtual_path = md.virtual_path
 WHERE mi.virtual_path IS NULL;

SELECT 'memory_layered_migration done.' AS result;
