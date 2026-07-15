package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.entity.*;
import com.aiplatform.backend.mapper.*;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.UUID;

/**
 * 支付核心服务
 * <p>
 * 核心职责：
 * 1. 创建订单（从订阅套餐发起）
 * 2. 发起支付（调用支付宝生成支付表单）
 * 3. 处理支付回调（验签 + 幂等 + 激活订阅）
 * 4. 查询支付状态
 * 5. 发起退款
 * <p>
 * 安全设计：
 * - 订单状态机：pending → paid → refunded / cancelled / expired
 * - 回调幂等：重复回调不重复激活
 * - 防重放：订单号唯一 + 过期时间校验
 * - 全链路审计日志
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class PayService {

    private final OrderMapper orderMapper;
    private final PaymentRecordMapper paymentRecordMapper;
    private final RefundRecordMapper refundRecordMapper;
    private final PayConfigService payConfigService;
    private final PayAuditService payAuditService;
    private final AlipayAdapter alipayAdapter;
    private final LdcPayAdapter ldcPayAdapter;
    private final AdminService adminService;
    private final WalletService walletService;
    private final SubscriptionPlanMapper planMapper;
    private final SysUserMapper sysUserMapper;

    @Value("${app.payment.order-prefix:MH}")
    private String orderPrefix;

    @Value("${app.payment.order-expire-minutes:30}")
    private int orderExpireMinutes;

    // ==================== 创建订单 ====================

    /**
     * 创建订单
     *
     * @param req           创建请求（含套餐ID、支付方式）
     * @param userId        用户ID
     * @param clientIp      客户端IP
     * @param userAgent     User-Agent
     * @return 创建的订单
     */
    @Transactional
    public OrderEntity createOrder(PaymentDTO.OrderCreateRequest req, Long userId,
                                   String clientIp, String userAgent) {
        // 校验套餐
        if (req.getPlanId() == null) {
            throw new RuntimeException("请选择订阅套餐");
        }
        SubscriptionPlan plan = planMapper.selectById(req.getPlanId());
        if (plan == null || (plan.getEnabled() != null && !plan.getEnabled())) {
            throw new RuntimeException("套餐不存在或已下架");
        }

        // 校验支付方式
        String paymentMethod = req.getPaymentMethod();
        if (paymentMethod == null || paymentMethod.isEmpty()) {
            throw new RuntimeException("请选择支付方式");
        }

        // 检查支付配置是否可用
        PayConfig config = payConfigService.getDefaultConfig(paymentMethod);
        if (config == null) {
            throw new RuntimeException("支付渠道未配置或未启用: " + paymentMethod);
        }

        // 生成订单
        OrderEntity order = new OrderEntity();
        order.setUuid(UUID.randomUUID().toString());
        order.setOrderNo(generateOrderNo());
        order.setUserId(userId);
        order.setPlanId(plan.getId());
        order.setPlanName(plan.getName());
        order.setAmount(plan.getPrice());
        order.setDiscountAmount(BigDecimal.ZERO);
        order.setActualAmount(plan.getPrice());
        order.setPaymentMethod(paymentMethod);
        order.setPaymentProvider(config.getProvider());
        order.setStatus("pending");
        order.setClientIp(clientIp);
        order.setUserAgent(userAgent);
        order.setRemark(req.getRemark());
        order.setExpiredAt(LocalDateTime.now().plusMinutes(orderExpireMinutes));

        orderMapper.insert(order);

        // 审计日志
        SysUser user = sysUserMapper.selectById(userId);
        payAuditService.logSuccess(userId, user != null ? user.getUsername() : null, clientIp,
            "create_order", "order", order.getOrderNo(),
            "创建订单: " + plan.getName() + " ¥" + order.getActualAmount(), order);

        log.info("[PayService] 创建订单: orderNo={}, userId={}, plan={}, amount={}",
            order.getOrderNo(), userId, plan.getName(), order.getActualAmount());
        return order;
    }

    @Transactional
    public OrderEntity createWalletRechargeOrder(BigDecimal amount, String paymentMethod, Long userId,
                                                 String clientIp, String userAgent, String remark) {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new RuntimeException("充值金额必须大于 0");
        }
        if (paymentMethod == null || paymentMethod.isBlank()) {
            throw new RuntimeException("请选择支付方式");
        }
        PayConfig config = payConfigService.getDefaultConfig(paymentMethod);
        if (config == null) {
            throw new RuntimeException("支付渠道未配置或未启用: " + paymentMethod);
        }

        OrderEntity order = new OrderEntity();
        order.setUuid(UUID.randomUUID().toString());
        order.setOrderNo(generateOrderNo());
        order.setUserId(userId);
        order.setPlanId(null);
        order.setPlanName("钱包充值");
        order.setAmount(amount);
        order.setDiscountAmount(BigDecimal.ZERO);
        order.setActualAmount(amount);
        order.setPaymentMethod(paymentMethod);
        order.setPaymentProvider(config.getProvider());
        order.setStatus("pending");
        order.setClientIp(clientIp);
        order.setUserAgent(userAgent);
        order.setRemark(remark);
        order.setExtraData("{\"type\":\"wallet_recharge\"}");
        order.setExpiredAt(LocalDateTime.now().plusMinutes(orderExpireMinutes));
        orderMapper.insert(order);
        return order;
    }

    // ==================== 发起支付 ====================

    /**
     * 发起支付（生成支付宝支付表单）
     *
     * @param orderNo 订单号
     * @param userId  用户ID（校验归属）
     * @return 支付响应（含支付表单 HTML）
     */
    @Transactional
    public PaymentDTO.PaymentCreateResponse createPayment(String orderNo, Long userId) {
        OrderEntity order = getOrderByNo(orderNo);
        if (order == null) {
            throw new RuntimeException("订单不存在");
        }
        // 校验订单归属
        if (!order.getUserId().equals(userId)) {
            throw new RuntimeException("无权操作此订单");
        }
        // 校验订单状态
        if (!"pending".equals(order.getStatus())) {
            throw new RuntimeException("订单状态不允许支付: " + order.getStatus());
        }
        // 校验是否过期
        if (order.getExpiredAt() != null && order.getExpiredAt().isBefore(LocalDateTime.now())) {
            order.setStatus("expired");
            order.setExpiredAt(LocalDateTime.now());
            orderMapper.updateById(order);
            throw new RuntimeException("订单已过期，请重新创建");
        }

        // 获取支付配置
        PayConfig config = payConfigService.getDefaultConfig(order.getPaymentMethod());
        if (config == null) {
            throw new RuntimeException("支付配置不可用");
        }

        // 记录支付请求
        PaymentRecord record = new PaymentRecord();
        record.setUuid(UUID.randomUUID().toString());
        record.setOrderId(order.getId());
        record.setOrderNo(order.getOrderNo());
        record.setAmount(order.getActualAmount());
        record.setPaymentStatus("pending");
        record.setVerifyStatus("pending");

        try {
            // 调用支付宝生成支付表单
            String subject = order.getPlanName() != null ? order.getPlanName() : "订阅套餐";
            String body = "订单号: " + order.getOrderNo() + ", 套餐: " + order.getPlanName();

            String payForm;
            if (isLdc(order.getPaymentMethod(), config)) {
                payForm = ldcPayAdapter.createPagePay(
                    config,
                    order.getOrderNo(),
                    order.getActualAmount(),
                    subject,
                    config.getNotifyUrl(),
                    config.getReturnUrl()
                );
            } else {
                payForm = alipayAdapter.createPagePay(
                    config,
                    order.getOrderNo(),
                    order.getActualAmount(),
                    subject,
                    body,
                    config.getNotifyUrl(),
                    config.getReturnUrl()
                );
            }

            // 更新支付记录
            record.setResponseContent(payForm);
            record.setPaymentStatus("pending");
            paymentRecordMapper.insert(record);

            // 审计日志
            SysUser user = sysUserMapper.selectById(userId);
            payAuditService.logSuccess(userId, user != null ? user.getUsername() : null, order.getClientIp(),
                "pay", "order", order.getOrderNo(),
                "发起支付: " + order.getPaymentMethod() + " ¥" + order.getActualAmount(), null);

            // 构建响应
            PaymentDTO.PaymentCreateResponse resp = new PaymentDTO.PaymentCreateResponse();
            resp.setOrderNo(order.getOrderNo());
            resp.setOrderId(order.getId());
            resp.setActualAmount(order.getActualAmount());
            resp.setPaymentMethod(order.getPaymentMethod());
            resp.setPayForm(payForm);

            log.info("[PayService] 发起支付成功: orderNo={}, method={}", orderNo, order.getPaymentMethod());
            return resp;

        } catch (Exception e) {
            // 记录失败
            record.setPaymentStatus("failed");
            record.setErrorCode("CREATE_PAY_ERROR");
            record.setErrorMsg(e.getMessage());
            paymentRecordMapper.insert(record);

            SysUser user = sysUserMapper.selectById(userId);
            payAuditService.logFailed(userId, user != null ? user.getUsername() : null, order.getClientIp(),
                "pay", "order", order.getOrderNo(),
                "发起支付失败: " + e.getMessage(), e.getMessage());

            log.error("[PayService] 发起支付失败: orderNo={}", orderNo, e);
            throw new RuntimeException("发起支付失败: " + e.getMessage(), e);
        }
    }

    // ==================== 支付回调 ====================

    /**
     * 处理支付宝异步回调
     * <p>
     * 安全要点：
     * 1. RSA2 验签 — 确保回调来自支付宝且未被篡改
     * 2. 幂等处理 — 已支付的订单不重复处理
     * 3. 金额校验 — 回调金额必须与订单金额一致
     * 4. 状态校验 — 仅 pending 订单可转为 paid
     *
     * @param params 回调参数
     * @return "success" 表示处理成功（支付宝要求返回此字符串）
     */
    @Transactional
    public String handleCallback(Map<String, String> params) {
        String orderNo = params.get("out_trade_no");
        String tradeNo = params.get("trade_no");
        String tradeStatus = params.get("trade_status");
        String totalAmount = params.get("total_amount");
        if (totalAmount == null || totalAmount.isBlank()) {
            totalAmount = params.get("money");
        }

        log.info("[PayService] 收到支付回调: orderNo={}, tradeNo={}, status={}", orderNo, tradeNo, tradeStatus);

        try {
            // 1. 查找订单
            OrderEntity order = getOrderByNo(orderNo);
            if (order == null) {
                log.warn("[PayService] 回调订单不存在: orderNo={}", orderNo);
                return "failure";
            }

            // 2. 幂等检查：已支付的订单直接返回 success
            if ("paid".equals(order.getStatus()) || "refunded".equals(order.getStatus())) {
                log.info("[PayService] 订单已处理，幂等返回: orderNo={}, status={}", orderNo, order.getStatus());
                return "success";
            }

            // 3. 验签
            PayConfig config = payConfigService.getDefaultConfig(order.getPaymentMethod());
            if (config == null) {
                log.error("[PayService] 支付配置不存在: method={}", order.getPaymentMethod());
                return "failure";
            }

            boolean ldc = isLdc(order.getPaymentMethod(), config);
            boolean verified = ldc
                ? ldcPayAdapter.verifyCallback(config, params)
                : alipayAdapter.verifyCallback(config, params);

            // 4. 记录回调
            PaymentRecord callbackRecord = new PaymentRecord();
            callbackRecord.setUuid(UUID.randomUUID().toString());
            callbackRecord.setOrderId(order.getId());
            callbackRecord.setOrderNo(orderNo);
            callbackRecord.setTradeNo(tradeNo);
            callbackRecord.setAmount(new BigDecimal(totalAmount != null ? totalAmount : "0"));
            callbackRecord.setCallbackContent(toJsonString(params));
            callbackRecord.setCallbackAt(LocalDateTime.now());
            callbackRecord.setVerifyStatus(verified ? "verified" : "failed");
            callbackRecord.setVerifyMsg(verified
                ? (ldc ? "LDC MD5 verify passed" : "RSA2验签通过")
                : (ldc ? "LDC MD5 verify failed" : "RSA2验签失败"));

            if (!verified) {
                callbackRecord.setPaymentStatus("failed");
                callbackRecord.setErrorCode("VERIFY_FAILED");
                callbackRecord.setErrorMsg("回调验签失败");
                paymentRecordMapper.insert(callbackRecord);

                payAuditService.logFailed(0L, "system", null,
                    "callback", "order", orderNo,
                    "回调验签失败", "RSA2验签不通过");
                return "failure";
            }

            // 5. 校验金额
            if (order.getActualAmount().compareTo(callbackRecord.getAmount()) != 0) {
                log.warn("[PayService] 回调金额不匹配: orderNo={}, expected={}, actual={}",
                    orderNo, order.getActualAmount(), callbackRecord.getAmount());
                callbackRecord.setPaymentStatus("failed");
                callbackRecord.setErrorCode("AMOUNT_MISMATCH");
                callbackRecord.setErrorMsg("回调金额与订单金额不匹配");
                paymentRecordMapper.insert(callbackRecord);

                payAuditService.logFailed(0L, "system", null,
                    "callback", "order", orderNo,
                    "回调金额不匹配", "期望: " + order.getActualAmount() + ", 实际: " + callbackRecord.getAmount());
                return "failure";
            }

            // 6. 检查交易状态
            // 支付宝状态: TRADE_FINISHED(交易完成，不可退款) / TRADE_SUCCESS(支付成功)
            if (!"TRADE_SUCCESS".equals(tradeStatus) && !"TRADE_FINISHED".equals(tradeStatus)) {
                log.info("[PayService] 交易状态非成功，忽略: orderNo={}, status={}", orderNo, tradeStatus);
                callbackRecord.setPaymentStatus("pending");
                paymentRecordMapper.insert(callbackRecord);
                return "success";  // 非终态，返回 success 避免支付宝重试
            }

            // 7. 更新订单状态
            order.setStatus("paid");
            LocalDateTime paidAt = LocalDateTime.now();
            int paidUpdated = orderMapper.update(null, new LambdaUpdateWrapper<OrderEntity>()
                    .eq(OrderEntity::getId, order.getId())
                    .eq(OrderEntity::getStatus, "pending")
                    .set(OrderEntity::getStatus, "paid")
                    .set(OrderEntity::getTradeNo, tradeNo)
                    .set(OrderEntity::getPaidAt, paidAt));
            if (paidUpdated <= 0) {
                callbackRecord.setPaymentStatus("success");
                paymentRecordMapper.insert(callbackRecord);
                log.info("[PayService] callback order already handled or not pending: orderNo={}, status={}",
                        orderNo, order.getStatus());
                return "success";
            }
            order.setStatus("paid");
            order.setTradeNo(tradeNo);
            order.setPaidAt(paidAt);

            callbackRecord.setPaymentStatus("success");
            paymentRecordMapper.insert(callbackRecord);

            // 8. 激活订阅
            try {
                if (isWalletRechargeOrder(order)) {
                    walletService.recharge(order.getUserId(), order.getActualAmount(),
                            "钱包充值订单 " + order.getOrderNo(), 0L);
                    log.info("[PayService] 钱包充值成功: orderNo={}, userId={}, amount={}",
                            orderNo, order.getUserId(), order.getActualAmount());
                } else if (order.getPlanId() != null) {
                    SubscriptionPlan plan = planMapper.selectById(order.getPlanId());
                    if (plan != null) {
                        adminService.userSubscribe(order.getUserId(), plan.getUuid(), order.getPaymentMethod());
                        log.info("[PayService] 订阅激活成功: orderNo={}, userId={}, plan={}",
                            orderNo, order.getUserId(), plan.getName());
                    }
                }
            } catch (Exception e) {
                log.error("[PayService] 订阅激活失败（订单已支付）: orderNo={}", orderNo, e);
                // 不影响回调返回，后续可补偿
            }

            // 9. 审计日志
            payAuditService.logSuccess(0L, "system", null,
                "callback", "order", orderNo,
                "支付回调成功: tradeNo=" + tradeNo + ", ¥" + totalAmount, order);

            log.info("[PayService] 支付回调处理成功: orderNo={}, tradeNo={}", orderNo, tradeNo);
            return "success";

        } catch (Exception e) {
            log.error("[PayService] 支付回调处理异常: orderNo={}", orderNo, e);
            return "failure";
        }
    }

    // ==================== 查询支付状态 ====================

    /**
     * 主动查询支付状态（对账用）
     *
     * @param orderNo 订单号
     * @return 更新后的订单
     */
    @Transactional
    public OrderEntity queryPaymentStatus(String orderNo) {
        OrderEntity order = getOrderByNo(orderNo);
        if (order == null) {
            throw new RuntimeException("订单不存在");
        }
        if (!"alipay".equals(order.getPaymentMethod()) && !isLdc(order.getPaymentMethod(), null)) {
            return order;  // 仅支持支付宝查询
        }

        PayConfig config = payConfigService.getDefaultConfig(order.getPaymentMethod());
        if (config == null) {
            throw new RuntimeException("支付配置不可用");
        }

        try {
            if (isLdc(order.getPaymentMethod(), config)) {
                LdcPayAdapter.LdcQueryResult ldcResponse = ldcPayAdapter.queryOrder(config, orderNo);
                if (ldcResponse.isSuccess() && ldcResponse.getStatus() == 1 && "pending".equals(order.getStatus())) {
                    BigDecimal paidAmount = ldcResponse.getMoney() != null && !ldcResponse.getMoney().isBlank()
                        ? new BigDecimal(ldcResponse.getMoney())
                        : order.getActualAmount();
                    if (order.getActualAmount().compareTo(paidAmount) != 0) {
                        log.warn("[PayService] LDC query amount mismatch: orderNo={}, expected={}, actual={}",
                            orderNo, order.getActualAmount(), paidAmount);
                        return order;
                    }

                    order.setStatus("paid");
                    order.setTradeNo(ldcResponse.getTradeNo());
                    order.setPaidAt(LocalDateTime.now());
                    orderMapper.updateById(order);

                    if (isWalletRechargeOrder(order)) {
                        walletService.recharge(order.getUserId(), order.getActualAmount(),
                                "钱包充值订单" + order.getOrderNo(), 0L);
                    } else if (order.getPlanId() != null) {
                        SubscriptionPlan plan = planMapper.selectById(order.getPlanId());
                        if (plan != null) {
                            adminService.userSubscribe(order.getUserId(), plan.getUuid(), order.getPaymentMethod());
                        }
                    }
                }
                return order;
            }
            var response = alipayAdapter.queryTrade(config, orderNo);
            if (response.isSuccess()) {
                String tradeStatus = response.getTradeStatus();
                String tradeNo = response.getTradeNo();

                // 如果支付宝返回支付成功，但本地订单仍为 pending，则补偿更新
                if (("TRADE_SUCCESS".equals(tradeStatus) || "TRADE_FINISHED".equals(tradeStatus))
                    && "pending".equals(order.getStatus())) {

                    order.setStatus("paid");
                    order.setTradeNo(tradeNo);
                    order.setPaidAt(LocalDateTime.now());
                    orderMapper.updateById(order);

                    log.info("[PayService] 主动查询补偿更新订单: orderNo={}, tradeNo={}", orderNo, tradeNo);

                    // 激活订阅
                    if (isWalletRechargeOrder(order)) {
                        walletService.recharge(order.getUserId(), order.getActualAmount(),
                                "钱包充值订单 " + order.getOrderNo(), 0L);
                    } else if (order.getPlanId() != null) {
                        SubscriptionPlan plan = planMapper.selectById(order.getPlanId());
                        if (plan != null) {
                            adminService.userSubscribe(order.getUserId(), plan.getUuid(), order.getPaymentMethod());
                        }
                    }
                }
            }
        } catch (Exception e) {
            log.warn("[PayService] 查询支付状态失败: orderNo={}, error={}", orderNo, e.getMessage());
        }

        return order;
    }

    // ==================== 退款 ====================

    /**
     * 发起退款
     *
     * @param req        退款请求
     * @param operatorId 操作人ID（管理员）
     * @return 退款记录
     */
    @Transactional
    public RefundRecord refund(PaymentDTO.RefundRequest req, Long operatorId) {
        OrderEntity order = orderMapper.selectById(req.getOrderId());
        if (order == null) {
            throw new RuntimeException("订单不存在");
        }
        if (!"paid".equals(order.getStatus())) {
            throw new RuntimeException("订单状态不允许退款: " + order.getStatus());
        }

        // 退款金额（默认全额）
        BigDecimal refundAmount = req.getRefundAmount() != null
            ? req.getRefundAmount() : order.getActualAmount();
        if (refundAmount == null || refundAmount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new RuntimeException("退款金额必须大于 0");
        }
        BigDecimal refunded = sumSuccessfulRefunds(order.getId());
        if (refunded.add(refundAmount).compareTo(order.getActualAmount()) > 0) {
            throw new RuntimeException("累计退款金额不能大于订单实付金额");
        }
        if (isWalletRechargeOrder(order)) {
            walletService.assertRefundable(order.getUserId(), refundAmount);
        }
        if (refundAmount.compareTo(order.getActualAmount()) > 0) {
            throw new RuntimeException("退款金额不能大于订单金额");
        }

        // 生成退款单号
        String refundNo = "RF" + System.currentTimeMillis() + (int)(Math.random() * 10000);

        // 创建退款记录
        RefundRecord record = new RefundRecord();
        record.setUuid(UUID.randomUUID().toString());
        record.setRefundNo(refundNo);
        record.setOrderId(order.getId());
        record.setOrderNo(order.getOrderNo());
        record.setTradeNo(order.getTradeNo());
        record.setRefundAmount(refundAmount);
        record.setTotalAmount(order.getActualAmount());
        record.setRefundStatus("processing");
        record.setReason(req.getReason());
        record.setOperatorId(operatorId);

        SysUser operator = sysUserMapper.selectById(operatorId);
        if (operator != null) {
            record.setOperatorName(operator.getUsername());
        }

        try {
            // 调用支付宝退款
            PayConfig config = payConfigService.getDefaultConfig(order.getPaymentMethod());
            if (config == null) {
                throw new RuntimeException("支付配置不可用");
            }

            boolean refundSuccess;
            String tradeRefundNo = null;
            String errorCode = null;
            String errorMsg = null;

            if (isLdc(order.getPaymentMethod(), config)) {
                LdcPayAdapter.LdcRefundResult response = ldcPayAdapter.refund(
                    config,
                    order.getOrderNo(),
                    order.getTradeNo(),
                    refundAmount
                );
                refundSuccess = response.isSuccess();
                errorMsg = response.getMessage();
            } else {
                var response = alipayAdapter.refund(
                    config,
                    order.getOrderNo(),
                    order.getTradeNo(),
                    refundAmount,
                    req.getReason(),
                    refundNo
                );
                refundSuccess = response.isSuccess();
                tradeRefundNo = response.getTradeNo();
                errorCode = response.getSubCode() != null ? response.getSubCode() : response.getCode();
                errorMsg = response.getSubMsg() != null ? response.getSubMsg() : response.getMsg();
            }

            if (refundSuccess) {
                record.setRefundStatus("success");
                record.setTradeRefundNo(tradeRefundNo);
                record.setCompletedAt(LocalDateTime.now());

                // 更新订单状态
                if (refunded.add(refundAmount).compareTo(order.getActualAmount()) == 0) {
                    order.setStatus("refunded");
                    order.setRefundedAt(LocalDateTime.now());
                } else {
                    // 部分退款不改状态，但记录
                    order.setRemark("部分退款 ¥" + refundAmount);
                }
                orderMapper.updateById(order);
                if (isWalletRechargeOrder(order)) {
                    walletService.refundRecharge(order.getUserId(), refundAmount,
                            "支付退款回滚钱包充值 " + order.getOrderNo(), refundNo);
                }

                payAuditService.logSuccess(operatorId, record.getOperatorName(), null,
                    "refund", "order", order.getOrderNo(),
                    "退款成功: ¥" + refundAmount + ", 退款单号=" + refundNo, record);

                log.info("[PayService] 退款成功: orderNo={}, refundNo={}, amount={}",
                    order.getOrderNo(), refundNo, refundAmount);
            } else {
                record.setRefundStatus("failed");
                record.setErrorCode(errorCode);
                record.setErrorMsg(errorMsg);

                payAuditService.logFailed(operatorId, record.getOperatorName(), null,
                    "refund", "order", order.getOrderNo(),
                    "退款失败: " + record.getErrorMsg(), record.getErrorMsg());

                log.warn("[PayService] 退款失败: orderNo={}, code={}, msg={}",
                    order.getOrderNo(), errorCode, errorMsg);
            }

        } catch (Exception e) {
            record.setRefundStatus("failed");
            record.setErrorCode("REFUND_ERROR");
            record.setErrorMsg(e.getMessage());

            payAuditService.logFailed(operatorId, record.getOperatorName(), null,
                "refund", "order", order.getOrderNo(),
                "退款异常: " + e.getMessage(), e.getMessage());

            log.error("[PayService] 退款异常: orderNo={}", order.getOrderNo(), e);
        }

        refundRecordMapper.insert(record);
        return record;
    }

    // ==================== 辅助方法 ====================

    /**
     * 生成唯一订单号: 前缀 + 年月日时分秒 + 6位随机数
     */
    private String generateOrderNo() {
        return orderPrefix + System.currentTimeMillis() + String.format("%06d", (int)(Math.random() * 1000000));
    }

    /**
     * 根据订单号查询订单
     */
    public OrderEntity getOrderByNo(String orderNo) {
        return orderMapper.selectOne(
            new LambdaQueryWrapper<OrderEntity>()
                .eq(OrderEntity::getOrderNo, orderNo)
                .last("LIMIT 1")
        );
    }

    private BigDecimal sumSuccessfulRefunds(Long orderId) {
        if (orderId == null) return BigDecimal.ZERO;
        return refundRecordMapper.selectList(
                new LambdaQueryWrapper<RefundRecord>()
                        .eq(RefundRecord::getOrderId, orderId)
                        .eq(RefundRecord::getRefundStatus, "success"))
                .stream()
                .map(RefundRecord::getRefundAmount)
                .filter(amount -> amount != null)
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    /**
     * 简单 JSON 序列化（避免引入额外依赖）
     */
    private boolean isWalletRechargeOrder(OrderEntity order) {
        return order != null
                && order.getExtraData() != null
                && order.getExtraData().contains("\"wallet_recharge\"");
    }

    private boolean isLdc(String paymentMethod, PayConfig config) {
        return "ldc".equalsIgnoreCase(paymentMethod)
                || (config != null && "ldc".equalsIgnoreCase(config.getProvider()));
    }

    private String toJsonString(Map<String, String> params) {
        StringBuilder sb = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> entry : params.entrySet()) {
            if (!first) sb.append(",");
            sb.append("\"").append(entry.getKey()).append("\":\"")
              .append(entry.getValue() != null ? entry.getValue().replace("\"", "\\\"") : "")
              .append("\"");
            first = false;
        }
        sb.append("}");
        return sb.toString();
    }
}
