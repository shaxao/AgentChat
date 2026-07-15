# 技能系统

技能（Skill）是平台给对话「挂外挂」的机制：用户问到某个专业领域时，系统自动匹配相关技能，把技能的提示词/知识注入到对话里，让回答更专业。这一章讲**技能怎么被匹配出来**。

## 核心问题：从一句话找到该用的技能

用户发了一条消息，系统里可能有成百上千个技能。怎么快速挑出最相关的几个？这就是 `SkillMatchingService` 的职责。

它没有一上来就上向量检索那种重武器，而是先用一套**轻量打分**：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/SkillMatchingService.java:72"
  :notes="[
    { lines: '4-7', text: '关键词命中：技能配置了一组关键词，消息里每命中一个 +2 分。这是最直接的召回信号。' },
    { lines: '8-9', text: '名称命中：消息里直接提到技能名字，说明相关性很强，+3 分。' },
    { lines: '10-11', text: '热度加成：用得越多的技能，说明越靠谱，按使用次数给一个封顶 2 分的小加成。这样避免冷门技能和热门技能同分时排序随机。' }
  ]">

```java
public double scoreSkill(AgentSkill skill, String message) {
    double score = 0.0;
    String lower = message.toLowerCase();
    // 关键词命中
    for (String kw : parseKeywords(skill.getKeywords())) {
        if (lower.contains(kw.toLowerCase())) score += 2.0;
    }
    // 名称/描述相似度
    if (skill.getName() != null && lower.contains(skill.getName().toLowerCase())) score += 3.0;
    // 使用热度加成
    score += Math.min(2.0, nvl(skill.getUsageCount()) * 0.01);
    return score;
}
```

</SourceExplainer>

`matchSkills` 会对所有技能算分，然后取 `topK`。

::: tip 为什么先做简单版
关键词 + 名称 + 热度这套打分，代码几十行、零外部依赖、毫秒级返回。对大多数场景已经够用。等到发现召回不准，再叠加向量检索、LLM 判别器也不迟。这正是 [Harness 进化引擎](/java/harness) 里说的「技能匹配从一次算法演进为多路投票」的起点 —— 先能跑，再进化。
:::

## 匹配之后

匹配出的技能会在对话组装阶段把它们的提示词/知识注入到 system prompt。这一步和 [记忆系统](/java/memory) 的 `buildMemoryPrompt` 是同一类操作：**在调用 AI 之前，往上下文里拼装额外信息**。

技能系统还有对话式编辑、评分、文件管理、导入等一整套能力（`SkillConversationService` / `SkillRatingService` / `SkillFileManager` / `SkillImportController`），但从「理解对话怎么变聪明」的角度，`SkillMatchingService` 的打分逻辑是最核心的一块。

## 相关源码

- `service/SkillMatchingService.java` —— 匹配打分
- `service/SkillConversationService.java` —— 对话式编辑技能
- `service/SkillRatingService.java` —— 技能评分
- `controller/SkillImportController.java` —— 技能导入
