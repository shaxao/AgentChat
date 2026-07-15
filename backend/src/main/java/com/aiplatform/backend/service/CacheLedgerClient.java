package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Client for the shared cache ledger used by AutoCode and the Java dialogue system.
 *
 * The client is intentionally best-effort: cache failures must never break chat.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CacheLedgerClient {

    private final ObjectMapper objectMapper;

    @Value("${app.cache-ledger.base-url:${CACHE_LEDGER_BASE_URL:}}")
    private String baseUrl;

    @Value("${app.cache-ledger.timeout-ms:${CACHE_LEDGER_TIMEOUT_MS:2500}}")
    private long timeoutMs;

    private WebClient client() {
        return WebClient.builder()
                .baseUrl(normalizeBaseUrl(baseUrl))
                .build();
    }

    public boolean isEnabled() {
        return baseUrl != null && !baseUrl.isBlank();
    }

    public Map<String, Object> buildPromptContext(
            String tenantId,
            String userId,
            String sessionId,
            String model,
            String provider,
            String contextVersion,
            String systemPrompt,
            Object stableContext
    ) {
        Map<String, Object> body = new HashMap<>();
        body.put("tenant_id", safe(tenantId));
        body.put("user_id", safe(userId));
        body.put("session_id", safe(sessionId));
        body.put("model", safe(model));
        body.put("provider", safe(provider));
        body.put("context_version", safe(contextVersion));
        body.put("system_prompt", safe(systemPrompt));
        body.put("stable_context", stableContext);
        return post("/prompt-context", body);
    }

    public void recordEvent(Map<String, Object> event) {
        post("/events", event != null ? event : Map.of());
    }

    public void recordProviderUsage(
            String tenantId,
            String userId,
            String sessionId,
            String model,
            String provider,
            int inputTokens,
            int cachedInputTokens,
            int outputTokens,
            int latencyMs
    ) {
        Map<String, Object> event = new HashMap<>();
        event.put("cache_layer", "L3");
        event.put("cache_key", "java-provider:" + safe(sessionId) + ":" + safe(model));
        event.put("status", cachedInputTokens > 0 ? "hit" : "miss");
        event.put("scene_type", "chat");
        event.put("tenant_id", safe(tenantId));
        event.put("user_id", safe(userId));
        event.put("session_id", safe(sessionId));
        event.put("model", safe(model));
        event.put("provider", safe(provider));
        event.put("input_tokens", Math.max(0, inputTokens));
        event.put("cached_input_tokens", Math.max(0, cachedInputTokens));
        event.put("output_tokens", Math.max(0, outputTokens));
        event.put("latency_saved_ms", cachedInputTokens > 0 ? Math.max(1, latencyMs / 3) : 0);
        event.put("token_saved_estimate", Math.max(0, cachedInputTokens));
        event.put("hit_reason", cachedInputTokens > 0 ? "java_dialogue_provider_cached_tokens" : "");
        event.put("miss_reason", cachedInputTokens > 0 ? "" : "provider_reported_no_cached_tokens");
        recordEvent(event);
    }

    public Map<String, Object> saveSolution(Map<String, Object> solution) {
        return post("/solutions", solution != null ? solution : Map.of());
    }

    @SuppressWarnings("unchecked")
    public List<Map<String, Object>> searchSolutions(
            String query,
            String fingerprint,
            String tenantId,
            int limit
    ) {
        Map<String, Object> body = new HashMap<>();
        body.put("query", safe(query));
        body.put("fingerprint", safe(fingerprint));
        body.put("scene_type", "chat");
        body.put("tenant_id", safe(tenantId));
        body.put("limit", Math.max(1, limit));
        Map<String, Object> response = post("/solutions/search", body);
        Object solutions = response.get("solutions");
        if (solutions instanceof List<?> list) {
            return list.stream()
                    .filter(Map.class::isInstance)
                    .map(item -> (Map<String, Object>) item)
                    .toList();
        }
        return List.of();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> post(String path, Map<String, Object> body) {
        if (!isEnabled()) {
            return Map.of();
        }
        try {
            Object response = client().post()
                    .uri(path)
                    .bodyValue(body)
                    .retrieve()
                    .bodyToMono(Object.class)
                    .block(Duration.ofMillis(Math.max(500, timeoutMs)));
            if (response instanceof Map<?, ?> map) {
                return (Map<String, Object>) map;
            }
            if (response != null) {
                return objectMapper.convertValue(response, Map.class);
            }
        } catch (Exception e) {
            log.debug("[CacheLedger] request skipped: path={}, error={}", path, e.getMessage());
        }
        return Map.of();
    }

    private String normalizeBaseUrl(String raw) {
        String url = raw == null ? "" : raw.trim();
        if (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (!url.endsWith("/api/cache")) {
            url = url + "/api/cache";
        }
        return url;
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }
}
