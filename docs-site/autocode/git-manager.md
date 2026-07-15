# Git Manager

Agent 每写一轮代码，都是一次「可能对、也可能错」的尝试。要让这种尝试变得**安全可回退**，就得给每一步都留下版本记录。这是 `GitManager` 的职责——它用 GitPython 把 Git 能力封装成任务可用的几个动作。

## 为什么 Agent 必须用 Git

想象没有 Git 的情况：Agent 改了 20 个文件，跑测试挂了，你想回到「改之前」——没得回。Agent 的自主循环里，`verify` 失败后要能 `reconcile`（见 [Agentic Loop](/autocode/agentic-loop)），前提是每一步都有版本锚点。

所以 AutoCode 的约定是：**Agent 的每一轮有意义的改动，都对应一次 commit**。于是任务历史天然变成一条可视化、可回滚的时间线。

## 身份配置：每次操作都先坐实「作者是谁」

`GitManager` 有个细节值得注意——它在 init / commit 前都会调用 `_configure_identity`，把 Git 的 `user.name` / `user.email` 写进仓库配置：

<SourceExplainer
  file="agent-platform/backend/core/git_manager.py"
  :notes="[
    { lines: '1-9', text: '从全局设置读出 Agent 的作者名和邮箱，写进这个仓库的本地配置。用 with config_writer 保证句柄正确关闭。失败只 debug 不抛错——身份配置不该阻断主流程。' },
    { lines: '11-19', text: 'init 是幂等的：已有 .git 就复用并重配身份，没有才 Repo.init。这意味着对同一工作区重复调用 init 是安全的，符合 Agent 循环可能反复进入的场景。' }
  ]">

```python
def _configure_identity(self, repo: Repo) -> None:
    settings = get_settings()
    try:
        with repo.config_writer() as writer:
            writer.set_value("user", "name", settings.git_author_name)
            writer.set_value("user", "email", settings.git_author_email)
    except Exception as e:
        logger.debug(f"[Git] configure identity failed: {e}")

def init(self, path: Path) -> Repo:
    if (path / ".git").exists():
        repo = Repo(path)
        self._configure_identity(repo)
        return repo
    repo = Repo.init(path)
    self._configure_identity(repo)
    logger.info(f"[Git] 仓库初始化: {path}")
    return repo
```

</SourceExplainer>

::: tip 为什么每次都重配身份
Agent 的工作区可能被复制、迁移、或从模板容器初始化，Git 配置未必带过来。每次操作前坐实身份，比「假设配置已经对」要健壮。这是防御式编程在小处的体现。
:::

## commit：显式指定 author 和 committer

<SourceExplainer
  file="agent-platform/backend/core/git_manager.py"
  :notes="[
    { lines: '1-12', text: '用 Actor 显式构造作者身份，author 和 committer 都设成它——避免依赖环境里的全局 git 配置。author_name 可覆盖，方便区分是哪个 Agent（前端/后端/DevOps）提交的。' },
    { lines: '13-15', text: '返回 12 位短哈希。这个短哈希会成为任务时间线上每个节点的标识，前端可视化 Git 历史时直接用它。' }
  ]">

```python
def commit(self, path: Path, message: str, author_name: Optional[str] = None) -> str:
    settings = get_settings()
    repo = Repo(path)
    self._configure_identity(repo)
    actor = Actor(
        author_name or settings.git_author_name,
        settings.git_author_email,
    )
    repo.index.commit(message, author=actor, committer=actor)
    commit_hash = repo.head.commit.hexsha[:12]
    logger.info(f"[Git] 提交 {commit_hash}: {message}")
    return commit_hash
```

</SourceExplainer>

## log：过滤掉 .git 噪音

`log` 方法有一处很实际的坑处理。初始提交（第一次 commit）往往会把 `.git/objects/*` 里成千上万个文件也算进「变更文件」，直接展示会淹没真正的业务文件：

> `files_changed` 对于初始提交可能包含数千个 `.git/objects/*` 文件——过滤掉 `.git/` 目录下的文件，只保留工作空间内的文件，上限 100。

这类「看起来能跑，但真实数据一进来就爆」的问题，只有实际用过才会遇到并修掉。它也是判断一份代码是否「真的上过生产」的信号。

## 和自主循环的关系

把 Git Manager 放回 [Agentic Loop](/autocode/agentic-loop) 里看：

| 循环阶段 | Git 动作 |
|---------|---------|
| act（写文件） | 改动累积在工作区 |
| verify（跑测试） | 决定这轮改动是否可信 |
| reconcile（校准） | 验证通过 → commit 锚定；失败 → 可回退到上一个 commit |

于是「Agent 自主编程」不再是一条没有退路的单行道，而是一棵可以随时回到任意节点的树。这就是版本控制赋予 Agent 的「后悔权」。

## 相关源码

- `agent-platform/backend/core/git_manager.py` — GitPython 封装：init / commit / log
- `agent-platform/backend/api/git.py` — 对前端暴露的 Git 可视化接口

下一篇 [编排器](/autocode/orchestrator) 会把前面所有部件（循环、上下文、工具、权限、容器、Git）串成一个完整的任务执行器。
