package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.WorkflowDTO;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Realtime workflow execution event bus.
 *
 * Database rows remain the durable source of truth. This bus is only the hot
 * path for SSE fanout: local queues for single-node latency and Redis pub/sub
 * for cross-node delivery when Redis is available.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkflowExecutionEventBus implements MessageListener {

    public static final String REDIS_TOPIC = "workflow:execution:events";
    private static final int QUEUE_CAPACITY = 500;
    private static final Duration DEFAULT_POLL_TIMEOUT = Duration.ofSeconds(15);

    private final StringRedisTemplate redisTemplate;
    private final ObjectMapper objectMapper;
    private final String nodeId = UUID.randomUUID().toString();
    private final ConcurrentHashMap<Long, CopyOnWriteArraySet<Subscription>> subscriptions = new ConcurrentHashMap<>();

    public Subscription subscribe(Long executionId) {
        Subscription subscription = new Subscription(executionId, new LinkedBlockingQueue<>(QUEUE_CAPACITY));
        subscriptions.computeIfAbsent(executionId, ignored -> new CopyOnWriteArraySet<>()).add(subscription);
        return subscription;
    }

    public void unsubscribe(Subscription subscription) {
        if (subscription == null) return;
        subscription.close();
        Set<Subscription> set = subscriptions.get(subscription.executionId());
        if (set != null) {
            set.remove(subscription);
            if (set.isEmpty()) {
                subscriptions.remove(subscription.executionId(), set);
            }
        }
    }

    public void publish(WorkflowDTO.ExecutionEventVO event) {
        if (event == null || event.getExecutionId() == null) {
            return;
        }

        publishLocal(event);

        try {
            EventEnvelope envelope = new EventEnvelope(nodeId, event);
            redisTemplate.convertAndSend(REDIS_TOPIC, objectMapper.writeValueAsString(envelope));
        } catch (Exception e) {
            log.debug("[WorkflowEventBus] Redis publish unavailable, local fanout only. executionId={}, error={}",
                    event.getExecutionId(), e.getMessage());
        }
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        try {
            String body = new String(message.getBody());
            EventEnvelope envelope = objectMapper.readValue(body, EventEnvelope.class);
            if (envelope == null || envelope.event() == null) {
                return;
            }
            if (nodeId.equals(envelope.nodeId())) {
                return;
            }
            publishLocal(envelope.event());
        } catch (Exception e) {
            log.warn("[WorkflowEventBus] Failed to consume Redis event: {}", e.getMessage());
        }
    }

    private void publishLocal(WorkflowDTO.ExecutionEventVO event) {
        Set<Subscription> set = subscriptions.get(event.getExecutionId());
        if (set == null || set.isEmpty()) {
            return;
        }

        for (Subscription subscription : set) {
            if (!subscription.offer(event)) {
                log.warn("[WorkflowEventBus] SSE subscriber queue full, closing subscription. executionId={}",
                        event.getExecutionId());
                unsubscribe(subscription);
            }
        }
    }

    public static final class Subscription implements AutoCloseable {
        private final Long executionId;
        private final BlockingQueue<WorkflowDTO.ExecutionEventVO> queue;
        private volatile boolean closed;

        private Subscription(Long executionId, BlockingQueue<WorkflowDTO.ExecutionEventVO> queue) {
            this.executionId = executionId;
            this.queue = queue;
        }

        public Long executionId() {
            return executionId;
        }

        private boolean offer(WorkflowDTO.ExecutionEventVO event) {
            return !closed && queue.offer(event);
        }

        public WorkflowDTO.ExecutionEventVO poll() throws InterruptedException {
            return queue.poll(DEFAULT_POLL_TIMEOUT.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        }

        @Override
        public void close() {
            closed = true;
            queue.clear();
        }
    }

    public record EventEnvelope(String nodeId, WorkflowDTO.ExecutionEventVO event) {
    }
}
