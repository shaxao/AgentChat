-- Model routing rule compatibility migration.
-- Safe to run repeatedly on MySQL 5.7/8.0+.
--
-- This script fixes databases created by older routing migrations that used
-- `name` / `required_capabilities` and did not include newer rule constraints.

CREATE TABLE IF NOT EXISTS model_routing_rule (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL COMMENT 'NULL means global rule; non-null means user-owned rule',
    rule_name VARCHAR(100) NOT NULL COMMENT 'Rule name',
    description VARCHAR(500) NULL COMMENT 'Rule description',
    scene_type VARCHAR(50) NOT NULL COMMENT 'Scene type: chat/vision/code/image/agent',
    agent_type VARCHAR(50) NULL COMMENT 'Optional agent type',
    complexity VARCHAR(20) NULL COMMENT 'simple/moderate/complex',
    required_tags VARCHAR(255) NULL COMMENT 'Required capability tags JSON array',
    preferred_providers VARCHAR(255) NULL COMMENT 'Preferred providers JSON array',
    min_context_length INT NULL COMMENT 'Minimum context length',
    max_input_price DECIMAL(12,6) NULL COMMENT 'Maximum input price',
    max_output_price DECIMAL(12,6) NULL COMMENT 'Maximum output price',
    priority INT NOT NULL DEFAULT 0 COMMENT 'Higher value means higher priority',
    enabled TINYINT NOT NULL DEFAULT 1 COMMENT 'Whether enabled',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted TINYINT NOT NULL DEFAULT 0,
    INDEX idx_rrr_user_id (user_id),
    INDEX idx_rrr_scene_type (scene_type),
    INDEX idx_rrr_priority (priority),
    INDEX idx_rrr_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Model routing rules';

DROP PROCEDURE IF EXISTS add_model_routing_rule_column;
DROP PROCEDURE IF EXISTS add_model_routing_rule_index;
DROP PROCEDURE IF EXISTS copy_model_routing_rule_column_if_present;
DELIMITER $$
CREATE PROCEDURE add_model_routing_rule_column(
    IN p_column_name VARCHAR(64),
    IN p_column_def TEXT,
    IN p_after_column VARCHAR(64)
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_rule'
          AND column_name = p_column_name
    ) THEN
        SET @ddl = CONCAT(
            'ALTER TABLE model_routing_rule ADD COLUMN ',
            p_column_def,
            CASE
                WHEN p_after_column IS NULL OR p_after_column = '' THEN ''
                ELSE CONCAT(' AFTER ', p_after_column)
            END
        );
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

CREATE PROCEDURE add_model_routing_rule_index(
    IN p_index_name VARCHAR(64),
    IN p_index_def TEXT
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.statistics
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_rule'
          AND index_name = p_index_name
    ) THEN
        SET @ddl = CONCAT('ALTER TABLE model_routing_rule ADD INDEX ', p_index_name, ' ', p_index_def);
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

CREATE PROCEDURE copy_model_routing_rule_column_if_present(
    IN p_source_column VARCHAR(64),
    IN p_target_column VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_rule'
          AND column_name = p_source_column
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_rule'
          AND column_name = p_target_column
    ) THEN
        SET @copy_sql = CONCAT(
            'UPDATE model_routing_rule SET ',
            p_target_column,
            ' = ',
            p_source_column,
            ' WHERE (',
            p_target_column,
            ' IS NULL OR ',
            p_target_column,
            ' = '''') AND ',
            p_source_column,
            ' IS NOT NULL'
        );
        PREPARE stmt FROM @copy_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$
DELIMITER ;

CALL add_model_routing_rule_column('rule_name', 'rule_name VARCHAR(100) NULL COMMENT ''Rule name''', 'id');
CALL add_model_routing_rule_column('user_id', 'user_id BIGINT NULL COMMENT ''NULL means global rule; non-null means user-owned rule''', 'id');
CALL add_model_routing_rule_column('description', 'description VARCHAR(500) NULL COMMENT ''Rule description''', 'rule_name');
CALL add_model_routing_rule_column('scene_type', 'scene_type VARCHAR(50) NULL COMMENT ''Scene type: chat/vision/code/image/agent''', 'description');
CALL add_model_routing_rule_column('agent_type', 'agent_type VARCHAR(50) NULL COMMENT ''Optional agent type''', 'scene_type');
CALL add_model_routing_rule_column('complexity', 'complexity VARCHAR(20) NULL COMMENT ''simple/moderate/complex''', 'agent_type');
CALL add_model_routing_rule_column('required_tags', 'required_tags VARCHAR(255) NULL COMMENT ''Required capability tags JSON array''', 'complexity');
CALL add_model_routing_rule_column('preferred_providers', 'preferred_providers VARCHAR(255) NULL COMMENT ''Preferred providers JSON array''', 'required_tags');
CALL add_model_routing_rule_column('min_context_length', 'min_context_length INT NULL COMMENT ''Minimum context length''', 'preferred_providers');
CALL add_model_routing_rule_column('max_input_price', 'max_input_price DECIMAL(12,6) NULL COMMENT ''Maximum input price''', 'min_context_length');
CALL add_model_routing_rule_column('max_output_price', 'max_output_price DECIMAL(12,6) NULL COMMENT ''Maximum output price''', 'max_input_price');
CALL add_model_routing_rule_column('priority', 'priority INT NOT NULL DEFAULT 0 COMMENT ''Higher value means higher priority''', 'max_output_price');
CALL add_model_routing_rule_column('enabled', 'enabled TINYINT NOT NULL DEFAULT 1 COMMENT ''Whether enabled''', 'priority');
CALL add_model_routing_rule_column('created_at', 'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', 'enabled');
CALL add_model_routing_rule_column('updated_at', 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', 'created_at');
CALL add_model_routing_rule_column('deleted', 'deleted TINYINT NOT NULL DEFAULT 0', 'updated_at');
CALL add_model_routing_rule_index('idx_rrr_user_id', '(user_id)');

CALL copy_model_routing_rule_column_if_present('name', 'rule_name');
CALL copy_model_routing_rule_column_if_present('required_capabilities', 'required_tags');

UPDATE model_routing_rule
SET priority = 0
WHERE priority IS NULL;

UPDATE model_routing_rule
SET enabled = 1
WHERE enabled IS NULL;

UPDATE model_routing_rule
SET deleted = 0
WHERE deleted IS NULL;

-- Older builds created a hidden OpenAI-only provider preference before the
-- admin UI exposed this field. Treat that legacy value as "no preference" so
-- routing rules do not appear to have an unexplained constraint.
UPDATE model_routing_rule
SET preferred_providers = NULL
WHERE REPLACE(REPLACE(REPLACE(TRIM(COALESCE(preferred_providers, '')), '"', ''), '''', ''), ' ', '')
      IN ('OpenAI', '[OpenAI]');

-- Collapse duplicate active routing rules caused by repeated historical seed imports.
-- Keep the highest priority rule; when priority ties, keep the newest id.
UPDATE model_routing_rule r1
JOIN model_routing_rule r2
  ON r1.id <> r2.id
 AND COALESCE(r1.rule_name, '') = COALESCE(r2.rule_name, '')
 AND COALESCE(r1.scene_type, '') = COALESCE(r2.scene_type, '')
 AND COALESCE(r1.agent_type, '') = COALESCE(r2.agent_type, '')
 AND COALESCE(r1.complexity, '') = COALESCE(r2.complexity, '')
 AND COALESCE(r1.required_tags, '') = COALESCE(r2.required_tags, '')
 AND COALESCE(r1.preferred_providers, '') = COALESCE(r2.preferred_providers, '')
 AND COALESCE(r1.min_context_length, -1) = COALESCE(r2.min_context_length, -1)
 AND COALESCE(r1.max_input_price, -1) = COALESCE(r2.max_input_price, -1)
 AND COALESCE(r1.max_output_price, -1) = COALESCE(r2.max_output_price, -1)
 AND r1.deleted = 0
 AND r2.deleted = 0
 AND (
    COALESCE(r1.priority, 0) < COALESCE(r2.priority, 0)
    OR (COALESCE(r1.priority, 0) = COALESCE(r2.priority, 0) AND r1.id < r2.id)
 )
SET r1.deleted = 1;

DROP PROCEDURE IF EXISTS add_model_routing_rule_column;
DROP PROCEDURE IF EXISTS copy_model_routing_rule_column_if_present;

CREATE TABLE IF NOT EXISTS model_routing_stats (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    model_id VARCHAR(100) NOT NULL COMMENT 'Model id',
    scene_type VARCHAR(50) NOT NULL COMMENT 'Scene type',
    total_calls BIGINT NOT NULL DEFAULT 0 COMMENT 'Total calls',
    success_calls BIGINT NOT NULL DEFAULT 0 COMMENT 'Successful calls',
    failed_calls BIGINT NOT NULL DEFAULT 0 COMMENT 'Failed calls',
    avg_response_time INTEGER NOT NULL DEFAULT 0 COMMENT 'Average response time in ms',
    last_success_at DATETIME NULL COMMENT 'Last success time',
    last_failure_at DATETIME NULL COMMENT 'Last failure time',
    consecutive_failures INTEGER NOT NULL DEFAULT 0 COMMENT 'Consecutive failure count',
    circuit_breaker_state VARCHAR(20) NOT NULL DEFAULT 'closed' COMMENT 'closed/open/half-open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted TINYINT(1) NOT NULL DEFAULT 0,
    UNIQUE INDEX uk_mrs_model_scene (model_id, scene_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Model routing stats';

DROP PROCEDURE IF EXISTS add_model_routing_stats_column;
DROP PROCEDURE IF EXISTS add_model_routing_rule_index;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_column_if_present;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_counter_if_present;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_breaker_state_if_present;
DELIMITER $$
CREATE PROCEDURE add_model_routing_stats_column(
    IN p_column_name VARCHAR(64),
    IN p_column_def TEXT,
    IN p_after_column VARCHAR(64)
)
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = p_column_name
    ) THEN
        SET @ddl = CONCAT(
            'ALTER TABLE model_routing_stats ADD COLUMN ',
            p_column_def,
            CASE
                WHEN p_after_column IS NULL OR p_after_column = '' THEN ''
                ELSE CONCAT(' AFTER ', p_after_column)
            END
        );
        PREPARE stmt FROM @ddl;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

CREATE PROCEDURE copy_model_routing_stats_column_if_present(
    IN p_source_column VARCHAR(64),
    IN p_target_column VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = p_source_column
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = p_target_column
    ) THEN
        SET @copy_sql = CONCAT(
            'UPDATE model_routing_stats SET ',
            p_target_column,
            ' = ',
            p_source_column,
            ' WHERE ',
            p_target_column,
            ' IS NULL AND ',
            p_source_column,
            ' IS NOT NULL'
        );
        PREPARE stmt FROM @copy_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

CREATE PROCEDURE copy_model_routing_stats_counter_if_present(
    IN p_source_column VARCHAR(64),
    IN p_target_column VARCHAR(64)
)
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = p_source_column
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = p_target_column
    ) THEN
        SET @copy_counter_sql = CONCAT(
            'UPDATE model_routing_stats SET ',
            p_target_column,
            ' = ',
            p_source_column,
            ' WHERE (',
            p_target_column,
            ' IS NULL OR ',
            p_target_column,
            ' = 0) AND ',
            p_source_column,
            ' IS NOT NULL'
        );
        PREPARE stmt FROM @copy_counter_sql;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END$$

CREATE PROCEDURE copy_model_routing_stats_breaker_state_if_present()
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = 'circuit_breaker_open'
    ) AND EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = DATABASE()
          AND table_name = 'model_routing_stats'
          AND column_name = 'circuit_breaker_state'
    ) THEN
        UPDATE model_routing_stats
        SET circuit_breaker_state = CASE WHEN circuit_breaker_open = 1 THEN 'open' ELSE 'closed' END
        WHERE circuit_breaker_state IS NULL OR circuit_breaker_state = '';
    END IF;
END$$
DELIMITER ;

CALL add_model_routing_stats_column('model_id', 'model_id VARCHAR(100) NULL COMMENT ''Model id''', 'id');
CALL add_model_routing_stats_column('scene_type', 'scene_type VARCHAR(50) NULL COMMENT ''Scene type''', 'model_id');
CALL add_model_routing_stats_column('total_calls', 'total_calls BIGINT NOT NULL DEFAULT 0 COMMENT ''Total calls''', 'scene_type');
CALL add_model_routing_stats_column('success_calls', 'success_calls BIGINT NOT NULL DEFAULT 0 COMMENT ''Successful calls''', 'total_calls');
CALL add_model_routing_stats_column('failed_calls', 'failed_calls BIGINT NOT NULL DEFAULT 0 COMMENT ''Failed calls''', 'success_calls');
CALL add_model_routing_stats_column('avg_response_time', 'avg_response_time INTEGER NOT NULL DEFAULT 0 COMMENT ''Average response time in ms''', 'failed_calls');
CALL add_model_routing_stats_column('last_success_at', 'last_success_at DATETIME NULL COMMENT ''Last success time''', 'avg_response_time');
CALL add_model_routing_stats_column('last_failure_at', 'last_failure_at DATETIME NULL COMMENT ''Last failure time''', 'last_success_at');
CALL add_model_routing_stats_column('consecutive_failures', 'consecutive_failures INTEGER NOT NULL DEFAULT 0 COMMENT ''Consecutive failure count''', 'last_failure_at');
CALL add_model_routing_stats_column('circuit_breaker_state', 'circuit_breaker_state VARCHAR(20) NOT NULL DEFAULT ''closed'' COMMENT ''closed/open/half-open''', 'consecutive_failures');
CALL add_model_routing_stats_column('created_at', 'created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP', 'circuit_breaker_state');
CALL add_model_routing_stats_column('updated_at', 'updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP', 'created_at');
CALL add_model_routing_stats_column('deleted', 'deleted TINYINT(1) NOT NULL DEFAULT 0', 'updated_at');

CALL copy_model_routing_stats_counter_if_present('total_requests', 'total_calls');
CALL copy_model_routing_stats_counter_if_present('success_requests', 'success_calls');
CALL copy_model_routing_stats_counter_if_present('failed_requests', 'failed_calls');
CALL copy_model_routing_stats_column_if_present('last_success_time', 'last_success_at');
CALL copy_model_routing_stats_column_if_present('last_failure_time', 'last_failure_at');
CALL copy_model_routing_stats_breaker_state_if_present();

UPDATE model_routing_stats
SET total_calls = 0
WHERE total_calls IS NULL;

UPDATE model_routing_stats
SET success_calls = 0
WHERE success_calls IS NULL;

UPDATE model_routing_stats
SET failed_calls = 0
WHERE failed_calls IS NULL;

UPDATE model_routing_stats
SET avg_response_time = 0
WHERE avg_response_time IS NULL;

UPDATE model_routing_stats
SET consecutive_failures = 0
WHERE consecutive_failures IS NULL;

UPDATE model_routing_stats
SET circuit_breaker_state = 'closed'
WHERE circuit_breaker_state IS NULL OR circuit_breaker_state = '';

UPDATE model_routing_stats
SET deleted = 0
WHERE deleted IS NULL;

DROP PROCEDURE IF EXISTS add_model_routing_stats_column;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_column_if_present;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_counter_if_present;
DROP PROCEDURE IF EXISTS copy_model_routing_stats_breaker_state_if_present;
