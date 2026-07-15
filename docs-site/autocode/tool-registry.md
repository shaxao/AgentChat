# Tool Registry

AutoCode 的 Agent 在 `act` 阶段要调用工具（读文件、写文件、bash、搜索……）。这些工具不是散落在代码里的函数，而是被统一登记在一张**工具注册表**里，每个工具带一份结构化的规格（`ToolSpec`）。这一章讲这张表怎么设计。

## 为什么要有注册表

如果工具是散落的函数，会遇到几个问题：

- Agent 不知道有哪些工具可用、每个工具怎么调用（缺少统一的能力清单）。
- 权限、成本、超时、缓存这些横切属性无处安放。
- 前端要展示"Agent 正在执行 xxx"，需要每个工具的可读标签和描述。

注册表把这些都收进一份声明式的 `ToolSpec`。

## ToolSpec：工具的身份证

<SourceExplainer
  file="agent-platform/backend/runtime/tool_registry.py"
  :notes="[
    { lines: '1-8', text: 'frozen dataclass，工具规格一旦注册就不可变。三个 Literal 类型约束了权限默认值、副作用类型、输出模式的取值范围——用类型系统防止写错。' },
    { lines: '10-16', text: '核心字段：name 是唯一标识，side_effect 标注读/写/外部/支付，permission_default 是权限引擎的默认策略，risk_level 是风险分级。' },
    { lines: '17-23', text: '横切属性全部声明式：超时、允许的角色、成本标签、是否可缓存、是否改动工作区、是否需要确认、输出模式与长度上限。' },
    { lines: '24-26', text: 'agent_enabled / local_runner_enabled 两个开关，决定这个工具能不能被 Agent 用、能不能在本地连接器里跑。' }
  ]">

```python
@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    label: str = ""
    action: str = ""
    purpose: str = ""
    side_effect: SideEffect = "none"
    permission_default: PermissionDefault = "ask"
    risk_level: int = 1
    timeout_seconds: int = 60
    allowed_roles: tuple[str, ...] = ("all",)
    cost_tag: str = "autocode"
    cacheable: bool = False
    mutates_workspace: bool = False
    requires_confirmation: bool = False
    output_mode: OutputMode = "bounded"
    max_model_chars: int = 2000
    max_preview_chars: int = 12000
    parameters: dict | None = None
    agent_enabled: bool = False
    local_runner_enabled: bool = False
    metadata: dict = field(default_factory=dict)
```

</SourceExplainer>

::: tip 声明式设计的价值
注意这里没有一行"逻辑"，全是"数据"。权限引擎、缓存层、成本核算、前端展示，都是**读取这些字段**来决策的。加一个新工具时，你只需要填一份 `ToolSpec`，整个系统就自动知道该怎么对待它。这是典型的"配置优于代码"。
:::

## 注册表提供的查询能力

`ToolRegistry` 把 spec 存进一个字典，并提供一组语义化查询——注意这些查询都是**围绕 spec 字段派生**的：

| 方法 | 作用 | 基于哪个字段 |
|------|------|-------------|
| `get(name)` / `require(name)` | 取单个 spec | — |
| `is_cacheable(name)` | 结果能否缓存 | `cacheable` |
| `mutates_workspace(name)` | 是否改动工作区 | `mutates_workspace` |
| `agent_specs()` | Agent 可用的工具 | `agent_enabled` |
| `local_runner_specs()` | 本地连接器可跑的工具 | `local_runner_enabled` |
| `can_run_locally(name)` | 能否本地执行 | `local_runner_enabled` |
| `agent_tool_definitions()` | 生成给 LLM 的工具定义 | `parameters` 等 |
| `agent_usage_prompt()` | 生成工具使用说明 | `action` / `purpose` |

`is_cacheable` 和 `mutates_workspace` 直接服务于 [编排器](/autocode/orchestrator) 的工具结果缓存：只读工具的结果可以按 `(工具名, 参数, 工作区版本)` 缓存复用，改动工作区的工具则会让缓存失效。

## 工具的两个"面向"

同一个工具有两个不同受众的描述：

- **面向 LLM**：`agent_description()` 返回 `action: purpose`，还有 `agent_tool_definitions()` 生成符合 Claude 工具调用格式的 JSON schema。
- **面向人类**：`label`（如"读取文件"）、`describe_invocation()`（如"读取 src/main.py"）——前端拿这些展示"Agent 正在做什么"。

一份 spec，两种视角，避免了描述散落和不一致。

## 默认工具在模块加载时注册

<SourceExplainer
  file="agent-platform/backend/runtime/tool_registry.py"
  :notes="[
    { lines: '1-4', text: '_register_defaults 遍历预定义的工具规格，逐个注册进全局单例 tool_registry。' },
    { lines: '6', text: '模块被 import 时立即执行注册。任何 import 这个模块的地方，拿到的都是已经填好的注册表——这是 Python 模块级单例的常见用法。' }
  ]">

```python
def _register_defaults() -> None:
    for spec in DEFAULT_SPECS:
        tool_registry.register(spec)


_register_defaults()
```

</SourceExplainer>

## 相关源码

- `agent-platform/backend/runtime/tool_registry.py` — ToolSpec、ToolRegistry、默认工具注册

Agent 决定调用一个工具后，它不会直接执行——先要过 [Permission Engine](/autocode/permission-engine) 这一关。下一章讲权限引擎怎么读 `ToolSpec` 里的 `permission_default` / `risk_level` / `allowed_roles` 做出放行、询问还是拒绝的决策。
