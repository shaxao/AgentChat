package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.CodeExecutionService;
import com.aiplatform.backend.service.UnifiedToolService;
import com.aiplatform.backend.service.UsageTrackingService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * 工具测试 & 代码生成控制器
 * <p>
 * 提供独立于工作流执行的工具测试 API + AI 代码生成 + 内联代码测试
 */
@Slf4j
@RestController
@RequestMapping("/api/tools")
@RequiredArgsConstructor
public class ToolTestController {

    private final UnifiedToolService unifiedToolService;
    private final AiService aiService;
    private final UsageTrackingService usageTrackingService;
    private final CodeExecutionService codeExecutionService;
    private final ObjectMapper objectMapper;

    /**
     * 测试单个工具 — 发送参数并获得结构化结果
     */
    @PostMapping("/test")
    public Result<Map<String, Object>> testTool(@RequestBody Map<String, Object> body) {
        String toolName = (String) body.get("toolName");
        @SuppressWarnings("unchecked")
        Map<String, Object> args = (Map<String, Object>) body.getOrDefault("args", Map.of());

        if (toolName == null || toolName.trim().isEmpty()) {
            return Result.fail("toolName 不能为空");
        }

        try {
            Map<String, Object> result = unifiedToolService.testTool(toolName, args);
            return Result.ok(result);
        } catch (Exception e) {
            log.error("[ToolTest] 测试工具 {} 失败: {}", toolName, e.getMessage(), e);
            return Result.fail("工具测试异常: " + e.getMessage());
        }
    }

    /**
     * 列出所有可用工具
     */
    @GetMapping("/list")
    public Result<List<String>> listTools() {
        return Result.ok(unifiedToolService.listTools());
    }

    /**
     * 检查工具是否存在
     */
    @GetMapping("/exists")
    public Result<Map<String, Object>> toolExists(@RequestParam String toolName) {
        boolean exists = unifiedToolService.hasTool(toolName);
        return Result.ok(Map.of("toolName", toolName, "exists", exists));
    }

    // ==================== AI 生成工具代码（SSE 流式） ====================

    /**
     * AI 生成/微调工具代码 — SSE 流式输出
     *
     * <pre>
     * POST /api/tools/generate-code
     * 首次生成:
     * { "toolName": "check_email", "description": "验证邮箱", "language": "python" }
     *
     * 微调已有代码:
     * { "toolName": "check_email", "description": "验证邮箱", "language": "python",
     *   "existingCode": "def main(args): ...", "refineInstruction": "增加域名黑名单校验" }
     * </pre>
     *
     * SSE 事件:
     * - event: token, data: {"message":"..."}  — 逐 token 输出代码
     * - event: done, data: {"code":"...", "status":"success"}  — 完成
     * - event: error, data: {"message":"..."}  — 出错
     */
    @PostMapping(value = "/generate-code", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter generateCode(@RequestBody Map<String, Object> body,
                                    @RequestAttribute(required = false) Long userId) {
        String toolName = (String) body.getOrDefault("toolName", "workflow_tool");
        String description = (String) body.getOrDefault("description", "");
        String language = (String) body.getOrDefault("language", "python");
        String existingCode = (String) body.get("existingCode");
        String refineInstruction = (String) body.get("refineInstruction");

        SseEmitter emitter = new SseEmitter(120_000L);

        boolean isRefinement = existingCode != null && !existingCode.trim().isEmpty()
                && refineInstruction != null && !refineInstruction.trim().isEmpty();

        if (!isRefinement && description.isEmpty()) {
            safeSendError(emitter, "工具描述不能为空");
            return emitter;
        }

        log.info("[ToolCodeGen] AI {} {} 代码: {} (语言={})",
                isRefinement ? "微调" : "生成", language, toolName, language);

        new Thread(() -> {
            try {
                String systemPrompt = buildCodeGenerationPrompt(language);
                String userPrompt;
                if (isRefinement) {
                    userPrompt = String.format(
                        "现有代码如下（%s语言）：\n```%s\n%s\n```\n\n"
                        + "请根据以下要求修改这段代码：\n%s\n\n"
                        + "只输出修改后的完整代码，不要包含任何解释或 markdown 标记。",
                        language, language, existingCode, refineInstruction);
                } else {
                    userPrompt = String.format(
                        "请为以下工具生成代码：\n工具名称：%s\n功能描述：%s\n语言：%s\n\n只输出代码，不要包含任何解释或 markdown 标记。",
                        toolName, description, language);
                }

                AiService.AiResult result = aiService.chat(
                        "auto",
                        systemPrompt,
                        null,
                        userPrompt,
                        0.3,
                    4096);

                if (result != null && result.content() != null) {
                    String code = ensureExecutableToolCode(
                            extractCode(result.content(), language),
                            language,
                            toolName,
                            description);

                    // ★ 计费追踪 — AI 代码生成
                    if (userId != null) {
                        try {
                            usageTrackingService.trackFull(userId,
                                    result.model() != null ? result.model() : "auto",
                                    result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                                    result.latencyMs(), "tool_code_gen", null);
                        } catch (Exception ex) {
                            log.warn("[ToolTest] 计费追踪失败: {}", ex.getMessage());
                        }
                    }

                    // 流式发送 token
                    emitter.send(SseEmitter.event()
                            .name("token")
                            .data("{\"message\":" + objectMapper.writeValueAsString(code) + "}"));
                    // 完成
                    emitter.send(SseEmitter.event()
                            .name("done")
                            .data("{\"code\":" + objectMapper.writeValueAsString(code)
                                    + ",\"status\":\"success\"}"));
                } else {
                    safeSendError(emitter, "AI 未返回有效内容");
                }
                emitter.complete();
            } catch (Exception e) {
                log.error("[ToolCodeGen] 生成失败: {}", e.getMessage(), e);
                safeSendError(emitter, "代码生成失败: " + e.getMessage());
            }
        }).start();

        return emitter;
    }

    // ==================== 测试内联代码 ====================

    /**
     * 测试内联工具代码 — 在沙箱中执行并返回结果
     *
     * <pre>
     * POST /api/tools/test-code
     * {
     *   "code": "def main(args):\n    return {'valid': '@' in args.get('email','')}",
     *   "language": "python",
     *   "input": { "email": "test@example.com" }
     * }
     * </pre>
     *
     * @return { success, output, error?, elapsedMs }
     */
    @PostMapping("/test-code")
    public Result<Map<String, Object>> testCode(@RequestBody Map<String, Object> body) {
        String code = (String) body.get("code");
        String language = (String) body.getOrDefault("language", "python");
        Integer timeoutSeconds = null;
        Object timeoutRaw = body.get("timeoutSeconds");
        if (timeoutRaw instanceof Number number) {
            timeoutSeconds = number.intValue();
        } else if (timeoutRaw instanceof String text && !text.isBlank()) {
            try {
                timeoutSeconds = Integer.parseInt(text);
            } catch (NumberFormatException ignored) {
                timeoutSeconds = null;
            }
        }
        @SuppressWarnings("unchecked")
        List<String> permissions = body.get("permissions") instanceof List
                ? ((List<?>) body.get("permissions")).stream()
                    .filter(java.util.Objects::nonNull)
                    .map(String::valueOf)
                    .toList()
                : null;
        @SuppressWarnings("unchecked")
        Map<String, Object> input = (Map<String, Object>) body.getOrDefault("input", Map.of());

        if (code == null || code.trim().isEmpty()) {
            return Result.fail("代码不能为空");
        }

        long startMs = System.currentTimeMillis();
        try {
            Map<String, Object> result = codeExecutionService.executeCode(code, language, input, timeoutSeconds, permissions);
            result.put("elapsedMs", System.currentTimeMillis() - startMs);
            return Result.ok(result);
        } catch (Exception e) {
            log.error("[ToolCodeTest] 执行失败: {}", e.getMessage());
            Map<String, Object> errResult = new java.util.HashMap<>();
            errResult.put("success", false);
            errResult.put("error", e.getMessage());
            errResult.put("elapsedMs", System.currentTimeMillis() - startMs);
            return Result.ok(errResult); // 用 ok 包装错误结果，让前端判断 success 字段
        }
    }

    // ==================== 私有方法 ====================

    private String buildCodeGenerationPrompt(String language) {
        if (language.equalsIgnoreCase("javascript") || language.equalsIgnoreCase("js")) {
            return String.format(
                "你是一个专业的%s代码生成器。你的任务是：\n" +
                "1. 根据工具的功能描述，生成一个可直接运行的完整脚本\n" +
                "2. 定义一个 main(args) 函数，args 是一个对象，包含输入参数\n" +
                "3. 函数必须返回一个对象作为执行结果\n" +
                "4. 代码要健壮，有参数校验和错误处理\n" +
                "5. 脚本末尾必须有入口块：从 stdin 读取 JSON（格式 {tool_name, arguments}），调用 main(arguments)，将结果用 JSON.stringify 输出到 stdout\n" +
                "6. 只输出纯代码，不要包含任何解释、markdown 或代码块标记\n" +
                "7. 使用 CommonJS 规范（require）或 Node.js 内置模块",
                language);
        } else {
            return String.format(
                "你是一个专业的%s代码生成器。你的任务是：\n" +
                "1. 根据工具的功能描述，生成一个可直接运行的完整 Python 脚本\n" +
                "2. 定义一个 main(args) 函数，args 是一个字典，包含输入参数\n" +
                "3. 函数必须返回一个字典作为执行结果\n" +
                "4. 代码要健壮，有参数校验和错误处理\n" +
                "5. 脚本末尾必须有入口块：从 stdin 读取 JSON（格式 {\"tool_name\": \"...\", \"arguments\": {...}}），调用 main(arguments)，将结果用 json.dumps 输出到 stdout\n" +
                "6. 只输出纯代码，不要包含任何解释、markdown 或代码块标记\n" +
                "7. 使用 Python 3 语法，可以 import 标准库（os, json, re, sys, requests 等）\n" +
                "8. 入口块模板：\n" +
                "   if __name__ == \"__main__\":\n" +
                "       import sys, json\n" +
                "       input_data = json.loads(sys.stdin.read())\n" +
                "       tool_name = input_data.get(\"tool_name\", \"\")\n" +
                "       arguments = input_data.get(\"arguments\", {})\n" +
                "       result = main(arguments)\n" +
                "       print(json.dumps(result, ensure_ascii=False))",
                language);
        }
    }

    /**
     * 从 AI 回复中提取纯代码（去除 markdown 代码块标记和解释文字）
     */
    private String extractCode(String raw, String language) {
        // 尝试匹配 ```python 或 ``` 代码块
        String marker = "```" + language.toLowerCase();
        int start = raw.indexOf(marker);
        if (start == -1) start = raw.indexOf("```");
        if (start >= 0) {
            start = raw.indexOf('\n', start) + 1;
            int end = raw.indexOf("```", start);
            if (end > start) return raw.substring(start, end).trim();
        }
        return raw.trim();
    }

    private String ensureExecutableToolCode(String code, String language, String toolName, String description) {
        if (!"python".equalsIgnoreCase(language)) {
            return code != null ? code.trim() : "";
        }
        String trimmed = code != null ? code.trim() : "";
        String entrypoint = "\n\nif __name__ == \"__main__\":\n"
                + "    import sys, json\n"
                + "    input_data = json.loads(sys.stdin.read() or \"{}\")\n"
                + "    arguments = input_data.get(\"arguments\", {})\n"
                + "    result = main(arguments)\n"
                + "    print(json.dumps(result, ensure_ascii=False))";

        boolean hasMain = java.util.regex.Pattern
                .compile("(?s).*def\\s+main\\s*\\(\\s*args\\s*\\).*")
                .matcher(trimmed)
                .matches();
        if (!hasMain) {
            String safeName = pythonStringLiteral(toolName != null ? toolName : "tool");
            String safeDescription = pythonStringLiteral(description != null ? description : "");
            return (trimmed.isBlank() ? "import json\nimport sys" : trimmed)
                    + "\n\n"
                    + "def main(args):\n"
                    + "    return {\n"
                    + "        \"status\": \"ok\",\n"
                    + "        \"tool_name\": \"" + safeName + "\",\n"
                    + "        \"message\": \"Tool scaffold is executable; complete the business logic before production use.\",\n"
                    + "        \"description\": \"" + safeDescription + "\",\n"
                    + "        \"arguments\": args,\n"
                    + "    }"
                    + entrypoint;
        }
        if (!trimmed.contains("__main__")) {
            return trimmed + entrypoint;
        }
        return trimmed;
    }

    private String pythonStringLiteral(String value) {
        return value.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n");
    }

    private void safeSendError(SseEmitter emitter, String message) {
        try {
            emitter.send(SseEmitter.event()
                    .name("error")
                    .data("{\"message\":" + objectMapper.writeValueAsString(message) + "}"));
            emitter.complete();
        } catch (IOException e) {
            emitter.completeWithError(e);
        }
    }
}
