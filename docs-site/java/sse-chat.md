# SSE 流式对话

这一章讲「为什么 AI 的回答是一个字一个字冒出来的」，以及后端如何把上游模型的流式输出，一路透传到浏览器。它是整个平台里最高频的一条链路。

## 先感受一下效果

<SSEStreamDemo
  thinking="让我先看历史上下文，再决定怎么回答。"
  content="SSE（Server-Sent Events）是一种服务器向浏览器单向推送的技术。和 WebSocket 不同，它更轻量，天然适合“聊天逐字输出”这种场景。"
/>

## 端点长什么样

流式对话的入口在 `ChatController.sendMessageStream`，注意它的返回类型是 `SseEmitter`，`produces` 是 `text/event-stream`：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/controller/ChatController.java:176"
  :notes="[
    { lines: '1-6', text: '端点声明。produces 指定 SSE 媒体类型，返回 SseEmitter —— Spring MVC 的服务端推送发射器。' },
    { lines: '8-10', text: '按是否为 Agent 模式区分超时：Agent 因为要多轮工具调用，给 30 分钟；普通对话给 3 分钟。超时值直接决定长连接能挂多久。' },
    { lines: '12', text: '把整段流式处理提交到独立线程池 sseExecutor，不阻塞 Tomcat 的请求线程 —— 否则并发一高，Tomcat 线程就被长连接占满了。' }
  ]">

```java
@PostMapping(value = "/conversations/{uuid}/messages/stream",
             produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter sendMessageStream(
        @RequestAttribute Long userId,
        @PathVariable String uuid,
        @RequestBody ChatDTO.SendMessageRequest req,
        HttpServletRequest httpRequest) {

    boolean isAgent = req.getAgentId() != null && !req.getAgentId().isBlank();
    SseEmitter emitter = new SseEmitter(isAgent ? 1_800_000L : 180_000L);
    String requestIp = ClientIpUtil.getClientIp(httpRequest);

    sseExecutor.submit(() -> {
        // ... 流式处理
    });
    return emitter;
}
```

</SourceExplainer>

`@RequestAttribute Long userId` 直接拿到了当前登录用户 —— 这正是 [JWT + RBAC](/java/auth-rbac) 那一章里 `JwtFilter` 提前塞进 request attribute 的结果。业务代码完全不用碰 token。

## 线程池里都做了什么

提交到 `sseExecutor` 的任务，按顺序做这几件事（都会向前端推 SSE 事件）：

1. 校验用户订阅的模型限制（`checkModelLimit`），不通过就推 `error` 事件并 `complete()`。
2. 确保对话存在（`ensureConversationExists`）—— H2 重启丢数据时自动重建，避免「对话不存在」导致流被截断。
3. 加载历史上下文（`getHistoryForAi`，**不含**当前这条消息）。
4. 保存用户消息（`saveUserMessage`），推 `user` 事件带回 msgId。
5. 调用 `AiService` 的流式方法，把上游 token 逐个通过 `content` 事件推给前端。

::: tip 为什么要先加载历史、再保存当前消息
如果先保存再加载，当前这条用户消息会混进「历史」里重复一次。顺序在这里是有意为之的。
:::

## 核心：AiService 如何读上游的流

真正跟模型 API 打交道的是 `AiService.streamChat`。它用 JDK 的 `HttpClient` 拿到一个 `InputStream`，然后 `BufferedReader` 逐行读，交给 **Provider 适配器**解析：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/AiService.java:442"
  :notes="[
    { lines: '1-3', text: '逐行读取上游 SSE 流。isStreamDone 由适配器判断流是否结束（不同厂商的结束标记不一样）。' },
    { lines: '4-5', text: 'parseStreamLine 是适配器方法：把一行原始 SSE 文本解析成本次增量的正文 token。厂商差异全部收敛在这里。' },
    { lines: '6-9', text: '拿到非空 token 就累加到 fullContent，并通过 onToken 回调交给上层 —— 上层再 emitter.send 推给前端。这就是“逐字冒出来”的源头。' }
  ]">

```java
try (BufferedReader reader = new BufferedReader(new InputStreamReader(response.body()))) {
    String line;
    while ((line = reader.readLine()) != null) {
        if (adapter.isStreamDone(ctx)) break;
        int thinkingLenBefore = ctx.thinkingBuilder.length();
        String tokenText = adapter.parseStreamLine(line, ctx);
        emitThinkingDelta(ctx, thinkingLenBefore);
        if (tokenText != null && !tokenText.isEmpty()) {
            fullContent.append(tokenText);
            onToken.accept(tokenText);
        }
    }
}
```

</SourceExplainer>

`adapter` 就是下一章 [Provider 架构](/java/provider) 的主角。这里只需记住：**AiService 只管「逐行读、回调吐 token」，具体怎么解析一行交给适配器**。这是一个干净的职责分层。

## 全链路时序

把前后端串起来看，一次流式对话经过这些关键动作：

<FlowTimeline
  title="一次流式对话的关键动作"
  :steps='[
    { system: "React", title: "用户点发送", detail: "ChatPage 发起 POST …/messages/stream", file: "app/src/pages/ChatPage.tsx" },
    { system: "Nginx", title: "反向代理", detail: "proxy_buffering off 保证流式不被缓冲", file: "app/nginx.conf:43" },
    { system: "Spring Boot", title: "创建 SseEmitter", detail: "agent 30 分钟 / 普通 3 分钟超时", file: "ChatController.java:185" },
    { system: "Spring Boot", title: "线程池提交任务", detail: "sseExecutor.submit，不阻塞 Tomcat 线程", file: "ChatController.java:188" },
    { system: "Spring Boot", title: "加载历史 + 保存用户消息", detail: "getHistoryForAi 后 saveUserMessage", file: "ChatController.java:243" },
    { system: "Spring Boot", title: "调用 AiService", detail: "streamChat 逐行读取上游 SSE", file: "AiService.java:270" },
    { system: "Java", title: "适配器解析", detail: "adapter.parseStreamLine 逐行解析", file: "AiService.java:447" },
    { system: "Java", title: "onToken 回调", detail: "每个 token 触发 onToken.accept()", file: "AiService.java:451" },
    { system: "Spring Boot", title: "推送 SSE 事件", detail: "emitter.send(content 事件)", file: "ChatController.java" },
    { system: "React", title: "前端逐字渲染", detail: "getReader() 读流，追加到气泡", file: "app/src/pages/ChatPage.tsx" }
  ]'
/>

前端怎么读这个流、怎么逐字渲染，见 [流式渲染管线](/frontend/streaming-render)。整条链路的端到端追踪，见 [一次对话的一生](/deep-dive/chat-lifecycle)。
