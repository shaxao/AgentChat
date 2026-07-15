package com.aiplatform.backend.service.impl;

import com.aiplatform.backend.service.OssService;
import com.qcloud.cos.COSClient;
import com.qcloud.cos.ClientConfig;
import com.qcloud.cos.auth.BasicCOSCredentials;
import com.qcloud.cos.model.*;
import com.qcloud.cos.region.Region;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URL;
import java.util.Date;

/**
 * 腾讯云 COS 实现。
 */
@Slf4j
@Service
public class TencentCosService implements OssService {

    @Override
    public String getProvider() { return "tencent"; }

    @Override
    public String upload(String objectKey, byte[] content, String contentType) {
        COSClient client = null;
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
        COSClient client = null;
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
        COSClient client = null;
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
        COSClient client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var obj = client.getObject(cfg.getBucket(), objectKey);
            return obj.getObjectContent().readAllBytes();
        } catch (Exception e) {
            log.error("腾讯云 COS 下载失败: {}", e.getMessage());
            throw new RuntimeException("COS 下载失败: " + e.getMessage());
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public byte[] readRange(String objectKey, long offset, int limit) {
        COSClient client = null;
        try {
            var cfg = getCurrentConfig();
            client = buildClient(cfg);
            var req = new GetObjectRequest(cfg.getBucket(), objectKey);
            req.setRange(offset, offset + limit - 1);
            var obj = client.getObject(req);
            return obj.getObjectContent().readAllBytes();
        } catch (Exception e) {
            log.error("腾讯云 COS 分页读取失败: {}", e.getMessage());
            throw new RuntimeException("COS 分页读取失败: " + e.getMessage());
        } finally {
            if (client != null) client.shutdown();
        }
    }

    @Override
    public void delete(String objectKey) {
        COSClient client = null;
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
        COSClient client = null;
        try {
            var cred = new BasicCOSCredentials(accessKey, secretKey);
            var clientConfig = new ClientConfig(new Region(region != null ? region : "ap-guangzhou"));
            clientConfig.setEndPointSuffix(endpoint != null ? endpoint : "cos.ap-guangzhou.myqcloud.com");
            client = new COSClient(cred, clientConfig);
            client.doesBucketExist(bucket);
            return "ok";
        } catch (Exception e) {
            return "连接失败: " + e.getMessage();
        } finally {
            if (client != null) client.shutdown();
        }
    }

    // ---- internal helpers ----

    private OSSClientConfig getCurrentConfig() {
        return OssServiceFactory.getAliyunCredential(); // 复用同一配置结构
    }

    private COSClient buildClient(OSSClientConfig cfg) {
        var cred = new BasicCOSCredentials(cfg.getAccessKey(), cfg.getSecretKey());
        var clientConfig = new ClientConfig(new Region(
                cfg.getRegion() != null ? cfg.getRegion() : "ap-guangzhou"));
        clientConfig.setEndPointSuffix(cfg.getEndpoint());
        return new COSClient(cred, clientConfig);
    }

    private String generateUrl(COSClient client, String bucket, String objectKey, OSSClientConfig cfg) {
        try {
            var expiration = new Date(System.currentTimeMillis() + 3600 * 1000);
            URL url = client.generatePresignedUrl(bucket, objectKey, expiration);
            return url.toString();
        } catch (Exception e) {
            return "https://" + bucket + "." + cfg.getEndpoint() + "/" + objectKey;
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
