package com.aiplatform.backend.service;

import com.alipay.api.AlipayClient;
import com.alipay.api.DefaultAlipayClient;
import com.alipay.api.internal.util.AlipaySignature;
import com.alipay.api.request.AlipayTradePagePayRequest;
import com.alipay.api.request.AlipayTradeQueryRequest;
import com.alipay.api.request.AlipayTradeRefundRequest;
import com.alipay.api.response.AlipayTradeQueryResponse;
import com.alipay.api.response.AlipayTradeRefundResponse;
import com.aiplatform.backend.entity.PayConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.util.HashMap;
import java.util.Map;

/**
 * 支付宝适配器
 * <p>
 * 封装支付宝 SDK 核心操作：
 * 1. AlipayClient 初始化（沙箱/生产环境自动切换）
 * 2. 电脑网站支付（alipay.trade.page.pay）— 生成支付表单 HTML
 * 3. 回调验签（RSA2）— 确保回调数据未被篡改
 * 4. 交易查询（alipay.trade.query）
 * 5. 退款（alipay.trade.refund）
 * <p>
 * 安全要点：
 * - 每次 API 调用从 PayConfig 动态构建 Client，避免全局缓存密钥
 * - 验签使用 RSA2（SHA256WithRSA），拒绝 RSA1
 * - 退款支持部分退款
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class AlipayAdapter {

    private final ObjectMapper objectMapper;

    private static final String SIGN_TYPE = "RSA2";
    private static final String CHARSET = "UTF-8";
    private static final String FORMAT = "json";

    /** 沙箱网关 */
    private static final String SANDBOX_GATEWAY = "https://openapi-sandbox.dl.alipaydev.com/gateway.do";
    /** 生产网关 */
    private static final String PROD_GATEWAY = "https://openapi.alipay.com/gateway.do";

    /**
     * 构建 AlipayClient（每次从 PayConfig 动态构建，避免缓存密钥）
     */
    private AlipayClient buildClient(PayConfig config) {
        String gateway = (config.getSandbox() != null && config.getSandbox() == 1)
            ? SANDBOX_GATEWAY : PROD_GATEWAY;

        return new DefaultAlipayClient(
            gateway,
            config.getAppId(),
            config.getPrivateKey(),
            FORMAT,
            CHARSET,
            config.getPublicKey(),
            SIGN_TYPE
        );
    }

    /**
     * 电脑网站支付 — 生成支付页面表单 HTML
     * <p>
     * 用户在前端渲染此 HTML 会自动跳转到支付宝支付页面
     *
     * @param config    支付配置（含解密后的密钥）
     * @param orderNo   订单号
     * @param amount    金额（元）
     * @param subject   订单标题
     * @param body      订单描述
     * @param notifyUrl 异步回调地址
     * @param returnUrl 同步返回地址
     * @return 支付宝支付表单 HTML
     */
    public String createPagePay(PayConfig config, String orderNo, BigDecimal amount,
                                String subject, String body,
                                String notifyUrl, String returnUrl) {
        try {
            AlipayClient client = buildClient(config);

            AlipayTradePagePayRequest request = new AlipayTradePagePayRequest();
            request.setNotifyUrl(notifyUrl);
            request.setReturnUrl(returnUrl);

            // 业务参数
            Map<String, Object> bizContent = new HashMap<>();
            bizContent.put("out_trade_no", orderNo);
            bizContent.put("total_amount", amount.toPlainString());
            bizContent.put("subject", subject);
            bizContent.put("body", body != null ? body : subject);
            bizContent.put("product_code", "FAST_INSTANT_TRADE_PAY");

            request.setBizContent(objectMapper.writeValueAsString(bizContent));

            // 生成表单 HTML（pageExecute 返回完整的自提交表单）
            String form = client.pageExecute(request).getBody();

            log.info("[AlipayAdapter] 创建支付订单成功: orderNo={}, amount={}", orderNo, amount);
            return form;
        } catch (Exception e) {
            log.error("[AlipayAdapter] 创建支付订单失败: orderNo={}", orderNo, e);
            throw new RuntimeException("支付宝下单失败: " + e.getMessage(), e);
        }
    }

    /**
     * 回调验签（RSA2）
     * <p>
     * 使用支付宝公钥验证回调参数的签名，防止伪造回调
     *
     * @param config      支付配置（含支付宝公钥）
     * @param params      回调参数（已转为 Map<String, String>）
     * @return true=验签通过, false=验签失败
     */
    public boolean verifyCallback(PayConfig config, Map<String, String> params) {
        try {
            // 支付宝回调验签：sign 和 sign_type 字段不参与验签
            String sign = params.get("sign");
            String callbackAppId = params.get("app_id");
            if (config.getAppId() != null && callbackAppId != null
                    && !config.getAppId().equals(callbackAppId)) {
                log.warn("[AlipayAdapter] callback app_id mismatch: expected={}, actual={}, orderNo={}",
                        config.getAppId(), callbackAppId, params.get("out_trade_no"));
                return false;
            }
            Map<String, String> verifyParams = new HashMap<>(params);
            verifyParams.remove("sign");
            verifyParams.remove("sign_type");

            boolean verified = AlipaySignature.rsaCheckV2(
                verifyParams,
                config.getPublicKey(),
                CHARSET,
                SIGN_TYPE
            );

            if (!verified) {
                log.warn("[AlipayAdapter] 回调验签失败! orderNo={}", params.get("out_trade_no"));
            } else {
                log.info("[AlipayAdapter] 回调验签通过: orderNo={}", params.get("out_trade_no"));
            }
            return verified;
        } catch (Exception e) {
            log.error("[AlipayAdapter] 回调验签异常: orderNo={}", params.get("out_trade_no"), e);
            return false;
        }
    }

    /**
     * 交易查询
     * <p>
     * 主动查询支付宝交易状态，用于对账或回调补偿
     *
     * @param config  支付配置
     * @param orderNo 商户订单号
     * @return 查询响应
     */
    public AlipayTradeQueryResponse queryTrade(PayConfig config, String orderNo) {
        try {
            AlipayClient client = buildClient(config);

            AlipayTradeQueryRequest request = new AlipayTradeQueryRequest();
            Map<String, Object> bizContent = new HashMap<>();
            bizContent.put("out_trade_no", orderNo);
            request.setBizContent(objectMapper.writeValueAsString(bizContent));

            AlipayTradeQueryResponse response = client.execute(request);

            log.info("[AlipayAdapter] 交易查询: orderNo={}, tradeStatus={}",
                orderNo, response.getTradeStatus());
            return response;
        } catch (Exception e) {
            log.error("[AlipayAdapter] 交易查询失败: orderNo={}", orderNo, e);
            throw new RuntimeException("支付宝交易查询失败: " + e.getMessage(), e);
        }
    }

    /**
     * 退款
     * <p>
     * 调用支付宝退款接口，支持部分退款
     *
     * @param config       支付配置
     * @param orderNo      商户订单号
     * @param tradeNo      支付宝交易号（二选一，优先使用 tradeNo）
     * @param refundAmount 退款金额
     * @param refundReason 退款原因
     * @param refundNo     退款请求号（唯一标识本次退款，用于防重）
     * @return 退款响应
     */
    public AlipayTradeRefundResponse refund(PayConfig config, String orderNo, String tradeNo,
                                            BigDecimal refundAmount, String refundReason,
                                            String refundNo) {
        try {
            AlipayClient client = buildClient(config);

            AlipayTradeRefundRequest request = new AlipayTradeRefundRequest();
            Map<String, Object> bizContent = new HashMap<>();

            // 优先使用支付宝交易号
            if (tradeNo != null && !tradeNo.isEmpty()) {
                bizContent.put("trade_no", tradeNo);
            } else {
                bizContent.put("out_trade_no", orderNo);
            }
            bizContent.put("refund_amount", refundAmount.toPlainString());
            bizContent.put("refund_reason", refundReason != null ? refundReason : "用户退款");
            bizContent.put("out_request_no", refundNo);  // 防重：同一笔退款请求号唯一

            request.setBizContent(objectMapper.writeValueAsString(bizContent));

            AlipayTradeRefundResponse response = client.execute(request);

            if (response.isSuccess()) {
                log.info("[AlipayAdapter] 退款成功: orderNo={}, refundAmount={}, tradeRefundNo={}",
                    orderNo, refundAmount, response.getTradeNo());
            } else {
                log.warn("[AlipayAdapter] 退款失败: orderNo={}, code={}, msg={}, subMsg={}",
                    orderNo, response.getCode(), response.getMsg(), response.getSubMsg());
            }
            return response;
        } catch (Exception e) {
            log.error("[AlipayAdapter] 退款异常: orderNo={}", orderNo, e);
            throw new RuntimeException("支付宝退款失败: " + e.getMessage(), e);
        }
    }
}
