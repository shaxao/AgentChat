-- Runtime compatibility migration for model discovery and Harness Evolution.
-- Safe to execute repeatedly on MySQL 5.7/8.x: every ALTER is guarded by information_schema.

SET @schema_name = DATABASE();

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='status_message'),
    'ALTER TABLE model_channel ADD COLUMN status_message VARCHAR(1000) DEFAULT NULL COMMENT ''最近一次连接测试结果或异常原因''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='api_format'),
    'ALTER TABLE model_channel ADD COLUMN api_format VARCHAR(30) NOT NULL DEFAULT ''chat_completions'' COMMENT ''出站接口格式''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='channel_type'),
    'ALTER TABLE model_channel ADD COLUMN channel_type VARCHAR(20) NOT NULL DEFAULT ''chat'' COMMENT ''chat/translate/tts/asr/image/search''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='tags'),
    'ALTER TABLE model_channel ADD COLUMN tags VARCHAR(255) DEFAULT NULL COMMENT ''渠道标签 JSON 数组''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='tts_voices'),
    'ALTER TABLE model_channel ADD COLUMN tts_voices VARCHAR(2000) DEFAULT NULL COMMENT ''TTS 音色配置 JSON 数组''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_channel')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_channel' AND column_name='translate_langs'),
    'ALTER TABLE model_channel ADD COLUMN translate_langs VARCHAR(2000) DEFAULT NULL COMMENT ''翻译支持语言配置 JSON 数组''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='cached_input_price'),
    'ALTER TABLE model_config ADD COLUMN cached_input_price DECIMAL(10,4) NOT NULL DEFAULT 0 AFTER input_price',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='aliases'),
    'ALTER TABLE model_config ADD COLUMN aliases VARCHAR(500) DEFAULT NULL COMMENT ''模型别名，逗号分隔''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='code_quality'),
    'ALTER TABLE model_config ADD COLUMN code_quality DECIMAL(3,2) DEFAULT 0.80 COMMENT ''代码质量评分 (0~1)''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='strengths'),
    'ALTER TABLE model_config ADD COLUMN strengths VARCHAR(500) DEFAULT NULL COMMENT ''模型优势 JSON 数组''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='task_types'),
    'ALTER TABLE model_config ADD COLUMN task_types VARCHAR(500) DEFAULT NULL COMMENT ''擅长任务类型 JSON 数组''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @ddl = IF(
    EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=@schema_name AND table_name='model_config')
    AND NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=@schema_name AND table_name='model_config' AND column_name='routing_priority'),
    'ALTER TABLE model_config ADD COLUMN routing_priority INT NOT NULL DEFAULT 1 COMMENT ''路由优先级 (1~10)''',
    'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS harness_version (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    surface VARCHAR(50) NOT NULL,
    version VARCHAR(100) NOT NULL,
    name VARCHAR(200),
    config_json LONGTEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    description TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_harness_surface_version (surface, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness version registry';

CREATE TABLE IF NOT EXISTS harness_trace (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_uuid VARCHAR(64) NOT NULL UNIQUE,
    surface VARCHAR(50) NOT NULL,
    user_id BIGINT,
    conversation_id BIGINT,
    conversation_uuid VARCHAR(64),
    task_id VARCHAR(100),
    model VARCHAR(100),
    provider VARCHAR(50),
    channel_id VARCHAR(100),
    harness_version VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    input_summary TEXT,
    output_summary TEXT,
    failure_type VARCHAR(80),
    error_msg TEXT,
    latency_ms INT NOT NULL DEFAULT 0,
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    request_json LONGTEXT,
    context_json LONGTEXT,
    events_json LONGTEXT,
    metrics_json LONGTEXT,
    quality_json LONGTEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    KEY idx_harness_trace_surface_created (surface, created_at),
    KEY idx_harness_trace_user_created (user_id, created_at),
    KEY idx_harness_trace_task (task_id),
    KEY idx_harness_trace_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness execution trace';

CREATE TABLE IF NOT EXISTS harness_trace_event (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_id BIGINT NOT NULL,
    surface VARCHAR(50) NOT NULL,
    seq INT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    event_name VARCHAR(100) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'info',
    status VARCHAR(20) NOT NULL DEFAULT 'ok',
    agent_id VARCHAR(100),
    model VARCHAR(100),
    provider VARCHAR(50),
    channel_id VARCHAR(100),
    turn_index INT,
    tool_name VARCHAR(120),
    tool_call_id VARCHAR(120),
    duration_ms INT,
    input_chars INT,
    output_chars INT,
    payload_json LONGTEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_harness_trace_event_trace_seq (trace_id, seq),
    KEY idx_harness_trace_event_surface_created (surface, created_at),
    KEY idx_harness_trace_event_tool (tool_name, created_at),
    KEY idx_harness_trace_event_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Structured Harness trace event';

CREATE TABLE IF NOT EXISTS harness_failure_case (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    trace_id BIGINT,
    surface VARCHAR(50) NOT NULL,
    failure_type VARCHAR(80) NOT NULL,
    severity VARCHAR(20) NOT NULL DEFAULT 'medium',
    summary TEXT,
    evidence_json LONGTEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'open',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME,
    KEY idx_harness_failure_surface_created (surface, created_at),
    KEY idx_harness_failure_type (failure_type),
    KEY idx_harness_failure_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness failure case';

CREATE TABLE IF NOT EXISTS harness_patch (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    patch_uuid VARCHAR(64) NOT NULL UNIQUE,
    surface VARCHAR(50) NOT NULL,
    target_type VARCHAR(80) NOT NULL,
    target_id VARCHAR(200),
    title VARCHAR(300) NOT NULL,
    rationale TEXT,
    patch_json LONGTEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    created_by_trace_id BIGINT,
    reviewed_by BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    KEY idx_harness_patch_surface_created (surface, created_at),
    KEY idx_harness_patch_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness candidate patch';

CREATE TABLE IF NOT EXISTS harness_regression_run (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_uuid VARCHAR(64) NOT NULL UNIQUE,
    surface VARCHAR(50) NOT NULL,
    version_id BIGINT,
    version VARCHAR(100),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    total_cases INT NOT NULL DEFAULT 0,
    passed_cases INT NOT NULL DEFAULT 0,
    failed_cases INT NOT NULL DEFAULT 0,
    blocked_cases INT NOT NULL DEFAULT 0,
    summary TEXT,
    result_json LONGTEXT,
    created_by BIGINT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    KEY idx_harness_regression_surface_created (surface, created_at),
    KEY idx_harness_regression_status (status),
    KEY idx_harness_regression_version (version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Harness regression run record';

INSERT IGNORE INTO harness_version (surface, version, name, status, description) VALUES
('chat', 'chat-harness-v1', 'Chat Harness V1', 'active', 'Default chat harness trace contract'),
('chat_agent', 'chat-harness-v1', 'Chat Agent Harness V1', 'active', 'Default agent chat harness trace contract'),
('chat_sync', 'chat-harness-v1', 'Sync Chat Harness V1', 'active', 'Synchronous chat fallback harness trace contract'),
('autocode', 'autocode-harness-v1', 'AutoCode Harness V1', 'active', 'Default AutoCode task harness trace contract');

INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES (UUID(), 'Harness 演进', 'harness', 0, 'menu', 0);

INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES
(UUID(), '查看 Harness 演进', 'harness:view',
 (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) p), 'menu', 1),
(UUID(), '管理 Harness 候选改进', 'harness:patch',
 (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) p), 'button', 2),
(UUID(), '管理 Harness 回归样本', 'harness:regression',
 (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) p), 'button', 3);

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
WHERE r.role_code IN ('admin', 'super_admin') AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');

SELECT table_name
FROM information_schema.tables
WHERE table_schema=DATABASE() AND table_name LIKE 'harness_%'
ORDER BY table_name;

SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema=DATABASE()
  AND ((table_name='model_channel' AND column_name IN ('status_message','api_format','channel_type','tags','tts_voices','translate_langs'))
    OR (table_name='model_config' AND column_name IN ('cached_input_price','aliases','code_quality','strengths','task_types','routing_priority')))
ORDER BY table_name, column_name;
