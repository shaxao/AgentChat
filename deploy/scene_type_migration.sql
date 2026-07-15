-- Add scene_type column to api_log for distinguishing source (chat/autocode/translate/etc).
-- Compatible with MySQL versions that do not support ADD COLUMN IF NOT EXISTS.

SET @db_name = DATABASE();

SET @sql = (
  SELECT IF(
    NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = @db_name
        AND table_name = 'api_log'
        AND column_name = 'scene_type'
    ),
    'ALTER TABLE api_log ADD COLUMN scene_type VARCHAR(50) NOT NULL DEFAULT ''chat'' COMMENT ''场景类型：chat/autocode/translate/image/asr'' AFTER model',
    'SELECT 1'
  )
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
