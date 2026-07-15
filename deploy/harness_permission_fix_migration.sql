-- Fix Harness RBAC permission display names and assignments.
-- Safe to run multiple times.

SET @harness_id := (
    SELECT id FROM sys_permission
    WHERE permission_code = 'harness' AND deleted = 0
    ORDER BY id ASC
    LIMIT 1
);

INSERT INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
SELECT UUID(), 'Harness 演进', 'harness', 0, 'menu', 0
WHERE @harness_id IS NULL;

SET @harness_id := (
    SELECT id FROM sys_permission
    WHERE permission_code = 'harness' AND deleted = 0
    ORDER BY id ASC
    LIMIT 1
);

UPDATE sys_permission
SET permission_name = 'Harness 演进',
    parent_id = 0,
    resource_type = 'menu',
    sort_order = 0,
    deleted = 0
WHERE id = @harness_id;

UPDATE sys_permission
SET deleted = 1
WHERE permission_code = 'harness'
  AND id <> @harness_id;

INSERT INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
SELECT UUID(), '查看 Harness 演进', 'harness:view', @harness_id, 'menu', 1
WHERE NOT EXISTS (
    SELECT 1 FROM sys_permission WHERE permission_code = 'harness:view' AND deleted = 0
);

INSERT INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
SELECT UUID(), '管理 Harness 候选改进', 'harness:patch', @harness_id, 'button', 2
WHERE NOT EXISTS (
    SELECT 1 FROM sys_permission WHERE permission_code = 'harness:patch' AND deleted = 0
);

INSERT INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
SELECT UUID(), '管理 Harness 回归样本', 'harness:regression', @harness_id, 'button', 3
WHERE NOT EXISTS (
    SELECT 1 FROM sys_permission WHERE permission_code = 'harness:regression' AND deleted = 0
);

UPDATE sys_permission
SET permission_name = CASE permission_code
        WHEN 'harness:view' THEN '查看 Harness 演进'
        WHEN 'harness:patch' THEN '管理 Harness 候选改进'
        WHEN 'harness:regression' THEN '管理 Harness 回归样本'
        ELSE permission_name
    END,
    parent_id = @harness_id,
    resource_type = CASE permission_code
        WHEN 'harness:view' THEN 'menu'
        ELSE 'button'
    END,
    sort_order = CASE permission_code
        WHEN 'harness:view' THEN 1
        WHEN 'harness:patch' THEN 2
        WHEN 'harness:regression' THEN 3
        ELSE sort_order
    END,
    deleted = 0
WHERE permission_code IN ('harness:view', 'harness:patch', 'harness:regression');

INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM sys_role r
JOIN sys_permission p
WHERE r.role_code IN ('super_admin', 'admin')
  AND r.deleted = 0
  AND p.deleted = 0
  AND p.permission_code IN ('harness', 'harness:view', 'harness:patch', 'harness:regression');
