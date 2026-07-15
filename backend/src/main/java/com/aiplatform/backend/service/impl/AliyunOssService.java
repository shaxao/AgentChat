package com.aiplatform.backend.service.impl;

import com.aiplatform.backend.service.OssService;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.model.*;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.time.Duration;
import java.time.temporal.ChronoUnit;

/**
 * 阿里云 OSS 实现。
 *
 * putObject 操作缺省位于路径 style 的 resource，若需生成可直接下载的 URL，
 * 本实现默认通过 generatePresignedUrl() 产生短期访问链接。
 */
@Slf4j
@Service
public class AliyunOssService implements OssService {

    @Override
    public String getProvider() { return "aliyun"; }

    @Override
    public String upload(String objectKey, byte[] content, String contentType) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var meta = new ObjectMetadata();
            meta.setContentType(contentType != null ? contentType : "text/plain; charset=utf-8");
            meta.setContentLength(content.length);
            client.putObject(cfg.getBucket(), objectKey, new ByteArrayInputStream(content), meta);
            return generateUrl(client, cfg.getBucket(), objectKey, cfg);
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public String uploadPublicRead(String objectKey, byte[] content, String contentType) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var meta = new ObjectMetadata();
            meta.setContentType(contentType != null ? contentType : "image/jpeg");
            meta.setContentLength(content.length);
            client.putObject(cfg.getBucket(), objectKey, new ByteArrayInputStream(content), meta);
            client.setObjectAcl(cfg.getBucket(), objectKey, CannedAccessControlList.PublicRead);
            return buildStablePublicUrl(cfg, objectKey);
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public String upload(String objectKey, InputStream stream, long size, String contentType) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var meta = new ObjectMetadata();
            meta.setContentType(contentType != null ? contentType : "text/plain; charset=utf-8");
            meta.setContentLength(size);
            client.putObject(cfg.getBucket(), objectKey, stream, meta);
            return generateUrl(client, cfg.getBucket(), objectKey, cfg);
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public byte[] download(String objectKey) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var obj = client.getObject(cfg.getBucket(), objectKey);
            return obj.getObjectContent().readAllBytes();
        } catch (Exception e) {
            log.error("阿里云 OSS 下载失败: {}", e.getMessage());
            throw new RuntimeException("OSS 下载失败: " + e.getMessage());
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public byte[] readRange(String objectKey, long offset, int limit) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var req = new GetObjectRequest(cfg.getBucket(), objectKey);
            req.setRange(offset, offset + limit - 1);
            var obj = client.getObject(req);
            return obj.getObjectContent().readAllBytes();
        } catch (Exception e) {
            log.error("阿里云 OSS 分页读取失败: {}", e.getMessage());
            throw new RuntimeException("OSS 分页读取失败: " + e.getMessage());
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public void delete(String objectKey) {
        OSS client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            client.deleteObject(cfg.getBucket(), objectKey);
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public String testConnection(String endpoint, String region, String bucket, String accessKey, String secretKey) {
        OSS client = null;
        try {
            client = new OSSClientBuilder().build(endpoint, accessKey, secretKey);
            client.getBucketInfo(bucket);
            return "ok";
        } catch (Exception e) {
            return "连接失败: " + e.getMessage();
        } finally {
            if (client != null) client.shutdown();
        }
    }

    // ---- internal helpers ----

    private OSSClientConfig getCurrentConfig() {
        // 延迟注入：由 OssServiceFactory 在运行时设置
        return OssServiceFactory.getAliyunCredential();
    }

    private OSS buildClient(OSSClientConfig cfg) {
        // 只用 endpoint（如 oss-cn-hongkong.aliyuncs.com），SDK 会自动处理 region
        // 注意：OSSClientBuilder.build() 没有 (region, endpoint, ak, sk) 重载
        // 4 参数版本是 (endpoint, ak, sk, securityToken)，传 region 会导致参数错位
        return new OSSClientBuilder().build(cfg.getEndpoint(), cfg.getAccessKey(), cfg.getSecretKey());
    }

    private String generateUrl(OSS client, String bucket, String objectKey, OSSClientConfig cfg) {
        // 生成 1 小时签名的下载 URL
        try {
            var expiration = Duration.of(1, ChronoUnit.HOURS);
            var url = client.generatePresignedUrl(bucket, objectKey,
                    java.util.Date.from(java.time.Instant.now().plus(expiration)));
            return url.toString();
        } catch (Exception e) {
            // 降级：拼接原始 URL
            return cfg.getEndpoint() + "/" + bucket + "/" + objectKey;
        }
    }

    private String buildStablePublicUrl(OSSClientConfig cfg, String objectKey) {
        String endpoint = cfg.getEndpoint();
        if (endpoint == null || endpoint.isBlank()) {
            return "/" + objectKey;
        }
        String scheme = endpoint.startsWith("http://") ? "http://" : "https://";
        String host = endpoint.replaceFirst("^https?://", "").replaceAll("/+$", "");
        return scheme + cfg.getBucket() + "." + host + "/" + objectKey;
    }
}
