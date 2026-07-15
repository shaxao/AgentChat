-- Scene-aware billing policy for chat/autocode/workflow.
-- Safe defaults: wallet fallback is disabled unless an admin explicitly enables it in features JSON.

DROP PROCEDURE IF EXISTS add_column_if_missing;

DELIMITER $$

CREATE PROCEDURE add_column_if_missing(
    IN table_name_in VARCHAR(64),
    IN column_name_in VARCHAR(64),
    IN column_def_in TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = table_name_in
          AND column_name = column_name_in
    ) THEN
        SET @ddl = CONCAT('ALTER TABLE `', table_name_in, '` ADD COLUMN `', column_name_in, '` ', column_def_in);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

DELIMITER ;

CALL add_column_if_missing('subscription_plan', 'features', 'TEXT NULL COMMENT ''Plan features and scene billing policy JSON'' AFTER `model_limit`');
CALL add_column_if_missing('subscription', 'features', 'TEXT NULL COMMENT ''Subscription-level features and scene billing policy override JSON'' AFTER `model_limit`');

DROP PROCEDURE add_column_if_missing;

-- Optional enterprise example. Adjust values before running in production.
-- UPDATE subscription_plan
-- SET features = JSON_SET(
--   COALESCE(NULLIF(features, ''), JSON_OBJECT()),
--   '$.billing.scenes.chat', JSON_OBJECT(
--     'enabled', true,
--     'costLimit', 100,
--     'walletFallbackEnabled', false,
--     'walletFallbackMonthlyLimit', 0,
--     'upstreamBillingMode', 'metered'
--   ),
--   '$.billing.scenes.autocode', JSON_OBJECT(
--     'enabled', true,
--     'costLimit', 200,
--     'walletFallbackEnabled', false,
--     'walletFallbackMonthlyLimit', 0,
--     'upstreamBillingMode', 'coding_plan'
--   )
-- )
-- WHERE code = 'enterprise' AND deleted = 0;
