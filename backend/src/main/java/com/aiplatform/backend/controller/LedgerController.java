package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.LedgerToolService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;
import java.util.UUID;

/**
 * 台账文件控制器
 * <p>
 * 提供文件上传和下载接口，供前端和 Agent 工具使用。
 * - 上传：前端通过 multipart/form-data 上送图片/Excel，返回文件路径供工具使用
 * - 下载：前端通过下载链接获取生成的台账 Excel
 */
@Slf4j
@RestController
@RequestMapping("/api/v1/ledger")
@RequiredArgsConstructor
public class LedgerController {

    private final LedgerToolService ledgerToolService;

    @Value("${app.upload-dir:${java.io.tmpdir}/aiplatform/uploads}")
    private String uploadDir;

    @Value("${app.ledger-output-dir:${java.io.tmpdir}/aiplatform/ledgers}")
    private String ledgerOutputDir;

    /**
     * 上传文件（图片/Excel）
     * <p>
     * 前端通过 multipart/form-data 上传文件，返回 file_path 供 Agent 工具使用。
     */
    @PostMapping("/upload")
    public Result<Map<String, String>> uploadFile(
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "type", defaultValue = "image") String fileType) throws IOException {

        // 确保上传目录存在
        Files.createDirectories(Path.of(uploadDir));

        // 生成唯一文件名
        String originalName = file.getOriginalFilename();
        String extension = "";
        if (originalName != null && originalName.contains(".")) {
            extension = originalName.substring(originalName.lastIndexOf("."));
        }
        String fileName = UUID.randomUUID().toString() + extension;
        Path filePath = Path.of(uploadDir, fileName);

        // 保存文件
        Files.copy(file.getInputStream(), filePath, StandardCopyOption.REPLACE_EXISTING);

        log.info("[Ledger] 文件上传成功: {} -> {}", originalName, filePath);

        return Result.ok(Map.of(
            "file_path", filePath.toString(),
            "file_name", originalName != null ? originalName : fileName,
            "file_type", fileType,
            "size", String.valueOf(file.getSize())
        ));
    }

    /**
     * 下载台账文件
     */
    @GetMapping("/download/{fileName}")
    public ResponseEntity<Resource> downloadLedger(@PathVariable String fileName) throws IOException {
        Path filePath = Path.of(ledgerOutputDir, fileName);

        if (!Files.exists(filePath)) {
            return ResponseEntity.notFound().build();
        }

        FileSystemResource resource = new FileSystemResource(filePath);
        String contentType = Files.probeContentType(filePath);
        if (contentType == null) {
            contentType = "application/octet-stream";
        }

        return ResponseEntity.ok()
            .contentType(MediaType.parseMediaType(contentType))
            .header(HttpHeaders.CONTENT_DISPOSITION,
                "attachment; filename=\"" + fileName.replaceAll("[^\\x00-\\xFF]", "_") + "\";"
                + " filename*=UTF-8''" + URLEncoder.encode(fileName, StandardCharsets.UTF_8).replace("+", "%20"))
            .body(resource);
    }

    /**
     * 获取可用 Agent 列表
     */
    @GetMapping("/agents")
    public Result<Map<String, Object>> listAgents() {
        return Result.ok(Map.of(
            "agents", java.util.List.of(
                Map.of(
                    "agentId", "ban-biao",
                    "displayName", "台账识别",
                    "description", "根据送货单图片识别数据，匹配台账模板，生成标准台账 Excel 文件",
                    "tools", java.util.List.of(
                        "upload_procurement_excel", "recognize_delivery_image",
                        "query_kg_table", "match_ledger_template",
                        "fill_ledger_template", "generate_ledger_file",
                        "external_upload"
                    )
                )
            )
        ));
    }
}
