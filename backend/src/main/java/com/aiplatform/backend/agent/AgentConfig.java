package com.aiplatform.backend.agent;

import java.util.List;

/**
 * Agent 配置
 * <p>
 * 定义一个 Agent 的完整配置：系统提示词、模型参数、可用工具、工具执行器。
 * 由 AgentService 根据不同的 agentId 构建对应的配置。
 *
 * @param agentId      Agent 唯一标识（如 "ban-biao"）
 * @param displayName  显示名称
 * @param systemPrompt 系统提示词
 * @param model        推荐模型（需支持 tool calling 和可选 vision）
 * @param temperature  温度
 * @param maxTokens    最大 token 数
 * @param tools        可调用的工具列表
 * @param toolExecutor 工具执行器
 */
public record AgentConfig(
    String agentId,
    String displayName,
    String systemPrompt,
    String model,
    double temperature,
    int maxTokens,
    List<ToolDefinition> tools,
    ToolExecutor toolExecutor
) {}
