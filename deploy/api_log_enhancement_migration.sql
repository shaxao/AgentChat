-- Enhance api_log for request diagnostics.
-- Compatible with MySQL versions that do not support ADD COLUMN IF NOT EXISTS.

SET @db_name = DATABASE();

SET @sql = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = @db_name
        AND table_name = 'api_log'
        AND column_name = 'request_ip'
        AND character_maximum_length < 100
    ),
    'ALTER TABLE api_log MODIFY COLUMN request_ip VARCHAR(100)',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = @db_name
        AND table_name = 'api_log'
        AND column_name = 'provider'
    ),
    'ALTER TABLE api_log ADD COLUMN provider VARCHAR(50) NULL AFTER request_ip',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @sql = (
  SELECT IF(
    NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = @db_name
        AND table_name = 'api_log'
        AND column_name = 'channel_id'
    ),
    'ALTER TABLE api_log ADD COLUMN channel_id VARCHAR(100) NULL AFTER provider',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
