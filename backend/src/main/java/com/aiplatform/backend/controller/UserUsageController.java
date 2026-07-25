package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.UserUsageDTO;
import com.aiplatform.backend.service.UserUsageService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/user")
@RequiredArgsConstructor
public class UserUsageController {

    private final UserUsageService userUsageService;

    @GetMapping("/usage-summary")
    public Result<UserUsageDTO.UsageSummary> usageSummary(
            @RequestAttribute Long userId,
            @RequestParam(defaultValue = "30") int days) {
        return Result.ok(userUsageService.summary(userId, days));
    }

    @GetMapping("/usage-logs")
    public Result<Result.PageResult<UserUsageDTO.UsageLogItem>> usageLogs(
            @RequestAttribute Long userId,
            @RequestParam(defaultValue = "1") int page,
            @RequestParam(defaultValue = "20") int size,
            @RequestParam(required = false) String model,
            @RequestParam(required = false) String sceneType,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to) {
        return Result.ok(userUsageService.logs(userId, page, size, model, sceneType, status, from, to));
    }

    @GetMapping("/model-prices")
    public Result<List<UserUsageDTO.ModelPriceItem>> modelPrices(@RequestAttribute Long userId) {
        return Result.ok(userUsageService.modelPrices(userId));
    }
}
