package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.PayConfig;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Map;
import java.util.TreeMap;

@Slf4j
@Component
@RequiredArgsConstructor
public class LdcPayAdapter {

    private final ObjectMapper objectMapper;

    private static final String DEFAULT_GATEWAY = "https://credit.linux.do/epay";
    private static final String TYPE = "epay";
    private static final String SIGN_TYPE = "MD5";

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .followRedirects(HttpClient.Redirect.NEVER)
            .build();

    public String createPagePay(PayConfig config, String orderNo, BigDecimal amount,
                                String subject, String notifyUrl, String returnUrl) {
        Map<String, String> params = new TreeMap<>();
        params.put("pid", required(config.getAppId(), "LDC pid/appId is required"));
        params.put("type", TYPE);
        params.put("out_trade_no", orderNo);
        params.put("name", truncate(subject != null ? subject : "MuHuo order", 64));
        params.put("money", money(amount));
        putIfText(params, "notify_url", notifyUrl);
        putIfText(params, "return_url", returnUrl);
        params.put("sign", sign(params, secret(config)));
        params.put("sign_type", SIGN_TYPE);

        String action = gateway(config) + "/pay/submit.php";
        return buildAutoSubmitForm(action, params);
    }

    public boolean verifyCallback(PayConfig config, Map<String, String> params) {
        String sign = params.get("sign");
        if (sign == null || sign.isBlank()) {
            log.warn("[LdcPayAdapter] missing sign, orderNo={}", params.get("out_trade_no"));
            return false;
        }
        String pid = params.get("pid");
        if (config.getAppId() != null && pid != null && !config.getAppId().equals(pid)) {
            log.warn("[LdcPayAdapter] callback pid mismatch: expected={}, actual={}, orderNo={}",
                    config.getAppId(), pid, params.get("out_trade_no"));
            return false;
        }
        String expected = sign(params, secret(config));
        boolean ok = expected.equalsIgnoreCase(sign);
        if (!ok) {
            log.warn("[LdcPayAdapter] callback sign verify failed, orderNo={}", params.get("out_trade_no"));
        }
        return ok;
    }

    public LdcQueryResult queryOrder(PayConfig config, String orderNo) {
        try {
            String url = gateway(config) + "/api.php"
                    + "?act=order"
                    + "&pid=" + encode(required(config.getAppId(), "LDC pid/appId is required"))
                    + "&key=" + encode(secret(config))
                    + "&out_trade_no=" + encode(orderNo);
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofSeconds(15))
                    .GET()
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            JsonNode root = objectMapper.readTree(response.body());
            LdcQueryResult result = new LdcQueryResult();
            result.setSuccess(root.path("code").asInt(0) == 1);
            result.setTradeNo(root.path("trade_no").asText(null));
            result.setOutTradeNo(root.path("out_trade_no").asText(orderNo));
            result.setMoney(root.path("money").asText(null));
            result.setStatus(root.path("status").asInt(0));
            result.setMessage(root.path("msg").asText(""));
            return result;
        } catch (Exception e) {
            throw new RuntimeException("LDC order query failed: " + e.getMessage(), e);
        }
    }

    public LdcRefundResult refund(PayConfig config, String orderNo, String tradeNo, BigDecimal amount) {
        try {
            Map<String, String> params = new TreeMap<>();
            params.put("pid", required(config.getAppId(), "LDC pid/appId is required"));
            params.put("key", secret(config));
            params.put("trade_no", required(tradeNo, "LDC trade_no is required"));
            params.put("money", money(amount));
            putIfText(params, "out_trade_no", orderNo);

            HttpRequest request = HttpRequest.newBuilder(URI.create(gateway(config) + "/api.php"))
                    .timeout(Duration.ofSeconds(20))
                    .header("Content-Type", "application/x-www-form-urlencoded")
                    .POST(HttpRequest.BodyPublishers.ofString(toFormBody(params), StandardCharsets.UTF_8))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            JsonNode root = objectMapper.readTree(response.body());
            LdcRefundResult result = new LdcRefundResult();
            result.setSuccess(root.path("code").asInt(0) == 1);
            result.setMessage(root.path("msg").asText(""));
            return result;
        } catch (Exception e) {
            throw new RuntimeException("LDC refund failed: " + e.getMessage(), e);
        }
    }

    private String sign(Map<String, String> input, String secret) {
        TreeMap<String, String> sorted = new TreeMap<>();
        input.forEach((k, v) -> {
            if (k == null || v == null || v.isBlank()) return;
            if ("sign".equals(k) || "sign_type".equals(k)) return;
            sorted.put(k, v);
        });
        StringBuilder data = new StringBuilder();
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if (data.length() > 0) data.append('&');
            data.append(e.getKey()).append('=').append(e.getValue());
        }
        data.append(secret);
        return md5Lower(data.toString());
    }

    private String gateway(PayConfig config) {
        String gateway = null;
        try {
            if (config.getExtraConfig() != null && !config.getExtraConfig().isBlank()) {
                JsonNode root = objectMapper.readTree(config.getExtraConfig());
                gateway = root.path("gateway").asText(null);
            }
        } catch (Exception e) {
            log.warn("[LdcPayAdapter] invalid extraConfig, fallback to default gateway: {}", e.getMessage());
        }
        if (gateway == null || gateway.isBlank()) gateway = DEFAULT_GATEWAY;
        while (gateway.endsWith("/")) gateway = gateway.substring(0, gateway.length() - 1);
        return gateway;
    }

    private String secret(PayConfig config) {
        String secret = config.getEncryptKey();
        if (secret == null || secret.isBlank()) secret = config.getPrivateKey();
        return required(secret, "LDC client secret is required");
    }

    private static String money(BigDecimal amount) {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) <= 0) {
            throw new RuntimeException("LDC amount must be greater than 0");
        }
        return amount.setScale(2, RoundingMode.HALF_UP).toPlainString();
    }

    private static void putIfText(Map<String, String> params, String key, String value) {
        if (value != null && !value.isBlank()) params.put(key, value);
    }

    private static String required(String value, String message) {
        if (value == null || value.isBlank()) throw new RuntimeException(message);
        return value;
    }

    private static String truncate(String value, int max) {
        if (value == null || value.length() <= max) return value;
        return value.substring(0, max);
    }

    private static String md5Lower(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            throw new RuntimeException("MD5 sign failed", e);
        }
    }

    private static String buildAutoSubmitForm(String action, Map<String, String> params) {
        StringBuilder html = new StringBuilder();
        html.append("<!doctype html><html><head><meta charset=\"utf-8\"><title>LDC Pay</title></head>");
        html.append("<body onload=\"document.forms[0].submit()\">");
        html.append("<form method=\"post\" action=\"").append(escapeHtml(action)).append("\">");
        params.forEach((k, v) -> html.append("<input type=\"hidden\" name=\"")
                .append(escapeHtml(k)).append("\" value=\"").append(escapeHtml(v)).append("\">"));
        html.append("<noscript><button type=\"submit\">Continue to LDC Pay</button></noscript>");
        html.append("</form></body></html>");
        return html.toString();
    }

    private static String toFormBody(Map<String, String> params) {
        StringBuilder body = new StringBuilder();
        params.forEach((k, v) -> {
            if (body.length() > 0) body.append('&');
            body.append(encode(k)).append('=').append(encode(v));
        });
        return body.toString();
    }

    private static String encode(String value) {
        return URLEncoder.encode(value != null ? value : "", StandardCharsets.UTF_8);
    }

    private static String escapeHtml(String value) {
        return (value != null ? value : "")
                .replace("&", "&amp;")
                .replace("\"", "&quot;")
                .replace("<", "&lt;")
                .replace(">", "&gt;");
    }

    @Data
    public static class LdcQueryResult {
        private boolean success;
        private String tradeNo;
        private String outTradeNo;
        private String money;
        private int status;
        private String message;
    }

    @Data
    public static class LdcRefundResult {
        private boolean success;
        private String message;
    }
}
