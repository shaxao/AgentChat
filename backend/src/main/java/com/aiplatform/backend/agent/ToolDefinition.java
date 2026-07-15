package com.aiplatform.backend.agent;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.util.Map;

/**
 * LLM 工具定义（OpenAI Function Calling 格式）
 *
 * @param name        工具名称，LLM 调用时使用
 * @param description 工具描述，引导 LLM 判断何时调用
 * @param parameters  参数 JSON Schema（ObjectNode 格式）
 */
public record ToolDefinition(
    String name,
    String description,
    ObjectNode parameters
) {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 从 Map 构建 ToolDefinition（方便内联定义）
     */
    @SuppressWarnings("unchecked")
    public static ToolDefinition of(String name, String description, Map<String, Object> schema) {
        ObjectNode params = MAPPER.valueToTree(schema);
        return new ToolDefinition(name, description, params);
    }

    /**
     * 快捷构建：无参数工具
     */
    public static ToolDefinition of(String name, String description) {
        ObjectNode params = MAPPER.createObjectNode();
        params.put("type", "object");
        params.putArray("properties");
        params.putArray("required");
        return new ToolDefinition(name, description, params);
    }
}
