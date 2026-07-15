package com.aiplatform.backend.util;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.util.ArrayList;
import java.util.List;

public final class ClientIpUtil {

    private static final String[] HEADERS = {
            "X-Forwarded-For",
            "X-Real-IP",
            "CF-Connecting-IP",
            "True-Client-IP",
            "X-Client-IP",
            "Forwarded"
    };

    private ClientIpUtil() {
    }

    public static String getClientIp(HttpServletRequest request) {
        if (request == null) return null;
        List<String> candidates = new ArrayList<>();
        for (String header : HEADERS) {
            String value = request.getHeader(header);
            candidates.addAll(usableIps(value, "Forwarded".equalsIgnoreCase(header)));
        }
        String remoteAddr = normalizeIp(request.getRemoteAddr());
        if (remoteAddr != null) candidates.add(remoteAddr);

        return selectBestIp(candidates);
    }

    public static boolean isPrivateOrLocal(String ip) {
        if (ip == null || ip.isBlank()) return true;
        try {
            InetAddress address = InetAddress.getByName(ip);
            return address.isAnyLocalAddress()
                    || address.isLoopbackAddress()
                    || address.isLinkLocalAddress()
                    || address.isSiteLocalAddress();
        } catch (Exception ignored) {
            return ip.startsWith("127.")
                    || ip.startsWith("10.")
                    || ip.startsWith("192.168.")
                    || ip.matches("^172\\.(1[6-9]|2\\d|3[0-1])\\..*")
                    || "::1".equals(ip)
                    || "0:0:0:0:0:0:0:1".equals(ip);
        }
    }

    private static String selectBestIp(List<String> candidates) {
        if (candidates == null || candidates.isEmpty()) return null;
        for (String candidate : candidates) {
            if (!isPrivateOrLocal(candidate)) return candidate;
        }
        return candidates.get(0);
    }

    private static List<String> usableIps(String raw, boolean forwardedHeader) {
        List<String> ips = new ArrayList<>();
        if (raw == null || raw.isBlank()) return ips;
        String value = raw.trim();
        if (forwardedHeader) {
            for (String part : value.split(";|,")) {
                String item = part.trim();
                if (item.toLowerCase().startsWith("for=")) {
                    String ip = normalizeIp(item.substring(4));
                    if (ip != null && !isUnknown(ip)) ips.add(ip);
                }
            }
            return ips;
        }
        for (String part : value.split(",")) {
            String ip = normalizeIp(part);
            if (ip != null && !isUnknown(ip)) ips.add(ip);
        }
        return ips;
    }

    private static String normalizeIp(String raw) {
        if (raw == null) return null;
        String ip = raw.trim();
        if (ip.isEmpty() || isUnknown(ip)) return null;
        if (ip.startsWith("\"") && ip.endsWith("\"") && ip.length() > 1) {
            ip = ip.substring(1, ip.length() - 1);
        }
        if (ip.startsWith("[") && ip.contains("]")) {
            ip = ip.substring(1, ip.indexOf(']'));
        } else {
            int colon = ip.indexOf(':');
            if (colon > 0 && ip.indexOf(':', colon + 1) < 0) {
                ip = ip.substring(0, colon);
            }
        }
        return ip;
    }

    private static boolean isUnknown(String value) {
        return "unknown".equalsIgnoreCase(value) || "null".equalsIgnoreCase(value);
    }
}
