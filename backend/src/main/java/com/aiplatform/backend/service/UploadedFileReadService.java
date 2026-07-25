package com.aiplatform.backend.service;

import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.entity.MemoryWorkFile;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.mapper.MemoryWorkFileMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.poi.ss.usermodel.DataFormatter;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.ss.usermodel.WorkbookFactory;
import org.springframework.stereotype.Service;

import java.io.ByteArrayInputStream;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.List;

@Slf4j
@Service
@RequiredArgsConstructor
public class UploadedFileReadService {

    private static final int MAX_TEXT_CHARS = 10_000;
    private static final int MAX_EXCEL_ROWS_PER_SHEET = 200;

    private final ChatConversationMapper conversationMapper;
    private final MemoryWorkFileMapper workFileMapper;

    public ReadResult readByName(Long userId, String conversationUuid, Long conversationId,
                                 String fileName, List<String> requestFileUrls) {
        try {
            if (fileName == null || fileName.isBlank()) {
                return ReadResult.failed("ARGUMENT_MISSING", "read_uploaded_file requires fileName");
            }

            ChatConversation conv = resolveConversation(userId, conversationUuid, conversationId);
            if (conv == null) {
                return ReadResult.failed("CONVERSATION_NOT_FOUND", "Conversation was not found");
            }

            String ossUrl = findWorkFileAndGetUrl(userId, conv.getId(), fileName);
            if (ossUrl == null) {
                ossUrl = findInRequestUrls(fileName, requestFileUrls);
            }
            if (ossUrl == null) {
                ossUrl = findInAllUserFiles(userId, fileName);
            }
            if (ossUrl == null || ossUrl.isBlank()) {
                return ReadResult.failed("FILE_NOT_FOUND",
                        "File \"" + fileName + "\" was not found. " + buildFileListHint(userId, conv.getId(), requestFileUrls));
            }

            byte[] data = downloadUrl(ossUrl);
            String output = parseDownloadedFile(fileName, ossUrl, data);
            return new ReadResult(true, "OK", output, ossUrl, guessMimeType(fileName), data.length);
        } catch (Exception e) {
            log.warn("[UploadedFileRead] read failed: file={}, error={}", fileName, e.getMessage());
            return ReadResult.failed("READ_UPLOADED_FILE_FAILED", "Failed to read uploaded file: " + e.getMessage());
        }
    }

    private ChatConversation resolveConversation(Long userId, String conversationUuid, Long conversationId) {
        QueryWrapper<ChatConversation> qw = new QueryWrapper<ChatConversation>()
                .eq("deleted", 0)
                .orderByDesc("id")
                .last("LIMIT 1");
        if (conversationId != null) {
            qw.eq("id", conversationId);
        } else if (conversationUuid != null && !conversationUuid.isBlank()) {
            qw.eq("uuid", conversationUuid);
        } else {
            return null;
        }
        if (userId != null) {
            qw.eq("user_id", userId);
        }
        return conversationMapper.selectOne(qw);
    }

    private String findWorkFileAndGetUrl(Long userId, Long conversationId, String fileName) {
        MemoryWorkFile wf = findWorkFile(userId, conversationId, fileName);
        if (wf != null && wf.getOssUrl() != null && !wf.getOssUrl().isBlank()) {
            return wf.getOssUrl();
        }
        return null;
    }

    private MemoryWorkFile findWorkFile(Long userId, Long conversationId, String fileName) {
        MemoryWorkFile exact = workFileMapper.selectOne(new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId)
                .eq("conversation_id", conversationId)
                .eq("file_name", fileName)
                .eq("deleted", 0)
                .orderByDesc("id")
                .last("LIMIT 1"));
        if (exact != null) return exact;

        List<MemoryWorkFile> all = workFileMapper.selectList(new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId)
                .eq("conversation_id", conversationId)
                .eq("deleted", 0));

        for (MemoryWorkFile file : all) {
            String urlName = decodeFileName(extractFileNameFromUrl(file.getOssUrl()));
            if (matchesFileName(urlName, fileName)) return file;
        }
        for (MemoryWorkFile file : all) {
            String storedName = decodeFileName(file.getFileName());
            if (matchesFileName(storedName, fileName) || matchesFileName(stripUuidPrefix(storedName), fileName)) {
                return file;
            }
        }
        return null;
    }

    private String findInRequestUrls(String fileName, List<String> requestFileUrls) {
        if (requestFileUrls == null || requestFileUrls.isEmpty()) return null;
        for (String url : requestFileUrls) {
            String urlName = decodeFileName(extractFileNameFromUrl(url));
            if (matchesFileName(urlName, fileName) || matchesFileName(stripUuidPrefix(urlName), fileName)) {
                return url;
            }
        }
        return null;
    }

    private String findInAllUserFiles(Long userId, String fileName) {
        List<MemoryWorkFile> allFiles = workFileMapper.selectList(new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId)
                .eq("deleted", 0));
        for (MemoryWorkFile file : allFiles) {
            if (file.getOssUrl() == null || file.getOssUrl().isBlank()) continue;
            String storedName = decodeFileName(file.getFileName());
            String urlName = decodeFileName(extractFileNameFromUrl(file.getOssUrl()));
            if (matchesFileName(storedName, fileName)
                    || matchesFileName(urlName, fileName)
                    || matchesFileName(stripUuidPrefix(urlName), fileName)) {
                return file.getOssUrl();
            }
        }
        return null;
    }

    private String buildFileListHint(Long userId, Long conversationId, List<String> requestFileUrls) {
        LinkedHashSet<String> names = new LinkedHashSet<>();
        List<MemoryWorkFile> convFiles = workFileMapper.selectList(new QueryWrapper<MemoryWorkFile>()
                .eq("user_id", userId)
                .eq("conversation_id", conversationId)
                .eq("deleted", 0));
        convFiles.stream()
                .map(MemoryWorkFile::getFileName)
                .filter(name -> name != null && !name.isBlank())
                .forEach(names::add);
        if (requestFileUrls != null) {
            for (String url : requestFileUrls) {
                String name = decodeFileName(extractFileNameFromUrl(url));
                if (name != null && !name.isBlank()) names.add(name + " [from request]");
            }
        }
        if (!names.isEmpty()) {
            return "Available files: " + String.join(", ", names) + ".";
        }
        return "No uploaded files are available in the current conversation.";
    }

    private byte[] downloadUrl(String url) throws Exception {
        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .GET()
                .build();
        HttpResponse<byte[]> response = client.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() != 200) {
            throw new IllegalStateException("Failed to download file: HTTP " + response.statusCode());
        }
        return response.body();
    }

    private String parseDownloadedFile(String fileName, String ossUrl, byte[] data) throws Exception {
        String lowerName = fileName.toLowerCase();
        String mimeType = guessMimeType(fileName);
        if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
            return parseExcel(data, fileName);
        }
        if (lowerName.endsWith(".csv")) {
            return truncateText(new String(data, StandardCharsets.UTF_8), data.length);
        }
        if (mimeType.startsWith("image/")) {
            return "Image file \"" + fileName + "\" (" + data.length + " bytes, " + mimeType + ")\n"
                    + "Image URL: " + ossUrl;
        }
        String text = new String(data, StandardCharsets.UTF_8);
        return truncateText(text, data.length);
    }

    private String parseExcel(byte[] data, String fileName) throws Exception {
        try (Workbook workbook = WorkbookFactory.create(new ByteArrayInputStream(data))) {
            DataFormatter formatter = new DataFormatter();
            StringBuilder sb = new StringBuilder();
            sb.append("Parsed file \"").append(fileName).append("\":\n\n");
            for (int s = 0; s < workbook.getNumberOfSheets(); s++) {
                Sheet sheet = workbook.getSheetAt(s);
                sb.append("=== Sheet: ").append(sheet.getSheetName()).append(" ===\n");
                int emitted = 0;
                for (Row row : sheet) {
                    if (emitted >= MAX_EXCEL_ROWS_PER_SHEET) break;
                    int lastCell = Math.max(row.getLastCellNum(), 0);
                    for (int c = 0; c < lastCell; c++) {
                        if (c > 0) sb.append('\t');
                        sb.append(formatter.formatCellValue(row.getCell(c)));
                    }
                    sb.append('\n');
                    emitted++;
                }
                if (sheet.getPhysicalNumberOfRows() > MAX_EXCEL_ROWS_PER_SHEET) {
                    sb.append("... (total ").append(sheet.getPhysicalNumberOfRows())
                            .append(" rows, showing first ").append(MAX_EXCEL_ROWS_PER_SHEET).append(" rows)\n");
                }
                sb.append('\n');
            }
            return sb.toString().trim();
        }
    }

    private String truncateText(String text, int byteLength) {
        if (text.length() <= MAX_TEXT_CHARS) return text;
        return text.substring(0, MAX_TEXT_CHARS)
                + "\n\n[... content truncated, original size " + byteLength + " bytes ...]";
    }

    private boolean matchesFileName(String candidate, String requested) {
        if (candidate == null || requested == null) return false;
        String a = candidate.trim();
        String b = requested.trim();
        if (a.isBlank() || b.isBlank()) return false;
        if (a.equalsIgnoreCase(b)) return true;
        if (a.replace(" ", "").equalsIgnoreCase(b.replace(" ", ""))) return true;
        return a.contains(b) || b.contains(a);
    }

    private String stripUuidPrefix(String name) {
        if (name == null) return "";
        return name.replaceFirst("^[a-fA-F0-9]{8,32}_", "");
    }

    private String decodeFileName(String rawName) {
        if (rawName == null) return null;
        try {
            return URLDecoder.decode(rawName, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return rawName;
        }
    }

    private String extractFileNameFromUrl(String url) {
        if (url == null || url.isBlank()) return null;
        try {
            String path = url.contains("?") ? url.substring(0, url.indexOf("?")) : url;
            int lastSlash = path.lastIndexOf('/');
            return lastSlash >= 0 ? path.substring(lastSlash + 1) : path;
        } catch (Exception e) {
            return null;
        }
    }

    private String guessMimeType(String fileName) {
        String name = fileName == null ? "" : fileName.toLowerCase();
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
        if (name.endsWith(".gif")) return "image/gif";
        if (name.endsWith(".webp")) return "image/webp";
        if (name.endsWith(".csv")) return "text/csv";
        if (name.endsWith(".txt") || name.endsWith(".md")) return "text/plain";
        if (name.endsWith(".pdf")) return "application/pdf";
        if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
        if (name.endsWith(".xls")) return "application/vnd.ms-excel";
        if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        return "application/octet-stream";
    }

    public record ReadResult(
            boolean success,
            String code,
            String output,
            String fileUrl,
            String mimeType,
            int byteLength
    ) {
        static ReadResult failed(String code, String output) {
            return new ReadResult(false, code, output, null, null, 0);
        }
    }
}
