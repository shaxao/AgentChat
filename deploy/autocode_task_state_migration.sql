-- AutoCode task state persistence migration.
-- Safe to run repeatedly on MySQL versions that support ADD COLUMN IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS `autocode_tasks` (
    `id` VARCHAR(64) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `description` TEXT NOT NULL,
    `project_type` VARCHAR(50) NOT NULL DEFAULT 'nextjs',
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending',
    `progress` INT NOT NULL DEFAULT 0,
    `current_step` VARCHAR(500) DEFAULT '',
    `workspace_id` VARCHAR(64) DEFAULT NULL,
    `user_id` VARCHAR(64) DEFAULT NULL,
    `harness_trace_id` BIGINT DEFAULT NULL,
    `agents` JSON DEFAULT NULL,
    `preview_url` VARCHAR(500) DEFAULT NULL,
    `logs` JSON DEFAULT NULL,
    `commit_history` JSON DEFAULT NULL,
    `command_history` JSON DEFAULT NULL,
    `pipeline_runs` JSON DEFAULT NULL,
    `plan` JSON DEFAULT NULL,
    `review` JSON DEFAULT NULL,
    `phase_reviews` JSON DEFAULT NULL,
    `prototype` JSON DEFAULT NULL,
    `plan_confirmed` TINYINT(1) DEFAULT NULL,
    `prototype_confirmed` TINYINT(1) DEFAULT NULL,
    `review_confirmed` TINYINT(1) DEFAULT NULL,
    `current_subtask_id` VARCHAR(64) DEFAULT NULL,
    `project_recon` JSON DEFAULT NULL,
    `complexity` VARCHAR(20) DEFAULT NULL,
    `recommended_flow` VARCHAR(80) DEFAULT NULL,
    `prototype_required` TINYINT(1) DEFAULT NULL,
    `needs_continuation` TINYINT(1) DEFAULT NULL,
    `pipeline_status` VARCHAR(20) DEFAULT NULL,
    `preview_status` VARCHAR(20) DEFAULT NULL,
    `preview_error` TEXT DEFAULT NULL,
    `queued_at` VARCHAR(40) DEFAULT NULL,
    `lease_owner` VARCHAR(128) DEFAULT NULL,
    `lease_until` DATETIME DEFAULT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    INDEX `idx_status` (`status`),
    INDEX `idx_user_id` (`user_id`),
    INDEX `idx_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @schema_name = DATABASE();

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `review` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'review'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `phase_reviews` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'phase_reviews'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `prototype` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'prototype'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `plan_confirmed` TINYINT(1) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'plan_confirmed'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `prototype_confirmed` TINYINT(1) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'prototype_confirmed'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `review_confirmed` TINYINT(1) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'review_confirmed'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `current_subtask_id` VARCHAR(64) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'current_subtask_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `harness_trace_id` BIGINT DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'harness_trace_id'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `model` VARCHAR(100) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'model'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `project_recon` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'project_recon'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `complexity` VARCHAR(20) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'complexity'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `recommended_flow` VARCHAR(80) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'recommended_flow'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `prototype_required` TINYINT(1) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'prototype_required'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `needs_continuation` TINYINT(1) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'needs_continuation'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `command_history` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'command_history'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `pipeline_status` VARCHAR(20) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'pipeline_status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `preview_status` VARCHAR(20) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'preview_status'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `preview_error` TEXT DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'preview_error'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `pipeline_runs` JSON DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'pipeline_runs'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `queued_at` VARCHAR(40) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'queued_at'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `lease_owner` VARCHAR(128) DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'lease_owner'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql = (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE autocode_tasks ADD COLUMN `lease_until` DATETIME DEFAULT NULL',
        'SELECT 1'
    )
    FROM information_schema.columns
    WHERE table_schema = @schema_name AND table_name = 'autocode_tasks' AND column_name = 'lease_until'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
