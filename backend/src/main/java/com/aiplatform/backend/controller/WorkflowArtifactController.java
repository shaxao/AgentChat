package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.dto.WorkflowArtifactDTO;
import com.aiplatform.backend.service.WorkflowArtifactService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.List;

/**
 * 工作流资产 API。
 */
@Slf4j
@RestController
@RequestMapping("/api/workflow-artifacts")
@RequiredArgsConstructor
public class WorkflowArtifactController {

    private final WorkflowArtifactService artifactService;

    @PostMapping("/chunk/init")
    public Result<WorkflowArtifactDTO.ChunkUploadSessionVO> initChunkUpload(
            @RequestAttribute Long userId,
            @RequestParam("fileName") String fileName,
            @RequestParam("totalSize") Long totalSize,
            @RequestParam(value = "chunkSize", required = false) Long chunkSize,
            @RequestParam(value = "contentType", required = false) String contentType,
            @RequestParam(value = "workflowId", required = false) Long workflowId,
            @RequestParam(value = "executionId", required = false) Long executionId,
            @RequestParam(value = "stepId", required = false) String stepId,
            @RequestParam(value = "sourceType", required = false) String sourceType,
            @RequestParam(value = "convUuid", required = false) String convUuid,
            @RequestParam(value = "syncToWorkFile", required = false, defaultValue = "false") Boolean syncToWorkFile,
            @RequestParam(value = "metadataJson", required = false) String metadataJson) {
        try {
            return Result.ok(artifactService.initChunkUpload(
                    userId, fileName, totalSize, chunkSize, contentType, workflowId, executionId,
                    stepId, sourceType, convUuid, syncToWorkFile, metadataJson));
        } catch (IllegalArgumentException e) {
            return Result.fail(400, e.getMessage());
        } catch (Exception e) {
            log.error("[WorkflowArtifact] init chunk upload failed: {}", e.getMessage(), e);
            return Result.fail(500, "Init chunk upload failed: " + e.getMessage());
        }
    }

    @PostMapping("/chunk/{uploadId}/part")
    public Result<WorkflowArtifactDTO.ChunkUploadSessionVO> uploadChunk(
            @RequestAttribute Long userId,
            @PathVariable String uploadId,
            @RequestParam("partNumber") Integer partNumber,
            @RequestParam("chunk") MultipartFile chunk) {
        try {
            return Result.ok(artifactService.uploadChunk(userId, uploadId, partNumber, chunk));
        } catch (IllegalArgumentException e) {
            return Result.fail(400, e.getMessage());
        } catch (Exception e) {
            log.error("[WorkflowArtifact] upload chunk failed: {}", e.getMessage(), e);
            return Result.fail(500, "Upload chunk failed: " + e.getMessage());
        }
    }

    @GetMapping("/chunk/{uploadId}")
    public Result<WorkflowArtifactDTO.ChunkUploadSessionVO> chunkStatus(
            @RequestAttribute Long userId,
            @PathVariable String uploadId) {
        try {
            return Result.ok(artifactService.getChunkStatus(userId, uploadId));
        } catch (IllegalArgumentException e) {
            return Result.fail(404, e.getMessage());
        } catch (Exception e) {
            log.error("[WorkflowArtifact] get chunk status failed: {}", e.getMessage(), e);
            return Result.fail(500, "Get chunk status failed: " + e.getMessage());
        }
    }

    @PostMapping("/chunk/{uploadId}/complete")
    public Result<WorkflowArtifactDTO.ArtifactVO> completeChunkUpload(
            @RequestAttribute Long userId,
            @PathVariable String uploadId) {
        try {
            return Result.ok(artifactService.completeChunkUpload(userId, uploadId));
        } catch (IllegalArgumentException e) {
            return Result.fail(400, e.getMessage());
        } catch (Exception e) {
            log.error("[WorkflowArtifact] complete chunk upload failed: {}", e.getMessage(), e);
            return Result.fail(500, "Complete chunk upload failed: " + e.getMessage());
        }
    }

    @PostMapping("/upload")
    public Result<WorkflowArtifactDTO.ArtifactVO> upload(
            @RequestAttribute Long userId,
            @RequestParam("file") MultipartFile file,
            @RequestParam(value = "workflowId", required = false) Long workflowId,
            @RequestParam(value = "executionId", required = false) Long executionId,
            @RequestParam(value = "stepId", required = false) String stepId,
            @RequestParam(value = "sourceType", required = false) String sourceType,
            @RequestParam(value = "convUuid", required = false) String convUuid,
            @RequestParam(value = "syncToWorkFile", required = false, defaultValue = "false") Boolean syncToWorkFile,
            @RequestParam(value = "metadataJson", required = false) String metadataJson) {
        try {
            return Result.ok(artifactService.uploadArtifact(
                    userId, file, workflowId, executionId, stepId, sourceType, convUuid, syncToWorkFile, metadataJson));
        } catch (IllegalArgumentException e) {
            return Result.fail(400, e.getMessage());
        } catch (Exception e) {
            log.error("[WorkflowArtifact] 上传失败: {}", e.getMessage(), e);
            return Result.fail(500, "上传失败: " + e.getMessage());
        }
    }

    @GetMapping("/{uuid}")
    public Result<WorkflowArtifactDTO.ArtifactVO> detail(
            @RequestAttribute Long userId,
            @PathVariable String uuid) {
        try {
            return Result.ok(artifactService.getByUuid(userId, uuid));
        } catch (IllegalArgumentException e) {
            return Result.fail(404, e.getMessage());
        }
    }

    @GetMapping
    public Result<List<WorkflowArtifactDTO.ArtifactVO>> list(
            @RequestAttribute Long userId,
            @RequestParam(value = "workflowId", required = false) Long workflowId,
            @RequestParam(value = "executionId", required = false) Long executionId,
            @RequestParam(value = "fileType", required = false) String fileType) {
        return Result.ok(artifactService.list(userId, workflowId, executionId, fileType));
    }
}
