# 分层架构总览

这一章带你建立对 Java 主系统的整体认知：它有哪些层、每层放什么、一个请求如何自上而下穿过它们。读完这一章，再去看任何一个具体功能（对话、计费、技能……），你都能把它准确定位到某一层。

## 它有多大

Java 主系统约 **4.7 万行**，是整个平台里最稳定、最"传统"的部分——正因为它承载的是用户、订阅、钱包、渠道这些**交易链路**，稳定压倒一切。

粗略的量级感受：

| 维度 | 量级 |
|------|------|
| 控制器 Controller | ~30 个 |
| 服务 Service | ~50 个 |
| 实体 Entity | 53 张表 |
| Mapper | MyBatis Plus + XML |

## 经典的 Spring Boot 分层

项目遵循标准的分层架构，包结构就是最好的说明（`backend/src/main/java/com/aiplatform/backend/`）：

```text
com.aiplatform.backend
├── BackendApplication.java   # 启动入口
├── controller/               # ① 接入层：REST 端点、参数校验、SSE
├── service/                  # ② 业务层：核心逻辑、事务、编排
│   ├── impl/                 #    业务实现
│   └── provider/             #    AI 供应商适配器（见 Provider 架构）
├── mapper/                   # ③ 数据访问层：MyBatis Plus Mapper
├── entity/                   # ④ 领域实体：53 张表映射
├── dto/                      # 传输对象：请求/响应
├── config/                   # 配置：Security、CORS、线程池…
├── util/                     # 工具类
├── agent/                    # Agent 会话上下文、工具
├── billing/                  # 计费相关
└── memory/                   # 记忆系统
```

一个请求的标准流向：

```text
HTTP 请求
  → Controller（接参、校验、鉴权由过滤器完成）
  → Service（业务逻辑、事务边界）
  → Mapper（SQL）
  → MySQL
```

## 从一个真实端点看清分层

以对话发送为例（`controller/ChatController.java`）：

- **Controller** 负责：拿到 `userId`（由 JWT 过滤器注入为 `@RequestAttribute`）、创建 `SseEmitter`、把耗时逻辑丢进线程池。
- **Service**（`ChatService` / `AiService`）负责：加载历史、保存消息、调用上游 AI、多渠道降级。
- **Mapper**（`ConversationMapper` 等）负责：具体的增删改查。

Controller 只做"接入 + 编排 SSE"，真正的业务在 Service 层，这是分层清晰的体现。

::: tip 一个值得学习的细节
`userId` 不是从请求体里传的，而是 JWT 过滤器解析 token 后，通过 `request.setAttribute("userId", ...)` 注入，Controller 用 `@RequestAttribute Long userId` 直接拿。这样**业务代码永远拿到的是可信的用户身份**，前端伪造无效。见 [JWT + RBAC 权限](/java/auth-rbac)。
:::

## 技术选型

| 关注点 | 选型 | 为什么 |
|--------|------|--------|
| Web 框架 | Spring Boot 3.2 | 生态成熟、稳定 |
| ORM | MyBatis Plus | 兼顾 SQL 可控性与开发效率，`LambdaQueryWrapper` 类型安全 |
| 安全 | Spring Security + JWT | 无状态鉴权，适合前后端分离 |
| 数据库 | MySQL 8.0 | 交易数据的可靠存储 |
| 缓存 | Redis 7 | 验证码、限流、会话上下文 |
| 流式 | `SseEmitter` | 服务器推送，逐 token 输出 |

## 两类"稳定"与"多变"的分工

理解 Java 主系统的定位，关键是记住这句话：

> Java 承载**稳定的交易链路**，Python AutoCode 承载**多变的 Agent Runtime**。

所以你会发现：Java 侧的代码风格偏"保守"——完善的降级重试、事务边界清晰、大量防御性判断（比如 H2 重启后自动重建对话）。这不是啰嗦，而是交易系统该有的样子。

## 建议的阅读顺序

Java 主系统的章节，推荐这样读：

1. [JWT + RBAC 权限](/java/auth-rbac) — 先搞懂"谁能做什么"
2. [SSE 流式对话](/java/sse-chat) — 最核心的用户功能
3. [Provider 架构](/java/provider) — 多模型接入的适配器模式
4. [模型路由](/java/model-routing) — 请求如何被分派到具体渠道
5. [CacheLedger 计费桥接](/java/cache-ledger) — 用量与成本如何记账
6. 其余（记忆、技能、工作流、钱包、Harness）按兴趣展开
