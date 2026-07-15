# 后端环境变量清单

本文档记录 Java 后端 `muhugochat` 常用生产环境变量。建议统一放在：

```ini
/etc/systemd/system/muhugochat.service.d/override.conf
```

修改后执行：

```bash
systemctl daemon-reload
systemctl restart muhugochat
```

## 必填安全配置

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `JWT_SECRET` | JWT 签名密钥，必须是长随机字符串 | `openssl rand -base64 64` |
| `PAY_AES_KEY` | 支付配置密钥加密用 AES key，必须长期稳定保存 | 32 字节以上随机字符串 |

## 内部服务通信

| 变量 | 用途 | 说明 |
| --- | --- | --- |
| `INTERNAL_API_KEY` | Java 后端内部接口密钥 | AutoCode 调 Java 内部接口时使用 |
| `MUHUGOCHAT_INTERNAL_API_KEY` | 同上，兼容旧命名 | 建议和 `INTERNAL_API_KEY` 一致 |

## 缓存账本

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CACHE_LEDGER_BASE_URL` | CacheLedger 服务地址 | `http://127.0.0.1:8000/api/cache` |
| `CACHE_LEDGER_TIMEOUT_MS` | 缓存账本请求超时 | `2500` |

## 跨域

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `CORS_ALLOWED_ORIGINS` | 允许访问 Java 后端的前端来源 | `http://your-server-b-ip,https://muhuo.cloud` |

## Linux.do OAuth 登录

| 变量 | 用途 | 示例 |
| --- | --- | --- |
| `LINUXDO_OAUTH_CLIENT_ID` | Linux.do 应用 Client ID | Linux.do 后台复制 |
| `LINUXDO_OAUTH_CLIENT_SECRET` | Linux.do 应用 Client Secret | Linux.do 后台复制 |
| `LINUXDO_OAUTH_REDIRECT_URI` | OAuth 回调地址，必须与 Linux.do 后台完全一致 | `http://your-server-b-ip/api/auth/oauth/linuxdo/callback` |
| `LINUXDO_OAUTH_FRONTEND_SUCCESS_URL` | 登录成功后返回的前端地址 | `http://your-server-b-ip` |
| `LINUXDO_OAUTH_AUTHORIZE_ENDPOINT` | 授权端点 | `https://connect.linux.do/oauth2/authorize` |
| `LINUXDO_OAUTH_TOKEN_ENDPOINT` | 换 token 端点 | `https://connect.linuxdo.org/oauth2/token` |
| `LINUXDO_OAUTH_USERINFO_ENDPOINT` | 用户信息端点 | `https://connect.linuxdo.org/api/user` |

## systemd 示例

```ini
[Service]
Environment="JWT_SECRET=replace-with-long-random-secret"
Environment="PAY_AES_KEY=replace-with-stable-payment-aes-key"
Environment="INTERNAL_API_KEY=replace-with-internal-key"
Environment="MUHUGOCHAT_INTERNAL_API_KEY=replace-with-internal-key"
Environment="CACHE_LEDGER_BASE_URL=http://127.0.0.1:8000/api/cache"
Environment="CACHE_LEDGER_TIMEOUT_MS=2500"
Environment="CORS_ALLOWED_ORIGINS=http://your-server-b-ip,https://muhuo.cloud,https://www.muhuo.cloud"
Environment="LINUXDO_OAUTH_CLIENT_ID=replace-with-client-id"
Environment="LINUXDO_OAUTH_CLIENT_SECRET=replace-with-client-secret"
Environment="LINUXDO_OAUTH_REDIRECT_URI=http://your-server-b-ip/api/auth/oauth/linuxdo/callback"
Environment="LINUXDO_OAUTH_FRONTEND_SUCCESS_URL=http://your-server-b-ip"
Environment="LINUXDO_OAUTH_AUTHORIZE_ENDPOINT=https://connect.linux.do/oauth2/authorize"
Environment="LINUXDO_OAUTH_TOKEN_ENDPOINT=https://connect.linuxdo.org/oauth2/token"
Environment="LINUXDO_OAUTH_USERINFO_ENDPOINT=https://connect.linuxdo.org/api/user"
```
