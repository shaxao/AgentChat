package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.math.BigDecimal;
import java.time.LocalDateTime;

/**
 * 订单实体
 * 状态机: pending(待支付) → paid(已支付) → refunded(已退款) / cancelled(已取消) / expired(已过期)
 */
@Data
@TableName("orders")
public class OrderEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String uuid;

    /** 订单号（业务生成，唯一） */
    private String orderNo;

    /** 下单用户ID */
    private Long userId;

    /** 关联套餐ID（订阅订单时有效） */
    private Long planId;

    /** 套餐快照名称 */
    private String planName;

    // ===== 金额信息 =====

    /** 订单金额（¥） */
    private BigDecimal amount;

    /** 优惠金额（¥） */
    private BigDecimal discountAmount;

    /** 实付金额（¥） */
    private BigDecimal actualAmount;

    // ===== 支付信息 =====

    /** 支付方式: alipay/wechat */
    private String paymentMethod;

    /** 实际支付渠道（冗余，便于查询） */
    private String paymentProvider;

    /** 第三方交易流水号（支付宝/微信返回） */
    private String tradeNo;

    /** 订单状态: pending/paid/refunded/cancelled/expired */
    private String status;

    // ===== 时间节点 =====

    /** 支付完成时间 */
    private LocalDateTime paidAt;

    /** 退款完成时间 */
    private LocalDateTime refundedAt;

    /** 取消时间 */
    private LocalDateTime cancelledAt;

    /** 过期时间 */
    private LocalDateTime expiredAt;

    // ===== 扩展信息 =====

    /** 下单客户端IP */
    private String clientIp;

    /** 下单User-Agent */
    private String userAgent;

    /** 订单备注 */
    private String remark;

    /** 附加数据(JSON) */
    private String extraData;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;

    // ===== 非DB字段 =====

    /** 用户名（非DB字段，由Service填充） */
    @TableField(exist = false)
    private String username;

    /** 用户昵称（非DB字段，由Service填充） */
    @TableField(exist = false)
    private String nickname;
}
