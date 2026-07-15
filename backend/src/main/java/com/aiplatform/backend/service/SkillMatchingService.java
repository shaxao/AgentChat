package com.aiplatform.backend.service;

import com.aiplatform.backend.dto.MemoryDTO;
import com.aiplatform.backend.entity.AgentRegistry;
import com.aiplatform.backend.entity.ChatConversation;
import com.aiplatform.backend.mapper.ChatConversationMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class SkillMatchingService {

    private static final String WORK_TITLE = "WORK.md";
    private static final String CACHE_START = "<!-- skill-routing-cache:start -->";
    private static final String CACHE_END = "<!-- skill-routing-cache:end -->";
    private static final int CACHE_VERSION = 2;
    private static final int MAX_CACHE_RECORDS = 60;
    private static final double DIRECT_USE_THRESHOLD = 0.62;
    private static final double CONDITIONAL_USE_THRESHOLD = 0.42;
    private static final double MIN_TOP_GAP = 0.18;
    private static final double CACHE_SIMILARITY_THRESHOLD = 0.72;

    private final AgentRegistryService agentRegistryService;
    private final ChatConversationMapper conversationMapper;
    private final MemoryService memoryService;
    private final ObjectMapper objectMapper;

    private final Map<Long, List<String>> userContextMap = new HashMap<>();

    public List<SkillMatch> matchSkill(String userInput, Long userId) {
        log.info("[SkillMatchingService] match skill: userId={}, inputLen={}",
                userId, userInput != null ? userInput.length() : 0);

        List<AgentRegistry> allSkills = agentRegistryService.listAllForMatching();
        List<SkillMatch> matches = allSkills.stream()
                .map(skill -> {
                    double score = calculateRelevance(skill, userInput, userId);
                    return new SkillMatch(skill.getAgentId(), skill.getName(), skill.getDescription(), score);
                })
                .filter(match -> match.getScore() > 0.14)
                .sorted((a, b) -> Double.compare(b.getScore(), a.getScore()))
                .limit(5)
                .collect(Collectors.toList());

        if (!matches.isEmpty()) {
            updateUserContext(userId, matches.get(0).getAgentId());
        }

        return matches;
    }

    public AutoSkillDecision autoRouteSkill(String userInput, Long userId) {
        return autoRouteSkill(userInput, userId, null);
    }

    public AutoSkillDecision autoRouteSkill(String userInput, Long userId, String convUuid) {
        if (userInput == null || userInput.isBlank()) {
            return new AutoSkillDecision(false, false, null, Collections.emptyList(), "empty", false);
        }

        RouteKey routeKey = buildRouteKey(userInput);
        ChatConversation conv = resolveConversation(userId, convUuid);
        if (conv != null) {
            AutoSkillDecision cached = findCachedDecision(userInput, userId, conv, routeKey);
            if (cached != null) return cached;
        }

        List<SkillMatch> matches = matchSkill(userInput, userId);
        SkillMatch best = selectAutoUsableMatch(userInput, matches);

        boolean complex = shouldAutoUseSkill(userInput) || best != null;
        AutoSkillDecision decision = new AutoSkillDecision(best != null, complex, best, matches, "store", false);
        if (conv != null) {
            writeRouteCacheAsync(userId, conv.getId(), routeKey, userInput, decision);
        }
        return decision;
    }

    public boolean shouldAutoUseSkill(String userInput) {
        if (userInput == null || userInput.isBlank()) return false;
        String input = normalize(userInput);
        int score = 0;
        if (input.length() >= 80) score += 2;
        if (input.length() >= 160) score += 2;
        for (String signal : COMPLEX_SIGNALS) {
            if (input.contains(signal)) score++;
        }
        if (input.contains("\n") || input.contains(";") || input.contains(":")) score++;
        return score >= 2;
    }

    private AutoSkillDecision findCachedDecision(String userInput, Long userId, ChatConversation conv, RouteKey routeKey) {
        try {
            MemoryDTO.DocumentVO work = memoryService.getDocumentByTitle(userId, conv.getId(), WORK_TITLE);
            if (work == null || work.getContent() == null) return null;

            List<RouteCacheRecord> records = parseRouteCache(work.getContent());
            RouteCacheRecord hit = records.stream()
                    .filter(record -> isSimilar(routeKey, record))
                    .reduce((first, second) -> second)
                    .orElse(null);
            if (hit == null) return null;

            if (!hit.matched) {
                return new AutoSkillDecision(false, shouldAutoUseSkill(userInput), null,
                        Collections.emptyList(), "work-cache-negative", true);
            }

            SkillMatch match = new SkillMatch(hit.agentId, hit.name, hit.description, Math.max(hit.score, DIRECT_USE_THRESHOLD));
            updateUserContext(userId, hit.agentId);
            return new AutoSkillDecision(true, true, match, List.of(match), "work-cache", true);
        } catch (Exception e) {
            log.warn("[SkillMatchingService] read WORK.md route cache failed: convUuid={}, error={}",
                    conv.getUuid(), e.getMessage());
            return null;
        }
    }

    private void writeRouteCacheAsync(Long userId, Long conversationId, RouteKey routeKey, String userInput, AutoSkillDecision decision) {
        CompletableFuture.runAsync(() -> {
            try {
                MemoryDTO.DocumentVO work = memoryService.getDocumentByTitle(userId, conversationId, WORK_TITLE);
                String content = work != null && work.getContent() != null ? work.getContent() : "";
                List<RouteCacheRecord> records = parseRouteCache(content);

                RouteCacheRecord next = RouteCacheRecord.from(routeKey, userInput, decision);
                List<RouteCacheRecord> merged = new ArrayList<>();
                for (RouteCacheRecord record : records) {
                    if (!Objects.equals(record.key, next.key)) {
                        merged.add(record);
                    }
                }
                merged.add(next);
                if (merged.size() > MAX_CACHE_RECORDS) {
                    merged = merged.subList(merged.size() - MAX_CACHE_RECORDS, merged.size());
                }

                String updated = replaceRouteCache(content, merged);
                MemoryDTO.DocumentRequest req = new MemoryDTO.DocumentRequest();
                req.setTitle(WORK_TITLE);
                req.setDocType("work_index");
                req.setCategory("conversation");
                req.setImportance(3);
                req.setContent(updated);
                memoryService.saveDocument(userId, conversationId, req);
            } catch (Exception e) {
                log.warn("[SkillMatchingService] async write WORK.md route cache failed: conversationId={}, error={}",
                        conversationId, e.getMessage());
            }
        });
    }

    private ChatConversation resolveConversation(Long userId, String convUuid) {
        if (userId == null || convUuid == null || convUuid.isBlank() || convUuid.startsWith("conv_")) {
            return null;
        }
        return conversationMapper.selectOne(
                new QueryWrapper<ChatConversation>()
                        .eq("uuid", convUuid)
                        .eq("user_id", userId)
                        .eq("deleted", 0)
                        .orderByDesc("id")
                        .last("LIMIT 1"));
    }

    private List<RouteCacheRecord> parseRouteCache(String content) {
        int start = content.indexOf(CACHE_START);
        int end = content.indexOf(CACHE_END);
        if (start < 0 || end < 0 || end <= start) return new ArrayList<>();

        String body = content.substring(start + CACHE_START.length(), end);
        List<RouteCacheRecord> records = new ArrayList<>();
        for (String line : body.split("\\R")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || !trimmed.startsWith("{")) continue;
            try {
                Map<String, Object> map = objectMapper.readValue(trimmed, new TypeReference<>() {});
                RouteCacheRecord record = RouteCacheRecord.fromMap(map);
                if (record.key != null && !record.key.isBlank()) records.add(record);
            } catch (Exception ignored) {
                // Keep WORK.md human-editable; ignore malformed cache lines.
            }
        }
        return records;
    }

    private String replaceRouteCache(String content, List<RouteCacheRecord> records) throws Exception {
        StringBuilder block = new StringBuilder();
        block.append("## Skill Routing Cache\n");
        block.append(CACHE_START).append('\n');
        for (RouteCacheRecord record : records) {
            block.append(objectMapper.writeValueAsString(record.toMap())).append('\n');
        }
        block.append(CACHE_END).append('\n');

        int start = content.indexOf(CACHE_START);
        int end = content.indexOf(CACHE_END);
        if (start >= 0 && end > start) {
            int headingStart = content.lastIndexOf("## Skill Routing Cache", start);
            int replaceStart = headingStart >= 0 ? headingStart : start;
            return content.substring(0, replaceStart).stripTrailing()
                    + "\n\n" + block
                    + content.substring(end + CACHE_END.length()).stripLeading();
        }
        return content.stripTrailing() + "\n\n" + block;
    }

    private boolean isSimilar(RouteKey current, RouteCacheRecord record) {
        if (record.version < CACHE_VERSION) return false;
        if (record.key == null || record.key.isBlank()) return false;
        if (record.key.equals(current.key)) return true;

        Set<String> cached = new LinkedHashSet<>(Optional.ofNullable(record.keywords).orElse(List.of()));
        if (cached.isEmpty() || current.keywords.isEmpty()) return false;
        Set<String> intersection = new HashSet<>(cached);
        intersection.retainAll(current.keywords);
        Set<String> union = new HashSet<>(cached);
        union.addAll(current.keywords);
        return !union.isEmpty() && (intersection.size() * 1.0 / union.size()) >= CACHE_SIMILARITY_THRESHOLD;
    }

    private SkillMatch selectAutoUsableMatch(String userInput, List<SkillMatch> matches) {
        if (matches == null || matches.isEmpty()) return null;
        SkillMatch best = matches.get(0);
        double secondScore = matches.size() > 1 ? matches.get(1).getScore() : 0.0;
        if (best.getScore() >= DIRECT_USE_THRESHOLD) return best;
        if (best.getScore() >= CONDITIONAL_USE_THRESHOLD
                && best.getScore() - secondScore >= MIN_TOP_GAP
                && hasExplicitSkillIntent(userInput, best)) {
            return best;
        }
        return null;
    }

    private double calculateRelevance(AgentRegistry skill, String userInput, Long userId) {
        double score = 0.0;
        String inputLower = normalize(userInput);
        String agentIdLower = normalize(skill.getAgentId());
        String nameLower = normalize(skill.getName());
        String descLower = normalize(skill.getDescription());
        String categoriesLower = normalize(skill.getCategories());
        String guideLower = normalize(skill.getUsageGuide());
        String combined = String.join(" ", agentIdLower, nameLower, descLower, categoriesLower, guideLower);
        Set<String> skillNameTerms = extractSkillNameTerms(nameLower);
        Set<String> categoryTerms = splitTerms(categoriesLower);

        if (!inputLower.isBlank()) {
            if (inputLower.equals(agentIdLower)) score += 1.0;
            else if (containsMeaningful(agentIdLower, inputLower) || containsMeaningful(inputLower, agentIdLower)) score += 0.72;

            if (inputLower.equals(nameLower)) score += 0.9;
            else if (containsMeaningful(nameLower, inputLower) || containsMeaningful(inputLower, nameLower)) score += 0.68;
        }

        RouteKey routeKey = buildRouteKey(userInput);
        double keywordScore = 0.0;
        for (String keyword : routeKey.keywords) {
            if (!isUsefulKeyword(keyword) || !combined.contains(keyword)) continue;
            if (skillNameTerms.contains(keyword)) {
                keywordScore += 0.42;
            } else if (categoryTerms.contains(keyword)) {
                keywordScore += 0.26;
            } else if (DOMAIN_PHRASES.contains(keyword)) {
                keywordScore += 0.18;
            } else if (keyword.length() >= 4 || isAsciiKeyword(keyword)) {
                keywordScore += 0.12;
            } else if (keyword.length() >= 3) {
                keywordScore += 0.06;
            }
        }
        score += Math.min(keywordScore, 0.62);

        if (isPronounReference(inputLower) && userId != null) {
            List<String> context = userContextMap.get(userId);
            if (context != null && context.contains(skill.getAgentId())) {
                score += 0.4;
            }
        }

        return Math.min(score, 1.0);
    }

    private boolean containsMeaningful(String text, String query) {
        return query != null && query.length() >= 3 && text != null && text.contains(query);
    }

    private RouteKey buildRouteKey(String input) {
        LinkedHashSet<String> keywords = extractKeywords(normalize(input));
        String key = keywords.stream().limit(10).collect(Collectors.joining("|"));
        if (key.isBlank()) {
            key = normalize(input).replaceAll("\\s+", " ");
            if (key.length() > 80) key = key.substring(0, 80);
        }
        return new RouteKey(key, new ArrayList<>(keywords));
    }

    private LinkedHashSet<String> extractKeywords(String input) {
        LinkedHashSet<String> words = new LinkedHashSet<>();
        if (input == null || input.isBlank()) return words;

        for (String phrase : DOMAIN_PHRASES) {
            if (input.contains(phrase)) words.add(phrase);
        }

        for (String part : input.split("[\\s\\p{Punct}\\p{P}]+")) {
            String word = part.trim();
            if (isUsefulKeyword(word)) words.add(word);
        }

        for (String part : input.split("[^a-z0-9_-]+")) {
            String word = part.trim();
            if (isUsefulKeyword(word)) words.add(word);
        }

        return words;
    }

    private Set<String> extractSkillNameTerms(String name) {
        LinkedHashSet<String> terms = new LinkedHashSet<>();
        if (name == null || name.isBlank()) return terms;
        for (String phrase : DOMAIN_PHRASES) {
            if (name.contains(phrase)) terms.add(phrase);
        }
        terms.addAll(splitTerms(name));
        return terms;
    }

    private Set<String> splitTerms(String text) {
        LinkedHashSet<String> terms = new LinkedHashSet<>();
        if (text == null || text.isBlank()) return terms;
        for (String part : text.split("[\\s\\p{Punct}\\p{P}]+")) {
            String word = part.trim();
            if (isUsefulKeyword(word)) terms.add(word);
        }
        return terms;
    }

    private boolean hasExplicitSkillIntent(String userInput, SkillMatch match) {
        String input = normalize(userInput);
        String name = normalize(match.getName());
        if (containsMeaningful(input, name) || containsMeaningful(name, input)) return true;
        Set<String> inputTerms = extractKeywords(input);
        Set<String> matchTerms = new LinkedHashSet<>();
        matchTerms.addAll(extractSkillNameTerms(name));
        matchTerms.addAll(splitTerms(normalize(match.getDescription())));
        matchTerms.retainAll(inputTerms);
        return matchTerms.stream().anyMatch(term -> DOMAIN_PHRASES.contains(term) || term.length() >= 4 || isAsciiKeyword(term));
    }

    private boolean isUsefulKeyword(String word) {
        if (word == null) return false;
        String trimmed = word.trim();
        if (trimmed.length() < 2 || STOPWORDS.contains(trimmed)) return false;
        return DOMAIN_PHRASES.contains(trimmed) || trimmed.length() >= 3 || isAsciiKeyword(trimmed);
    }

    private boolean isAsciiKeyword(String word) {
        return word != null && word.matches(".*[a-z0-9].*");
    }

    private String normalize(String input) {
        return Optional.ofNullable(input).orElse("").trim().toLowerCase(Locale.ROOT);
    }

    private boolean isPronounReference(String input) {
        for (String pronoun : PRONOUNS) {
            if (input.contains(pronoun)) return true;
        }
        return false;
    }

    private void updateUserContext(Long userId, String agentId) {
        if (userId == null || agentId == null || agentId.isBlank()) return;
        userContextMap.computeIfAbsent(userId, k -> new ArrayList<>());
        List<String> context = userContextMap.get(userId);
        context.remove(agentId);
        context.add(0, agentId);
        if (context.size() > 3) {
            userContextMap.put(userId, new ArrayList<>(context.subList(0, 3)));
        }
    }

    public void clearUserContext(Long userId) {
        if (userId != null) userContextMap.remove(userId);
    }

    private record RouteKey(String key, List<String> keywords) {
    }

    public static class SkillMatch {
        private final String agentId;
        private final String name;
        private final String description;
        private final double score;

        public SkillMatch(String agentId, String name, String description, double score) {
            this.agentId = agentId;
            this.name = name;
            this.description = description;
            this.score = score;
        }

        public String getAgentId() { return agentId; }
        public String getName() { return name; }
        public String getDescription() { return description; }
        public double getScore() { return score; }
    }

    public static class AutoSkillDecision {
        private final boolean useSkill;
        private final boolean complex;
        private final SkillMatch bestMatch;
        private final List<SkillMatch> matches;
        private final String source;
        private final boolean cacheHit;

        public AutoSkillDecision(boolean useSkill, boolean complex, SkillMatch bestMatch, List<SkillMatch> matches) {
            this(useSkill, complex, bestMatch, matches, "store", false);
        }

        public AutoSkillDecision(boolean useSkill, boolean complex, SkillMatch bestMatch,
                                 List<SkillMatch> matches, String source, boolean cacheHit) {
            this.useSkill = useSkill;
            this.complex = complex;
            this.bestMatch = bestMatch;
            this.matches = matches;
            this.source = source;
            this.cacheHit = cacheHit;
        }

        public boolean isUseSkill() { return useSkill; }
        public boolean isComplex() { return complex; }
        public SkillMatch getBestMatch() { return bestMatch; }
        public List<SkillMatch> getMatches() { return matches; }
        public String getSource() { return source; }
        public boolean isCacheHit() { return cacheHit; }
    }

    private static class RouteCacheRecord {
        private String key;
        private int version = CACHE_VERSION;
        private List<String> keywords = new ArrayList<>();
        private boolean matched;
        private String agentId;
        private String name;
        private String description;
        private double score;
        private String sample;
        private String updatedAt;

        static RouteCacheRecord from(RouteKey routeKey, String input, AutoSkillDecision decision) {
            RouteCacheRecord record = new RouteCacheRecord();
            record.version = CACHE_VERSION;
            record.key = routeKey.key();
            record.keywords = routeKey.keywords().stream().limit(20).toList();
            record.matched = decision.isUseSkill() && decision.getBestMatch() != null;
            if (record.matched) {
                SkillMatch match = decision.getBestMatch();
                record.agentId = match.getAgentId();
                record.name = match.getName();
                record.description = match.getDescription();
                record.score = match.getScore();
            }
            record.sample = trimSample(input);
            record.updatedAt = LocalDateTime.now().toString();
            return record;
        }

        static RouteCacheRecord fromMap(Map<String, Object> map) {
            RouteCacheRecord record = new RouteCacheRecord();
            Object versionObj = map.get("version");
            if (versionObj instanceof Number number) record.version = number.intValue();
            record.key = asString(map.get("key"));
            Object keywordsObj = map.get("keywords");
            if (keywordsObj instanceof List<?> list) {
                record.keywords = list.stream().map(Object::toString).collect(Collectors.toList());
            }
            record.matched = Boolean.TRUE.equals(map.get("matched"));
            record.agentId = asString(map.get("agentId"));
            record.name = asString(map.get("name"));
            record.description = asString(map.get("description"));
            Object scoreObj = map.get("score");
            if (scoreObj instanceof Number number) record.score = number.doubleValue();
            record.sample = asString(map.get("sample"));
            record.updatedAt = asString(map.get("updatedAt"));
            return record;
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("version", version);
            map.put("key", key);
            map.put("keywords", keywords);
            map.put("matched", matched);
            if (matched) {
                map.put("agentId", agentId);
                map.put("name", name);
                map.put("description", description);
                map.put("score", score);
            }
            map.put("sample", sample);
            map.put("updatedAt", updatedAt);
            return map;
        }

        private static String asString(Object value) {
            return value == null ? null : String.valueOf(value);
        }

        private static String trimSample(String value) {
            String sample = Optional.ofNullable(value).orElse("").replaceAll("\\s+", " ").trim();
            return sample.length() <= 120 ? sample : sample.substring(0, 120);
        }
    }

    private static final List<String> COMPLEX_SIGNALS = Arrays.asList(
            "\u5206\u6790", "\u6574\u7406", "\u63d0\u53d6", "\u8f6c\u6362", "\u751f\u6210",
            "\u6279\u91cf", "\u603b\u7ed3", "\u62a5\u544a", "\u65b9\u6848", "\u8ba1\u5212",
            "\u5ba1\u67e5", "\u4ee3\u7801", "\u8868\u683c", "\u6587\u4ef6", "\u56fe\u7247",
            "\u8bc6\u522b", "\u5bfc\u51fa", "\u8ba1\u7b97", "\u5bf9\u6bd4", "\u8bc4\u4f30",
            "\u5de5\u4f5c\u6d41", "analyze", "extract", "convert", "generate", "batch",
            "report", "review", "workflow", "file", "image", "code"
    );

    private static final List<String> DOMAIN_PHRASES = Arrays.asList(
            "\u4ee3\u7801", "\u7f16\u7a0b", "\u5ba1\u67e5", "\u8868\u683c", "\u56fe\u7247",
            "\u6587\u4ef6", "\u97f3\u9891", "\u8bed\u97f3", "\u8bc6\u522b", "\u603b\u7ed3",
            "\u62a5\u544a", "\u8ba1\u5212", "\u65b9\u6848", "\u641c\u7d22", "\u8054\u7f51",
            "\u8d22\u52a1", "\u9910\u996e", "\u5e93\u5b58", "\u7528\u6237\u753b\u50cf",
            "\u8bb0\u5fc6", "\u5de5\u4f5c\u6d41", "\u652f\u4ed8", "\u6a21\u578b",
            "\u8def\u7531", "\u7ffb\u8bd1", "\u5199\u4f5c", "\u6587\u6848", "\u5ba2\u670d",
            "\u8fd0\u8425", "\u6570\u636e", "\u7edf\u8ba1", "\u5b89\u5168", "\u5408\u89c4",
            "\u5c0f\u7ea2\u4e66", "\u6296\u97f3", "\u5fae\u4fe1", "\u516c\u4f17\u53f7",
            "\u77ed\u89c6\u9891", "\u811a\u672c", "\u6807\u9898", "\u5c01\u9762",
            "\u6587\u7ae0", "\u7b14\u8bb0", "\u7206\u6b3e", "\u9009\u9898",
            "\u98de\u4e66", "\u591a\u7ef4\u8868\u683c", "\u65e5\u5386", "\u4f1a\u8bae",
            "\u5468\u62a5", "\u6708\u62a5", "\u77e5\u8bc6\u5e93", "\u6587\u6863",
            "\u80a1\u7968", "a\u80a1", "\u6e2f\u80a1", "\u7f8e\u80a1",
            "\u6295\u8d44", "\u884c\u60c5", "\u8d22\u62a5", "\u6280\u672f\u5206\u6790",
            "k\u7ebf", "\u6da8\u8dcc", "\u4e70\u5356\u70b9", "\u5165\u5e93",
            "\u51fa\u5e93", "\u91c7\u8d2d", "\u76d8\u70b9", "\u9884\u8b66",
            "\u5b89\u5168\u5e93\u5b58",
            "\u6d4f\u89c8\u5668", "\u7f51\u9875", "\u81ea\u52a8\u5316", "\u63d0\u53d6",
            "\u6570\u636e\u5206\u6790", "\u53ef\u89c6\u5316", "\u4fe1\u606f\u56fe",
            "\u547d\u7406", "\u516b\u5b57", "\u6392\u76d8", "ppt",
            "\u6f14\u793a", "\u7b80\u62a5", "\u4ee3\u7801\u5ba1\u67e5",
            "\u5b89\u5168\u626b\u63cf", "\u5ba1\u8ba1", "\u53bb\u5473",
            "code", "review", "search", "workflow", "report", "image", "audio", "asr",
            "ocr", "pdf", "ppt", "excel", "csv", "json", "sql", "api", "browser",
            "feishu", "wechat", "xhs", "douyin", "stock", "finance"
    );

    private static final Set<String> STOPWORDS = Set.of(
            "\u5e2e\u6211", "\u8bf7", "\u4e00\u4e0b", "\u4e0b", "\u8fd9\u4e2a",
            "\u90a3\u4e2a", "\u600e\u4e48", "\u5982\u4f55", "\u53ef\u4ee5",
            "\u9700\u8981", "\u60f3\u8981", "\u5e2e\u5fd9", "\u770b\u770b",
            "\u5904\u7406", "\u95ee\u9898", "\u5185\u5bb9", "please", "help",
            "how", "what", "the", "and", "with", "for", "this", "that"
    );

    private static final List<String> PRONOUNS = Arrays.asList(
            "\u5b83", "\u8fd9\u4e2a", "\u90a3\u4e2a", "\u8be5\u6280\u80fd",
            "\u6b64\u6280\u80fd", "the skill", "it", "this"
    );
}
