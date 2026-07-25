-- Usage/cost transparency migration.
-- Safe to run repeatedly on MySQL 5.7/8.x.

SET @schema_name = DATABASE();

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='input_price_snapshot'),
    'ALTER TABLE api_log ADD COLUMN input_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Input price snapshot, CNY per 1M tokens'' AFTER output_tokens',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='cached_input_price_snapshot'),
    'ALTER TABLE api_log ADD COLUMN cached_input_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Cached input price snapshot, CNY per 1M tokens'' AFTER input_price_snapshot',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='output_price_snapshot'),
    'ALTER TABLE api_log ADD COLUMN output_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Output price snapshot, CNY per 1M tokens'' AFTER cached_input_price_snapshot',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='input_cost'),
    'ALTER TABLE api_log ADD COLUMN input_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Input cost, CNY'' AFTER output_price_snapshot',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='cached_input_cost'),
    'ALTER TABLE api_log ADD COLUMN cached_input_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Cached input cost, CNY'' AFTER input_cost',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='output_cost'),
    'ALTER TABLE api_log ADD COLUMN output_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Output cost, CNY'' AFTER cached_input_cost',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- If an early draft migration created zero-filled breakdown columns for old paid rows,
-- mark those rows as legacy again so the API can estimate the split while preserving total cost.
SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='input_price_snapshot')
    AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='output_cost'),
    'UPDATE api_log SET input_price_snapshot=NULL, cached_input_price_snapshot=NULL, output_price_snapshot=NULL, input_cost=NULL, cached_input_cost=NULL, output_cost=NULL WHERE COALESCE(cost,0) > 0 AND (COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) > 0 AND COALESCE(input_price_snapshot,0)=0 AND COALESCE(cached_input_price_snapshot,0)=0 AND COALESCE(output_price_snapshot,0)=0 AND COALESCE(input_cost,0)=0 AND COALESCE(cached_input_cost,0)=0 AND COALESCE(output_cost,0)=0',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='input_price_snapshot'),
    'ALTER TABLE api_log MODIFY COLUMN input_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Input price snapshot, CNY per 1M tokens''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='cached_input_price_snapshot'),
    'ALTER TABLE api_log MODIFY COLUMN cached_input_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Cached input price snapshot, CNY per 1M tokens''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='output_price_snapshot'),
    'ALTER TABLE api_log MODIFY COLUMN output_price_snapshot DECIMAL(12,6) NULL DEFAULT NULL COMMENT ''Output price snapshot, CNY per 1M tokens''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='input_cost'),
    'ALTER TABLE api_log MODIFY COLUMN input_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Input cost, CNY''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='cached_input_cost'),
    'ALTER TABLE api_log MODIFY COLUMN cached_input_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Cached input cost, CNY''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='api_log' AND column_name='output_cost'),
    'ALTER TABLE api_log MODIFY COLUMN output_cost DECIMAL(12,8) NULL DEFAULT NULL COMMENT ''Output cost, CNY''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='api_log')
    AND NOT EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=@schema_name AND table_name='api_log' AND index_name='idx_api_log_user_created'),
    'ALTER TABLE api_log ADD INDEX idx_api_log_user_created (user_id, created_at)',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
