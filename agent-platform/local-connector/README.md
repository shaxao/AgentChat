# AutoCode IDE

面向 Windows 优先的本地 AutoCode 开发桌面 IDE 壳。

基于 **Tauri 2**（Rust 后端）+ **Vite**（TypeScript 前端）构建，内置 CodeMirror 6 编辑器、xterm.js 终端、预览浏览器、Git 面板和技能商店。

- **版本：** 0.4.14
- **标识符：** `com.muhuo.autocode.localconnector`
- **产品名称：** AutoCode IDE

## 用户流程

1. 在本地启动 AutoCode IDE。
2. 配置 `API URL` 和 `API Key`。
3. 打开一个本地项目目录。
4. 使用内置的文件树、编辑器、终端、预览浏览器、Git 面板、技能商店和 AutoCode 任务面板。

网站端 AutoCode API 始终是业务数据的唯一来源。桌面端负责本地 IDE 体验，通过以下请求头直接调用配置的 API：

- `Authorization: Bearer <apiKey>`
- `X-API-Key: <apiKey>`

## 默认配置

生产环境的 API URL 由发布/部署配置注入。开发构建默认使用：

```text
http://localhost:8000
```

连接器还会按以下顺序检查环境变量：

```text
AUTOCODE_API_BASE_URL
AUTOCODE_CONNECTOR_API_BASE_URL
AUTOCODE_PUBLIC_API_BASE_URL
```

## 本地能力

- 工作区文件树列表，支持路径边界检查和 `.autocodeignore` 忽略规则。
- 文件读写，支持 UTF-8、UTF-8 BOM，以及 Windows GBK 编码处理。
- 保存文件时保留原始换行符风格。
- 对当前编辑器文件进行外部修改轮询检测。
- 通过 `portable-pty` 执行本地终端命令，提供完整 PTY 支持。
- Git 状态和差异摘要。
- 内置预览浏览器面板。
- 通过配置的 API 进行技能商店列表/安装。
- 通过 `tokio-tungstenite` 实现 WebSocket 连接，用于实时通信。
- 通过 `cpal` 和 `hound` 实现音频采集/播放，支持语音功能。
- 单实例强制运行，并支持 deep-link 转发（`tauri-plugin-single-instance`）。
- 通过 `tauri-plugin-updater` 实现自动更新检查。

## 技术栈

### 前端

| 依赖 | 用途 |
|---|---|
| Vite 5 | 构建工具和开发服务器 |
| CodeMirror 6 | 多语言代码编辑器（JS、TS、Python、Rust、Java、C/C++、CSS、HTML、JSON、SQL、XML、YAML、Markdown） |
| xterm.js 6 | 集成终端模拟器，带 fit 适配插件 |
| Mermaid 11 | 图表渲染 |
| Tauri API 2 | 与 Rust 后端的 IPC 桥接 |

### 后端（Rust）

| 依赖 | 用途 |
|---|---|
| Tauri 2 | 桌面应用框架 |
| reqwest 0.12 | HTTP 客户端（rustls-tls） |
| tokio 1 | 异步运行时，支持多线程、进程、文件系统 |
| tokio-tungstenite 0.26 | WebSocket 客户端 |
| portable-pty 0.9 | 基于 PTY 的终端执行 |
| walkdir 2 | 递归目录遍历 |
| rfd 0.15 | 原生文件/文件夹对话框 |
| cpal 0.15 + hound 3 | 音频采集和 WAV 编码 |
| sha2 0.10 | 文件哈希 |
| encoding_rs 0.8 | Windows GBK 编码支持 |

## 兼容性

`muhuo-autocode://` deep link 仍会注册以保持兼容，但现在仅作为项目导入/打开的辅助入口，不再是主要产品入口。

## 开发

### 前置条件

- [Node.js](https://nodejs.org/)（推荐 LTS 版本）
- [Rust](https://www.rust-lang.org/tools/install)（stable 工具链）
- Tauri 2 系统依赖（参见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/)）

### 开发模式（桌面端）

```powershell
cd agent-platform/local-connector
npm install
npm run dev
```

启动 Vite 开发服务器（`http://localhost:5173`）并打开 Tauri 桌面窗口。

### 开发模式（纯前端）

```powershell
cd agent-platform/local-connector
npm install
npm run dev:web
```

仅运行 Vite（`http://127.0.0.1:5173`，固定端口），不启动 Tauri 壳——适合前端快速迭代。

### 构建

#### Tauri 桌面壳（NSIS 安装包）

```powershell
cd agent-platform/local-connector
powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -InstallRust
```

或直接运行：

```powershell
cd agent-platform/local-connector
npm run build
```

预期的 Windows 安装包路径：

```text
src-tauri/target/release/bundle/nsis/AutoCode IDE_0.4.14_x64-setup.exe
```

#### 旧版 Python Runner

成熟的 Python runner 包仍可作为故障排除的备选方案：

```powershell
cd agent-platform/local-connector/windows
.\build-windows-connector.ps1
```

后端在以下路径提供安装包下载：

```text
/api/local-runner/connector/windows/latest
```

## 自动更新

桌面端从以下地址检查更新：

```text
https://muhuo.site/downloads/autocode/latest.json
```

更新通过 minisign 公钥验证，并在 Windows 上以被动模式安装。

## 发布

```powershell
cd agent-platform/local-connector
npm run publish:desktop
```

此命令运行 `deploy/publish-autocode-desktop.ps1` 来构建并发布桌面端版本。
