package com.aiplatform.backend.service.provider.doubao;

import com.aiplatform.backend.service.provider.SearchAdapter;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

public class DoubaoSearchAdapter implements SearchAdapter {

    private static final String DEFAULT_URL = "https://open.feedcoopapi.com/search_api/global_search";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Override
    public SearchResponse search(String baseUrl, String apiKey, String query, int docCount,
                                 int maxSnippetLength, int maxImageCountPerDoc) throws Exception {
        String url = normalizeUrl(baseUrl);
        ObjectNode body = MAPPER.createObjectNode();
        body.put("Query", query);
        body.put("DocCount", Math.max(1, Math.min(docCount, 20)));
        body.put("MaxSnippetLength", Math.max(1, Math.min(maxSnippetLength, 3000)));
        body.put("MaxImageCountPerDoc", Math.max(0, Math.min(maxImageCountPerDoc, 10)));

        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(url))
                .timeout(Duration.ofSeconds(30))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + firstApiKey(apiKey))
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();

        HttpClient client = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build();
        HttpResponse<String> response = client.send(request, HttpResponse.BodyHandlers.ofString());
        JsonNode root = MAPPER.readTree(response.body());
        String requestId = root.path("ResponseMetadata").path("RequestId").asText("");

        if (response.statusCode() != 200 || root.path("ResponseMetadata").has("Error")) {
            JsonNode err = root.path("ResponseMetadata").path("Error");
            String code = err.path("Code").asText(String.valueOf(response.statusCode()));
            String msg = err.path("Message").asText(response.body());
            return new SearchResponse(query, "doubao", 0, List.of(), requestId, code, msg);
        }

        JsonNode result = root.path("Result");
        String errorCode = result.path("ErrorCode").asText("");
        String errorMessage = result.path("ErrorMsg").asText("");
        if (!errorCode.isBlank() && !"0".equals(errorCode)) {
            return new SearchResponse(query, "doubao", 0, List.of(), requestId, errorCode, errorMessage);
        }

        List<SearchDocument> documents = new ArrayList<>();
        for (JsonNode doc : result.path("Documents")) {
            documents.add(parseDocument(doc));
        }
        return new SearchResponse(query, "doubao", result.path("TotalDocCount").asInt(documents.size()),
                documents, requestId, errorCode, errorMessage);
    }

    private SearchDocument parseDocument(JsonNode doc) {
        List<String> textParts = new ArrayList<>();
        List<SearchImage> images = new ArrayList<>();
        for (JsonNode block : doc.path("Snippet")) {
            String type = block.path("Type").asText("");
            if ("text".equalsIgnoreCase(type)) {
                String text = block.path("Text").asText("");
                if (!text.isBlank()) textParts.add(text.trim());
            } else if ("image".equalsIgnoreCase(type)) {
                JsonNode img = block.path("Image");
                String imageUrl = img.path("ImageUrl").asText("");
                if (!imageUrl.isBlank()) {
                    images.add(new SearchImage(imageUrl, img.path("Alt").asText(""),
                            img.path("Width").asInt(0), img.path("Height").asInt(0)));
                }
            }
        }
        JsonNode host = doc.path("HostInfo");
        JsonNode info = doc.path("DocumentInfo");
        return new SearchDocument(
                doc.path("Rank").asInt(0),
                doc.path("Title").asText(""),
                doc.path("Url").asText(""),
                String.join("\n", textParts),
                images,
                new SearchHost(host.path("Hostname").asText(""), host.path("IconUrl").asText("")),
                info.path("PublishTime").asText(""),
                info.path("Filetype").asText(""),
                info.path("ContentCharCount").asInt(0),
                info.path("ContentTokenCount").asInt(0)
        );
    }

    private String normalizeUrl(String baseUrl) {
        if (baseUrl == null || baseUrl.isBlank()) return DEFAULT_URL;
        String b = baseUrl.trim();
        if (b.endsWith("/global_search")) return b;
        return b.replaceAll("/+$", "") + "/global_search";
    }

    private String firstApiKey(String apiKey) {
        if (apiKey == null) return "";
        for (String part : apiKey.split(",")) {
            String key = part.trim();
            if (!key.isBlank()) return key;
        }
        return apiKey.trim();
    }
}
