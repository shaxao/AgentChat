package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.ModelConfig;
import com.aiplatform.backend.mapper.ModelConfigMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 模型别名解析服务 — 将外部工具（Claude Code / Cline / Cursor 等 IDE）发来的模型名
 * 映射到平台已配置的 {@code model_config.model_id}。
 * <p>
 * 解析优先级：
 * <ol>
 *   <li>精确匹配 {@code model_id}（大小写不敏感）</li>
 *   <li>匹配 {@code aliases}（逗号分隔，大小写不敏感）</li>
 *   <li>无命中：返回原始请求模型名，交给 {@code AiService.resolveChannel} 的渠道兜底逻辑处理</li>
 * </ol>
 * <p>
 * 别名表在内存中缓存 60 秒，避免每次入站请求都查库。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class ModelAliasService {

    private final ModelConfigMapper modelConfigMapper;

    /** 别名 → model_id 映射缓存（key 已小写归一化） */
    private final ConcurrentHashMap<String, String> aliasCache = new ConcurrentHashMap<>();
    /** 已知 model_id 集合缓存（key 已小写归一化） */
    private final ConcurrentHashMap<String, String> modelIdCache = new ConcurrentHashMap<>();
    private final AtomicLong cacheExpireAt = new AtomicLong(0);

    private static final long CACHE_TTL_MS = 60_000L;

    /**
     * 解析外部请求的模型名到平台 model_id。
     *
     * @param requested 外部工具请求的模型名（可能是别名，如 claude-3-5-sonnet-20241022）
     * @return 平台已配置的 model_id；无命中时返回原始值（不为 null，除非入参为 null）
     */
    public String resolveModelId(String requested) {
        if (requested == null || requested.isBlank()) {
            return requested;
        }
        String key = requested.trim().toLowerCase(Locale.ROOT);
        refreshIfNeeded();

        // 1. 精确匹配 model_id
        String direct = modelIdCache.get(key);
        if (direct != null) {
            return direct;
        }
        // 2. 匹配别名
        String aliased = aliasCache.get(key);
        if (aliased != null) {
            log.debug("[ModelAlias] 别名解析: {} → {}", requested, aliased);
            return aliased;
        }
        // 3. 无命中：返回原值，交给渠道兜底
        return requested;
    }

    private void refreshIfNeeded() {
        long now = System.currentTimeMillis();
        if (now < cacheExpireAt.get() && !modelIdCache.isEmpty()) {
            return;
        }
        synchronized (this) {
            if (now < cacheExpireAt.get() && !modelIdCache.isEmpty()) {
                return;
            }
            try {
                List<ModelConfig> configs = modelConfigMapper.selectList(
                        new QueryWrapper<ModelConfig>().eq("deleted", 0));
                ConcurrentHashMap<String, String> newModelIds = new ConcurrentHashMap<>();
                ConcurrentHashMap<String, String> newAliases = new ConcurrentHashMap<>();
                for (ModelConfig mc : configs) {
                    String modelId = mc.getModelId();
                    if (modelId == null || modelId.isBlank()) continue;
                    newModelIds.put(modelId.trim().toLowerCase(Locale.ROOT), modelId);
                    if (mc.getAliases() != null && !mc.getAliases().isBlank()) {
                        for (String alias : mc.getAliases().split(",")) {
                            String a = alias.trim();
                            if (!a.isBlank()) {
                                newAliases.putIfAbsent(a.toLowerCase(Locale.ROOT), modelId);
                            }
                        }
                    }
                }
                modelIdCache.clear();
                modelIdCache.putAll(newModelIds);
                aliasCache.clear();
                aliasCache.putAll(newAliases);
                cacheExpireAt.set(now + CACHE_TTL_MS);
            } catch (Exception e) {
                log.warn("[ModelAlias] 刷新别名缓存失败: {}", e.getMessage());
                // 保留旧缓存，推迟下次刷新，避免异常时反复查库
                cacheExpireAt.set(now + CACHE_TTL_MS);
            }
        }
    }

    /** 手动清除缓存（管理端更新模型别名后调用可选） */
    public void evictCache() {
        cacheExpireAt.set(0);
    }
}
