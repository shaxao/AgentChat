-- AutoCode task persistence table.
-- Target database: MuHuoAi.

CREATE TABLE IF NOT EXISTS `autocode_tasks` (
    `id` VARCHAR(64) NOT NULL COMMENT 'Task id',
    `title` VARCHAR(200) NOT NULL COMMENT 'Task title',
    `description` TEXT NOT NULL COMMENT 'User requirement',
    `project_type` VARCHAR(50) NOT NULL DEFAULT 'nextjs' COMMENT 'Project type',
    `status` VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'Task status',
    `progress` INT NOT NULL DEFAULT 0 COMMENT 'Progress 0-100',
    `current_step` VARCHAR(500) DEFAULT '' COMMENT 'Current step',
    `workspace_id` VARCHAR(64) DEFAULT NULL COMMENT 'Workspace id',
    `user_id` VARCHAR(64) DEFAULT NULL COMMENT 'Owner user id',
    `harness_trace_id` BIGINT DEFAULT NULL COMMENT 'Linked harness trace id',
    `agents` JSON DEFAULT NULL COMMENT 'Enabled agent types',
    `preview_url` VARCHAR(500) DEFAULT NULL COMMENT 'Preview URL',
    `logs` JSON DEFAULT NULL COMMENT 'Execution and chat logs',
    `commit_history` JSON DEFAULT NULL COMMENT 'Git commit history',
    `plan` JSON DEFAULT NULL COMMENT 'AutoCode task plan',
    `review` JSON DEFAULT NULL COMMENT 'Final code review result',
    `phase_reviews` JSON DEFAULT NULL COMMENT 'Per-phase code review results',
    `prototype` JSON DEFAULT NULL COMMENT 'UI prototype data',
    `plan_confirmed` TINYINT(1) DEFAULT NULL COMMENT 'Whether the plan was confirmed',
    `prototype_confirmed` TINYINT(1) DEFAULT NULL COMMENT 'Whether the prototype was confirmed',
    `review_confirmed` TINYINT(1) DEFAULT NULL COMMENT 'Whether the final review was confirmed',
    `current_subtask_id` VARCHAR(64) DEFAULT NULL COMMENT 'Current subtask id',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Created time',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Updated time',
    PRIMARY KEY (`id`),
    INDEX `idx_status` (`status`),
    INDEX `idx_created_at` (`created_at`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='AutoCode tasks';
