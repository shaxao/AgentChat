package com.aiplatform.backend.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.connection.Message;
import org.springframework.data.redis.connection.MessageListener;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 聊天流中继：统一实时发送与事后回放。
 *
 * <p>数据库仍是持久化真相来源；本服务是流式 SSE 的热路径：
 * 本地队列做单节点低延迟 fanout，Redis pub/sub 跨节点投递，
 * Redis List 做逐事件回放缓冲以支持断线续传/多端接入。
 *
 * <p>关键不变量：一个 generationId 只有一个生成线程写入，因此 List 顺序即 seq 顺序；
 * 订阅者必须"先 subscribe 再回放"，并用 seq 去重实时与回放的重叠区间。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class StreamRelayService implements MessageListener {

    public static final String REDIS_TOPIC = "chat:stream:events";

    private static final int QUEUE_CAPACITY = 2000;
    private static final int MAX_EVENT_BYTES = 256 * 1024;
    private static final long BUF_LIMIT = 20000;
    private static final Duration LIVE_TTL = Duration.ofMinutes(30);
    private static final Duration TERMINAL_TTL = Duration.ofSeconds(120);
    private static final Duration DEFAULT_POLL_TIMEOUT = Duration.ofSeconds(15);

    private final StringRedisTemplate redis;
    private final ObjectMapper objectMapper;
    private final String nodeId = UUID.randomUUID().toString();
    private final ConcurrentHashMap<String, CopyOnWriteArraySet<Subscription>> subscriptions = new ConcurrentHashMap<>();

    private static String bufKey(String gid) { return "chat:stream:buf:" + gid; }
    private static String seqKey(String gid) { return "chat:stream:seq:" + gid; }
    private static String activeKey(String uuid) { return "chat:stream:active:" + uuid; }
    private static String lastKey(String uuid) { return "chat:stream:last:" + uuid; }
    private static String metaKey(String gid) { return "chat:stream:meta:" + gid; }

    public String nodeId() { return nodeId; }

    // ===== 生命周期 =====

    /** 生成任务开始：登记 active + meta。失败静默降级（Redis 不可用则退化为纯本地 fanout）。 */
    public void begin(String generationId, String conversationUuid) {
        try {
            redis.opsForValue().set(activeKey(conversationUuid), generationId, LIVE_TTL);
            redis.opsForValue().set(lastKey(conversationUuid), generationId, LIVE_TTL);
            redis.opsForHash().putAll(metaKey(generationId), Map.of(
                    "status", "running",
                    "conversationUuid", conversationUuid,
                    "nodeId", nodeId,
                    "startedAt", String.valueOf(System.currentTimeMillis())
            ));
            redis.expire(metaKey(generationId), LIVE_TTL);
        } catch (Exception e) {
            log.debug("[StreamRelay] begin 无法写入 Redis，退化为本地模式: gid={}, error={}", generationId, e.getMessage());
        }
    }

    /** 标记生成状态与落库消息 id（done/error 回调调用），不做清理。 */
    public void markStatus(String generationId, String status, String assistantMsgId) {
        if (generationId == null) return;
        try {
            Map<String, String> patch = new java.util.HashMap<>();
            patch.put("status", status);
            if (assistantMsgId != null) patch.put("assistantMsgId", assistantMsgId);
            redis.opsForHash().putAll(metaKey(generationId), patch);
        } catch (Exception e) {
            log.debug("[StreamRelay] markStatus 失败: gid={}, error={}", generationId, e.getMessage());
        }
    }

    /**
     * 生成结束清理（放 finally 保证所有退出路径都执行）：清 active/seq，
     * 缩短 buf/meta TTL 给晚到者回放窗口。幂等，可安全重复调用。
     */
    public void finish(String generationId, String conversationUuid) {
        if (generationId == null) return;
        try {
            redis.delete(activeKey(conversationUuid));
            redis.delete(seqKey(generationId));
            redis.expire(bufKey(generationId), TERMINAL_TTL);
            redis.expire(metaKey(generationId), TERMINAL_TTL);
            // last 指针保留到终态窗口，供晚到 resume 者在 active 消失后仍能找到刚结束的生成。
            redis.expire(lastKey(conversationUuid), TERMINAL_TTL);
        } catch (Exception e) {
            log.debug("[StreamRelay] finish 清理失败: gid={}, error={}", generationId, e.getMessage());
        }
    }

    public String getActiveGeneration(String conversationUuid) {
        try {
            return redis.opsForValue().get(activeKey(conversationUuid));
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 无活跃生成时，查最近一次已结束的生成（仍在终态 TTL 窗口内）。
     * 用于"关页面后几秒内重开"能回放完整内容含 done。窗口外返回 null → 前端退回纯 DB 加载。
     */
    public String findTerminalGeneration(String conversationUuid) {
        try {
            String gid = redis.opsForValue().get(lastKey(conversationUuid));
            if (gid == null) return null;
            // 缓冲已过期（窗口外）则视为无可回放。
            Boolean exists = redis.hasKey(bufKey(gid));
            return Boolean.TRUE.equals(exists) ? gid : null;
        } catch (Exception e) {
            return null;
        }
    }

    public Map<Object, Object> getMeta(String generationId) {
        try {
            return redis.opsForHash().entries(metaKey(generationId));
        } catch (Exception e) {
            return Map.of();
        }
    }

    /** 判断 meta 所属节点是否被本进程视为存活（仅同节点可确认；异节点交由 resume 超时兜底）。 */
    public boolean isLocalNode(Map<Object, Object> meta) {
        return meta != null && nodeId.equals(meta.get("nodeId"));
    }

    // ===== 发送 =====

    /** 发送一个事件：INCR seq → 回放缓冲 → 本地 fanout → 跨节点 publish。 */
    public long emit(String generationId, String name, String dataJson) {
        String data = dataJson;
        if (data != null && data.length() > MAX_EVENT_BYTES) {
            data = truncatedEvent(name);
        }
        long seq = nextSeq(generationId);
        RelayEvent ev = new RelayEvent(generationId, seq, name, data, System.currentTimeMillis());
        try {
            String payload = objectMapper.writeValueAsString(ev);
            redis.opsForList().rightPush(bufKey(generationId), payload);
            redis.opsForList().trim(bufKey(generationId), -BUF_LIMIT, -1);
            // 首个事件为缓冲 List 设置存活 TTL（begin 时 List 尚不存在，expire 无效）。
            if (seq == 1) redis.expire(bufKey(generationId), LIVE_TTL);
        } catch (Exception e) {
            log.debug("[StreamRelay] 回放缓冲写入失败: gid={}, error={}", generationId, e.getMessage());
        }
        fanoutLocal(ev);
        try {
            redis.convertAndSend(REDIS_TOPIC, objectMapper.writeValueAsString(new RelayEnvelope(nodeId, ev)));
        } catch (Exception e) {
            log.debug("[StreamRelay] 跨节点 publish 不可用，仅本地 fanout: gid={}, error={}", generationId, e.getMessage());
        }
        return seq;
    }

    private long nextSeq(String generationId) {
        try {
            Long seq = redis.opsForValue().increment(seqKey(generationId));
            if (seq != null) return seq;
        } catch (Exception e) {
            log.debug("[StreamRelay] seq INCR 失败，退化为时间戳: gid={}", generationId);
        }
        return System.nanoTime();
    }

    private String truncatedEvent(String name) {
        try {
            return objectMapper.writeValueAsString(Map.of(
                    "truncated", true,
                    "message", "事件内容过大已截断",
                    "event", name));
        } catch (Exception e) {
            return "{\"truncated\":true}";
        }
    }

    // ===== 订阅 / fanout =====

    public Subscription subscribe(String generationId) {
        Subscription subscription = new Subscription(generationId, new LinkedBlockingQueue<>(QUEUE_CAPACITY));
        subscriptions.computeIfAbsent(generationId, ignored -> new CopyOnWriteArraySet<>()).add(subscription);
        return subscription;
    }

    public void unsubscribe(Subscription subscription) {
        if (subscription == null) return;
        subscription.close();
        Set<Subscription> set = subscriptions.get(subscription.generationId());
        if (set != null) {
            set.remove(subscription);
            if (set.isEmpty()) {
                subscriptions.remove(subscription.generationId(), set);
            }
        }
    }

    private void fanoutLocal(RelayEvent event) {
        Set<Subscription> set = subscriptions.get(event.generationId());
        if (set == null || set.isEmpty()) return;
        for (Subscription subscription : set) {
            if (!subscription.offer(event)) {
                log.warn("[StreamRelay] 订阅队列已满，关闭订阅: gid={}", event.generationId());
                unsubscribe(subscription);
            }
        }
    }

    /** 回放缓冲中 seq > afterSeq 的事件，按 seq 升序返回（防御性排序，不假设 List 顺序）。 */
    public List<RelayEvent> replay(String generationId, long afterSeq) {
        List<RelayEvent> result = new ArrayList<>();
        try {
            List<String> raw = redis.opsForList().range(bufKey(generationId), 0, -1);
            if (raw == null) return result;
            for (String s : raw) {
                try {
                    RelayEvent ev = objectMapper.readValue(s, RelayEvent.class);
                    if (ev.seq() > afterSeq) result.add(ev);
                } catch (Exception ignored) {}
            }
            result.sort((a, b) -> Long.compare(a.seq(), b.seq()));
        } catch (Exception e) {
            log.debug("[StreamRelay] 回放读取失败: gid={}, error={}", generationId, e.getMessage());
        }
        return result;
    }

    @Override
    public void onMessage(Message message, byte[] pattern) {
        try {
            RelayEnvelope envelope = objectMapper.readValue(new String(message.getBody()), RelayEnvelope.class);
            if (envelope == null || envelope.event() == null) return;
            if (nodeId.equals(envelope.nodeId())) return;
            fanoutLocal(envelope.event());
        } catch (Exception e) {
            log.warn("[StreamRelay] 消费跨节点事件失败: {}", e.getMessage());
        }
    }

    // ===== 载荷 =====

    public record RelayEvent(String generationId, long seq, String name, String data, long ts) {}

    public record RelayEnvelope(String nodeId, RelayEvent event) {}

    public static final class Subscription implements AutoCloseable {
        private final String generationId;
        private final BlockingQueue<RelayEvent> queue;
        private volatile boolean closed;

        private Subscription(String generationId, BlockingQueue<RelayEvent> queue) {
            this.generationId = generationId;
            this.queue = queue;
        }

        public String generationId() { return generationId; }

        private boolean offer(RelayEvent event) {
            return !closed && queue.offer(event);
        }

        public RelayEvent poll() throws InterruptedException {
            return queue.poll(DEFAULT_POLL_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
        }

        @Override
        public void close() {
            closed = true;
            queue.clear();
        }
    }
}
