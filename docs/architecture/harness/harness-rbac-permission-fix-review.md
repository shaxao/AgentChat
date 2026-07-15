# Harness RBAC Permission Fix Review

Date: 2026-07-08

## Scope

- Fix garbled Harness permission names in permission management.
- Fix admin users being denied when entering Harness Evolution.
- Keep migrations and init SQL aligned.

## Changes

- `RbacService`
  - Added legacy role-code permission merge.
  - JWT/sys_user role such as `admin` now contributes permissions from `sys_role.role_code='admin'`.
  - This keeps old admin accounts working even if `sys_user_role` bindings are incomplete.

- `JwtFilter`
  - Loads permissions through the new merged RBAC method.

- `deploy/harness_permission_fix_migration.sql`
  - Repairs Harness permission display names.
  - Ensures Harness parent permission is unique and active.
  - Reparents Harness child permissions.
  - Ensures `admin` and `super_admin` roles have Harness permissions.

- `init-mysql.sql`, `backend/src/main/resources/schema.sql`, `deploy/rbac_migration.sql`
  - Added `ORDER BY id ASC LIMIT 1` to Harness parent permission lookups.

- `RbacAdminTab.tsx`
  - Added permission-code based display fallback for Harness permission names.
  - Prevents old garbled DB data from leaking into the UI before migration is run.

## Verification

- `mvn.cmd -DskipTests compile`: passed.
- `npm.cmd run build`: passed.

## Deployment Note

Run `deploy/harness_permission_fix_migration.sql` on the server database to repair existing garbled rows.
