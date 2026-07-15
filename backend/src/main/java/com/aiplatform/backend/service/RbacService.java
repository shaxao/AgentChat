package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.SysPermission;
import com.aiplatform.backend.entity.SysRole;
import com.aiplatform.backend.entity.SysRolePermission;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.entity.SysUserRole;
import com.aiplatform.backend.mapper.SysPermissionMapper;
import com.aiplatform.backend.mapper.SysRoleMapper;
import com.aiplatform.backend.mapper.SysRolePermissionMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.mapper.SysUserRoleMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class RbacService {

    private final SysRoleMapper roleMapper;
    private final SysPermissionMapper permissionMapper;
    private final SysRolePermissionMapper rolePermissionMapper;
    private final SysUserRoleMapper userRoleMapper;
    private final SysUserMapper userMapper;

    public List<SysRole> listRoles() {
        return roleMapper.selectList(
                new QueryWrapper<SysRole>().eq("deleted", 0).orderByAsc("sort_order"));
    }

    public SysRole createRole(String roleName, String roleCode, String description,
                              String status, Integer sortOrder) {
        SysRole exist = roleMapper.selectOne(
                new QueryWrapper<SysRole>().eq("role_code", roleCode).eq("deleted", 0).last("LIMIT 1"));
        if (exist != null) throw new RuntimeException("角色代码 " + roleCode + " 已存在");

        SysRole role = new SysRole();
        role.setUuid(UUID.randomUUID().toString());
        role.setRoleName(roleName);
        role.setRoleCode(roleCode);
        role.setDescription(description);
        role.setStatus(status != null ? status : "active");
        role.setSortOrder(sortOrder != null ? sortOrder : 0);
        role.setIsSystem(0);
        roleMapper.insert(role);
        return role;
    }

    public SysRole updateRole(String uuid, String roleName, String roleCode, String description,
                              String status, Integer sortOrder) {
        SysRole role = findRoleByUuid(uuid);
        if (role.getIsSystem() != null && role.getIsSystem() == 1 && roleCode != null && !roleCode.equals(role.getRoleCode())) {
            throw new RuntimeException("系统内置角色不可修改角色代码");
        }

        if (roleName != null) role.setRoleName(roleName);
        if (roleCode != null) {
            SysRole exist = roleMapper.selectOne(
                    new QueryWrapper<SysRole>()
                            .eq("role_code", roleCode)
                            .eq("deleted", 0)
                            .ne("id", role.getId())
                            .last("LIMIT 1"));
            if (exist != null) throw new RuntimeException("角色代码 " + roleCode + " 已存在");
            role.setRoleCode(roleCode);
        }
        if (description != null) role.setDescription(description);
        if (status != null) role.setStatus(status);
        if (sortOrder != null) role.setSortOrder(sortOrder);
        roleMapper.updateById(role);
        return role;
    }

    public void deleteRole(String uuid) {
        SysRole role = findRoleByUuid(uuid);
        if (role.getIsSystem() != null && role.getIsSystem() == 1) {
            throw new RuntimeException("系统内置角色不可删除");
        }

        rolePermissionMapper.delete(new QueryWrapper<SysRolePermission>().eq("role_id", role.getId()));
        userRoleMapper.delete(new QueryWrapper<SysUserRole>().eq("role_id", role.getId()));

        role.setDeleted(1);
        roleMapper.updateById(role);
    }

    public List<SysPermission> listPermissions() {
        return permissionMapper.selectList(
                new QueryWrapper<SysPermission>().eq("deleted", 0).orderByAsc("parent_id", "sort_order"));
    }

    public List<Map<String, Object>> getPermissionTree() {
        List<SysPermission> all = listPermissions();
        Map<Long, List<SysPermission>> byParent = all.stream()
                .collect(Collectors.groupingBy(p -> p.getParentId() != null ? p.getParentId() : 0L));
        return buildTree(0L, byParent);
    }

    private List<Map<String, Object>> buildTree(Long parentId, Map<Long, List<SysPermission>> byParent) {
        List<SysPermission> children = new ArrayList<>(byParent.getOrDefault(parentId, Collections.emptyList()));
        children.sort(Comparator.comparing(p -> p.getSortOrder() != null ? p.getSortOrder() : 0));
        return children.stream().map(p -> {
            Map<String, Object> node = new LinkedHashMap<>();
            node.put("id", p.getId());
            node.put("uuid", p.getUuid());
            node.put("permissionName", normalizedPermissionName(p));
            node.put("permissionCode", p.getPermissionCode());
            node.put("parentId", p.getParentId());
            node.put("resourceType", p.getResourceType());
            node.put("action", p.getAction());
            node.put("description", p.getDescription());
            node.put("sortOrder", p.getSortOrder());
            node.put("createdAt", p.getCreatedAt());
            node.put("children", buildTree(p.getId(), byParent));
            return node;
        }).collect(Collectors.toList());
    }

    private String normalizedPermissionName(SysPermission permission) {
        if (permission == null || permission.getPermissionCode() == null) {
            return permission != null ? permission.getPermissionName() : "";
        }
        return switch (permission.getPermissionCode()) {
            case "harness" -> "Harness 演进";
            case "harness:view" -> "查看 Harness 演进";
            case "harness:patch" -> "管理 Harness 候选改进";
            case "harness:regression" -> "管理 Harness 回归样本";
            default -> permission.getPermissionName();
        };
    }

    public SysPermission createPermission(String permissionName, String permissionCode,
                                          Long parentId, String resourceType, String action,
                                          String description, Integer sortOrder) {
        SysPermission exist = permissionMapper.selectOne(
                new QueryWrapper<SysPermission>().eq("permission_code", permissionCode).eq("deleted", 0).last("LIMIT 1"));
        if (exist != null) throw new RuntimeException("权限代码 " + permissionCode + " 已存在");

        SysPermission perm = new SysPermission();
        perm.setUuid(UUID.randomUUID().toString());
        perm.setPermissionName(permissionName);
        perm.setPermissionCode(permissionCode);
        perm.setParentId(parentId != null ? parentId : 0L);
        perm.setResourceType(resourceType != null ? resourceType : "api");
        perm.setAction(action);
        perm.setDescription(description);
        perm.setSortOrder(sortOrder != null ? sortOrder : 0);
        permissionMapper.insert(perm);
        return perm;
    }

    public SysPermission updatePermission(String uuid, String permissionName, String permissionCode,
                                          Long parentId, String resourceType, String action,
                                          String description, Integer sortOrder) {
        SysPermission perm = findPermissionByUuid(uuid);

        if (permissionName != null) perm.setPermissionName(permissionName);
        if (permissionCode != null) {
            SysPermission exist = permissionMapper.selectOne(
                    new QueryWrapper<SysPermission>()
                            .eq("permission_code", permissionCode)
                            .eq("deleted", 0)
                            .ne("id", perm.getId())
                            .last("LIMIT 1"));
            if (exist != null) throw new RuntimeException("权限代码 " + permissionCode + " 已存在");
            perm.setPermissionCode(permissionCode);
        }
        if (parentId != null) {
            if (parentId.equals(perm.getId())) {
                throw new RuntimeException("上级权限不能选择自身");
            }
            perm.setParentId(parentId);
        } else {
            perm.setParentId(0L);
        }
        if (resourceType != null) perm.setResourceType(resourceType);
        if (action != null) perm.setAction(action);
        if (description != null) perm.setDescription(description);
        if (sortOrder != null) perm.setSortOrder(sortOrder);
        permissionMapper.updateById(perm);
        return perm;
    }

    public void deletePermission(String uuid) {
        SysPermission perm = findPermissionByUuid(uuid);
        deletePermissionRecursive(perm);
    }

    private void deletePermissionRecursive(SysPermission perm) {
        List<SysPermission> children = permissionMapper.selectList(
                new QueryWrapper<SysPermission>().eq("parent_id", perm.getId()).eq("deleted", 0));
        for (SysPermission child : children) {
            deletePermissionRecursive(child);
        }
        rolePermissionMapper.delete(new QueryWrapper<SysRolePermission>().eq("permission_id", perm.getId()));
        perm.setDeleted(1);
        permissionMapper.updateById(perm);
    }

    public List<Long> getRolePermissionIds(Long roleId) {
        List<SysRolePermission> rps = rolePermissionMapper.selectList(
                new QueryWrapper<SysRolePermission>().eq("role_id", roleId));
        return rps.stream().map(SysRolePermission::getPermissionId).collect(Collectors.toList());
    }

    public List<String> getRolePermissionCodes(Long roleId) {
        List<Long> permIds = getRolePermissionIds(roleId);
        if (permIds.isEmpty()) return Collections.emptyList();
        List<SysPermission> perms = permissionMapper.selectBatchIds(permIds);
        return perms.stream().map(SysPermission::getPermissionCode).collect(Collectors.toList());
    }

    @Transactional
    public void assignPermissionsToRole(Long roleId, List<Long> permissionIds) {
        rolePermissionMapper.delete(new QueryWrapper<SysRolePermission>().eq("role_id", roleId));
        if (permissionIds == null) return;
        for (Long permId : permissionIds) {
            SysRolePermission rp = new SysRolePermission();
            rp.setRoleId(roleId);
            rp.setPermissionId(permId);
            rolePermissionMapper.insert(rp);
        }
    }

    public List<Long> getUserRoleIds(Long userId) {
        List<SysUserRole> urs = userRoleMapper.selectList(
                new QueryWrapper<SysUserRole>().eq("user_id", userId));
        return urs.stream().map(SysUserRole::getRoleId).collect(Collectors.toList());
    }

    public List<Long> getUserRoleIds(String userIdOrUuid) {
        return getUserRoleIds(resolveUserId(userIdOrUuid));
    }

    public List<SysRole> getUserRoles(Long userId) {
        List<Long> roleIds = getUserRoleIds(userId);
        if (roleIds.isEmpty()) return Collections.emptyList();
        return roleMapper.selectBatchIds(roleIds);
    }

    public List<SysRole> getUserRoles(String userIdOrUuid) {
        return getUserRoles(resolveUserId(userIdOrUuid));
    }

    @Transactional
    public void assignRolesToUser(Long userId, List<Long> roleIds) {
        userRoleMapper.delete(new QueryWrapper<SysUserRole>().eq("user_id", userId));
        if (roleIds == null) return;
        for (Long roleId : roleIds) {
            SysUserRole ur = new SysUserRole();
            ur.setUserId(userId);
            ur.setRoleId(roleId);
            userRoleMapper.insert(ur);
        }
    }

    @Transactional
    public void assignRolesToUser(String userIdOrUuid, List<Long> roleIds) {
        assignRolesToUser(resolveUserId(userIdOrUuid), roleIds);
    }

    public Set<String> getUserPermissionCodes(Long userId) {
        List<Long> roleIds = getUserRoleIds(userId);
        if (roleIds.isEmpty()) return Collections.emptySet();

        Set<Long> allPermIds = new HashSet<>();
        for (Long roleId : roleIds) {
            allPermIds.addAll(getRolePermissionIds(roleId));
        }
        if (allPermIds.isEmpty()) return Collections.emptySet();

        List<SysPermission> perms = permissionMapper.selectBatchIds(allPermIds);
        return perms.stream().map(SysPermission::getPermissionCode).collect(Collectors.toSet());
    }

    public Set<String> getUserPermissionCodes(String userIdOrUuid) {
        return getUserPermissionCodes(resolveUserId(userIdOrUuid));
    }

    public Set<String> getUserPermissionCodes(Long userId, String legacyRoleCode) {
        Set<String> codes = new HashSet<>(getUserPermissionCodes(userId));
        codes.addAll(getRolePermissionCodesByRoleCode(legacyRoleCode));
        return codes;
    }

    public Set<String> getRolePermissionCodesByRoleCode(String roleCode) {
        if (roleCode == null || roleCode.isBlank()) {
            return Collections.emptySet();
        }
        String normalizedRoleCode = roleCode.trim().toLowerCase(Locale.ROOT);
        SysRole role = roleMapper.selectOne(
                new QueryWrapper<SysRole>()
                        .eq("role_code", normalizedRoleCode)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        if (role == null || (role.getStatus() != null && !"active".equalsIgnoreCase(role.getStatus()))) {
            return Collections.emptySet();
        }
        return new HashSet<>(getRolePermissionCodes(role.getId()));
    }

    private Long resolveUserId(String userIdOrUuid) {
        if (userIdOrUuid == null || userIdOrUuid.isBlank()) {
            throw new RuntimeException("用户不存在");
        }
        String value = userIdOrUuid.trim();
        try {
            Long id = Long.valueOf(value);
            SysUser user = userMapper.selectOne(
                    new QueryWrapper<SysUser>().eq("id", id).eq("deleted", 0).last("LIMIT 1"));
            if (user != null) return id;
        } catch (NumberFormatException ignored) {
            // UUID path below.
        }
        SysUser user = userMapper.selectOne(
                new QueryWrapper<SysUser>().eq("uuid", value).eq("deleted", 0).last("LIMIT 1"));
        if (user == null) {
            throw new RuntimeException("用户不存在");
        }
        return user.getId();
    }

    private SysRole findRoleByUuid(String uuid) {
        SysRole role = roleMapper.selectOne(
                new QueryWrapper<SysRole>().eq("uuid", uuid).eq("deleted", 0).last("LIMIT 1"));
        if (role == null) throw new RuntimeException("角色不存在");
        return role;
    }

    private SysPermission findPermissionByUuid(String uuid) {
        SysPermission permission = permissionMapper.selectOne(
                new QueryWrapper<SysPermission>().eq("uuid", uuid).eq("deleted", 0).last("LIMIT 1"));
        if (permission == null) throw new RuntimeException("权限不存在");
        return permission;
    }
}
