package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.RbacService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Set;

@RestController
@RequestMapping("/api/rbac")
@RequiredArgsConstructor
public class UserRbacController {

    private final RbacService rbacService;

    @GetMapping("/me/permissions")
    public Result<Set<String>> myPermissions(
            @RequestAttribute Long userId,
            @RequestAttribute String userRole) {
        return Result.ok(rbacService.getUserPermissionCodes(userId, userRole));
    }
}
