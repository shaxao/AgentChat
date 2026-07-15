-- =============================================
-- P2-3: 社区 v1 — 场景分享 + 技能评分
-- 依赖：P1-2 + 现有技能商店
-- 执行前请先备份！
-- =============================================

-- 1. agent_registry 新增社区字段
ALTER TABLE agent_registry
    ADD COLUMN IF NOT EXISTS is_public  TINYINT NOT NULL DEFAULT 0 COMMENT '是否公开（社区可见，仅 approved/active 状态可设为公开）',
    ADD COLUMN IF NOT EXISTS avg_rating DECIMAL(3,2) NOT NULL DEFAULT 0 COMMENT '平均评分（1-5星，冗余字段加速查询）',
    ADD COLUMN IF NOT EXISTS rating_count INT NOT NULL DEFAULT 0 COMMENT '评分人数';

-- 索引：按评分排序（社区热门排序）
ALTER TABLE agent_registry
    ADD INDEX IF NOT EXISTS idx_ar_is_public (is_public),
    ADD INDEX IF NOT EXISTS idx_ar_avg_rating (avg_rating);

-- 2. 技能评分表
CREATE TABLE IF NOT EXISTS skill_rating (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    agent_id    BIGINT      NOT NULL COMMENT '关联 agent_registry.id',
    user_id     BIGINT      NOT NULL COMMENT '评分用户 ID',
    rating      TINYINT     NOT NULL COMMENT '评分 1-5 星',
    comment     TEXT        COMMENT '评价内容（可选）',
    created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT     NOT NULL DEFAULT 0,

    -- 同一用户对同一技能只能有一条有效评分
    UNIQUE INDEX uk_skill_rating_user (agent_id, user_id, deleted),
    INDEX idx_sr_agent_id (agent_id),
    INDEX idx_sr_user_id (user_id),
    INDEX idx_sr_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='技能评分表';
