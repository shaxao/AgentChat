package com.aiplatform.backend.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import lombok.Data;

public class AuthDTO {

    @Data
    public static class RegisterRequest {
        @NotBlank(message = "用户名不能为空")
        @Size(min = 2, max = 20, message = "用户名长度为 2-20 位")
        private String username;

        @NotBlank(message = "邮箱不能为空")
        @Email(message = "邮箱格式不正确")
        private String email;

        @NotBlank(message = "密码不能为空")
        @Size(min = 8, max = 32, message = "密码长度为 8-32 位")
        private String password;

        @NotBlank(message = "验证码不能为空")
        @Size(min = 6, max = 6, message = "验证码为 6 位")
        private String verifyCode;
    }

    @Data
    public static class LoginRequest {
        @NotBlank(message = "邮箱/用户名不能为空")
        private String email;

        @NotBlank(message = "密码不能为空")
        private String password;

        private String verifyCode;
    }

    @Data
    public static class SendCodeRequest {
        @NotBlank(message = "邮箱不能为空")
        @Email(message = "邮箱格式不正确")
        private String email;

        /** register / reset / login */
        @NotBlank(message = "场景不能为空")
        private String scene;
    }

    @Data
    public static class ResetPasswordRequest {
        @NotBlank(message = "邮箱不能为空")
        @Email(message = "邮箱格式不正确")
        private String email;

        @NotBlank(message = "验证码不能为空")
        @Size(min = 6, max = 6, message = "验证码为 6 位")
        private String verifyCode;

        @NotBlank(message = "新密码不能为空")
        @Size(min = 8, max = 32, message = "密码长度为 8-32 位")
        private String newPassword;
    }

    @Data
    public static class LoginResponse {
        private String token;
        private UserVO user;
    }

    @Data
    public static class UserVO {
        private String id;
        private String name;
        private String email;
        private String avatar;
        private String role;
        private String plan;
        private Long tokensUsed;
        private Long tokensLimit;
        private java.math.BigDecimal costUsed;
        private java.math.BigDecimal costLimit;
        private String createdAt;
        private String status;
        /** 当前订阅的模型限制，逗号分隔，空表示不限。 */
        private String modelLimit;
    }
}
