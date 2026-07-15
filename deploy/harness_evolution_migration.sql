-- Harness Evolution migration.
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS harness_version (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    surface         VARCHAR(50)  NOT NULL,
    version         VARCHAR(100) NOT NULL,
    name            VARCHAR(200),
    config_json     LONGTEXT,
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',
    description     TEXT,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_harness_surface_version (surface, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness version registry';

CREATE TABLE IF NOT EXISTS harness_trace (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_uuid        VARCHAR(64)  NOT NULL UNIQUE,
    surface           VARCHAR(50)  NOT NULL,
    user_id           BIGINT,
    conversation_id   BIGINT,
    conversation_uuid VARCHAR(64),
    task_id           VARCHAR(100),
    model             VARCHAR(100),
    provider          VARCHAR(50),
    channel_id        VARCHAR(100),
    harness_version   VARCHAR(100),
    status            VARCHAR(20)  NOT NULL DEFAULT 'running',
    input_summary     TEXT,
    output_summary    TEXT,
    failure_type      VARCHAR(80),
    error_msg         TEXT,
    latency_ms        INT          NOT NULL DEFAULT 0,
    input_tokens      INT          NOT NULL DEFAULT 0,
    output_tokens     INT          NOT NULL DEFAULT 0,
    request_json      LONGTEXT,
    context_json      LONGTEXT,
    events_json       LONGTEXT,
    metrics_json      LONGTEXT,
    quality_json      LONGTEXT,
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at      DATETIME,
    KEY idx_harness_trace_surface_created (surface, created_at),
    KEY idx_harness_trace_user_created (user_id, created_at),
    KEY idx_harness_trace_task (task_id),
    KEY idx_harness_trace_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness execution trace';

CREATE TABLE IF NOT EXISTS harness_failure_case (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_id       BIGINT,
    surface        VARCHAR(50) NOT NULL,
    failure_type   VARCHAR(80) NOT NULL,
    severity       VARCHAR(20) NOT NULL DEFAULT 'medium',
    summary        TEXT,
    evidence_json  LONGTEXT,
    status         VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at     DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at    DATETIME,
    KEY idx_harness_failure_surface_created (surface, created_at),
    KEY idx_harness_failure_type (failure_type),
    KEY idx_harness_failure_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness failure case';

CREATE TABLE IF NOT EXISTS harness_patch (
    id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
    patch_uuid          VARCHAR(64)  NOT NULL UNIQUE,
    surface             VARCHAR(50)  NOT NULL,
    target_type         VARCHAR(80)  NOT NULL,
    target_id           VARCHAR(200),
    title               VARCHAR(300) NOT NULL,
    rationale           TEXT,
    patch_json          LONGTEXT,
    status              VARCHAR(20)  NOT NULL DEFAULT 'draft',
    created_by_trace_id BIGINT,
    reviewed_by         BIGINT,
    created_at          DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at         DATETIME,
    KEY idx_harness_patch_surface_created (surface, created_at),
    KEY idx_harness_patch_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness candidate patch';

CREATE TABLE IF NOT EXISTS harness_regression_run (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_uuid       VARCHAR(64) NOT NULL UNIQUE,
    surface        VARCHAR(50) NOT NULL,
    version_id     BIGINT,
    version        VARCHAR(100),
    status         VARCHAR(20) NOT NULL DEFAULT 'pending',
    total_cases    INT NOT NULL DEFAULT 0,
    passed_cases   INT NOT NULL DEFAULT 0,
    failed_cases   INT NOT NULL DEFAULT 0,
    blocked_cases  INT NOT NULL DEFAULT 0,
    summary        TEXT,
    result_json    LONGTEXT,
    created_by     BIGINT,
    created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at   DATETIME,
    KEY idx_harness_regression_surface_created (surface, created_at),
    KEY idx_harness_regression_status (status),
    KEY idx_harness_regression_version (version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness regression run record';

INSERT IGNORE INTO harness_version (surface, version, name, status, description)
VALUES
    ('chat', 'chat-harness-v1', 'Chat Harness V1', 'active', 'Default chat harness trace contract'),
    ('chat_agent', 'chat-harness-v1', 'Chat Agent Harness V1', 'active', 'Default agent chat harness trace contract'),
    ('chat_sync', 'chat-harness-v1', 'Sync Chat Harness V1', 'active', 'Synchronous chat fallback harness trace contract'),
    ('autocode', 'autocode-harness-v1', 'AutoCode Harness V1', 'active', 'Default AutoCode task harness trace contract');

INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES (UUID(), 'Harness Evolution', 'harness', 0, 'menu', 0);

INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), 'View Harness Evolution', 'harness:view',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 LIMIT 1) t), 'menu', 1),
    (UUID(), 'Manage Harness Patches', 'harness:patch',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 LIMIT 1) t), 'button', 2),
    (UUID(), 'Manage Harness Regression', 'harness:regression',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 LIMIT 1) t), 'button', 3);

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
WHERE r.role_code='super_admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');
