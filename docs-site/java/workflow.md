# 工作流引擎 V2

工作流是这个平台的第二种「AI 执行」形态——介于「一次对话」和「AutoCode 自主循环」之间。它把多个步骤（节点）编排成一张图，按拓扑顺序执行，其中某些节点可以是 AI 调用。

如果你还没读过 [三系统整体架构](/guide/architecture) 里「三种 AI 执行形态」那张表，建议先回去看一眼——理解这个梯度，是理解本章的前提。

## 定位：编排好的多次调用

| 形态 | 本质 |
|------|------|
| 对话 | 一次 AI 调用 |
| **工作流** | **预先编排好的多次调用（节点图）** |
| AutoCode | 自主决策的循环 |

工作流的关键词是「**预先编排**」：节点之间的连接、每个节点做什么，是在执行前就定义好的。它不像 AutoCode 那样临场决定下一步，而是沿着既定的图往前推进。这让它**可预测、可复用**——适合固化成模板反复使用（见侧边栏 [工作流模板](/frontend/pages) 相关页面）。

## 异步执行 + 轮询/订阅

工作流可能跑很久（多个 AI 节点串起来），所以执行是**异步**的：提交后立即返回一个 `execution` 对象，前端靠它轮询或订阅进度。

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/WorkflowService.java:88"
  :notes="[
    { lines: '1-2', text: '先创建一条 execution 记录（含 id、状态、输入），这条记录立即返回给前端，作为后续查询进度的凭据。' },
    { lines: '3-11', text: '真正的执行丢进线程池 taskExecutor 异步跑，不阻塞 HTTP 请求。执行失败时捕获异常并标记 execution 为 failed，保证前端能看到明确的失败状态而不是一直转圈。' },
    { lines: '12', text: '方法立即返回 execution。此时工作流可能才刚开始跑——前端拿到 id 后去订阅 SSE 进度。' }
  ]">

```java
public WorkflowExecution executeWorkflowAsync(Long workflowId, Map<String, Object> inputs, Long userId) {
    WorkflowExecution execution = createExecution(workflowId, inputs, userId);
    // 异步执行，立即返回 execution 供前端轮询/SSE 订阅
    taskExecutor.submit(() -> {
        try {
            runWorkflow(execution.getId());
        } catch (Exception e) {
            log.error("[Workflow] 执行失败 execId={}", execution.getId(), e);
            markExecutionFailed(execution.getId(), e.getMessage());
        }
    });
    return execution;
}
```

</SourceExplainer>

## 进度推送：EventBus + SseEmitter

工作流执行过程中，每个节点的开始、完成、输出都要实时推给前端。这里复用了和 [SSE 流式对话](/java/sse-chat) 同一套 `SseEmitter` 机制，但包了一层 **EventBus**，因为工作流是「一个执行，多方订阅」：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/service/WorkflowExecutionEventBus.java:33"
  :notes="[
    { lines: '1', text: 'subscribe(executionId)：前端拿到 executionId 后订阅，返回一个 SseEmitter。EventBus 内部按 executionId 维护订阅者列表。' },
    { lines: '3', text: 'publish(executionId, eventType, data)：工作流执行到某个节点时，往对应 executionId 的所有订阅者推送事件。节点开始、节点完成、最终结果都是不同的 eventType。' }
  ]">

```java
public SseEmitter subscribe(Long executionId) {
    // 按 executionId 注册订阅者，返回 SseEmitter
}

public void publish(Long executionId, String eventType, Object data) {
    // 向该 executionId 的所有订阅者推送事件
}
```

</SourceExplainer>

::: tip 为什么工作流用 EventBus，对话不用
普通对话是「一个请求对应一个流」，`SseEmitter` 直接绑在请求上就够了。工作流是「一次执行，可能多个客户端/多个标签页都想看进度」，而且执行是异步线程在跑、和订阅请求不在同一个线程，所以需要一个 EventBus 做「执行线程 → 订阅者」的解耦转发。这是同一个 SSE 底座在不同场景下的两种用法。
:::

## 断点续执行

工作流引擎 V2 的一个重要能力是**断点续跑**：如果执行到一半失败（比如某个 AI 节点超时），修复后可以从失败节点继续，而不必从头再跑一遍。这依赖 execution 记录里保存的节点级状态——每个节点的执行结果单独落库，续跑时跳过已成功的节点。

设计文档见仓库 `docs/architecture/workflow-engine-v2/`。

## 普通工具模式 vs AI 驱动模式

工作流节点有两种：

| 模式 | 节点做什么 |
|------|-----------|
| **普通工具模式** | 确定性操作：HTTP 请求、数据转换、条件分支等，输入输出可预测 |
| **AI 驱动模式** | 节点内部是一次 AI 调用，用 prompt 处理上一节点的输出 |

一张工作流图里两种节点可以混用——比如「AI 节点生成文案 → 普通节点调用发布 API → AI 节点总结结果」。这种混合让工作流既有 AI 的灵活，又有传统流程的可控。

## 与前端的对应

工作流的可视化编辑器在前端用 `@xyflow/react`（React Flow）实现——拖拽节点、连线、配置参数。前端相关内容见 [页面导览](/frontend/pages) 里的 WorkflowPage / WorkflowTemplatePage。

## 相关源码

- `backend/src/main/java/com/aiplatform/backend/service/WorkflowService.java` — 执行主逻辑
- `backend/src/main/java/com/aiplatform/backend/service/WorkflowExecutionEventBus.java` — 进度事件总线
- `backend/src/main/java/com/aiplatform/backend/service/WorkflowParser.java` — 节点图解析
- `backend/src/main/java/com/aiplatform/backend/service/WorkflowScheduler.java` — 调度
- `docs/architecture/workflow-engine-v2/` — V2 设计文档

理解了工作流这种「编排好的多次调用」，下一步就可以去看 [AutoCode 的 Agentic Loop](/autocode/agentic-loop)——它是三种形态里最复杂的「自主决策循环」，和工作流形成鲜明对比。
