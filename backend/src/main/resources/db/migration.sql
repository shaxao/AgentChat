-- MuhugoChat 增量数据库迁移脚本
-- 部署到新服务器时，按顺序执行此文件中的 SQL
-- H2 和 MySQL 8.0 兼容

-- ── 2026-06-16：model_channel 增加 tags 字段（标记渠道能力：tool/vision等）──
ALTER TABLE model_channel ADD COLUMN IF NOT EXISTS tags VARCHAR(255) DEFAULT NULL COMMENT '渠道标签 JSON 数组，如 ["tool","vision"]';

-- ── 2026-06-16：sys_user 增加钱包字段（如果之前部署时缺失）──
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS balance DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS total_consumed DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS total_earned DECIMAL(10,2) DEFAULT 0.00;
ALTER TABLE sys_user ADD COLUMN IF NOT EXISTS total_recharged DECIMAL(10,2) DEFAULT 0.00;

-- ── 说明 ──
-- H2 支持 IF NOT EXISTS；MySQL 8.0 不支持，需在 MySQL 上手动移除 IF NOT EXISTS 后执行
-- 生产 MySQL 执行时用以下语句（需逐条执行，确保不重复添加）：
--   ALTER TABLE model_channel ADD COLUMN tags VARCHAR(255) DEFAULT NULL COMMENT '渠道标签 JSON 数组，如 ["tool","vision"]';
--   ALTER TABLE sys_user ADD COLUMN balance DECIMAL(10,2) DEFAULT 0.00;
--   ALTER TABLE sys_user ADD COLUMN total_consumed DECIMAL(10,2) DEFAULT 0.00;
--   ALTER TABLE sys_user ADD COLUMN total_earned DECIMAL(10,2) DEFAULT 0.00;
--   ALTER TABLE sys_user ADD COLUMN total_recharged DECIMAL(10,2) DEFAULT 0.00;
