package com.aiplatform.backend.service.provider;

import java.util.List;

public interface SearchAdapter {

    SearchResponse search(String baseUrl, String apiKey, String query, int docCount,
                          int maxSnippetLength, int maxImageCountPerDoc) throws Exception;

    record SearchResponse(
            String query,
            String provider,
            int total,
            List<SearchDocument> documents,
            String requestId,
            String errorCode,
            String errorMessage
    ) {}

    record SearchDocument(
            int rank,
            String title,
            String url,
            String snippet,
            List<SearchImage> images,
            SearchHost host,
            String publishTime,
            String fileType,
            int contentCharCount,
            int contentTokenCount
    ) {}

    record SearchImage(String url, String alt, int width, int height) {}

    record SearchHost(String hostname, String iconUrl) {}
}
