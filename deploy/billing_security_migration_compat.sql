-- Compatible billing migration for MySQL/MariaDB versions that do not support
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS.

DROP PROCEDURE IF EXISTS add_column_if_missing;

DELIMITER $$
CREATE PROCEDURE add_column_if_missing(
    IN p_table_name VARCHAR(64),
    IN p_column_name VARCHAR(64),
    IN p_definition TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = p_table_name
          AND column_name = p_column_name
    ) THEN
        SET @ddl = CONCAT(
            'ALTER TABLE `', p_table_name, '` ADD COLUMN `',
            p_column_name, '` ', p_definition
        );
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

CALL add_column_if_missing('model_config', 'cached_input_price', 'DECIMAL(10,4) NOT NULL DEFAULT 0 AFTER `input_price`');
CALL add_column_if_missing('api_log', 'cached_input_tokens', 'INT DEFAULT 0 AFTER `input_tokens`');
CALL add_column_if_missing('subscription_plan', 'cost_limit', 'DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER `price`');
CALL add_column_if_missing('subscription', 'cost_limit', 'DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER `price`');
CALL add_column_if_missing('subscription', 'cost_used', 'DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER `cost_limit`');
CALL add_column_if_missing('sys_user', 'cost_used', 'DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER `tokens_limit`');
CALL add_column_if_missing('sys_user', 'cost_limit', 'DECIMAL(12,4) NOT NULL DEFAULT 0 AFTER `cost_used`');

ALTER TABLE api_log
    MODIFY COLUMN cost DECIMAL(12,8) DEFAULT 0;

UPDATE model_config
SET cached_input_price = input_price
WHERE cached_input_price IS NULL OR cached_input_price = 0;

UPDATE subscription_plan
SET cost_limit = price
WHERE cost_limit IS NULL OR cost_limit = 0;

UPDATE subscription
SET cost_limit = price
WHERE cost_limit IS NULL OR cost_limit = 0;

UPDATE sys_user
SET cost_used = COALESCE(total_consumed, 0)
WHERE cost_used IS NULL OR cost_used = 0;

DROP PROCEDURE IF EXISTS add_column_if_missing;
