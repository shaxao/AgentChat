# AutoCode Agent Platform

> 自主式 AI 编程 Agent 系统 — 基于 Claude Code SDK + Docker 隔离执行 + 多 Agent 协作

## 愿景

让 AI 不只是给建议，而是**自己动手完成整个项目**。用户提出需求 → AI 理解拆解 → 多 Agent 并行执行 → 实时预览 → 用户验收 → 一键部署。

## 核心能力

| 能力 | 状态 | 说明 |
|------|------|------|
| 多 Agent 协作 | 🔨 开发中 | Frontend / Backend / DevOps / Researcher Agent 并行 |
| Git 版本管理 | 📋 待实现 | 可视化历史 · 分支切换 · 任意版本回滚 |
| 实时终端 | 📋 待实现 | WebSocket 推流 · Agent 执行过程实时可见 |
| iframe 预览 | 📋 待实现 | Build 完直接内嵌预览 |
| 一键部署 | 📋 待实现 | Vercel / 容器镜像发布 |

## 架构

```
用户 (Next.js UI)
    ↓ HTTP/WebSocket
FastAPI Backend
    ├── Agent Orchestrator (Claude Code SDK)
    ├── Workspace Manager (Docker 容器池)
    ├── Git Manager (isomorphic-git)
    └── Terminal Manager (WebSocket PTY)
    ↓
隔离执行容器 (workspace containers)
```

## 快速启动

### 前置要求
- Docker & Docker Compose
- Python 3.11+
- Node.js 20+
- Anthropic API Key

### 启动服务

```bash
# 1. 初始化后端
cd backend
cp .env.example .env
# 编辑 .env 填入 ANTHROPIC_API_KEY
pip install -r requirements.txt
uvicorn main:app --reload --port 8000

# 2. 初始化前端
cd ../frontend
cp .env.example .env.local
npm install
npm run dev

# 3. 启动 Docker 容器池
cd ..
docker-compose -f docker-compose.yml up -d
```

### 环境变量

**backend/.env**
```
ANTHROPIC_API_KEY=sk-ant-xxxxx
WORKSPACE_BASE_DIR=/data/workspaces
GIT_AUTHOR_NAME=AutoCode Agent
GIT_AUTHOR_EMAIL=agent@autocode.local
MAX_CONCURRENT_TASKS=5
DOCKER_WORKSPACE_IMAGE=autocode-workspace:latest
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | Next.js 15 · React 19 · shadcn/ui · xterm.js · @xyflow |
| 后端 | FastAPI · Python 3.11 · Claude Code SDK · pydantic |
| 执行隔离 | Docker · websocket · python-dotenv |
| Git | isomorphic-git (前端) · Gitea API (服务端) |
| 部署 | Docker Compose · Nginx |

## Agent 能力池

| Agent | 职责 | 核心 Skill |
|-------|------|-----------|
| **Frontend Agent** | 前端 UI 开发 | file-write · read · bash · preview |
| **Backend Agent** | API / 数据库 / 业务逻辑 | file-write · read · bash · docker |
| **DevOps Agent** | CI/CD / 部署 / 容器化 | docker · bash · deploy · rollback |
| **Researcher Agent** | 技术调研 / 方案选型 | web-search · read · analyze |

## 安全策略

- ✅ 删除/覆盖文件：每次操作需用户手动确认
- ✅ 代码执行：隔离 Docker 容器内运行
- ✅ 网络隔离：容器内禁止访问内网
- ✅ 资源限制：CPU / 内存 / 磁盘配额
- ✅ 操作审计：所有 git commit 和文件操作记录
