# MuhugoChat 三服务器部署指南

## 服务器规划

| 服务器 | 配置 | 部署内容 |
|--------|------|---------|
| **服务器 A** | 2C2G | Java 后端 (8080) + Nginx (80/443) + 前端静态文件 |
| **服务器 B** | 4C4G | AutoCode Python 后端 (8000) + 工作空间 |
| **服务器 C** | 2C2G | MySQL 8.0 (3306) |

---

## 第一步：修改 deploy/deploy.sh 顶部的 IP 配置

```bash
# 打开 deploy/deploy.sh，修改这三行：
SERVER_A_IP="1.2.3.4"   # 替换为实际 IP
SERVER_B_IP="5.6.7.8"
SERVER_C_IP="9.10.11.12"
```

---

## 第二步：部署服务器 C（MySQL）

```bash
# SSH 登录到服务器 C
ssh root@<服务器C_IP>

# 把 deploy.sh 上传到服务器 C，然后运行：
bash deploy.sh server-c
```

完成后会输出 MySQL 服务器的 IP，记录备用。

---

## 第三步：部署服务器 A（Java + Nginx）

```bash
# SSH 登录到服务器 A
ssh root@<服务器A_IP>

# 上传 deploy.sh 到服务器 A，然后运行：
bash deploy.sh server-a
```

服务器 A 的 /opt/muhugochat/ 目录已创建，等待上传 backend.jar。

---

## 第四步：在本机构建 + 上传

```bash
# 进入 deploy 目录
cd deploy

# 构建前端
bash deploy.sh build-frontend

# 构建 Java 后端
bash deploy.sh build-backend

# 上传到服务器 A（前端 + JAR）
bash deploy.sh upload-a <服务器A_IP>

# 上传 AutoCode 到服务器 B
bash deploy.sh upload-b <服务器B_IP>
```

---

## 第五步：启动服务

```bash
# 服务器 A
ssh root@<服务器A_IP>
systemctl start muhugochat
systemctl status muhugochat

# 服务器 B
ssh root@<服务器B_IP>
systemctl start autocode
systemctl status autocode
```

---

## 验证部署

```bash
# 检查 Java 后端
curl http://<服务器A_IP>:8080/api/health

# 检查 AutoCode
curl http://<服务器B_IP>:8000/health

# 检查 Nginx 前端
curl http://<服务器A_IP>/
```

---

## 防火墙配置

```bash
# 服务器 A（对外开放 80/443）
ufw allow 80/tcp
ufw allow 443/tcp

# 服务器 C（只允许 A 和 B 访问 3306）
ufw allow from <服务器A_IP> to any port 3306
ufw allow from <服务器B_IP> to any port 3306

# 服务器 B（只允许 A 访问 8000）
ufw allow from <服务器A_IP> to any port 8000
```
