# Harness Dynamic RBAC Fix Review

Date: 2026-07-08

## Problem

Harness permissions were visible in permission management, but access was still effectively hard-coded to admin users:

- `/api/admin/**` required `ROLE_ADMIN` before method-level `harness:*` permissions could run.
- Login only loaded RBAC permissions for admin/super_admin users.
- The app only showed the admin entry for admin users.
- `HarnessEvolutionTab` required admin role even when `harness:view` was granted.

This meant assigning Harness permissions to a normal user did not fully work.

## Changes

- Added `GET /api/rbac/me/permissions`.
  - Any authenticated user can fetch their own permission codes.
  - Uses the same merged RBAC logic as request authentication.

- Updated `SecurityConfig`.
  - `/api/admin/harness/**` now requires authentication at the path layer.
  - Fine-grained access is enforced by `HarnessEvolutionController` method permissions:
    - `harness:view`
    - `harness:patch`
    - `harness:regression`

- Updated frontend permission loading.
  - Login now fetches permissions for every user, not only admins.
  - App startup refreshes current permissions so role changes take effect after refresh.

- Updated frontend navigation and admin page filtering.
  - Users with Harness permissions can open the management shell.
  - Non-admin users only see tabs they have permission for.
  - `HarnessEvolutionTab` no longer requires admin role; it uses `harness:*` permissions directly.

## Expected Behavior

If permission management assigns:

- `harness:view`: user can enter Harness Evolution and read data.
- `harness:patch`: user can manage candidate improvements.
- `harness:regression`: user can manage regression runs/samples.

No code change is needed when these permissions are granted or revoked.

## Verification

- `mvn.cmd -DskipTests compile`: passed.
- `npm.cmd run build`: passed.
