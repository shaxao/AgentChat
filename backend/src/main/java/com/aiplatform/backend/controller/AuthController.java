package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.AuthDTO;
import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.service.AuthService;
import com.aiplatform.backend.service.LinuxDoOAuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

import java.io.IOException;

@RestController
@RequestMapping("/api/auth")
@RequiredArgsConstructor
public class AuthController {

    private final AuthService authService;
    private final LinuxDoOAuthService linuxDoOAuthService;

    /** 发送邮箱验证码。 */
    @PostMapping("/send-code")
    public Result<String> sendCode(@Valid @RequestBody AuthDTO.SendCodeRequest req) {
        authService.sendCode(req.getEmail(), req.getScene());
        return Result.ok("验证码已发送至 " + req.getEmail() + "，请注意查收");
    }

    /** 注册。 */
    @PostMapping("/register")
    public Result<AuthDTO.LoginResponse> register(@Valid @RequestBody AuthDTO.RegisterRequest req) {
        AuthDTO.LoginResponse resp = authService.register(req);
        return Result.ok(resp);
    }

    /** 登录。 */
    @PostMapping("/login")
    public Result<AuthDTO.LoginResponse> login(@Valid @RequestBody AuthDTO.LoginRequest req) {
        AuthDTO.LoginResponse resp = authService.login(req);
        return Result.ok(resp);
    }

    @GetMapping("/oauth/linuxdo/authorize")
    public void linuxDoAuthorize(HttpServletRequest request, HttpServletResponse response) throws IOException {
        response.sendRedirect(linuxDoOAuthService.buildAuthorizeUrl(request));
    }

    @GetMapping("/oauth/linuxdo/callback")
    public void linuxDoCallback(@RequestParam(required = false) String code,
                                HttpServletRequest request,
                                HttpServletResponse response) throws IOException {
        AuthDTO.LoginResponse login = linuxDoOAuthService.handleCallback(code, request);
        response.sendRedirect(linuxDoOAuthService.buildFrontendRedirect(login, request));
    }

    /** 重置密码。 */
    @PostMapping("/reset-password")
    public Result<String> resetPassword(@Valid @RequestBody AuthDTO.ResetPasswordRequest req) {
        authService.resetPassword(req);
        return Result.ok("密码重置成功，请重新登录");
    }

    /** 获取当前用户信息。 */
    @GetMapping("/me")
    public Result<AuthDTO.UserVO> me(@RequestAttribute Long userId) {
        return Result.ok(authService.getUserInfo(userId));
    }

    /** 更新个人信息。 */
    @PutMapping("/profile")
    public Result<AuthDTO.UserVO> updateProfile(
            @RequestAttribute Long userId,
            @RequestBody java.util.Map<String, String> body) {
        return Result.ok(authService.updateProfile(userId, body.get("name")));
    }
}
