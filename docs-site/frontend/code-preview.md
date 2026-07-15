# 代码执行预览

这一章讲前端一个很"炫"但也很有工程含量的功能：**AI 生成的代码，直接在浏览器里跑起来看结果**。它分两条路——Python 走 Pyodide（WebAssembly），前端片段走 iframe 沙箱。本学习站你正在用的两个 Playground 组件，用的就是同一套思路。

## 两种执行，两种隔离

| 类型 | 组件 | 执行方式 | 隔离手段 |
|------|------|----------|----------|
| Python | `CodeRunner.tsx` | Pyodide（CPython 编译成 WASM） | 浏览器 WASM 沙箱天然隔离 |
| HTML/JS | `HtmlPreview` / `MessageBubble` | iframe `srcDoc` | `sandbox` 属性限制权限 |

两者都在**浏览器内**执行，不碰后端、不碰服务器文件系统。这是安全的前提。

## Python：Pyodide 单例

`app/src/components/autocode/CodeRunner.tsx` 的核心是把 Pyodide 运行时做成**全局单例**——它有约 10MB，绝不能每次运行都重新下载。

<SourceExplainer
  file="app/src/components/autocode/CodeRunner.tsx"
  :notes="[
    { lines: '1-4', text: '模块级的全局变量 pyodideInstance 和 pyodideLoading。注意它们在组件外面——这样多个组件实例共享同一个运行时。' },
    { lines: '6-12', text: 'ensurePyodide：已加载好就直接返回实例；正在加载就返回同一个 Promise，避免并发重复加载。这是单例 + 防抖的经典写法。' },
    { lines: '14-19', text: '首次才动态插入 script 标签加载 pyodide.js，再 loadPyodide 拿到实例。CDN 地址指向 jsdelivr。' }
  ]">

```typescript
// Pyodide 全局单例（避免重复加载 ~10MB 运行时）
let pyodideInstance: any = null
let pyodideLoading: Promise<any> | null = null

const PYODIDE_VERSION = 'v0.26.4'
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`

async function ensurePyodide() {
  if (pyodideInstance) return pyodideInstance
  if (pyodideLoading) return pyodideLoading

  pyodideLoading = (async () => {
    if (!window.loadPyodide) {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script')
        script.src = `${PYODIDE_CDN}pyodide.js`
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('Pyodide 加载失败'))
        document.head.appendChild(script)
      })
    }
    pyodideInstance = await window.loadPyodide({ indexURL: PYODIDE_CDN })
    return pyodideInstance
  })()

  return pyodideLoading
}
```

</SourceExplainer>

## 捕获 stdout/stderr

Pyodide 跑用户代码时，`print` 的输出默认进不了 JS。技巧是先把 Python 的 `sys.stdout` 重定向到 `io.StringIO()`，跑完再取出来：

<SourceExplainer
  file="app/src/components/autocode/CodeRunner.tsx"
  :notes="[
    { lines: '1-5', text: '运行用户代码前，先把 stdout/stderr 换成内存缓冲区 StringIO。' },
    { lines: '7', text: '执行用户真正的代码。此时所有 print 都写进了缓冲区。' },
    { lines: '9-11', text: '再用 runPython 取出缓冲区的字符串值，拼成最终输出展示给用户。stderr 单独标注。' }
  ]">

```typescript
pyodide.runPython(`
import sys
import io
sys.stdout = io.StringIO()
sys.stderr = io.StringIO()
`)

pyodide.runPython(code)

const stdout = pyodide.runPython('sys.stdout.getvalue()')
const stderr = pyodide.runPython('sys.stderr.getvalue()')
setOutput((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''))
```

</SourceExplainer>

你可以在下面这个 Playground 里亲手试一次——它用的正是同样的 Pyodide 机制：

<PyodidePlayground />

## HTML/JS：iframe 沙箱

前端片段（HTML/CSS/JS）走另一条路：塞进 iframe 的 `srcDoc`，靠 `sandbox` 属性限权。项目里两处用法：

```html
<!-- MessageBubble 里的 HTML 预览 -->
<iframe
  srcDoc={htmlPreviewDocument}
  sandbox="allow-scripts allow-forms allow-popups allow-modals"
  title="Preview"
/>
```

::: warning 注意 sandbox 里没有 allow-same-origin
`sandbox="allow-scripts ..."` 允许 iframe 里的脚本运行，但**故意不给 `allow-same-origin`**。这样 iframe 内的代码被当作"独立源"，无法读取父页面的 Cookie、localStorage、DOM——即使 AI 生成了恶意脚本，也偷不到你的登录态。这是"允许执行"和"防止越权"之间的平衡点。
:::

下面这个 Playground 用的就是 iframe 沙箱，可以改 HTML 看实时渲染：

<SandboxPlayground />

## 三处呼应：CSP 是硬前提

浏览器要跑 WASM 和 iframe 脚本，`Content-Security-Policy` 必须放行。项目 `app/nginx.conf` 里就显式配了：

```
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net;
worker-src 'self' blob:;
```

- `wasm-unsafe-eval`：Pyodide 编译 WASM 的硬性要求
- `https://cdn.jsdelivr.net`：Pyodide 运行时的下载源
- `blob:` worker：Pyodide 用 Web Worker

::: tip 三处一致的设计
主前端的 CodeRunner、本学习站的 PyodidePlayground、以及 nginx 的 CSP——三处放行的是**同一套** WASM/CDN 策略。这也是为什么本学习站能直接部署到 `/learn/` 子路径下复用同一 Nginx，而不用额外改 CSP。
:::

## 相关源码

- `app/src/components/autocode/CodeRunner.tsx` — Pyodide 单例 + stdout 捕获
- `app/src/components/chat/HtmlPreview.tsx`、`MessageBubble.tsx` — iframe 沙箱
- `app/nginx.conf` — CSP 放行 WASM/CDN

下一章 [页面导览](/frontend/pages) 会带你快速走一遍 13 个页面，把前端各功能串起来。
