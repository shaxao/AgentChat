package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class HarnessReplayToolSandboxService {

    private static final int MAX_REPLAY_OUTPUT_CHARS = 20_000;

    private final ToolResultStorageService toolResultStorageService;
    private final MemoryService memoryService;
    private final UploadedFileReadService uploadedFileReadService;
    private final ChatConversationMapper conversationMapper;
    private final ObjectMapper objectMapper;

    /**
     * Replays the tool calls found in a trace's event stream.
     * <p>
     * Two classes of tools are handled differently:
     * <ul>
     *   <li>Read-only allowlisted tools are truly re-executed against live read-only services.</li>
     *   <li>Side-effect tools are never executed. Instead their recorded {@code tool_result}
     *       outcome from the historical trace is inspected (recorded-outcome replay), so we can
     *       assert the outcome was structured and observable without writing chat, charging the
     *       wallet, or sending anything.</li>
     * </ul>
     */
    public ReplayToolReport replayReadOnlyTools(Map<String, Object> replayCase, List<Map<String, Object>> events) {
        List<Map<String, Object>> toolCalls = extractToolCalls(events);
        if (toolCalls.isEmpty()) {
            return new ReplayToolReport("passed", true, 0, 0, 0,
                    List.of(), "No tool calls to replay.");
        }

        List<Map<String, Object>> results = new ArrayList<>();
        int passed = 0;
        int failed = 0;
        int blocked = 0;
        for (Map<String, Object> call : toolCalls) {
            Map<String, Object> result = replayOne(replayCase, call, events);
            results.add(result);
            String status = String.valueOf(result.getOrDefault("status", "blocked"));
            if ("passed".equals(status)) passed++;
            else if ("failed".equals(status)) failed++;
            else blocked++;
        }

        String status = failed > 0 ? "failed" : (blocked > 0 ? "blocked" : "passed");
        return new ReplayToolReport(status, "passed".equals(status), passed, failed, blocked, results,
                "Replayed read-only tools live and side-effect tools from recorded outcomes.");
    }

    private Map<String, Object> replayOne(Map<String, Object> replayCase, Map<String, Object> call,
                                          List<Map<String, Object>> events) {
        String toolName = stringValue(call.get("toolName"));
        String toolCallId = stringValue(call.get("toolCallId"));
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("toolName", toolName);
        result.put("toolCallId", toolCallId);
        result.put("sideEffects", false);

        if (toolName == null || toolName.isBlank()) {
            return finish(result, "blocked", "TOOL_NAME_MISSING", "Tool name is missing from trace evidence.", null);
        }

        String argumentsJson = stringValue(call.get("argumentsJson"));
        boolean truncated = Boolean.TRUE.equals(call.get("argumentsTruncated"));
        if (isSideEffectTool(toolName)) {
            return simulateSideEffect(result, call, events, argumentsJson, truncated);
        }
        if (!isReadOnlyTool(toolName)) {
            return finish(result, "blocked", "TOOL_NOT_ALLOWLISTED",
                    "Replay sandbox only executes allowlisted read-only tools.", null);
        }

        if (truncated) {
            return finish(result, "blocked", "TOOL_ARGUMENTS_TRUNCATED",
                    "Tool arguments were truncated in trace evidence and cannot be safely replayed.", null);
        }
        if (argumentsJson == null || argumentsJson.isBlank()) {
            return finish(result, "blocked", "TOOL_ARGUMENTS_MISSING",
                    "Tool arguments are missing from trace evidence.", null);
        }

        try {
            String output = switch (toolName) {
                case "read_stored_result" -> replayReadStoredResult(argumentsJson);
                case "memory_read_document" -> replayMemoryRead(replayCase, argumentsJson);
                case "memory_search_documents" -> replayMemorySearch(replayCase, argumentsJson);
                case "read_uploaded_file" -> replayReadUploadedFile(replayCase, argumentsJson);
                default -> null;
            };
            return finish(result, "passed", "OK", "Tool replay completed.", output);
        } catch (Exception e) {
            log.debug("[HarnessReplay] tool replay failed: tool={}, error={}", toolName, e.getMessage());
            return finish(result, "failed", "TOOL_REPLAY_FAILED", e.getMessage(), null);
        }
    }

    private Map<String, Object> simulateSideEffect(Map<String, Object> result,
                                                   Map<String, Object> call,
                                                   List<Map<String, Object>> events,
                                                   String argumentsJson,
                                                   boolean truncated) {
        result.put("executed", false);
        result.put("mode", "simulated_recorded_outcome");
        if (truncated) {
            return finish(result, "blocked", "SIDE_EFFECT_ARGUMENTS_TRUNCATED",
                    "Side-effect arguments were truncated, so a reliable simulation cannot be built.", null);
        }
        if (argumentsJson == null || argumentsJson.isBlank()) {
            return finish(result, "blocked", "SIDE_EFFECT_ARGUMENTS_MISSING",
                    "Side-effect arguments are missing from trace evidence.", null);
        }

        JsonNode arguments;
        try {
            arguments = objectMapper.readTree(argumentsJson);
        } catch (Exception e) {
            return finish(result, "failed", "SIDE_EFFECT_ARGUMENTS_INVALID_JSON",
                    "Side-effect arguments are not valid JSON: " + e.getMessage(), null);
        }
        if (arguments == null || !arguments.isObject()) {
            return finish(result, "failed", "SIDE_EFFECT_ARGUMENTS_INVALID",
                    "Side-effect arguments must be a JSON object.", null);
        }

        String toolName = stringValue(call.get("toolName"));
        String validationError = validateSideEffectArguments(toolName, arguments);
        if (validationError != null) {
            return finish(result, "failed", "SIDE_EFFECT_ARGUMENTS_INVALID", validationError, null);
        }

        List<String> argumentKeys = new ArrayList<>();
        arguments.fieldNames().forEachRemaining(argumentKeys::add);
        Map<String, Object> simulation = new LinkedHashMap<>();
        simulation.put("operation", inferSideEffectType(toolName));
        simulation.put("toolName", toolName);
        simulation.put("argumentKeys", argumentKeys);
        simulation.put("target", sideEffectTarget(arguments));
        simulation.put("wouldExecute", true);
        simulation.put("executed", false);
        result.put("simulation", simulation);
        return replaySideEffectFromRecordedOutcome(result, call, events);
    }

    private String validateSideEffectArguments(String toolName, JsonNode arguments) {
        if ("memory_save_document".equals(toolName)) {
            if (!hasText(arguments, "title")) return "memory_save_document requires a non-empty title.";
            if (!hasText(arguments, "content")) return "memory_save_document requires non-empty content.";
        }
        return null;
    }

    private boolean hasText(JsonNode node, String field) {
        return node.has(field) && !node.get(field).isNull() && !node.get(field).asText("").isBlank();
    }

    private String inferSideEffectType(String toolName) {
        String name = toolName != null ? toolName.toLowerCase() : "";
        if (name.contains("delete")) return "delete";
        if (name.contains("send")) return "send";
        if (name.contains("update")) return "update";
        if (name.contains("create")) return "create";
        return "write";
    }

    private String sideEffectTarget(JsonNode arguments) {
        for (String field : List.of("title", "fileName", "id", "documentId", "conversationUuid", "recipient")) {
            if (hasText(arguments, field)) {
                return field + ":" + truncate(arguments.get(field).asText(), 160);
            }
        }
        return "unspecified";
    }
    /**
     * Recorded-outcome replay for side-effect tools. The tool is never executed. We locate the
     * {@code tool_result} event that the historical trace recorded for this call and assert the
     * outcome was structured and observable:
     * <ul>
     *   <li>No recorded outcome at all &rarr; blocked (cannot judge a side-effect tool safely).</li>
     *   <li>Recorded success &rarr; passed.</li>
     *   <li>Recorded error with a readable failure code / message / detail &rarr; passed
     *       (the failure was correctly captured, which is the harness goal).</li>
     *   <li>Recorded error that is only a generic "exception"/"error" &rarr; failed.</li>
     * </ul>
     */
    private Map<String, Object> replaySideEffectFromRecordedOutcome(Map<String, Object> result,
                                                                    Map<String, Object> call,
                                                                    List<Map<String, Object>> events) {
        result.put("executed", false);
        result.putIfAbsent("mode", "recorded_outcome");

        Map<String, Object> outcome = findRecordedToolResult(events, stringValue(call.get("toolCallId")),
                stringValue(call.get("toolName")));
        if (outcome == null) {
            return finish(result, "blocked", "SIDE_EFFECT_OUTCOME_MISSING",
                    "No recorded tool_result outcome for this side-effect tool; cannot replay safely.", null);
        }

        String status = stringValue(outcome.get("status"));
        if ("error".equalsIgnoreCase(status)) {
            String combined = String.join(" ",
                    blankTo(stringValue(outcome.get("failureType")), ""),
                    blankTo(stringValue(outcome.get("errorCode")), ""),
                    blankTo(stringValue(outcome.get("message")), ""),
                    blankTo(stringValue(outcome.get("detail")), ""));
            if (notGenericException(combined)) {
                return finish(result, "passed", "SIDE_EFFECT_OUTCOME_STRUCTURED_ERROR",
                        "Recorded side-effect failure was structured and observable.", combined.trim());
            }
            return finish(result, "failed", "SIDE_EFFECT_OUTCOME_UNSTRUCTURED",
                    "Recorded side-effect failure only carries a generic exception without a readable code or message.", null);
        }

        return finish(result, "passed", "SIDE_EFFECT_OUTCOME_RECORDED",
                "Recorded side-effect outcome was completed and observable.", status);
    }

    private Map<String, Object> findRecordedToolResult(List<Map<String, Object>> events, String toolCallId, String toolName) {
        if (events == null || events.isEmpty()) return null;
        Map<String, Object> nameMatch = null;
        for (Map<String, Object> event : events) {
            String name = stringValue(event.get("name"));
            if (name == null) name = stringValue(event.get("eventName"));
            if (!"tool_result".equals(name)) continue;
            Map<String, Object> payload = mapValue(event.get("payload"));
            String eventCallId = firstString(event.get("toolCallId"), payload.get("toolCallId"));
            String eventToolName = firstString(event.get("toolName"), payload.get("toolName"));
            Map<String, Object> outcome = new LinkedHashMap<>();
            outcome.put("status", firstString(event.get("status"), payload.get("status")));
            outcome.put("failureType", firstString(event.get("failureType"), payload.get("failureType")));
            outcome.put("errorCode", firstString(event.get("errorCode"), payload.get("errorCode")));
            outcome.put("message", firstString(event.get("message"), payload.get("message")));
            outcome.put("detail", firstString(event.get("detail"), payload.get("detail")));
            if (toolCallId != null && !toolCallId.isBlank() && toolCallId.equals(eventCallId)) {
                return outcome;
            }
            if (nameMatch == null && toolName != null && !toolName.isBlank() && toolName.equals(eventToolName)) {
                nameMatch = outcome;
            }
        }
        return nameMatch;
    }

    /**
     * Local copy of the "not a bare generic exception" heuristic used by the harness evolution
     * service, kept private here to avoid a cross-service dependency.
     */
    private boolean notGenericException(String text) {
        String value = text != null ? text.trim() : "";
        if (value.isBlank()) return false;
        String normalized = value.toLowerCase();
        return normalized.length() > 8
                && !List.of("异常", "錯誤", "错误", "error", "exception", "failed", "失败")
                .contains(normalized);
    }

    private String blankTo(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private String replayReadStoredResult(String argumentsJson) throws Exception {
        JsonNode args = objectMapper.readTree(argumentsJson);
        String storedKey = args.has("storedKey") ? args.get("storedKey").asText() : null;
        if (storedKey == null || storedKey.isBlank()) {
            throw new IllegalArgumentException("storedKey is required");
        }
        long offset = args.has("offset") ? args.get("offset").asLong() : 0L;
        int limit = args.has("limit") ? Math.min(args.get("limit").asInt(), 10_000) : 2_000;
        return truncate(toolResultStorageService.readStoredResultRange(storedKey, offset, limit));
    }

    private String replayMemoryRead(Map<String, Object> replayCase, String argumentsJson) throws Exception {
        JsonNode args = objectMapper.readTree(argumentsJson);
        String title = args.has("title") ? args.get("title").asText() : null;
        if (title == null || title.isBlank()) {
            throw new IllegalArgumentException("title is required");
        }
        Long userId = longValue(replayCase.get("userId"));
        Long conversationId = resolveConversationId(replayCase);
        if (userId == null || conversationId == null) {
            throw new IllegalArgumentException("userId and conversationId are required for memory replay");
        }
        MemoryDTO.DocumentVO doc = memoryService.getDocumentByTitle(userId, conversationId, title);
        return truncate(doc != null && doc.getContent() != null ? doc.getContent() : "");
    }

    private String replayMemorySearch(Map<String, Object> replayCase, String argumentsJson) throws Exception {
        JsonNode args = objectMapper.readTree(argumentsJson);
        String query = args.has("query") ? args.get("query").asText() : null;
        if (query == null || query.isBlank()) {
            throw new IllegalArgumentException("query is required");
        }
        Long userId = longValue(replayCase.get("userId"));
        Long conversationId = resolveConversationId(replayCase);
        if (userId == null) {
            throw new IllegalArgumentException("userId is required for memory replay");
        }
        List<MemoryDTO.DocumentVO> docs = memoryService.searchDocuments(userId, conversationId, query);
        List<Map<String, Object>> compact = docs == null ? List.of() : docs.stream()
                .limit(20)
                .map(doc -> {
                    Map<String, Object> row = new LinkedHashMap<>();
                    row.put("title", doc.getTitle());
                    row.put("contentPreview", truncate(doc.getContent(), 500));
                    return row;
                })
                .toList();
        return truncate(objectMapper.writeValueAsString(compact));
    }

    private String replayReadUploadedFile(Map<String, Object> replayCase, String argumentsJson) throws Exception {
        JsonNode args = objectMapper.readTree(argumentsJson);
        String fileName = args.has("fileName") ? args.get("fileName").asText() : null;
        if (fileName == null || fileName.isBlank()) {
            throw new IllegalArgumentException("fileName is required");
        }
        Long userId = longValue(replayCase.get("userId"));
        Long conversationId = longValue(replayCase.get("conversationId"));
        String conversationUuid = stringValue(replayCase.get("conversationUuid"));
        if (userId == null) {
            throw new IllegalArgumentException("userId is required for uploaded file replay");
        }
        UploadedFileReadService.ReadResult read = uploadedFileReadService.readByName(
                userId, conversationUuid, conversationId, fileName, stringList(replayCase.get("fileUrls")));
        if (!read.success()) {
            throw new IllegalStateException(read.code() + ": " + read.output());
        }
        return truncate(read.output());
    }

    private Long resolveConversationId(Map<String, Object> replayCase) {
        Long direct = longValue(replayCase.get("conversationId"));
        if (direct != null) return direct;
        String uuid = stringValue(replayCase.get("conversationUuid"));
        if (uuid == null || uuid.isBlank()) return null;
        ChatConversation conv = conversationMapper.selectOne(new LambdaQueryWrapper<ChatConversation>()
                .eq(ChatConversation::getUuid, uuid)
                .eq(ChatConversation::getDeleted, 0)
                .orderByDesc(ChatConversation::getId)
                .last("LIMIT 1"));
        return conv != null ? conv.getId() : null;
    }

    private List<Map<String, Object>> extractToolCalls(List<Map<String, Object>> events) {
        if (events == null || events.isEmpty()) return List.of();
        List<Map<String, Object>> calls = new ArrayList<>();
        for (Map<String, Object> event : events) {
            String name = stringValue(event.get("name"));
            if (name == null) name = stringValue(event.get("eventName"));
            if (!"tool_call".equals(name)) continue;
            Map<String, Object> payload = mapValue(event.get("payload"));
            Map<String, Object> call = new LinkedHashMap<>();
            call.put("toolName", firstString(event.get("toolName"), payload.get("toolName")));
            call.put("toolCallId", firstString(event.get("toolCallId"), payload.get("toolCallId")));
            call.put("argumentsJson", firstString(event.get("argumentsJson"), payload.get("argumentsJson"),
                    payload.get("arguments"), payload.get("args")));
            call.put("argumentsTruncated", Boolean.TRUE.equals(payload.get("argumentsTruncated"))
                    || Boolean.TRUE.equals(event.get("argumentsTruncated")));
            calls.add(call);
        }
        return calls;
    }

    private boolean isReadOnlyTool(String toolName) {
        return "read_stored_result".equals(toolName)
                || "memory_read_document".equals(toolName)
                || "memory_search_documents".equals(toolName)
                || "read_uploaded_file".equals(toolName);
    }

    private boolean isSideEffectTool(String toolName) {
        String name = toolName != null ? toolName.toLowerCase() : "";
        return name.contains("save")
                || name.contains("write")
                || name.contains("delete")
                || name.contains("update")
                || name.contains("create")
                || name.contains("send")
                || "memory_save_document".equals(toolName);
    }

    private Map<String, Object> finish(Map<String, Object> result, String status, String code, String message, String output) {
        result.put("status", status);
        result.put("code", code);
        result.put("message", message);
        if (output != null) {
            result.put("outputPreview", truncate(output));
            result.put("outputChars", output.length());
        }
        return result;
    }

    private Map<String, Object> mapValue(Object value) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (value instanceof Map<?, ?> map) {
            map.forEach((key, val) -> {
                if (key != null) result.put(String.valueOf(key), val);
            });
        }
        return result;
    }

    private List<String> stringList(Object value) {
        if (!(value instanceof List<?> list)) return List.of();
        return list.stream().map(this::stringValue).filter(item -> item != null && !item.isBlank()).toList();
    }

    private String firstString(Object... values) {
        for (Object value : values) {
            String text = stringValue(value);
            if (text != null && !text.isBlank()) return text;
        }
        return null;
    }

    private String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private Long longValue(Object value) {
        if (value == null) return null;
        if (value instanceof Number number) return number.longValue();
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (Exception e) {
            return null;
        }
    }

    private String truncate(String text) {
        return truncate(text, MAX_REPLAY_OUTPUT_CHARS);
    }

    private String truncate(String text, int max) {
        if (text == null) return "";
        return text.length() <= max ? text : text.substring(0, max) + "...";
    }

    public record ReplayToolReport(
            String status,
            boolean passed,
            int passedCount,
            int failedCount,
            int blockedCount,
            List<Map<String, Object>> results,
            String summary
    ) {}
}
