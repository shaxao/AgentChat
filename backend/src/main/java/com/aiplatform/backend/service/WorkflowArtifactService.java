package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.dto.WorkflowArtifactDTO;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.entity.Workflow;
import com.aiplatform.backend.entity.WorkflowArtifact;
import com.aiplatform.backend.entity.WorkflowArtifactUploadSession;
import com.aiplatform.backend.entity.WorkflowExecution;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.mapper.WorkflowArtifactMapper;
import com.aiplatform.backend.mapper.WorkflowArtifactUploadSessionMapper;
import com.aiplatform.backend.mapper.WorkflowExecutionMapper;
import com.aiplatform.backend.mapper.WorkflowMapper;
import com.aiplatform.backend.service.impl.OssServiceFactory;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * Workflow artifact service.
 *
 * Large files are uploaded to OSS by stream. Chunked upload stores resumable
 * parts as temporary OSS objects, then streams those parts into the final OSS
 * object so the application server never keeps uploaded files on local disk.
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WorkflowArtifactService {

    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private static final DateTimeFormatter FMT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss");
    private static final long DEFAULT_MAX_SIZE = 1024L * 1024 * 1024;
    private static final long DEFAULT_CHUNK_SIZE = 32L * 1024 * 1024;
    private static final long MIN_CHUNK_SIZE = 1L * 1024 * 1024;
    private static final long MAX_CHUNK_SIZE = 100L * 1024 * 1024;
    private static final int REMOTE_READ_CHUNK_SIZE = 4 * 1024 * 1024;
    private static final String STORAGE_OSS_TEMP_MERGE = "oss_temp_merge";
    private static final String STORAGE_NATIVE_MULTIPART = "native_multipart";

    private final WorkflowArtifactMapper artifactMapper;
    private final WorkflowArtifactUploadSessionMapper uploadSessionMapper;
    private final WorkflowMapper workflowMapper;
    private final WorkflowExecutionMapper executionMapper;
    private final ChatConversationMapper conversationMapper;
    private final MemoryService memoryService;
    private final ObjectMapper objectMapper;

    @Transactional
    public WorkflowArtifactDTO.ArtifactVO uploadArtifact(Long userId,
                                                         MultipartFile file,
                                                         Long workflowId,
                                                         Long executionId,
                                                         String stepId,
                                                         String sourceType,
                                                         String convUuid,
                                                         Boolean syncToWorkFile,
                                                         String metadataJson) throws IOException {
        if (file == null || file.isEmpty()) {
            throw new IllegalArgumentException("File cannot be empty");
        }
        if (file.getSize() > DEFAULT_MAX_SIZE) {
            throw new IllegalArgumentException("File size cannot exceed 1GB");
        }
        Long normalizedWorkflowId = normalizeWorkflowScope(userId, workflowId, executionId);
        Long conversationId = resolveConversationId(userId, convUuid);
        StoredArtifact stored = uploadToOss(file);
        return createArtifact(userId, normalizedWorkflowId, executionId, stepId, sourceType,
                conversationId, syncToWorkFile, metadataJson, stored);
    }

    public WorkflowArtifactDTO.ChunkUploadSessionVO initChunkUpload(Long userId,
                                                                    String fileName,
                                                                    Long totalSize,
                                                                    Long chunkSize,
                                                                    String contentType,
                                                                    Long workflowId,
                                                                    Long executionId,
                                                                    String stepId,
                                                                    String sourceType,
                                                                    String convUuid,
                                                                    Boolean syncToWorkFile,
                                                                    String metadataJson) throws IOException {
        if (fileName == null || fileName.isBlank()) {
            throw new IllegalArgumentException("fileName is required");
        }
        if (totalSize == null || totalSize <= 0) {
            throw new IllegalArgumentException("totalSize must be greater than 0");
        }
        if (totalSize > DEFAULT_MAX_SIZE) {
            throw new IllegalArgumentException("File size cannot exceed 1GB");
        }

        WorkflowArtifactUploadSession session = new WorkflowArtifactUploadSession();
        session.setUploadId(UUID.randomUUID().toString());
        session.setUserId(userId);
        session.setFileName(fileName);
        session.setTotalSize(totalSize);
        session.setChunkSize(normalizeChunkSize(chunkSize));
        session.setTotalParts((int) Math.ceil((double) totalSize / session.getChunkSize()));
        session.setUploadedParts("[]");
        session.setContentType(contentType != null && !contentType.isBlank() ? contentType : "application/octet-stream");
        session.setWorkflowId(normalizeWorkflowScope(userId, workflowId, executionId));
        session.setExecutionId(executionId);
        session.setStepId(blankToNull(stepId));
        session.setSourceType(sourceType != null && !sourceType.isBlank() ? sourceType : "upload");
        session.setConversationId(resolveConversationId(userId, convUuid));
        session.setSyncToWorkFile(Boolean.TRUE.equals(syncToWorkFile));
        session.setMetadataJson(blankToNull(metadataJson));
        if (OssServiceFactory.getActive() == null) {
            throw new IllegalStateException("No active OSS configuration");
        }
        session.setStorageMode(STORAGE_OSS_TEMP_MERGE);
        session.setStatus("pending");
        session.setExpiresAt(LocalDateTime.now().plusDays(3));

        session.setTempDir(tempUploadPrefix(userId, session.getUploadId()));
        uploadSessionMapper.insert(session);
        return toChunkSessionVO(session);
    }

    public WorkflowArtifactDTO.ChunkUploadSessionVO uploadChunk(Long userId,
                                                               String uploadId,
                                                               Integer partNumber,
                                                               MultipartFile chunk) throws IOException {
        if (partNumber == null || partNumber <= 0) {
            throw new IllegalArgumentException("partNumber must be greater than 0");
        }
        if (chunk == null || chunk.isEmpty()) {
            throw new IllegalArgumentException("chunk cannot be empty");
        }
        WorkflowArtifactUploadSession session = readChunkSession(userId, uploadId);
        if ("completed".equals(session.getStatus())) {
            return toChunkSessionVO(session);
        }
        if (partNumber > session.getTotalParts()) {
            throw new IllegalArgumentException("partNumber exceeds totalParts");
        }
        if (chunk.getSize() > session.getChunkSize()) {
            throw new IllegalArgumentException("chunk size exceeds configured chunkSize");
        }

        if (!STORAGE_OSS_TEMP_MERGE.equals(session.getStorageMode())) {
            throw new IllegalStateException("Legacy local upload session is no longer supported; please restart upload");
        }
        uploadChunkToOssTemp(session, partNumber, chunk);
        markPartUploaded(session, partNumber);
        return toChunkSessionVO(session);
    }

    public WorkflowArtifactDTO.ChunkUploadSessionVO getChunkStatus(Long userId, String uploadId) throws IOException {
        return toChunkSessionVO(readChunkSession(userId, uploadId));
    }

    @Transactional
    public WorkflowArtifactDTO.ArtifactVO completeChunkUpload(Long userId, String uploadId) throws IOException {
        WorkflowArtifactUploadSession session = readChunkSession(userId, uploadId);
        List<Integer> uploadedParts = uploadedParts(session);
        if (uploadedParts.size() != session.getTotalParts()) {
            throw new IllegalArgumentException("Upload is incomplete: " + uploadedParts.size() + "/" + session.getTotalParts());
        }

        if (!STORAGE_OSS_TEMP_MERGE.equals(session.getStorageMode())) {
            throw new IllegalStateException("Legacy local upload session is no longer supported; please restart upload");
        }
        try {
            StoredArtifact stored = uploadOssTempPartsToFinalObject(session);
            WorkflowArtifactDTO.ArtifactVO vo = createArtifact(userId, session.getWorkflowId(), session.getExecutionId(),
                    session.getStepId(), session.getSourceType(), session.getConversationId(),
                    session.getSyncToWorkFile(), session.getMetadataJson(), stored);
            session.setStatus("completed");
            session.setErrorMsg(null);
            uploadSessionMapper.updateById(session);
            deleteOssTempPartsQuietly(session);
            return vo;
        } catch (Exception e) {
            session.setStatus("failed");
            session.setErrorMsg(e.getMessage());
            uploadSessionMapper.updateById(session);
            throw e;
        }
    }

    public WorkflowArtifactDTO.ArtifactVO getByUuid(Long userId, String uuid) {
        WorkflowArtifact artifact = artifactMapper.selectOne(
                new QueryWrapper<WorkflowArtifact>()
                        .eq("uuid", uuid)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        if (artifact == null) {
            throw new IllegalArgumentException("Artifact not found");
        }
        return toVO(artifact);
    }

    public List<WorkflowArtifactDTO.ArtifactVO> list(Long userId, Long workflowId, Long executionId, String fileType) {
        QueryWrapper<WorkflowArtifact> qw = new QueryWrapper<WorkflowArtifact>()
                .eq("user_id", userId)
                .eq("deleted", 0)
                .orderByDesc("created_at");
        if (workflowId != null) qw.eq("workflow_id", workflowId);
        if (executionId != null) qw.eq("execution_id", executionId);
        if (fileType != null && !fileType.isBlank()) qw.eq("file_type", fileType);
        return artifactMapper.selectList(qw).stream().map(this::toVO).collect(Collectors.toList());
    }

    public int cleanupExpiredUploadSessions(int batchSize) {
        int limit = Math.max(1, Math.min(batchSize, 200));
        List<WorkflowArtifactUploadSession> sessions = uploadSessionMapper.selectList(
                new QueryWrapper<WorkflowArtifactUploadSession>()
                        .eq("deleted", 0)
                        .lt("expires_at", LocalDateTime.now())
                        .in("status", Arrays.asList("pending", "uploading", "uploaded", "failed"))
                        .last("LIMIT " + limit));
        int cleaned = 0;
        for (WorkflowArtifactUploadSession session : sessions) {
            try {
                cleanupUploadSessionStorage(session);
                session.setStatus("aborted");
                session.setErrorMsg("Expired upload session cleaned up");
                uploadSessionMapper.updateById(session);
                cleaned++;
            } catch (Exception e) {
                session.setStatus("failed");
                session.setErrorMsg("Cleanup failed: " + e.getMessage());
                uploadSessionMapper.updateById(session);
                log.warn("[WorkflowArtifact] cleanup expired upload session failed: uploadId={}, error={}",
                        session.getUploadId(), e.getMessage());
            }
        }
        if (cleaned > 0) {
            log.info("[WorkflowArtifact] cleaned {} expired upload session(s)", cleaned);
        }
        return cleaned;
    }

    private WorkflowArtifactDTO.ArtifactVO createArtifact(Long userId,
                                                          Long workflowId,
                                                          Long executionId,
                                                          String stepId,
                                                          String sourceType,
                                                          Long conversationId,
                                                          Boolean syncToWorkFile,
                                                          String metadataJson,
                                                          StoredArtifact stored) {
        WorkflowArtifact artifact = new WorkflowArtifact();
        artifact.setUuid(UUID.randomUUID().toString());
        artifact.setUserId(userId);
        artifact.setConversationId(conversationId);
        artifact.setWorkflowId(workflowId);
        artifact.setExecutionId(executionId);
        artifact.setStepId(blankToNull(stepId));
        artifact.setSourceType(sourceType != null && !sourceType.isBlank() ? sourceType : "upload");
        artifact.setFileName(stored.fileName());
        artifact.setFileType(classifyFileType(stored.fileName(), stored.contentType()));
        artifact.setMimeType(stored.contentType());
        artifact.setFileSize(stored.size());
        artifact.setOssUrl(stored.url());
        artifact.setObjectKey(stored.objectKey());
        artifact.setMetadataJson(blankToNull(metadataJson));
        artifact.setStatus("ready");
        artifactMapper.insert(artifact);

        Long workFileId = null;
        if (Boolean.TRUE.equals(syncToWorkFile) && conversationId != null) {
            MemoryDTO.WorkFileVO workFile = memoryService.saveWorkFile(
                    userId,
                    conversationId,
                    stored.fileName(),
                    artifact.getFileType(),
                    stored.size(),
                    stored.contentType(),
                    stored.url(),
                    null);
            workFileId = workFile.getId();
        }

        log.info("[WorkflowArtifact] uploaded artifactId={}, fileName={}, size={}",
                artifact.getId(), stored.fileName(), stored.size());
        WorkflowArtifactDTO.ArtifactVO vo = toVO(artifact);
        vo.setWorkFileId(workFileId);
        return vo;
    }

    private StoredArtifact uploadToOss(MultipartFile file) throws IOException {
        String originalName = file.getOriginalFilename() != null ? file.getOriginalFilename() : "unknown";
        String contentType = file.getContentType() != null ? file.getContentType() : "application/octet-stream";
        try (InputStream stream = file.getInputStream()) {
            return uploadStreamToOss(stream, file.getSize(), originalName, contentType);
        }
    }

    private StoredArtifact uploadStreamToOss(InputStream stream, long size, String originalName, String contentType) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalStateException("No active OSS configuration");
        }
        String objectKey = buildObjectKey(originalName);
        String normalizedContentType = contentType != null ? contentType : "application/octet-stream";
        String url = ossService.upload(objectKey, stream, size, normalizedContentType);
        return new StoredArtifact(url, objectKey, originalName, size, normalizedContentType);
    }

    private String buildObjectKey(String originalName) {
        var activeCfg = OssServiceFactory.getAliyunCredential();
        String configuredBasePath = activeCfg != null ? activeCfg.getBasePath() : null;
        String basePath = configuredBasePath == null || configuredBasePath.isBlank()
                ? "workflow_artifacts"
                : configuredBasePath.replaceAll("^/+|/+$", "");
        return basePath + "/" + LocalDateTime.now().format(DATE_FMT)
                + "/" + UUID.randomUUID().toString().substring(0, 8) + "_" + safeFileName(originalName);
    }

    private String tempUploadPrefix(Long userId, String uploadId) {
        var activeCfg = OssServiceFactory.getAliyunCredential();
        String configuredBasePath = activeCfg != null ? activeCfg.getBasePath() : null;
        String basePath = configuredBasePath == null || configuredBasePath.isBlank()
                ? "workflow_artifacts"
                : configuredBasePath.replaceAll("^/+|/+$", "");
        return basePath + "/_multipart_tmp/" + userId + "/" + uploadId;
    }

    private String tempUploadPrefix(WorkflowArtifactUploadSession session) {
        if (session.getTempDir() != null && !session.getTempDir().isBlank()) {
            return session.getTempDir().replaceAll("/+$", "");
        }
        return tempUploadPrefix(session.getUserId(), session.getUploadId());
    }

    private String partObjectKey(WorkflowArtifactUploadSession session, int partNumber) {
        return tempUploadPrefix(session) + "/parts/" + partNumber + ".part";
    }

    private void uploadChunkToOssTemp(WorkflowArtifactUploadSession session,
                                      Integer partNumber,
                                      MultipartFile chunk) throws IOException {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalStateException("No active OSS configuration");
        }
        try (InputStream stream = chunk.getInputStream()) {
            ossService.upload(partObjectKey(session, partNumber), stream, chunk.getSize(), "application/octet-stream");
        }
    }

    private StoredArtifact uploadOssTempPartsToFinalObject(WorkflowArtifactUploadSession session) throws IOException {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalStateException("No active OSS configuration");
        }
        try (InputStream stream = new OssTempPartsInputStream(ossService, session)) {
            return uploadStreamToOss(stream, session.getTotalSize(), session.getFileName(), session.getContentType());
        }
    }

    private void deleteOssTempPartsQuietly(WorkflowArtifactUploadSession session) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) return;
        for (int part = 1; part <= session.getTotalParts(); part++) {
            try {
                ossService.delete(partObjectKey(session, part));
            } catch (Exception e) {
                log.warn("[WorkflowArtifact] failed to delete OSS temp part: uploadId={}, part={}, error={}",
                        session.getUploadId(), part, e.getMessage());
            }
        }
    }

    private void cleanupUploadSessionStorage(WorkflowArtifactUploadSession session) {
        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalStateException("No active OSS configuration");
        }
        if (STORAGE_NATIVE_MULTIPART.equals(session.getStorageMode())) {
            if (session.getObjectKey() != null && session.getNativeUploadId() != null) {
                ossService.abortMultipartUpload(session.getObjectKey(), session.getNativeUploadId());
            }
            return;
        }
        deleteOssTempPartsQuietly(session);
    }

    private long expectedPartSize(WorkflowArtifactUploadSession session, int partNumber) {
        long offset = (long) (partNumber - 1) * session.getChunkSize();
        long remaining = session.getTotalSize() - offset;
        return Math.min(session.getChunkSize(), Math.max(remaining, 0));
    }

    private void assertWorkflowOwner(Long workflowId, Long userId) {
        Workflow workflow = workflowMapper.selectOne(
                new QueryWrapper<Workflow>()
                        .eq("id", workflowId)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        if (workflow == null) {
            throw new IllegalArgumentException("Workflow not found or no permission");
        }
    }

    private Long normalizeWorkflowScope(Long userId, Long workflowId, Long executionId) {
        if (workflowId != null) {
            assertWorkflowOwner(workflowId, userId);
        }
        if (executionId != null) {
            WorkflowExecution exec = executionMapper.selectById(executionId);
            if (exec == null || !userId.equals(exec.getUserId())) {
                throw new IllegalArgumentException("No permission to access this workflow execution");
            }
            if (workflowId == null) {
                return exec.getWorkflowId();
            }
        }
        return workflowId;
    }

    private Long resolveConversationId(Long userId, String convUuid) {
        if (convUuid == null || convUuid.isBlank()) return null;
        ChatConversation conversation = conversationMapper.selectOne(
                new QueryWrapper<ChatConversation>()
                        .eq("uuid", convUuid)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        return conversation != null ? conversation.getId() : null;
    }

    private WorkflowArtifactDTO.ArtifactVO toVO(WorkflowArtifact artifact) {
        WorkflowArtifactDTO.ArtifactVO vo = new WorkflowArtifactDTO.ArtifactVO();
        vo.setId(artifact.getId());
        vo.setUuid(artifact.getUuid());
        vo.setUserId(artifact.getUserId());
        vo.setConversationId(artifact.getConversationId());
        vo.setWorkflowId(artifact.getWorkflowId());
        vo.setExecutionId(artifact.getExecutionId());
        vo.setStepId(artifact.getStepId());
        vo.setSourceType(artifact.getSourceType());
        vo.setFileName(artifact.getFileName());
        vo.setFileType(artifact.getFileType());
        vo.setMimeType(artifact.getMimeType());
        vo.setFileSize(artifact.getFileSize());
        vo.setOssUrl(artifact.getOssUrl());
        vo.setObjectKey(artifact.getObjectKey());
        vo.setContentText(artifact.getContentText());
        vo.setMetadataJson(artifact.getMetadataJson());
        vo.setStatus(artifact.getStatus());
        vo.setCreatedAt(artifact.getCreatedAt() != null ? artifact.getCreatedAt().format(FMT) : null);
        return vo;
    }

    private String classifyFileType(String fileName, String contentType) {
        if (contentType == null) contentType = "";
        String name = fileName != null ? fileName.toLowerCase() : "";
        if (contentType.startsWith("image/")) return "image";
        if (contentType.startsWith("audio/")) return "audio";
        if (contentType.startsWith("video/")) return "video";
        if (name.endsWith(".xlsx") || name.endsWith(".xls") || name.endsWith(".csv")) return "spreadsheet";
        if (name.endsWith(".pdf") || name.endsWith(".doc") || name.endsWith(".docx")) return "document";
        if (name.endsWith(".md") || name.endsWith(".txt") || name.endsWith(".json")) return "text";
        return "other";
    }

    private String safeFileName(String name) {
        if (name == null || name.isBlank()) return "unknown";
        return name.replaceAll("[^a-zA-Z0-9._\\u4e00-\\u9fa5-]", "_");
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private long normalizeChunkSize(Long chunkSize) {
        long size = chunkSize != null && chunkSize > 0 ? chunkSize : DEFAULT_CHUNK_SIZE;
        if (size < MIN_CHUNK_SIZE) return MIN_CHUNK_SIZE;
        if (size > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
        return size;
    }

    private WorkflowArtifactUploadSession readChunkSession(Long userId, String uploadId) {
        if (uploadId == null || !uploadId.matches("[a-fA-F0-9-]{36}")) {
            throw new IllegalArgumentException("Invalid uploadId");
        }
        WorkflowArtifactUploadSession session = uploadSessionMapper.selectOne(
                new QueryWrapper<WorkflowArtifactUploadSession>()
                        .eq("upload_id", uploadId)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .last("LIMIT 1"));
        if (session == null) {
            throw new IllegalArgumentException("Upload session not found");
        }
        return session;
    }

    private WorkflowArtifactDTO.ChunkUploadSessionVO toChunkSessionVO(WorkflowArtifactUploadSession session) {
        WorkflowArtifactDTO.ChunkUploadSessionVO vo = new WorkflowArtifactDTO.ChunkUploadSessionVO();
        vo.setUploadId(session.getUploadId());
        vo.setFileName(session.getFileName());
        vo.setTotalSize(session.getTotalSize());
        vo.setChunkSize(session.getChunkSize());
        vo.setTotalParts(session.getTotalParts());
        List<Integer> uploadedParts = uploadedParts(session);
        vo.setUploadedParts(uploadedParts);
        vo.setCompleted(uploadedParts.size() == session.getTotalParts() || "completed".equals(session.getStatus()));
        vo.setStatus(session.getStatus());
        vo.setErrorMsg(session.getErrorMsg());
        return vo;
    }

    private void markPartUploaded(WorkflowArtifactUploadSession session, Integer partNumber) throws IOException {
        Set<Integer> parts = new LinkedHashSet<>(uploadedParts(session));
        parts.add(partNumber);
        session.setUploadedParts(objectMapper.writeValueAsString(parts.stream().sorted().toList()));
        session.setStatus(parts.size() >= session.getTotalParts() ? "uploaded" : "uploading");
        session.setErrorMsg(null);
        uploadSessionMapper.updateById(session);
    }

    private List<Integer> uploadedParts(WorkflowArtifactUploadSession session) {
        String raw = session.getUploadedParts();
        if (raw == null || raw.isBlank()) return List.of();
        try {
            Integer[] parts = objectMapper.readValue(raw, Integer[].class);
            return java.util.Arrays.stream(parts)
                    .filter(part -> part != null && part > 0 && part <= session.getTotalParts())
                    .distinct()
                    .sorted()
                    .collect(Collectors.toList());
        } catch (Exception e) {
            return List.of();
        }
    }

    private final class OssTempPartsInputStream extends InputStream {
        private final OssService ossService;
        private final WorkflowArtifactUploadSession session;
        private int currentPart = 1;
        private long currentPartOffset = 0;
        private byte[] buffer = new byte[0];
        private int bufferOffset = 0;

        private OssTempPartsInputStream(OssService ossService, WorkflowArtifactUploadSession session) {
            this.ossService = ossService;
            this.session = session;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int read = read(one, 0, 1);
            return read == -1 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] target, int offset, int length) throws IOException {
            if (target == null) throw new NullPointerException("target");
            if (offset < 0 || length < 0 || length > target.length - offset) {
                throw new IndexOutOfBoundsException();
            }
            if (length == 0) return 0;
            if (!ensureBuffer()) return -1;
            int copyLength = Math.min(length, buffer.length - bufferOffset);
            System.arraycopy(buffer, bufferOffset, target, offset, copyLength);
            bufferOffset += copyLength;
            return copyLength;
        }

        private boolean ensureBuffer() throws IOException {
            while (bufferOffset >= buffer.length) {
                if (currentPart > session.getTotalParts()) {
                    return false;
                }
                long partSize = expectedPartSize(session, currentPart);
                if (currentPartOffset >= partSize) {
                    currentPart++;
                    currentPartOffset = 0;
                    continue;
                }
                int limit = (int) Math.min(REMOTE_READ_CHUNK_SIZE, partSize - currentPartOffset);
                try {
                    buffer = ossService.readRange(partObjectKey(session, currentPart), currentPartOffset, limit);
                } catch (RuntimeException e) {
                    throw new IOException("Failed to read OSS temp part " + currentPart, e);
                }
                if (buffer == null || buffer.length == 0) {
                    throw new IOException("OSS temp part is missing bytes: part=" + currentPart);
                }
                currentPartOffset += buffer.length;
                bufferOffset = 0;
            }
            return true;
        }
    }

    private record StoredArtifact(String url, String objectKey, String fileName, long size, String contentType) {}
}
