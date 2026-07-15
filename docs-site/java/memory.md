# 记忆系统

让 AI「记住用户」是对话产品的核心竞争力之一。这一章讲 Java 主系统这一侧的对话记忆：怎么从对话里**抽取**值得记的信息、怎么在下一次对话时**召回**它、怎么**注入**进 prompt。

::: tip 两套记忆别混淆
本项目里有两套记忆：
- **Java 侧对话记忆**（本章）：面向普通聊天用户的画像/偏好/事实，服务于「AI 越聊越懂你」。
- **AutoCode 侧 SystemContext**（见 [SystemContext Epoch](/autocode/system-context)）：面向编程 Agent 的工作区上下文，服务于「长任务不迷失」。

两者解决的问题不同，别搞混。
:::

## 三个动作：抽取 / 召回 / 注入

对话记忆的生命周期就是这三步，分别对应 `MemoryService` 的三个方法。

### 1. 抽取（extract）

一次对话结束后，用一个**便宜的小模型**去分析这轮对话，判断有没有值得长期记住的信息：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/MemoryService.java:53"
  :notes="[
    { lines: '1-3', text: '构建抽取专用 prompt，把用户消息和 AI 回复喂进去，让模型判断有哪些值得记的信息。' },
    { lines: '5-6', text: '用异步、低温度(0.3)、小 token 上限(500)调用抽取模型。低温度让抽取更稳定，不发散。' },
    { lines: '7-11', text: '解析模型返回的记忆条目，逐条 saveOrUpdate——已存在的更新，新的插入。返回抽取结果。' }
  ]">

```java
public Mono<MemoryExtractionResult> extractAndSaveMemories(Long userId, String userMessage, String aiResponse) {
    String extractionPrompt = buildExtractionPrompt(userMessage, aiResponse);

    return aiService.chatAsync(extractionModel, extractionPrompt, List.of(), userMessage, 0.3, 500)
            .map(result -> {
                List<UserMemory> extracted = parseMemories(userId, result.getContent());
                for (UserMemory memory : extracted) {
                    saveOrUpdateMemory(memory);
                }
                return new MemoryExtractionResult(extracted);
            });
}
```

</SourceExplainer>

用小模型、异步、低温度——这三个选择都是为了「抽取记忆」这件事本身不该拖慢也不该拖贵主对话。

### 2. 召回（retrieve）

下一次对话开始时，要从这个用户的所有记忆里挑出**跟当前问题相关的**：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/MemoryService.java:67"
  :notes="[
    { lines: '3-8', text: '拉取该用户所有未删除记忆，按更新时间倒序——越近更新的越靠前。' },
    { lines: '11-16', text: '两条召回规则：高权重记忆(weight ≥ 8)无条件注入；其余靠关键词命中当前消息。' },
    { lines: '17', text: '最多召回 10 条，避免注入过多稀释重点、也控制 token。' }
  ]">

```java
public List<UserMemory> getRelevantMemories(Long userId, String currentMessage) {
    List<UserMemory> all = memoryMapper.selectList(
            new LambdaQueryWrapper<UserMemory>()
                    .eq(UserMemory::getUserId, userId)
                    .eq(UserMemory::getDeleted, 0)
                    .orderByDesc(UserMemory::getUpdatedAt));
    if (all.isEmpty()) return List.of();

    String lower = currentMessage.toLowerCase();
    return all.stream()
            .filter(m -> {
                if (m.getContent() == null) return false;
                if (m.getWeight() != null && m.getWeight() >= 8) return true;   // 高权重始终注入
                return keywordMatch(lower, m.getContent().toLowerCase());        // 关键词命中
            })
            .limit(10)
            .collect(Collectors.toList());
}
```

</SourceExplainer>

这里用的是**关键词匹配 + 权重**的朴素召回，没有上向量检索。对一个中小规模的对话记忆库来说，这是务实的选择——实现简单、可解释、够用。真要扩展，可以在 `keywordMatch` 这一层换成向量相似度。

### 3. 注入（inject）

召回到的记忆，要拼成一段 prompt 片段，塞进系统提示词里：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/MemoryService.java:120"
  :notes="[
    { lines: '2-5', text: '没有相关记忆就返回空串——不注入任何东西，不污染 prompt。' },
    { lines: '10-11', text: '按记忆类型分组：preference(偏好) / fact(事实) / profile(画像)。' },
    { lines: '13-22', text: '把中文类型名和内容拼成 [用户记忆] 段落。注意措辞：请自然地运用，而不是生硬复述——引导模型把记忆用得不着痕迹。' }
  ]">

```java
public String buildMemoryPrompt(Long userId, String currentMessage) {
    List<UserMemory> memories = getRelevantMemories(userId, currentMessage);
    if (memories.isEmpty()) return "";

    StringBuilder sb = new StringBuilder();
    sb.append("\n\n[用户记忆]\n");
    sb.append("以下是关于用户的已知信息，请在回答时自然地运用这些信息：\n");

    Map<String, List<UserMemory>> byType = memories.stream()
            .collect(Collectors.groupingBy(UserMemory::getMemoryType));

    for (Map.Entry<String, List<UserMemory>> entry : byType.entrySet()) {
        String typeName = switch (entry.getKey()) {
            case "preference" -> "偏好";
            case "fact" -> "事实";
            case "profile" -> "画像";
            default -> "其他";
        };
        sb.append("- ").append(typeName).append(": ");
        sb.append(entry.getValue().stream()
                .map(UserMemory::getContent)
                .collect(Collectors.joining("; ")));
        sb.append("\n");
    }
    return sb.toString();
}
```

</SourceExplainer>

## 记忆的类型与权重

- **memoryType**：`preference`（偏好，如「喜欢简洁回答」）/ `fact`（事实，如「在做餐饮创业」）/ `profile`（画像，如职业、行业）。
- **weight**：权重，决定召回优先级。≥ 8 的高权重记忆**每次都注入**，不管当前问题是什么——这类是「关于这个人最本质、始终成立」的信息。

## 完整闭环

把三步串起来，就是「越聊越懂你」的实现：

<FlowTimeline
  title="对话记忆的一次完整闭环"
  :steps='[
    { system: "React", title: "用户发新消息", detail: "进入 SSE 对话流程" },
    { system: "Java", title: "召回相关记忆", detail: "getRelevantMemories：关键词 + 高权重" },
    { system: "Java", title: "注入系统提示词", detail: "buildMemoryPrompt 拼接 [用户记忆] 段" },
    { system: "Java", title: "带记忆调用模型", detail: "模型据此给出更懂用户的回答" },
    { system: "Java", title: "对话后异步抽取", detail: "小模型分析本轮，抽取新记忆" },
    { system: "MySQL", title: "saveOrUpdate 记忆", detail: "下一轮召回就能用上" }
  ]'
/>

## 相关源码

- `backend/src/main/java/com/aiplatform/backend/service/MemoryService.java` — 抽取 / 召回 / 注入
- `backend/src/main/java/com/aiplatform/backend/entity/UserMemory.java` — 记忆实体（type / content / weight）
- `docs/memory_layered_architecture.md` — 分层记忆架构设计文档

更宏观的「记忆分层」思想（对话级 / 会话级 / 归档级）可以读仓库里的 `docs/memory_layered_architecture.md`，那是对记忆生命周期更完整的规划。
