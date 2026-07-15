# SystemContext Epoch

这一章讲 AutoCode 里我个人最欣赏的一个设计。它解决的问题听起来很朴素——「Agent 每次该看多少上下文」——但它的解法，是整个系统能长期稳定运行的关键。

## 先理解痛点

AutoCode 在一个工作区里干活时，会往 `.autocode/` 目录写很多 markdown 文件：项目画像、项目地图、命令清单、计划、记忆、会话摘要、CI 报告、代码审查结论……随着任务推进，这些文件越来越多、越来越长。

早期的做法很直接：**每一轮循环，把这些文件全文读进来，拼进 prompt。**

这带来两个致命问题：

1. **token 爆炸**：文件越攒越多，每轮都全量拼接，输入 token 直线上升，成本和延迟都失控。
2. **无法感知变化**：Agent 不知道「相比上一轮，哪些上下文变了」。它每次都在一大团没有结构的文本里重新找重点，很容易忽略真正的增量。

一句话概括：**上下文不是越多越好，关键是「结构化」和「感知增量」。**

## 解法：manifest + hash + epoch

AutoCode 引入了一个清单文件 `.autocode/SYSTEM_CONTEXT.json` 作为**上下文的目录（manifest）**，而不是每次都读全文。

<SourceExplainer
  file="agent-platform/backend/runtime/system_context.py"
  :notes="[
    { lines: '1', text: '清单文件路径。它不存源码/文档正文，只存「有哪些上下文源、各自的指纹」。' },
    { lines: '3-16', text: '被纳入清单管理的上下文源。覆盖项目画像、地图、命令、计划、记忆、会话摘要、CI、审查、检索计划、契约、需求、说明。' }
  ]">

```python
SYSTEM_CONTEXT_PATH = ".autocode/SYSTEM_CONTEXT.json"

DEFAULT_SYSTEM_CONTEXT_SOURCES = (
    ".autocode/PROJECT_PROFILE.md",
    ".autocode/PROJECT_MAP.md",
    ".autocode/COMMANDS.md",
    ".autocode/PLAN.md",
    ".autocode/MEMORY.md",
    ".autocode/SESSION_SUMMARY.md",
    ".autocode/CONTEXT_SUMMARY.md",
    ".autocode/CI_REPORT.md",
    ".autocode/REVIEW.md",
    ".autocode/RETRIEVAL_PLAN.md",
    "SCRIPT_CONTRACT.md",
    "SPEC.md",
    "README.md",
)
```

</SourceExplainer>

清单里每个 source 记录这几项元数据：

| 字段 | 含义 | 作用 |
|------|------|------|
| `path` | 文件路径 | 定位 |
| `kind` | 类型（画像 / 计划 / 记忆…） | 分类与优先级判断 |
| `sha256` | 内容哈希 | **判断内容有没有变** |
| `mtime` | 修改时间 | 辅助判断 |
| `size` | 文件大小 | 预估 token |
| `priority` | 优先级 | 决定紧张时先看谁 |
| `summary` | 摘要 | **让 Agent 不读全文也能知道大意** |
| `epoch` | 世代号 | **变化发生在第几轮** |

## epoch（世代）是什么

`epoch` 是这个设计的灵魂。你可以把它理解成一个**全局递增的版本号**：每完成一轮 reconcile（校准），epoch + 1。

每个上下文源也记着自己「最后一次变化发生在哪个 epoch」。于是 Agent 可以问出一个非常精确的问题：

> 「从上个 epoch 到现在，哪些上下文的 sha256 变了？」

只有 hash 变化的源，才会进入 **changed sources**，被重点关注。没变的源，Agent 只看它的 `summary`，甚至完全跳过。

这就把「每轮全量拼接」变成了「每轮只关注增量」。

## 三个事件

这套机制会发出三个事件，让整个系统（包括前端和日志）都能观测上下文的流动：

| 事件 | 触发时机 | 含义 |
|------|----------|------|
| `system_context_indexed` | 首次建立清单 | 「我把工作区的上下文源都登记好了」 |
| `system_context_changed` | 检测到 hash 变化 | 「有 N 个源变了，这是增量」 |
| `system_context_reconciled` | 一轮校准完成 | 「epoch 推进，增量已消化」 |

回想上一章 [Agentic Loop](/autocode/agentic-loop) 的 `reconcile` 阶段——它做的正是：刷新 epoch、算 diff、发 `system_context_reconciled`。两章在这里闭环。

## 收益总结

- **默认看 manifest，不拼全文**：token 从「随文件数量线性增长」变成「基本恒定」。
- **只处理增量**：Agent 每轮聚焦真正变化的部分，决策更准。
- **可观测**：三个事件让上下文流动变得透明，方便调试「Agent 为什么没注意到某个变化」。
- **解决记忆膨胀**：这是长时间任务能稳定跑下去的前提——否则跑得越久，prompt 越臃肿，最后必然失控。

::: tip 设计思想的迁移
这套「manifest + 内容哈希 + 世代号 + 增量事件」的思路，本质上是把**操作系统的脏页/版本控制思想**搬到了 LLM 上下文管理里。当你自己设计长时运行的 Agent 时，这是一个非常值得复用的模式：不要问「我能塞多少上下文」，要问「相比上一步，什么变了」。
:::

## 相关源码

- `agent-platform/backend/runtime/system_context.py` — manifest 的建立、哈希、epoch 推进
- `agent-platform/backend/runtime/context_manager.py` — 上下文的组织与注入策略

下一步可以看 [Tool Registry](/autocode/tool-registry) 和 [Permission Engine](/autocode/permission-engine)，理解 Agent 在 `act` 阶段调用工具时，工具是怎么被注册和管控的。
