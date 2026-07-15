# Agentic Loop

这是 AutoCode 的心脏。理解了它，你就理解了「自主编程 Agent」和「普通对话」的本质区别。

## 先看它跑起来的样子

下面这个动画演示了一个完整的循环。点「下一步」逐步查看，或点「自动播放」：

<AgenticLoopAnimation />

## 为什么不要固定流程

早期 AutoCode 用的是「固定阶段流程」：先需求分析 → 再规划 → 再编码 → 再冒烟测试 → 再验收。听起来很合理，但实际跑起来问题很大：

> 任务被阶段牵着走，而不是由 Agent 根据真实上下文决策。

两个真实的翻车例子：

- 用户已经明确说「修复 `parse_args` 中的 `args.input_file`」，系统却还卡在第一阶段提示「请描述需求」。
- 冒烟测试阶段压根没有源码变更，却被机械地判定为「测试失败」。

根因是：**固定流程假设了任务的形状，但真实任务的形状千变万化**。修一个已经定位好的 bug、从零搭一个项目、改一行配置——它们需要的步骤完全不同。

## 解决方案：默认进入 Agentic Loop

现在的默认行为是让 Agent 自己决策。执行模式的入口判断在 `agent-platform/backend/core/agent_orchestrator.py`：

<SourceExplainer
  file="agent-platform/backend/core/agent_orchestrator.py"
  :notes="[
    { lines: '1-4', text: '默认值是 agentic。只有显式配置成 planned/phase/legacy 才回退到旧的固定阶段模式。换句话说——自主循环是默认，固定流程是例外。' },
    { lines: '6-11', text: '两道否决门：显式选了 planned 模式、或任务带了 force_planned_execution 标记，才不走 agentic。其余情况一律走自主循环。这是一种「默认智能、可手动降级」的设计。' }
  ]">

```python
def _execution_mode(task: dict | None) -> str:
    configured = str((task or {}).get("execution_mode")
        or os.getenv("AUTOCODE_EXECUTION_MODE", "agentic")).strip().lower()
    return "planned" if configured in {"planned", "phase", "legacy"} else "agentic"

def _should_use_agentic_execution(task: dict | None, description: str, project_type: str = "") -> bool:
    if _execution_mode(task) == "planned":
        return False
    if task and task.get("force_planned_execution"):
        return False
    return True
```

</SourceExplainer>

## 循环的六个阶段

Agentic Loop 的行为协议是一个闭环：

```text
observe → decide → act → verify → reconcile → finish
```

| 阶段 | 做什么 |
|------|--------|
| **observe** | 读取 SystemContext manifest、最近用户输入、检索计划、CI 与 Review 状态。默认只看摘要，不拼全文。 |
| **decide** | Agent 自己判断下一步：`search` / `read` / `edit` / `bash` / `answer` / `ask`。 |
| **act** | 调用工具执行决策。工具经 Tool Registry 注册、Permission Engine 校验后运行。 |
| **verify** | 写入后**必须**运行合适验证（编译 / 测试 / lint）。 |
| **reconcile** | 刷新 SystemContext Epoch，根据 diff 判断是否继续。 |
| **finish** | 验证通过、无待处理用户输入、无失败 guardrail，才判定完成。 |

## 三个设计要点

**1. decide 是开放选择，不是固定顺序。** Agent 可以连续 read 五次再 edit，也可以 edit 完直接 verify。顺序由真实上下文决定，不由流程图决定。

**2. verify 是硬约束。** 「写了代码就必须验证」是写进协议的。这避免了 Agent「自我感觉良好地宣布完成」——没有绿灯就不能进 finish。

**3. finish 有多重 guardrail。** 不是「Agent 说完了就完了」，而是要同时满足：验证通过、没有待回应的用户输入、没有触发失败的护栏。任一不满足就继续循环。

## 与普通对话的本质区别

| 维度 | 普通对话（Java） | AutoCode（Python） |
|------|------------------|--------------------|
| 调用次数 | 一次 | 循环多次直到完成 |
| 下一步谁决定 | 无「下一步」 | Agent 自己决定 |
| 验证 | 无 | 强制验证才能收尾 |
| 状态 | 无状态 | 有 SystemContext Epoch |

正是这套循环，让 AutoCode 从「聊天机器人」变成了「会自己干活的 Agent」。

## 下一步

循环里反复提到 SystemContext——它是 Agent 每轮 observe 的输入、reconcile 的输出。这套「上下文只增量、不重复读全文」的机制，见 [SystemContext Epoch](/autocode/system-context)。
