package com.aiplatform.backend.service;

import com.aiplatform.backend.agent.AgentConfig;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;

/**
 * Agent 管理服务（重构版）
 * <p>
 * 不再硬编码 Agent 配置，而是委托 AgentRegistryService 从数据库动态加载。
 * 支持内置 Agent（ban-biao）和动态注册的第三方 Agent。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class AgentService {

    private final AgentRegistryService agentRegistryService;

    /**
     * 根据 agentId 获取 Agent 配置
     * <p>
     * 优先级：内置 Agent → 数据库动态注册的 Agent
     */
    public AgentConfig getAgentConfig(String agentId) {
        return agentRegistryService.loadAgentConfig(agentId);
    }

    /**
     * 获取所有已注册的 Agent ID 列表
     */
    public List<String> getAvailableAgentIds() {
        return agentRegistryService.listAll().stream()
            .map(item -> item.getAgentId())
            .toList();
    }
}
