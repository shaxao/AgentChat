# Review Agent 代码审查器

Agent 写完代码不等于任务完成。就像人类开发者提交前要过 CI 和 code review 一样，AutoCode 有一个专门的 `ReviewAgent`，在任务收尾前对产物做**多道关卡**的质量把关。这一章讲它怎么审。

## 为什么需要独立的审查器

回想 [Agentic Loop](/autocode/agentic-loop) 的 `verify` 阶段——那是 Agent **自己**跑验证。但「自己验证自己」有盲区：Agent 可能只跑了它想跑的测试，或者根本没意识到某处有问题。

`ReviewAgent` 是一个**独立的、结构化的**把关者：它不参与写代码，只负责挑毛病。这种「执行者 / 审查者分离」的设计，和人类团队里「开发 / reviewer 分离」是一个道理——旁观者更容易发现问题。

## 五道关卡

`ReviewAgent.run()` 依次跑五道检查，每道都往 `ReviewResult` 里累加 issue：

<SourceExplainer
  file="agent-platform/backend/core/review_agent.py"
  :notes="[
    { lines: '1', text: 'artifact_gate：产物门。先确认「到底有没有产出该有的东西」——比如说好要建前端项目，结果连 index.html 都没有，直接拦下。' },
    { lines: '2', text: 'static_scan：静态扫描。查明显的坏味道——比如残留的调试语句、明显的语法问题、危险模式。' },
    { lines: '3', text: 'file_quality_check：文件质量。查空文件、超大文件、疑似占位符内容（Agent 有时会写「// TODO 实现这里」就交差）。' },
    { lines: '4', text: 'toolchain_check：工具链检查。按项目类型跑真实的编译/lint/测试命令，拿到真实的退出码和输出。' },
    { lines: '5', text: 'ai_review：AI 审查。把关键改动喂给 LLM，让它从「人类 reviewer」视角给出更高层的意见。' }
  ]">

```python
async def run(self, ...):
    await self._artifact_gate(ws_path, project_type, result, log)
    await self._static_scan(ws_path, result, log)
    await self._file_quality_check(ws_path, result, log)
    await self._toolchain_check(ws_path, project_type, result, log)
    await self._ai_review(ws_path, ..., result, log)
    self._generate_summary(result)
    await self._write_review_file(ws_path, task_id, task_title, result)
```

</SourceExplainer>

设计上的讲究：**从便宜到贵、从确定到模糊**。先跑 artifact_gate、static_scan 这类快而确定的检查——如果连产物都没有，后面的 AI 审查根本不用花钱跑。AI 审查（`_ai_review`）放最后，因为它最贵、最慢。这和 [Permission Engine](/autocode/permission-engine) 的分层顺序是同一种「短路优化」思想。

## ReviewResult：结构化的审查结论

审查结果不是一段自由文本，而是结构化的 issue 列表：

<SourceExplainer
  file="agent-platform/backend/core/review_agent.py"
  :notes="[
    { lines: '1-2', text: 'add_issue 累加一条问题，带 level（严重级别）、rule（哪条规则）、file（哪个文件）、message（描述）。' },
    { lines: '4', text: 'to_dict 把整份审查结论序列化，供前端展示、供编排器判断是否通过。' }
  ]">

```python
def add_issue(self, level: str, rule: str, file: str, message: str):
    # 累加一条结构化 issue
    ...

def to_dict(self) -> dict:
    # 序列化：issue 列表 + 汇总 + 是否通过
    ...
```

</SourceExplainer>

结构化的好处：编排器能**程序化地判断**审查是否通过（回看 orchestrator 的 `_review_is_passed` / `_group_review_passed`），前端能按严重级别高亮，而不是让人肉眼读一段话去猜「到底过没过」。

## 审查结论落地：REVIEW.md

`_write_review_file` 会把审查结论写成工作区里的 `.autocode/REVIEW.md`。还记得 [SystemContext Epoch](/autocode/system-context) 里的上下文源清单吗？`REVIEW.md` 正是其中一员。

这就形成了一个漂亮的闭环：

```
Agent 写代码
  → ReviewAgent 审查 → 写 .autocode/REVIEW.md
  → SystemContext 检测到 REVIEW.md 的 hash 变了 → 进入 changed sources
  → 下一轮 observe 时 Agent 看到「审查发现了这些问题」
  → decide：去修
```

审查结论不是死路一条的报告，而是**回流成 Agent 下一轮的输入**。这正是整个 harness 能自我改进的微观体现。

## 产物门：一个务实的细节

`_artifact_gate` 和 `_expects_code(project_type)` 处理了一个很现实的问题：**不是所有任务都该产出代码**。

如果是纯文档任务、纯调研任务，那「没有 .py/.js 文件」是正常的，不该被判失败。`_expects_code` 按项目类型判断「这个任务到底该不该有源码产物」，避免了 [Agentic Loop 那章](/autocode/agentic-loop) 提到的翻车例子——「冒烟测试阶段没有源码变更就被机械判失败」。

## 小结

- `ReviewAgent` 是独立的质量把关者，与写代码的 Agent 分离，避免「自己验自己」的盲区。
- 五道关卡**从便宜到贵、从确定到模糊**排列，前面的确定性检查能短路掉后面昂贵的 AI 审查。
- 审查结论是**结构化 issue 列表**，供编排器程序化判断、供前端展示。
- 结论写入 `.autocode/REVIEW.md`，经 SystemContext 回流成 Agent 下一轮的输入，形成自我改进闭环。
- 产物门按项目类型判断「该不该有代码产物」，避免误判文档/调研类任务。

至此 AutoCode 十章讲完了。接下来的 [全链路专题](/deep-dive/autocode-task) 会把这些拼成一次完整的任务追踪。
