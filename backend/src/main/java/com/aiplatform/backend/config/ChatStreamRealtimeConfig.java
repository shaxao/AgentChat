package com.aiplatform.backend.config;

import com.aiplatform.backend.service.StreamRelayService;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.listener.ChannelTopic;
import org.springframework.data.redis.listener.RedisMessageListenerContainer;

@Configuration
@RequiredArgsConstructor
public class ChatStreamRealtimeConfig {

    private final StreamRelayService streamRelayService;

    @Bean
    @ConditionalOnProperty(prefix = "app.chat.stream.redis", name = "enabled", havingValue = "true", matchIfMissing = true)
    public RedisMessageListenerContainer chatStreamRedisMessageListenerContainer(
            RedisConnectionFactory connectionFactory) {
        RedisMessageListenerContainer container = new RedisMessageListenerContainer();
        container.setConnectionFactory(connectionFactory);
        container.addMessageListener(
                streamRelayService,
                new ChannelTopic(StreamRelayService.REDIS_TOPIC)
        );
        return container;
    }
}
