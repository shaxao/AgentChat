package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 支付配置实体
 * 敏感字段（private_key_enc, public_key_enc, encrypt_key_enc）由应用层 AES-256 加密后存储，禁止明文暴露
 */
@Data
@TableName("pay_config")
public class PayConfig {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 支付渠道: alipay/wechat */
    private String provider;

    /** 配置名称（便于识别） */
    private String name;

    /** 应用ID/商户号 */
    @TableField("app_id")
    private String appId;

    /** 商户私钥（AES-256 加密存储） */
    private String privateKeyEnc;

    /** 支付宝公钥/微信平台证书（AES-256 加密存储） */
    private String publicKeyEnc;

    /** AES加密密钥（加密存储，支付宝专用） */
    private String encryptKeyEnc;

    /** 异步回调通知地址 */
    private String notifyUrl;

    /** 同步跳转返回地址 */
    private String returnUrl;

    /** 是否沙箱环境: 0=生产, 1=沙箱 */
    private Integer sandbox;

    /** 是否启用 */
    private Integer enabled;

    /** 是否默认配置（同 provider 仅一个） */
    private Integer isDefault;

    /** 额外配置(JSON)，如微信 apiclient_cert 等 */
    private String extraConfig;

    /** 创建者用户ID */
    private Long createdBy;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;

    // ===== 非DB字段 =====

    /** 解密后的私钥（仅内存使用，不序列化到JSON） */
    @TableField(exist = false)
    private transient String privateKey;

    /** 解密后的公钥（仅内存使用，不序列化到JSON） */
    @TableField(exist = false)
    private transient String publicKey;

    /** 解密后的AES加密密钥（仅内存使用，不序列化到JSON） */
    @TableField(exist = false)
    private transient String encryptKey;
}
