package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.SysPermission;
import com.aiplatform.backend.entity.SysRole;
import com.aiplatform.backend.service.RbacService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Set;

@RestController
@RequestMapping("/api/admin/rbac")
@RequiredArgsConstructor
public class RbacController {

    private final RbacService rbacService;

    private void requireAdmin(String role) {
        if (!"admin".equals(role) && !"super_admin".equals(role)) {
            throw new RuntimeException("无权限，仅管理员可操作");
        }
    }

    @GetMapping("/roles")
    public Result<List<SysRole>> listRoles(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(rbacService.listRoles());
    }

    @PostMapping("/roles")
    public Result<SysRole> createRole(@RequestAttribute String userRole,
                                      @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(rbacService.createRole(
                (String) body.get("roleName"),
                (String) body.get("roleCode"),
                (String) body.get("description"),
                (String) body.get("status"),
                body.get("sortOrder") != null ? Integer.valueOf(body.get("sortOrder").toString()) : null
        ));
    }

    @PutMapping("/roles/{uuid}")
    public Result<SysRole> updateRole(@RequestAttribute String userRole,
                                      @PathVariable String uuid,
                                      @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(rbacService.updateRole(
                uuid,
                (String) body.get("roleName"),
                (String) body.get("roleCode"),
                (String) body.get("description"),
                (String) body.get("status"),
                body.get("sortOrder") != null ? Integer.valueOf(body.get("sortOrder").toString()) : null
        ));
    }

    @DeleteMapping("/roles/{uuid}")
    public Result<String> deleteRole(@RequestAttribute String userRole,
                                     @PathVariable String uuid) {
        requireAdmin(userRole);
        rbacService.deleteRole(uuid);
        return Result.ok("删除成功");
    }

    @GetMapping("/permissions")
    public Result<List<Map<String, Object>>> getPermissionTree(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(rbacService.getPermissionTree());
    }

    @GetMapping("/permissions/flat")
    public Result<List<SysPermission>> listPermissionsFlat(@RequestAttribute String userRole) {
        requireAdmin(userRole);
        return Result.ok(rbacService.listPermissions());
    }

    @PostMapping("/permissions")
    public Result<SysPermission> createPermission(@RequestAttribute String userRole,
                                                  @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(rbacService.createPermission(
                (String) body.get("permissionName"),
                (String) body.get("permissionCode"),
                body.get("parentId") != null ? Long.valueOf(body.get("parentId").toString()) : null,
                (String) body.get("resourceType"),
                (String) body.get("action"),
                (String) body.get("description"),
                body.get("sortOrder") != null ? Integer.valueOf(body.get("sortOrder").toString()) : null
        ));
    }

    @PutMapping("/permissions/{uuid}")
    public Result<SysPermission> updatePermission(@RequestAttribute String userRole,
                                                  @PathVariable String uuid,
                                                  @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        return Result.ok(rbacService.updatePermission(
                uuid,
                (String) body.get("permissionName"),
                (String) body.get("permissionCode"),
                body.get("parentId") != null ? Long.valueOf(body.get("parentId").toString()) : null,
                (String) body.get("resourceType"),
                (String) body.get("action"),
                (String) body.get("description"),
                body.get("sortOrder") != null ? Integer.valueOf(body.get("sortOrder").toString()) : null
        ));
    }

    @DeleteMapping("/permissions/{uuid}")
    public Result<String> deletePermission(@RequestAttribute String userRole,
                                           @PathVariable String uuid) {
        requireAdmin(userRole);
        rbacService.deletePermission(uuid);
        return Result.ok("删除成功");
    }

    @GetMapping("/roles/{roleId}/permissions")
    public Result<List<Long>> getRolePermissions(@RequestAttribute String userRole,
                                                 @PathVariable Long roleId) {
        requireAdmin(userRole);
        return Result.ok(rbacService.getRolePermissionIds(roleId));
    }

    @GetMapping("/roles/{roleId}/permission-codes")
    public Result<List<String>> getRolePermissionCodes(@RequestAttribute String userRole,
                                                       @PathVariable Long roleId) {
        requireAdmin(userRole);
        return Result.ok(rbacService.getRolePermissionCodes(roleId));
    }

    @PutMapping("/roles/{roleId}/permissions")
    public Result<String> assignPermissionsToRole(@RequestAttribute String userRole,
                                                  @PathVariable Long roleId,
                                                  @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        rbacService.assignPermissionsToRole(roleId, readLongList(body.get("permissionIds")));
        return Result.ok("权限分配成功");
    }

    @GetMapping("/users/{userId}/roles")
    public Result<List<SysRole>> getUserRoles(@RequestAttribute String userRole,
                                              @PathVariable String userId) {
        requireAdmin(userRole);
        return Result.ok(rbacService.getUserRoles(userId));
    }

    @PutMapping("/users/{userId}/roles")
    public Result<String> assignRolesToUser(@RequestAttribute String userRole,
                                            @PathVariable String userId,
                                            @RequestBody Map<String, Object> body) {
        requireAdmin(userRole);
        rbacService.assignRolesToUser(userId, readLongList(body.get("roleIds")));
        return Result.ok("角色分配成功");
    }

    @GetMapping("/users/{userId}/permissions")
    public Result<Set<String>> getUserPermissions(@RequestAttribute String userRole,
                                                  @PathVariable String userId) {
        requireAdmin(userRole);
        return Result.ok(rbacService.getUserPermissionCodes(userId));
    }

    private List<Long> readLongList(Object value) {
        if (!(value instanceof List<?> rawList)) {
            return Collections.emptyList();
        }
        return rawList.stream()
                .filter(item -> item != null && !item.toString().isBlank())
                .map(item -> Long.valueOf(item.toString()))
                .toList();
    }
}
