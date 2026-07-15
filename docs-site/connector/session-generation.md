# 会话代次机制

这一章拆解一个真实的 bug 和它的修复。它不长，但把「并发状态管理」讲得很透——是本手册里我最推荐精读的一章。

## 现象

> 用户从连接器打开一个**已授权**的项目，浏览器却不自动连接、不打开任务。

明明之前能用，为什么再打开就连不上了？这背后是**两处**独立的根因——一处在 Rust 端，一处在前端。两处都修好，问题才彻底消失。

## 背景：会话是怎么建立的

从浏览器打开本地项目时，URL 会带上 `local_grant_id` / `local_project_path`，但**不一定带 `task_id`**（取决于授权记录里是否存了 task_id，见 `services/local_project_grants.py` 的 `open_url`）。

每次打开项目，后端都会调用 `enable(task_id)` **铸造一个全新 token 的会话**。特别注意：**后端一重启，内存里的旧 session 全部丢失**。

这就埋下了祸根：如果连接器还固执地连着那个「已经死掉的旧会话」，它就永远连不上新会话。

## 根因一：Rust 端的「布尔闸门」

原来的连接器用一个简单的布尔标志控制是否已在运行：

<SourceExplainer
  file="agent-platform/local-connector/src-tauri/src/main.rs（重构前）"
  :notes="[
    { lines: '1', text: '一个布尔标志：连接器是否已经在跑。' },
    { lines: '3-6', text: '致命逻辑：只要已经在运行，新来的深链就被直接忽略。于是「打开新项目」这个动作根本触发不了新连接——连接器还连着上一个（很可能已经死掉的）会话。' }
  ]">

```rust
let runner_started: bool = /* 全局状态 */;

fn on_deep_link(url: Url) {
    if runner_started {
        // 已经在跑了，忽略新的深链
        return;              // ← 新会话永远建立不起来
    }
    start_runner(url);
}
```

</SourceExplainer>

问题的本质：**布尔标志只能表达「有没有在跑」，无法表达「跑的是不是最新那个」。** 而我们真正需要的语义是后者。

## 修法一：代次机制（generation）

改用一个**单调递增的世代计数器**，用原子类型保证并发安全：

<SourceExplainer
  file="agent-platform/local-connector/src-tauri/src/connector.rs"
  :notes="[
    { lines: '1', text: '用 Arc<AtomicU64> 存「当前活跃代次」。Arc 让多个异步任务共享它，AtomicU64 保证并发读写安全。' },
    { lines: '3-7', text: 'start_runner 每次被调用（每次打开新项目）都 fetch_add(1) 抢占一个更大的代次号，并把它交给新的连接循环。' },
    { lines: '9-11', text: '旧的连接循环持有的是较小的 generation。它会不断和 active_generation 比对，一旦发现自己过期，就主动退出。' }
  ]">

```rust
let active_generation: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

fn start_runner(url: Url) {
    // 抢占一个新的代次号
    let generation = active_generation.fetch_add(1, Ordering::SeqCst) + 1;
    spawn(run_connector_loop(url, generation, active_generation.clone()));
}

// 每个连接循环都知道自己的 generation，
// 并持有 active_generation 的共享引用用于比对。
```

</SourceExplainer>

抢占之后，关键在于让**被抢占的旧循环优雅退出**。这靠两个检查点：

<SourceExplainer
  file="agent-platform/local-connector/src-tauri/src/connector.rs（run_connector_loop）"
  :notes="[
    { lines: '2-4', text: '检查点 A：外层重连循环每次开头，先看自己是不是最新代次。不是就直接 return，不再重连。' },
    { lines: '7-13', text: '检查点 B：内层用 tokio select! 同时等两件事——WebSocket 消息，以及每 500ms 触发一次的 supersede_check。' },
    { lines: '10-12', text: '一旦 supersede 分支发现代次被抢占，就给对端发 Message::Close 优雅关闭，然后退出。不是硬断连，而是礼貌地告别。' }
  ]">

```rust
loop {
    // 检查点 A：外层循环开头
    if generation != active_generation.load(Ordering::SeqCst) {
        return;  // 我已过期，停止重连
    }
    let mut ws = connect().await?;
    loop {
        select! {
            msg = ws.next() => { handle(msg); }
            // 检查点 B：每 500ms 检查一次是否被抢占
            _ = supersede_check(&generation, &active_generation) => {
                ws.send(Message::Close(None)).await.ok();
                return;  // 优雅退出
            }
        }
    }
}
```

</SourceExplainer>

还有一个细节容易忽略：**过期循环产生的 `update` 回调必须丢弃**，否则它可能用旧会话的状态覆盖掉新会话的正确状态。

::: tip 为什么代次机制比布尔标志好
布尔标志是「二值状态」，只能回答「有没有」。代次号是「单调时间戳」，能回答「谁更新」。当你的系统里存在「同一资源的多个版本竞争，只有最新的有效」这类问题时——无论是连接、请求、还是缓存——代次 / 版本号几乎总是比布尔标志更正确的模型。这和数据库的 MVCC、前端请求的「丢弃过期响应」是同一个思想。
:::

## 根因二：前端的「永久置位」

Rust 修好后，还有一半问题在前端 `app/src/pages/AutoCodePage.tsx`（约 1937 行的 effect）。

任务列表是**分批到达**的。问题出在：当首批 `tasks` 已经非空、但还不包含目标任务时——

<SourceExplainer
  file="app/src/pages/AutoCodePage.tsx（重构前，约 L1937）"
  :notes="[
    { lines: '2-3', text: '目标任务还没到（分批加载中），走 !matched 分支。' },
    { lines: '4-5', text: 'bug：这里把 autoConnectGrantRef 永久置位了。含义变成「这个 grant 已经处理过，别再管了」。' },
    { lines: '7-8', text: '于是后续 tasks 更新、目标任务终于到达时，effect 因为 ref 已置位而不再重试 → 永远不自动连接。' }
  ]">

```ts
useEffect(() => {
  const matched = tasks.find(t => matchesGrant(t, grant));
  if (!matched) {
    // ✗ 永久置位：以后 tasks 再更新也不重试了
    autoConnectGrantRef.current = dedupeKey;
    return;
  }
  autoConnect(matched);
}, [tasks, grant]);
```

</SourceExplainer>

修法是**区分「已成功处理」和「暂时没匹配上」两种状态**：

<SourceExplainer
  file="app/src/pages/AutoCodePage.tsx（重构后）"
  :notes="[
    { lines: '3-6', text: '没匹配上时，不再污染 autoConnectGrantRef，而是用一个独立的 warnedRef 只提示一次，允许随 tasks 更新继续重试。' },
    { lines: '9-11', text: '只有真正成功匹配后，才落 autoConnectGrantRef 做去重。这样「暂时没到」和「已经处理」被清晰分开。' }
  ]">

```ts
useEffect(() => {
  const matched = tasks.find(t => matchesGrant(t, grant));
  if (!matched) {
    // 只提示一次，但保留重试机会
    if (autoConnectNoMatchWarnedRef.current !== dedupeKey) {
      autoConnectNoMatchWarnedRef.current = dedupeKey;
      toast('任务加载中，稍候自动连接…');
    }
    return;  // 不落 dedupe，下次 tasks 更新会再进来
  }
  autoConnect(matched);
  autoConnectGrantRef.current = dedupeKey;  // 成功后才去重
}, [tasks, grant]);
```

</SourceExplainer>

## 两处根因的关系

<FlowTimeline
  title="打开已授权项目 → 自动连接（修复后）"
  :steps="[
    { system: 'React', title: '深链唤起连接器', detail: 'muhuo-autocode://…?local_grant_id=…（由浏览器发起）' },
    { system: 'Rust', title: 'start_runner 抢占新代次', detail: 'active_generation.fetch_add(1)，旧循环收到 Close 优雅退出' },
    { system: 'Rust', title: '连上后端新会话', detail: 'enable(task_id) 铸造的新 token 会话' },
    { system: 'AutoCode', title: '推送任务列表（分批）', detail: 'SSE / WS 逐批下发' },
    { system: 'React', title: '目标任务到达时重试匹配', detail: '不再被永久置位卡死，成功后才去重' },
    { system: 'React', title: '自动打开任务、建立连接', detail: '现象修复' }
  ]"
/>

- **Rust 端**保证了「永远连的是最新会话」。
- **前端**保证了「任务分批到达也能连上」。

两者缺一不可：只修 Rust，前端仍会因为分批加载卡住；只修前端，连接器还连着死会话。

## 验证方式

- Rust：`cargo check` 通过（本机需设 `RUSTUP_HOME=.rustup CARGO_HOME=.cargo`，因为没有默认 toolchain）。
- 前端：`cd app && npx tsc --noEmit` 通过。

::: warning 一个容易踩的坑
Web 前端是 `app/`，**不是** `agent-platform/frontend/`。后者是 AutoCode 平台早期的 Next.js 控制台，真正和连接器配合的生产 Web 端是 `app/`。读代码时别找错目录。
:::
