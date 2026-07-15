package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.aiplatform.backend.service.AdminService;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

/**
 * 用户端套餐接口（公开查询 + 认证后订阅）
 */
@RestController
@RequestMapping("/api/plans")
@RequiredArgsConstructor
public class PlanController {

    private final AdminService adminService;
    private final SubscriptionPlanMapper planMapper;

    /** 获取所有启用的套餐（公开，无需登录） */
    @GetMapping
    public Result<List<SubscriptionPlan>> listPublicPlans() {
        return Result.ok(adminService.listEnabledPlans());
    }

    /**
     * 用户订阅套餐（模拟支付）
     * 实际生产中这里应对接支付宝/微信支付，验证支付成功后再激活订阅
     */
    @PostMapping("/subscribe")
    public Result<String> subscribe(
            @RequestAttribute Long userId,
            @RequestBody Map<String, Object> body) {
        String planUuid = (String) body.get("planUuid");
        String paymentMethod = (String) body.getOrDefault("paymentMethod", "mock");
        SubscriptionPlan plan = planMapper.selectOne(new QueryWrapper<SubscriptionPlan>()
                .eq("uuid", planUuid)
                .eq("deleted", 0)
                .last("LIMIT 1"));
        if (plan == null || (plan.getEnabled() != null && !plan.getEnabled())) {
            return Result.fail("套餐不存在或已下架");
        }
        if (plan.getPrice() != null && plan.getPrice().compareTo(BigDecimal.ZERO) > 0) {
            return Result.fail("付费套餐请先创建支付订单，支付成功后自动开通");
        }
        adminService.userSubscribe(userId, planUuid, paymentMethod);
        return Result.ok("订阅成功");
    }
}
