-- =============================================
-- AI Chat Platform - Database Schema
-- 兼容 H2 (开发) 和 MySQL (生产)
-- =============================================

-- 用户表
CREATE TABLE IF NOT EXISTS sys_user (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid        VARCHAR(36)  NOT NULL UNIQUE,
    username    VARCHAR(50)  NOT NULL UNIQUE,
    email       VARCHAR(100) NOT NULL UNIQUE,
    password    VARCHAR(255) NOT NULL,
    avatar      VARCHAR(500),
    role        VARCHAR(20)  NOT NULL DEFAULT 'user'   COMMENT 'admin/user',
    plan        VARCHAR(20)  NOT NULL DEFAULT 'free'   COMMENT 'free/pro/enterprise',
    status      VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active/suspended/pending',
    email_verified BOOLEAN  NOT NULL DEFAULT FALSE,
    tokens_used BIGINT       NOT NULL DEFAULT 0,
    tokens_limit BIGINT      NOT NULL DEFAULT 50000,
    cost_used      DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT 'current cycle model cost used',
    cost_limit     DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT 'current cycle model cost limit',
    balance         DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '账户余额（¥）',
    total_consumed  DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计消费（¥）',
    total_earned    DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计收益（开发者分成，¥）',
    total_recharged DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计充值（¥）',
    last_login_at DATETIME,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT      NOT NULL DEFAULT 0
);

-- 对话表（context_summary: 早期对话摘要，用于超长对话的记忆压缩）
CREATE TABLE IF NOT EXISTS chat_conversation (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL,
    title           VARCHAR(200) NOT NULL DEFAULT '新对话',
    model           VARCHAR(50)  NOT NULL DEFAULT 'gpt-4o',
    system_prompt   TEXT,
    pinned          BOOLEAN      NOT NULL DEFAULT FALSE,
    tags            VARCHAR(500),
    context_summary TEXT         COMMENT '早期对话摘要，用于超长对话记忆压缩',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- 消息表
CREATE TABLE IF NOT EXISTS chat_message (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    conversation_id BIGINT       NOT NULL,
    role            VARCHAR(20)  NOT NULL COMMENT 'user/assistant/system',
    content         TEXT         NOT NULL,
    model           VARCHAR(50),
    input_tokens    INT          DEFAULT 0,
    output_tokens   INT          DEFAULT 0,
    cost            DECIMAL(10,6) DEFAULT 0,
    latency_ms      INT          DEFAULT 0,
    status          VARCHAR(20)  NOT NULL DEFAULT 'success' COMMENT 'success/error',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- 模型渠道表
CREATE TABLE IF NOT EXISTS model_channel (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid        VARCHAR(36)  NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    provider    VARCHAR(50)  NOT NULL,
    api_key     VARCHAR(500) NOT NULL,
    base_url    VARCHAR(500) NOT NULL,
    models      TEXT         COMMENT 'JSON array of model ids',
    channel_type VARCHAR(20) NOT NULL DEFAULT 'chat' COMMENT 'chat/translate/tts/asr/image/search',
    tags         VARCHAR(255) DEFAULT NULL COMMENT '渠道标签 JSON 数组，如 ["tool","vision"]',
    tts_voices   VARCHAR(2000) DEFAULT NULL COMMENT 'TTS 音色配置 JSON 数组，仅 channel_type=tts 时有效',
    translate_langs VARCHAR(2000) DEFAULT NULL COMMENT '翻译支持语言配置 JSON 数组，仅 channel_type=translate 时有效',
    status      VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active/error/disabled',
    priority    INT          NOT NULL DEFAULT 1,
    rate_limit  INT          NOT NULL DEFAULT 60,
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT      NOT NULL DEFAULT 0
);

-- 模型配置表
CREATE TABLE IF NOT EXISTS model_config (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    model_id        VARCHAR(100) NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL,
    provider        VARCHAR(50)  NOT NULL,
    description     VARCHAR(500),
    context_length  INT          NOT NULL DEFAULT 4096,
    input_price     DECIMAL(10,4) NOT NULL DEFAULT 0,
    cached_input_price DECIMAL(10,4) NOT NULL DEFAULT 0,
    output_price    DECIMAL(10,4) NOT NULL DEFAULT 0,
    capabilities    VARCHAR(200) COMMENT 'comma-separated: text,vision,code,reasoning,audio,image',
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    -- 路由所需字段
    code_quality    DECIMAL(3,2) DEFAULT 0.80 COMMENT '代码质量评分 (0~1)',
    strengths       VARCHAR(500) COMMENT '模型优势 JSON 数组，如 ["vision","reasoning"]',
    task_types      VARCHAR(500) COMMENT '擅长任务类型 JSON 数组，如 ["chat","code","image"]',
    routing_priority INT         NOT NULL DEFAULT 1 COMMENT '路由优先级 (1~10)',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- 订阅套餐定义表（管理员配置）
CREATE TABLE IF NOT EXISTS subscription_plan (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL COMMENT '套餐名称',
    code            VARCHAR(50)  NOT NULL UNIQUE COMMENT '套餐代码 free/pro/enterprise/custom',
    description     VARCHAR(500) COMMENT '套餐描述',
    price           DECIMAL(10,2) NOT NULL DEFAULT 0 COMMENT '月价格（元）',
    cost_limit      DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '月度模型消费金额额度',
    tokens_limit    BIGINT       NOT NULL DEFAULT 50000 COMMENT 'Token 月限额',
    model_limit     VARCHAR(500) COMMENT '允许使用的模型，逗号分隔，空表示不限',
    features        TEXT         COMMENT '功能列表，JSON 数组',
    sort_order      INT          NOT NULL DEFAULT 0 COMMENT '排序',
    is_popular      BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '是否推荐',
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    role_id         BIGINT       NULL     COMMENT '绑定的角色ID (FK→sys_role.id)',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_plan_role (role_id),
    CONSTRAINT fk_plan_role FOREIGN KEY (role_id) REFERENCES sys_role(id) ON DELETE SET NULL
);

-- 订阅表（用户订阅记录）
CREATE TABLE IF NOT EXISTS subscription (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL,
    plan_id         BIGINT       COMMENT '关联套餐 ID',
    plan            VARCHAR(20)  NOT NULL COMMENT 'free/pro/enterprise/custom',
    plan_name       VARCHAR(100) COMMENT '套餐显示名称',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active/cancelled/expired',
    price           DECIMAL(10,2) NOT NULL DEFAULT 0,
    cost_limit      DECIMAL(12,4) NOT NULL DEFAULT 0,
    cost_used       DECIMAL(12,4) NOT NULL DEFAULT 0,
    tokens_limit    BIGINT       NOT NULL DEFAULT 50000,
    model_limit     VARCHAR(500),
    features        TEXT         COMMENT '订阅级功能与计费策略覆盖，JSON',
    payment_method  VARCHAR(50)  COMMENT '支付方式',
    payment_ref     VARCHAR(200) COMMENT '支付流水号',
    start_date      DATE         NOT NULL,
    end_date        DATE         NOT NULL,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- Agent 注册表（开放平台核心）
-- status 状态机：注册→pending→管理员审核→approved(上架)/rejected(驳回)；上架后 admin 可 disabled
CREATE TABLE IF NOT EXISTS agent_registry (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id        VARCHAR(100) NOT NULL UNIQUE COMMENT 'Agent 唯一标识（如 ban-biao）',
    name            VARCHAR(200) NOT NULL COMMENT '显示名称',
    version         VARCHAR(20)  NOT NULL DEFAULT '1.0.0',
    description     TEXT         COMMENT 'Agent 功能描述',
    categories      VARCHAR(500) COMMENT '分类标签，逗号分隔（如 文档识别,数据处理）',
    model           VARCHAR(50)  NOT NULL DEFAULT 'gpt-4o' COMMENT '推荐模型',
    temperature     DOUBLE       NOT NULL DEFAULT 0.1,
    max_tokens      INT          NOT NULL DEFAULT 8192,
    system_prompt   TEXT         NOT NULL COMMENT '系统提示词',
    tools_json      TEXT         COMMENT '工具定义 JSON 数组（OpenAI Function Calling 格式）',
    depends_on      TEXT         COMMENT '依赖的其他 Skill agentId，JSON 数组如 ["skill-a","skill-b"]',
    hooks_json      TEXT         COMMENT '生命周期钩子 JSON（onStart/onToolCall/onDone）',
    icon            VARCHAR(500) COMMENT 'Agent 图标 URL',
    author          VARCHAR(100) COMMENT '作者',
    api_key         VARCHAR(200) COMMENT 'Agent 注册时的 API Key',
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '审核状态：pending/approved/rejected/active/disabled',
    is_builtin      BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '是否内置 Agent',
    sort_order      INT          NOT NULL DEFAULT 0,
    created_by      BIGINT       COMMENT '创建者用户 ID',
    review_comment  VARCHAR(500) COMMENT '审核意见（通过/驳回时填写）',
    reviewed_by     BIGINT       COMMENT '审核人用户 ID',
    reviewed_at     DATETIME     COMMENT '审核时间',
    screenshots     TEXT         COMMENT '应用截图 JSON 数组',
    usage_guide     TEXT         COMMENT '使用说明',
    revenue_ratio   DECIMAL(5,4) NOT NULL DEFAULT 0.3000 COMMENT '开发者分成比例（0~1，默认 30%）',
    is_certified    TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '是否官方认证（P3-4）',
    -- P2-3: 社区字段
    is_public       TINYINT      NOT NULL DEFAULT 0 COMMENT '是否公开（社区可见，仅 approved/active 状态可设为公开）',
    avg_rating      DECIMAL(3,2) NOT NULL DEFAULT 0 COMMENT '平均评分（1-5星）',
    rating_count    INT          NOT NULL DEFAULT 0 COMMENT '评分人数',
    total_usage     BIGINT       NOT NULL DEFAULT 0 COMMENT '总使用次数',
    total_revenue   DECIMAL(12,4) NOT NULL DEFAULT 0 COMMENT '累计分成收入',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_ar_is_public (is_public),
    INDEX idx_ar_avg_rating (avg_rating)
);

-- 调用日志表
CREATE TABLE IF NOT EXISTS api_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT,
    conversation_id BIGINT,
    model           VARCHAR(100),
    scene_type      VARCHAR(50)  NOT NULL DEFAULT 'chat' COMMENT '场景类型：chat/autocode/translate/image/asr',
    input_tokens    INT          DEFAULT 0,
    cached_input_tokens INT      DEFAULT 0,
    output_tokens   INT          DEFAULT 0,
    cost            DECIMAL(12,8) DEFAULT 0,
    latency_ms      INT          DEFAULT 0,
    status          VARCHAR(20)  NOT NULL DEFAULT 'success',
    error_msg       TEXT,
    request_ip      VARCHAR(100),
    provider        VARCHAR(50),
    channel_id      VARCHAR(100),
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 用户安装的技能表（我的技能）
CREATE TABLE IF NOT EXISTS user_api_key (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid          VARCHAR(64)  NOT NULL,
    user_id       BIGINT       NOT NULL,
    name          VARCHAR(100) NOT NULL DEFAULT 'Default API Key',
    key_prefix    VARCHAR(32)  NOT NULL,
    key_hash      VARCHAR(128) NOT NULL,
    key_enc       TEXT         NOT NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'active',
    expires_at    DATETIME     NULL,
    last_used_at  DATETIME     NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted       TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_user_api_key_uuid (uuid),
    UNIQUE KEY uk_user_api_key_hash (key_hash),
    INDEX idx_user_api_key_user_status (user_id, status, deleted),
    INDEX idx_user_api_key_prefix (key_prefix)
);

CREATE TABLE IF NOT EXISTS user_installed_skills (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户 ID',
    agent_id        VARCHAR(200) NOT NULL COMMENT '技能 agentId',
    installed_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uk_user_agent (user_id, agent_id)
);

-- 钱包流水表
CREATE TABLE IF NOT EXISTS wallet_transaction (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户 ID',
    type            VARCHAR(20)  NOT NULL COMMENT '交易类型：deposit/withdraw/consume/earn/refund',
    amount          DECIMAL(12,4) NOT NULL COMMENT '交易金额（¥）',
    balance_before  DECIMAL(12,4) NOT NULL COMMENT '交易前余额',
    balance_after   DECIMAL(12,4) NOT NULL COMMENT '交易后余额',
    description     VARCHAR(500) COMMENT '交易描述',
    ref_type        VARCHAR(50)  COMMENT '关联类型：chat/agent_share/recharge/withdraw',
    ref_id          VARCHAR(100) COMMENT '关联 ID（对话 uuid/agent_id/充值单号）',
    status          VARCHAR(20)  NOT NULL DEFAULT 'success' COMMENT '交易状态：success/pending/failed',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- =============================================
-- 对话记忆系统（基于 Coze 记忆架构设计）
-- =============================================

-- 基础设定表（对应 Coze 的 基础设定/ 目录：SOUL.md / TOOLS.md / RULES.md）
CREATE TABLE IF NOT EXISTS memory_setting (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    setting_key     VARCHAR(100) NOT NULL UNIQUE COMMENT '设定键：soul/tools/rules/email_rules',
    setting_name    VARCHAR(200) NOT NULL COMMENT '设定名称（显示用）',
    content         TEXT         NOT NULL COMMENT 'Markdown 格式的设定内容',
    sort_order      INT          NOT NULL DEFAULT 0 COMMENT '排序',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- 记忆文档表（统一存储对话记忆/项目记忆/用户画像/凭据/工作文件元数据）
-- 对应 Coze 的 MEMORY.md / USER.md / SECRET.md / recent_memory/project/*.md
CREATE TABLE IF NOT EXISTS memory_document (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    conversation_id BIGINT       COMMENT '所属对话（NULL 表示全局）',
    doc_type        VARCHAR(30)  NOT NULL COMMENT '文档类型：conversation_summary/project_memory/user_profile/secret/skill_memory/work_file_meta',
    title           VARCHAR(300) NOT NULL COMMENT '文档标题',
    content         TEXT         COMMENT 'Markdown 格式的文档内容（秘密类可加密存储）',
    category        VARCHAR(100) COMMENT '分类标签（如 project/skill/system）',
    tags            VARCHAR(500) COMMENT '标签，逗号分隔',
    importance      INT          NOT NULL DEFAULT 3 COMMENT '重要性 1-5',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT 'active/archived/expired',
    layer           VARCHAR(8)   NOT NULL DEFAULT 'L2' COMMENT '记忆层级：L1热/L2温/L3冷/L4归档',
    virtual_path    VARCHAR(512) COMMENT 'VFS 虚拟路径',
    access_count    INT          NOT NULL DEFAULT 0 COMMENT '访问计数，用于压缩/归档决策',
    last_accessed_at DATETIME    COMMENT '最近访问时间',
    source_conv_uuid VARCHAR(36) COMMENT '来源对话 UUID（项目记忆追溯）',
    expires_at      DATETIME     COMMENT '过期时间（NULL 表示永不过期）',
    file_size       BIGINT       DEFAULT 0 COMMENT '关联文件大小（work_file_meta 类型）',
    file_type       VARCHAR(50)  COMMENT '关联文件类型（work_file_meta 类型）',
    oss_url         VARCHAR(1000) COMMENT '关联文件 OSS URL（work_file_meta 类型）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_md_user_id (user_id),
    INDEX idx_md_conv_id (conversation_id),
    INDEX idx_md_doc_type (doc_type),
    INDEX idx_md_category (category),
    INDEX idx_md_layer (layer),
    INDEX idx_md_last_accessed (last_accessed_at),
    INDEX idx_md_created_at (created_at)
);

-- 记忆索引表（JSON 结构化元数据，用于快速检索）
-- 对应 Coze 的 recent_memory/index.json
-- MySQL 生产环境建议额外执行: ALTER TABLE memory_index ADD FULLTEXT INDEX ft_summary_tags (summary, tags);
CREATE TABLE IF NOT EXISTS memory_index (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    doc_id          BIGINT       NOT NULL COMMENT '关联 memory_document.id',
    category        VARCHAR(100) NOT NULL COMMENT '分类：project/skill/user_setting',
    summary         VARCHAR(500) NOT NULL COMMENT '简要摘要，用于快速展示和检索',
    tags            VARCHAR(500) COMMENT '逗号分隔的标签',
    importance      INT          NOT NULL DEFAULT 3 COMMENT '重要性 1-5',
    expires_at      DATETIME     COMMENT '过期时间',
    layer           VARCHAR(8)   NOT NULL DEFAULT 'L2' COMMENT '记忆层级',
    virtual_path    VARCHAR(512) COMMENT 'VFS 虚拟路径',
    access_count    INT          NOT NULL DEFAULT 0 COMMENT '访问计数',
    last_accessed_at DATETIME    COMMENT '最近访问时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_mi_user_id (user_id),
    INDEX idx_mi_doc_id (doc_id),
    INDEX idx_mi_category (category),
    INDEX idx_mi_layer (layer)
);

CREATE TABLE IF NOT EXISTS memory_archive (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    source_doc_id   BIGINT       COMMENT '来源 memory_document.id',
    title           VARCHAR(300) NOT NULL,
    doc_type        VARCHAR(30),
    category        VARCHAR(100),
    content         MEDIUMTEXT   COMMENT '下沉的完整内容',
    summary         VARCHAR(500),
    tags            VARCHAR(500),
    layer_from      VARCHAR(8)   COMMENT '归档前层级',
    archived_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    restore_key     VARCHAR(64)  COMMENT '恢复键',
    INDEX idx_ma_user_id (user_id),
    INDEX idx_ma_source_doc (source_doc_id)
);

-- 工作文件物理存储表（对话中产生/上传的文件）
CREATE TABLE IF NOT EXISTS memory_work_file (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL COMMENT '所属用户',
    conversation_id BIGINT       COMMENT '来源对话',
    doc_id          BIGINT       COMMENT '关联 memory_document.id（文件元数据）',
    file_name       VARCHAR(500) NOT NULL COMMENT '原始文件名',
    file_type       VARCHAR(50)  NOT NULL COMMENT '文件类型：image/document/spreadsheet/audio/video/skill/other',
    file_size       BIGINT       NOT NULL DEFAULT 0 COMMENT '文件大小（字节）',
    mime_type       VARCHAR(100) COMMENT 'MIME 类型',
    oss_url         VARCHAR(1000) NOT NULL COMMENT 'OSS 存储 URL',
    thumb_url       VARCHAR(1000) COMMENT '缩略图 URL',
    description     VARCHAR(500) COMMENT '文件描述',
    tags            VARCHAR(500) COMMENT '标签',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_mwf_user_id (user_id),
    INDEX idx_mwf_conv_id (conversation_id),
    INDEX idx_mwf_file_type (file_type),
    INDEX idx_mwf_created_at (created_at)
);

-- OSS 存储配置表（支持阿里云/腾讯云/MinIO 多厂商）
CREATE TABLE IF NOT EXISTS oss_config (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    name            VARCHAR(100) NOT NULL COMMENT '配置名称',
    provider        VARCHAR(20)  NOT NULL COMMENT '提供商：aliyun/tencent/minio',
    endpoint        VARCHAR(500) NOT NULL COMMENT 'Endpoint 地址',
    region          VARCHAR(100) COMMENT '区域（阿里云/腾讯云需要）',
    bucket          VARCHAR(200) NOT NULL COMMENT 'Bucket 名称',
    access_key      VARCHAR(500) NOT NULL COMMENT 'Access Key / SecretId',
    secret_key      VARCHAR(500) NOT NULL COMMENT 'Secret Key',
    base_path       VARCHAR(200) DEFAULT 'tool_results' COMMENT '存储路径前缀',
    is_default      BOOLEAN      NOT NULL DEFAULT FALSE COMMENT '是否默认配置',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active' COMMENT '状态：active/disabled/error',
    last_test_at    DATETIME     COMMENT '最后测试连接时间',
    test_result     TEXT COMMENT '最后测试结果',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0
);

-- =============================================
-- 场景系统（职业/行业场景入口，战略改造 v2.0）
-- =============================================
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
    INDEX idx_scenario_usage (usage_count),
    UNIQUE INDEX uk_scenario_name_profession (name, profession)
);

-- =============================================
-- 模型路由系统（智能模型选择，战略改造 v2.0）
-- =============================================

-- 模型路由规则表（配置场景→模型映射）
CREATE TABLE IF NOT EXISTS model_routing_rule (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NULL COMMENT 'NULL 表示全局规则；非空表示用户个人规则',
    rule_name       VARCHAR(100)  NOT NULL COMMENT '规则名称',
    description     VARCHAR(500) COMMENT '规则描述',
    scene_type      VARCHAR(50)   NOT NULL COMMENT '场景类型: chat/vision/code/image/agent',
    agent_type      VARCHAR(50)   COMMENT 'Agent类型（可选，如 ledger/text2code）',
    complexity      VARCHAR(20)   COMMENT '复杂度: simple/moderate/complex',
    required_tags   VARCHAR(255) COMMENT '必需能力标签 JSON 数组，如 ["tool","vision"]',
    preferred_providers VARCHAR(255) COMMENT '优先供应商 JSON 数组',
    min_context_length INT COMMENT '最小上下文长度',
    max_input_price DECIMAL(12,6) COMMENT '最大输入价格',
    max_output_price DECIMAL(12,6) COMMENT '最大输出价格',
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

-- 模型路由统计表（跟踪模型调用情况，支持熔断器）
CREATE TABLE IF NOT EXISTS model_routing_stats (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    model_id        VARCHAR(100) NOT NULL COMMENT '模型ID（关联 model_config.model_id）',
    scene_type      VARCHAR(50)  NOT NULL COMMENT '场景类型',
    total_calls     BIGINT       NOT NULL DEFAULT 0 COMMENT '总调用次数',
    success_calls   BIGINT       NOT NULL DEFAULT 0 COMMENT '成功调用次数',
    failed_calls    BIGINT       NOT NULL DEFAULT 0 COMMENT '失败调用次数',
    avg_response_time INTEGER    NOT NULL DEFAULT 0 COMMENT '平均响应时间(ms)',
    last_success_at DATETIME     COMMENT '最后一次成功时间',
    last_failure_at DATETIME     COMMENT '最后一次失败时间',
    consecutive_failures INTEGER NOT NULL DEFAULT 0 COMMENT '连续失败次数',
    circuit_breaker_state VARCHAR(20) NOT NULL DEFAULT 'closed' COMMENT '熔断器状态: closed/open/half-open',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT(1)   NOT NULL DEFAULT 0 COMMENT '逻辑删除',
    UNIQUE INDEX uk_mrs_model_scene (model_id, scene_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型路由统计表';

-- =============================================
-- 工作流引擎（战略改造 v2.0 P2-1）
-- =============================================

-- 工作流定义表
CREATE TABLE IF NOT EXISTS workflow (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '创建者用户ID',
    scenario_id     BIGINT       COMMENT '关联场景ID（P2-2）',
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
    INDEX idx_wf_scenario_id (scenario_id),
    INDEX idx_wf_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作流定义表';

-- 工作流执行记录表
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

-- 工作流资产表：文件、识别结果、节点产物等统一引用
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

-- 工作流步骤执行记录表
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

-- 工作流执行事件表：用于实时进度、审计和后续 SSE
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
-- 工作流模板市场（战略改造 v3.0 P3-2）
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
-- 技能收益记录（战略改造 v3.0 P3-4 创作者激励）
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

-- =============================================
-- 技能评分表（P2-3 社区 v1）
-- =============================================
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

-- =============================================
-- v2.0: 知识图谱（P3-1 记忆系统 v2）
-- =============================================
CREATE TABLE IF NOT EXISTS kg_entity (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    user_id         BIGINT       NOT NULL,
    name            VARCHAR(200) NOT NULL COMMENT '实体名称',
    entity_type     VARCHAR(50)  NOT NULL COMMENT '实体类型：person/place/organization/product/number/concept',
    properties      JSON         COMMENT '属性',
    confidence      DECIMAL(3,2) NOT NULL DEFAULT 0.80 COMMENT '提取置信度',
    aliases         VARCHAR(500) COMMENT '别名',
    source_conv_uuid VARCHAR(36) COMMENT '来源对话',
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
    subject_entity_id BIGINT       NOT NULL COMMENT '主语实体',
    predicate         VARCHAR(100) NOT NULL COMMENT '谓词',
    object_entity_id  BIGINT       COMMENT '宾语实体',
    object_value      VARCHAR(500) COMMENT '宾语字面值',
    confidence        DECIMAL(3,2) NOT NULL DEFAULT 0.80 COMMENT '置信度',
    source_conv_uuid  VARCHAR(36) COMMENT '来源对话',
    created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted           TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_kg_r_user_id (user_id),
    INDEX idx_kg_r_subject (subject_entity_id),
    INDEX idx_kg_r_object (object_entity_id),
    INDEX idx_kg_r_predicate (predicate),
    UNIQUE KEY uk_triple (subject_entity_id, predicate, object_entity_id, object_value)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='知识图谱关系表';

-- =============================================
-- v3.1: 用户模型偏好系统
-- =============================================
CREATE TABLE IF NOT EXISTS user_model_preference (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id     BIGINT       NOT NULL COMMENT '用户ID → sys_user.id',
    model_id    VARCHAR(100) NOT NULL COMMENT '模型ID → model_config.model_id',
    scene_type  VARCHAR(50)  NOT NULL DEFAULT 'chat' COMMENT '场景: chat/vision/code/image/agent',

    preference_weight DECIMAL(4,3) DEFAULT 0.000 COMMENT '偏好权重 (-1.0 ~ +1.0)，正数偏好、负数排斥',
    usage_count       INT          DEFAULT 0     COMMENT '该场景下使用该模型的累计次数',
    like_count        INT          DEFAULT 0     COMMENT '用户点赞次数',
    dislike_count     INT          DEFAULT 0     COMMENT '用户点踩次数',
    avg_response_time INT          DEFAULT 0     COMMENT '该用户在该模型上的平均响应时间(ms)',
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

    rating          TINYINT      COMMENT '评分 1-5 (null=未评分)',
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

-- =============================================
-- v4.0: RBAC 权限管理系统
-- =============================================

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

-- =============================================
-- 通知系统
-- =============================================

-- 系统通知表（公告/审核结果通知/系统通知）
CREATE TABLE IF NOT EXISTS sys_notification (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    title           VARCHAR(200) NOT NULL COMMENT '通知标题',
    content         TEXT         NOT NULL COMMENT '通知内容',
    type            VARCHAR(50)  NOT NULL DEFAULT 'announcement' COMMENT '通知类型: announcement/skill_review/system',
    target_type     VARCHAR(50)  NOT NULL DEFAULT 'all' COMMENT '推送目标: all=全部用户, specific=指定用户',
    target_user_ids TEXT         COMMENT '目标用户ID列表(逗号分隔)，target_type=specific 时有效',
    extra_data      TEXT         COMMENT '附加数据(JSON)，如技能名称、审核原因等',
    created_by      BIGINT       NOT NULL COMMENT '创建者用户ID',
    status          VARCHAR(20)  NOT NULL DEFAULT 'published' COMMENT '状态: draft/published',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_sn_type (type),
    INDEX idx_sn_status (status),
    INDEX idx_sn_created_by (created_by),
    INDEX idx_sn_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统通知表';

-- 用户通知记录表（跟踪每个用户的通知投递和已读状态）
CREATE TABLE IF NOT EXISTS user_notification (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户ID',
    notification_id BIGINT       NOT NULL COMMENT '关联 sys_notification.id',
    is_read         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否已读: 0=未读, 1=已读',
    read_at         DATETIME     COMMENT '阅读时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uk_user_notification (user_id, notification_id),
    INDEX idx_un_user_id (user_id),
    INDEX idx_un_notification_id (notification_id),
    INDEX idx_un_is_read (user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户通知记录表';

-- 用户隐私设置表
CREATE TABLE IF NOT EXISTS user_privacy_setting (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id          BIGINT       NOT NULL UNIQUE COMMENT '用户ID',
    save_history     TINYINT      NOT NULL DEFAULT 1 COMMENT '保存对话历史: 0=关闭, 1=开启',
    data_improvement TINYINT      NOT NULL DEFAULT 0 COMMENT '数据用于改进: 0=关闭, 1=开启',
    two_factor_auth  TINYINT      NOT NULL DEFAULT 0 COMMENT '两步验证: 0=关闭, 1=开启',
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ups_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户隐私设置表';

-- =============================================
-- 支付模块
-- =============================================

-- 支付配置表（敏感字段由应用层 AES 加密后存储，禁止明文）
CREATE TABLE IF NOT EXISTS pay_config (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    provider        VARCHAR(20)  NOT NULL COMMENT '支付渠道: alipay/wechat',
    name            VARCHAR(100) NOT NULL COMMENT '配置名称',
    app_id          VARCHAR(200) NOT NULL COMMENT '应用ID/商户号',
    private_key_enc TEXT         COMMENT '商户私钥（加密存储）',
    public_key_enc  TEXT         COMMENT '支付宝公钥/微信平台证书（加密存储）',
    encrypt_key_enc VARCHAR(500) COMMENT 'AES加密密钥（加密存储，支付宝专用）',
    notify_url      VARCHAR(500) COMMENT '异步回调通知地址',
    return_url      VARCHAR(500) COMMENT '同步跳转返回地址',
    sandbox         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否沙箱环境: 0=生产, 1=沙箱',
    enabled         TINYINT      NOT NULL DEFAULT 1 COMMENT '是否启用',
    is_default      TINYINT      NOT NULL DEFAULT 0 COMMENT '是否默认配置',
    extra_config    TEXT         COMMENT '额外配置(JSON)',
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
    order_no        VARCHAR(64)  NOT NULL UNIQUE COMMENT '订单号',
    user_id         BIGINT       NOT NULL COMMENT '下单用户ID',
    plan_id         BIGINT       COMMENT '关联套餐ID',
    plan_name       VARCHAR(100) COMMENT '套餐快照名称',
    amount          DECIMAL(12,2) NOT NULL COMMENT '订单金额（¥）',
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '优惠金额（¥）',
    actual_amount   DECIMAL(12,2) NOT NULL COMMENT '实付金额（¥）',
    payment_method  VARCHAR(20)  NOT NULL DEFAULT 'alipay' COMMENT '支付方式: alipay/wechat',
    payment_provider VARCHAR(20) COMMENT '实际支付渠道',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号',
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '订单状态: pending/paid/refunded/cancelled/expired',
    paid_at         DATETIME     COMMENT '支付完成时间',
    refunded_at     DATETIME     COMMENT '退款完成时间',
    cancelled_at    DATETIME     COMMENT '取消时间',
    expired_at      DATETIME     COMMENT '过期时间',
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

-- 支付记录表
CREATE TABLE IF NOT EXISTS payment_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余）',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号',
    amount          DECIMAL(12,2) NOT NULL COMMENT '支付金额（¥）',
    payment_status  VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '支付状态: pending/success/failed/closed',
    verify_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '验签状态: pending/verified/failed',
    verify_msg      VARCHAR(500) COMMENT '验签结果消息',
    callback_content TEXT        COMMENT '回调原始内容（JSON）',
    callback_at     DATETIME     COMMENT '回调接收时间',
    request_content TEXT         COMMENT '下单请求参数（JSON，脱敏后）',
    response_content TEXT        COMMENT '下单响应内容（JSON，脱敏后）',
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
    refund_no       VARCHAR(64)  NOT NULL UNIQUE COMMENT '退款单号',
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余）',
    trade_no        VARCHAR(100) COMMENT '原交易流水号',
    refund_amount   DECIMAL(12,2) NOT NULL COMMENT '退款金额（¥）',
    total_amount    DECIMAL(12,2) NOT NULL COMMENT '订单原金额（¥）',
    refund_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '退款状态: pending/processing/success/failed',
    reason          VARCHAR(500) COMMENT '退款原因',
    operator_id     BIGINT       COMMENT '操作人ID',
    trade_refund_no VARCHAR(100) COMMENT '第三方退款流水号',
    callback_content TEXT        COMMENT '退款回调原始内容',
    callback_at     DATETIME     COMMENT '回调接收时间',
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

-- 支付操作审计日志表
CREATE TABLE IF NOT EXISTS pay_audit_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    operator_id     BIGINT       COMMENT '操作人ID（0=系统自动）',
    operator_name   VARCHAR(100) COMMENT '操作人名称',
    operator_ip     VARCHAR(50)  COMMENT '操作人IP',
    action          VARCHAR(50)  NOT NULL COMMENT '操作类型: create_order/pay/callback/refund/config_update/config_view',
    target_type     VARCHAR(20)  NOT NULL COMMENT '目标类型: order/payment/refund/config',
    target_id       VARCHAR(64)  COMMENT '目标ID/订单号',
    description     VARCHAR(500) COMMENT '操作描述',
    before_data     TEXT         COMMENT '变更前数据(JSON)',
    after_data      TEXT         COMMENT '变更后数据(JSON)',
    result          VARCHAR(20)  NOT NULL DEFAULT 'success' COMMENT '操作结果: success/failed',
    error_msg       VARCHAR(500) COMMENT '错误消息',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_operator (operator_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_target (target_type, target_id),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付操作审计日志表';
-- Harness Evolution: trace prompts, tool calls, failures and candidate harness patches.
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
VALUES (UUID(), 'Harness 演进', 'harness', 0, 'menu', 0);

INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '查看 Harness 演进', 'harness:view',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) t), 'menu', 1),
    (UUID(), '管理 Harness 候选改进', 'harness:patch',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) t), 'button', 2),
    (UUID(), '管理 Harness 回归样本', 'harness:regression',
        (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='harness' AND deleted=0 ORDER BY id ASC LIMIT 1) t), 'button', 3);

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
WHERE r.role_code='super_admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');
