package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.UserApiKeyDTO;
import com.aiplatform.backend.entity.UserApiKey;
import com.aiplatform.backend.mapper.UserApiKeyMapper;
import com.aiplatform.backend.util.AesEncryptUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.LocalDateTime;
import java.util.Base64;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class UserApiKeyService {
    private static final String PREFIX = "muhuo-";
    private static final SecureRandom RANDOM = new SecureRandom();

    private final UserApiKeyMapper apiKeyMapper;
    private final AesEncryptUtil aesEncryptUtil;

    public UserApiKeyDTO.ApiKeyVO getCurrent(Long userId) {
        UserApiKey key = currentEntity(userId);
        return key == null ? null : toVO(key);
    }

    @Transactional
    public UserApiKeyDTO.GenerateApiKeyResponse regenerate(Long userId, String name) {
        apiKeyMapper.update(null, new LambdaUpdateWrapper<UserApiKey>()
                .eq(UserApiKey::getUserId, userId)
                .eq(UserApiKey::getStatus, "active")
                .set(UserApiKey::getStatus, "revoked"));

        String plain = generatePlainKey();
        UserApiKey entity = new UserApiKey();
        entity.setUuid(UUID.randomUUID().toString());
        entity.setUserId(userId);
        entity.setName(name != null && !name.isBlank() ? name.trim() : "Default API Key");
        entity.setKeyPrefix(maskPrefix(plain));
        entity.setKeyHash(hash(plain));
        entity.setKeyEnc(aesEncryptUtil.encrypt(plain));
        entity.setStatus("active");
        entity.setExpiresAt(null);
        apiKeyMapper.insert(entity);

        UserApiKeyDTO.GenerateApiKeyResponse resp = new UserApiKeyDTO.GenerateApiKeyResponse();
        resp.setApiKey(toVO(entity));
        resp.setKey(plain);
        return resp;
    }

    @Transactional
    public void revoke(Long userId) {
        apiKeyMapper.update(null, new LambdaUpdateWrapper<UserApiKey>()
                .eq(UserApiKey::getUserId, userId)
                .eq(UserApiKey::getStatus, "active")
                .set(UserApiKey::getStatus, "revoked"));
    }

    public AuthenticatedApiKey authenticate(String authorizationHeader) {
        String key = extractBearer(authorizationHeader);
        if (key == null || !key.startsWith(PREFIX)) {
            return null;
        }
        UserApiKey entity = apiKeyMapper.selectOne(new LambdaQueryWrapper<UserApiKey>()
                .eq(UserApiKey::getKeyHash, hash(key))
                .eq(UserApiKey::getStatus, "active")
                .eq(UserApiKey::getDeleted, 0)
                .last("LIMIT 1"));
        if (entity == null) {
            return null;
        }
        if (entity.getExpiresAt() != null && entity.getExpiresAt().isBefore(LocalDateTime.now())) {
            return null;
        }
        entity.setLastUsedAt(LocalDateTime.now());
        apiKeyMapper.updateById(entity);
        AuthenticatedApiKey auth = new AuthenticatedApiKey();
        auth.setUserId(entity.getUserId());
        auth.setApiKeyId(entity.getUuid());
        auth.setKeyPrefix(entity.getKeyPrefix());
        return auth;
    }

    private UserApiKey currentEntity(Long userId) {
        return apiKeyMapper.selectOne(new LambdaQueryWrapper<UserApiKey>()
                .eq(UserApiKey::getUserId, userId)
                .eq(UserApiKey::getStatus, "active")
                .eq(UserApiKey::getDeleted, 0)
                .orderByDesc(UserApiKey::getId)
                .last("LIMIT 1"));
    }

    private String generatePlainKey() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return PREFIX + Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private String maskPrefix(String key) {
        if (key.length() <= 18) return key;
        return key.substring(0, 16) + "..." + key.substring(key.length() - 4);
    }

    private String extractBearer(String header) {
        if (header == null || !header.startsWith("Bearer ")) return null;
        return header.substring(7).trim();
    }

    private String hash(String key) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(key.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(hash);
        } catch (Exception e) {
            throw new RuntimeException("hash api key failed", e);
        }
    }

    private UserApiKeyDTO.ApiKeyVO toVO(UserApiKey key) {
        UserApiKeyDTO.ApiKeyVO vo = new UserApiKeyDTO.ApiKeyVO();
        vo.setId(key.getUuid());
        vo.setName(key.getName());
        vo.setKeyPrefix(key.getKeyPrefix());
        vo.setStatus(key.getStatus());
        vo.setCreatedAt(key.getCreatedAt() != null ? key.getCreatedAt().toString() : null);
        vo.setLastUsedAt(key.getLastUsedAt() != null ? key.getLastUsedAt().toString() : null);
        vo.setExpiresAt(key.getExpiresAt() != null ? key.getExpiresAt().toString() : null);
        return vo;
    }

    @Data
    public static class AuthenticatedApiKey {
        private Long userId;
        private String apiKeyId;
        private String keyPrefix;
    }
}
