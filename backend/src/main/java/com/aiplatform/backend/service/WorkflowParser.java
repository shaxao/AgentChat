package com.aiplatform.backend.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

/**
 * 工作流 DSL 解析器（战略改造 v2.0 P2-1）
 * <p>
 * 解析工作流 JSON DSL，提取触发条件（cron）和执行步骤。
 * DSL 格式示例：
 * <pre>
 * {
 *   "trigger": { "type": "cron", "value": "0 8 * * *" },
 *   "steps": [
 *     { "id": "step1", "tool": "some_tool", "args": {}, "description": "第一步" },
 *     { "id": "step2", "condition": "step1.success", "tool": "another_tool", "args": {} }
 *   ]
 * }
 * </pre>
 */
@Slf4j
@Component
public class WorkflowParser {

    private final ObjectMapper objectMapper;
    private static final Set<String> ALLOWED_SIDE_EFFECTS = Set.of(
            "none", "read", "write", "external_call", "notification", "payment");

    public WorkflowParser(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * 解析后的 DSL 结构
     */
    public static class ParsedDsl {
        private String cronExpr;
        private String triggerType;
        private List<ParsedStep> steps;
        /** 数据传递模式: "auto"(默认,自动注入) | "template"(纯模板变量) | "ai"(AI编排) */
        private String dataMode;
        private ParsedAiPolicy aiPolicy;

        public String getCronExpr() { return cronExpr; }
        public void setCronExpr(String cronExpr) { this.cronExpr = cronExpr; }
        public String getTriggerType() { return triggerType; }
        public void setTriggerType(String triggerType) { this.triggerType = triggerType; }
        public List<ParsedStep> getSteps() { return steps; }
        public void setSteps(List<ParsedStep> steps) { this.steps = steps; }
        public String getDataMode() { return dataMode; }
        public void setDataMode(String dataMode) { this.dataMode = dataMode; }
        public ParsedAiPolicy getAiPolicy() { return aiPolicy; }
        public void setAiPolicy(ParsedAiPolicy aiPolicy) { this.aiPolicy = aiPolicy; }
    }

    public static class ParsedAiPolicy {
        private Integer maxTurns;
        private Boolean allowRepeatSteps;
        private Boolean continueOnStepFailure;

        public Integer getMaxTurns() { return maxTurns; }
        public void setMaxTurns(Integer maxTurns) { this.maxTurns = maxTurns; }
        public Boolean getAllowRepeatSteps() { return allowRepeatSteps; }
        public void setAllowRepeatSteps(Boolean allowRepeatSteps) { this.allowRepeatSteps = allowRepeatSteps; }
        public Boolean getContinueOnStepFailure() { return continueOnStepFailure; }
        public void setContinueOnStepFailure(Boolean continueOnStepFailure) { this.continueOnStepFailure = continueOnStepFailure; }
    }

    /**
     * 解析后的步骤
     */
    public static class ParsedStep {
        private String id;
        private String tool;
        private String description;
        private String condition;
        private Map<String, Object> args;
        /** 内联代码（Python/JS），由用户编写或 AI 生成 */
        private String code;
        /** 代码语言：python / javascript */
        private String language;
        /** 自定义工具超时秒数，1-300 秒 */
        private Integer timeoutSeconds;
        /** 自定义工具权限，如 network / filesystem_read / filesystem_write / process */
        private List<String> permissions;
        private Boolean idempotent;
        private String sideEffect;
        /** 输入参数 schema（JSON Schema 子集） */
        private Map<String, Object> inputSchema;
        /** 输出结果 schema（JSON Schema 子集） */
        private Map<String, Object> outputSchema;

        public String getId() { return id; }
        public void setId(String id) { this.id = id; }
        public String getTool() { return tool; }
        public void setTool(String tool) { this.tool = tool; }
        public String getDescription() { return description; }
        public void setDescription(String description) { this.description = description; }
        public String getCondition() { return condition; }
        public void setCondition(String condition) { this.condition = condition; }
        public Map<String, Object> getArgs() { return args; }
        public void setArgs(Map<String, Object> args) { this.args = args; }
        public String getCode() { return code; }
        public void setCode(String code) { this.code = code; }
        public String getLanguage() { return language; }
        public void setLanguage(String language) { this.language = language; }
        public Integer getTimeoutSeconds() { return timeoutSeconds; }
        public void setTimeoutSeconds(Integer timeoutSeconds) { this.timeoutSeconds = timeoutSeconds; }
        public List<String> getPermissions() { return permissions; }
        public void setPermissions(List<String> permissions) { this.permissions = permissions; }
        public Boolean getIdempotent() { return idempotent; }
        public void setIdempotent(Boolean idempotent) { this.idempotent = idempotent; }
        public String getSideEffect() { return sideEffect; }
        public void setSideEffect(String sideEffect) { this.sideEffect = sideEffect; }
        public Map<String, Object> getInputSchema() { return inputSchema; }
        public void setInputSchema(Map<String, Object> inputSchema) { this.inputSchema = inputSchema; }
        public Map<String, Object> getOutputSchema() { return outputSchema; }
        public void setOutputSchema(Map<String, Object> outputSchema) { this.outputSchema = outputSchema; }
    }

    /**
     * 解析 DSL JSON 字符串
     */
    public ParsedDsl parse(String dslJson) {
        if (dslJson == null || dslJson.trim().isEmpty()) {
            throw new IllegalArgumentException("DSL 不能为空");
        }

        try {
            Map<String, Object> dsl = objectMapper.readValue(dslJson,
                    new TypeReference<Map<String, Object>>() {});

            ParsedDsl result = new ParsedDsl();

            // 解析 trigger
            @SuppressWarnings("unchecked")
            Map<String, Object> trigger = (Map<String, Object>) dsl.get("trigger");
            if (trigger != null) {
                result.setTriggerType((String) trigger.get("type"));
                result.setCronExpr((String) trigger.get("value"));
            }

            // 解析 steps
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> stepsRaw = (List<Map<String, Object>>) dsl.get("steps");
            if (stepsRaw != null) {
                List<ParsedStep> steps = new ArrayList<>();
                for (Map<String, Object> s : stepsRaw) {
                    ParsedStep step = new ParsedStep();
                    step.setId((String) s.get("id"));
                    step.setTool((String) s.get("tool"));
                    step.setDescription((String) s.get("description"));
                    step.setCondition((String) s.get("condition"));
                    // ★ 解析内联代码和语言（工作流执行引擎需要这些字段来执行自定义代码步骤）
                    step.setCode((String) s.get("code"));
                    step.setLanguage((String) s.get("language"));
                    Object timeoutRaw = s.get("timeoutSeconds");
                    if (timeoutRaw instanceof Number number) {
                        step.setTimeoutSeconds(number.intValue());
                    } else if (timeoutRaw instanceof String text && !text.isBlank()) {
                        try {
                            step.setTimeoutSeconds(Integer.parseInt(text));
                        } catch (NumberFormatException ignored) {
                            // 保持 null，执行器使用默认超时。
                        }
                    }
                    @SuppressWarnings("unchecked")
                    List<String> permissions = s.get("permissions") instanceof List
                            ? (List<String>) s.get("permissions") : null;
                    step.setPermissions(permissions);
                    Boolean explicitIdempotent = asBoolean(s.get("idempotent"));
                    Object sideEffectRaw = s.get("sideEffect");
                    String sideEffect = normalizeSideEffect(sideEffectRaw, step.getTool(), step.getId());
                    step.setSideEffect(sideEffect);
                    step.setIdempotent(explicitIdempotent != null
                            ? explicitIdempotent
                            : defaultIdempotent(step.getTool(), sideEffect));
                    @SuppressWarnings("unchecked")
                    Map<String, Object> inputSchema = s.get("inputSchema") instanceof Map
                            ? (Map<String, Object>) s.get("inputSchema") : null;
                    step.setInputSchema(inputSchema);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> outputSchema = s.get("outputSchema") instanceof Map
                            ? (Map<String, Object>) s.get("outputSchema") : null;
                    step.setOutputSchema(outputSchema);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> args = (Map<String, Object>) s.get("args");
                    step.setArgs(args != null ? args : new HashMap<>());
                    steps.add(step);
                }
                result.setSteps(steps);
            } else {
                result.setSteps(new ArrayList<>());
            }

            // ★ 解析数据传递模式（默认 auto）
            Object dataModeVal = dsl.get("dataMode");
            result.setDataMode(dataModeVal != null ? dataModeVal.toString() : "auto");

            @SuppressWarnings("unchecked")
            Map<String, Object> aiPolicyRaw = dsl.get("aiPolicy") instanceof Map
                    ? (Map<String, Object>) dsl.get("aiPolicy") : null;
            if (aiPolicyRaw != null) {
                ParsedAiPolicy aiPolicy = new ParsedAiPolicy();
                Object maxTurnsRaw = aiPolicyRaw.get("maxTurns");
                if (maxTurnsRaw instanceof Number number) {
                    aiPolicy.setMaxTurns(number.intValue());
                } else if (maxTurnsRaw instanceof String text && !text.isBlank()) {
                    try {
                        aiPolicy.setMaxTurns(Integer.parseInt(text));
                    } catch (NumberFormatException ignored) {
                        // Keep default in scheduler.
                    }
                }
                aiPolicy.setAllowRepeatSteps(asBoolean(aiPolicyRaw.get("allowRepeatSteps")));
                aiPolicy.setContinueOnStepFailure(asBoolean(aiPolicyRaw.get("continueOnStepFailure")));
                result.setAiPolicy(aiPolicy);
            }

            return result;
        } catch (Exception e) {
            log.error("[WorkflowParser] DSL 解析失败: {}", e.getMessage());
            throw new RuntimeException("DSL 解析失败: " + e.getMessage());
        }
    }

    /**
     * 验证 DSL 是否合法
     */
    public void validate(String dslJson) {
        ParsedDsl parsed = parse(dslJson);

        if (parsed.getSteps() == null || parsed.getSteps().isEmpty()) {
            // 没有步骤的 DSL 也是允许的（仅触发记录）
            log.warn("[WorkflowParser] DSL 没有定义任何步骤");
        }

        if (parsed.getTriggerType() != null && "cron".equals(parsed.getTriggerType())) {
            if (parsed.getCronExpr() == null || parsed.getCronExpr().trim().isEmpty()) {
                throw new RuntimeException("cron 触发器缺少 cron 表达式");
            }
            // 简单验证 cron 格式（至少 5 个字段）
            String[] parts = parsed.getCronExpr().trim().split("\\s+");
            if (parts.length < 5) {
                throw new RuntimeException("无效的 cron 表达式: " + parsed.getCronExpr());
            }
        }
    }

    private String normalizeSideEffect(Object raw, String tool, String stepId) {
        String value = raw != null ? raw.toString().trim().toLowerCase(Locale.ROOT) : "";
        if (value.isBlank()) {
            return defaultSideEffect(tool);
        }
        if (!ALLOWED_SIDE_EFFECTS.contains(value)) {
            throw new IllegalArgumentException("Invalid sideEffect for step "
                    + (stepId != null ? stepId : "<unknown>") + ": " + value
                    + ". Allowed values: " + ALLOWED_SIDE_EFFECTS);
        }
        return value;
    }

    private String defaultSideEffect(String tool) {
        if (tool == null || tool.isBlank()) {
            return "external_call";
        }
        return switch (tool) {
            case UnifiedToolService.TOOL_AI_CHAT -> "none";
            case UnifiedToolService.TOOL_WEB_SEARCH, UnifiedToolService.TOOL_FILE_UPLOAD -> "read";
            case UnifiedToolService.TOOL_IMAGE_RECOGNITION,
                    UnifiedToolService.TOOL_AUDIO_TRANSCRIBE,
                    UnifiedToolService.TOOL_DOCUMENT_CHUNK_PROCESS -> "write";
            case UnifiedToolService.TOOL_AGENT_CALL -> "external_call";
            default -> inferSideEffectFromToolName(tool);
        };
    }

    private String inferSideEffectFromToolName(String tool) {
        String name = tool.toLowerCase(Locale.ROOT);
        if (name.contains("payment") || name.contains("pay") || name.contains("refund")) {
            return "payment";
        }
        if (name.contains("notify") || name.contains("notification") || name.contains("sms")
                || name.contains("email") || name.contains("message")) {
            return "notification";
        }
        if (name.contains("save") || name.contains("update") || name.contains("delete")
                || name.contains("create") || name.contains("write")) {
            return "write";
        }
        if (name.contains("search") || name.contains("read") || name.contains("list")
                || name.contains("get") || name.contains("query")) {
            return "read";
        }
        return "external_call";
    }

    private Boolean defaultIdempotent(String tool, String sideEffect) {
        if ("none".equals(sideEffect) || "read".equals(sideEffect)) {
            return true;
        }
        if (UnifiedToolService.TOOL_AI_CHAT.equals(tool) || UnifiedToolService.TOOL_WEB_SEARCH.equals(tool)
                || UnifiedToolService.TOOL_FILE_UPLOAD.equals(tool)) {
            return true;
        }
        return false;
    }

    private Boolean asBoolean(Object value) {
        if (value instanceof Boolean bool) {
            return bool;
        }
        if (value instanceof String text && !text.isBlank()) {
            return Boolean.parseBoolean(text);
        }
        return null;
    }
}
