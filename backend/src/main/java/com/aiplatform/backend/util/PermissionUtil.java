package com.aiplatform.backend.util;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

import java.util.Collections;
import java.util.Optional;
import java.util.Set;

/**
 * RBAC 权限检查工具类。
 * 使用时需确保当前请求已通过 JwtFilter（即已注入 userPermissions 到 request attribute）。
 *
 * 使用方式：
 *   Controller 中：PermissionUtil.requirePermission(request, "skill:publish");
 *   Service 中：  PermissionUtil.requirePermission("skill:publish");
 *
 * 注意：Service 层使用无参重载依赖于 Spring RequestContextHolder，需确保在请求线程中调用。
 */
public class PermissionUtil {

    private PermissionUtil() {
        // 工具类，禁止实例化
    }

    /**
     * 检查当前用户是否拥有指定权限
     */
    public static boolean hasPermission(HttpServletRequest request, String permissionCode) {
        @SuppressWarnings("unchecked")
        Set<String> permissions = (Set<String>) request.getAttribute("userPermissions");
        return permissions != null && permissions.contains(permissionCode);
    }

    /**
     * 检查当前用户是否拥有指定权限中的任意一个
     */
    public static boolean hasAnyPermission(HttpServletRequest request, String... permissionCodes) {
        @SuppressWarnings("unchecked")
        Set<String> permissions = (Set<String>) request.getAttribute("userPermissions");
        if (permissions == null) return false;
        for (String code : permissionCodes) {
            if (permissions.contains(code)) return true;
        }
        return false;
    }

    /**
     * 检查当前用户是否拥有所有指定权限
     */
    public static boolean hasAllPermissions(HttpServletRequest request, String... permissionCodes) {
        @SuppressWarnings("unchecked")
        Set<String> permissions = (Set<String>) request.getAttribute("userPermissions");
        if (permissions == null) return false;
        for (String code : permissionCodes) {
            if (!permissions.contains(code)) return false;
        }
        return true;
    }

    /**
     * 要求当前用户必须拥有指定权限，否则抛出异常
     */
    public static void requirePermission(HttpServletRequest request, String permissionCode) {
        if (!hasPermission(request, permissionCode)) {
            throw new RuntimeException("无权限，缺少权限点：" + permissionCode);
        }
    }

    /**
     * 要求当前用户必须拥有指定权限中的任意一个，否则抛出异常
     */
    public static void requireAnyPermission(HttpServletRequest request, String... permissionCodes) {
        if (!hasAnyPermission(request, permissionCodes)) {
            throw new RuntimeException("无权限，缺少任意一个权限点：" + String.join(",", permissionCodes));
        }
    }

    /**
     * 要求当前用户必须拥有所有指定权限，否则抛出异常
     */
    public static void requireAllPermissions(HttpServletRequest request, String... permissionCodes) {
        if (!hasAllPermissions(request, permissionCodes)) {
            throw new RuntimeException("无权限，要求权限点：" + String.join(",", permissionCodes));
        }
    }

    // ==================== Service 层便捷方法（依赖 RequestContextHolder） ====================

    private static HttpServletRequest getCurrentRequest() {
        return Optional.ofNullable((ServletRequestAttributes) RequestContextHolder.getRequestAttributes())
                .map(ServletRequestAttributes::getRequest)
                .orElseThrow(() -> new RuntimeException("非请求上下文，无法获取 request"));
    }

    /**
     * Service 层无参版本：检查当前用户是否拥有指定权限
     */
    public static boolean hasPermission(String permissionCode) {
        return hasPermission(getCurrentRequest(), permissionCode);
    }

    /**
     * Service 层无参版本：要求当前用户拥有指定权限
     */
    public static void requirePermission(String permissionCode) {
        requirePermission(getCurrentRequest(), permissionCode);
    }

    /**
     * 获取当前用户的所有权限代码（不可变集合）
     */
    @SuppressWarnings("unchecked")
    public static Set<String> getPermissions(HttpServletRequest request) {
        Set<String> permissions = (Set<String>) request.getAttribute("userPermissions");
        return permissions != null ? permissions : Collections.emptySet();
    }
}
