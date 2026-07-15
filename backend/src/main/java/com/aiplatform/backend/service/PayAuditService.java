package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.entity.PayAuditLog;
import com.aiplatform.backend.mapper.PayAuditLogMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.metadata.IPage;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.UUID;

/**
 * 支付审计日志服务
 * <p>
 * 全链路记录支付关键操作，确保可追溯：
 * - create_order: 创建订单
 * - pay: 发起支付
 * - callback: 支付回调
 * - refund: 退款操作
 * - config_update: 修改支付配置
 * - config_view: 查看支付配置
 * <p>
 * 所有日志异步记录，不影响主流程性能
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PayAuditService {

    private final PayAuditLogMapper auditLogMapper;
    private final ObjectMapper objectMapper;

    /**
     * 记录审计日志（同步）
     *
     * @param operatorId   操作人ID（0=系统）
     * @param operatorName 操作人名称
     * @param operatorIp   操作人IP
     * @param action       操作类型
     * @param targetType   目标类型
     * @param targetId     目标ID
     * @param description  操作描述
     * @param beforeData   变更前数据
     * @param afterData    变更后数据
     * @param result       操作结果: success/failed
     * @param errorMsg     错误消息
     */
    public void log(Long operatorId, String operatorName, String operatorIp,
                    String action, String targetType, String targetId,
                    String description, Object beforeData, Object afterData,
                    String result, String errorMsg) {
        try {
            PayAuditLog auditLog = new PayAuditLog();
            auditLog.setUuid(UUID.randomUUID().toString());
            auditLog.setOperatorId(operatorId != null ? operatorId : 0L);
            auditLog.setOperatorName(operatorName);
            auditLog.setOperatorIp(operatorIp);
            auditLog.setAction(action);
            auditLog.setTargetType(targetType);
            auditLog.setTargetId(targetId);
            auditLog.setDescription(description);
            auditLog.setBeforeData(beforeData != null ? objectMapper.writeValueAsString(beforeData) : null);
            auditLog.setAfterData(afterData != null ? objectMapper.writeValueAsString(afterData) : null);
            auditLog.setResult(result);
            auditLog.setErrorMsg(errorMsg);

            auditLogMapper.insert(auditLog);
        } catch (Exception e) {
            log.error("[PayAuditService] 审计日志记录失败: action={}, target={}", action, targetId, e);
        }
    }

    /** 快捷方法：记录成功操作 */
    public void logSuccess(Long operatorId, String operatorName, String operatorIp,
                           String action, String targetType, String targetId,
                           String description, Object afterData) {
        log(operatorId, operatorName, operatorIp, action, targetType, targetId,
            description, null, afterData, "success", null);
    }

    /** 快捷方法：记录失败操作 */
    public void logFailed(Long operatorId, String operatorName, String operatorIp,
                          String action, String targetType, String targetId,
                          String description, String errorMsg) {
        log(operatorId, operatorName, operatorIp, action, targetType, targetId,
            description, null, null, "failed", errorMsg);
    }

    /**
     * 分页查询审计日志
     */
    public IPage<PayAuditLog> queryAuditLogs(PaymentDTO.AuditLogQueryRequest req) {
        Page<PayAuditLog> page = new Page<>(
            req.getPage() != null ? req.getPage() : 1,
            req.getSize() != null ? req.getSize() : 20
        );

        LambdaQueryWrapper<PayAuditLog> wrapper = new LambdaQueryWrapper<PayAuditLog>()
            .eq(req.getAction() != null, PayAuditLog::getAction, req.getAction())
            .eq(req.getTargetType() != null, PayAuditLog::getTargetType, req.getTargetType())
            .eq(req.getTargetId() != null, PayAuditLog::getTargetId, req.getTargetId())
            .eq(req.getOperatorId() != null, PayAuditLog::getOperatorId, req.getOperatorId())
            .eq(req.getResult() != null, PayAuditLog::getResult, req.getResult())
            .ge(req.getStartTime() != null, PayAuditLog::getCreatedAt, req.getStartTime())
            .le(req.getEndTime() != null, PayAuditLog::getCreatedAt, req.getEndTime())
            .orderByDesc(PayAuditLog::getCreatedAt);

        return auditLogMapper.selectPage(page, wrapper);
    }
}
