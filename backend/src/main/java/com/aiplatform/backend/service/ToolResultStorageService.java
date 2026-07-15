package com.aiplatform.backend.service;

import com.aiplatform.backend.service.impl.OssServiceFactory;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * 工具结果外部化存储服务。
 *
 * 核心逻辑：
 *   1. 工具结果 > 分层截断上限 → 上传完整结果到 OSS
 *   2. SSE 只发送预览（500 字）+ OSS 签名 URL
 *   3. LLM 可通过 read_stored_result 工具按需分页读取
 */
@Slf4j
@Service
public class ToolResultStorageService {

    private static final int PREVIEW_LENGTH = 500;
    private static final DateTimeFormatter KEY_FMT = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss");

    /**
     * 判断工具结果是否超过截断上限，超过则上传 OSS 并返回存储摘要。
     *
     * @param toolName    工具名称（用于日志/判定）
     * @param rawResult   原始结果字符串
     * @param maxChars    分层截断上限
     * @param toolCallId  工具调用 ID（用于生成 OSS key）
     * @return 存储结果摘要（包含 url / preview / stored 标志），null 表示未触发外部化
     */
    public ToolResultSummary maybeOffload(String toolName, String rawResult, int maxChars, String toolCallId) {
        if (rawResult == null || rawResult.length() <= maxChars) {
            return null; // 未触发阈值
        }

        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            log.warn("无活跃 OSS 配置，工具结果 {} ({} 字符) 无法外部化，将直接截断",
                    toolName, rawResult.length());
            return null;
        }

        var activeCfg = OssServiceFactory.getAliyunCredential();
        String basePath = activeCfg.getBasePath() != null ? activeCfg.getBasePath() : "tool_results";
        String timestamp = LocalDateTime.now().format(KEY_FMT);
        String objectKey = basePath + "/" + timestamp + "_" + safeName(toolCallId) + ".txt";

        try {
            byte[] content = rawResult.getBytes(StandardCharsets.UTF_8);
            String url = ossService.upload(objectKey, content, "text/plain; charset=utf-8");

            log.info("工具结果已外部化: toolName={}, size={}, ossKey={}, url={}",
                    toolName, content.length, objectKey, url);

            String preview = rawResult.substring(0, Math.min(PREVIEW_LENGTH, rawResult.length()));

            return new ToolResultSummary(
                    true,
                    url,
                    objectKey,
                    preview,
                    rawResult.length(),
                    "结果 " + rawResult.length() + " 字符已存储至 OSS，"
                            + "预览（前 " + PREVIEW_LENGTH + " 字符）如上。"
                            + "需要完整结果时请使用 read_stored_result 工具读取。"
            );
        } catch (Exception e) {
            log.error("OSS 上传失败: toolName={}, error={}", toolName, e.getMessage());
            // 降级：返回截断后的原始结果，不标记为 stored
            return null;
        }
    }

    /**
     * 从 OSS 读取已存储的完整结果。
     */
    public String readStoredResult(String objectKey) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new RuntimeException("OSS 存储不可用");
        }
        byte[] data = ossService.download(objectKey);
        return new String(data, StandardCharsets.UTF_8);
    }

    /**
     * 从 OSS 分页读取已存储的结果。
     */
    public String readStoredResultRange(String objectKey, long offset, int limit) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new RuntimeException("OSS 存储不可用");
        }
        byte[] data = ossService.readRange(objectKey, offset, limit);
        return new String(data, StandardCharsets.UTF_8);
    }

    private String safeName(String id) {
        if (id == null || id.isBlank()) return "unknown";
        return id.replaceAll("[^a-zA-Z0-9_-]", "_").substring(0, Math.min(32, id.length()));
    }

    /**
     * 工具结果存储摘要 — 通过 SSE 发送给前端。
     */
    public record ToolResultSummary(
            boolean stored,
            String url,
            String objectKey,
            String preview,
            int totalSize,
            String message
    ) {}
}
