package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.OrderService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.util.List;

/**
 * 订单管理控制器
 * <p>
 * 端点分组：
 * 1. 管理端（需 ADMIN 角色）：
 *    - 订单列表（多条件组合筛选 + 分页）: GET /api/orders
 *    - 订单详情:                       GET /api/orders/{id}
 *    - 订单导出（CSV）:                 GET /api/orders/export
 *    - 订单统计概览:                    GET /api/orders/stats
 *    - 订单支付记录:                    GET /api/orders/{id}/payments
 *    - 订单退款记录:                    GET /api/orders/{id}/refunds
 * <p>
 * 2. 用户端（需登录）：
 *    - 我的订单:                       GET /api/orders/my
 *    - 订单详情（仅自己的）:             GET /api/orders/{id}  （非管理员校验归属）
 */
@Slf4j
@RestController
@RequestMapping("/api/orders")
@RequiredArgsConstructor
public class OrderController {

    private final OrderService orderService;

    // ==================== 管理端：订单列表 ====================

    /**
     * 订单列表查询（多条件组合筛选 + 分页）
     * <p>
     * 支持的筛选条件：
     * - orderNo:       订单号（模糊匹配）
     * - tradeNo:       第三方交易流水号
     * - userId:        用户ID
     * - username:      用户名（模糊匹配）
     * - status:        订单状态（pending/paid/refunded/cancelled/expired）
     * - paymentMethod: 支付方式（alipay/wechat）
     * - planId:        套餐ID
     * - minAmount:     最小金额
     * - maxAmount:     最大金额
     * - startTime:     开始时间（ISO 8601）
     * - endTime:       结束时间（ISO 8601）
     * - sortBy:        排序字段（created_at/amount/paid_at/updated_at）
     * - sortDir:       排序方向（asc/desc）
     * - page:          页码（默认1）
     * - size:          每页大小（默认20）
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping
    public Result<Result.PageResult<PaymentDTO.OrderBriefVO>> listOrders(
            @RequestParam(required = false) String orderNo,
            @RequestParam(required = false) String tradeNo,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String username,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String paymentMethod,
            @RequestParam(required = false) Long planId,
            @RequestParam(required = false) BigDecimal minAmount,
            @RequestParam(required = false) BigDecimal maxAmount,
            @RequestParam(required = false) String startTime,
            @RequestParam(required = false) String endTime,
            @RequestParam(required = false) String sortBy,
            @RequestParam(required = false) String sortDir,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size) {

        PaymentDTO.OrderQueryRequest req = buildQueryRequest(orderNo, tradeNo, userId, username,
            status, paymentMethod, planId, minAmount, maxAmount, startTime, endTime, sortBy, sortDir, page, size);

        return Result.ok(orderService.listOrders(req));
    }

    // ==================== 管理端：订单详情 ====================

    /**
     * 获取订单详情
     * 包含：订单基本信息、金额信息、支付信息、时间节点
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/{id}")
    public Result<PaymentDTO.OrderVO> getOrderDetail(@PathVariable Long id) {
        try {
            return Result.ok(orderService.getOrderDetail(id));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    // ==================== 管理端：订单导出 ====================

    /**
     * 导出订单为 CSV 文件（兼容 Excel 打开）
     * <p>
     * 添加 UTF-8 BOM 头确保 Excel 正确识别中文编码
     * 最大导出行数 10000 条
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/export")
    public void exportOrders(
            @RequestParam(required = false) String orderNo,
            @RequestParam(required = false) String tradeNo,
            @RequestParam(required = false) Long userId,
            @RequestParam(required = false) String username,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String paymentMethod,
            @RequestParam(required = false) Long planId,
            @RequestParam(required = false) BigDecimal minAmount,
            @RequestParam(required = false) BigDecimal maxAmount,
            @RequestParam(required = false) String startTime,
            @RequestParam(required = false) String endTime,
            HttpServletResponse response) {

        PaymentDTO.OrderQueryRequest req = buildQueryRequest(orderNo, tradeNo, userId, username,
            status, paymentMethod, planId, minAmount, maxAmount, startTime, endTime,
            null, null, 1, 10000);

        String csv = orderService.exportOrdersCsv(req);
        String filename = "orders_" + java.time.LocalDate.now() + ".csv";

        try {
            response.setContentType("text/csv; charset=UTF-8");
            response.setHeader("Content-Disposition",
                "attachment; filename=\"" + URLEncoder.encode(filename, StandardCharsets.UTF_8) + "\"");
            response.getOutputStream().write(csv.getBytes(StandardCharsets.UTF_8));
            response.getOutputStream().flush();
        } catch (Exception e) {
            log.error("[OrderController] 导出订单 CSV 失败", e);
            throw new RuntimeException("导出失败: " + e.getMessage());
        }
    }

    // ==================== 管理端：订单统计 ====================

    /**
     * 支付统计概览
     * 包含：今日订单数/金额、总订单数/金额、待处理退款、各支付方式统计
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/stats")
    public Result<PaymentDTO.PaymentStatsVO> getStats() {
        return Result.ok(orderService.getStats());
    }

    // ==================== 管理端：订单关联记录 ====================

    /**
     * 获取订单的支付记录列表
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/{id}/payments")
    public Result<List<PaymentDTO.PaymentRecordVO>> getOrderPayments(@PathVariable Long id) {
        return Result.ok(orderService.listPaymentRecords(id));
    }

    /**
     * 获取订单的退款记录列表
     */
    @PreAuthorize("hasRole('ADMIN')")
    @GetMapping("/{id}/refunds")
    public Result<List<PaymentDTO.RefundRecordVO>> getOrderRefunds(@PathVariable Long id) {
        return Result.ok(orderService.listRefundRecords(id));
    }

    // ==================== 用户端：我的订单 ====================

    /**
     * 获取当前用户的订单列表
     *
     * @param userId 当前用户ID（由 JWT 注入）
     * @param page   页码
     * @param size   每页大小
     * @param status 状态过滤（可选）
     */
    @GetMapping("/my")
    public Result<Result.PageResult<PaymentDTO.OrderBriefVO>> myOrders(
            @RequestAttribute Long userId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String status) {
        return Result.ok(orderService.listUserOrders(userId, page, size, status));
    }

    // ==================== 辅助方法 ====================

    /**
     * 构建查询请求对象
     */
    private PaymentDTO.OrderQueryRequest buildQueryRequest(
            String orderNo, String tradeNo, Long userId, String username,
            String status, String paymentMethod, Long planId,
            BigDecimal minAmount, BigDecimal maxAmount,
            String startTime, String endTime,
            String sortBy, String sortDir,
            int page, int size) {

        PaymentDTO.OrderQueryRequest req = new PaymentDTO.OrderQueryRequest();
        req.setOrderNo(orderNo);
        req.setTradeNo(tradeNo);
        req.setUserId(userId);
        req.setUsername(username);
        req.setStatus(status);
        req.setPaymentMethod(paymentMethod);
        req.setPlanId(planId);
        req.setMinAmount(minAmount);
        req.setMaxAmount(maxAmount);
        if (startTime != null && !startTime.isBlank()) {
            req.setStartTime(LocalDateTime.parse(startTime));
        }
        if (endTime != null && !endTime.isBlank()) {
            req.setEndTime(LocalDateTime.parse(endTime));
        }
        req.setSortBy(sortBy);
        req.setSortDir(sortDir);
        req.setPage(page);
        req.setSize(size);
        return req;
    }
}
