# 技术栈全景

这一章是一张「地图的图例」。把全项目用到的技术按子系统列清楚，并说明**为什么选它**——选型理由往往比技术本身更值得学。

## 一图看全

| 子系统 | 语言 | 核心框架/库 | 规模 |
|--------|------|-------------|------|
| Java 主系统 | Java 17 | Spring Boot 3.2、MyBatis Plus、Spring Security、JWT | ~46.8K 行 |
| React 前端 | TypeScript | React 18、Vite 5、Tailwind、shadcn/ui、Zustand | ~53.4K 行 |
| Python AutoCode | Python 3.11 | FastAPI、Claude Code SDK、pydantic | ~28.7K 行 |
| Rust 连接器 | Rust | Tauri | ~33.6K 行 |
| 基础设施 | — | MySQL 8、Redis 7、Docker、Nginx | — |

## Java 主系统

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| Spring Boot 3.2 | Web / DI / 事务 | 业务系统事实标准，生态成熟 |
| MyBatis Plus | ORM | 相比 JPA 更贴近 SQL，复杂查询可控性强 |
| Spring Security + JWT | 认证授权 | 无状态 token，适合前后端分离 + 多端 |
| Redis | 验证码、缓存 | 带 TTL 的临时数据天然适配 |
| SSE (Server-Sent Events) | 流式对话 | 比 WebSocket 轻，单向推送足够，浏览器原生支持 |

深入细节见 [Java 分层架构总览](/java/architecture)。

## React 前端

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| Vite 5 | 构建/开发服务器 | 冷启动快、HMR 秒级，`manualChunks` 手动分包 |
| Zustand | 状态管理 | 比 Redux 轻，无样板代码，hook 即用 |
| shadcn/ui + Radix | 组件体系 | 源码即组件，可完全定制，无黑盒 |
| Tailwind CSS | 样式 | 原子化，配合 shadcn 一致性好 |
| marked + KaTeX + Shiki | 富文本渲染 | 分别处理 Markdown、数学公式、代码高亮 |
| react-virtuoso | 虚拟滚动 | 长对话列表性能关键 |
| @xyflow/react | 工作流画布 | 节点拖拽/连线的成熟方案 |

深入细节见 [Vite 构建体系](/frontend/build)。

## Python AutoCode

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| FastAPI | Web / SSE | async 原生、pydantic 校验、自动文档 |
| Claude Code SDK | Agent 能力 | 直接复用成熟的 agentic 工具循环 |
| pydantic | 数据契约 | schema 校验 + 序列化 |
| Docker SDK | 执行隔离 | 每个任务在独立容器跑，安全边界清晰 |

深入细节见 [AutoCode 愿景与定位](/autocode/vision)。

## Rust 连接器

| 技术 | 用途 | 选型理由 |
|------|------|----------|
| Tauri | 桌面应用外壳 | 比 Electron 轻，Rust 后端 + Web 前端 |
| Rust | 本地执行/连接逻辑 | 内存安全、跨平台原生性能 |

为什么要一个桌面连接器？见 [为什么需要连接器](/connector/why)。

## 本学习站自己

顺带一提，你正在看的这个站也是项目的一部分：

| 技术 | 用途 |
|------|------|
| VitePress | 文档站框架（Vite + Vue） |
| Vue 3 组件 | 交互动画（架构图、Agentic Loop 动画等） |
| Pyodide (WASM) | 浏览器内跑真实 Python |
| iframe sandbox | 浏览器内跑 JS/HTML |

所以本站的 [代码 Playground](/frontend/code-preview) 和主项目的「浏览器内代码执行」用的是同源技术——学到的东西可以直接迁移。

## 下一步

技术清单心里有数了，去 [本地启动指南](/guide/getting-started) 把它跑起来。
