package com.aiplatform.backend.config;

import com.aiplatform.backend.service.RbacService;
import com.aiplatform.backend.util.JwtUtil;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;

@Slf4j
@Component
@RequiredArgsConstructor
public class JwtFilter extends OncePerRequestFilter {

    private final JwtUtil jwtUtil;
    private final RbacService rbacService;

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain)
            throws ServletException, IOException {
        String path = request.getRequestURI();

        if (isPublicPath(path)) {
            filterChain.doFilter(request, response);
            return;
        }

        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith("Bearer ")) {
            sendUnauthorized(response, "未登录或 Token 已过期");
            return;
        }

        String token = header.substring(7);
        if (!jwtUtil.isValid(token)) {
            sendUnauthorized(response, "Token 无效或已过期");
            return;
        }

        Long userId = jwtUtil.getUserId(token);
        String role = jwtUtil.getRole(token);
        if (role == null || role.isBlank()) {
            role = "user";
        }

        request.setAttribute("userId", userId);
        request.setAttribute("userRole", role);

        Set<String> permissionCodes = Set.of();
        try {
            permissionCodes = rbacService.getUserPermissionCodes(userId, role);
        } catch (Exception e) {
            log.warn("Failed to load permissions for user {}: {}", userId, e.getMessage());
        }
        request.setAttribute("userPermissions", permissionCodes);

        List<SimpleGrantedAuthority> authorities = new ArrayList<>();
        String roleUpper = role.toUpperCase();
        authorities.add(new SimpleGrantedAuthority("ROLE_" + roleUpper));
        if ("SUPER_ADMIN".equals(roleUpper)) {
            authorities.add(new SimpleGrantedAuthority("ROLE_ADMIN"));
        }
        for (String permCode : permissionCodes) {
            authorities.add(new SimpleGrantedAuthority("PERM_" + permCode));
        }

        UsernamePasswordAuthenticationToken authentication =
                new UsernamePasswordAuthenticationToken(userId, null, authorities);
        SecurityContextHolder.getContext().setAuthentication(authentication);

        filterChain.doFilter(request, response);
    }

    private boolean isPublicPath(String path) {
        return path.startsWith("/api/auth/login")
                || path.startsWith("/api/auth/register")
                || path.startsWith("/api/auth/send-code")
                || path.startsWith("/api/auth/reset-password")
                || path.startsWith("/api/auth/oauth/linuxdo/")
                || path.startsWith("/v1/")
                || path.equals("/api/plans")
                || path.startsWith("/api/admin/internal/")
                || path.startsWith("/api/payment/callback/");
    }

    private void sendUnauthorized(HttpServletResponse response, String message) throws IOException {
        response.setStatus(401);
        response.setContentType("application/json;charset=UTF-8");
        response.getWriter().write("{\"code\":401,\"message\":\"" + message + "\"}");
    }
}
