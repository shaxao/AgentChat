# Backend Java 项目完整结构报告

**项目路径**: c:\Users\Administrator\WorkBuddy\20260417103053\backend

---

## 1. 项目总体结构

### 基础信息
- groupId: com.aiplatform
- artifactId: backend
- Spring Boot: 3.2.0 (parent)
- Java: 17
- 单模块项目(非 Maven 多模块)

### 核心依赖 (pom.xml)
| 依赖 | 版本 | 用途 |
|---|---|---|
| spring-boot-starter-web | 3.2.0 | Web 框架 |
| spring-boot-starter-security | 3.2.0 | 安全框架 |
| spring-boot-starter-validation | 3.2.0 | 参数校验 |
| spring-boot-starter-mail | 3.2.0 | 邮件发送 |
| spring-boot-starter-data-redis | 3.2.0 | Redis 缓存 |
| mybatis-plus-spring-boot3-starter | 3.5.8 | ORM 框架 |
| mysql-connector-j | - | MySQL 驱动 |
| h2 | - | H2 内存数据库(开发) |
| jjwt-api/impl/jackson | 0.12.5 | JWT 工具 |
| lombok | - | 代码简化 |
| caffeine | - | 本地缓存 |
| poi-ooxml | - | Excel 处理 |
| spring-boot-starter-webflux | 3.2.0 | WebClient(AI调用) |
| aliyun-sdk-oss | - | 阿里云 OSS |
| cos_api | - | 腾讯 COS |
| minio | - | MinIO OSS |

### 包结构 (com.aiplatform.backend)

`
com.aiplatform.backend/
  |-- BackendApplication.java          -- 启动类(@MapperScan, @EnableAsync, @EnableScheduling)
  |-- agent/                           -- Agent 系统核心
  |    |-- AgentConfig.java             -- Agent 配置(model, temp, maxTokens, systemPrompt, tools)
  |    |-- AgentSessionContext.java     -- 会话上下文(ThreadLocal: userId, uploadedFilePaths)
  |    |-- ToolDefinition.java          -- 工具定义(name, description, parametersJson)
  |    |-- ToolExecutor.java            -- 工具执行器(函数式: toolName+argsJson -> result)
  |    |-- ToolCallRecord.java          -- 工具调用记录
  |-- config/                          -- 配置类(6 个)
  |    |-- AppConfig.java               -- CORS, BCryptPasswordEncoder, MybatisPlusInterceptor
  |    |-- JwtFilter.java               -- JWT 过滤器(OncePerRequestFilter)
  |    |-- SecurityConfig.java          -- SecurityFilterChain 配置
  |    |-- MyMetaObjectHandler.java     -- 自动填充(createdAt, updatedAt, deleted)
  |    |-- OssDefaultProperties.java    -- OSS 默认属性
  |    |-- OssConfigInitializer.java    -- OSS 配置初始化
  |-- controller/                      -- 控制器层(12 个)
  |-- dto/                             -- 数据传输对象(12 个)
  |-- entity/                          -- 实体类(22 个)
  |-- mapper/                          -- MyBatis-Plus Mapper(30 个)
  |-- service/                         -- 服务层(41 个)
  |    |-- impl/                       -- OSS 实现(5 个)
  |    |-- image/                      -- 图片生成适配器(4 个)
  |    |-- provider/                   -- AI Provider 适配器(6 个)
  |-- util/                            -- 工具类(2 个)
      |-- JwtUtil.java
      |-- CodeUtil.java
`

### 资源文件结构 (src/main/resources/)
- application.yml -- 主配置(H2 开发, MyBatis-Plus, JWT, Redis, Mail, OSS)
- application-prod.yml -- 生产配置(MySQL, HikariCP)
- schema.sql -- 完整建表脚本(25+ 张表)
- data.sql -- 初始化数据(admin用户, 模型配置, 订阅计划等)
- data-skills.sql -- 内置 Agent/Skill 初始数据
- migration.sql + db/migration.sql -- 增量迁移脚本

---

## 2. 所有数据库实体/模型

### 关键发现: 没有独立的 Role 和 Permission 表

系统中不存在 Role.java, Permission.java 等独立 RBAC 实体类。角色权限设计是扁平的:
- SysUser 实体的 role 字段是 String 类型, 取值为 "admin" 或 "user"
- 没有角色表、权限表、用户-角色关联表、角色-权限关联表

### 完整实体清单(22 个实体类)

| 实体类 | 数据库表名 | 主键 | 逻辑删除 | 关键字段 |
|---|---|---|---|---|
| SysUser | sys_user | id(AUTO) | deleted | username, email, password(BCrypt), role(admin/user), plan(free/pro/enterprise), balance(BigDecimal), tokensUsed/Limit |
| ChatConversation | chat_conversation | id(AUTO) | deleted | uuid, userId, title, model, systemPrompt, pinned, tags, contextSummary |
| ChatMessage | chat_message | id(AUTO) | deleted | uuid, conversationId, role(user/assistant/system/tool), content, model, tokens, cost, latencyMs |
| ModelChannel | model_channel | id(AUTO) | deleted | uuid, name, provider, apiKey, baseUrl, models, channelType(chat/tts/translate), status |
| ModelConfig | model_config | id(AUTO) | - | uuid, modelId, name, provider, contextLength, input/outputPrice, capabilities, taskTypes, routingPriority |
| ModelRoutingRule | model_routing_rule | id(AUTO) | - | uuid, name, conditionJson, targetModels, priority, scenario |
| ModelRoutingStats | model_routing_stats | id(AUTO) | - | uuid, model, scenario, successCount, failureCount, avgLatency, circuitBreakerOpen |
| Subscription | subscription | id(AUTO) | deleted | uuid, userId, planId, plan, status, price, tokensLimit, modelLimit |
| SubscriptionPlan | subscription_plan | id(AUTO) | - | uuid, name, code, price, tokensLimit, modelLimit, features, isPopular |
| AgentRegistry | agent_registry | id(AUTO) | - | agentId, name, version, systemPrompt, toolsJson, status(5种), isBuiltin, revenueRatio, avgRating, totalUsage/Revenue |
| UserInstalledSkill | user_installed_skills | id(AUTO) | - | userId, skillId, agentId, installedAt |
| SkillRating | skill_rating | id(AUTO) | - | userId, skillId, rating, comment |
| WalletTransaction | wallet_transaction | id(AUTO) | - | uuid, userId, type(5种), amount, balanceAfter, status(4种) |
| ApiLog | api_log | id(AUTO) | - | userId, model, tokens, cost, latencyMs, status, channel |
| MemorySetting | memory_setting | id(AUTO) | - | userId, conversationUuid, contextInjectionMode, maxDocuments, maxTokens |
| MemoryDocument | memory_document | id(AUTO) | - | userId, conversationUuid, title(SOUL/MEMORY/USER/WORK.md), content, tags, version |
| MemoryIndex | memory_index | id(AUTO) | - | userId, conversationUuid, documentId, keywords, summary |
| MemoryWorkFile | memory_work_file | id(AUTO) | - | userId, conversationUuid, fileName, fileUrl, fileType |
| OssConfig | oss_config | id(AUTO) | - | uuid, provider(aliyun/tencent/minio), endpoint, bucket, accessKey, isDefault |
| Scenario | scenario | id(AUTO) | - | uuid, name, description, icon, model, sort |
| Workflow | workflow | id(AUTO) | - | uuid, name, dsl(Json), cron, enabled, createdBy |
| WorkflowExecution | workflow_execution | id(AUTO) | - | uuid, workflowId, status, inputJson, outputJson, error |
| KgEntity | kg_entity | id(AUTO) | - | uuid, name, type, propertiesJson, description, source |
| KgRelation | kg_relation | id(AUTO) | - | uuid, subjectId, predicate, objectId, propertiesJson, weight |

**额外 Mapper 对应的表**(可能 Entity 在别处或内嵌):
- skill_revenue_record, user_model_preference, user_model_feedback
- user_model_usage_daily, workflow_template

---

## 3. 数据库 Schema

### 数据库配置
| 环境 | 数据库 | JDBC URL |
|---|---|---|
| 开发(dev) | H2 (内存) | jdbc:h2:mem:aiplatform;MODE=MySQL |
| 生产(prod) | MySQL | jdbc:mysql://your-server-c-ip:3000/MuHugoAi |

### Schema 初始化
- schema.sql -- 所有 25+ 张表完整 CREATE TABLE 定义
- data.sql -- admin 用户(BCrypt), 6 个模型配置, 3 个订阅计划, 渠道, 6 场景, 8 路由规则
- data-skills.sql -- 内置 Agent/Skill 初始数据
- sql.init.mode=always (每次启动都执行)
- migration.sql + db/migration.sql -- 增量迁移(ALTER TABLE, CREATE TABLE IF NOT EXISTS)

### 关键发现: 不存在 Mapper XML 文件
所有 Mapper 接口纯粹继承 BaseMapper<T>, 无自定义 SQL 方法, 无 XML 映射文件。
复杂查询在 Service 层通过 LambdaQueryWrapper / QueryWrapper 构建。

### 完整数据库表清单
- 用户: sys_user, subscription, subscription_plan
- 聊天: chat_conversation, chat_message, api_log
- 模型: model_channel, model_config, model_routing_rule, model_routing_stats
- Agent/Skill: agent_registry, user_installed_skills, skill_rating, skill_revenue_record
- 钱包: wallet_transaction
- 记忆: memory_setting, memory_document, memory_index, memory_work_file
- OSS: oss_config
- 工作流: workflow, workflow_execution, workflow_template
- 知识图谱: kg_entity, kg_relation
- 场景: scenario
- 用户偏好: user_model_preference, user_model_feedback, user_model_usage_daily
