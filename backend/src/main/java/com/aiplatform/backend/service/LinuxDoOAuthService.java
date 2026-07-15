package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.AuthDTO;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class LinuxDoOAuthService {

    private final ObjectMapper objectMapper;
    private final AuthService authService;

    @Value("${app.oauth.linuxdo.client-id:${LINUXDO_OAUTH_CLIENT_ID:}}")
    private String clientId;

    @Value("${app.oauth.linuxdo.client-secret:${LINUXDO_OAUTH_CLIENT_SECRET:}}")
    private String clientSecret;

    @Value("${app.oauth.linuxdo.redirect-uri:${LINUXDO_OAUTH_REDIRECT_URI:}}")
    private String redirectUri;

    @Value("${app.oauth.linuxdo.frontend-success-url:${LINUXDO_OAUTH_FRONTEND_SUCCESS_URL:}}")
    private String frontendSuccessUrl;

    @Value("${app.oauth.linuxdo.authorize-endpoint:${LINUXDO_OAUTH_AUTHORIZE_ENDPOINT:https://connect.linux.do/oauth2/authorize}}")
    private String authorizeEndpoint;

    @Value("${app.oauth.linuxdo.token-endpoint:${LINUXDO_OAUTH_TOKEN_ENDPOINT:https://connect.linuxdo.org/oauth2/token}}")
    private String tokenEndpoint;

    @Value("${app.oauth.linuxdo.userinfo-endpoint:${LINUXDO_OAUTH_USERINFO_ENDPOINT:https://connect.linuxdo.org/api/user}}")
    private String userInfoEndpoint;

    private final HttpClient httpClient = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(10))
            .build();

    public String buildAuthorizeUrl(HttpServletRequest request) {
        requireConfigured();
        String state = UUID.randomUUID().toString().replace("-", "");
        return authorizeEndpoint
                + "?response_type=code"
                + "&client_id=" + enc(clientId)
                + "&redirect_uri=" + enc(resolveRedirectUri(request))
                + "&scope=" + enc("openid profile email")
                + "&state=" + enc(state);
    }

    public AuthDTO.LoginResponse handleCallback(String code, HttpServletRequest request) {
        requireConfigured();
        if (code == null || code.isBlank()) {
            throw new RuntimeException("Linux.do OAuth code 为空");
        }
        try {
            String accessToken = exchangeToken(code, resolveRedirectUri(request));
            JsonNode user = fetchUser(accessToken);
            if (user.path("active").isBoolean() && !user.path("active").asBoolean()) {
                throw new RuntimeException("Linux.do 账号未激活");
            }
            if (user.path("silenced").isBoolean() && user.path("silenced").asBoolean()) {
                throw new RuntimeException("Linux.do 账号已被禁言，暂不可登录");
            }
            return authService.loginOrCreateLinuxDoUser(
                    user.path("id").asText(null),
                    user.path("username").asText(null),
                    user.path("name").asText(null),
                    user.path("avatar_url").asText(null),
                    user.path("trust_level").isMissingNode() ? null : user.path("trust_level").asInt());
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Linux.do OAuth 登录失败: " + e.getMessage(), e);
        }
    }

    public String buildFrontendRedirect(AuthDTO.LoginResponse login, HttpServletRequest request) {
        String base = frontendSuccessUrl;
        if (base == null || base.isBlank()) {
            base = origin(request);
        }
        return trimRight(base, "/") + "/login?oauth_token=" + enc(login.getToken());
    }

    private String exchangeToken(String code, String callbackUri) throws Exception {
        String form = "grant_type=authorization_code"
                + "&code=" + enc(code)
                + "&redirect_uri=" + enc(callbackUri)
                + "&client_id=" + enc(clientId)
                + "&client_secret=" + enc(clientSecret);
        HttpRequest request = HttpRequest.newBuilder(URI.create(tokenEndpoint))
                .timeout(Duration.ofSeconds(20))
                .header("Content-Type", "application/x-www-form-urlencoded")
                .POST(HttpRequest.BodyPublishers.ofString(form, StandardCharsets.UTF_8))
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode root = objectMapper.readTree(response.body());
        String token = root.path("access_token").asText(null);
        if (token == null || token.isBlank()) {
            throw new RuntimeException("Linux.do token 获取失败: " + response.body());
        }
        return token;
    }

    private JsonNode fetchUser(String accessToken) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(userInfoEndpoint))
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + accessToken)
                .GET()
                .build();
        HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode root = objectMapper.readTree(response.body());
        if (root.path("id").isMissingNode()) {
            throw new RuntimeException("Linux.do 用户信息获取失败: " + response.body());
        }
        return root;
    }

    private String resolveRedirectUri(HttpServletRequest request) {
        if (redirectUri != null && !redirectUri.isBlank()) return redirectUri;
        return origin(request) + "/api/auth/oauth/linuxdo/callback";
    }

    private String origin(HttpServletRequest request) {
        String proto = firstHeader(request, "X-Forwarded-Proto", request.getScheme());
        String host = firstHeader(request, "X-Forwarded-Host", request.getHeader("Host"));
        if (host == null || host.isBlank()) {
            host = request.getServerName() + (request.getServerPort() > 0 ? ":" + request.getServerPort() : "");
        }
        return proto + "://" + host;
    }

    private String firstHeader(HttpServletRequest request, String name, String fallback) {
        String value = request.getHeader(name);
        if (value != null && value.contains(",")) value = value.split(",")[0].trim();
        return value != null && !value.isBlank() ? value : fallback;
    }

    private void requireConfigured() {
        if (clientId == null || clientId.isBlank() || clientSecret == null || clientSecret.isBlank()) {
            throw new RuntimeException("Linux.do OAuth 未配置 client id / client secret");
        }
    }

    private String trimRight(String value, String suffix) {
        String result = value;
        while (result.endsWith(suffix)) result = result.substring(0, result.length() - suffix.length());
        return result;
    }

    private String enc(String value) {
        return URLEncoder.encode(value != null ? value : "", StandardCharsets.UTF_8);
    }
}
