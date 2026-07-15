package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.PaymentDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.OrderEntity;
import com.aiplatform.backend.entity.WalletTransaction;
import com.aiplatform.backend.service.PayService;
import com.aiplatform.backend.service.WalletService;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

@Slf4j
@RestController
@RequestMapping("/api/wallet")
@RequiredArgsConstructor
public class WalletController {

    private final WalletService walletService;
    private final PayService payService;

    @GetMapping("/balance")
    public Result<BigDecimal> balance(Authentication authentication) {
        return Result.ok(walletService.getBalance(extractUserId(authentication)));
    }

    @GetMapping("/transactions")
    public Result<List<WalletTransaction>> transactions(Authentication authentication) {
        return Result.ok(walletService.getTransactions(extractUserId(authentication)));
    }

    @PostMapping("/recharge")
    public Result<PaymentDTO.PaymentCreateResponse> recharge(
            @RequestBody Map<String, Object> body,
            Authentication authentication,
            HttpServletRequest request) {
        Long userId = extractUserId(authentication);
        BigDecimal amount = new BigDecimal(body.get("amount").toString());
        String desc = body.getOrDefault("description", "").toString();
        String paymentMethod = body.getOrDefault("paymentMethod", "alipay").toString();
        try {
            OrderEntity order = payService.createWalletRechargeOrder(
                    amount,
                    paymentMethod,
                    userId,
                    getClientIp(request),
                    request.getHeader("User-Agent"),
                    desc.isBlank() ? "wallet recharge" : desc);
            return Result.ok(payService.createPayment(order.getOrderNo(), userId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PostMapping("/withdraw")
    public Result<WalletTransaction> withdraw(
            @RequestBody Map<String, Object> body,
            Authentication authentication) {
        Long userId = extractUserId(authentication);
        BigDecimal amount = new BigDecimal(body.get("amount").toString());
        String desc = body.getOrDefault("description", "withdraw request").toString();
        try {
            return Result.ok(walletService.requestWithdraw(userId, amount, desc));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @GetMapping("/admin/transactions")
    public Result<List<WalletTransaction>> adminTransactions(
            @RequestParam(defaultValue = "100") int limit,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        return Result.ok(walletService.getAllTransactions(limit));
    }

    @PostMapping("/admin/recharge")
    public Result<WalletTransaction> adminRecharge(
            @RequestBody Map<String, Object> body,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        Long userId = Long.valueOf(body.get("userId").toString());
        BigDecimal amount = new BigDecimal(body.get("amount").toString());
        String desc = body.getOrDefault("description", "admin recharge").toString();
        try {
            return Result.ok(walletService.recharge(userId, amount, desc, adminId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PostMapping("/admin/withdraw/approve")
    public Result<WalletTransaction> approveWithdraw(
            @RequestBody Map<String, Object> body,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        Long txId = Long.valueOf(body.get("txId").toString());
        try {
            return Result.ok(walletService.approveWithdraw(txId, adminId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    @PostMapping("/admin/withdraw/reject")
    public Result<WalletTransaction> rejectWithdraw(
            @RequestBody Map<String, Object> body,
            Authentication authentication,
            @RequestAttribute(value = "userRole", required = false) String userRole) {
        requireAdmin(userRole);
        Long adminId = extractUserId(authentication);
        Long txId = Long.valueOf(body.get("txId").toString());
        String reason = body.getOrDefault("reason", "").toString();
        try {
            return Result.ok(walletService.rejectWithdraw(txId, reason, adminId));
        } catch (RuntimeException e) {
            return Result.fail(e.getMessage());
        }
    }

    private void requireAdmin(String userRole) {
        if (!"admin".equals(userRole) && !"super_admin".equals(userRole)) {
            throw new RuntimeException("Admin permission required");
        }
    }

    private Long extractUserId(Authentication authentication) {
        if (authentication == null || authentication.getPrincipal() == null) return null;
        Object principal = authentication.getPrincipal();
        if (principal instanceof Long userId) return userId;
        try {
            return Long.parseLong(authentication.getName());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private String getClientIp(HttpServletRequest request) {
        String ip = request.getHeader("X-Forwarded-For");
        if (ip == null || ip.isBlank() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getHeader("X-Real-IP");
        }
        if (ip == null || ip.isBlank() || "unknown".equalsIgnoreCase(ip)) {
            ip = request.getRemoteAddr();
        }
        if (ip != null && ip.contains(",")) ip = ip.split(",")[0].trim();
        return ip;
    }
}
