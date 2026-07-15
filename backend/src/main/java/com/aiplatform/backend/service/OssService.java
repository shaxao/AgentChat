package com.aiplatform.backend.service;

import java.io.InputStream;

/**
 * OSS 对象存储统一接口（策略模式）。
 * 支持阿里云 OSS、腾讯云 COS、MinIO 三种实现，通过 OssServiceFactory 动态选择。
 */
public interface OssService {

    /** 提供商标识 */
    String getProvider();

    /**
     * 上传文件到 OSS。
     * @param objectKey 对象键（相对路径，如 "tool_results/abc123.txt"）
     * @param content   文件内容
     * @param contentType MIME 类型
     * @return 公开访问 URL（或签名 URL）
     */
    String upload(String objectKey, byte[] content, String contentType);

    /**
     * Upload a long-lived public asset, such as generated skill icons.
     * Implementations should set object-level public-read permission when the
     * provider supports it and return a stable non-presigned URL.
     */
    default String uploadPublicRead(String objectKey, byte[] content, String contentType) {
        return upload(objectKey, content, contentType);
    }

    /**
     * 上传文件流。
     */
    String upload(String objectKey, InputStream stream, long size, String contentType);

    /**
     * Reserve native cloud multipart capability for future provider-specific wiring.
     * Current workflow artifact uploads do not call these methods by default.
     */
    default boolean supportsNativeMultipart() {
        return false;
    }

    default MultipartUploadSession initiateMultipartUpload(String objectKey, String contentType, long totalSize) {
        throw new UnsupportedOperationException(getProvider() + " native multipart upload is not enabled");
    }

    default MultipartPartETag uploadMultipartPart(String objectKey,
                                                  String uploadId,
                                                  int partNumber,
                                                  InputStream stream,
                                                  long partSize) {
        throw new UnsupportedOperationException(getProvider() + " native multipart upload is not enabled");
    }

    default String completeMultipartUpload(String objectKey,
                                           String uploadId,
                                           java.util.List<MultipartPartETag> parts,
                                           String contentType) {
        throw new UnsupportedOperationException(getProvider() + " native multipart upload is not enabled");
    }

    default void abortMultipartUpload(String objectKey, String uploadId) {
        throw new UnsupportedOperationException(getProvider() + " native multipart upload is not enabled");
    }

    /**
     * 下载文件完整内容。
     */
    byte[] download(String objectKey);

    /**
     * 分页读取文件内容（支持 offset/limit）。
     * @return 读取到的字节数组
     */
    byte[] readRange(String objectKey, long offset, int limit);

    /**
     * 删除文件。
     */
    void delete(String objectKey);

    /**
     * 测试连接是否正常。
     * @return 测试结果描述（成功返回 "ok"，失败返回错误信息）
     */
    String testConnection(String endpoint, String region, String bucket, String accessKey, String secretKey);

    record MultipartUploadSession(String uploadId, String objectKey, String provider) {}

    record MultipartPartETag(int partNumber, String eTag, long size) {}
}
