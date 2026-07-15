package com.aiplatform.backend.agent;

/**
 * 工具执行器接口
 * <p>
 * Agent 的 ReAct 循环中，当 LLM 返回 tool_calls 时，
 * 通过此接口执行对应的工具并返回结果。
 */
@FunctionalInterface
public interface ToolExecutor {
    /**
     * 执行工具
     *
     * @param toolName      工具名称
     * @param argumentsJson 工具参数（JSON 字符串）
     * @return 工具执行结果（JSON 字符串）
     */
    String execute(String toolName, String argumentsJson);
}
