package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.PayConfig;
import com.aiplatform.backend.entity.RefundRecord;
import com.aiplatform.backend.entity.OrderEntity;
import com.aiplatform.backend.service.OrderService;
import com.aiplatform.backend.service.PayAuditService;
import com.aiplatform.backend.service.PayConfigService;
import com.aiplatform.backend.service.PayService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;

/**
 * 支付管理控制器
 * <p>
 * 端点分组：
 * 1. 管理端（需 ADMIN 角色）：
 *    - 支付配置 CRUD:  GET/POST/PUT/DELETE /api/payment/configs
 *    - 支付记录查看:    GET /api/payment/records
 *    - 退款处理:       POST /api/payment/refund
 *    - 退款记录查询:    GET /api/payment/refunds
 *    - 审计日志:       GET /api/payment/audit-logs
 *    - 支付统计:       GET /api/payment/stats
 * <p>
 * 2. 用户端（需登录）：
 *    - 创建订单:       POST /api/payment/orders
 *    - 发起支付:       POST /api/payment/pay/{orderNo}
 *    - 查询支付状态:    GET /api/payment/status/{orderNo}
 * <p>
 * 3. 公开端（验签保护）：
 *    - 支付宝回调:     POST /api/payment/callback/alipay
 */
@Slf4j
@RestController
@RequestMapping("/api/payment")
@RequiredArgsConstructor
public class PaymentController {

    private final PayService payService;
    private final PayConfigService payConfigService;
    private final PayAuditService payAuditService;
    private final OrderService orderService;

    // ==================== 管理端：支付配置管理 ====================

    /**
     * 获取所有支付配置列表
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/configs")
    public Result<List<PaymentDTO.PayConfigVO>> listConfigs() {
        return Result.ok(payConfigService.toVOList(payConfigService.listAll()));
    }

    /**
     * 获取单个支付配置详情
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/configs/{id}")
    public Result<PaymentDTO.PayConfigVO> getConfig(@PathVariable Long id) {
        PayConfig config = payConfigService.getById(id);
        if (config == null) {
            return Result.fail("支付配置不存在");
        }
        return Result.ok(payConfigService.toVO(config));
    }

    /**
     * 创建支付配置
     * 敏感字段（私钥/公钥/加密密钥）在 Service 层 AES-256 加密后存储
     */
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/configs")
    public Result<PaymentDTO.PayConfigVO> createConfig(
            @RequestBody PaymentDTO.PayConfigCreateRequest req,
            @RequestAttribute Long userId,
            HttpServletRequest request) {
        // 输入校验
        if (req.getProvider() == null || req.getProvider().isBlank()) {
            return Result.fail("支付渠道（provider）不能为空");
        }
        if (req.getName() == null || req.getName().isBlank()) {
            return Result.fail("配置名称不能为空");
        }
        if (req.getAppId() == null || req.getAppId().isBlank()) {
            return Result.fail("AppID 不能为空");
        }
        boolean isLdc = "ldc".equalsIgnoreCase(req.getProvider());
        if (!isLdc && (req.getPrivateKey() == null || req.getPrivateKey().isBlank())) {
            return Result.fail("商户私钥不能为空");
        }
        if (!isLdc && (req.getPublicKey() == null || req.getPublicKey().isBlank())) {
            return Result.fail("支付平台公钥不能为空");
        }

        if (isLdc && isBlank(req.getEncryptKey()) && isBlank(req.getPrivateKey())) {
            return Result.fail("LDC 支付需要配置 client secret（建议填入加密密钥字段）");
        }

        try {
            PayConfig config = payConfigService.create(req, userId);

            // 审计日志
            payAuditService.logSuccess(userId, null, getClientIp(request),
                "config_update", "config", config.getUuid(),
                "创建支付配置: " + config.getProvider() + " / " + config.getName(), config);

            return Result.ok(payConfigService.toVO(config));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 更新支付配置
     * 密钥字段为空时不更新（保持原值）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @PutMapping("/configs/{id}")
    public Result<PaymentDTO.PayConfigVO> updateConfig(
            @PathVariable Long id,
            @RequestBody PaymentDTO.PayConfigUpdateRequest req,
            @RequestAttribute Long userId,
            HttpServletRequest request) {
        try {
            PayConfig before = payConfigService.getById(id);
            if (before != null && "ldc".equalsIgnoreCase(before.getProvider())) {
                boolean appIdChanged = req.getAppId() != null
                        && !req.getAppId().isBlank()
                        && !req.getAppId().equals(before.getAppId());
                boolean hasNewSecret = !isBlank(req.getEncryptKey()) || !isBlank(req.getPrivateKey());
                boolean hasStoredSecret = !isBlank(before.getEncryptKeyEnc()) || !isBlank(before.getPrivateKeyEnc());
                if ((appIdChanged || !hasStoredSecret) && !hasNewSecret) {
                    return Result.fail("LDC 配置修改 PID 或缺少已保存密钥时，必须重新填写 Client Secret");
                }
            }
            PayConfig config = payConfigService.update(id, req);

            // 审计日志（记录变更前后的配置）
            payAuditService.log(userId, null, getClientIp(request),
                "config_update", "config", config.getUuid(),
                "更新支付配置: " + config.getName(),
                before, config, "success", null);

            return Result.ok(payConfigService.toVO(config));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 删除支付配置（逻辑删除）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @DeleteMapping("/configs/{id}")
    public Result<String> deleteConfig(
            @PathVariable Long id,
            @RequestAttribute Long userId,
            HttpServletRequest request) {
        try {
            PayConfig config = payConfigService.getById(id);
            if (config == null) {
                return Result.fail("支付配置不存在");
            }
            payConfigService.delete(id);

            // 审计日志
            payAuditService.logSuccess(userId, null, getClientIp(request),
                "config_update", "config", config.getUuid(),
                "删除支付配置: " + config.getName(), null);

            return Result.ok("删除成功");
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ==================== 管理端：支付记录 ====================

    /**
     * 分页查询支付记录
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/records")
    public Result<Result.PageResult<PaymentDTO.PaymentRecordVO>> listPaymentRecords(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String orderNo) {
        return Result.ok(orderService.listAllPaymentRecords(page, size, orderNo));
    }

    // ==================== 管理端：退款处理 ====================

    /**
     * 发起退款
     * 支持：全额退款 / 部分退款
     * 安全：仅已支付订单可退款，退款金额不超过订单金额
     */
    @PreAuthorize("hasRole('ADMIN')")
    @PostMapping("/refund")
    public Result<PaymentDTO.RefundRecordVO> refund(
            @RequestBody PaymentDTO.RefundRequest req,
            @RequestAttribute Long userId) {
        if (req.getOrderId() == null) {
            return Result.fail("订单ID不能为空");
        }
        if (req.getReason() == null || req.getReason().isBlank()) {
            return Result.fail("退款原因不能为空");
        }
        try {
            RefundRecord record = payService.refund(req, userId);
            return Result.ok(orderService.listRefundRecords(req.getOrderId())
                .stream()
                .filter(r -> r.getRefundNo().equals(record.getRefundNo()))
                .findFirst()
                .orElse(null));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 分页查询退款记录
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/refunds")
    public Result<Result.PageResult<PaymentDTO.RefundRecordVO>> listRefunds(
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status) {
        return Result.ok(orderService.listAllRefundRecords(page, size, status));
    }

    // ==================== 管理端：审计日志 ====================

    /**
     * 分页查询支付审计日志
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/audit-logs")
    public Result<Result.PageResult<PaymentDTO.PayAuditLogVO>> listAuditLogs(
            @RequestParam(required = false) String action,
            @RequestParam(required = false) String targetType,
            @RequestParam(required = false) String targetId,
            @RequestParam(required = false) Long operatorId,
            @RequestParam(required = false) String result,
            @RequestParam(required = false) String startTime,
            @RequestParam(required = false) String endTime,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {
        PaymentDTO.AuditLogQueryRequest req = new PaymentDTO.AuditLogQueryRequest();
        req.setAction(action);
        req.setTargetType(targetType);
        req.setTargetId(targetId);
        req.setOperatorId(operatorId);
        req.setResult(result);
        if (startTime != null) {
            req.setStartTime(java.time.LocalDateTime.parse(startTime));
        }
        if (endTime != null) {
            req.setEndTime(java.time.LocalDateTime.parse(endTime));
        }
        req.setPage(page);
        req.setSize(size);
        return Result.ok(orderService.listAuditLogs(req));
    }

    // ==================== 管理端：统计概览 ====================

    /**
     * 支付统计概览
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/stats")
    public Result<PaymentDTO.PaymentStatsVO> getStats() {
        return Result.ok(orderService.getStats());
    }

    // ==================== 用户端：创建订单 + 发起支付 ====================

    /**
     * 创建订单
     * 用户选择套餐后调用此接口生成订单
     */
    @PostMapping("/orders")
    public Result<PaymentDTO.PaymentCreateResponse> createOrder(
            @RequestBody PaymentDTO.OrderCreateRequest req,
            @RequestAttribute Long userId,
            HttpServletRequest request) {
        if (req.getPlanId() == null) {
            return Result.fail("请选择订阅套餐");
        }
        if (req.getPaymentMethod() == null || req.getPaymentMethod().isBlank()) {
            return Result.fail("请选择支付方式");
        }
        try {
            OrderEntity order = payService.createOrder(
                req, userId, getClientIp(request), request.getHeader("User-Agent"));
            // 直接发起支付
            PaymentDTO.PaymentCreateResponse resp = payService.createPayment(order.getOrderNo(), userId);
            return Result.ok(resp);
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 发起支付（重新支付未完成订单）
     */
    @PostMapping("/pay/{orderNo}")
    public Result<PaymentDTO.PaymentCreateResponse> createPayment(
            @PathVariable String orderNo,
            @RequestAttribute Long userId) {
        try {
            return Result.ok(payService.createPayment(orderNo, userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    /**
     * 查询支付状态（主动对账）
     */
    @GetMapping("/status/{orderNo}")
    public Result<PaymentDTO.OrderVO> queryPaymentStatus(
            @PathVariable String orderNo,
            @RequestAttribute Long userId) {
        try {
            OrderEntity order = payService.queryPaymentStatus(orderNo);
            // 校验订单归属（非管理员只能查自己的订单）
            if (!order.getUserId().equals(userId)) {
                return Result.fail("无权查看此订单");
            }
            return Result.ok(orderService.getOrderDetailByNo(orderNo));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ==================== 公开端：支付回调 ====================

    /**
     * 支付宝异步回调通知
     * <p>
     * 安全保障：
     * 1. RSA2 验签 — 确保回调来自支付宝且未被篡改
     * 2. 幂等处理 — 重复回调不重复激活订阅
     * 3. 金额校验 — 回调金额必须与订单金额一致
     * 4. 状态校验 — 仅 pending 订单可转为 paid
     * <p>
     * 返回 "success" 表示处理成功（支付宝要求）
     */
    @PostMapping(value = "/callback/alipay", produces = "text/plain")
    @ResponseBody
    public String alipayCallback(HttpServletRequest request) {
        // 提取所有回调参数
        Map<String, String> params = new java.util.HashMap<>();
        Map<String, String[]> requestParams = request.getParameterMap();
        for (Map.Entry<String, String[]> entry : requestParams.entrySet()) {
            String[] values = entry.getValue();
            StringBuilder valueStr = new StringBuilder();
            for (int i = 0; i < values.length; i++) {
                if (i > 0) valueStr.append(",");
                valueStr.append(values[i]);
            }
            params.put(entry.getKey(), valueStr.toString());
        }

        log.info("[PaymentController] 收到支付宝回调: out_trade_no={}, trade_no={}, trade_status={}",
            params.get("out_trade_no"), params.get("trade_no"), params.get("trade_status"));

        try {
            return payService.handleCallback(params);
        } catch (Exception e) {
            log.error("[PaymentController] 支付宝回调处理异常", e);
            return "failure";
        }
    }

    // ==================== 辅助方法 ====================

    /**
     * 获取客户端真实 IP
     */
    @RequestMapping(value = "/callback/ldc", method = {RequestMethod.GET, RequestMethod.POST}, produces = "text/plain")
    @ResponseBody
    public String ldcCallback(HttpServletRequest request) {
        Map<String, String> params = new java.util.HashMap<>();
        Map<String, String[]> requestParams = request.getParameterMap();
        for (Map.Entry<String, String[]> entry : requestParams.entrySet()) {
            String[] values = entry.getValue();
            StringBuilder valueStr = new StringBuilder();
            for (int i = 0; i < values.length; i++) {
                if (i > 0) valueStr.append(",");
                valueStr.append(values[i]);
            }
            params.put(entry.getKey(), valueStr.toString());
        }

        log.info("[PaymentController] received LDC callback: out_trade_no={}, trade_no={}, trade_status={}",
            params.get("out_trade_no"), params.get("trade_no"), params.get("trade_status"));

        try {
            return payService.handleCallback(params);
        } catch (Exception e) {
            log.error("[PaymentController] LDC callback failed", e);
            return "failure";
        }
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private String getClientIp(HttpServletRequest request) {
        String ip = request.getHeader("X-Forwarded-For");
        if (ip == null || ip.isEmpty() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getHeader("X-Real-IP");
        }
        if (ip == null || ip.isEmpty() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getRemoteAddr();
        }
        // 多级代理时取第一个
        if (ip != null && ip.contains(",")) {
            ip = ip.split(",")[0].trim();
        }
        return ip;
    }
}
