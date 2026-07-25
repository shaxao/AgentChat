package com.aiplatform.backend.service;

import com.aiplatform.backend.billing.BillingPolicyResolver;
import com.aiplatform.backend.entity.ApiLog;
import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.ApiLogMapper;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import org.mockito.ArgumentCaptor;

class UsageTrackingServiceTest {

    private ApiLogMapper apiLogMapper;
    private ModelConfigMapper modelConfigMapper;
    private ModelChannelMapper modelChannelMapper;
    private SysUserMapper sysUserMapper;
    private UsageTrackingService usageTrackingService;

    @BeforeEach
    void setUp() {
        apiLogMapper = mock(ApiLogMapper.class);
        sysUserMapper = mock(SysUserMapper.class);
        modelConfigMapper = mock(ModelConfigMapper.class);
        modelChannelMapper = mock(ModelChannelMapper.class);
        SubscriptionMapper subscriptionMapper = mock(SubscriptionMapper.class);
        WalletService walletService = mock(WalletService.class);
        UserPreferenceService userPreferenceService = mock(UserPreferenceService.class);
        BillingPolicyResolver billingPolicyResolver = new BillingPolicyResolver(
                new ObjectMapper(),
                mock(SubscriptionPlanMapper.class)
        );

        usageTrackingService = new UsageTrackingService(
                apiLogMapper,
                sysUserMapper,
                modelConfigMapper,
                modelChannelMapper,
                subscriptionMapper,
                walletService,
                userPreferenceService,
                billingPolicyResolver
        );
    }

    @Test
    void calculatesInputCachedInputAndOutputCostInCnyPerMillionTokens() {
        when(modelConfigMapper.selectOne(any())).thenReturn(model("gpt-test",
                "2.00", "0.50", "8.00"));

        UsageTrackingService.CostBreakdown cost = usageTrackingService.calculateCostBreakdown(
                "gpt-test", 1_000, 200, 300);

        assertThat(cost.getBillableInputTokens()).isEqualTo(800);
        assertThat(cost.getCachedInputTokens()).isEqualTo(200);
        assertMoney(cost.getInputCost(), "0.0016000000");
        assertMoney(cost.getCachedInputCost(), "0.0001000000");
        assertMoney(cost.getOutputCost(), "0.0024000000");
        assertMoney(cost.getTotalCost(), "0.0041000000");
    }

    @Test
    void clampsCachedInputTokensToInputTokens() {
        when(modelConfigMapper.selectOne(any())).thenReturn(model("gpt-test",
                "2.00", "0.50", "8.00"));

        UsageTrackingService.CostBreakdown cost = usageTrackingService.calculateCostBreakdown(
                "gpt-test", 100, 500, 0);

        assertThat(cost.getBillableInputTokens()).isZero();
        assertThat(cost.getCachedInputTokens()).isEqualTo(100);
        assertMoney(cost.getTotalCost(), "0.0000500000");
    }

    @Test
    void usageSummaryAggregatesCacheHitRateAndActualCost() {
        ApiLog first = apiLog(1_000, 250, 500, "success", "0.10000000");
        ApiLog second = apiLog(1_000, 250, 100, "error", "0.20000000");
        when(apiLogMapper.selectList(any())).thenReturn(List.of(first, second));

        UserUsageService userUsageService = new UserUsageService(
                apiLogMapper,
                modelConfigMapper,
                modelChannelMapper,
                mock(SubscriptionMapper.class),
                mock(SubscriptionPlanMapper.class),
                mock(SysUserMapper.class),
                usageTrackingService
        );

        var summary = userUsageService.summary(7L, 30);

        assertThat(summary.getRequestCount()).isEqualTo(2);
        assertThat(summary.getSuccessCount()).isEqualTo(1);
        assertThat(summary.getErrorCount()).isEqualTo(1);
        assertThat(summary.getInputTokens()).isEqualTo(2_000);
        assertThat(summary.getCachedInputTokens()).isEqualTo(500);
        assertThat(summary.getBillableInputTokens()).isEqualTo(1_500);
        assertThat(summary.getOutputTokens()).isEqualTo(600);
        assertThat(summary.getTotalTokens()).isEqualTo(2_600);
        assertMoney(summary.getCacheHitRate(), "25.00");
        assertMoney(summary.getTotalCost(), "0.30000000");
    }

    @Test
    void legacyUsageLogFallsBackToEstimatedBreakdownWithoutChangingPersistedTotal() {
        ApiLog legacy = apiLog(1_000, 100, 200, "success", "0.12345678");
        legacy.setId(99L);
        legacy.setModel("legacy-model");
        legacy.setSceneType("api");
        legacy.setInputPriceSnapshot(BigDecimal.ZERO);
        legacy.setCachedInputPriceSnapshot(BigDecimal.ZERO);
        legacy.setOutputPriceSnapshot(BigDecimal.ZERO);
        legacy.setInputCost(BigDecimal.ZERO);
        legacy.setCachedInputCost(BigDecimal.ZERO);
        legacy.setOutputCost(BigDecimal.ZERO);

        Page<ApiLog> page = new Page<>(1, 20);
        page.setRecords(List.of(legacy));
        page.setTotal(1);
        when(apiLogMapper.selectPage(any(), any())).thenReturn(page);
        when(modelChannelMapper.selectList(any())).thenReturn(List.of());

        UsageTrackingService.CostBreakdown estimated = new UsageTrackingService.CostBreakdown();
        estimated.setInputPrice(new BigDecimal("2.00"));
        estimated.setCachedInputPrice(new BigDecimal("0.50"));
        estimated.setOutputPrice(new BigDecimal("8.00"));
        estimated.setInputCost(new BigDecimal("0.0018000000"));
        estimated.setCachedInputCost(new BigDecimal("0.0000500000"));
        estimated.setOutputCost(new BigDecimal("0.0016000000"));
        estimated.setTotalCost(new BigDecimal("0.0034500000"));
        when(modelConfigMapper.selectOne(any())).thenReturn(model("legacy-model",
                "2.00", "0.50", "8.00"));

        UserUsageService userUsageService = new UserUsageService(
                apiLogMapper,
                modelConfigMapper,
                modelChannelMapper,
                mock(SubscriptionMapper.class),
                mock(SubscriptionPlanMapper.class),
                mock(SysUserMapper.class),
                usageTrackingService
        );

        var logs = userUsageService.logs(7L, 1, 20, null, null, null, null, null);

        assertThat(logs.getList()).hasSize(1);
        var item = logs.getList().get(0);
        assertThat(item.isCostEstimated()).isTrue();
        assertMoney(item.getTotalCost(), "0.12345678");
        assertMoney(item.getInputPrice(), "2.00");
        assertMoney(item.getCachedInputPrice(), "0.50");
        assertMoney(item.getOutputPrice(), "8.00");
    }

    @Test
    void trackFullStillWritesApiLogWhenBillingPreflightFails() {
        when(modelConfigMapper.selectOne(any())).thenReturn(model("gpt-test",
                "1.00", "0.30", "4.00"));
        when(modelChannelMapper.selectList(any())).thenReturn(List.of());

        usageTrackingService.trackFull(7L, "gpt-test", 6_239, 6_144, 242,
                13_000, "api", null, "127.0.0.1", "OpenAI", "471");

        ArgumentCaptor<ApiLog> captor = ArgumentCaptor.forClass(ApiLog.class);
        verify(apiLogMapper).insert(captor.capture());
        ApiLog log = captor.getValue();
        assertThat(log.getUserId()).isEqualTo(7L);
        assertThat(log.getSceneType()).isEqualTo("api");
        assertThat(log.getModel()).isEqualTo("gpt-test");
        assertThat(log.getStatus()).isEqualTo("billing_failed");
        assertThat(log.getErrorMsg()).contains("User not found");
        assertThat(log.getInputTokens()).isEqualTo(6_239);
        assertThat(log.getCachedInputTokens()).isEqualTo(6_144);
        assertThat(log.getOutputTokens()).isEqualTo(242);
        assertMoney(log.getInputCost(), "0.0000950000");
        assertMoney(log.getCachedInputCost(), "0.0018432000");
        assertMoney(log.getOutputCost(), "0.0009680000");
        assertMoney(log.getCost(), "0.0029062000");
    }

    @Test
    void apiSceneDefaultsToWalletFallbackWhenQuotaIsExhausted() {
        when(modelConfigMapper.selectOne(any())).thenReturn(model("gpt-test",
                "1.00", "0.30", "4.00"));
        SysUser user = new SysUser();
        user.setId(7L);
        user.setBalance(new BigDecimal("10.00"));
        user.setCostLimit(new BigDecimal("1.00"));
        user.setCostUsed(new BigDecimal("1.00"));
        when(sysUserMapper.selectById(7L)).thenReturn(user);

        var decision = usageTrackingService.preflightUsage(7L, "gpt-test",
                new BigDecimal("0.25"), "api");

        assertMoney(decision.getQuotaCost(), "0");
        assertMoney(decision.getWalletCost(), "0.25");
    }

    private ModelConfig model(String id, String inputPrice, String cachedInputPrice, String outputPrice) {
        ModelConfig model = new ModelConfig();
        model.setModelId(id);
        model.setEnabled(true);
        model.setInputPrice(new BigDecimal(inputPrice));
        model.setCachedInputPrice(new BigDecimal(cachedInputPrice));
        model.setOutputPrice(new BigDecimal(outputPrice));
        return model;
    }

    private ApiLog apiLog(int inputTokens, int cachedInputTokens, int outputTokens, String status, String cost) {
        ApiLog log = new ApiLog();
        log.setInputTokens(inputTokens);
        log.setCachedInputTokens(cachedInputTokens);
        log.setOutputTokens(outputTokens);
        log.setStatus(status);
        log.setCost(new BigDecimal(cost));
        log.setCreatedAt(LocalDateTime.now());
        return log;
    }

    private void assertMoney(BigDecimal actual, String expected) {
        assertThat(actual).isEqualByComparingTo(new BigDecimal(expected));
    }
}
