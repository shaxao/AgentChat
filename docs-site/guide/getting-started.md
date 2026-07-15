# 本地启动指南

这一章带你把整个平台在本地跑起来。分子系统给出最小启动路径——你不必一次全跑，按学习目标挑需要的部分即可。

::: tip 只想看文档？
你现在看的这个学习站本身就能独立运行，不依赖任何后端。见文末 [启动学习站](#启动学习站本站)。
:::

## 依赖总览

| 子系统 | 需要 |
|--------|------|
| Java 后端 | JDK 17、Maven、MySQL 8、Redis 7 |
| React 前端 | Node.js 20+ |
| AutoCode 后端 | Python 3.11+、Docker、Anthropic API Key |
| Rust 连接器 | Rust 工具链、Node.js |

## 一、Java 主系统

```bash
cd backend

# 1. 准备数据库（MySQL 8）
#    创建库并导入初始化 SQL
mysql -u root -p -e "CREATE DATABASE MuHuoAi DEFAULT CHARACTER SET utf8mb4;"
mysql -u root -p MuHuoAi < ../init-mysql.sql

# 2. 配置（复制模板并填写）
#    数据库、Redis、邮件、JWT 密钥等
cp ../.env.example ../.env

# 3. 启动
mvn spring-boot:run
```

启动后后端监听 `:8080`。验证：

```bash
curl http://localhost:8080/api/plans
```

默认管理员账号：`admin@aiplatform.com` / `Admin@123456`（首次登录务必改密码）。

## 二、React 前端

```bash
cd app
npm install
npm run dev
```

开发服务器在 `:5173`（Vite 默认）。它通过 `vite.config.ts` 里的 proxy 把 `/api/chat`、`/api/v1` 转发到 `:8080`（Java），把 `/api` 转发到 `:8000`（AutoCode）。

::: details 看一眼代理规则
```ts
server: {
  proxy: {
    '/api/v1/ledger': { target: 'http://localhost:8080' },
    '/api/chat':      { target: 'http://localhost:8080' },
    '/api/v1':        { target: 'http://localhost:8080' },
    '/api':           { target: 'http://localhost:8000' }, // AutoCode
  },
}
```
注意顺序：更具体的路径（`/api/chat`）在通配 `/api` 之前。
:::

## 三、Python AutoCode

```bash
cd agent-platform/backend
cp .env.example .env
# 编辑 .env 填入 ANTHROPIC_API_KEY

pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

AutoCode 前端（Next.js）：

```bash
cd agent-platform/frontend
npm install
npm run dev
```

要跑真实的代码执行任务，还需启动 Docker 容器池——细节见 [Docker 隔离执行](/autocode/docker-isolation)。

## 四、Rust 连接器

```bash
cd agent-platform/local-connector
npm install
npm run tauri dev
```

第一次编译 Rust 依赖会比较慢。连接器的作用见 [为什么需要连接器](/connector/why)。

## 启动学习站（本站）

```bash
cd docs-site
npm install
npm run docs:dev
```

打开 `http://localhost:5173/learn/` 即可。构建部署：

```bash
npm run docs:build   # 产物在 .vitepress/dist
```

部署已接进主项目的 `deploy/deploy.sh`：

```bash
./deploy.sh build-docs   # 构建
./deploy.sh upload-a      # 随前端一起上传到 /learn 子路径
```

## 下一步

跑起来之后，读 [如何阅读本手册](/guide/how-to-read) 规划你的学习路线。
