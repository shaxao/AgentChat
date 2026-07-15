-- =====================================================
-- v5.0: 支付模块（支付配置 + 订单 + 支付记录 + 退款 + 审计日志）
-- 幂等安全：可重复执行
-- =====================================================

-- 支付配置表（敏感字段由应用层 AES 加密后存储，禁止明文）
CREATE TABLE IF NOT EXISTS pay_config (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    provider        VARCHAR(20)  NOT NULL COMMENT '支付渠道: alipay/wechat',
    name            VARCHAR(100) NOT NULL COMMENT '配置名称（便于识别）',
    app_id          VARCHAR(200) NOT NULL COMMENT '应用ID/商户号',
    -- 敏感字段：应用层 AES-256 加密后存储，禁止明文
    private_key_enc TEXT         COMMENT '商户私钥（加密存储）',
    public_key_enc  TEXT         COMMENT '支付宝公钥/微信平台证书（加密存储）',
    encrypt_key_enc VARCHAR(500) COMMENT 'AES加密密钥（加密存储，支付宝专用）',
    notify_url      VARCHAR(500) COMMENT '异步回调通知地址',
    return_url      VARCHAR(500) COMMENT '同步跳转返回地址',
    sandbox         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否沙箱环境: 0=生产, 1=沙箱',
    enabled         TINYINT      NOT NULL DEFAULT 1 COMMENT '是否启用',
    is_default      TINYINT      NOT NULL DEFAULT 0 COMMENT '是否默认配置（同 provider 仅一个）',
    extra_config    TEXT         COMMENT '额外配置(JSON)，如微信 apiclient_cert 等',
    created_by      BIGINT       COMMENT '创建者用户ID',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_paycfg_provider (provider),
    INDEX idx_paycfg_enabled (enabled),
    INDEX idx_paycfg_default (provider, is_default)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付配置表';

-- 订单表（状态机: pending→paid→refunded / cancelled / expired）
CREATE TABLE IF NOT EXISTS orders (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    order_no        VARCHAR(64)  NOT NULL UNIQUE COMMENT '订单号（业务生成，唯一）',
    user_id         BIGINT       NOT NULL COMMENT '下单用户ID',
    plan_id         BIGINT       COMMENT '关联套餐ID（订阅订单时有效）',
    plan_name       VARCHAR(100) COMMENT '套餐快照名称',
    -- 金额信息
    amount          DECIMAL(12,2) NOT NULL COMMENT '订单金额（¥）',
    discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0 COMMENT '优惠金额（¥）',
    actual_amount   DECIMAL(12,2) NOT NULL COMMENT '实付金额（¥）',
    -- 支付信息
    payment_method  VARCHAR(20)  NOT NULL DEFAULT 'alipay' COMMENT '支付方式: alipay/wechat',
    payment_provider VARCHAR(20) COMMENT '实际支付渠道（冗余，便于查询）',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号（支付宝/微信返回）',
    -- 状态机: pending(待支付) → paid(已支付) → refunded(已退款) / cancelled(已取消) / expired(已过期)
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '订单状态',
    -- 时间节点
    paid_at         DATETIME     COMMENT '支付完成时间',
    refunded_at     DATETIME     COMMENT '退款完成时间',
    cancelled_at    DATETIME     COMMENT '取消时间',
    expired_at      DATETIME     COMMENT '过期时间',
    -- 扩展信息
    client_ip       VARCHAR(50)  COMMENT '下单客户端IP',
    user_agent      VARCHAR(500) COMMENT '下单User-Agent',
    remark          VARCHAR(500) COMMENT '订单备注',
    extra_data      TEXT         COMMENT '附加数据(JSON)',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_order_user (user_id),
    INDEX idx_order_no (order_no),
    INDEX idx_order_status (status),
    INDEX idx_order_method (payment_method),
    INDEX idx_order_paid (paid_at),
    INDEX idx_order_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表';

-- 支付记录表（每次支付请求/回调都记录，用于审计追溯）
CREATE TABLE IF NOT EXISTS payment_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余，便于查询）',
    trade_no        VARCHAR(100) COMMENT '第三方交易流水号',
    -- 金额
    amount          DECIMAL(12,2) NOT NULL COMMENT '支付金额（¥）',
    -- 支付状态
    payment_status  VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '支付状态: pending/success/failed/closed',
    -- 回调验签
    verify_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '验签状态: pending/verified/failed',
    verify_msg      VARCHAR(500) COMMENT '验签结果消息',
    -- 回调内容（原始数据，用于审计）
    callback_content TEXT        COMMENT '回调原始内容（JSON）',
    callback_at     DATETIME     COMMENT '回调接收时间',
    -- 请求信息
    request_content TEXT         COMMENT '下单请求参数（JSON，脱敏后）',
    response_content TEXT        COMMENT '下单响应内容（JSON，脱敏后）',
    -- 错误信息
    error_code      VARCHAR(50)  COMMENT '错误代码',
    error_msg       VARCHAR(500) COMMENT '错误消息',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_payrec_order (order_id),
    INDEX idx_payrec_trade (trade_no),
    INDEX idx_payrec_status (payment_status),
    INDEX idx_payrec_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付记录表';

-- 退款记录表
CREATE TABLE IF NOT EXISTS refund_record (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    refund_no       VARCHAR(64)  NOT NULL UNIQUE COMMENT '退款单号（业务生成）',
    order_id        BIGINT       NOT NULL COMMENT '关联订单ID',
    order_no        VARCHAR(64)  NOT NULL COMMENT '订单号（冗余）',
    trade_no        VARCHAR(100) COMMENT '原交易流水号',
    -- 退款金额
    refund_amount   DECIMAL(12,2) NOT NULL COMMENT '退款金额（¥）',
    total_amount    DECIMAL(12,2) NOT NULL COMMENT '订单原金额（¥）',
    -- 退款状态: pending(申请中) → processing(处理中) → success(成功) → failed(失败)
    refund_status   VARCHAR(20)  NOT NULL DEFAULT 'pending' COMMENT '退款状态',
    -- 退款信息
    reason          VARCHAR(500) COMMENT '退款原因',
    operator_id     BIGINT       COMMENT '操作人ID（管理员发起时）',
    trade_refund_no VARCHAR(100) COMMENT '第三方退款流水号',
    -- 回调
    callback_content TEXT        COMMENT '退款回调原始内容',
    callback_at     DATETIME     COMMENT '回调接收时间',
    -- 错误信息
    error_code      VARCHAR(50)  COMMENT '错误代码',
    error_msg       VARCHAR(500) COMMENT '错误消息',
    completed_at    DATETIME     COMMENT '退款完成时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_refund_order (order_id),
    INDEX idx_refund_no (refund_no),
    INDEX idx_refund_status (refund_status),
    INDEX idx_refund_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='退款记录表';

-- 支付操作审计日志表（全链路记录关键操作）
CREATE TABLE IF NOT EXISTS pay_audit_log (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    -- 操作人信息
    operator_id     BIGINT       COMMENT '操作人ID（0=系统自动）',
    operator_name   VARCHAR(100) COMMENT '操作人名称',
    operator_ip     VARCHAR(50)  COMMENT '操作人IP',
    -- 操作目标
    action          VARCHAR(50)  NOT NULL COMMENT '操作类型: create_order/pay/callback/refund/config_update/config_view',
    target_type     VARCHAR(20)  NOT NULL COMMENT '目标类型: order/payment/refund/config',
    target_id       VARCHAR(64)  COMMENT '目标ID/订单号',
    -- 操作内容
    description     VARCHAR(500) COMMENT '操作描述',
    before_data     TEXT         COMMENT '变更前数据(JSON)',
    after_data      TEXT         COMMENT '变更后数据(JSON)',
    -- 结果
    result          VARCHAR(20)  NOT NULL DEFAULT 'success' COMMENT '操作结果: success/failed',
    error_msg       VARCHAR(500) COMMENT '错误消息（result=failed时）',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_audit_operator (operator_id),
    INDEX idx_audit_action (action),
    INDEX idx_audit_target (target_type, target_id),
    INDEX idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='支付操作审计日志表';

-- 支付模块 RBAC 权限
-- 顶级菜单权限
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '支付管理', 'payment', 0, 'menu', 0),
    (UUID(), '订单管理', 'order', 0, 'menu', 0);

-- 子权限
INSERT IGNORE INTO sys_permission (uuid, permission_name, permission_code, parent_id, resource_type, sort_order)
VALUES
    (UUID(), '支付配置', 'payment:config',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'menu',   1),
    (UUID(), '查看支付记录', 'payment:view',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'button', 2),
    (UUID(), '退款处理', 'payment:refund', (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='payment' AND deleted=0) t), 'button', 3),
    (UUID(), '查看订单', 'order:view',    (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='order' AND deleted=0) t), 'button', 1),
    (UUID(), '导出订单', 'order:export',  (SELECT id FROM (SELECT id FROM sys_permission WHERE permission_code='order' AND deleted=0) t), 'button', 2);

-- 超级管理员 → 支付模块全部权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='super_admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('payment', 'payment:config', 'payment:view', 'payment:refund', 'order', 'order:view', 'order:export');

-- 管理员 → 支付模块全部权限
INSERT IGNORE INTO sys_role_permission (role_id, permission_id)
SELECT r.id, p.id FROM sys_role r JOIN sys_permission p
WHERE r.role_code='admin' AND r.deleted=0 AND p.deleted=0
  AND p.permission_code IN ('payment', 'payment:config', 'payment:view', 'payment:refund', 'order', 'order:view', 'order:export');
