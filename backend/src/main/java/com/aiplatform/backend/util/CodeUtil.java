package com.aiplatform.backend.util;

import java.security.SecureRandom;

public class CodeUtil {
    private static final SecureRandom RANDOM = new SecureRandom();

    /** 生成 N 位数字验证码 */
    public static String generateNumericCode(int length) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < length; i++) {
            sb.append(RANDOM.nextInt(10));
        }
        return sb.toString();
    }

    public static String generateCode6() {
        return generateNumericCode(6);
    }
}
