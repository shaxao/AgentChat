package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.HarnessTrace;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class ChatAgentRuntimeService {

    private final HarnessEvolutionService harnessEvolutionService;
    private final ObjectMapper objectMapper;

    public Map<String, Object> statusPayload(Long traceId, String status, Integer turnIndex,
                                             String message, String model, String agentId) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("runId", traceId != null ? String.valueOf(traceId) : "");
        data.put("status", status);
        data.put("message", message);
        data.put("turnIndex", turnIndex);
        data.put("model", model);
        data.put("agentId", agentId);
        data.put("harnessVersion", traceHarnessVersion(traceId));
        return data;
    }

    public Map<String, Object> warningPayload(Long traceId, String code, String message, Map<String, Object> detail) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("runId", traceId != null ? String.valueOf(traceId) : "");
        data.put("code", blankTo(code, "agent_warning"));
        data.put("message", blankTo(message, "Agent warning"));
        data.put("detail", detail != null ? detail : Map.of());
        return data;
    }

    public ToolFailure classifyToolResult(String toolName, String toolCallId, String result) {
        String text = result != null ? result.trim() : "";
        if (text.isBlank()) {
            return new ToolFailure(true, "tool_empty_result", "TOOL_EMPTY_RESULT",
                    "Tool returned an empty result.", baseDetail(toolName, toolCallId, result));
        }

        Map<String, Object> detail = baseDetail(toolName, toolCallId, result);
        JsonNode json = parseJson(text);
        if (json != null) {
            String errorCode = firstText(json, "errorCode", "code", "error_code", "type");
            String errorMessage = firstText(json, "message", "error", "errorMsg", "error_message", "detail");
            if (json.has("error") || json.has("errorCode") || json.has("errorMsg") || errorCode != null) {
                detail.put("rawErrorCode", blankTo(errorCode, "TOOL_ERROR"));
                detail.put("rawMessage", truncate(blankTo(errorMessage, "Tool returned an error object."), 500));
                return new ToolFailure(true, "tool_error", normalizeErrorCode(errorCode),
                        truncate(blankTo(errorMessage, "Tool returned an error object."), 500), detail);
            }
        }

        String lower = text.toLowerCase(Locale.ROOT);
        if (lower.contains("timeout") || lower.contains("timed out")) {
            return new ToolFailure(true, "tool_timeout", "TOOL_TIMEOUT",
                    "Tool execution timed out.", detail);
        }
        if (lower.contains("exception") || lower.contains("traceback")) {
            return new ToolFailure(true, "tool_exception", "TOOL_EXCEPTION",
                    readableMessage(text, "Tool execution raised an exception."), detail);
        }
        if (lower.contains("error:") || lower.contains("\"error\"") || lower.contains("failed")
                || lower.contains("失败") || lower.contains("异常")) {
            return new ToolFailure(true, "tool_error", "TOOL_ERROR",
                    readableMessage(text, "Tool returned an error result."), detail);
        }

        return new ToolFailure(false, "", "", "", detail);
    }

    private String traceHarnessVersion(Long traceId) {
        if (traceId == null) return null;
        try {
            HarnessTrace trace = harnessEvolutionService.getTrace(traceId);
            return trace != null ? trace.getHarnessVersion() : null;
        } catch (Exception e) {
            return null;
        }
    }

    private Map<String, Object> baseDetail(String toolName, String toolCallId, String result) {
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("toolName", blankTo(toolName, ""));
        detail.put("toolCallId", blankTo(toolCallId, ""));
        detail.put("outputChars", result != null ? result.length() : 0);
        if (result != null && !result.isBlank()) {
            detail.put("preview", truncate(result, 500));
        }
        return detail;
    }

    private JsonNode parseJson(String text) {
        try {
            JsonNode node = objectMapper.readTree(text);
            return node != null && node.isObject() ? node : null;
        } catch (Exception e) {
            return null;
        }
    }

    private String firstText(JsonNode node, String... keys) {
        if (node == null) return null;
        for (String key : keys) {
            JsonNode value = node.get(key);
            if (value == null || value.isNull()) continue;
            String text = value.isTextual() ? value.asText() : value.toString();
            if (text != null && !text.isBlank()) return text;
        }
        return null;
    }

    private String normalizeErrorCode(String code) {
        if (code == null || code.isBlank()) return "TOOL_ERROR";
        return code.trim()
                .replaceAll("[^A-Za-z0-9_\\-]+", "_")
                .toUpperCase(Locale.ROOT);
    }

    private String readableMessage(String text, String fallback) {
        String preview = truncate(text, 500);
        if (preview == null || preview.isBlank()) return fallback;
        return preview;
    }

    private String truncate(String text, int max) {
        if (text == null) return null;
        return text.length() <= max ? text : text.substring(0, max) + "...";
    }

    private String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    public record ToolFailure(
            boolean failed,
            String failureType,
            String errorCode,
            String message,
            Map<String, Object> detail
    ) {}
}
