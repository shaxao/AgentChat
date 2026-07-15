package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.entity.PayConfig;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.PayConfigMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.util.AesEncryptUtil;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * 支付配置服务
 * <p>
 * 核心职责：
 * 1. 支付配置 CRUD（含敏感字段 AES-256 加密/解密）
 * 2. 默认配置管理（同一 provider 仅一个默认）
 * 3. 配置 VO 脱敏转换（API 返回时敏感字段仅显示布尔值）
 * <p>
 * 安全要点：
 * - 敏感字段（privateKey, publicKey, encryptKey）通过 AesEncryptUtil 加密后存储
 * - 解密后的密钥仅在内存使用，transient 修饰防止 JSON 序列化
 * - API 返回的 VO 仅包含 hasPrivateKey 等布尔值，不暴露实际密钥
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PayConfigService {

    private final PayConfigMapper payConfigMapper;
    private final SysUserMapper sysUserMapper;
    private final AesEncryptUtil aesEncryptUtil;

    // ==================== CRUD ====================

    /**
     * 创建支付配置
     * 敏感字段加密后存储
     */
    @Transactional
    public PayConfig create(PaymentDTO.PayConfigCreateRequest req, Long operatorId) {
        PayConfig config = new PayConfig();
        config.setUuid(UUID.randomUUID().toString());
        config.setProvider(req.getProvider());
        config.setName(req.getName());
        config.setAppId(req.getAppId());

        // 敏感字段加密存储
        if (StringUtils.hasText(req.getPrivateKey())) {
            config.setPrivateKeyEnc(aesEncryptUtil.encrypt(req.getPrivateKey()));
        }
        if (StringUtils.hasText(req.getPublicKey())) {
            config.setPublicKeyEnc(aesEncryptUtil.encrypt(req.getPublicKey()));
        }
        if (StringUtils.hasText(req.getEncryptKey())) {
            config.setEncryptKeyEnc(aesEncryptUtil.encrypt(req.getEncryptKey()));
        }

        config.setNotifyUrl(req.getNotifyUrl());
        config.setReturnUrl(req.getReturnUrl());
        config.setSandbox(req.getSandbox() != null ? req.getSandbox() : 0);
        config.setEnabled(req.getEnabled() != null ? req.getEnabled() : 1);
        config.setIsDefault(req.getIsDefault() != null ? req.getIsDefault() : 0);
        config.setExtraConfig(req.getExtraConfig());
        config.setCreatedBy(operatorId);

        // 如果设为默认，先清除同 provider 的其他默认
        if (config.getIsDefault() == 1) {
            clearDefaultForProvider(config.getProvider());
        }

        payConfigMapper.insert(config);
        log.info("[PayConfigService] 创建支付配置: provider={}, name={}, operator={}",
            config.getProvider(), config.getName(), operatorId);
        return config;
    }

    /**
     * 更新支付配置
     * 密钥字段为空时不更新（保持原值）
     */
    @Transactional
    public PayConfig update(Long configId, PaymentDTO.PayConfigUpdateRequest req) {
        PayConfig config = getById(configId);
        if (config == null) {
            throw new RuntimeException("支付配置不存在");
        }

        if (StringUtils.hasText(req.getName())) {
            config.setName(req.getName());
        }
        if (StringUtils.hasText(req.getAppId())) {
            config.setAppId(req.getAppId());
        }
        // 密钥字段：仅当提供了新值时才更新
        if (StringUtils.hasText(req.getPrivateKey())) {
            config.setPrivateKeyEnc(aesEncryptUtil.encrypt(req.getPrivateKey()));
        }
        if (StringUtils.hasText(req.getPublicKey())) {
            config.setPublicKeyEnc(aesEncryptUtil.encrypt(req.getPublicKey()));
        }
        if (StringUtils.hasText(req.getEncryptKey())) {
            config.setEncryptKeyEnc(aesEncryptUtil.encrypt(req.getEncryptKey()));
        }
        if (req.getNotifyUrl() != null) {
            config.setNotifyUrl(req.getNotifyUrl());
        }
        if (req.getReturnUrl() != null) {
            config.setReturnUrl(req.getReturnUrl());
        }
        if (req.getSandbox() != null) {
            config.setSandbox(req.getSandbox());
        }
        if (req.getEnabled() != null) {
            config.setEnabled(req.getEnabled());
        }
        if (req.getIsDefault() != null && req.getIsDefault() == 1) {
            clearDefaultForProvider(config.getProvider());
            config.setIsDefault(1);
        }
        if (req.getExtraConfig() != null) {
            config.setExtraConfig(req.getExtraConfig());
        }

        payConfigMapper.updateById(config);
        log.info("[PayConfigService] 更新支付配置: id={}, name={}", configId, config.getName());
        return config;
    }

    /**
     * 删除支付配置（逻辑删除）
     */
    @Transactional
    public void delete(Long configId) {
        PayConfig config = getById(configId);
        if (config == null) {
            throw new RuntimeException("支付配置不存在");
        }
        // @TableLogic 逻辑删除
        payConfigMapper.deleteById(configId);
        log.info("[PayConfigService] 删除支付配置: id={}, name={}", configId, config.getName());
    }

    // ==================== 查询 ====================

    /**
     * 根据 ID 获取配置（不解密敏感字段）
     */
    public PayConfig getById(Long id) {
        return payConfigMapper.selectById(id);
    }

    /**
     * 根据 ID 获取配置并解密敏感字段（内部使用，不返回给前端）
     */
    public PayConfig getByIdWithDecrypt(Long id) {
        PayConfig config = payConfigMapper.selectById(id);
        if (config != null) {
            decryptSensitiveFields(config);
        }
        return config;
    }

    /**
     * 获取所有配置列表
     */
    public List<PayConfig> listAll() {
        return payConfigMapper.selectList(
            new LambdaQueryWrapper<PayConfig>()
                .orderByDesc(PayConfig::getIsDefault)
                .orderByAsc(PayConfig::getProvider)
        );
    }

    /**
     * 获取指定 provider 的默认配置（解密后）
     */
    public PayConfig getDefaultConfig(String provider) {
        PayConfig config = payConfigMapper.selectOne(
            new LambdaQueryWrapper<PayConfig>()
                .eq(PayConfig::getProvider, provider)
                .eq(PayConfig::getIsDefault, 1)
                .eq(PayConfig::getEnabled, 1)
                .last("LIMIT 1")
        );
        if (config == null) {
            // 回退：取该 provider 第一个启用的配置
            config = payConfigMapper.selectOne(
                new LambdaQueryWrapper<PayConfig>()
                    .eq(PayConfig::getProvider, provider)
                    .eq(PayConfig::getEnabled, 1)
                    .last("LIMIT 1")
            );
        }
        if (config != null) {
            decryptSensitiveFields(config);
        }
        return config;
    }

    // ==================== VO 转换 ====================

    /**
     * 将实体转换为 VO（脱敏：敏感字段仅返回布尔值）
     */
    public PaymentDTO.PayConfigVO toVO(PayConfig config) {
        if (config == null) return null;

        PaymentDTO.PayConfigVO vo = new PaymentDTO.PayConfigVO();
        vo.setId(config.getId());
        vo.setUuid(config.getUuid());
        vo.setProvider(config.getProvider());
        vo.setName(config.getName());
        vo.setAppId(config.getAppId());
        vo.setHasPrivateKey(StringUtils.hasText(config.getPrivateKeyEnc()));
        vo.setHasPublicKey(StringUtils.hasText(config.getPublicKeyEnc()));
        vo.setHasEncryptKey(StringUtils.hasText(config.getEncryptKeyEnc()));
        vo.setNotifyUrl(config.getNotifyUrl());
        vo.setReturnUrl(config.getReturnUrl());
        vo.setSandbox(config.getSandbox());
        vo.setEnabled(config.getEnabled());
        vo.setIsDefault(config.getIsDefault());
        vo.setExtraConfig(config.getExtraConfig());
        vo.setCreatedBy(config.getCreatedBy());
        vo.setCreatedAt(config.getCreatedAt());
        vo.setUpdatedAt(config.getUpdatedAt());

        // 填充创建者名称
        if (config.getCreatedBy() != null) {
            SysUser user = sysUserMapper.selectById(config.getCreatedBy());
            if (user != null) {
                vo.setCreatorName(user.getUsername());
            }
        }
        return vo;
    }

    /**
     * 批量转 VO
     */
    public List<PaymentDTO.PayConfigVO> toVOList(List<PayConfig> configs) {
        return configs.stream().map(this::toVO).collect(Collectors.toList());
    }

    // ==================== 内部方法 ====================

    /**
     * 解密敏感字段到内存（设置 transient 字段）
     */
    private void decryptSensitiveFields(PayConfig config) {
        if (StringUtils.hasText(config.getPrivateKeyEnc())) {
            config.setPrivateKey(aesEncryptUtil.decrypt(config.getPrivateKeyEnc()));
        }
        if (StringUtils.hasText(config.getPublicKeyEnc())) {
            config.setPublicKey(aesEncryptUtil.decrypt(config.getPublicKeyEnc()));
        }
        if (StringUtils.hasText(config.getEncryptKeyEnc())) {
            config.setEncryptKey(aesEncryptUtil.decrypt(config.getEncryptKeyEnc()));
        }
    }

    /**
     * 清除指定 provider 的其他默认配置
     */
    private void clearDefaultForProvider(String provider) {
        payConfigMapper.update(null,
            new LambdaUpdateWrapper<PayConfig>()
                .eq(PayConfig::getProvider, provider)
                .eq(PayConfig::getIsDefault, 1)
                .set(PayConfig::getIsDefault, 0)
        );
    }
}
