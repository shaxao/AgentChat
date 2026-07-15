package com.aiplatform.backend.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@TableName("oss_config")
public class OssConfig {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String uuid;
    private String name;
    private String provider;       // aliyun / tencent / minio
    private String endpoint;
    private String region;
    private String bucket;
    private String accessKey;
    private String secretKey;
    private String basePath;       // 默认 tool_results
    private Boolean isDefault;     // 是否默认配置
    private String status;         // active / disabled / error
    private LocalDateTime lastTestAt;
    private String testResult;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    private Integer deleted;
}
