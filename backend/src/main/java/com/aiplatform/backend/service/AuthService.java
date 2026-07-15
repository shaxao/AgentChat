package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.AuthDTO;
import com.aiplatform.backend.entity.Subscription;
import com.aiplatform.backend.entity.SubscriptionPlan;
import com.aiplatform.backend.entity.SysUser;
import com.aiplatform.backend.mapper.SubscriptionMapper;
import com.aiplatform.backend.mapper.SubscriptionPlanMapper;
import com.aiplatform.backend.mapper.SysUserMapper;
import com.aiplatform.backend.util.JwtUtil;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class AuthService {

    private final SysUserMapper userMapper;
    private final SubscriptionMapper subscriptionMapper;
    private final SubscriptionPlanMapper planMapper;
    private final EmailService emailService;
    private final PrivacySettingService privacySettingService;
    private final JwtUtil jwtUtil;
    private final BCryptPasswordEncoder passwordEncoder;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    /** 发送邮箱验证码。 */
    public void sendCode(String email, String scene) {
        if ("register".equals(scene)) {
            SysUser existing = userMapper.selectOne(
                    new QueryWrapper<SysUser>().eq("email", email).eq("deleted", 0).last("LIMIT 1"));
            if (existing != null) {
                throw new RuntimeException("该邮箱已注册，请直接登录");
            }
        } else if ("login".equals(scene)) {
            SysUser existing = userMapper.selectOne(
                    new QueryWrapper<SysUser>().eq("email", email).eq("deleted", 0).last("LIMIT 1"));
            if (existing == null) {
                throw new RuntimeException("邮箱或密码错误");
            }
            if (!privacySettingService.isTwoFactorAuthEnabled(existing.getId())) {
                throw new RuntimeException("该账号未开启两步验证，无需登录验证码");
            }
        } else if (!"reset".equals(scene)) {
            throw new RuntimeException("不支持的验证码场景");
        }
        emailService.sendVerifyCode(email, scene);
    }

    /** 注册。 */
    public AuthDTO.LoginResponse register(AuthDTO.RegisterRequest req) {
        if (!emailService.verifyCode(req.getEmail(), "register", req.getVerifyCode())) {
            throw new RuntimeException("验证码错误或已过期");
        }

        assertUserUnique(req.getUsername(), req.getEmail(), null);

        SysUser user = new SysUser();
        user.setUuid(UUID.randomUUID().toString());
        user.setUsername(req.getUsername());
        user.setEmail(req.getEmail());
        user.setPassword(passwordEncoder.encode(req.getPassword()));
        user.setRole("user");
        user.setPlan("free");
        user.setStatus("active");
        user.setEmailVerified(true);
        user.setTokensUsed(0L);
        user.setTokensLimit(50000L);
        userMapper.insert(user);

        createFreeSubscriptionIfMissing(user.getId());

        String token = jwtUtil.generateToken(user.getId(), user.getEmail(), user.getRole());
        return buildLoginResponse(token, user);
    }

    /** 登录。 */
    public AuthDTO.LoginResponse login(AuthDTO.LoginRequest req) {
        SysUser user = userMapper.selectOne(
                new QueryWrapper<SysUser>()
                        .eq("deleted", 0)
                        .and(w -> w.eq("email", req.getEmail()).or().eq("username", req.getEmail()))
                        .last("LIMIT 1")
        );

        if (user == null || !passwordEncoder.matches(req.getPassword(), user.getPassword())) {
            throw new RuntimeException("邮箱/用户名或密码错误");
        }

        if ("suspended".equals(user.getStatus())) {
            throw new RuntimeException("账号已被禁用，请联系管理员");
        }

        if (privacySettingService.isTwoFactorAuthEnabled(user.getId())) {
            if (!req.getEmail().equalsIgnoreCase(user.getEmail())) {
                throw new RuntimeException("两步验证已开启，请使用邮箱和邮箱验证码登录");
            }
            if (req.getVerifyCode() == null || req.getVerifyCode().isBlank()) {
                throw new RuntimeException("登录需要邮箱验证码");
            }
            if (!emailService.verifyCode(user.getEmail(), "login", req.getVerifyCode())) {
                throw new RuntimeException("邮箱验证码错误或已过期");
            }
        }

        user.setLastLoginAt(LocalDateTime.now());
        userMapper.updateById(user);

        String token = jwtUtil.generateToken(user.getId(), user.getEmail(), user.getRole());
        return buildLoginResponse(token, user);
    }

    public AuthDTO.LoginResponse loginOrCreateLinuxDoUser(String linuxDoId,
                                                          String username,
                                                          String name,
                                                          String avatarUrl,
                                                          Integer trustLevel) {
        if (linuxDoId == null || linuxDoId.isBlank()) {
            throw new RuntimeException("Linux.do 用户 ID 为空");
        }
        String syntheticEmail = "linuxdo-" + linuxDoId + "@oauth.local";
        SysUser user = userMapper.selectOne(new QueryWrapper<SysUser>()
                .eq("email", syntheticEmail)
                .eq("deleted", 0)
                .last("LIMIT 1"));

        String displayName = firstText(name, username, "linuxdo_" + linuxDoId);
        if (user == null) {
            user = new SysUser();
            user.setUuid(UUID.randomUUID().toString());
            user.setUsername(uniqueUsername(displayName, linuxDoId));
            user.setEmail(syntheticEmail);
            user.setPassword(passwordEncoder.encode(UUID.randomUUID().toString()));
            user.setAvatar(avatarUrl);
            user.setRole("user");
            user.setPlan("free");
            user.setStatus("active");
            user.setEmailVerified(true);
            user.setTokensUsed(0L);
            user.setTokensLimit(50000L);
            user.setLastLoginAt(LocalDateTime.now());
            userMapper.insert(user);
            createFreeSubscriptionIfMissing(user.getId());
        } else {
            user.setUsername(uniqueUsername(displayName, linuxDoId, user.getId()));
            if (avatarUrl != null && !avatarUrl.isBlank()) {
                user.setAvatar(avatarUrl);
            }
            user.setLastLoginAt(LocalDateTime.now());
            userMapper.updateById(user);
        }

        String token = jwtUtil.generateToken(user.getId(), user.getEmail(), user.getRole());
        return buildLoginResponse(token, user);
    }

    /** 重置密码。 */
    public void resetPassword(AuthDTO.ResetPasswordRequest req) {
        if (!emailService.verifyCode(req.getEmail(), "reset", req.getVerifyCode())) {
            throw new RuntimeException("验证码错误或已过期");
        }
        SysUser user = userMapper.selectOne(new QueryWrapper<SysUser>()
                .eq("email", req.getEmail())
                .eq("deleted", 0)
                .last("LIMIT 1"));
        if (user == null) throw new RuntimeException("用户不存在");

        user.setPassword(passwordEncoder.encode(req.getNewPassword()));
        userMapper.updateById(user);
    }

    /** 获取用户信息。 */
    public AuthDTO.UserVO getUserInfo(Long userId) {
        SysUser user = userMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");
        return toVO(user);
    }

    /** 更新个人信息。 */
    public AuthDTO.UserVO updateProfile(Long userId, String newUsername) {
        SysUser user = userMapper.selectById(userId);
        if (user == null) throw new RuntimeException("用户不存在");
        if (newUsername != null && !newUsername.isBlank()) {
            assertUserUnique(newUsername, null, userId);
            user.setUsername(newUsername);
            userMapper.updateById(user);
        }
        return toVO(user);
    }

    private void assertUserUnique(String username, String email, Long excludeUserId) {
        if (username != null && !username.isBlank()) {
            QueryWrapper<SysUser> query = new QueryWrapper<SysUser>()
                    .eq("username", username)
                    .eq("deleted", 0);
            if (excludeUserId != null) {
                query.ne("id", excludeUserId);
            }
            if (userMapper.selectOne(query.last("LIMIT 1")) != null) {
                throw new RuntimeException("用户名已存在");
            }
        }
        if (email != null && !email.isBlank()) {
            QueryWrapper<SysUser> query = new QueryWrapper<SysUser>()
                    .eq("email", email)
                    .eq("deleted", 0);
            if (excludeUserId != null) {
                query.ne("id", excludeUserId);
            }
            if (userMapper.selectOne(query.last("LIMIT 1")) != null) {
                throw new RuntimeException("邮箱已存在");
            }
        }
    }

    private AuthDTO.LoginResponse buildLoginResponse(String token, SysUser user) {
        AuthDTO.LoginResponse resp = new AuthDTO.LoginResponse();
        resp.setToken(token);
        resp.setUser(toVO(user));
        return resp;
    }

    private void createFreeSubscriptionIfMissing(Long userId) {
        Subscription existing = subscriptionMapper.selectOne(new QueryWrapper<Subscription>()
                .eq("user_id", userId)
                .eq("status", "active")
                .eq("deleted", 0)
                .last("LIMIT 1"));
        if (existing != null) return;

        SubscriptionPlan freePlan = planMapper.selectOne(
                new QueryWrapper<SubscriptionPlan>().eq("code", "free").eq("deleted", 0).eq("enabled", true));

        Subscription freeSub = new Subscription();
        freeSub.setUuid(UUID.randomUUID().toString());
        freeSub.setUserId(userId);
        freeSub.setPlan("free");
        freeSub.setPlanName("免费版");
        freeSub.setStatus("active");
        freeSub.setPrice(BigDecimal.ZERO);
        freeSub.setTokensLimit(freePlan != null ? freePlan.getTokensLimit() : 50000L);
        freeSub.setModelLimit(freePlan != null ? freePlan.getModelLimit() : null);
        freeSub.setStartDate(LocalDate.now());
        freeSub.setEndDate(LocalDate.now().plusYears(10));
        subscriptionMapper.insert(freeSub);
    }

    private String uniqueUsername(String preferred, String linuxDoId) {
        return uniqueUsername(preferred, linuxDoId, null);
    }

    private String uniqueUsername(String preferred, String linuxDoId, Long selfId) {
        String base = sanitizeUsername(firstText(preferred, "linuxdo_" + linuxDoId));
        String candidate = base;
        int suffix = 1;
        while (true) {
            QueryWrapper<SysUser> query = new QueryWrapper<SysUser>()
                    .eq("username", candidate)
                    .eq("deleted", 0);
            if (selfId != null) {
                query.ne("id", selfId);
            }
            SysUser existing = userMapper.selectOne(query.last("LIMIT 1"));
            if (existing == null) return candidate;
            candidate = base + "_" + suffix++;
        }
    }

    private String sanitizeUsername(String value) {
        String cleaned = value == null ? "" : value.trim().replaceAll("[^a-zA-Z0-9_\\u4e00-\\u9fa5-]", "_");
        if (cleaned.isBlank()) return "linuxdo_user";
        if (cleaned.length() > 40) return cleaned.substring(0, 40);
        return cleaned;
    }

    private String firstText(String... values) {
        for (String value : values) {
            if (value != null && !value.isBlank()) return value.trim();
        }
        return "";
    }

    private AuthDTO.UserVO toVO(SysUser user) {
        AuthDTO.UserVO vo = new AuthDTO.UserVO();
        vo.setId(user.getUuid() != null && !user.getUuid().isBlank()
                ? user.getUuid()
                : String.valueOf(user.getId()));
        vo.setName(user.getUsername());
        vo.setEmail(user.getEmail());
        vo.setAvatar(user.getAvatar());
        vo.setRole(user.getRole());
        vo.setPlan(user.getPlan());
        vo.setTokensUsed(user.getTokensUsed());
        vo.setTokensLimit(user.getTokensLimit());
        vo.setCostUsed(user.getCostUsed());
        vo.setCostLimit(user.getCostLimit());
        vo.setStatus(user.getStatus());
        if (user.getCreatedAt() != null) vo.setCreatedAt(user.getCreatedAt().format(FMT));

        Subscription sub = subscriptionMapper.selectOne(
                new QueryWrapper<Subscription>()
                        .eq("user_id", user.getId())
                        .eq("status", "active")
                        .eq("deleted", 0)
                        .orderByDesc("created_at")
                        .last("LIMIT 1"));
        if (sub != null && sub.getModelLimit() != null && !sub.getModelLimit().isBlank()) {
            vo.setModelLimit(sub.getModelLimit());
        }
        return vo;
    }
}
