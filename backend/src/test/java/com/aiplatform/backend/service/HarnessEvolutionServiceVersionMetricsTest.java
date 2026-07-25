package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.HarnessTrace;
import com.aiplatform.backend.entity.HarnessVersion;
import com.aiplatform.backend.mapper.HarnessFailureCaseMapper;
import com.aiplatform.backend.mapper.HarnessPatchMapper;
import com.aiplatform.backend.mapper.HarnessRegressionRunMapper;
import com.aiplatform.backend.mapper.HarnessTraceEventMapper;
import com.aiplatform.backend.mapper.HarnessTraceMapper;
import com.aiplatform.backend.mapper.HarnessVersionMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class HarnessEvolutionServiceVersionMetricsTest {

    private final HarnessTraceMapper traceMapper = mock(HarnessTraceMapper.class);
    private final HarnessFailureCaseMapper failureCaseMapper = mock(HarnessFailureCaseMapper.class);
    private final HarnessPatchMapper patchMapper = mock(HarnessPatchMapper.class);
    private final HarnessRegressionRunMapper regressionRunMapper = mock(HarnessRegressionRunMapper.class);
    private final HarnessVersionMapper versionMapper = mock(HarnessVersionMapper.class);
    private final HarnessTraceEventMapper traceEventMapper = mock(HarnessTraceEventMapper.class);
    private final HarnessReplayToolSandboxService replayToolSandboxService = mock(HarnessReplayToolSandboxService.class);

    private HarnessEvolutionService newService() {
        return new HarnessEvolutionService(traceMapper, failureCaseMapper, patchMapper, regressionRunMapper,
                versionMapper, traceEventMapper, replayToolSandboxService, new ObjectMapper());
    }

    @Test
    @SuppressWarnings("unchecked")
    void mergesTraceAndToolMetricsAndComparesCanaryAgainstActive() {
        HarnessEvolutionService service = newService();

        // Two versions: an active baseline and a canary under evaluation.
        when(traceMapper.aggregateByVersion(anyString(), any(LocalDateTime.class))).thenReturn(List.of(
                traceRow("chat-active", 100L, 90L, 10L, 0L, 1500.0, 1000L, 2000L),
                traceRow("chat-canary-1", 50L, 48L, 2L, 0L, 1200.0, 500L, 1100L)
        ));
        when(traceEventMapper.aggregateToolOutcomesByVersion(anyString(), any(LocalDateTime.class))).thenReturn(List.of(
                toolRow("chat-active", 40L, 8L),   // 80% tool success
                toolRow("chat-canary-1", 20L, 2L)  // 90% tool success
        ));
        // Version registry resolves status + rollout percentage.
        when(versionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(
                version(1L, "chat", "chat-active", "active", null),
                version(2L, "chat", "chat-canary-1", "canary",
                        "{\"policy\":{\"rollout\":{\"percentage\":5}}}")
        ));
        // Empty-response sampling: one blank output on the canary only.
        when(traceMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(
                trace("chat-active", "{\"hasOutput\":true}"),
                trace("chat-canary-1", "{\"hasOutput\":true}"),
                trace("chat-canary-1", "{\"hasOutput\":false}")
        ));

        Map<String, Object> result = service.versionMetrics("chat", 7);

        assertThat(result.get("windowDays")).isEqualTo(7);

        Map<String, Object> active = (Map<String, Object>) result.get("active");
        assertThat(active).isNotNull();
        assertThat(active.get("version")).isEqualTo("chat-active");
        assertThat(active.get("successRate")).isEqualTo(90.0);
        assertThat(active.get("failureRate")).isEqualTo(10.0);
        assertThat(active.get("toolSuccessRate")).isEqualTo(80.0);
        assertThat(active.get("avgLatencyMs")).isEqualTo(1500L);

        List<Map<String, Object>> canaries = (List<Map<String, Object>>) result.get("canaries");
        assertThat(canaries).hasSize(1);
        Map<String, Object> canary = canaries.get(0);
        assertThat(canary.get("version")).isEqualTo("chat-canary-1");
        assertThat(canary.get("successRate")).isEqualTo(96.0);
        assertThat(canary.get("toolSuccessRate")).isEqualTo(90.0);
        assertThat(canary.get("percentage")).isEqualTo(5);
        // Empty-response rate: 1 blank out of 2 canary samples = 50%.
        assertThat(canary.get("emptyResponseRate")).isEqualTo(50.0);

        Map<String, Object> comparison = (Map<String, Object>) result.get("comparison");
        assertThat(comparison).isNotNull();
        assertThat(comparison.get("canaryVersion")).isEqualTo("chat-canary-1");
        // canary 96 - active 90 = +6.0
        assertThat(comparison.get("successRateDelta")).isEqualTo(6.0);
        // canary 90 - active 80 = +10.0
        assertThat(comparison.get("toolSuccessRateDelta")).isEqualTo(10.0);
        // canary 1200 - active 1500 = -300
        assertThat(comparison.get("avgLatencyDelta")).isEqualTo(-300L);
    }

    @Test
    @SuppressWarnings("unchecked")
    void hasNoComparisonWhenNoCanaryExists() {
        HarnessEvolutionService service = newService();

        when(traceMapper.aggregateByVersion(anyString(), any(LocalDateTime.class))).thenReturn(List.of(
                traceRow("chat-active", 10L, 10L, 0L, 0L, 800.0, 100L, 200L)
        ));
        when(traceEventMapper.aggregateToolOutcomesByVersion(anyString(), any(LocalDateTime.class)))
                .thenReturn(List.of());
        when(versionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(
                version(1L, "chat", "chat-active", "active", null)
        ));
        when(traceMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of());

        Map<String, Object> result = service.versionMetrics("chat", 7);

        assertThat(result.get("active")).isNotNull();
        assertThat((List<Map<String, Object>>) result.get("canaries")).isEmpty();
        assertThat(result.get("comparison")).isNull();
        // No tool events recorded -> toolSuccessRate stays null.
        assertThat(((Map<String, Object>) result.get("active")).get("toolSuccessRate")).isNull();
    }

    @Test
    void clampsWindowDaysIntoRange() {
        HarnessEvolutionService service = newService();
        when(traceMapper.aggregateByVersion(any(), any(LocalDateTime.class))).thenReturn(List.of());
        when(traceEventMapper.aggregateToolOutcomesByVersion(any(), any(LocalDateTime.class))).thenReturn(List.of());
        when(versionMapper.selectList(any())).thenReturn(List.of());
        when(traceMapper.selectList(any())).thenReturn(List.of());

        assertThat(service.versionMetrics("chat", 999).get("windowDays")).isEqualTo(90);
        assertThat(service.versionMetrics("chat", 0).get("windowDays")).isEqualTo(1);
    }

    private Map<String, Object> traceRow(String version, long total, long success, long failed, long running,
                                         double avgLatency, long inTokens, long outTokens) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("version", version);
        row.put("total", total);
        row.put("successCount", success);
        row.put("failedCount", failed);
        row.put("runningCount", running);
        row.put("avgLatencyMs", avgLatency);
        row.put("inputTokens", inTokens);
        row.put("outputTokens", outTokens);
        return row;
    }

    private Map<String, Object> toolRow(String version, long toolResults, long toolErrors) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("version", version);
        row.put("toolResults", toolResults);
        row.put("toolErrors", toolErrors);
        return row;
    }

    private HarnessVersion version(Long id, String surface, String version, String status, String configJson) {
        HarnessVersion v = new HarnessVersion();
        v.setId(id);
        v.setSurface(surface);
        v.setVersion(version);
        v.setStatus(status);
        v.setConfigJson(configJson);
        return v;
    }

    private HarnessTrace trace(String version, String qualityJson) {
        HarnessTrace t = new HarnessTrace();
        t.setHarnessVersion(version);
        t.setQualityJson(qualityJson);
        return t;
    }
}
