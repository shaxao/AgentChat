package com.aiplatform.backend.controller;

import com.aiplatform.backend.dto.Result;
import com.aiplatform.backend.entity.ModelChannel;
import com.aiplatform.backend.mapper.ModelChannelMapper;
import com.aiplatform.backend.service.AiService;
import com.aiplatform.backend.service.UsageTrackingService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;

import java.util.*;

/**
 * 翻译 & TTS 工具接口（使用专用渠道，计入用量统计）
 */
@Slf4j
@RestController
@RequestMapping("/api/util")
@RequiredArgsConstructor
public class UtilController {

    private final AiService aiService;
    private final ModelChannelMapper channelMapper;
    private final UsageTrackingService usageTrackingService;

    /**
     * AI 翻译（使用 translate 类型渠道）
     * POST /api/util/translate
     * body: { text, targetLang }
     */
    @PostMapping("/translate")
    public Result<String> translate(
            @RequestAttribute Long userId,
            @RequestBody Map<String, String> body) {
        String text = body.get("text");
        String targetLang = body.getOrDefault("targetLang", "英文");
        if (text == null || text.isBlank()) return Result.fail(400, "text 不能为空");

        long start = System.currentTimeMillis();
        try {
            AiService.AiResult result = aiService.translateWithChannel(text, targetLang);
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFull(userId, result.model(), result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                    latency, "translate", null);
            return Result.ok(result.content());
        } catch (Exception e) {
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFailure(userId, "translate", 0, 0, latency, "translate", e.getMessage());
            log.warn("翻译失败: {}", e.getMessage());
            return Result.fail(503, "翻译服务不可用: " + e.getMessage());
        }
    }

    /**
     * AI TTS（使用 tts 类型渠道），返回 base64 MP3
     * POST /api/util/tts
     * body: { text, voice?, channelId? }
     *   - channelId: 可选，传则使用指定渠道（从音色配置反查）；不传则自动选择 tts 类型渠道
     */
    @PostMapping("/tts")
    public Result<String> tts(
            @RequestAttribute Long userId,
            @RequestBody Map<String, String> body) {
        String text = body.get("text");
        String voice = body.getOrDefault("voice", "alloy");
        String channelIdStr = body.get("channelId");
        if (text == null || text.isBlank()) return Result.fail(400, "text 不能为空");

        String cleanText = text.replaceAll("[#*`>]", "").trim();
        if (cleanText.length() > 4096) cleanText = cleanText.substring(0, 4096);

        long start = System.currentTimeMillis();
        try {
            String audioBase64;
            if (channelIdStr != null && !channelIdStr.isBlank()) {
                audioBase64 = aiService.textToSpeechByChannelIdentifier(channelIdStr, cleanText, voice);
            } else {
                audioBase64 = aiService.textToSpeechWithChannel(cleanText, voice);
            }
            int latency = (int) (System.currentTimeMillis() - start);
            int estimatedTokens = Math.max(1, cleanText.length());
            usageTrackingService.trackFull(userId, "tts", estimatedTokens, 0, latency, "tts", null);
            return Result.ok(audioBase64);
        } catch (Exception e) {
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFailure(userId, "tts", 0, 0, latency, "tts", e.getMessage());
            log.warn("TTS 失败: {}", e.getMessage());
            return Result.fail(503, "TTS 服务不可用: " + e.getMessage());
        }
    }

    // ====== TTS 音色 / 翻译语言 动态配置端点 ======

    /**
     * 获取当前激活的 TTS 渠道配置的音色列表（支持多渠道）
     * GET /api/util/tts/voices
     * 返回: {
     *   channels: [{ channelId, name, provider, voices: [{ id, label }] }],  // 所有 TTS 渠道（按 priority 排序）
     *   voices: [...],      // 向后兼容：第一个渠道的音色
     *   channelId: "..."     // 向后兼容：第一个渠道的 ID
     * }
     * 前端按渠道分组展示音色，选择时传递对应 channelId
     */
    @GetMapping("/tts/voices")
    public Result<Map<String, Object>> getTtsVoices() {
        try {
            List<ModelChannel> channels = channelMapper.selectList(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelChannel>()
                            .eq("channel_type", "tts")
                            .eq("status", "active")
                            .eq("deleted", 0)
                            .orderByAsc("priority")
            );
            Map<String, Object> result = new java.util.HashMap<>();
            // 构建多渠道音色列表
            List<Map<String, Object>> channelList = new java.util.ArrayList<>();
            String firstChannelId = "";
            List<Map<String, String>> firstVoices = List.of();
            for (ModelChannel ch : channels) {
                String cId = ch.getUuid() != null && !ch.getUuid().isBlank() ? ch.getUuid() : String.valueOf(ch.getId());
                if (firstChannelId.isEmpty()) firstChannelId = cId;
                Map<String, Object> cInfo = new java.util.HashMap<>();
                cInfo.put("channelId", cId);
                cInfo.put("name", ch.getName());
                cInfo.put("provider", ch.getProvider());
                List<Map<String, String>> voices = List.of();
                if (ch.getTtsVoices() != null && !ch.getTtsVoices().isBlank()) {
                    try {
                        voices = OBJECT_MAPPER.readValue(ch.getTtsVoices(),
                                OBJECT_MAPPER.getTypeFactory().constructCollectionType(List.class,
                                        OBJECT_MAPPER.getTypeFactory().constructMapType(Map.class, String.class, String.class)));
                    } catch (Exception ignored) { /* 单个渠道解析失败跳过 */ }
                }
                cInfo.put("voices", voices);
                channelList.add(cInfo);
                if (firstVoices.isEmpty() && !voices.isEmpty()) firstVoices = voices;
            }
            result.put("channels", channelList);       // 多渠道数据（新前端使用）
            result.put("voices", firstVoices);         // 向后兼容
            result.put("channelId", firstChannelId);   // 向后兼容
            return Result.ok(result);
        } catch (Exception e) {
            log.warn("获取 TTS 音色列表失败: {}", e.getMessage());
            Map<String, Object> result = new java.util.HashMap<>();
            result.put("channels", List.of());
            result.put("voices", List.of());
            result.put("channelId", "");
            return Result.ok(result);
        }
    }

    /**
     * 获取当前激活的翻译渠道配置的支持语言列表
     * GET /api/util/translate/langs
     * 返回: { langs: [{ code, label }] }
     */
    @GetMapping("/translate/langs")
    public Result<List<Map<String, String>>> getTranslateLangs() {
        try {
            List<ModelChannel> channels = channelMapper.selectList(
                    new com.baomidou.mybatisplus.core.conditions.query.QueryWrapper<ModelChannel>()
                            .eq("channel_type", "translate")
                            .eq("status", "active")
                            .eq("deleted", 0)
                            .orderByAsc("priority")
            );
            if (channels.isEmpty()) {
                // 未配置翻译渠道，返回默认语言列表
                return Result.ok(getDefaultTranslateLangs());
            }
            ModelChannel ch = channels.get(0);
            if (ch.getTranslateLangs() == null || ch.getTranslateLangs().isBlank()) {
                return Result.ok(getDefaultTranslateLangs());
            }
            List<Map<String, String>> langs = OBJECT_MAPPER.readValue(ch.getTranslateLangs(),
                    OBJECT_MAPPER.getTypeFactory().constructCollectionType(List.class,
                            OBJECT_MAPPER.getTypeFactory().constructMapType(Map.class, String.class, String.class)));
            return Result.ok(langs);
        } catch (Exception e) {
            log.warn("获取翻译语言列表失败: {}", e.getMessage());
            return Result.ok(getDefaultTranslateLangs());
        }
    }

    private List<Map<String, String>> getDefaultTranslateLangs() {
        return List.of(
                Map.of("code", "英文", "label", "🇺🇸 英文"),
                Map.of("code", "日文", "label", "🇯🇵 日文"),
                Map.of("code", "韩文", "label", "🇰🇷 韩文"),
                Map.of("code", "法文", "label", "🇫🇷 法文"),
                Map.of("code", "德文", "label", "🇩🇪 德文"),
                Map.of("code", "西班牙文", "label", "🇪🇸 西班牙文"),
                Map.of("code", "俄文", "label", "🇷🇺 俄文"),
                Map.of("code", "阿拉伯文", "label", "🇸🇦 阿拉伯文"),
                Map.of("code", "中文", "label", "🇨🇳 中文")
        );
    }

    private static final com.fasterxml.jackson.databind.ObjectMapper OBJECT_MAPPER = new com.fasterxml.jackson.databind.ObjectMapper();

    /**
     * TTS 音色预览：用指定音色生成短音频样本
     * POST /api/util/tts/preview
     * body: { voice, text?, channelId? }
     *   - voice: 音色ID（必填）
     *   - text: 预览文本（可选，默认"你好，这是语音预览。"）
     *   - channelId: 渠道标识（可选，支持 UUID 或数字 ID；传则使用指定渠道预览；不传则自动选择 TTS 类型渠道）
     * 返回: base64 MP3 音频（与 /tts 端点相同格式）
     */
    @PostMapping("/tts/preview")
    public Result<String> previewTts(@RequestBody Map<String, String> body) {
        String voice = body.get("voice");
        if (voice == null || voice.isBlank()) return Result.fail(400, "voice 不能为空");
        String text = body.getOrDefault("text", "你好，这是语音预览。");
        if (text.length() > 200) text = text.substring(0, 200);
        String channelIdStr = body.get("channelId");
        try {
            String audioBase64;
            if (channelIdStr != null && !channelIdStr.isBlank()) {
                audioBase64 = aiService.textToSpeechByChannelIdentifier(channelIdStr, text, voice);
            } else {
                audioBase64 = aiService.textToSpeechWithChannel(text, voice);
            }
            return Result.ok(audioBase64);
        } catch (Exception e) {
            log.warn("TTS 预览失败: {}", e.getMessage());
            return Result.fail(503, "预览生成失败: " + e.getMessage());
        }
    }

    /**
     * 语音转文字（ASR）— 用于 HTTP 环境下 Web Speech API 不可用时的回退
     * POST /api/util/transcribe
     * body: { fileUrl } — 音频文件的 OSS URL
     * 返回: { text } — 识别出的文字
     */
    @PostMapping("/transcribe")
    public Result<Map<String, String>> transcribe(
            @RequestAttribute Long userId,
            @RequestBody Map<String, String> body) {
        String fileUrl = body.get("fileUrl");
        if (fileUrl == null || fileUrl.isBlank()) {
            return Result.fail(400, "fileUrl 不能为空");
        }

        long start = System.currentTimeMillis();
        try {
            String text = aiService.speechToText(fileUrl);
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFull(userId, "qwen3-asr-flash", 0, text != null ? text.length() : 0,
                    latency, "asr", null);
            Map<String, String> result = new HashMap<>();
            result.put("text", text != null ? text : "");
            return Result.ok(result);
        } catch (Exception e) {
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFailure(userId, "qwen3-asr-flash", 0, 0, latency, "asr", e.getMessage());
            log.warn("语音识别失败: {}", e.getMessage());
            return Result.fail(503, "语音识别服务不可用: " + e.getMessage());
        }
    }

    /**
     * 语音转文字（音频文件直传）— 用于 HTTP 环境下无法调用浏览器语音 API 的场景
     * POST /api/util/transcribe/upload
     * body: multipart/form-data, 包含 audio 文件字段
     * 返回: { text } — 识别出的文字
     */
    @PostMapping("/transcribe/upload")
    public Result<Map<String, String>> transcribeUpload(
            @RequestAttribute Long userId,
            @RequestParam("audio") MultipartFile audioFile) {
        if (audioFile == null || audioFile.isEmpty()) {
            return Result.fail(400, "audio 文件不能为空");
        }
        if (audioFile.getSize() > 50 * 1024 * 1024) {
            return Result.fail(400, "音频文件大小不能超过 50MB");
        }

        long start = System.currentTimeMillis();
        try {
            String text = aiService.speechToTextFromBytes(
                    audioFile.getBytes(),
                    audioFile.getOriginalFilename() != null
                            ? audioFile.getOriginalFilename()
                            : "audio.mp3"
            );
            int latency = (int) (System.currentTimeMillis() - start);
            int estimatedTokens = text != null ? text.length() : 0;
            usageTrackingService.trackFull(userId, "asr", 0, estimatedTokens,
                    latency, "asr", null);
            Map<String, String> result = new HashMap<>();
            result.put("text", text != null ? text : "");
            return Result.ok(result);
        } catch (Exception e) {
            int latency = (int) (System.currentTimeMillis() - start);
            usageTrackingService.trackFailure(userId, "asr", 0, 0, latency, "asr", e.getMessage());
            log.warn("语音识别(上传模式)失败: {}", e.getMessage());
            return Result.fail(503, "语音识别失败: " + e.getMessage());
        }
    }
}
