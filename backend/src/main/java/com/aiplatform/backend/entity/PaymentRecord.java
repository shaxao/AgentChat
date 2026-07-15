package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 支付记录实体
 * 每次支付请求/回调都记录，用于审计追溯
 */
@Data
@TableName("payment_record")
public class PaymentRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 关联订单ID */
    private Long orderId;

    /** 订单号（冗余，便于查询） */
    private String orderNo;

    /** 第三方交易流水号 */
    private String tradeNo;

    /** 支付金额（¥） */
    private BigDecimal amount;

    /** 支付状态: pending/success/failed/closed */
    private String paymentStatus;

    // ===== 回调验签 =====

    /** 验签状态: pending/verified/failed */
    private String verifyStatus;

    /** 验签结果消息 */
    private String verifyMsg;

    /** 回调原始内容（JSON） */
    private String callbackContent;

    /** 回调接收时间 */
    private LocalDateTime callbackAt;

    // ===== 请求信息 =====

    /** 下单请求参数（JSON，脱敏后） */
    private String requestContent;

    /** 下单响应内容（JSON，脱敏后） */
    private String responseContent;

    // ===== 错误信息 =====

    /** 错误代码 */
    private String errorCode;

    /** 错误消息 */
    private String errorMsg;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
