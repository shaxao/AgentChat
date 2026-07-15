-- ============================================================
-- P2-2: 场景 + 工作流 + 记忆联调 — 数据库迁移
-- 新增: workflow.scenario_id 关联字段
-- ============================================================

-- 1. workflow 表增加 scenario_id 关联
ALTER TABLE workflow
  ADD COLUMN IF NOT EXISTS scenario_id BIGINT COMMENT '关联场景ID'
  AFTER user_id;

-- 2. 索引
CREATE INDEX IF NOT EXISTS idx_wf_scenario_id ON workflow (scenario_id);
