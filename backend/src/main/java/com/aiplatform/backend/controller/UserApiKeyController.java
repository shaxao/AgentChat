package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.UserApiKeyDTO;
import com.aiplatform.backend.service.UserApiKeyService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/user/api-key")
@RequiredArgsConstructor
public class UserApiKeyController {
    private final UserApiKeyService userApiKeyService;

    @GetMapping
    public Result<UserApiKeyDTO.ApiKeyVO> current(@RequestAttribute Long userId) {
        return Result.ok(userApiKeyService.getCurrent(userId));
    }

    @PostMapping("/regenerate")
    public Result<UserApiKeyDTO.GenerateApiKeyResponse> regenerate(
            @RequestAttribute Long userId,
            @RequestBody(required = false) UserApiKeyDTO.GenerateApiKeyRequest request) {
        String name = request != null ? request.getName() : null;
        return Result.ok(userApiKeyService.regenerate(userId, name));
    }

    @DeleteMapping
    public Result<Void> revoke(@RequestAttribute Long userId) {
        userApiKeyService.revoke(userId);
        return Result.ok();
    }
}
