# Local Runner 本地执行器

到目前为止，AutoCode 的工具都在**服务端的 Docker 容器**里执行。但有一类需求是容器满足不了的：**在用户自己的机器上跑代码**。Local Runner 就是为此而生。

## 为什么需要在本地执行

设想这些场景：

- 用户想让 AutoCode 改**他本地磁盘上的现有项目**，而不是服务端一个空工作区。
- 项目依赖用户本地环境（特定的 SDK、本地数据库、本地端口）。
- 用户出于隐私，不希望代码上传到服务端容器。

这时就需要一个**运行在用户机器上的执行器**——它接收服务端编排器下发的工具调用（读文件、写文件、跑命令），在本地执行，再把结果传回。这个本地执行器，就是 [Rust 连接器](/connector/why) 桌面应用；而服务端这一侧负责管理会话、转发工具调用的，是 `LocalRunnerManager`。

## 会话生命周期

`LocalRunnerManager` 管理「服务端 ↔ 本地连接器」之间的 WebSocket 会话。核心方法：

| 方法 | 作用 |
|------|------|
| `enable(task_id)` | 为某个任务开启本地执行，铸造一个新会话（带 token） |
| `attach(session_id, token, ws)` | 本地连接器带 token 连上来，绑定 WebSocket |
| `bind_session_to_task` | 把会话和任务关联 |
| `execute_tool(...)` | 把一次工具调用通过 WebSocket 下发到本地执行 |
| `receive_message` | 接收本地连接器回传的执行结果 |
| `detach` / `disable` | 断开 / 关闭会话 |

<SourceExplainer
  file="agent-platform/backend/services/local_runner_manager.py"
  :notes="[
    { lines: '1', text: 'enable 为任务开启本地执行模式，返回一个 LocalRunnerSession。' },
    { lines: '2-3', text: '每次 enable 都铸造一个带新 token 的会话——这是理解连接器为什么要用「代次机制」的关键前提。' },
    { lines: '5-6', text: 'attach 是本地连接器带着 token 连上来时调用的，把 WebSocket 绑定到会话上。token 不对就拒绝，保证只有授权的连接器能接管。' }
  ]">

```python
async def enable(self, task_id: str) -> LocalRunnerSession:
    # 铸造新 token 的会话，登记到内存
    ...

async def attach(self, session_id: str, token: str, ws: WebSocket) -> LocalRunnerSession:
    # 校验 token，绑定 WebSocket，标记会话已连接
    ...
```

</SourceExplainer>

## 关键坑：会话是内存态的

注意 `enable` 铸造的会话**存在内存里**。这带来一个重要后果：**后端一重启，所有旧会话就全没了。**

这正是 [连接器会话代次机制](/connector/session-generation) 那一章要解决的核心问题——

> 每次从浏览器打开项目都会铸造全新 token 的会话（尤其后端重启后旧内存 session 全丢），旧连接器连着已死会话，永远连不上新会话。

所以本地连接器（Rust 端）必须用「代次机制」来保证**永远连的是最新会话**，而不是抱着一个已经死掉的旧会话不放。服务端这边 `LocalRunnerManager` 的「会话是内存态、每次 enable 都是新 token」的设计，就是那个问题的根源上下文。两章在这里闭环。

## 陈旧会话检测

`LocalRunnerSession` 有 `is_stale(stale_after_seconds)` 判断会话是否已经太久没心跳：

<SourceExplainer
  file="agent-platform/backend/services/local_runner_manager.py"
  :notes="[
    { lines: '1-2', text: '如果距离上次活动超过阈值，会话视为陈旧。' },
    { lines: '4-6', text: 'public_status 对外暴露会话状态时也带上陈旧判断（默认 45 秒），让前端能显示「连接器在线 / 离线」。' }
  ]">

```python
def is_stale(self, stale_after_seconds: int) -> bool:
    return (now - self.last_active) > stale_after_seconds

def public_status(self, *, stale_after_seconds: int = 45) -> dict:
    # 返回给前端的状态，含 online/stale 标记
    ...
```

</SourceExplainer>

这让整个链路可观测：用户能在界面上看到「本地连接器现在是否在线」，而不是发了指令石沉大海。

## 工具调用的转发

当任务处于本地执行模式，编排器要调用工具时，不再走服务端 Docker，而是通过 `execute_tool` 把调用**序列化后经 WebSocket 下发**给本地连接器，连接器在用户机器上执行，再把结果经 `receive_message` 传回。

对编排器来说，这几乎是透明的——它只管「调用工具、拿结果」，至于工具是在服务端容器跑还是在用户本地跑，由 Local Runner 这一层屏蔽掉。这是一个漂亮的**执行位置抽象**。

## 小结

- Local Runner 让 AutoCode 能在**用户本地机器**上执行工具，覆盖「改本地现有项目 / 依赖本地环境 / 隐私」等场景。
- 服务端 `LocalRunnerManager` 管理 WebSocket 会话；会话是**内存态**的，后端重启即失效。
- 「每次 enable 铸造新 token 会话」+「内存态」正是 [连接器代次机制](/connector/session-generation) 要解决问题的根源。
- 工具调用经 WebSocket 下发到本地执行，对编排器透明——这是执行位置的抽象。

下一章看 [Review Agent](/autocode/review-agent)：Agent 写完代码后，谁来把关质量。
