# MuHuo AI Platform

一个面向真实业务的 AI 对话与代码开发平台。项目由 Java 主系统、React 前端、Python AutoCode Agent 平台、Windows 本地连接器和学习文档站组成，覆盖模型渠道管理、聊天对话、用户与订阅、支付计费、工作流、代码开发 Agent、本地项目执行等能力。

> 本仓库适合用于学习一个中大型 AI 应用如何做工程拆分、模型路由、流式对话、权限计费、Agentic Loop、本地执行连接器和多服务器部署。

## 功能概览

- 多模型对话：兼容 OpenAI 格式 Provider，支持模型渠道、价格、路由、用户偏好和日志记录。
- 用户体系：注册登录、JWT、RBAC 权限、订阅套餐、钱包余额、API Key。
- 安全计费：按场景区分 chat/autocode/workflow，支持套餐额度、钱包兜底、上游渠道成本标记。
- 工作流与技能：工作流模板、执行记录、技能市场/技能运行。
- AutoCode 代码开发：Agentic Loop、自主检索/修改/验证、权限审批、任务状态、预览和本地执行。
- 本地连接器：Windows Tauri/Rust Local Connector，用于授权本机项目目录并执行读写/命令。
- 缓存与记忆：CacheLedger、用户记忆、对话上下文、AutoCode 工作区记忆。
- 文档站：`docs-site` 基于 VitePress，部署后通过 `/learn/` 访问。

## 技术栈

| 模块 | 技术 |
| --- | --- |
| 主前端 | React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand |
| Java 后端 | Spring Boot, MyBatis Plus, Spring Security, JWT, MySQL |
| AutoCode 后端 | Python, FastAPI/Uvicorn, Docker workspace, WebSocket/SSE |
| AutoCode 前端 | Next.js, TypeScript |
| 本地连接器 | Tauri v2, Rust, TypeScript |
| 文档站 | VitePress |
| 部署 | Nginx, systemd, PowerShell/Bash deploy scripts |

## 目录结构

```text
.
├── app/                         # 主 React 前端
├── backend/                     # Java Spring Boot 后端
├── agent-platform/
│   ├── backend/                 # AutoCode Python 后端
│   ├── frontend/                # AutoCode standalone Next.js 前端
│   ├── local-connector/         # Windows 本地连接器
│   └── workspace-image/         # AutoCode Docker 工作区镜像
├── deploy/                      # Windows/服务器部署脚本与 Nginx 配置
├── docs/                        # 设计与实现文档
├── docs-site/                   # VitePress 学习站，部署到 /learn/
├── scripts/                     # 辅助脚本
├── tests/                       # 测试与报告目录
├── .env.example                 # 根环境变量示例
└── docker-compose.yml           # 单机 Docker Compose 参考
```

## 环境变量

真实 `.env` 不应提交到 GitHub。请复制示例文件后填写自己的值：

```bash
cp .env.example .env
cp app/.env.example app/.env
cp agent-platform/backend/.env.example agent-platform/backend/.env
cp agent-platform/frontend/.env.example agent-platform/frontend/.env.local
```

常见必配项：

- `JWT_SECRET`: Java 后端 JWT 密钥。
- `PAY_AES_KEY`: 支付相关 AES 密钥。
- `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USERNAME` / `DB_PASSWORD`: Java 主系统数据库。
- `MUHUGOCHAT_DB_*`: AutoCode 读取 Java 系统模型渠道配置时使用。
- `INTERNAL_API_KEY`: Java 与 AutoCode 内部接口共享密钥。
- `VITE_API_URL`: 主前端访问 Java API 的地址。
- `VITE_AUTOCODE_API_URL`: 主前端访问 AutoCode API 的地址。

## 本地开发

### 1. Java 后端

```powershell
cd backend
mvn -DskipTests compile
mvn spring-boot:run
```

默认 API 地址：

```text
http://localhost:8080/api
```

### 2. 主前端

```powershell
cd app
npm install
npm run dev
```

默认前端地址：

```text
http://localhost:5173
```

### 3. AutoCode 后端

```powershell
cd agent-platform/backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000
```

### 4. AutoCode 前端

```powershell
cd agent-platform/frontend
npm install
npm run dev
```

### 5. 文档站

```powershell
cd docs-site
npm install
npm run docs:dev
```

构建文档站：

```powershell
npm run docs:build
```

## Docker Compose 单机部署

适合本地演示或单台服务器快速启动：

```bash
cp .env.example .env
docker compose up -d --build
docker compose logs -f
```

常用命令：

```bash
docker compose ps
docker compose restart backend
docker compose logs -f backend
docker compose down
```

> 注意：单机 Docker Compose 是参考方案。生产环境建议使用下面的分服务器部署脚本，并将 MySQL、Java 后端、AutoCode Worker 和 Nginx 明确分层。

## Windows PowerShell 多服务器部署

主要部署入口是：

```powershell
.\deploy\deploy.ps1 help
```

这套脚本面向多服务器生产部署，默认分层如下：

| 服务器 | 职责 | 默认目标 |
| --- | --- | --- |
| Server A | Java 后端、主前端、Nginx 入口、文档站 | `HOST_A_IP` |
| Server B | AutoCode Python 后端、工作区、预览服务 | `HOST_B_IP` |
| Server C | MySQL 数据库 | `DB_HOST` |
| Overseas Node | 可选海外 Java 后端节点 | `MUHUGO_OVERSEAS_IP` |

首次部署前先执行初始化命令：

```powershell
# 初始化 Server C：安装和配置 MySQL
.\deploy\deploy.ps1 init-server-c

# 初始化 Server A：安装 Java/Nginx/systemd 运行环境
.\deploy\deploy.ps1 init-server-a

# 初始化 Server B：安装 Python/Node/systemd/AutoCode 运行环境
.\deploy\deploy.ps1 init-server-b

# 可选：初始化海外 Java 后端节点
$env:MUHUGO_OVERSEAS_IP="your-overseas-server-ip"
.\deploy\deploy.ps1 init-backend-overseas
```

常用构建命令：

```powershell
.\deploy\deploy.ps1 build-backend
.\deploy\deploy.ps1 build-frontend
.\deploy\deploy.ps1 build-docs
.\deploy\deploy.ps1 build-autocode-frontend
```

常用上传命令：

```powershell
.\deploy\deploy.ps1 upload-backend
.\deploy\deploy.ps1 upload-frontendonly
.\deploy\deploy.ps1 upload-docs
.\deploy\deploy.ps1 upload-autocode
.\deploy\deploy.ps1 upload-autocode-frontend
```

Nginx 配置更新：

```powershell
.\deploy\deploy.ps1 reload-nginx
```

推荐部署顺序：

```powershell
# 首次部署先初始化三台服务器
.\deploy\deploy.ps1 init-server-c
.\deploy\deploy.ps1 init-server-a
.\deploy\deploy.ps1 init-server-b

# 然后构建并上传 Java 主系统
.\deploy\deploy.ps1 build-backend
.\deploy\deploy.ps1 upload-backend

# 构建并上传主前端和学习文档站
.\deploy\deploy.ps1 build-frontend
.\deploy\deploy.ps1 build-docs
.\deploy\deploy.ps1 upload-frontendonly

# 构建并上传 AutoCode
.\deploy\deploy.ps1 build-autocode-frontend
.\deploy\deploy.ps1 upload-autocode-frontend
.\deploy\deploy.ps1 upload-autocode

# 更新 Nginx 入口配置
.\deploy\deploy.ps1 reload-nginx
```

部署完成后：

- 主站：`http://<server-ip>/`
- API：`http://<server-ip>/api/`
- AutoCode：`http://<server-ip>/autocode/`
- AutoCode API：`http://<server-ip>/autocode-api/`
- 学习文档：`http://<server-ip>/learn/`

## Linux Bash 部署

仓库也提供 Bash 入口：

```bash
./deploy/deploy.sh build-frontend
./deploy/deploy.sh build-backend
./deploy/deploy.sh build-docs
./deploy/deploy.sh upload-a
./deploy/deploy.sh upload-b
```

对应初始化命令：

```bash
./deploy/deploy.sh server-c
./deploy/deploy.sh server-a
./deploy/deploy.sh server-b
```

如果只发布学习文档站：

```bash
./deploy/deploy.sh build-docs
./deploy/deploy.sh upload-a
```

## 数据库迁移

通过 PowerShell 执行 SQL：

```powershell
.\deploy\deploy.ps1 migrate-db deploy\billing_scene_policy_migration.sql
```

迁移脚本主要位于：

```text
deploy/*.sql
deploy/migrations/*.sql
backend/src/main/resources/
```

## AutoCode 本地连接器

Windows 连接器位于：

```text
agent-platform/local-connector
```

构建安装包：

```powershell
cd agent-platform/local-connector
powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1
```

如果国内网络构建 Rust 依赖较慢：

```powershell
powershell -ExecutionPolicy Bypass -File .\build-tauri-windows.ps1 -UseChinaMirror
```

构建产物会复制到 AutoCode 后端静态目录，部署 `upload-autocode` 后可通过接口下载。

## 学习文档站

`docs-site` 是给读者学习项目架构用的 VitePress 站点。开发：

```powershell
cd docs-site
npm run docs:dev
```

构建并部署到 `/learn/`：

```powershell
.\deploy\deploy.ps1 build-docs
.\deploy\deploy.ps1 upload-docs
```

## GitHub 清理建议

本仓库已经加入 `.gitignore`，默认忽略：

- `node_modules/`, `venv/`, `target/`, `dist/`, `out/`, `.next/`
- `.env`, `.env.*`
- 日志、压缩包、jar/class/base64、exe 等生成产物
- IDE/Agent 本地状态目录
- `clear/`

真实配置请只保留在本地或服务器环境中。示例配置请提交 `.env.example`。

## 安全提醒

- 不要提交真实 API Key、JWT 密钥、支付密钥、数据库密码。
- 支付、钱包、订阅、数据库迁移等功能上线前必须经过审计。
- AutoCode 的高风险命令必须走审批策略，本地连接器不应绕过权限控制。
- 生产环境建议开启 HTTPS，并通过 Nginx 统一转发 `/api/`、`/autocode-api/`、`/autocode/`、`/learn/`。

## 友情链接

- [Linux.do](https://linux.do/)

## License

本项目使用 [GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0）。
