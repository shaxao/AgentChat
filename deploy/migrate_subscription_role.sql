-- =============================================
-- 迁移：订阅套餐绑定角色 + 新增 VIP/Premium 角色
-- 执行方式：.\deploy.ps1 migrate-db deploy\migrate_subscription_role.sql
-- 幂等安全：可重复执行 (MySQL 5.7/8.0 兼容版)
-- =============================================

-- Step 1: 给 subscription_plan 添加 role_id 列（幂等）
DELIMITER $$

CREATE PROCEDURE IF NOT EXISTS migrate_sub_role()
BEGIN
    -- 1a. 添加 role_id 列
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = 'MuHuoAi'
          AND TABLE_NAME = 'subscription_plan'
          AND COLUMN_NAME = 'role_id'
    ) THEN
        ALTER TABLE subscription_plan
            ADD COLUMN role_id BIGINT NULL COMMENT '绑定的角色ID (FK→sys_role.id)';
    END IF;

    -- 1b. 添加索引
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = 'MuHuoAi'
          AND TABLE_NAME = 'subscription_plan'
          AND INDEX_NAME = 'idx_plan_role'
    ) THEN
        ALTER TABLE subscription_plan ADD INDEX idx_plan_role (role_id);
    END IF;

    -- Step 4: 外键约束（先删后加）
    IF EXISTS (
        SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
        WHERE TABLE_SCHEMA = 'MuHuoAi'
          AND TABLE_NAME = 'subscription_plan'
          AND CONSTRAINT_NAME = 'fk_plan_role'
    ) THEN
        ALTER TABLE subscription_plan DROP FOREIGN KEY fk_plan_role;
    END IF;

    ALTER TABLE subscription_plan
        ADD CONSTRAINT fk_plan_role FOREIGN KEY (role_id) REFERENCES sys_role(id) ON DELETE SET NULL;
END$$

DELIMITER ;

CALL migrate_sub_role();
DROP PROCEDURE IF EXISTS migrate_sub_role;

-- Step 2: 新增 VIP 和高级会员角色
INSERT IGNORE INTO sys_role (uuid, role_name, role_code, description, status, sort_order, is_system) VALUES
    (UUID(), 'VIP会员',    'vip',     '订阅 Pro 版套餐的付费会员', 'active', 4, 0),
    (UUID(), '高级会员',   'premium', '订阅企业版套餐的高级会员',   'active', 5, 0);

-- Step 3: 为已有套餐绑定对应角色
UPDATE subscription_plan sp
SET sp.role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'user' AND deleted = 0) t)
WHERE sp.code = 'free' AND sp.role_id IS NULL AND sp.deleted = 0;

UPDATE subscription_plan sp
SET sp.role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'vip' AND deleted = 0) t)
WHERE sp.code = 'pro' AND sp.role_id IS NULL AND sp.deleted = 0;

UPDATE subscription_plan sp
SET sp.role_id = (SELECT id FROM (SELECT id FROM sys_role WHERE role_code = 'premium' AND deleted = 0) t)
WHERE sp.code = 'enterprise' AND sp.role_id IS NULL AND sp.deleted = 0;

-- Step 5: 为 VIP 和高级会员分配权限
-- VIP会员 → 使用权限 + 全部模型访问
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code = 'vip' AND r.deleted = 0 AND p.deleted = 0
  AND p.permission_code IN ('skill:use', 'scenario:use', 'workflow:use', 'model:use', 'model');

-- 高级会员 → VIP权限 + 技能/场景/工作流全部权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code = 'premium' AND r.deleted = 0 AND p.deleted = 0
  AND p.permission_code IN (
    'skill', 'skill:publish', 'skill:edit', 'skill:use',
    'scenario', 'scenario:publish', 'scenario:edit', 'scenario:use',
    'workflow', 'workflow:publish', 'workflow:edit', 'workflow:use',
    'model', 'model:use'
  );
