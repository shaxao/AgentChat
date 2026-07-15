package com.aiplatform.backend.agent;

/**
 * 工具调用记录
 * <p>
 * 用于在 Agent ReAct 循环中记录每次工具调用的信息，
 * 并通过 SSE 推送给前端展示。
 *
 * @param toolCallId LLM 返回的工具调用 ID（如 "call_xxx"）
 * @param toolName   工具名称
 * @param arguments  调用参数（JSON 字符串）
 * @param result     执行结果（JSON 字符串，calling 状态时为 null）
 */
public record ToolCallRecord(
    String toolCallId,
    String toolName,
    String arguments,
    String result
) {}
