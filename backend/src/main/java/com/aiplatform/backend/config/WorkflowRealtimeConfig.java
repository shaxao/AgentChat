package com.aiplatform.backend.config;

import com.aiplatform.backend.service.WorkflowExecutionEventBus;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

@Configuration
@RequiredArgsConstructor
public class WorkflowRealtimeConfig {

    private final WorkflowExecutionEventBus workflowExecutionEventBus;

    @Bean
    @ConditionalOnProperty(prefix = "app.workflow.realtime.redis", name = "enabled", havingValue = "true", matchIfMissing = true)
    public RedisMessageListenerContainer workflowRedisMessageListenerContainer(
            RedisConnectionFactory connectionFactory) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(
                workflowExecutionEventBus,
                new ChannelTopic(WorkflowExecutionEventBus.REDIS_TOPIC)
        );
        return container;
    }
}
