package com.aiplatform.backend.service.impl;

import lombok.AllArgsConstructor;
import lombok.Data;
import lombok.NoArgsConstructor;

/**
 * OSS 客户端运行时配置（从数据库 OssConfig 实体转换而来）。
 */
@Data
@NoArgsConstructor
@AllArgsConstructor
public class OSSClientConfig {
    private String provider;
    private String endpoint;
    private String region;
    private String bucket;
    private String accessKey;
    private String secretKey;
    private String basePath;
}
