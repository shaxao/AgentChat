-- =====================================================
-- RBAC 权限管理系统 — 一键迁移（生产环境）
-- 用法：deploy.ps1 migrate-db deploy\rbac_migration.sql
--      或手动：
--      ssh muhugo-a "mysql -h your-server-c-ip -P 3000 -u muhuoai -p'changeme' MuHuoAi < /tmp/rbac_migration.sql"
-- 幂等性：全部使用 IF NOT EXISTS / INSERT IGNORE，可安全重复执行
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

-- =====================================================
-- 种子数据：默认角色（4个）
-- =====================================================
INSERT IGNORE INTO sys_role (uuid, role_name, role_code, description, status, sort_order, is_system) VALUES
    (UUID(), '超级管理员', 'super_admin', '拥有系统所有权限，可管理一切', 'active', 0, 1),
    (UUID(), '管理员',     'admin',       '管理系统核心功能（用户/渠道/模型/订阅/日志）', 'active', 1, 1),
    (UUID(), '编辑',       'editor',      '可发布和编辑内容（技能/场景/工作流）', 'active', 2, 1),
    (UUID(), '普通用户',   'user',        '基础使用权限（使用已有技能/场景/工作流）', 'active', 3, 1);

-- =====================================================
-- 种子数据：默认权限（树形结构，共30个）
-- 分两步插入：先插顶级菜单(parent_id=0)，再插子权限(用子查询查 parent_id)
-- 使用派生表技巧绕过 MySQL "can't reference table being inserted into" 限制
-- =====================================================

-- Step 1: 插入10个顶级菜单权限 (parent_id=0)
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '技能管理',   'skill',        0, 'menu', 0),
    (UUID(), '场景管理',   'scenario',     0, 'menu', 0),
    (UUID(), '工作流管理', 'workflow',     0, 'menu', 0),
    (UUID(), '模型管理',   'model',        0, 'menu', 0),
    (UUID(), '用户管理',   'user_mgmt',    0, 'menu', 0),
    (UUID(), '订阅管理',   'subscription', 0, 'menu', 0),
    (UUID(), '钱包管理',   'wallet',       0, 'menu', 0),
    (UUID(), '系统设置',   'system',       0, 'menu', 0),
    (UUID(), '日志管理',   'logs',         0, 'menu', 0),
    (UUID(), '统计概览',   'overview',     0, 'menu', 0);

-- Step 2: 插入子权限 — 使用派生表子查询动态查找父权限 ID
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    -- 技能子权限
    (UUID(), '发布技能',   'skill:publish',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='skill' AND deleted=0) t),       'button', 1),
    (UUID(), '编辑技能',   'skill:edit',     (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='skill' AND deleted=0) t),       'button', 2),
    (UUID(), '删除技能',   'skill:delete',   (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='skill' AND deleted=0) t),       'button', 3),
    (UUID(), '审核技能',   'skill:review',   (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='skill' AND deleted=0) t),       'button', 4),
    (UUID(), '使用技能',   'skill:use',      (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='skill' AND deleted=0) t),       'api',    5),
    -- 场架子权限
    (UUID(), '发布场景',   'scenario:publish',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='scenario' AND deleted=0) t),  'button', 1),
    (UUID(), '编辑场景',   'scenario:edit',     (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='scenario' AND deleted=0) t),  'button', 2),
    (UUID(), '删除场景',   'scenario:delete',   (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='scenario' AND deleted=0) t),  'button', 3),
    (UUID(), '使用场景',   'scenario:use',      (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='scenario' AND deleted=0) t),  'api',    4),
    -- 工作流子权限
    (UUID(), '发布工作流', 'workflow:publish',   (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='workflow' AND deleted=0) t),  'button', 1),
    (UUID(), '编辑工作流', 'workflow:edit',      (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='workflow' AND deleted=0) t),  'button', 2),
    (UUID(), '删除工作流', 'workflow:delete',    (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='workflow' AND deleted=0) t),  'button', 3),
    (UUID(), '使用工作流', 'workflow:use',       (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='workflow' AND deleted=0) t),  'api',    4),
    -- 模型子权限
    (UUID(), '模型路由',   'model:routing',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='model' AND deleted=0) t),        'button', 1),
    -- 用户管理子权限
    (UUID(), '创建用户',   'user_mgmt:create',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='user_mgmt' AND deleted=0) t),  'button', 1),
    (UUID(), '编辑用户',   'user_mgmt:edit',    (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='user_mgmt' AND deleted=0) t),  'button', 2),
    (UUID(), '删除用户',   'user_mgmt:delete',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='user_mgmt' AND deleted=0) t),  'button', 3),
    -- 系统设置子权限
    (UUID(), '权限管理',   'system:rbac',     (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='system' AND deleted=0) t),       'menu',   1),
    (UUID(), '存储配置',   'system:storage',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='system' AND deleted=0) t),       'menu',   2);

-- Harness Evolution permissions
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

-- =====================================================
-- 分配默认角色权限
-- =====================================================

-- 超级管理员 → 所有权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r CROSS JOIN sys_permission p
WHERE r.role_code='super_admin' AND r.deleted=0 AND p.deleted=0;

-- 管理员 → 大部分权限（排除系统设置、权限管理、用户删除等敏感操作）
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code NOT IN ('system', 'system:rbac', 'system:storage', 'user_mgmt', 'user_mgmt:create', 'user_mgmt:delete', 'skill:delete', 'scenario:delete', 'workflow:delete');

-- 编辑 → 内容管理权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='editor' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('skill', 'skill:publish', 'skill:edit', 'skill:use',
                            'scenario', 'scenario:publish', 'scenario:edit', 'scenario:use',
                            'workflow', 'workflow:publish', 'workflow:edit', 'workflow:use');

-- 普通用户 → 使用权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='user' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('skill:use', 'scenario:use', 'workflow:use');

-- =====================================================
-- 将现有用户分配到默认角色
-- =====================================================

-- admin 用户 → admin 角色
INSERT IGNORE INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id FROM sys_user u JOIN sys_role r
ON u.role='admin' AND r.role_code='admin' AND u.deleted=0 AND r.deleted=0;

-- user 用户 → user 角色
INSERT IGNORE INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id FROM sys_user u JOIN sys_role r
ON u.role='user' AND r.role_code='user' AND u.deleted=0 AND r.deleted=0;

-- 第一个 admin 用户 → 超级管理员
INSERT IGNORE INTO sys_user_role (user_id, role_id)
SELECT u.id, r.id FROM sys_user u JOIN sys_role r
ON r.role_code='super_admin' AND r.deleted=0
WHERE u.role='admin' AND u.deleted=0
ORDER BY u.id ASC LIMIT 1;
