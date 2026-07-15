-- 通知系统数据库迁移
-- 安全可重复执行（CREATE TABLE IF NOT EXISTS）

-- 系统通知表
CREATE TABLE IF NOT EXISTS sys_notification (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    uuid            VARCHAR(36)  NOT NULL UNIQUE,
    title           VARCHAR(200) NOT NULL COMMENT '通知标题',
    content         TEXT         NOT NULL COMMENT '通知内容',
    type            VARCHAR(50)  NOT NULL DEFAULT 'announcement' COMMENT '通知类型: announcement/skill_review/system',
    target_type     VARCHAR(50)  NOT NULL DEFAULT 'all' COMMENT '推送目标: all=全部用户, specific=指定用户',
    target_user_ids TEXT         COMMENT '目标用户ID列表(逗号分隔)，target_type=specific 时有效',
    extra_data      TEXT         COMMENT '附加数据(JSON)，如技能名称、审核原因等',
    created_by      BIGINT       NOT NULL COMMENT '创建者用户ID',
    status          VARCHAR(20)  NOT NULL DEFAULT 'published' COMMENT '状态: draft/published',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted         TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_sn_type (type),
    INDEX idx_sn_status (status),
    INDEX idx_sn_created_by (created_by),
    INDEX idx_sn_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统通知表';

-- 用户通知记录表
CREATE TABLE IF NOT EXISTS user_notification (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id         BIGINT       NOT NULL COMMENT '用户ID',
    notification_id BIGINT       NOT NULL COMMENT '关联 sys_notification.id',
    is_read         TINYINT      NOT NULL DEFAULT 0 COMMENT '是否已读: 0=未读, 1=已读',
    read_at         DATETIME     COMMENT '阅读时间',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE INDEX uk_user_notification (user_id, notification_id),
    INDEX idx_un_user_id (user_id),
    INDEX idx_un_notification_id (notification_id),
    INDEX idx_un_is_read (user_id, is_read)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户通知记录表';

-- 用户隐私设置表
CREATE TABLE IF NOT EXISTS user_privacy_setting (
    id               BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id          BIGINT       NOT NULL UNIQUE COMMENT '用户ID',
    save_history     TINYINT      NOT NULL DEFAULT 1 COMMENT '保存对话历史: 0=关闭, 1=开启',
    data_improvement TINYINT      NOT NULL DEFAULT 0 COMMENT '数据用于改进: 0=关闭, 1=开启',
    two_factor_auth  TINYINT      NOT NULL DEFAULT 0 COMMENT '两步验证: 0=关闭, 1=开启',
    created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_ups_user_id (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户隐私设置表';
