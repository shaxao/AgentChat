package com.aiplatform.backend.dto;

import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 支付模块 DTO
 * 包含支付配置、订单、支付记录、退款、审计日志的请求和响应类
 */
public class PaymentDTO {

    // ==================== 支付配置 ====================

    /**
     * 支付配置 VO（返回前端时敏感字段已脱敏）
     */
    @Data
    public static class PayConfigVO {
        private Long id;
        private String uuid;
        private String provider;
        private String name;
        private String appId;
        /** 私钥是否已配置（不返回实际值） */
        private Boolean hasPrivateKey;
        /** 公钥是否已配置 */
        private Boolean hasPublicKey;
        /** 加密密钥是否已配置 */
        private Boolean hasEncryptKey;
        private String notifyUrl;
        private String returnUrl;
        private Integer sandbox;
        private Integer enabled;
        private Integer isDefault;
        private String extraConfig;
        private Long createdBy;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
        /** 创建者用户名 */
        private String creatorName;
    }

    /**
     * 创建支付配置请求
     */
    @Data
    public static class PayConfigCreateRequest {
        private String provider;
        private String name;
        private String appId;
        /** 商户私钥（明文，服务端加密后存储） */
        private String privateKey;
        /** 支付宝公钥/微信平台证书（明文，服务端加密后存储） */
        private String publicKey;
        /** AES加密密钥（明文，服务端加密后存储，支付宝专用） */
        private String encryptKey;
        private String notifyUrl;
        private String returnUrl;
        private Integer sandbox;
        private Integer enabled;
        private Integer isDefault;
        private String extraConfig;
    }

    /**
     * 更新支付配置请求
     */
    @Data
    public static class PayConfigUpdateRequest {
        private String name;
        private String appId;
        /** 新私钥（可选，为空则不更新） */
        private String privateKey;
        /** 新公钥（可选，为空则不更新） */
        private String publicKey;
        /** 新加密密钥（可选，为空则不更新） */
        private String encryptKey;
        private String notifyUrl;
        private String returnUrl;
        private Integer sandbox;
        private Integer enabled;
        private Integer isDefault;
        private String extraConfig;
    }

    // ==================== 订单 ====================

    /**
     * 订单 VO（列表/详情）
     */
    @Data
    public static class OrderVO {
        private Long id;
        private String uuid;
        private String orderNo;
        private Long userId;
        private String username;
        private String nickname;
        private Long planId;
        private String planName;
        private BigDecimal amount;
        private BigDecimal discountAmount;
        private BigDecimal actualAmount;
        private String paymentMethod;
        private String paymentProvider;
        private String tradeNo;
        private String status;
        private LocalDateTime paidAt;
        private LocalDateTime refundedAt;
        private LocalDateTime cancelledAt;
        private LocalDateTime expiredAt;
        private String clientIp;
        private String remark;
        private String extraData;
        private LocalDateTime createdAt;
        private LocalDateTime updatedAt;
    }

    /**
     * 订单列表简要 VO
     */
    @Data
    public static class OrderBriefVO {
        private Long id;
        private String orderNo;
        private Long userId;
        private String username;
        private String planName;
        private BigDecimal actualAmount;
        private String paymentMethod;
        private String tradeNo;
        private String status;
        private LocalDateTime paidAt;
        private LocalDateTime createdAt;
    }

    /**
     * 订单多条件查询请求
     */
    @Data
    public static class OrderQueryRequest {
        /** 订单号（模糊匹配） */
        private String orderNo;
        /** 第三方交易流水号 */
        private String tradeNo;
        /** 用户ID */
        private Long userId;
        /** 用户名（模糊匹配） */
        private String username;
        /** 订单状态 */
        private String status;
        /** 支付方式 */
        private String paymentMethod;
        /** 套餐ID */
        private Long planId;
        private String orderType;
        private BigDecimal amount;
        /** 最小金额 */
        private BigDecimal minAmount;
        /** 最大金额 */
        private BigDecimal maxAmount;
        /** 开始时间 */
        private LocalDateTime startTime;
        /** 结束时间 */
        private LocalDateTime endTime;
        /** 排序字段（默认 created_at） */
        private String sortBy;
        /** 排序方向（asc/desc，默认 desc） */
        private String sortDir;
        /** 页码（从1开始） */
        private Integer page;
        /** 每页大小 */
        private Integer size;
    }

    /**
     * 创建订单请求
     */
    @Data
    public static class OrderCreateRequest {
        /** 套餐ID（订阅订单时必填） */
        private Long planId;
        /** 支付方式: alipay/wechat */
        private String paymentMethod;
        /** 优惠码（可选） */
        private String couponCode;
        /** 备注 */
        private String remark;
    }

    /**
     * 创建订单 / 发起支付响应
     */
    @Data
    public static class PaymentCreateResponse {
        /** 订单号 */
        private String orderNo;
        /** 订单ID */
        private Long orderId;
        /** 实付金额 */
        private BigDecimal actualAmount;
        /** 支付方式 */
        private String paymentMethod;
        /** 支付表单 HTML（支付宝电脑网站支付）或支付链接 */
        private String payForm;
        /** 支付二维码链接（扫码支付时） */
        private String qrCodeUrl;
        /** H5 支付链接 */
        private String payUrl;
    }

    // ==================== 支付记录 ====================

    /**
     * 支付记录 VO
     */
    @Data
    public static class PaymentRecordVO {
        private Long id;
        private String uuid;
        private Long orderId;
        private String orderNo;
        private String tradeNo;
        private BigDecimal amount;
        private String paymentStatus;
        private String verifyStatus;
        private String verifyMsg;
        private String callbackContent;
        private LocalDateTime callbackAt;
        private String requestContent;
        private String responseContent;
        private String errorCode;
        private String errorMsg;
        private LocalDateTime createdAt;
    }

    // ==================== 退款 ====================

    /**
     * 退款申请请求
     */
    @Data
    public static class RefundRequest {
        /** 订单ID */
        private Long orderId;
        /** 退款金额（可选，默认全额退款） */
        private BigDecimal refundAmount;
        /** 退款原因 */
        private String reason;
    }

    /**
     * 退款记录 VO
     */
    @Data
    public static class RefundRecordVO {
        private Long id;
        private String uuid;
        private String refundNo;
        private Long orderId;
        private String orderNo;
        private String tradeNo;
        private BigDecimal refundAmount;
        private BigDecimal totalAmount;
        private String refundStatus;
        private String reason;
        private Long operatorId;
        private String operatorName;
        private String tradeRefundNo;
        private String callbackContent;
        private LocalDateTime callbackAt;
        private String errorCode;
        private String errorMsg;
        private LocalDateTime completedAt;
        private LocalDateTime createdAt;
    }

    // ==================== 审计日志 ====================

    /**
     * 审计日志 VO
     */
    @Data
    public static class PayAuditLogVO {
        private Long id;
        private String uuid;
        private Long operatorId;
        private String operatorName;
        private String operatorIp;
        private String action;
        private String targetType;
        private String targetId;
        private String description;
        private String beforeData;
        private String afterData;
        private String result;
        private String errorMsg;
        private LocalDateTime createdAt;
    }

    /**
     * 审计日志查询请求
     */
    @Data
    public static class AuditLogQueryRequest {
        private String action;
        private String targetType;
        private String targetId;
        private Long operatorId;
        private String result;
        private LocalDateTime startTime;
        private LocalDateTime endTime;
        private Integer page;
        private Integer size;
    }

    // ==================== 统计 ====================

    /**
     * 支付统计概览
     */
    @Data
    public static class PaymentStatsVO {
        /** 今日订单数 */
        private Long todayOrderCount;
        /** 今日支付金额 */
        private BigDecimal todayPayAmount;
        /** 总订单数 */
        private Long totalOrderCount;
        /** 总支付金额 */
        private BigDecimal totalPayAmount;
        /** 待处理退款数 */
        private Long pendingRefundCount;
        /** 已退款总金额 */
        private BigDecimal totalRefundAmount;
        /** 各支付方式统计 */
        private List<PaymentMethodStat> methodStats;
    }

    /**
     * 支付方式统计
     */
    @Data
    public static class PaymentMethodStat {
        private String paymentMethod;
        private Long orderCount;
        private BigDecimal totalAmount;
    }
}
