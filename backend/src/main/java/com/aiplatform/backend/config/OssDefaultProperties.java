package com.aiplatform.backend.config;

import lombok.Data;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 默认 OSS 配置 — 从 application.yml 的 app.oss.default 节点读取。
 *
 * 仅当数据库 oss_config 表为空时，初始化器（OssConfigInitializer）
 * 才会使用这些默认值自动创建一条 OSS 配置。
 */
@Data
@Component
@ConfigurationProperties(prefix = "app.oss.default")
public class OssDefaultProperties {

    /** 是否启用启动自动初始化 */
    private boolean enabled = true;

    /** 配置名称 */
    private String name = "默认存储";

    /** 提供商：aliyun / tencent / minio */
    private String provider = "minio";

    /** Endpoint 地址 */
    private String endpoint = "http://localhost:9000";

    /** 区域 */
    private String region = "";

    /** Bucket 名称 */
    private String bucket = "aiplatform";

    /** Access Key / SecretId */
    private String accessKey = "minioadmin";

    /** Secret Key */
    private String secretKey = "minioadmin";

    /** 存储路径前缀 */
    private String basePath = "tool_results";
}
