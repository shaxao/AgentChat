package com.aiplatform.backend.service;

import com.aiplatform.backend.service.impl.OssServiceFactory;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;

@Slf4j
@Service
public class IconStorageService {

    private static final long MAX_ICON_BYTES = 10L * 1024 * 1024;
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ofPattern("yyyyMMdd");
    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(15))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    public String persistRemoteIcon(String remoteUrl, String nameHint) {
        if (remoteUrl == null || remoteUrl.isBlank()) return remoteUrl;
        if (!remoteUrl.startsWith("http://") && !remoteUrl.startsWith("https://")) return remoteUrl;

        var ossService = OssServiceFactory.getActive();
        if (ossService == null) {
            throw new IllegalStateException("No active OSS configuration for generated icon storage");
        }

        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(remoteUrl))
                    .timeout(Duration.ofSeconds(60))
                    .header("User-Agent", "MuHuoAi-IconCache/1.0")
                    .GET()
                    .build();
            HttpResponse<byte[]> response = httpClient.send(request, HttpResponse.BodyHandlers.ofByteArray());
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IllegalStateException("Failed to download generated icon: HTTP " + response.statusCode());
            }

            byte[] bytes = response.body();
            if (bytes == null || bytes.length == 0 || bytes.length > MAX_ICON_BYTES) {
                throw new IllegalStateException("Generated icon size is invalid: " + (bytes == null ? 0 : bytes.length));
            }

            String contentType = response.headers().firstValue("content-type").orElse("image/jpeg");
            String objectKey = buildObjectKey(nameHint, contentType);
            return ossService.uploadPublicRead(objectKey, bytes, normalizeContentType(contentType));
        } catch (Exception e) {
            log.warn("[IconStorage] Failed to persist generated icon to OSS: url={}, error={}", remoteUrl, e.getMessage());
            if (e instanceof IllegalStateException illegalStateException) {
                throw illegalStateException;
            }
            throw new IllegalStateException("Failed to persist generated icon to OSS", e);
        }
    }

    private String buildObjectKey(String nameHint, String contentType) {
        var activeCfg = OssServiceFactory.getAliyunCredential();
        String configuredBasePath = activeCfg != null ? activeCfg.getBasePath() : null;
        String basePath = configuredBasePath == null || configuredBasePath.isBlank()
                ? "generated_icons"
                : configuredBasePath.replaceAll("^/+|/+$", "") + "/generated_icons";
        return basePath + "/" + LocalDateTime.now().format(DATE_FMT)
                + "/" + UUID.randomUUID().toString().substring(0, 8)
                + "_" + sanitizeName(nameHint) + extensionFromContentType(contentType);
    }

    private String sanitizeName(String value) {
        String safe = (value == null || value.isBlank() ? "skill-icon" : value)
                .toLowerCase(Locale.ROOT)
                .replaceAll("[^a-z0-9\\u4e00-\\u9fa5]+", "-")
                .replaceAll("^-|-$", "");
        return safe.isBlank() ? "skill-icon" : safe.substring(0, Math.min(safe.length(), 48));
    }

    private String normalizeContentType(String contentType) {
        String ct = contentType == null || contentType.isBlank() ? "image/jpeg" : contentType.toLowerCase(Locale.ROOT);
        if (ct.contains(";")) ct = ct.substring(0, ct.indexOf(';')).trim();
        return ct.startsWith("image/") ? ct : "image/jpeg";
    }

    private String extensionFromContentType(String contentType) {
        String ct = normalizeContentType(contentType);
        if (ct.contains("png")) return ".png";
        if (ct.contains("webp")) return ".webp";
        if (ct.contains("gif")) return ".gif";
        if (ct.contains("svg")) return ".svg";
        return ".jpg";
    }
}
