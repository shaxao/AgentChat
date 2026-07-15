-- 迁移: autocode_tasks 表添加 user_id 列，实现用户数据隔离
-- 日期: 2026-07-02

-- 添加 user_id 列（如果不存在）
ALTER TABLE autocode_tasks ADD COLUMN user_id VARCHAR(64) DEFAULT NULL;

-- 添加索引（如果不存在）
ALTER TABLE autocode_tasks ADD INDEX idx_user_id (user_id);
