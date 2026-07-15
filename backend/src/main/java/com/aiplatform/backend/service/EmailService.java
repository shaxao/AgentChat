package com.aiplatform.backend.service;

import com.aiplatform.backend.util.CodeUtil;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.mail.javamail.JavaMailSender;
import org.springframework.mail.javamail.MimeMessageHelper;
import org.springframework.scheduling.annotation.Async;
import org.springframework.stereotype.Service;

import jakarta.mail.MessagingException;
import jakarta.mail.internet.MimeMessage;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class EmailService {

    private final JavaMailSender mailSender;
    private final StringRedisTemplate redisTemplate;

    @Value("${app.mail.from}")
    private String from;

    @Value("${verify.code.expire:300}")
    private int codeExpire;

    private static final String REDIS_KEY_PREFIX = "verify:code:";
    private static final String RATE_LIMIT_PREFIX = "verify:rate:";

    // 内存降级存储（Redis 不可用时使用）
    private final Map<String, String> memoryCodeStore = new ConcurrentHashMap<>();
    private final Map<String, Long> memoryRateLimit = new ConcurrentHashMap<>();

    public void sendVerifyCode(String email, String scene) {
        String rateLimitKey = RATE_LIMIT_PREFIX + email;
        String codeKey = REDIS_KEY_PREFIX + scene + ":" + email;
        String code = CodeUtil.generateCode6();

        try {
            // 尝试使用 Redis
            if (Boolean.TRUE.equals(redisTemplate.hasKey(rateLimitKey))) {
                throw new RuntimeException("发送太频繁，请 60 秒后再试");
            }
            redisTemplate.opsForValue().set(codeKey, code, codeExpire, TimeUnit.SECONDS);
            redisTemplate.opsForValue().set(rateLimitKey, "1", 60, TimeUnit.SECONDS);
            log.info("验证码已存入 Redis: {} -> {}", email, code);
        } catch (RuntimeException e) {
            if (e.getMessage() != null && e.getMessage().contains("发送太频繁")) throw e;
            // Redis 不可用，降级到内存存储
            log.warn("Redis 不可用，降级到内存存储验证码: {}", e.getMessage());
            Long lastSent = memoryRateLimit.get(rateLimitKey);
            if (lastSent != null && System.currentTimeMillis() - lastSent < 60_000) {
                throw new RuntimeException("发送太频繁，请 60 秒后再试");
            }
            memoryCodeStore.put(codeKey, code);
            memoryRateLimit.put(rateLimitKey, System.currentTimeMillis());
            // 定时清理（简单实现）
            new Thread(() -> {
                try { Thread.sleep(codeExpire * 1000L); memoryCodeStore.remove(codeKey); } catch (InterruptedException ignored) {}
            }).start();
        }

        // 异步发送邮件（失败不影响主流程）
        sendEmailAsync(email, scene, code);
        log.info("验证码: {} -> {} ({})", email, code, scene);
    }

    public boolean verifyCode(String email, String scene, String code) {
        String redisKey = REDIS_KEY_PREFIX + scene + ":" + email;
        try {
            String savedCode = redisTemplate.opsForValue().get(redisKey);
            if (savedCode != null && savedCode.equals(code)) {
                redisTemplate.delete(redisKey);
                return true;
            }
        } catch (Exception e) {
            // Redis 不可用，从内存验证
            log.warn("Redis 不可用，从内存验证验证码");
            String savedCode = memoryCodeStore.get(redisKey);
            if (savedCode != null && savedCode.equals(code)) {
                memoryCodeStore.remove(redisKey);
                return true;
            }
        }
        return false;
    }

    @Async
    protected void sendEmailAsync(String to, String scene, String code) {
        try {
            MimeMessage message = mailSender.createMimeMessage();
            MimeMessageHelper helper = new MimeMessageHelper(message, true, "UTF-8");
            helper.setFrom(from);
            helper.setTo(to);
            String subject;
            String action;
            if ("register".equals(scene)) {
                subject = "【AI Chat Platform】注册验证码";
                action = "注册账号";
            } else if ("login".equals(scene)) {
                subject = "【AI Chat Platform】登录验证码";
                action = "登录账号";
            } else {
                subject = "【AI Chat Platform】密码重置验证码";
                action = "重置密码";
            }
            helper.setSubject(subject);
            helper.setText(buildEmailHtml(code, action, codeExpire / 60), true);
            mailSender.send(message);
            log.info("验证码邮件发送成功: {}", to);
        } catch (Exception e) {
            log.error("邮件发送失败（不影响验证码功能）: {}", e.getMessage());
        }
    }

//    private String buildEmailHtml(String code, String action, int expireMinutes) {
//        return """
//                <!DOCTYPE html>
//                <html>
//                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 40px;">
//                  <div style="max-width: 480px; margin: 0 auto; background: #fff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.08);">
//                    <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 32px; text-align: center;">
//                      <h1 style="color: #fff; margin: 0; font-size: 24px;">木火智能对话</h1>
//                    </div>
//                    <div style="padding: 40px;">
//                      <h2 style="color: #1a1a1a; margin-top: 0;">您的%s验证码</h2>
//                      <p style="color: #666; font-size: 15px;">请使用以下验证码完成%s操作：</p>
//                      <div style="background: #f8f7ff; border: 2px dashed #6366f1; border-radius: 12px; padding: 20px; text-align: center; margin: 24px 0;">
//                        <span style="font-size: 40px; font-weight: bold; color: #6366f1; letter-spacing: 12px;">%s</span>
//                      </div>
//                      <p style="color: #999; font-size: 13px;">验证码有效期 <strong>%d 分钟</strong>，请勿泄露给他人。</p>
//                      <p style="color: #999; font-size: 13px;">如非本人操作，请忽略此邮件。</p>
//                    </div>
//                    <div style="background: #f8f8f8; padding: 16px; text-align: center;">
//                      <p style="color: #bbb; font-size: 12px; margin: 0;">© 2024 AI Chat Platform. All rights reserved.</p>
//                    </div>
//                  </div>
//                </body>
//                </html>
//                """.formatted(action, action, code, expireMinutes);
//    }


    private String buildEmailHtml(String code, String action, int expireMinutes) {
        return """
            <!DOCTYPE html>
            <html>
            <body style="margin:0; padding:40px 16px; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif; background:#0b1020;">
              <div style="max-width:520px; margin:0 auto; background:#111827; border:1px solid rgba(148,163,184,0.24); border-radius:20px; overflow:hidden; box-shadow:0 24px 80px rgba(0,0,0,0.35);">

                <div style="position:relative; padding:36px 32px 34px; text-align:center; background:linear-gradient(135deg,#0f172a 0%%,#111827 45%%,#1e1b4b 100%%); border-bottom:1px solid rgba(148,163,184,0.18);">
                  <div style="position:absolute; left:32px; top:28px; width:8px; height:8px; background:#38bdf8; border-radius:50%%; box-shadow:36px 18px 0 #6366f1,72px -4px 0 #22d3ee,112px 22px 0 #a78bfa;"></div>
                  <div style="position:absolute; right:34px; bottom:30px; width:7px; height:7px; background:#a78bfa; border-radius:50%%; box-shadow:-34px -16px 0 #38bdf8,-76px 6px 0 #6366f1;"></div>

                  <div style="display:inline-block; padding:8px 14px; margin-bottom:16px; color:#67e8f9; font-size:12px; letter-spacing:2px; border:1px solid rgba(103,232,249,0.35); border-radius:999px; background:rgba(15,23,42,0.72);">
                    智能安全验证
                  </div>

                  <h1 style="margin:0; color:#f8fafc; font-size:26px; font-weight:700; letter-spacing:0.5px;">
                    木火智能对话
                  </h1>
                  <p style="margin:12px 0 0; color:#94a3b8; font-size:14px; line-height:1.7;">
                    人工智能安全校验 · 身份确认
                  </p>
                </div>

                <div style="padding:40px 34px 36px; background:linear-gradient(180deg,#111827 0%%,#0f172a 100%%);">
                  <h2 style="margin:0 0 14px; color:#e5e7eb; font-size:22px; font-weight:700;">
                    您的%s验证码
                  </h2>

                  <p style="margin:0; color:#94a3b8; font-size:15px; line-height:1.8;">
                    请使用以下验证码完成%s操作。该验证码由系统安全模块生成，用于确认本次请求的真实性。
                  </p>

                  <div style="margin:30px 0; padding:24px 18px; text-align:center; border-radius:16px; background:rgba(15,23,42,0.9); border:1px solid rgba(56,189,248,0.38); box-shadow:inset 0 0 0 1px rgba(99,102,241,0.16),0 0 32px rgba(56,189,248,0.12);">
                    <div style="margin-bottom:10px; color:#64748b; font-size:12px; letter-spacing:2px;">
                      本次验证码
                    </div>
                    <span style="display:inline-block; color:#67e8f9; font-size:42px; line-height:1; font-weight:800; letter-spacing:12px; text-shadow:0 0 18px rgba(103,232,249,0.36);">
                      %s
                    </span>
                  </div>

                  <div style="padding:16px 18px; border-radius:14px; background:rgba(30,41,59,0.62); border:1px solid rgba(148,163,184,0.16);">
                    <p style="margin:0 0 8px; color:#cbd5e1; font-size:13px; line-height:1.7;">
                      验证码有效期 <strong style="color:#f8fafc;">%d 分钟</strong>，请尽快完成验证。
                    </p>
                    <p style="margin:0; color:#94a3b8; font-size:13px; line-height:1.7;">
                      请勿将验证码泄露给他人。如非本人操作，请忽略此邮件。
                    </p>
                  </div>
                </div>

                <div style="padding:18px 24px; text-align:center; background:#0b1020; border-top:1px solid rgba(148,163,184,0.14);">
                  <p style="margin:0; color:#64748b; font-size:12px; line-height:1.6;">
                    © 2024 木火智能对话。保留所有权利。
                  </p>
                </div>

              </div>
            </body>
            </html>
            """.formatted(action, action, code, expireMinutes);
    }
}
