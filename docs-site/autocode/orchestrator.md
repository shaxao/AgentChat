# 编排器 Orchestrator

`agent_orchestrator.py` 是 AutoCode 后端最大、最核心的文件。它把前面几章讲过的东西——[Agentic Loop](/autocode/agentic-loop)、[SystemContext Epoch](/autocode/system-context)、[Tool Registry](/autocode/tool-registry)、[Permission Engine](/autocode/permission-engine)——真正串成一个能自主干活的循环。

这一章不逐行讲（它太大了），而是挑几个最能体现设计思想的函数，让你理解「一个自主编程 Agent 的编排层到底在操心什么」。

## 编排器在操心什么

从这个文件里的私有函数名，就能读出编排器的职责边界：

| 函数 | 操心的事 |
|------|----------|
| `_execution_mode` | 走 agentic 自主循环，还是 planned 固定阶段 |
| `_select_validation_command` | 写完代码后，该跑什么命令来验证 |
| `_snapshot_changed` / `_snapshot_deleted` | 这一轮 Agent 到底改了/删了哪些文件 |
| `_agent_iteration_policy` | 这个任务最多允许循环几轮 |
| `_classify_ci_failure` | 验证失败了，是什么类型的失败 |
| `_review_is_passed` | 代码审查过没过 |
| `_check_retrieval_read_guard` | Agent 想读的文件，是不是它该读的 |
| `_tool_cache_key` | 这次工具调用能不能命中缓存 |

一句话概括：**编排器不写代码，它决定「什么时候让 Agent 做什么、做完怎么验、验不过怎么办」。**

## 要点一：验证命令是自动选的

Agentic Loop 里 `verify` 阶段要「运行合适的验证」。但「合适」是什么，取决于项目类型。编排器用 `_select_validation_command` 根据工作区里的文件自动判断：

- 有 `package.json` → 可能跑 `npm run build` / `npm test`
- 有 `pytest` 相关 → 跑 `pytest`
- 纯前端静态页 → 可能只做产物存在性检查

这就避免了「拿 Node 的测试命令去验证 Python 项目」这种荒谬情况。验证命令是**从项目实际形态推断**出来的，不是写死的。

## 要点二：靠文件快照判断「Agent 真干活了没」

这是编排器一个很务实的设计。Agent 说「我改好了」，但真的改了吗？编排器不信口头汇报，它做**文件系统快照对比**：

<SourceExplainer
  file="agent-platform/backend/core/agent_orchestrator.py"
  :notes="[
    { lines: '1-3', text: '执行工具前，给工作区拍一张快照：每个文件的大小和修改时间。' },
    { lines: '5-7', text: '执行后再拍一张，对比两张快照的差异，得出这一轮真正变化的文件列表。' },
    { lines: '9', text: '如果一轮下来文件快照没有任何变化，就说明 Agent 其实没干活——这会触发特殊处理，避免它空转循环。' }
  ]">

```python
before = _workspace_file_snapshot(ws_path)
# ... Agent 执行工具 ...
after = _workspace_file_snapshot(ws_path)
changed = _snapshot_changed(before, after)
deleted = _snapshot_deleted(before, after)

if not changed and not deleted:
    _mark_agentic_no_change_retryable(task, "本轮无文件变更")
```

</SourceExplainer>

回想 [Agentic Loop](/autocode/agentic-loop) 里的翻车例子——「冒烟测试阶段没有源码变更却被判失败」。文件快照正是解决这类问题的基础：先看清「到底变没变」，再决定后面怎么走。

## 要点三：失败要分类，不是笼统报错

验证失败后，编排器用 `_classify_ci_failure` 把失败分类：

<SourceExplainer
  file="agent-platform/backend/core/agent_orchestrator.py"
  :notes="[
    { lines: '1', text: '入参是验证命令、退出码、以及命令输出。' },
    { lines: '2-4', text: '根据输出内容和退出码，判断这是编译错误、测试失败、依赖缺失还是其他类型。' },
    { lines: '5', text: '返回结构化的失败分类，让上层可以按类型决定下一步——比如依赖缺失就去装依赖，测试失败就回去改代码。' }
  ]">

```python
def _classify_ci_failure(command: str, exit_code: int | None, output: str) -> dict:
    # 根据命令、退出码、输出文本判断失败类型
    # 返回 { "kind": "...", "hint": "..." } 之类的结构化结果
    ...
```

</SourceExplainer>

**为什么要分类？** 因为「测试失败」和「依赖没装」需要完全不同的应对。笼统地把所有失败都丢回给 Agent 说「失败了，你看着办」，效率很低；分类后可以给出更精准的下一步提示，甚至自动处理某些类型（如自动装依赖）。

## 要点四：迭代次数有上限

自主循环最大的风险是**无限循环烧钱**。编排器用 `_agent_iteration_policy` 给每个任务设循环上限：

```python
def _agent_iteration_policy(task, description, has_memory_context) -> tuple[int, int]:
    # 根据任务复杂度、是否有记忆上下文，返回 (软上限, 硬上限)
    ...
```

- **软上限**：到了就开始倾向于收尾。
- **硬上限**：到了强制停止，避免失控。

这是自主 Agent 系统的必备护栏——[Agentic Loop](/autocode/agentic-loop) 的 `finish` 判定负责「正常完成」，而迭代上限负责「异常兜底」。

## 要点五：读取有 guard

`_check_retrieval_read_guard` 会检查 Agent 想读的文件是不是它「计划内」该读的。这是为了防止 Agent 漫无目的地乱读文件、浪费 token。它和 [SystemContext Epoch](/autocode/system-context) 的 `RETRIEVAL_PLAN.md` 配合——检索计划里规划了该读哪些，guard 负责执行这个计划。

## 编排器与其它模块的关系

<ArchitectureDiagram
  title="编排器的协作关系"
  :nodes='[
    { id: "orch", label: "Orchestrator", sub: "决策与调度", x: 340, y: 30, group: "python", w: 200 },
    { id: "loop", label: "Agentic Loop", sub: "observe→…→finish", x: 60, y: 150, group: "python", link: "/autocode/agentic-loop" },
    { id: "ctx", label: "SystemContext", sub: "epoch 增量", x: 260, y: 150, group: "python", link: "/autocode/system-context" },
    { id: "tools", label: "Tool Registry", sub: "工具目录", x: 460, y: 150, group: "python", link: "/autocode/tool-registry" },
    { id: "perm", label: "Permission Engine", sub: "安全闸门", x: 660, y: 150, group: "python", link: "/autocode/permission-engine" },
    { id: "review", label: "Review Agent", sub: "代码审查", x: 260, y: 270, group: "python", link: "/autocode/review-agent" },
    { id: "docker", label: "Docker", sub: "隔离执行", x: 460, y: 270, group: "infra", link: "/autocode/docker-isolation" }
  ]'
  :edges='[
    { from: "orch", to: "loop" },
    { from: "orch", to: "ctx" },
    { from: "orch", to: "tools" },
    { from: "orch", to: "perm" },
    { from: "orch", to: "review" },
    { from: "orch", to: "docker" }
  ]'
/>

编排器是中枢：它驱动循环、消费上下文增量、经权限引擎调用工具、在隔离容器里执行、最后交给审查器把关。

## 小结

- 编排器不写代码，它**决策与调度**：走什么模式、验什么、失败怎么办、循环几轮。
- **文件快照**让它能客观判断「Agent 真干活了没」，而不是听信口头汇报。
- **失败分类**让应对更精准，**迭代上限**是防失控的护栏。
- 它是把 Loop / Context / Tools / Permission / Docker / Review 串起来的中枢。

下一章看 [Local Runner](/autocode/local-runner)：当任务需要在**用户本地机器**上执行时，编排器是怎么把工具调用转发过去的。
