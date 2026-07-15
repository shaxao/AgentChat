package com.aiplatform.backend.service;

import com.aiplatform.backend.service.impl.OssServiceFactory;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

/**
 * 聊天文件 OSS 存储服务。
 *
 * 职责：
 *   1. 将用户上传的图片/文件存储到已配置的 OSS 渠道
 *   2. 返回可访问的 URL，供消息发送和 LLM 访问
 *
 * 存储路径规则：
 *   chat_files/{yyyyMMdd}/{uuid}_{originalFilename}
 */
@Slf4j
@Service
public class ChatFileStorageService {

    private static final String CHAT_FILES_PREFIX = "chat_files";
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");

    /**
     * 上传聊天文件到 OSS。
     *
     * @param file Spring MultipartFile（来自前端上传）
     * @return 文件存储摘要（URL、原始文件名、大小、OSS key）
     * @throws IOException 读取文件内容失败
     * @throws RuntimeException OSS 上传失败或无活跃配置
     */
    public ChatFileSummary upload(MultipartFile file) throws IOException {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new RuntimeException("无活跃 OSS 配置，无法上传文件。请在管理后台配置 OSS 存储。");
        }

        var activeCfg = OssServiceFactory.getAliyunCredential();
        String basePath = activeCfg.getBasePath() != null ? activeCfg.getBasePath() : "chat_files";

        // 生成 OSS 对象 key：basePath/yyyyMMdd/uuid_originalName
        String dateStr = LocalDateTime.now().format(DATE_FMT);
        String originalName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "unknown";
        String safeName = safeFileName(originalName);
        String objectKey = basePath + "/" + dateStr + "/" + UUID.randomUUID().toString().substring(0, 8) + "_" + safeName;

        String contentType = file.getContentType() != null ? file.getContentType() : "application/octet-stream";

        try (var stream = file.getInputStream()) {
            String url = ossService.upload(objectKey, stream, file.getSize(), contentType);
            log.info("聊天文件已上传 OSS: fileName={}, size={}, ossKey={}, url={}",
                    originalName, file.getSize(), objectKey, url);

            return new ChatFileSummary(
                    url,
                    objectKey,
                    originalName,
                    file.getSize(),
                    contentType
            );
        } catch (Exception e) {
            log.error("OSS 文件上传失败: fileName={}, error={}", originalName, e.getMessage(), e);
            throw new RuntimeException("OSS 上传失败: " + e.getMessage(), e);
        }
    }

    /**
     * 从 OSS 下载聊天文件（供后端读取文件内容后传给 LLM）。
     */
    public byte[] download(String objectKey) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new RuntimeException("OSS 存储不可用");
        }
        return ossService.download(objectKey);
    }

    private String safeFileName(String name) {
        if (name == null || name.isBlank()) return "unknown";
        // 保留扩展名，替换非法字符
        return name.replaceAll("[^a-zA-Z0-9._\\u4e00-\\u9fa5-]", "_");
    }

    /**
     * 聊天文件存储摘要 — 通过 API 返回给前端。
     *
     * @param url         OSS 访问 URL（公网可访问，或需鉴权取决于 OSS 配置）
     * @param objectKey   OSS 对象 key（用于后端下载）
     * @param fileName   原始文件名
     * @param size       文件大小（字节）
     * @param contentType HTTP Content-Type
     */
    public record ChatFileSummary(
            String url,
            String objectKey,
            String fileName,
            long size,
            String contentType
    ) {}
}
