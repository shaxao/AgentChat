package com.aiplatform.backend.service.impl;

import com.aiplatform.backend.entity.OssConfig;
import com.aiplatform.backend.mapper.OssConfigMapper;
import com.aiplatform.backend.service.OssService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * OSS 服务工厂 — 根据数据库配置动态选择存储提供商。
 *
 * 启动时从 oss_config 表加载所有 active 配置，
 * 运行时通过 refresh() 方法重新加载（管理后台修改配置后调用）。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OssServiceFactory {

    private final OssConfigMapper ossConfigMapper;
    private final List<OssService> ossServices;

    // provider → service 映射
    private final Map<String, OssService> serviceMap = new ConcurrentHashMap<>();
    // 当前活跃的配置（线程安全快照）
    private static volatile OSSClientConfig activeConfig;

    @PostConstruct
    public void init() {
        for (var svc : ossServices) {
            serviceMap.put(svc.getProvider(), svc);
        }
        refresh();
    }

    /** 重新加载活跃配置 */
    public synchronized void refresh() {
        try {
            var active = ossConfigMapper.selectList(
                    new LambdaQueryWrapper<OssConfig>()
                            .eq(OssConfig::getStatus, "active")
                            .orderByDesc(OssConfig::getIsDefault)
                            .last("LIMIT 1")
            );
            if (active.isEmpty()) {
                log.warn("没有找到活跃的 OSS 配置，OSS 外部化存储不可用");
                activeConfig = null;
                return;
            }
            var cfg = active.get(0);
            activeConfig = toClientConfig(cfg);
            log.info("OSS 活跃配置已加载: provider={}, bucket={}, endpoint={}",
                    cfg.getProvider(), cfg.getBucket(), cfg.getEndpoint());
        } catch (Exception e) {
            log.warn("OSS 配置加载失败（数据库表可能尚未初始化），OSS 外部化存储不可用: {}", e.getMessage());
            activeConfig = null;
        }
    }

    /** 获取当前活跃的 OssService，无可用配置时返回 null */
    public static OssService getActive() {
        if (activeConfig == null) return null;
        return getInstance().serviceMap.get(activeConfig.getProvider());
    }

    /** 获取当前活跃的客户端配置 */
    public static OSSClientConfig getAliyunCredential() {
        return activeConfig;
    }

    /** 静态工具方法 — 获取 OssServiceFactory 单例 */
    private static OssServiceFactory getInstance() {
        // Spring 注入的实例通过内部 Helper 获取
        return Holder.INSTANCE;
    }

    /** 内部 Holder（由 Spring 设置） */
    static class Holder {
        static OssServiceFactory INSTANCE;
    }

    @PostConstruct
    void registerInstance() {
        Holder.INSTANCE = this;
    }

    private static OSSClientConfig toClientConfig(OssConfig entity) {
        return new OSSClientConfig(
                entity.getProvider(),
                entity.getEndpoint(),
                entity.getRegion(),
                entity.getBucket(),
                entity.getAccessKey(),
                entity.getSecretKey(),
                entity.getBasePath()
        );
    }
}
