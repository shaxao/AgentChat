package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.OssConfig;
import com.aiplatform.backend.mapper.OssConfigMapper;
import com.aiplatform.backend.service.impl.OssServiceFactory;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.UUID;

@Slf4j
@Service
@RequiredArgsConstructor
public class OssConfigService {

    private final OssConfigMapper ossConfigMapper;
    private final OssServiceFactory ossServiceFactory;

    public List<OssConfig> listAll() {
        return ossConfigMapper.selectList(
                new LambdaQueryWrapper<OssConfig>()
                        .orderByDesc(OssConfig::getIsDefault)
                        .orderByDesc(OssConfig::getCreatedAt)
        );
    }

    public OssConfig getByUuid(String uuid) {
        return ossConfigMapper.selectOne(
                new LambdaQueryWrapper<OssConfig>().eq(OssConfig::getUuid, uuid));
    }

    @Transactional
    public OssConfig create(String name, String provider, String endpoint, String region,
                             String bucket, String accessKey, String secretKey, String basePath) {
        OssConfig config = new OssConfig();
        config.setUuid(UUID.randomUUID().toString());
        config.setName(name);
        config.setProvider(provider);
        config.setEndpoint(endpoint);
        config.setRegion(region);
        config.setBucket(bucket);
        config.setAccessKey(accessKey);
        config.setSecretKey(secretKey);
        config.setBasePath(basePath != null ? basePath : "tool_results");
        config.setIsDefault(false);
        config.setStatus("active");
        ossConfigMapper.insert(config);
        return config;
    }

    @Transactional
    public OssConfig update(String uuid, String name, String provider, String endpoint,
                             String region, String bucket, String accessKey, String secretKey,
                             String basePath) {
        var existing = getByUuid(uuid);
        if (existing == null) throw new RuntimeException("OSS 配置不存在");

        if (name != null) existing.setName(name);
        if (provider != null) existing.setProvider(provider);
        if (endpoint != null) existing.setEndpoint(endpoint);
        if (region != null) existing.setRegion(region);
        if (bucket != null) existing.setBucket(bucket);
        if (accessKey != null) existing.setAccessKey(accessKey);
        if (secretKey != null) existing.setSecretKey(secretKey);
        if (basePath != null) existing.setBasePath(basePath);

        ossConfigMapper.updateById(existing);
        refreshIfNeeded(existing);
        return existing;
    }

    @Transactional
    public void delete(String uuid) {
        var cfg = getByUuid(uuid);
        if (cfg == null) return;
        ossConfigMapper.deleteById(cfg.getId());
        ossServiceFactory.refresh();
    }

    @Transactional
    public OssConfig toggleStatus(String uuid, String status) {
        var cfg = getByUuid(uuid);
        if (cfg == null) throw new RuntimeException("OSS 配置不存在");
        cfg.setStatus(status);
        ossConfigMapper.updateById(cfg);
        ossServiceFactory.refresh();
        return cfg;
    }

    @Transactional
    public OssConfig setDefault(String uuid) {
        var cfg = getByUuid(uuid);
        if (cfg == null) throw new RuntimeException("OSS 配置不存在");

        // 取消其他默认
        var all = ossConfigMapper.selectList(
                new LambdaQueryWrapper<OssConfig>().eq(OssConfig::getIsDefault, true));
        for (var other : all) {
            if (!other.getUuid().equals(uuid)) {
                other.setIsDefault(false);
                ossConfigMapper.updateById(other);
            }
        }

        cfg.setIsDefault(true);
        cfg.setStatus("active");
        ossConfigMapper.updateById(cfg);
        ossServiceFactory.refresh();
        return cfg;
    }

    @Transactional
    public String testConnection(String uuid) {
        var cfg = getByUuid(uuid);
        if (cfg == null) throw new RuntimeException("OSS 配置不存在");

        // 使用对应提供商的实现测试连接（不依赖活跃配置）
        String result;
        try {
            result = testConnectionDirect(cfg);
        } catch (Exception e) {
            result = "测试失败: " + e.getMessage();
        }

        cfg.setLastTestAt(LocalDateTime.now());
        cfg.setTestResult(result);
        if ("ok".equals(result)) {
            cfg.setStatus("active");
        } else {
            cfg.setStatus("error");
        }
        ossConfigMapper.updateById(cfg);
        ossServiceFactory.refresh();
        return result;
    }

    private void refreshIfNeeded(OssConfig config) {
        // 只刷新如果修改了当前活跃配置的关键字段
        var current = OssServiceFactory.getAliyunCredential();
        if (current != null && current.getProvider() != null
                && current.getProvider().equals(config.getProvider())
                && "active".equals(config.getStatus())) {
            ossServiceFactory.refresh();
        }
    }

    private String testConnectionDirect(OssConfig cfg) {
        // 直接创建临时客户端测试（不用工厂）
        return switch (cfg.getProvider()) {
            case "aliyun" -> {
                var svc = new com.aiplatform.backend.service.impl.AliyunOssService();
                yield svc.testConnection(cfg.getEndpoint(), cfg.getRegion(), cfg.getBucket(),
                        cfg.getAccessKey(), cfg.getSecretKey());
            }
            case "tencent" -> {
                var svc = new com.aiplatform.backend.service.impl.TencentCosService();
                yield svc.testConnection(cfg.getEndpoint(), cfg.getRegion(), cfg.getBucket(),
                        cfg.getAccessKey(), cfg.getSecretKey());
            }
            case "minio" -> {
                var svc = new com.aiplatform.backend.service.impl.MinioService();
                yield svc.testConnection(cfg.getEndpoint(), cfg.getRegion(), cfg.getBucket(),
                        cfg.getAccessKey(), cfg.getSecretKey());
            }
            default -> "不支持的提供商: " + cfg.getProvider();
        };
    }
}
