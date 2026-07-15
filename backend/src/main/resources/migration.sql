-- =====================================================
-- MuhugoChat 增量迁移 SQL
-- 用途：将旧版数据库升级到最新 schema
-- 适用：已部署的服务器，已有旧数据，运行此文件追加新列
-- 对于全新部署：schema.sql 会自动创建完整表结构，无需执行此文件
--
-- 用法：
--   mysql -u muhuoai -p{MuHuoAi 的密码} MuHuoAi < migration.sql
--   或
--   ssh root@服务器C "mysql -h your-server-c-ip -P 3000 -u muhuoai -p{MuHuoAi 的密码} MuHuoAi < migration.sql"
--
-- 注意：执行时可能会有 "Duplicate column name" 错误，这是正常的（列已存在），请忽略
-- =====================================================

-- v1.1: 钱包系统（balance, consuming, earning, recharging）
-- 如果列已存在，会报错 "Duplicate column name"，请忽略
ALTER TABLE sys_user ADD COLUMN balance         DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '账户余额（¥）';
ALTER TABLE sys_user ADD COLUMN total_consumed  DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计消费（¥）';
ALTER TABLE sys_user ADD COLUMN total_earned    DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计收益（开发者分成，¥）';
ALTER TABLE sys_user ADD COLUMN total_recharged DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计充值（¥）';

-- v1.2: model_channel 增加 tags 字段（标记渠道能力：tool/vision 等）
ALTER TABLE model_channel ADD COLUMN tags VARCHAR(255) DEFAULT NULL COMMENT '渠道标签 JSON 数组，如 ["tool","vision"]';

-- v1.3: 场景系统（scenarios）
CREATE TABLE IF NOT EXISTS scenario (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(100) NOT NULL COMMENT '场景名称',
    icon            TEXT         COMMENT '场景图标（emoji 或 OSS URL）',
    profession      VARCHAR(100) NOT NULL COMMENT '目标职业/行业',
    description     TEXT         COMMENT '场景描述（给用户看的）',
    system_prompt   TEXT         COMMENT '激活场景时注入的 System Prompt',
    recommended_skills JSON     COMMENT '推荐安装的技能/Agent ID列表 JSON 数组',
    is_official     TINYINT      NOT NULL DEFAULT 0 COMMENT '是否官方场景',
    is_public       TINYINT      NOT NULL DEFAULT 1 COMMENT '是否公开（社区可见）',
    creator_id      BIGINT       COMMENT '创建者用户ID',
    usage_count     BIGINT       NOT NULL DEFAULT 0 COMMENT '使用量',
    sort_order      INT          NOT NULL DEFAULT 0 COMMENT '排序权重',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_scenario_profession (profession),
    INDEX idx_scenario_official (is_official),
    INDEX idx_scenario_usage (usage_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='场景表';

-- v1.4: 模型路由系统
-- 为 model_config 表添加路由所需字段
-- 如果列已存在，会报错 "Duplicate column name"，请忽略
ALTER TABLE model_config ADD COLUMN code_quality     DECIMAL(3,2) DEFAULT 0.80 COMMENT '代码质量评分 (0~1)';
ALTER TABLE model_config ADD COLUMN strengths       VARCHAR(500) COMMENT '模型优势 JSON 数组，如 ["vision","reasoning"]';
ALTER TABLE model_config ADD COLUMN task_types      VARCHAR(500) COMMENT '擅长任务类型 JSON 数组，如 ["chat","code","image"]';
ALTER TABLE model_config ADD COLUMN routing_priority INT NOT NULL DEFAULT 1 COMMENT '路由优先级 (1~10)';

-- 创建模型路由规则表
CREATE TABLE IF NOT EXISTS model_routing_rule (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NULL COMMENT 'NULL 表示全局规则；非空表示用户个人规则',
    rule_name       VARCHAR(100)  NOT NULL COMMENT '规则名称',
    description     VARCHAR(500) COMMENT '规则描述',
    scene_type      VARCHAR(50)   NOT NULL COMMENT '场景类型: chat/vision/code/image/agent',
    agent_type      VARCHAR(50)   COMMENT 'Agent类型（可选，如 ledger/text2code）',
    complexity      VARCHAR(20)   COMMENT '复杂度: simple/moderate/complex',
    required_tags   VARCHAR(255) COMMENT '必需能力标签 JSON 数组，如 ["tool","vision"]',
    priority        INT          NOT NULL DEFAULT 0 COMMENT '优先级（数字越大越优先）',
    enabled         TINYINT      NOT NULL DEFAULT 1 COMMENT '是否启用',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_rrr_user_id (user_id),
    INDEX idx_rrr_scene_type (scene_type),
    INDEX idx_rrr_priority (priority),
    INDEX idx_rrr_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型路由规则表';

-- 创建模型路由统计表
CREATE TABLE IF NOT EXISTS model_routing_stats (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    model_id        VARCHAR(100) NOT NULL COMMENT '模型ID（关联 model_config.model_id）',
    scene_type      VARCHAR(50)  NOT NULL COMMENT '场景类型',
    total_calls     BIGINT       NOT NULL DEFAULT 0 COMMENT '总调用次数',
    success_calls   BIGINT       NOT NULL DEFAULT 0 COMMENT '成功调用次数',
    failed_calls    BIGINT       NOT NULL DEFAULT 0 COMMENT '失败调用次数',
    last_success_at DATETIME     COMMENT '最后一次成功时间',
    last_failure_at DATETIME     COMMENT '最后一次失败时间',
    circuit_breaker_state VARCHAR(20) NOT NULL DEFAULT 'closed' COMMENT '熔断器状态: closed/open/half-open',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE INDEX uk_mrs_model_scene (model_id, scene_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型路由统计表';

-- 注意：默认路由规则在 data.sql 中插入（全新部署时）
-- 如果已部署服务器需要添加默认规则，请手动执行以下 SQL：
-- INSERT INTO model_routing_rule (rule_name, description, scene_type, agent_type, complexity, required_tags, priority, enabled) VALUES
-- ('默认对话路由',    '普通对话场景，优先低延迟模型',     'chat',   NULL,        NULL,       NULL,               10, 1),
-- ('Vision识别路由',  '图片识别场景，必须有vision能力',  'vision',  NULL,        NULL,       '["vision"]',       10, 1),
-- ('代码生成路由',    '代码生成场景，优先代码质量高的模型', 'code',   NULL,        'complex',  '["code"]',        10, 1),
-- ('图片生成路由',    '图片生成场景，必须有image能力',    'image',  NULL,        NULL,       '["image"]',        10, 1),
-- ('Agent执行路由',   'Agent技能执行，必须有tool能力',    'agent',   NULL,        NULL,       '["tool"]',         10, 1),
-- ('台账Agent路由',   '台账生成Agent，需要code+tool能力', 'agent',   'ledger',    'complex',  '["tool","code"]',  20, 1),
-- ('写作Agent路由',   '写作Agent，需要text能力',         'agent',   'writing',   'moderate', '["text"]',        15, 1),
-- ('数据分析路由',    '数据分析场景，优先推理能力',       'chat',    NULL,        'complex',  '["reasoning"]',    15, 1)
-- ON DUPLICATE KEY UPDATE rule_name=rule_name;

-- =====================================================
-- v2.0: P2-2 场景+工作流+记忆联调 — workflow 表增加 scenario_id
-- =====================================================
ALTER TABLE workflow ADD COLUMN scenario_id BIGINT COMMENT '关联场景ID' AFTER user_id;
CREATE INDEX idx_wf_scenario_id ON workflow (scenario_id);

-- =====================================================
-- v2.1: P2-3 社区 v1 — 场景分享 + 技能评分
-- =====================================================
ALTER TABLE agent_registry ADD COLUMN is_public  TINYINT NOT NULL DEFAULT 0 COMMENT '是否公开（社区可见，仅 approved/active 状态可设为公开）';
ALTER TABLE agent_registry ADD COLUMN avg_rating DECIMAL(3,2) NOT NULL DEFAULT 0 COMMENT '平均评分（1-5星，冗余字段加速查询）';
ALTER TABLE agent_registry ADD COLUMN rating_count INT NOT NULL DEFAULT 0 COMMENT '评分人数';
ALTER TABLE agent_registry ADD INDEX idx_ar_is_public (is_public);
ALTER TABLE agent_registry ADD INDEX idx_ar_avg_rating (avg_rating);

-- v3.0: P3-4 创作者激励 — 官方认证标识
ALTER TABLE agent_registry ADD COLUMN is_certified TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否官方认证';
ALTER TABLE agent_registry ADD INDEX idx_ar_is_certified (is_certified);

CREATE TABLE IF NOT EXISTS skill_rating (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id    BIGINT      NOT NULL COMMENT '关联 agent_registry.id',
    user_id     BIGINT      NOT NULL COMMENT '评分用户 ID',
    rating      TINYINT     NOT NULL COMMENT '评分 1-5 星',
    comment     TEXT        COMMENT '评价内容（可选）',
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT     NOT NULL DEFAULT 0,
    UNIQUE INDEX uk_skill_rating_user (agent_id, user_id, deleted),
    INDEX idx_sr_agent_id (agent_id),
    INDEX idx_sr_user_id (user_id),
    INDEX idx_sr_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='技能评分表';

-- =====================================================
-- v4.0: RBAC 权限管理系统
-- =====================================================

-- 角色表
CREATE TABLE IF NOT EXISTS sys_role (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    role_name       VARCHAR(100) NOT NULL COMMENT '角色名称（显示用）',
    role_code       VARCHAR(50)  NOT NULL UNIQUE COMMENT '角色代码（如 super_admin/admin/editor）',
    description     VARCHAR(500) COMMENT '角色描述',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT '状态：active/disabled',
    sort_order      INT          NOT NULL DEFAULT 0 COMMENT '排序权重',
    is_system       TINYINT      NOT NULL DEFAULT 0 COMMENT '是否系统内置角色（不可删除）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_sr_role_code (role_code),
    INDEX idx_sr_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='RBAC 角色表';

-- 权限表（支持树形层级结构，parent_id=0 表示顶级权限）
CREATE TABLE IF NOT EXISTS sys_permission (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    permission_name VARCHAR(100) NOT NULL COMMENT '权限名称（显示用）',
    permission_code VARCHAR(100) NOT NULL UNIQUE COMMENT '权限代码（如 skill:publish）',
    parent_id       BIGINT       NOT NULL DEFAULT 0 COMMENT '上级权限ID（0=顶级）',
    resource_type   VARCHAR(50)  NOT NULL COMMENT '资源类型：menu/button/api',
    action          VARCHAR(50)  COMMENT '操作类型：create/read/update/delete',
    description     VARCHAR(500) COMMENT '权限描述',
    sort_order      INT          NOT NULL DEFAULT 0 COMMENT '排序权重',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_sp_permission_code (permission_code),
    INDEX idx_sp_parent_id (parent_id),
    INDEX idx_sp_resource_type (resource_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='RBAC 权限表';

-- 角色-权限关联表
CREATE TABLE IF NOT EXISTS sys_role_permission (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    role_id         BIGINT       NOT NULL COMMENT '关联 sys_role.id',
    permission_id   BIGINT       NOT NULL COMMENT '关联 sys_permission.id',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uk_role_permission (role_id, permission_id),
    INDEX idx_srp_role_id (role_id),
    INDEX idx_srp_permission_id (permission_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='角色-权限关联表';

-- 用户-角色关联表
CREATE TABLE IF NOT EXISTS sys_user_role (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '关联 sys_user.id',
    role_id         BIGINT       NOT NULL COMMENT '关联 sys_role.id',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uk_user_role (user_id, role_id),
    INDEX idx_sur_user_id (user_id),
    INDEX idx_sur_role_id (role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户-角色关联表';

-- 插入默认角色
INSERT IGNORE INTO sys_role (uuid, role_name, role_code, description, status, sort_order, is_system) VALUES
    (UUID(), '超级管理员', 'super_admin', '拥有系统所有权限，可管理一切', 'active', 0, 1),
    (UUID(), '管理员',     'admin',       '管理系统核心功能（用户/渠道/模型/订阅/日志）', 'active', 1, 1),
    (UUID(), '编辑',       'editor',      '可发布和编辑内容（技能/场景/工作流）', 'active', 2, 1),
    (UUID(), '普通用户',   'user',        '基础使用权限（使用已有技能/场景/工作流）', 'active', 3, 1);

-- 插入默认权限（树形结构）
-- 顶级权限 = parent_id = 0，子权限 parent_id 指向对应的顶级权限
-- 注意：下面 INSERT 语句中 IF NOT EXISTS 的效果通过 IGNORE INTO + UNIQUE KEY 实现

-- 1. 技能管理 (skill)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '技能管理',     'skill',          0,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '发布技能',     'skill:publish',  1,    'button', 1);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '编辑技能',     'skill:edit',     1,    'button', 2);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '删除技能',     'skill:delete',   1,    'button', 3);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '审核技能',     'skill:review',   1,    'button', 4);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '使用技能',     'skill:use',      1,    'api',    5);

-- 2. 场景管理 (scenario)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '场景管理',     'scenario',          2,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '发布场景',     'scenario:publish',  7,    'button', 1);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '编辑场景',     'scenario:edit',     7,    'button', 2);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '删除场景',     'scenario:delete',   7,    'button', 3);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '使用场景',     'scenario:use',      7,    'api',    4);

-- 3. 工作流管理 (workflow)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '工作流管理',   'workflow',              3,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '发布工作流',   'workflow:publish',       12,   'button', 1);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '编辑工作流',   'workflow:edit',          12,   'button', 2);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '删除工作流',   'workflow:delete',        12,   'button', 3);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '使用工作流',   'workflow:use',           12,   'api',    4);

-- 4. 模型管理 (model)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '模型管理',     'model',         4,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '模型路由',     'model:routing', 17,   'button', 1);

-- 5. 用户管理 (user_mgmt)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '用户管理',     'user_mgmt',             5,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '创建用户',     'user_mgmt:create',      19,   'button', 1);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '编辑用户',     'user_mgmt:edit',        19,   'button', 2);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '删除用户',     'user_mgmt:delete',      19,   'button', 3);

-- 6. 订阅管理 (subscription)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '订阅管理',     'subscription',  6,    'menu',   0);

-- 7. 钱包管理 (wallet)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '钱包管理',     'wallet',        7,    'menu',   0);

-- 8. 系统设置 (system)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '系统设置',     'system',        8,    'menu',   0);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '权限管理',     'system:rbac',   25,   'menu',   1);
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '存储配置',     'system:storage', 25,   'menu',   2);

-- 9. 日志管理 (logs)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '日志管理',     'logs',          9,    'menu',   0);

-- 10. 统计概览 (overview)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order) VALUES (UUID(), '统计概览',     'overview',      10,   'menu',   0);

-- =====================================================
-- 分配默认角色权限
-- =====================================================

-- 超级管理员 → 所有权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT (SELECT id FROM sys_role WHERE role_code = 'super_admin'), id FROM sys_permission;

-- 管理员 → 大部分权限（排除系统设置和权限管理）
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT (SELECT id FROM sys_role WHERE role_code = 'admin'), id FROM sys_permission
WHERE permission_code NOT IN ('system', 'system:rbac', 'system:storage', 'user_mgmt', 'user_mgmt:create', 'user_mgmt:delete', 'skill:delete', 'scenario:delete', 'workflow:delete');

-- 编辑 → 内容管理权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT (SELECT id FROM sys_role WHERE role_code = 'editor'), id FROM sys_permission
WHERE permission_code IN ('skill', 'skill:publish', 'skill:edit', 'skill:use',
                          'scenario', 'scenario:publish', 'scenario:edit', 'scenario:use',
                          'workflow', 'workflow:publish', 'workflow:edit', 'workflow:use');

-- 普通用户 → 使用权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT (SELECT id FROM sys_role WHERE role_code = 'user'), id FROM sys_permission
WHERE permission_code IN ('skill:use', 'scenario:use', 'workflow:use');

-- =====================================================
-- 将现有用户分配到默认角色
-- =====================================================
INSERT IGNORE INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id FROM sys_user u
JOIN sys_role r ON (u.role = 'admin' AND r.role_code = 'admin')
                 OR (u.role = 'user'  AND r.role_code = 'user')
WHERE u.deleted = 0;

-- 超级管理员：默认第一个 admin 用户
INSERT IGNORE INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id FROM sys_user u
JOIN sys_role r ON r.role_code = 'super_admin'
WHERE u.role = 'admin' AND u.deleted = 0
ORDER BY u.id ASC LIMIT 1;

-- =====================================================
-- 后续新增列请按版本追加到下方
-- 格式：
-- -- vX.Y: 功能说明
-- ALTER TABLE xxx ADD COLUMN ... ;
-- =====================================================

-- v1.7: 模型路由统计表缺列补全（匹配 Java 实体字段）
ALTER TABLE model_routing_stats ADD COLUMN avg_response_time INTEGER DEFAULT 0 COMMENT '平均响应时间(ms)';
ALTER TABLE model_routing_stats ADD COLUMN consecutive_failures INTEGER DEFAULT 0 COMMENT '连续失败次数';
ALTER TABLE model_routing_stats ADD COLUMN deleted TINYINT(1) NOT NULL DEFAULT 0 COMMENT '逻辑删除';

-- v1.8: scenario.icon 字段扩容，支持 AI 生成的 OSS URL（原 VARCHAR(20) 太短）
ALTER TABLE scenario MODIFY COLUMN icon TEXT COMMENT '场景图标（emoji 或 OSS URL）';

-- v1.9: 工作流引擎
CREATE TABLE IF NOT EXISTS workflow (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '创建者用户ID',
    name            VARCHAR(128) NOT NULL COMMENT '工作流名称',
    description     VARCHAR(500) COMMENT '工作流描述',
    dsl             TEXT         COMMENT '工作流 DSL（JSON 定义）',
    cron_expr       VARCHAR(64)  COMMENT '触发 cron 表达式',
    status          VARCHAR(16)  NOT NULL DEFAULT 'paused' COMMENT 'paused/active/error',
    last_run_at     DATETIME     COMMENT '最后执行时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_wf_user_id (user_id),
    INDEX idx_wf_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流定义表';

CREATE TABLE IF NOT EXISTS workflow_execution (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    workflow_id     BIGINT       NOT NULL COMMENT '关联工作流ID',
    user_id         BIGINT       NOT NULL COMMENT '执行者用户ID',
    status          VARCHAR(20)  NOT NULL DEFAULT 'running' COMMENT 'running/success/failed/cancelled',
    trigger_type    VARCHAR(20)  NOT NULL DEFAULT 'manual' COMMENT '触发方式：manual/cron',
    input_json      TEXT         COMMENT '输入参数（JSON）',
    output_json     TEXT         COMMENT '执行结果（JSON）',
    step_results    TEXT         COMMENT '各步骤执行结果（JSON 数组）',
    error_msg       TEXT         COMMENT '错误信息',
    started_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '开始时间',
    finished_at     DATETIME     COMMENT '完成时间',
    duration_ms     INT          DEFAULT 0 COMMENT '执行耗时（毫秒）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_we_workflow_id (workflow_id),
    INDEX idx_we_user_id (user_id),
    INDEX idx_we_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流执行记录表';

CREATE TABLE IF NOT EXISTS workflow_artifact (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    conversation_id BIGINT       COMMENT '来源对话',
    workflow_id     BIGINT       COMMENT '工作流ID',
    execution_id    BIGINT       COMMENT '执行ID',
    step_id         VARCHAR(64)  COMMENT '来源步骤ID',
    source_type     VARCHAR(50)  NOT NULL DEFAULT 'upload' COMMENT 'upload/workflow_output/asr/vision/document_parse',
    file_name       VARCHAR(500) COMMENT '原始文件名',
    file_type       VARCHAR(50)  NOT NULL DEFAULT 'other' COMMENT 'image/document/spreadsheet/audio/video/text/other',
    mime_type       VARCHAR(100) COMMENT 'MIME 类型',
    file_size       BIGINT       NOT NULL DEFAULT 0 COMMENT '文件大小（字节）',
    oss_url         VARCHAR(1000) COMMENT 'OSS URL',
    object_key      VARCHAR(1000) COMMENT 'OSS object key',
    content_text    MEDIUMTEXT   COMMENT '小文本结果或摘要',
    metadata_json   TEXT         COMMENT '结构化元数据 JSON',
    status          VARCHAR(20)  NOT NULL DEFAULT 'ready' COMMENT 'pending/ready/failed',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_wa_user_id (user_id),
    INDEX idx_wa_workflow_id (workflow_id),
    INDEX idx_wa_execution_id (execution_id),
    INDEX idx_wa_step_id (step_id),
    INDEX idx_wa_file_type (file_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流资产表';

CREATE TABLE IF NOT EXISTS workflow_artifact_upload_session (
    id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
    upload_id          VARCHAR(64)  NOT NULL UNIQUE COMMENT 'Platform upload session UUID',
    user_id            BIGINT       NOT NULL COMMENT 'Owner user ID',
    file_name          VARCHAR(500) NOT NULL COMMENT 'Original file name',
    total_size         BIGINT       NOT NULL COMMENT 'Total file size in bytes',
    chunk_size         BIGINT       NOT NULL COMMENT 'Chunk size in bytes',
    total_parts        INT          NOT NULL COMMENT 'Total chunk count',
    uploaded_parts     TEXT         COMMENT 'Uploaded part numbers as JSON array',
    content_type       VARCHAR(100) COMMENT 'MIME type',
    workflow_id        BIGINT       COMMENT 'Workflow ID',
    execution_id       BIGINT       COMMENT 'Workflow execution ID',
    step_id            VARCHAR(64)  COMMENT 'Source step ID',
    source_type        VARCHAR(50)  NOT NULL DEFAULT 'upload',
    conversation_id    BIGINT       COMMENT 'Source conversation ID',
    sync_to_work_file  TINYINT      NOT NULL DEFAULT 0,
    metadata_json      TEXT         COMMENT 'Artifact metadata JSON',
    storage_mode       VARCHAR(32)  NOT NULL DEFAULT 'oss_temp_merge' COMMENT 'oss_temp_merge/native_multipart',
    temp_dir           VARCHAR(1000) COMMENT 'Server temp directory',
    object_key         VARCHAR(1000) COMMENT 'Reserved OSS object key',
    native_upload_id   VARCHAR(255) COMMENT 'Reserved cloud native multipart upload ID',
    status             VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT 'pending/uploading/completed/failed/aborted',
    error_msg          TEXT         COMMENT 'Last error message',
    created_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    expires_at         DATETIME     COMMENT 'Session expiration time',
    deleted            TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_waus_user_id (user_id),
    INDEX idx_waus_upload_id (upload_id),
    INDEX idx_waus_status (status),
    INDEX idx_waus_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Workflow artifact upload session table';

CREATE TABLE IF NOT EXISTS workflow_execution_step (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    execution_id    BIGINT       NOT NULL COMMENT '执行ID',
    workflow_id     BIGINT       NOT NULL COMMENT '工作流ID',
    step_id         VARCHAR(64)  NOT NULL COMMENT 'DSL 步骤ID',
    step_name       VARCHAR(200) COMMENT '步骤名称/描述',
    tool_name       VARCHAR(128) COMMENT '工具名',
    status          VARCHAR(20)  NOT NULL DEFAULT 'running' COMMENT 'running/completed/skipped/failed/cancelled',
    input_json      TEXT         COMMENT '步骤输入 JSON',
    output_json     MEDIUMTEXT   COMMENT '步骤输出 JSON',
    error_msg       TEXT         COMMENT '错误信息',
    started_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at     DATETIME     COMMENT '完成时间',
    duration_ms     INT          DEFAULT 0 COMMENT '耗时毫秒',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_wes_execution_id (execution_id),
    INDEX idx_wes_workflow_id (workflow_id),
    INDEX idx_wes_step_id (step_id),
    INDEX idx_wes_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流步骤执行记录表';

CREATE TABLE IF NOT EXISTS workflow_execution_event (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    execution_id    BIGINT       NOT NULL COMMENT '执行ID',
    step_id         VARCHAR(64)  COMMENT '步骤ID',
    event_type      VARCHAR(50)  NOT NULL COMMENT '事件类型',
    message         VARCHAR(1000) COMMENT '事件说明',
    payload_json    TEXT         COMMENT '事件载荷 JSON',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_wee_execution_id (execution_id),
    INDEX idx_wee_step_id (step_id),
    INDEX idx_wee_event_type (event_type),
    INDEX idx_wee_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流执行事件表';

-- =============================================
-- v2.0: 知识图谱（P3-1 记忆系统 v2）
-- =============================================
CREATE TABLE IF NOT EXISTS kg_entity (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL,
    name            VARCHAR(200) NOT NULL COMMENT '实体名称（如"老王"、"火锅店"、"深圳"）',
    entity_type     VARCHAR(50)  NOT NULL COMMENT '实体类型：person/place/organization/product/number/concept',
    properties      JSON         COMMENT '属性（如 {"age":35, "phone":"138..."}）',
    confidence      DECIMAL(3,2) NOT NULL DEFAULT 0.80 COMMENT '提取置信度 0-1',
    aliases         VARCHAR(500) COMMENT '别名（逗号分隔）',
    source_conv_uuid VARCHAR(36) COMMENT '来源对话 UUID',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active/merged/archived',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_kg_e_user_id (user_id),
    INDEX idx_kg_e_name (name),
    INDEX idx_kg_e_type (entity_type),
    INDEX idx_kg_e_status (status),
    UNIQUE KEY uk_user_name (user_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='知识图谱实体表';

CREATE TABLE IF NOT EXISTS kg_relation (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid              VARCHAR(36)  NOT NULL UNIQUE,
    user_id           BIGINT       NOT NULL,
    subject_entity_id BIGINT       NOT NULL COMMENT '主语实体 ID',
    predicate         VARCHAR(100) NOT NULL COMMENT '谓词（如"拥有"、"位于"、"有员工"）',
    object_entity_id  BIGINT       COMMENT '宾语实体 ID（实体→实体关系）',
    object_value      VARCHAR(500) COMMENT '宾语字面值（如"12人"，实体→值关系）',
    confidence        DECIMAL(3,2) NOT NULL DEFAULT 0.80 COMMENT '置信度 0-1',
    source_conv_uuid  VARCHAR(36) COMMENT '来源对话 UUID',
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted           TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_kg_r_user_id (user_id),
    INDEX idx_kg_r_subject (subject_entity_id),
    INDEX idx_kg_r_object (object_entity_id),
    INDEX idx_kg_r_predicate (predicate),
    UNIQUE KEY uk_triple (subject_entity_id, predicate, object_entity_id, object_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='知识图谱关系表';

-- =============================================
-- v3.0: 工作流模板市场（P3-2）
-- =============================================
CREATE TABLE IF NOT EXISTS workflow_template (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    name            VARCHAR(128) NOT NULL COMMENT '模板名称',
    description     TEXT         COMMENT '模板描述',
    category        VARCHAR(50)  NOT NULL DEFAULT 'general' COMMENT '分类：general/data/report/notification/schedule/automation/ai/其他',
    icon            VARCHAR(16)  DEFAULT '⚙️' COMMENT '模板图标 emoji',
    dsl             JSON         NOT NULL COMMENT '工作流 DSL 定义',
    params_schema   JSON         COMMENT '参数化字段定义 [{"key":"webhook_url","label":"Webhook地址","type":"string","required":true}]',
    is_official     TINYINT(1)   DEFAULT 0 COMMENT '是否官方模板',
    author_id       BIGINT       DEFAULT 0 COMMENT '作者用户ID（0=官方）',
    author_name     VARCHAR(50)  DEFAULT '' COMMENT '作者名称',
    use_count       INT          DEFAULT 0 COMMENT '使用次数',
    rating          DECIMAL(3,2) DEFAULT 0.00 COMMENT '平均评分 0-5',
    rating_count    INT          DEFAULT 0 COMMENT '评分人数',
    is_published    TINYINT(1)   DEFAULT 1 COMMENT '是否已发布',
    is_certified    TINYINT(1)   DEFAULT 0 COMMENT '是否官方认证',
    source_workflow_id BIGINT    DEFAULT NULL COMMENT '来源工作流ID（用户发布模板时关联）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_wt_category (category),
    INDEX idx_wt_author (author_id),
    INDEX idx_wt_official (is_official),
    INDEX idx_wt_use_count (use_count),
    INDEX idx_wt_rating (rating),
    INDEX idx_wt_published (is_published)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流模板市场';

-- =============================================
-- v3.0: 技能收益记录（P3-4 创作者激励）
-- =============================================
CREATE TABLE IF NOT EXISTS skill_revenue_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL COMMENT '创作者用户ID',
    agent_id        BIGINT       NOT NULL COMMENT '关联 agent_registry.id',
    revenue_type    VARCHAR(30)  NOT NULL COMMENT '收益类型：usage/download/subscription',
    amount          DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '收益金额',
    description     VARCHAR(300) COMMENT '收益描述',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_srr_user_id (user_id),
    INDEX idx_srr_agent_id (agent_id),
    INDEX idx_srr_type (revenue_type),
    INDEX idx_srr_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='技能收益记录';

-- =====================================================
-- v3.1: 用户模型偏好系统（智能路由用户个性化）
-- =====================================================
CREATE TABLE IF NOT EXISTS user_model_preference (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL COMMENT '用户ID → sys_user.id',
    model_id    VARCHAR(100) NOT NULL COMMENT '模型ID → model_config.model_id',
    scene_type  VARCHAR(50)  NOT NULL DEFAULT 'chat' COMMENT '场景: chat/vision/code/image/agent',

    preference_weight DECIMAL(4,3) DEFAULT 0.000 COMMENT '偏好权重 (-1.0 ~ +1.0)',
    usage_count       INT          DEFAULT 0     COMMENT '该场景下使用该模型的累计次数',
    like_count        INT          DEFAULT 0     COMMENT '用户点赞次数',
    dislike_count     INT          DEFAULT 0     COMMENT '用户点踩次数',
    avg_response_time INT          DEFAULT 0     COMMENT '平均响应时间(ms)',
    last_used_at      DATETIME     COMMENT '最后使用时间',
    source            VARCHAR(20)  DEFAULT 'auto' COMMENT '来源: auto=系统学习, manual=用户手动设定',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uk_user_model_scene (user_id, model_id, scene_type),
    INDEX idx_user_scene (user_id, scene_type),
    INDEX idx_user_model (user_id, model_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型偏好表';

CREATE TABLE IF NOT EXISTS user_model_feedback (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户ID',
    conversation_id VARCHAR(100) COMMENT '关联对话ID',
    model_id        VARCHAR(100) NOT NULL COMMENT '模型ID',
    scene_type      VARCHAR(50)  DEFAULT 'chat' COMMENT '场景类型',

    rating          TINYINT      COMMENT '评分 1-5',
    liked           TINYINT(1)   DEFAULT 0 COMMENT '是否点赞',
    disliked        TINYINT(1)   DEFAULT 0 COMMENT '是否点踩',
    feedback_text   TEXT         COMMENT '文字反馈',

    response_time_ms INT         COMMENT '响应耗时(ms)',
    token_usage      INT         COMMENT '消耗token数',
    was_retry        TINYINT(1)  DEFAULT 0 COMMENT '是否重试后的结果',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user_model (user_id, model_id),
    INDEX idx_user_conv (user_id, conversation_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型反馈记录表';

CREATE TABLE IF NOT EXISTS user_model_usage_daily (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    model_id    VARCHAR(100) NOT NULL,
    scene_type  VARCHAR(50)  NOT NULL DEFAULT 'chat',
    stat_date   DATE         NOT NULL COMMENT '统计日期',

    call_count       INT DEFAULT 0 COMMENT '当天调用次数',
    success_count    INT DEFAULT 0 COMMENT '成功次数',
    total_tokens     BIGINT DEFAULT 0 COMMENT '消耗token数',
    total_cost       DECIMAL(10,6) DEFAULT 0 COMMENT '消耗费用',
    avg_response_time INT DEFAULT 0 COMMENT '平均响应时间(ms)',

    UNIQUE KEY uk_user_model_date (user_id, model_id, scene_type, stat_date),
    INDEX idx_user_date (user_id, stat_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户模型使用日汇总表';

-- =====================================================
-- v4.1: 订阅套餐绑定角色 + VIP/Premium 角色权限
-- =====================================================

-- Step 1: 给 subscription_plan 添加 role_id 列
ALTER TABLE subscription_plan
    ADD COLUMN role_id BIGINT NULL COMMENT '绑定的角色ID (FK→sys_role.id)'
    AFTER enabled;

ALTER TABLE subscription_plan ADD INDEX idx_plan_role (role_id);

-- Step 2: 新增 VIP 和高级会员角色
INSERT IGNORE INTO sys_role (uuid, role_name, role_code, description, status, sort_order, is_system) VALUES
    (UUID(), 'VIP会员',    'vip',     '订阅 Pro 版套餐的付费会员', 'active', 4, 0),
    (UUID(), '高级会员',   'premium', '订阅企业版套餐的高级会员',   'active', 5, 0);

-- Step 3: 为已有套餐绑定对应角色
UPDATE subscription_plan
SET role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'user' AND deleted = 0) t)
WHERE code = 'free' AND role_id IS NULL AND deleted = 0;

UPDATE subscription_plan
SET role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'vip' AND deleted = 0) t)
WHERE code = 'pro' AND role_id IS NULL AND deleted = 0;

UPDATE subscription_plan
SET role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'premium' AND deleted = 0) t)
WHERE code = 'enterprise' AND role_id IS NULL AND deleted = 0;

-- Step 4: 为 VIP 和高级会员分配权限
-- VIP会员 → 使用权限 + 模型访问
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code = 'vip' AND r.deleted = 0 AND p.deleted = 0
  AND p.permission_code IN ('skill:use', 'scenario:use', 'workflow:use', 'model:use', 'model');

-- 高级会员 → VIP权限 + 内容发布编辑权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code = 'premium' AND r.deleted = 0 AND p.deleted = 0
  AND p.permission_code IN (
    'skill', 'skill:publish', 'skill:edit', 'skill:use',
    'scenario', 'scenario:publish', 'scenario:edit', 'scenario:use',
    'workflow', 'workflow:publish', 'workflow:edit', 'workflow:use',
    'model', 'model:use'
  );

-- Step 5: 添加外键约束
ALTER TABLE subscription_plan
    ADD CONSTRAINT fk_plan_role FOREIGN KEY (role_id) REFERENCES sys_role(id) ON DELETE SET NULL;

-- =====================================================
-- v5.0: 支付模块（支付配置 + 订单 + 支付记录 + 退款 + 审计日志）
-- =====================================================

-- 支付配置表（敏感字段由应用层 AES 加密后存储，禁止明文）
CREATE TABLE IF NOT EXISTS pay_config (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    provider        VARCHAR(20)  NOT NULL COMMENT '支付渠道: alipay/wechat',
    name            VARCHAR(100) NOT NULL COMMENT '配置名称（便于识别）',
    app_id          VARCHAR(200) NOT NULL COMMENT '应用ID/商户号',
    -- 敏感字段：应用层 AES-256 加密后存储，禁止明文
    private_key_enc TEXT         COMMENT '商户私钥（加密存储）',
    public_key_enc  TEXT         COMMENT '支付宝公钥/微信平台证书（加密存储）',
    encrypt_key_enc VARCHAR(500) COMMENT 'AES加密密钥（加密存储，支付宝专用）',
    notify_url      VARCHAR(500) COMMENT '异步回调通知地址',
    return_url      VARCHAR(500) COMMENT '同步跳转返回地址',
    sandbox         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否沙箱环境: 0=生产, 1=沙箱',
    enabled         TINYINT      NOT NULL DEFAULT 1 COMMENT '是否启用',
    is_default      TINYINT      NOT NULL DEFAULT 0 COMMENT '是否默认配置（同 provider 仅一个）',
    extra_config    TEXT         COMMENT '额外配置(JSON)，如微信 apiclient_cert 等',
    created_by      BIGINT       COMMENT '创建者用户ID',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_paycfg_provider (provider),
    INDEX idx_paycfg_enabled (enabled),
    INDEX idx_paycfg_default (provider, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付配置表';

-- 订单表（状态机: pending→paid→refunded / cancelled / expired）
CREATE TABLE IF NOT EXISTS orders (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    order_no        VARCHAR(64)  NOT NULL UNIQUE COMMENT '订单号（业务生成，唯一）',
    user_id         BIGINT       NOT NULL COMMENT '下单用户ID',
    plan_id         BIGINT       COMMENT '关联套餐ID（订阅订单时有效）',
    plan_name       VARCHAR(100) COMMENT '套餐快照名称',
    -- 金额信息
    amount          DECIMAL(12,2) NOT NULL COMMENT '订单金额（¥）',
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '优惠金额（¥）',
    actual_amount   DECIMAL(12,2) NOT NULL COMMENT '实付金额（¥）',
    -- 支付信息
    payment_method  VARCHAR(20)  NOT NULL DEFAULT 'alipay' COMMENT '支付方式: alipay/wechat',
    payment_provider VARCHAR(20) COMMENT '实际支付渠道（冗余，便于查询）',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号（支付宝/微信返回）',
    -- 状态机: pending(待支付) → paid(已支付) → refunded(已退款) / cancelled(已取消) / expired(已过期)
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '订单状态',
    -- 时间节点
    paid_at         DATETIME     COMMENT '支付完成时间',
    refunded_at     DATETIME     COMMENT '退款完成时间',
    cancelled_at    DATETIME     COMMENT '取消时间',
    expired_at      DATETIME     COMMENT '过期时间',
    -- 扩展信息
    client_ip       VARCHAR(50)  COMMENT '下单客户端IP',
    user_agent      VARCHAR(500) COMMENT '下单User-Agent',
    remark          VARCHAR(500) COMMENT '订单备注',
    extra_data      TEXT         COMMENT '附加数据(JSON)',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_order_user (user_id),
    INDEX idx_order_no (order_no),
    INDEX idx_order_status (status),
    INDEX idx_order_method (payment_method),
    INDEX idx_order_paid (paid_at),
    INDEX idx_order_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

-- 支付记录表（每次支付请求/回调都记录，用于审计追溯）
CREATE TABLE IF NOT EXISTS payment_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余，便于查询）',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号',
    -- 金额
    amount          DECIMAL(12,2) NOT NULL COMMENT '支付金额（¥）',
    -- 支付状态
    payment_status  VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '支付状态: pending/success/failed/closed',
    -- 回调验签
    verify_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '验签状态: pending/verified/failed',
    verify_msg      VARCHAR(500) COMMENT '验签结果消息',
    -- 回调内容（原始数据，用于审计）
    callback_content TEXT        COMMENT '回调原始内容（JSON）',
    callback_at     DATETIME     COMMENT '回调接收时间',
    -- 请求信息
    request_content TEXT         COMMENT '下单请求参数（JSON，脱敏后）',
    response_content TEXT        COMMENT '下单响应内容（JSON，脱敏后）',
    -- 错误信息
    error_code      VARCHAR(50)  COMMENT '错误代码',
    error_msg       VARCHAR(500) COMMENT '错误消息',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_payrec_order (order_id),
    INDEX idx_payrec_trade (trade_no),
    INDEX idx_payrec_status (payment_status),
    INDEX idx_payrec_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付记录表';

-- 退款记录表
CREATE TABLE IF NOT EXISTS refund_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    refund_no       VARCHAR(64)  NOT NULL UNIQUE COMMENT '退款单号（业务生成）',
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余）',
    trade_no        VARCHAR(100) COMMENT '原交易流水号',
    -- 退款金额
    refund_amount   DECIMAL(12,2) NOT NULL COMMENT '退款金额（¥）',
    total_amount    DECIMAL(12,2) NOT NULL COMMENT '订单原金额（¥）',
    -- 退款状态: pending(申请中) → processing(处理中) → success(成功) → failed(失败)
    refund_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '退款状态',
    -- 退款信息
    reason          VARCHAR(500) COMMENT '退款原因',
    operator_id     BIGINT       COMMENT '操作人ID（管理员发起时）',
    trade_refund_no VARCHAR(100) COMMENT '第三方退款流水号',
    -- 回调
    callback_content TEXT        COMMENT '退款回调原始内容',
    callback_at     DATETIME     COMMENT '回调接收时间',
    -- 错误信息
    error_code      VARCHAR(50)  COMMENT '错误代码',
    error_msg       VARCHAR(500) COMMENT '错误消息',
    completed_at    DATETIME     COMMENT '退款完成时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_refund_order (order_id),
    INDEX idx_refund_no (refund_no),
    INDEX idx_refund_status (refund_status),
    INDEX idx_refund_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退款记录表';

-- 支付操作审计日志表（全链路记录关键操作）
CREATE TABLE IF NOT EXISTS pay_audit_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    -- 操作人信息
    operator_id     BIGINT       COMMENT '操作人ID（0=系统自动）',
    operator_name   VARCHAR(100) COMMENT '操作人名称',
    operator_ip     VARCHAR(50)  COMMENT '操作人IP',
    -- 操作目标
    action          VARCHAR(50)  NOT NULL COMMENT '操作类型: create_order/pay/callback/refund/config_update/config_view',
    target_type     VARCHAR(20)  NOT NULL COMMENT '目标类型: order/payment/refund/config',
    target_id       VARCHAR(64)  COMMENT '目标ID/订单号',
    -- 操作内容
    description     VARCHAR(500) COMMENT '操作描述',
    before_data     TEXT         COMMENT '变更前数据(JSON)',
    after_data      TEXT         COMMENT '变更后数据(JSON)',
    -- 结果
    result          VARCHAR(20)  NOT NULL DEFAULT 'success' COMMENT '操作结果: success/failed',
    error_msg       VARCHAR(500) COMMENT '错误消息（result=failed时）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_operator (operator_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_target (target_type, target_id),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付操作审计日志表';

-- 支付模块 RBAC 权限
-- 顶级菜单权限
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '支付管理', 'payment', 0, 'menu', 0),
    (UUID(), '订单管理', 'order', 0, 'menu', 0);

-- 子权限
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '支付配置', 'payment:config',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'menu',   1),
    (UUID(), '查看支付记录', 'payment:view',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'button', 2),
    (UUID(), '退款处理', 'payment:refund', (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'button', 3),
    (UUID(), '查看订单', 'order:view',    (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='order' AND deleted=0) t), 'button', 1),
    (UUID(), '导出订单', 'order:export',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='order' AND deleted=0) t), 'button', 2);

-- 超级管理员 → 支付模块全部权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='super_admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('payment', 'payment:config', 'payment:view', 'payment:refund', 'order', 'order:view', 'order:export');

-- 管理员 → 支付模块全部权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('payment', 'payment:config', 'payment:view', 'payment:refund', 'order', 'order:view', 'order:export');
