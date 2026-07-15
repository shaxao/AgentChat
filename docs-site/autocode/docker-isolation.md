# Docker 隔离执行

AutoCode 的 Agent 会真的去跑 `bash`、写文件、装依赖、执行构建。这些动作必须被关在一个笼子里——不能让 Agent 的一条 `rm -rf` 或一个失控的脚本，波及到宿主机和别的任务。这一章讲这个笼子怎么搭。

## 两道笼子，不止一道

很多人以为「隔离」只有 Docker 一层。AutoCode 实际上有**两道防线**，缺一不可：

1. **命令层**：在命令真正执行前，先做静态检查——路径不能逃逸 `/workspace`、不能碰根目录、不能有 `..` 穿越。这道防线在 [Permission Engine](/autocode/permission-engine) 和 `docker_manager` 的命令预处理里。
2. **进程层**：命令在**独立容器**里执行，容器有资源配额、网络限制。就算命令层被绕过，容器也兜底。

这一章聚焦第二道（容器），但先看看第一道在 `docker_manager` 里的样子——因为它和容器是同一套代码在管。

## 命令预处理：路径不能逃逸

`docker_manager.py` 里有一组纯函数，在命令下发前做静态校验。它们的设计哲学是「白名单 + 显式拒绝」：

<SourceExplainer
  file="agent-platform/backend/core/docker_manager.py"
  :notes="[
    { lines: '1-2', text: '正则直接拦截对根目录的常见探测命令：ls / find / du / tree / grep / cat / sed / awk 后面紧跟一个裸的斜杠。这类命令一旦对根目录执行，轻则刷屏重则泄露宿主信息。' },
    { lines: '4-7', text: '用 shlex 按 shell 语法切词，切不动就退化成空格切分。逐个 token 检查，任何一个像父目录穿越就整条命令拒绝。' },
    { lines: '9-14', text: '绝对路径只有两个白名单前缀被放行：/workspace 和 /tmp（且各自受开关控制）。除此之外的任何绝对路径一律拒绝——这是把 Agent 死死摁在工作区里的关键一条。' }
  ]">

```python
if re.search(r"(^|[;&|]\s*)(ls|find|du|tree|grep|cat|sed|awk)\s+/(?:\s|$)", lowered):
    return False, "root directory access is not allowed"

try:
    tokens = shlex.split(command, posix=True)
except ValueError:
    tokens = compact.split()

for token in tokens:
    if _looks_like_parent_traversal(token):
        return False, "parent-directory traversal is not allowed"
    allowed_absolute = (
        (allow_workspace_absolute and (token == "/workspace" or token.startswith("/workspace/")))
        or (allow_tmp_absolute and (token == "/tmp" or token.startswith("/tmp/")))
    )
    if token.startswith("/") and not allowed_absolute:
        return False, f"absolute path outside /workspace is not allowed: {token}"
```

</SourceExplainer>

## 优雅降级：没有 Docker 也能跑

这是一个非常务实的设计。开发者本机不一定装了 Docker，AutoCode 不会因此罢工——它会把容器路径翻译成本地路径，退化到本地子进程执行：

<SourceExplainer
  file="agent-platform/backend/core/docker_manager.py"
  :notes="[
    { lines: '1-6', text: '把命令里的 /workspace 前缀翻译成当前工作目录相对路径 ./，让原本为容器写的命令在本地也能跑。前后用零宽断言避免误伤像 /workspaces-foo 这种词。' },
    { lines: '8-15', text: 'Windows 下子进程输出默认是 GBK 编码，直接按 UTF-8 解码会乱码。这里显式探测本地首选编码，解码失败再退回 UTF-8 replace，保证跨平台不乱码。这类细节是「真的在 Windows 上跑过」才会写的。' }
  ]">

```python
def _translate_workspace_paths_for_local(command: str) -> str:
    """Map container paths to the local workspace cwd when Docker is unavailable."""
    translated = command
    translated = re.sub(r"(?<![\w./-])/workspace/+", "./", translated)
    translated = re.sub(r"(?<![\w./-])/workspace(?![\w./-])", ".", translated)
    return translated

def _local_encoding() -> str:
    if sys.platform == "win32":
        try:
            return locale.getpreferredencoding() or "gbk"
        except Exception:
            return "gbk"
    return "utf-8"
```

</SourceExplainer>

::: tip 为什么降级很重要
一个「必须装 Docker 才能开发」的系统，会把大量贡献者挡在门外。AutoCode 选择让容器成为**生产环境的加固**，而不是**开发环境的前置门槛**。命令层的静态校验在两种模式下都生效——所以降级不等于放弃安全。
:::

## 容器的生命周期

`DockerManager` 管理一个 workspace 容器池，核心约定写在类文档里：

> 每次任务启动一个独立容器；容器内运行 Agent 的 bash / git / npm 等命令；容器退出后自动清理（或保留供调试）。

一个任务一个容器，意味着**任务之间天然隔离**——A 任务把容器搞崩了，B 任务毫发无伤。这和 [Java 主系统](/java/architecture) 里「一个请求一个线程」是同一种思路的放大版：把爆炸半径限制在单个工作单元内。

## 三层防护小结

| 层 | 手段 | 拦得住什么 |
|----|------|-----------|
| 命令静态校验 | 白名单路径 + 拒绝穿越/根目录 | 大部分误操作和路径逃逸 |
| 容器隔离 | 一任务一容器 + 资源配额 | 命令层漏网的破坏、任务间串扰 |
| 权限引擎 | 危险命令 ask/deny | 高风险操作前的人工确认 |

三层叠加，才敢让 Agent「真的动手」。单靠任何一层都不够——这也是自主编程 Agent 和「只给建议的 AI」在工程上最本质的区别。

## 相关源码

- `agent-platform/backend/core/docker_manager.py` — 容器管理 + 命令预处理 + 本地降级
- `agent-platform/backend/runtime/permission_engine.py` — 危险命令判定（见 [Permission Engine](/autocode/permission-engine)）

下一篇看 [Git Manager](/autocode/git-manager)，理解 Agent 每写一轮代码是怎么被版本化、可回滚的。
