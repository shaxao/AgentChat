package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 退款记录实体
 * 退款状态: pending(申请中) → processing(处理中) → success(成功) → failed(失败)
 */
@Data
@TableName("refund_record")
public class RefundRecord {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 退款单号（业务生成） */
    private String refundNo;

    /** 关联订单ID */
    private Long orderId;

    /** 订单号（冗余） */
    private String orderNo;

    /** 原交易流水号 */
    private String tradeNo;

    // ===== 退款金额 =====

    /** 退款金额（¥） */
    private BigDecimal refundAmount;

    /** 订单原金额（¥） */
    private BigDecimal totalAmount;

    /** 退款状态: pending/processing/success/failed */
    private String refundStatus;

    // ===== 退款信息 =====

    /** 退款原因 */
    private String reason;

    /** 操作人ID（管理员发起时） */
    private Long operatorId;

    /** 第三方退款流水号 */
    private String tradeRefundNo;

    // ===== 回调 =====

    /** 退款回调原始内容 */
    private String callbackContent;

    /** 回调接收时间 */
    private LocalDateTime callbackAt;

    // ===== 错误信息 =====

    /** 错误代码 */
    private String errorCode;

    /** 错误消息 */
    private String errorMsg;

    /** 退款完成时间 */
    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    // ===== 非DB字段 =====

    /** 操作人名称（非DB字段，由Service填充） */
    @TableField(exist = false)
    private String operatorName;
}
