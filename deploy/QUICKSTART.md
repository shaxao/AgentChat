# MuhugoChat 三服务器生产部署 — 快速开始（Windows）

## 当前服务器配置

| 服务器 | 配置 | IP | 部署内容 |
|--------|------|----|---------|
| **A** | 2C2G | `your-server-a-ip` | Java 后端 + Nginx + **前端静态文件** |
| **B** | 4C4G | `your-server-b-ip` | AutoCode Agent 平台 |
| **C** | 2C2G | `your-server-c-ip` | MySQL 8.0 |

> IP 已填，直接可用。如需修改，编辑 `deploy.ps1` 顶部变量。

---

## 服务通信一览

```
浏览器 → http://your-server-a-ip:80 (服务器 A Nginx)
              │
    ┌─────────┼─────────┐
    ▼         ▼         ▼
  /         /api/     /autocode-api/
 前端静态   Java后端    AutoCode API
 (本地)    (A:8080)   ──→ 服务器 B:8000
              │              │
              └──────┬───────┘
                     ▼
              MySQL (服务器 C:3306)
```

**前端部署在哪？** → 在服务器 A 的 `/var/www/muhugochat-frontend/`，Nginx 直接提供静态文件。

**前端构建在哪？** → 在你的 Windows 本机，构建后上传到服务器 A。

---

## 前置条件

在 Windows PowerShell（管理员）中运行：

```powershell
# 1. 确认 SSH 可用
ssh -V

# 2. 确认 tar 可用（Win10 1803+ 内置）
tar --version

# 3. 测试三台服务器 SSH 连通
ssh root@your-server-a-ip "echo OK"
ssh root@your-server-b-ip "echo OK"
ssh root@your-server-c-ip "echo OK"
```

---

## 部署步骤

### 第一步：初始化三台服务器（首次部署才需执行）

```powershell
cd C:\Users\Administrator\WorkBuddy\20260417103053\deploy

# 按顺序执行：
.\deploy.ps1 init-server-c     # 1. MySQL (约 3 分钟)
.\deploy.ps1 init-server-a     # 2. Java + Nginx (约 2 分钟)
.\deploy.ps1 init-server-b     # 3. AutoCode (约 2 分钟)
```

> init-server-a/b 会自动注入服务器 B/C 的 IP 到 Nginx 配置和 .env 中。

### 第二步：验证连通性

```powershell
.\deploy.ps1 check-connectivity
```

输出应全部为 `OK`。如果有 `FAIL`，检查对应端口是否开放：
- 服务器 A → 服务器 C:3306 (MySQL)
- 服务器 A → 服务器 B:8000 (AutoCode)
- 服务器 A → 服务器 B:3100-3199 (预览用 dev server)

### 第三步：构建 + 上传

```powershell
# 一键全流程（构建前端 + 打包 Java + 上传全部）
.\deploy.ps1 full-deploy
```

或者分步操作：

```powershell
# 仅构建 + 上传前端（日常最常用！）
.\deploy.ps1 build-frontend
.\deploy.ps1 upload-frontend

# 仅上传 Java 后端
.\deploy.ps1 build-backend
.\deploy.ps1 upload-backend

# 仅上传 AutoCode
.\deploy.ps1 upload-autocode
```

### 第四步：确认服务已启动

```powershell
ssh root@your-server-a-ip "systemctl status muhugochat --no-pager"
ssh root@your-server-b-ip "systemctl status autocode --no-pager"
```

### 第五步：打开浏览器验证

```
http://your-server-a-ip
```

---

## 日常更新指南

| 改了什么 | 执行命令 |
|---------|---------|
| **前端代码**（React/UI） | `.\deploy.ps1 upload-frontend` |
| **Java 后端** | `.\deploy.ps1 build-backend` 然后 `.\deploy.ps1 upload-backend` |
| **AutoCode** | `.\deploy.ps1 upload-autocode` |
| **全部** | `.\deploy.ps1 full-deploy` |

> `upload-frontend` 会自动检测前端是否已构建，未构建则先自动 `npm run build`。上传使用 `tar` 管道（Windows 10+ 内置），不依赖第三方工具。

---

## 故障排查

```powershell
# 查看 Java 后端日志
ssh root@your-server-a-ip "tail -50 /opt/muhugochat/app.log"

# 查看 AutoCode 日志
ssh root@your-server-b-ip "tail -50 /var/log/autocode/app.log"

# 查看 Nginx 错误
ssh root@your-server-a-ip "tail -20 /var/log/nginx/error.log"

# 从服务器 A 测试 MySQL 连接
ssh root@your-server-a-ip "mysql -h your-server-c-ip -u muhuoai -pchangeme MuHuoAi -e 'SELECT 1'"

# 重启服务
ssh root@your-server-a-ip "systemctl restart muhugochat"
ssh root@your-server-b-ip "systemctl restart autocode"

# 前端没更新？清除 Nginx 缓存
ssh root@your-server-a-ip "rm -rf /var/www/muhugochat-frontend/* && nginx -s reload"
```

---

## 预览功能说明

AutoCode 构建项目后会在服务器 B 的 **3100-3199 端口** 启动 Dev Server。防火墙已配置为**仅服务器 A 可访问**这些端口。Nginx 不需要额外配置——预览 URL 通过 `/autocode-api/` 代理转发到服务器 B。

预览 URL 格式：`http://your-server-a-ip/autocode-api/workspace/{task_id}/preview/`
