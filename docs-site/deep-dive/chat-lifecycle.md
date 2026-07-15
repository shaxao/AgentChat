# 一次对话的一生

前面各章把系统拆成了一个个零件。这一章反过来：跟着**一条用户消息**，从按下发送到最后一个字冒出来，走完全程。把零件拼回整机。

## 全链路时序

<FlowTimeline
  title="一次流式对话，从点击发送到逐字渲染"
  :steps='[
    { system: "React", title: "用户点发送", detail: "ChatPage 发起 POST …/messages/stream，乐观插入用户气泡", file: "app/src/pages/ChatPage.tsx" },
    { system: "Nginx", title: "反向代理", detail: "proxy_buffering off 保证流式不被缓冲", file: "app/nginx.conf:43" },
    { system: "Spring Boot", title: "创建 SseEmitter", detail: "agent 30 分钟 / 普通 3 分钟超时", file: "ChatController.java:185" },
    { system: "Spring Boot", title: "线程池提交", detail: "sseExecutor.submit，不阻塞 Tomcat 线程", file: "ChatController.java:188" },
    { system: "Spring Boot", title: "订阅/余额校验", detail: "checkModelLimit 检查套餐模型限制", file: "ChatController.java:203" },
    { system: "Spring Boot", title: "加载历史", detail: "getHistoryForAi（不含当前消息）", file: "ChatController.java:243" },
    { system: "Spring Boot", title: "保存用户消息", detail: "saveUserMessage，推送 user 事件", file: "ChatController.java:246" },
    { system: "Java", title: "模型路由", detail: "ModelRoutingService 打分选模型 + 熔断过滤", file: "ModelRoutingService.java:92" },
    { system: "Java", title: "调用 AiService", detail: "streamChat 逐行读上游 SSE", file: "AiService.java:270" },
    { system: "Java", title: "Provider 适配", detail: "adapter.parseStreamLine 解析各厂商格式", file: "AiService.java:447" },
    { system: "Java", title: "onToken 回调", detail: "每个 token 触发 onToken.accept()", file: "AiService.java:451" },
    { system: "Spring Boot", title: "推送 SSE 事件", detail: "emitter.send(content / thinking 事件)", file: "ChatController.java" },
    { system: "React", title: "逐字渲染", detail: "getReader + TextDecoder 解析 event/data", file: "app/src/pages/ChatPage.tsx:820" },
    { system: "Java", title: "计费与记忆", detail: "WalletService.consume 扣费；MemoryService 异步抽取记忆；CacheLedger 上报用量", file: "WalletService.java" }
  ]'
/>

## 三个值得回味的设计

**① 流式的两端对称。** 后端 `AiService` 用 `BufferedReader` 逐行读**上游**厂商的 SSE，前端 `ChatPage` 用 `getReader()` 逐行读**后端**的 SSE。同一种「逐行解析 `event:`/`data:`、按 `\n\n` 分包」的模式，在两端各出现一次。理解了一端，另一端自然通。详见 [SSE 流式对话](/java/sse-chat) 和 [流式渲染管线](/frontend/streaming-render)。

**② 关注点分离的漂亮示范。** 「你是谁」（[JWT + RBAC](/java/auth-rbac)）在过滤器里一次性算好；「用哪个模型」（[模型路由](/java/model-routing)）由路由服务打分决定；「怎么调厂商」（[Provider 架构](/java/provider)）由适配器屏蔽差异。Controller 只负责编排，每一层只操心自己的事。

**③ 副作用不挡主链路。** 扣费、记忆抽取、用量上报都在回答**生成完之后**做，而且用异步/降级保护——[CacheLedger](/java/cache-ledger) 上报失败只记 debug 日志，[记忆](/java/memory)抽取是异步 `Mono`。用户的「逐字体验」永远优先。

## 一句话总结

一次对话 = **鉴权 → 校验 → 选模型 → 屏蔽厂商差异 → 双端流式 → 事后结算**。这条链路把这个平台几乎所有 Java 侧的核心模块都串了一遍——它是理解整个主系统的最佳切入点。

接着看 [一次 AutoCode 任务](/deep-dive/autocode-task)，感受「自主循环」比「一问一答」复杂在哪。
