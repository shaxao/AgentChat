package com.aiplatform.backend.config;

import com.aiplatform.backend.entity.OssConfig;
import com.aiplatform.backend.mapper.OssConfigMapper;
import com.aiplatform.backend.service.impl.OssServiceFactory;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;

import java.util.UUID;

/**
 * OSS 默认配置初始化器。
 *
 * 启动时检查数据库 oss_config 表：
 * - 已有配置 → 不操作（避免覆盖用户手动设置）
 * - 空表 → 从 application.yml 读取默认值并自动创建一条配置
 *
 * 执行时机：在 ApplicationRunner 阶段（晚于 OssServiceFactory @PostConstruct），
 * 插入后手动调用 OssServiceFactory.refresh() 使其生效。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class OssConfigInitializer implements ApplicationRunner {

    private final OssDefaultProperties defaultProps;
    private final OssConfigMapper ossConfigMapper;
    private final OssServiceFactory ossServiceFactory;

    @Override
    public void run(ApplicationArguments args) {
        if (!defaultProps.isEnabled()) {
            log.info("[OSS初始化] 已禁用（app.oss.default.enabled=false），跳过");
            return;
        }

        try {
            // 检查是否已有配置（包括逻辑删除的）
            long count = ossConfigMapper.selectCount(new LambdaQueryWrapper<>());
            if (count > 0) {
                log.info("[OSS初始化] 数据库已有 {} 条配置，跳过自动初始化", count);
                return;
            }

            // 插入默认配置
            OssConfig cfg = new OssConfig();
            cfg.setUuid(UUID.randomUUID().toString());
            cfg.setName(defaultProps.getName());
            cfg.setProvider(defaultProps.getProvider());
            cfg.setEndpoint(defaultProps.getEndpoint());
            cfg.setRegion(defaultProps.getRegion());
            cfg.setBucket(defaultProps.getBucket());
            cfg.setAccessKey(defaultProps.getAccessKey());
            cfg.setSecretKey(defaultProps.getSecretKey());
            cfg.setBasePath(defaultProps.getBasePath() != null ? defaultProps.getBasePath() : "tool_results");
            cfg.setIsDefault(true);
            cfg.setStatus("active");

            ossConfigMapper.insert(cfg);

            log.info("[OSS初始化] ✓ 已从 YAML 自动创建默认配置: provider={}, bucket={}, endpoint={}",
                    cfg.getProvider(), cfg.getBucket(), cfg.getEndpoint());

            // 刷新工厂，使新配置立即生效
            ossServiceFactory.refresh();
        } catch (Exception e) {
            log.warn("[OSS初始化] 初始化失败（数据库表可能尚未就绪），跳过: {}", e.getMessage());
        }
    }
}
