-- ============================================
-- AutoCode 智能模型路由 — 数据库迁移
-- 日期: 2026-06-26
-- 执行方式:
--   docker exec -i aiplatform-mysql mysql -u root -pmuhuochat MuHuoAi < migrate_model_routing.sql
-- ============================================

-- ═══ 1. 新建 autocode_model_routing 路由规则表 ═══
CREATE TABLE IF NOT EXISTS autocode_model_routing (
    id          BIGINT          AUTO_INCREMENT PRIMARY KEY,
    
    -- 路由匹配条件（'*' 表示通配，匹配所有）
    agent_type      VARCHAR(50)     NOT NULL DEFAULT '*',
    task_phase      VARCHAR(50)     NOT NULL DEFAULT '*',
    content_type    VARCHAR(50)     NOT NULL DEFAULT '*',
    complexity      VARCHAR(20)     NOT NULL DEFAULT '*',
    
    -- 模型标识（对应 model_config.model_id）
    model_id        VARCHAR(100)    NOT NULL,
    
    -- 权重与排序
    priority        INT             NOT NULL DEFAULT 100,
    weight_bonus    DECIMAL(3,2)    NOT NULL DEFAULT 0.00 COMMENT '场景亲和度加成(0.00~1.00)',
    failover_order  INT             NOT NULL DEFAULT 0 COMMENT '故障转移优先级，0=不使用',
    
    -- 管理字段
    enabled         TINYINT(1)      NOT NULL DEFAULT 1,
    created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_agent_type   (agent_type),
    INDEX idx_task_phase   (task_phase),
    INDEX idx_content_type (content_type),
    INDEX idx_complexity   (complexity),
    INDEX idx_model_id     (model_id),
    INDEX idx_enabled      (enabled),
    INDEX idx_lookup       (agent_type, task_phase, content_type, complexity, enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='AutoCode 智能模型路由规则表';


-- ═══ 2. model_config 表扩展字段 ═══
-- MySQL 5.7 不支持 ADD COLUMN IF NOT EXISTS，用存储过程安全添加
DROP PROCEDURE IF EXISTS add_column_if_not_exists;

DELIMITER //
CREATE PROCEDURE add_column_if_not_exists(
    IN tbl_name VARCHAR(128),
    IN col_name VARCHAR(128),
    IN col_def  TEXT
)
BEGIN
    DECLARE col_count INT DEFAULT 0;
    SELECT COUNT(*) INTO col_count
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = 'MuHuoAi'
      AND TABLE_NAME = tbl_name
      AND COLUMN_NAME = col_name;
    
    IF col_count = 0 THEN
        SET @stmt = CONCAT('ALTER TABLE ', tbl_name, ' ADD COLUMN ', col_name, ' ', col_def);
        PREPARE stmt FROM @stmt;
        EXECUTE stmt;
        DEALLOCATE PREPARE stmt;
    END IF;
END //
DELIMITER ;

CALL add_column_if_not_exists('model_config', 'code_quality', "INT DEFAULT 60 COMMENT '代码质量评分 (0-100)'");
CALL add_column_if_not_exists('model_config', 'strengths', "JSON DEFAULT NULL COMMENT '擅长领域'");

DROP PROCEDURE IF EXISTS add_column_if_not_exists;


-- ═══ 3. 种子数据 — 默认路由规则 ═══
-- 这些规则定义了"在什么场景下优先使用哪个模型"

-- 3.1 Researcher Agent（调研阶段）— 优先用推理能力强的模型
INSERT IGNORE INTO autocode_model_routing (agent_type, task_phase, content_type, complexity, model_id, priority, weight_bonus, failover_order, enabled)
VALUES
    ('researcher', '*', 'text', '*', 'deepseek-v4-pro', 90, 0.15, 1, 1),
    ('researcher', '*', 'text', '*', 'gpt-oss-120b', 85, 0.10, 2, 1),
    ('researcher', '*', 'text', '*', 'claude-sonnet-4-20250514', 80, 0.05, 3, 1);

-- 3.2 Frontend Agent — 代码生成场景
INSERT IGNORE INTO autocode_model_routing (agent_type, task_phase, content_type, complexity, model_id, priority, weight_bonus, failover_order, enabled)
VALUES
    ('frontend', 'implementation', 'code', 'complex', 'claude-sonnet-4-20250514', 100, 0.20, 1, 1),
    ('frontend', 'implementation', 'code', 'moderate', 'deepseek-v4-pro', 95, 0.15, 1, 1),
    ('frontend', 'implementation', 'code', 'simple', 'deepseek-chat', 100, 0.10, 1, 1),
    ('frontend', 'debugging', 'code', '*', 'claude-sonnet-4-20250514', 95, 0.15, 1, 1),
    ('frontend', 'planning', 'text', '*', 'deepseek-v4-pro', 90, 0.10, 1, 1);

-- 3.3 Backend Agent — 复杂逻辑场景
INSERT IGNORE INTO autocode_model_routing (agent_type, task_phase, content_type, complexity, model_id, priority, weight_bonus, failover_order, enabled)
VALUES
    ('backend', 'implementation', 'code', 'complex', 'claude-sonnet-4-20250514', 100, 0.20, 1, 1),
    ('backend', 'implementation', 'code', 'moderate', 'deepseek-v4-pro', 95, 0.15, 1, 1),
    ('backend', 'implementation', 'code', 'simple', 'deepseek-chat', 100, 0.10, 1, 1),
    ('backend', 'debugging', 'code', '*', 'claude-sonnet-4-20250514', 95, 0.15, 1, 1),
    ('backend', 'planning', 'text', '*', 'deepseek-v4-pro', 90, 0.10, 1, 1);

-- 3.4 DevOps Agent
INSERT IGNORE INTO autocode_model_routing (agent_type, task_phase, content_type, complexity, model_id, priority, weight_bonus, failover_order, enabled)
VALUES
    ('devops', '*', '*', '*', 'deepseek-chat', 90, 0.05, 1, 1),
    ('devops', '*', '*', '*', 'gpt-oss-120b', 85, 0.05, 2, 1);

-- 3.5 通配规则（所有 Agent 在所有场景下都可用的回退模型）
INSERT IGNORE INTO autocode_model_routing (agent_type, task_phase, content_type, complexity, model_id, priority, weight_bonus, failover_order, enabled)
VALUES
    ('*', '*', '*', 'complex', 'claude-sonnet-4-20250514', 70, 0.05, 3, 1),
    ('*', '*', '*', 'complex', 'deepseek-v4-pro', 65, 0.05, 4, 1),
    ('*', '*', '*', '*', 'deepseek-chat', 60, 0.00, 5, 1),
    ('*', '*', '*', '*', 'gpt-oss-20b', 55, 0.00, 6, 1);


-- ═══ 4. 更新现有模型的价格和代码质量评分 ═══
-- 根据已知模型补充 code_quality 和 strengths
UPDATE model_config SET 
    code_quality = 92,
    strengths = JSON_ARRAY('frontend', 'backend', 'code_generation', 'debugging')
WHERE model_id = 'claude-sonnet-4-20250514' AND code_quality IS NULL;

UPDATE model_config SET 
    code_quality = 88,
    strengths = JSON_ARRAY('reasoning', 'research', 'planning', 'code_generation')
WHERE model_id = 'deepseek-v4-pro' AND code_quality IS NULL;

UPDATE model_config SET 
    code_quality = 78,
    strengths = JSON_ARRAY('code_generation', 'devops', 'general')
WHERE model_id = 'deepseek-chat' AND code_quality IS NULL;

UPDATE model_config SET 
    code_quality = 85,
    strengths = JSON_ARRAY('reasoning', 'research', 'text_generation')
WHERE model_id = 'gpt-oss-120b' AND code_quality IS NULL;

UPDATE model_config SET 
    code_quality = 72,
    strengths = JSON_ARRAY('fast_response', 'general', 'summarization')
WHERE model_id = 'gpt-oss-20b' AND code_quality IS NULL;
