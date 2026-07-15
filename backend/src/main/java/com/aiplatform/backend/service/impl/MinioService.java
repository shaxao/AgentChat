package com.aiplatform.backend.service.impl;

import com.aiplatform.backend.service.OssService;
import io.minio.*;
import io.minio.http.Method;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

/**
 * MinIO（及 S3 兼容存储）实现。
 * 适用于自建 MinIO Server 或其他 S3 兼容对象存储。
 */
@Slf4j
@Service
public class MinioService implements OssService {

    @Override
    public String getProvider() { return "minio"; }

    @Override
    public String upload(String objectKey, byte[] content, String contentType) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            ensureBucket(client, cfg.getBucket());
            client.putObject(PutObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .stream(new ByteArrayInputStream(content), content.length, -1)
                    .contentType(contentType != null ? contentType : "text/plain; charset=utf-8")
                    .build());
            return generateUrl(client, cfg.getBucket(), objectKey);
        } catch (Exception e) {
            log.error("MinIO 上传失败: {}", e.getMessage());
            throw new RuntimeException("MinIO 上传失败: " + e.getMessage());
        }
    }

    @Override
    public String uploadPublicRead(String objectKey, byte[] content, String contentType) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            ensureBucket(client, cfg.getBucket());
            client.putObject(PutObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .stream(new ByteArrayInputStream(content), content.length, -1)
                    .contentType(contentType != null ? contentType : "image/jpeg")
                    .build());
            return buildStablePublicUrl(cfg, objectKey);
        } catch (Exception e) {
            log.error("MinIO public asset upload failed: {}", e.getMessage());
            throw new RuntimeException("MinIO public asset upload failed: " + e.getMessage());
        }
    }

    @Override
    public String upload(String objectKey, InputStream stream, long size, String contentType) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            ensureBucket(client, cfg.getBucket());
            client.putObject(PutObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .stream(stream, size, -1)
                    .contentType(contentType != null ? contentType : "text/plain; charset=utf-8")
                    .build());
            return generateUrl(client, cfg.getBucket(), objectKey);
        } catch (Exception e) {
            log.error("MinIO 上传失败: {}", e.getMessage());
            throw new RuntimeException("MinIO 上传失败: " + e.getMessage());
        }
    }

    @Override
    public byte[] download(String objectKey) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            var resp = client.getObject(GetObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .build());
            return resp.readAllBytes();
        } catch (Exception e) {
            log.error("MinIO 下载失败: {}", e.getMessage());
            throw new RuntimeException("MinIO 下载失败: " + e.getMessage());
        }
    }

    @Override
    public byte[] readRange(String objectKey, long offset, int limit) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            var resp = client.getObject(GetObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .offset(offset)
                    .length((long) limit)
                    .build());
            return resp.readAllBytes();
        } catch (Exception e) {
            log.error("MinIO 分页读取失败: {}", e.getMessage());
            throw new RuntimeException("MinIO 分页读取失败: " + e.getMessage());
        }
    }

    @Override
    public void delete(String objectKey) {
        try {
            var cfg = getCurrentConfig();
            var client = buildClient(cfg);
            client.removeObject(RemoveObjectArgs.builder()
                    .bucket(cfg.getBucket())
                    .object(objectKey)
                    .build());
        } catch (Exception e) {
            log.warn("MinIO 删除失败: {}", e.getMessage());
        }
    }

    @Override
    public String testConnection(String endpoint, String region, String bucket, String accessKey, String secretKey) {
        try {
            var client = MinioClient.builder()
                    .endpoint(endpoint)
                    .credentials(accessKey, secretKey)
                    .build();
            boolean exists = client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build());
            return exists ? "ok" : "Bucket 不存在";
        } catch (Exception e) {
            return "连接失败: " + e.getMessage();
        }
    }

    // ---- internal helpers ----

    private OSSClientConfig getCurrentConfig() {
        return OssServiceFactory.getAliyunCredential();
    }

    private MinioClient buildClient(OSSClientConfig cfg) {
        return MinioClient.builder()
                .endpoint(cfg.getEndpoint())
                .credentials(cfg.getAccessKey(), cfg.getSecretKey())
                .build();
    }

    private void ensureBucket(MinioClient client, String bucket) throws Exception {
        boolean exists = client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build());
        if (!exists) {
            client.makeBucket(MakeBucketArgs.builder().bucket(bucket).build());
        }
    }

    private String generateUrl(MinioClient client, String bucket, String objectKey) {
        try {
            return client.getPresignedObjectUrl(GetPresignedObjectUrlArgs.builder()
                    .method(Method.GET)
                    .bucket(bucket)
                    .object(objectKey)
                    .expiry(1, TimeUnit.HOURS)
                    .build());
        } catch (Exception e) {
            return getCurrentConfig().getEndpoint() + "/" + bucket + "/" + objectKey;
        }
    }

    private String buildStablePublicUrl(OSSClientConfig cfg, String objectKey) {
        String endpoint = cfg.getEndpoint();
        if (endpoint == null || endpoint.isBlank()) {
            return "/" + cfg.getBucket() + "/" + objectKey;
        }
        return endpoint.replaceAll("/+$", "") + "/" + cfg.getBucket() + "/" + objectKey;
    }
}
