package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.ChatFileStorageService;
import com.aiplatform.backend.service.MemoryService;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.HashMap;
import java.util.Map;

/**
 * 聊天文件上传控制器。
 *
 * 功能：
 *   1. 接收前端文件上传（multipart/form-data）
 *   2. 上传到已配置的 OSS 存储渠道
 *   3. 返回 OSS URL，供消息发送时使用
 *   4. 🔧 自动保存为对话工作文件（memory_work_file）
 *
 * 端点：
 *   POST /api/files/upload — 上传文件到 OSS
 */
@Slf4j
@RestController
@RequestMapping("/api/files")
@RequiredArgsConstructor
public class FileUploadController {

    private final ChatFileStorageService chatFileStorageService;
    private final MemoryService memoryService;
    private final ChatConversationMapper conversationMapper;

    /**
     * 上传文件到 OSS 存储，并自动保存为对话工作文件。
     *
     * 请求格式：multipart/form-data，字段名 "file"
     * 可选字段：convUuid — 对话 UUID，提供后文件会自动关联到该对话的记忆空间
     * 响应：{ code: 200, data: { url, fileName, size, contentType, objectKey, workFileId } }
     */
    @PostMapping("/upload")
    public Result<Map<String, Object>> upload(
            @RequestParam("file") MultipartFile file,
            @RequestAttribute Long userId,
            @RequestParam(value = "convUuid", required = false) String convUuid
    ) {
        if (file == null || file.isEmpty()) {
            return Result.fail(400, "文件不能为空");
        }

        // 文件大小限制：单文件最大 50MB
        long maxSize = 50 * 1024 * 1024;
        if (file.getSize() > maxSize) {
            return Result.fail(400, "文件大小不能超过 50MB");
        }

        try {
            var summary = chatFileStorageService.upload(file);

            Map<String, Object> data = new HashMap<>();
            data.put("url", summary.url());
            data.put("objectKey", summary.objectKey());
            data.put("fileName", summary.fileName());
            data.put("size", summary.size());
            data.put("contentType", summary.contentType());

            // 🔧 自动保存为对话工作文件
            if (convUuid != null && !convUuid.isBlank() && userId != null) {
                try {
                    ChatConversation conv = conversationMapper.selectOne(
                            new QueryWrapper<ChatConversation>()
                                    .eq("uuid", convUuid)
                                    .eq("user_id", userId)
                                    .eq("deleted", 0));
                    if (conv != null) {
                        // 根据文件类型分类
                        String fileType = classifyFileType(summary.fileName(), summary.contentType());
                        var workFile = memoryService.saveWorkFile(
                                userId, conv.getId(),
                                summary.fileName(), fileType, summary.size(),
                                summary.contentType(), summary.url(), null);
                        data.put("workFileId", workFile.getId());
                        log.info("[Memory] 工作文件已自动保存: fileName={}, convUuid={}", summary.fileName(), convUuid);
                    }
                } catch (Exception e) {
                    // 工作文件保存失败不阻塞上传
                    log.warn("[Memory] 工作文件自动保存失败: fileName={}, error={}", summary.fileName(), e.getMessage());
                }
            }

            return Result.ok(data);
        } catch (Exception e) {
            log.error("文件上传失败: fileName={}, error={}", file.getOriginalFilename(), e.getMessage(), e);
            return Result.fail(500, "上传失败: " + e.getMessage());
        }
    }

    /**
     * 根据文件名和 MIME 类型自动分类文件类型
     */
    private String classifyFileType(String fileName, String contentType) {
        if (contentType == null) contentType = "";
        String name = fileName.toLowerCase();
        if (contentType.startsWith("image/")) return "image";
        if (contentType.startsWith("audio/")) return "audio";
        if (contentType.startsWith("video/")) return "video";
        if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) return "spreadsheet";
        if (name.endsWith(".pdf")) return "document";
        if (name.endsWith(".doc") || name.endsWith(".docx")) return "document";
        if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json")) return "document";
        if (name.endsWith(".zip") || name.endsWith(".skill") || name.endsWith(".yaml")) return "skill";
        return "other";
    }
}
