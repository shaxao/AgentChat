package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

/**
 * 支付操作审计日志实体
 * 全链路记录关键操作: create_order/pay/callback/refund/config_update/config_view
 */
@Data
@TableName("pay_audit_log")
public class PayAuditLog {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    // ===== 操作人信息 =====

    /** 操作人ID（0=系统自动） */
    private Long operatorId;

    /** 操作人名称 */
    private String operatorName;

    /** 操作人IP */
    private String operatorIp;

    // ===== 操作目标 =====

    /** 操作类型: create_order/pay/callback/refund/config_update/config_view */
    private String action;

    /** 目标类型: order/payment/refund/config */
    private String targetType;

    /** 目标ID/订单号 */
    private String targetId;

    // ===== 操作内容 =====

    /** 操作描述 */
    private String description;

    /** 变更前数据(JSON) */
    private String beforeData;

    /** 变更后数据(JSON) */
    private String afterData;

    // ===== 结果 =====

    /** 操作结果: success/failed */
    private String result;

    /** 错误消息（result=failed时） */
    private String errorMsg;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
