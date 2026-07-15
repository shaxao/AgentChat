# Tauri 架构

上一章 [会话代次机制](/connector/session-generation) 讲了连接器最精彩的一个 bug 修复。这一章退回来讲整体：连接器作为一个 **Tauri 桌面应用**是怎么搭起来的。

## 为什么选 Tauri

连接器要做的事（回看 [为什么需要连接器](/connector/why)）：在用户本机跑命令、读写本地文件、和云端后端建立 WebSocket、响应浏览器深链。这需要一个**能访问操作系统、又能跟 Web 前端通信**的载体。

候选方案里，Electron 是最常见的，但它打包整个 Chromium，动辄上百 MB。**Tauri** 用系统自带的 WebView + Rust 后端，产物小得多，而且 Rust 天然适合写这种「系统级、要求稳」的常驻进程。

| 维度 | Electron | Tauri（本项目选择） |
|------|----------|---------------------|
| 后端语言 | Node.js | Rust |
| UI 渲染 | 打包 Chromium | 系统 WebView |
| 产物体积 | 大（~100MB+） | 小（~10MB 级） |
| 系统能力 | Node API | Rust + Tauri command |

## 两层结构

Tauri 应用天然分两层，本项目的 `agent-platform/local-connector/` 也是这个结构：

<ArchitectureDiagram
  title="连接器的 Tauri 两层结构"
  :nodes='[
    { id: "os", label: "操作系统", sub: "文件 / 进程 / 网络", x: 320, y: 20, group: "infra" },
    { id: "rust", label: "Rust 核心 (src-tauri)", sub: "main.rs / connector.rs", x: 300, y: 130, w: 240, group: "rust" },
    { id: "web", label: "WebView UI (src)", sub: "main.ts / style.css", x: 320, y: 250, group: "frontend" },
    { id: "cloud", label: "云端后端", sub: "WebSocket / HTTP", x: 40, y: 130, group: "python" },
    { id: "browser", label: "浏览器", sub: "深链 muhuo-autocode://", x: 600, y: 250, group: "user" }
  ]'
  :edges='[
    { from: "rust", to: "os", label: "系统调用" },
    { from: "web", to: "rust", label: "Tauri command / event" },
    { from: "rust", to: "cloud", label: "WS 长连接" },
    { from: "browser", to: "rust", label: "深链唤起" }
  ]'
/>

- **Rust 核心（`src-tauri/`）**：真正干活的地方。跑命令、读写文件、维护和云端的 WebSocket、处理深链。代次机制（`active_generation: Arc<AtomicU64>`）就住在这里。
- **WebView UI（`src/`）**：一个轻量前端，负责给用户展示连接状态、授权项目列表等。它通过 Tauri 的 command / event 机制和 Rust 核心通信。

## 深链：浏览器怎么唤起连接器

连接器注册了自定义协议 `muhuo-autocode://`。当用户在网页里点「用连接器打开项目」，浏览器就唤起这个协议，把参数传给连接器：

```
muhuo-autocode://open?local_grant_id=xxx&local_project_path=/path/to/project
```

注意一个细节（这条来自项目的实战记忆）：深链**不一定带 `task_id`**——取决于授权（grant）里有没有存。所以 Web 前端归一化匹配任务时，要靠 `task_id` **或** `project_root` / `title` 兜底。这正是 [会话代次机制](/connector/session-generation) 那章前端侧 bug 的背景。

## 常驻循环与优雅退出

连接器是个常驻进程。它的核心是 `run_connector_loop`：外层循环维持 WebSocket 连接，内层用 `select!` 同时监听：

- 云端来的消息（执行工具、拉取状态）
- 每 500ms 一次的 `supersede_check`（检查自己有没有被新代次抢占）

一旦检测到代次变化，就发 `Message::Close` **优雅退出**，把连接让给新会话——而不是硬断。这种「协作式退出」是写常驻网络进程的好习惯：主动、干净地释放资源，比被动超时断开可控得多。

## 小结

- 连接器是个 **Tauri 桌面应用**，选 Tauri 而非 Electron 是为了小体积 + Rust 的系统级稳定性。
- 结构分两层：**Rust 核心**（`src-tauri/`，干系统活）+ **WebView UI**（`src/`，展示状态）。
- 通过自定义协议 `muhuo-autocode://` 响应浏览器深链；深链参数不保证带 `task_id`，前端需多字段兜底匹配。
- 常驻循环用 `select!` 同时处理云端消息和代次抢占检查，被抢占时发 `Message::Close` 优雅退出。

连接器三章到此结束。建议接着看 [全链路专题](/deep-dive/chat-lifecycle)，把三个系统拼成端到端的完整故事。
