package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.ChatDTO;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.entity.ChatMessage;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.aiplatform.backend.mapper.ChatMessageMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ChatService {

    private final ChatConversationMapper conversationMapper;
    private final ChatMessageMapper messageMapper;
    private final AiService aiService;
    private final MemoryService memoryService;
    private final UsageTrackingService usageTrackingService;
    private final PrivacySettingService privacySettingService;

    private static final DateTimeFormatter FMT = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    /** 获取用户所有对话列表 */
    public List<ChatDTO.ConversationVO> listConversations(Long userId) {
        List<ChatConversation> convs = conversationMapper.selectList(
                new QueryWrapper<ChatConversation>()
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("pinned")
                        .orderByDesc("updated_at")
        );
        return convs.stream().map(c -> toVO(c, false, 0)).collect(Collectors.toList());
    }

    /** 获取单个对话（含消息） */
    public ChatDTO.ConversationVO getConversation(Long userId, String uuid) {
        return getConversation(userId, uuid, 0, null); // 0 = 全部消息（兼容旧行为）
    }

    /**
     * 获取单个对话详情（带消息数量限制和游标分页）
     * @param limit 返回最多多少条消息
     * @param before 游标：只返回此消息ID之前的消息（可选，用于向上滚动加载更早消息）
     */
    public ChatDTO.ConversationVO getConversation(Long userId, String uuid, int limit, String before) {
        ChatConversation conv = getConvByUuid(userId, uuid);
        return toVO(conv, true, limit, before);
    }

    /** 创建对话（自动初始化记忆） */
    public ChatDTO.ConversationVO createConversation(Long userId, ChatDTO.CreateConversationRequest req) {
        ChatConversation conv = new ChatConversation();
        String uuid = UUID.randomUUID().toString();
        conv.setUuid(uuid);
        conv.setUserId(userId);
        conv.setTitle(req.getTitle() != null ? req.getTitle() : "新对话");
        conv.setModel(req.getModel() != null ? req.getModel() : "gpt-4o");
        conv.setSystemPrompt(req.getSystemPrompt());
        conv.setTags(normalizeConversationTags(req.getTags()));
        conv.setPinned(false);
        conv.setCreatedAt(LocalDateTime.now());
        conv.setUpdatedAt(LocalDateTime.now());
        conversationMapper.insert(conv);

        // 🔧 自动初始化记忆文件（SOUL.md / MEMORY.md / USER.md / WORK.md）
        if (privacySettingService.isSaveHistoryEnabled(userId)) {
            try {
                memoryService.initializeConversationMemory(userId, conv.getId(), uuid, req.getAgentId());
            } catch (Exception e) {
                // 记忆初始化失败不阻塞对话创建
                log.warn("[Memory] 对话记忆初始化失败, uuid={}, error={}", uuid, e.getMessage());
            }
        }

        return toVO(conv, false, 0);
    }

    /** 更新对话标题/置顶/标签 */
    public ChatDTO.ConversationVO updateConversation(Long userId, String uuid, ChatDTO.CreateConversationRequest req) {
        ChatConversation conv = getConvByUuid(userId, uuid);
        if (req.getTitle() != null) conv.setTitle(req.getTitle());
        if (req.getModel() != null) conv.setModel(req.getModel());
        if (req.getSystemPrompt() != null) conv.setSystemPrompt(req.getSystemPrompt());
        if (req.getTags() != null) conv.setTags(normalizeConversationTags(req.getTags()));
        conversationMapper.updateById(conv);
        return toVO(conv, false, 0);
    }

    /** 置顶/取消置顶 */
    public void togglePin(Long userId, String uuid) {
        ChatConversation conv = getConvByUuid(userId, uuid);
        conv.setPinned(!Boolean.TRUE.equals(conv.getPinned()));
        conversationMapper.updateById(conv);
    }

    /** 删除对话（逻辑删除） */
    @Transactional
    public void deleteConversation(Long userId, String uuid) {
        ChatConversation conv = getConvByUuid(userId, uuid);
        // 使用 UpdateWrapper 显式 SET deleted=1，绕过 @TableLogic 对 updateById 的干扰
        UpdateWrapper<ChatConversation> uwConv = new UpdateWrapper<>();
        uwConv.eq("id", conv.getId()).set("deleted", 1);
        conversationMapper.update(null, uwConv);
        // 同时逻辑删除该对话下所有消息（使用 UpdateWrapper 显式 SET）
        UpdateWrapper<ChatMessage> uwMsg = new UpdateWrapper<>();
        uwMsg.eq("conversation_id", conv.getId())
          .set("deleted", 1);
        messageMapper.update(null, uwMsg);
    }

    /** 清空消息 */
    @Transactional
    public void clearMessages(Long userId, String uuid) {
        ChatConversation conv = getConvByUuid(userId, uuid);
        UpdateWrapper<ChatMessage> uw2 = new UpdateWrapper<>();
        uw2.eq("conversation_id", conv.getId())
           .set("deleted", 1);
        messageMapper.update(null, uw2);
    }

    /** 确保对话存在；若不存在（如 H2 重启后数据丢失）则以给定 uuid 自动重建 */
    @Transactional
    public void ensureConversationExists(Long userId, String uuid, String model) {
        ChatConversation conv = conversationMapper.selectOne(
                new QueryWrapper<ChatConversation>()
                        .eq("uuid", uuid).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id")
                        .last("LIMIT 1"));
        if (conv == null) {
            ChatConversation newConv = new ChatConversation();
            newConv.setUuid(uuid); // 使用前端传入的 uuid，保持 ID 一致
            newConv.setUserId(userId);
            newConv.setTitle("新对话");
            newConv.setModel(model != null && !model.isBlank() ? model : "gpt-4o");
            newConv.setPinned(false);
            conversationMapper.insert(newConv);
        }
    }

    /** 保存用户消息 */
    public ChatDTO.MessageVO saveUserMessage(Long userId, String convUuid, String content) {
        if (!privacySettingService.isSaveHistoryEnabled(userId)) {
            return transientMessage("user", content, null, 0);
        }
        ChatConversation conv = getConvByUuid(userId, convUuid);
        ChatMessage msg = new ChatMessage();
        msg.setUuid(UUID.randomUUID().toString());
        msg.setConversationId(conv.getId());
        msg.setRole("user");
        msg.setContent(content);
        msg.setStatus("success");
        messageMapper.insert(msg);
        return toMsgVO(msg);
    }

    /** 保存 AI 回复消息 */
    public ChatDTO.MessageVO saveAssistantMessage(Long userId, String convUuid,
            String content, String model, int inputTokens, int outputTokens, int latencyMs) {
        if (!privacySettingService.isSaveHistoryEnabled(userId)) {
            return transientMessage("assistant", content, model, outputTokens);
        }
        ChatConversation conv = getConvByUuid(userId, convUuid);
        ChatMessage msg = new ChatMessage();
        msg.setUuid(UUID.randomUUID().toString());
        msg.setConversationId(conv.getId());
        msg.setRole("assistant");
        msg.setContent(content);
        msg.setModel(model);
        msg.setInputTokens(inputTokens);
        msg.setOutputTokens(outputTokens);
        msg.setLatencyMs(latencyMs);
        msg.setStatus("success");
        messageMapper.insert(msg);

        // 更新对话标题（首条消息时）
        long msgCount = messageMapper.selectCount(
                new QueryWrapper<ChatMessage>().eq("conversation_id", conv.getId()).eq("deleted", 0));
        if (msgCount <= 2) {
            String newTitle = content.length() > 30 ? content.substring(0, 30) + "..." : content;
            conv.setTitle(newTitle);
            conversationMapper.updateById(conv);
        }

        // 异步生成上下文摘要（对话过长时压缩历史）
        maybeGenerateSummary(userId, conv, msgCount);

        return toMsgVO(msg);
    }

    /**
     * 追加内容到现有 AI 消息（内联继续对话模式）。
     * 如果消息存在 → 追加新内容 + 累加 token 用量；
     * 如果消息不存在（之前被 abort 未保存）→ 创建新消息，使用 existingContent + newContent 作为完整内容。
     *
     * @param existingContent 前端传入的已有内容（valid_output），仅消息不存在时使用
     */
    public ChatDTO.MessageVO appendAssistantMessage(Long userId, String convUuid,
            String msgUuid, String newContent, String existingContent,
            String model, int inputTokens, int outputTokens, int latencyMs) {
        if (!privacySettingService.isSaveHistoryEnabled(userId)) {
            String fullContent = (existingContent != null ? existingContent : "") + (newContent != null ? newContent : "");
            ChatDTO.MessageVO vo = transientMessage("assistant", fullContent, model, outputTokens);
            vo.setId(msgUuid != null && !msgUuid.isBlank() ? msgUuid : vo.getId());
            return vo;
        }
        ChatConversation conv = getConvByUuid(userId, convUuid);

        // 尝试查找现有消息
        ChatMessage existingMsg = messageMapper.selectOne(
                new QueryWrapper<ChatMessage>()
                        .eq("uuid", msgUuid)
                        .eq("conversation_id", conv.getId())
                        .eq("deleted", 0)
                        .orderByDesc("id")
                        .last("LIMIT 1"));

        if (existingMsg != null) {
            // ✅ 消息存在 → 追加内容 + 累加 token
            String oldContent = existingMsg.getContent() != null ? existingMsg.getContent() : "";
            existingMsg.setContent(oldContent + newContent);
            existingMsg.setModel(model);
            existingMsg.setInputTokens((existingMsg.getInputTokens() != null ? existingMsg.getInputTokens() : 0) + inputTokens);
            existingMsg.setOutputTokens((existingMsg.getOutputTokens() != null ? existingMsg.getOutputTokens() : 0) + outputTokens);
            existingMsg.setLatencyMs(latencyMs);
            existingMsg.setStatus("success");
            messageMapper.updateById(existingMsg);
            log.info("[ContinueInPlace] 追加到现有消息 uuid={}, appendLen={}, totalLen={}",
                    msgUuid, newContent.length(), existingMsg.getContent().length());
            return toMsgVO(existingMsg);
        } else {
            // ❌ 消息不存在（之前被 abort 未保存）→ 创建新消息
            // 使用前端传入的 existingContent + newContent 作为完整内容
            String fullContent = (existingContent != null ? existingContent : "") + newContent;
            ChatMessage msg = new ChatMessage();
            msg.setUuid(msgUuid);
            msg.setConversationId(conv.getId());
            msg.setRole("assistant");
            msg.setContent(fullContent);
            msg.setModel(model);
            msg.setInputTokens(inputTokens);
            msg.setOutputTokens(outputTokens);
            msg.setLatencyMs(latencyMs);
            msg.setStatus("success");
            messageMapper.insert(msg);
            log.info("[ContinueInPlace] 创建新 AI 消息 uuid={}, existingLen={}, newLen={}, totalLen={}",
                    msgUuid, existingContent != null ? existingContent.length() : 0,
                    newContent.length(), fullContent.length());
            return toMsgVO(msg);
        }
    }

    // ---------- 上下文摘要生成 ----------

    /** 摘要生成的阈值：超过 120 条消息或总字符数超过 200000 时触发（适配 100K 上下文） */
    private static final int SUMMARY_MSG_THRESHOLD = 120;
    private static final int SUMMARY_CHAR_THRESHOLD = 200_000;

    /**
     * 检查是否需要生成上下文摘要。
     * 当对话消息数超过阈值且尚未有摘要时，提取早期消息调用 AI 生成摘要。
     */
    private void maybeGenerateSummary(Long userId, ChatConversation conv, long msgCount) {
        // 已有摘要的对话不再重复生成
        if (conv.getContextSummary() != null && !conv.getContextSummary().isBlank()) {
            return;
        }
        if (msgCount < SUMMARY_MSG_THRESHOLD) {
            return;
        }

        try {
            // 取最旧的 50 条消息作为摘要素材
            List<ChatMessage> oldMessages = messageMapper.selectList(
                    new QueryWrapper<ChatMessage>()
                            .eq("conversation_id", conv.getId())
                            .eq("deleted", 0)
                            .in("role", "user", "assistant")
                            .orderByAsc("created_at")
                            .last("LIMIT 50")
            );

            if (oldMessages.isEmpty()) return;

            // 检查总字符数是否超过阈值
            int totalChars = oldMessages.stream()
                    .mapToInt(m -> m.getContent() == null ? 0 : m.getContent().length())
                    .sum();
            if (totalChars < SUMMARY_CHAR_THRESHOLD) return;

            // 构造对话片段文本
            StringBuilder contextBuilder = new StringBuilder();
            for (ChatMessage m : oldMessages) {
                String role = "user".equals(m.getRole()) ? "用户" : "AI";
                String content = m.getContent() == null ? "" : m.getContent();
                // 每条消息截断到 2000 字符
                if (content.length() > 2000) {
                    content = content.substring(0, 2000) + "...";
                }
                contextBuilder.append(role).append(": ").append(content).append("\n\n");
            }

            String systemPrompt = "你是一个对话摘要专家。请将以下对话片段压缩成简洁的摘要（200-400字），保留关键信息：人物、任务、决策、数据、问题解决过程。只输出摘要文本，不要加任何前缀或说明。";

            log.info("[Summary] 开始生成对话摘要, convUuid={}, msgCount={}, totalChars={}",
                    conv.getUuid(), oldMessages.size(), totalChars);

            AiService.AiResult result = aiService.chat(
                    "gpt-4o",          // 使用较好的模型生成摘要
                    systemPrompt,
                    List.of(),          // 无历史
                    contextBuilder.toString(),
                    0.3,               // 低温度，确保摘要稳定
                    800                 // 摘要不需要太长
            );

            String summary = result.content();
            if (summary != null && !summary.isBlank()) {
                conv.setContextSummary(summary.trim());
                conversationMapper.updateById(conv);
                log.info("[Summary] 对话摘要已保存, convUuid={}, summaryLen={}", conv.getUuid(), summary.length());
            }

            // ★ 计费追踪 — AI 摘要生成
            try {
                usageTrackingService.trackFull(userId,
                        result.model() != null ? result.model() : "gpt-4o",
                        result.inputTokens(), result.cachedInputTokens(), result.outputTokens(),
                        result.latencyMs(), "conversation_summary", null);
            } catch (Exception ex) {
                log.warn("[Summary] 计费追踪失败: {}", ex.getMessage());
            }

        } catch (Exception e) {
            log.warn("[Summary] 生成摘要失败, convUuid={}: {}", conv.getUuid(), e.getMessage());
            // 摘要失败不影响主流程，下次继续尝试
        }
    }

    // ---------- 历史上下文加载 ----------

    /**
     * 为 AI 调用准备历史消息列表。
     * 策略：
     *   1. 取最近 MAX_HISTORY_ROWS 条消息（适配 100K token 上下文）
     *   2. 始终保留第一条用户消息（含代码/技能创建请求），避免上下文丢失导致 AI 失忆
     *   3. 对剩余消息用字符数估算 token，超出 TOKEN_BUDGET 时从最旧开始丢弃
     *   4. 若对话有 context_summary，在历史列表最前面插入一条 system 角色的摘要消息
     *
     * @param userId  当前用户 ID
     * @param convUuid 对话 UUID
     * @return 历史消息列表，每条 Map 含 role/content，不含当前用户消息
     */
    public List<Map<String, String>> getHistoryForAi(Long userId, String convUuid) {
        if (!privacySettingService.isSaveHistoryEnabled(userId)) {
            return List.of();
        }
        ChatConversation conv = getConvByUuid(userId, convUuid);

        // 最多取 400 条（200 轮对话），匹配 100K token 上下文
        final int MAX_HISTORY_ROWS = 400;
        // token 预算：100K tokens ≈ 250,000 字符（中文约 2.5 字符/token）
        final int TOKEN_BUDGET_CHARS = 250_000;

        List<ChatMessage> raw = messageMapper.selectList(
                new QueryWrapper<ChatMessage>()
                        .eq("conversation_id", conv.getId())
                        .eq("deleted", 0)
                        .in("role", "user", "assistant")
                        .orderByDesc("created_at")
                        .last("LIMIT " + MAX_HISTORY_ROWS)
        );

        // 倒序取回来，反转成正序（旧→新）
        List<ChatMessage> ordered = new ArrayList<>(raw);
        java.util.Collections.reverse(ordered);

        // 始终保留第一条消息（含代码/技能创建请求），避免上下文丢失导致 AI 失忆
        // 对剩余消息从最旧开始累积字符数，超出预算时丢弃
        int totalChars = 0;
        int startIdx = 0;
        boolean firstMsgPreserved = false;
        for (int i = 0; i < ordered.size(); i++) {
            int msgLen = ordered.get(i).getContent() == null ? 0 : ordered.get(i).getContent().length();
            // 第一条消息不计入预算，始终保留
            if (i == 0) {
                firstMsgPreserved = true;
                continue;
            }
            totalChars += msgLen;
            if (totalChars > TOKEN_BUDGET_CHARS) {
                startIdx = i + 1; // 从这里开始才放入
            }
        }
        // 确保第一条消息始终在结果中（如果 startIdx > 0，取 [0] + [startIdx, end)）
        List<ChatMessage> selected;
        if (startIdx > 0 && ordered.size() > 1) {
            selected = new ArrayList<>();
            if (firstMsgPreserved) selected.add(ordered.get(0));
            if (startIdx < ordered.size()) selected.addAll(ordered.subList(startIdx, ordered.size()));
        } else {
            selected = ordered.subList(startIdx, ordered.size());
        }

        List<Map<String, String>> result = new ArrayList<>();

        // 若有摘要，作为第一条 system 消息注入（让模型知道被截断的早期上下文）
        if (conv.getContextSummary() != null && !conv.getContextSummary().isBlank()) {
            Map<String, String> summaryMsg = new HashMap<>();
            summaryMsg.put("role", "system");
            summaryMsg.put("content", "【早期对话摘要】" + conv.getContextSummary());
            result.add(summaryMsg);
        }

        for (ChatMessage msg : selected) {
            Map<String, String> m = new HashMap<>();
            m.put("role", msg.getRole());
            m.put("content", msg.getContent() == null ? "" : msg.getContent());
            result.add(m);
        }
        return result;
    }

    // ---------- 私有辅助 ----------

    private ChatConversation getConvByUuid(Long userId, String uuid) {
        ChatConversation conv = conversationMapper.selectOne(
                new QueryWrapper<ChatConversation>()
                        .eq("uuid", uuid).eq("user_id", userId).eq("deleted", 0)
                        .orderByDesc("id")
                        .last("LIMIT 1"));
        if (conv == null) throw new RuntimeException("对话不存在");
        return conv;
    }

    private ChatDTO.ConversationVO toVO(ChatConversation c, boolean includeMessages, int limit) {
        return toVO(c, includeMessages, limit, null);
    }

    private ChatDTO.ConversationVO toVO(ChatConversation c, boolean includeMessages, int limit, String before) {
        ChatDTO.ConversationVO vo = new ChatDTO.ConversationVO();
        vo.setId(c.getUuid());
        vo.setTitle(c.getTitle());
        vo.setModel(c.getModel());
        vo.setPinned(c.getPinned());
        if (c.getTags() != null && !c.getTags().isEmpty()) {
            vo.setTags(Arrays.asList(c.getTags().split(",")));
        }
        if (c.getCreatedAt() != null) vo.setCreatedAt(c.getCreatedAt().format(FMT));
        if (c.getUpdatedAt() != null) vo.setUpdatedAt(c.getUpdatedAt().format(FMT));

        if (includeMessages) {
            // 游标分页：before != null 时，只取该消息之前的更早消息
            if (before != null && !before.isEmpty()) {
                // 先找到 before 消息的 ID（数据库自增ID）
                ChatMessage cursorMsg = messageMapper.selectOne(
                        new QueryWrapper<ChatMessage>()
                                .eq("uuid", before)
                                .eq("conversation_id", c.getId())
                                .select("id")
                                .orderByDesc("id")
                                .last("LIMIT 1")
                );
                if (cursorMsg != null) {
                    // 取比 cursorMsg.id 更小的（更早的）消息，limit+1 判断 hasMore
                    List<ChatMessage> msgs = messageMapper.selectList(
                            new QueryWrapper<ChatMessage>()
                                    .eq("conversation_id", c.getId())
                                    .eq("deleted", 0)
                                    .lt("id", cursorMsg.getId())
                                    .orderByDesc("id")
                                    .last("LIMIT " + (limit + 1))
                    );
                    vo.setHasMore(msgs.size() > limit);
                    if (vo.getHasMore()) {
                        msgs = msgs.subList(0, limit);
                    }
                    java.util.Collections.reverse(msgs);
                    vo.setMessages(msgs.stream().map(this::toMsgVO).collect(Collectors.toList()));
                } else {
                    vo.setMessages(List.of());
                    vo.setHasMore(false);
                }
            } else {
                // 首次加载：取最近 limit 条
                QueryWrapper<ChatMessage> qw = new QueryWrapper<ChatMessage>()
                        .eq("conversation_id", c.getId())
                        .eq("deleted", 0);
                if (limit > 0) {
                    qw.last("ORDER BY id DESC LIMIT " + (limit + 1));
                    List<ChatMessage> msgs = messageMapper.selectList(qw);
                    vo.setHasMore(msgs.size() > limit);
                    if (vo.getHasMore()) {
                        msgs = msgs.subList(0, limit);
                    }
                    java.util.Collections.reverse(msgs);
                    vo.setMessages(msgs.stream().map(this::toMsgVO).collect(Collectors.toList()));
                } else {
                    qw.orderByAsc("created_at");
                    List<ChatMessage> msgs = messageMapper.selectList(qw);
                    vo.setMessages(msgs.stream().map(this::toMsgVO).collect(Collectors.toList()));
                    vo.setHasMore(false);
                }
            }
        }
        return vo;
    }

    private ChatDTO.MessageVO toMsgVO(ChatMessage m) {
        ChatDTO.MessageVO vo = new ChatDTO.MessageVO();
        vo.setId(m.getUuid());
        vo.setRole(m.getRole());
        vo.setContent(m.getContent());
        vo.setModel(m.getModel());
        vo.setTokens(m.getOutputTokens() != null ? m.getOutputTokens() : 0);
        if (m.getCreatedAt() != null) vo.setTimestamp(m.getCreatedAt().format(FMT));
        return vo;
    }

    private ChatDTO.MessageVO transientMessage(String role, String content, String model, int outputTokens) {
        ChatDTO.MessageVO vo = new ChatDTO.MessageVO();
        vo.setId("local-" + UUID.randomUUID());
        vo.setRole(role);
        vo.setContent(content);
        vo.setModel(model);
        vo.setTokens(outputTokens);
        vo.setTimestamp(LocalDateTime.now().format(FMT));
        return vo;
    }

    private String normalizeConversationTags(List<String> tags) {
        if (tags == null || tags.isEmpty()) return null;
        String normalized = tags.stream()
                .filter(Objects::nonNull)
                .map(String::trim)
                .filter(t -> !t.isEmpty())
                .distinct()
                .collect(Collectors.joining(","));
        return normalized.isEmpty() ? null : normalized;
    }
}
