# Agent 记忆与文件分层管理 — 轻量级落地方案（MuhugoChat）

> 来源：合并方案《Agent 记忆与文件分层管理_合并方案.md》（五层记忆模型 + VFS + 存储引擎）
> 适配约束：**服务器限制，不引入 Elasticsearch / Milvus**，采用 MySQL 原生能力的轻量级方案。
> 适用范围：`backend`（Spring Boot + MyBatis-Plus + MySQL）记忆子系统；`app`（React）记忆面板；部署 `deploy/`。

---

## 1. 为什么需要这层抽象

当前 `MemoryService` 已是一个可用的 Coze 风格记忆系统，但存在三个与提案目标不符的缺口：

| 现状 | 提案要求 | 轻量级落地 |
|------|----------|-----------|
| 记忆仅按 `doc_type` 区分，无层级概念 | L0–L4 五层模型，信息按热度流动 | 为 `memory_document` / `memory_index` 增加 `layer` 字段，按类型自动定级 |
| 搜索仅 `LIKE` 关键词，中文召回差、无相关性排序 | L3 语义检索（提案用 Milvus） | **MySQL FULLTEXT + ngram 解析器**（原生支持中文分词），按相关性+重要性排序；预留本地轻量 embedding 作为可选增强 |
| 无容量/生命周期管理 | 压缩审计（80%）、归档（30/60 天） | 新增 `memory_archive` 表 + 定时任务，把冷数据下沉到 L4 |
| 文件无统一虚拟路径 | VFS 虚拟路径 `/memory/hot/...` | 为文档增加 `virtual_path` 字段，作为 Agent 与文件系统的解耦层 |

**核心结论**：方案 B 搭管道（VFS + 存储引擎），方案 A 决定水流（五层 + 流转）。在本项目中，
- 存储引擎层 = **MySQL**（已是事实标准，无需新增组件）
- 文件抽象层 = **`virtual_path` 字段 + `MemoryTierService`**（轻量 VFS，不做真正虚拟化）
- 记忆策略层 = **`layer` 字段 + 压缩/归档任务**
- 用户应用层 = 每个对话的 Memory 空间（已具备）

---

## 2. 五层模型 → 本项目映射

| 层 | 名称 | 本项目落点 | 容量预算 | 生命周期 | 管理方式 |
|----|------|-----------|---------|---------|---------|
| L0 | 工作记忆 | LLM 上下文窗口（`buildMemoryContext` 注入结果） | ~128K token | 随会话 | 自动，不落库 |
| L1 | 热记忆 | `memory_document`（`user_profile`/`secret`/`memory_setting`、重要性≥4 的基础文件） | ≤15KB/条 | 长期 | Agent 主动维护 |
| L2 | 温记忆 | `memory_document`（`conversation_summary`/`project_memory`/`skill_memory`、索引 `memory_index`） | 索引≤5KB/条 | 数天~数月 | 创建+归档 |
| L3 | 冷记忆 | `memory_document`（`layer='L3'`，低频访问的基础/项目记忆）+ FULLTEXT 索引 | 索引无限 | 永久 | 自动入库、语义可检索 |
| L4 | 归档 | `memory_archive` 表（内容下沉，原表保留摘要指针） | 受存储限制 | 永久 | 目录组织 + 可恢复 |

### 2.1 定级规则（`MemoryLayer.assignLayer`）

```
doc_type / category              → layer
user_profile, secret, setting     → L1   (每次对话都会注入，最高频)
conversation_summary (MEMORY.md)  → L2   (本对话上下文)
project_memory / skill_memory     → L2，若 access_count 低且重要性≤2 → L3
work_file_meta                    → L4   (文件元数据，仅索引)
自定义：importance>=4 且 category 含 'base' → L1
```

### 2.2 信息流转

```
新信息 → L0(上下文)
   │ 值得长期记住
   ▼
L1(热: USER.md/SOUL.md) 或 L2(温: MEMORY.md/项目记忆)
   │ 访问频率下降 / 容量超 80%
   ▼
L3(冷: 仍可被 FULLTEXT 检索)
   │ 30 天未访问 → 标记 archived；60 天未访问 → 内容搬入 L4
   ▼
L4(归档: memory_archive，原表仅留摘要)
反向需要时从任意层拉回 L0。
```

---

## 3. 轻量级搜索（替代 ES/Milvus）

### 3.1 主方案：MySQL FULLTEXT + ngram 解析器

```sql
-- 中文分词用 ngram，最小 2 元；英文仍按词
ALTER TABLE memory_document
  ADD FULLTEXT INDEX ft_doc_content (title, content) WITH PARSER ngram;
ALTER TABLE memory_index
  ADD FULLTEXT INDEX ft_idx_summary (summary, tags) WITH PARSER ngram;
```

- **相关性排序**：`MATCH(title,content) AGAINST(? IN NATURAL LANGUAGE MODE)` 返回 `score`，与 `importance` 加权：`ORDER BY (score * (1 + importance*0.1)) DESC`。
- **中文能力**：ngram 把"用户画像"切成"用户/户画/画像"等二元组，规避了默认 parser 不识别 CJK 的问题。
- **零额外组件**：纯 MySQL，部署脚本 `migrate-db` 即可生效，符合"不引入 ES/Milvus"。

### 3.2 可选增强：本地轻量 embedding（未来，仍不依赖 Milvus）

若后续需要语义近义召回（"忘记密码"≈"重置口令"），可引入一个 **本地小模型**（如 `bge-small-zh` 的 ONNX 版，~130MB）在应用进程内做向量化，向量存于 `memory_document.embedding`（`VECTOR` 类型或 `JSON` 浮点数组），用 MySQL 8.0.3+ 的 `DISTANCE` 函数或应用内余弦计算。**仍不引入外部向量数据库**，保持轻量。

### 3.3 检索入口

`MemoryTierService.semanticSearch()` 统一封装：
```
LIKE 关键词（兜底）  ←  失败/无结果时回退
FULLTEXT ngram（主力）  →  相关性+重要性排序
```

---

## 4. VFS 虚拟路径（轻量文件抽象层）

为每份文档生成 `virtual_path`，作为 Agent / 前端与物理存储的解耦键：

```
/memory/hot/{title}            # L1 热记忆，如 /memory/hot/USER.md
/memory/warm/{convUuid}/{title}# L2 温记忆，按对话隔离
/memory/cold/{category}/{title}# L3 冷记忆
/archive/{yyyy}/{title}        # L4 归档
/workspace/{convUuid}/{file}    # 工作文件（对应 memory_work_file）
```

- Agent 只认 `virtual_path`，不关心底层是 MySQL 行还是对象存储。
- `MemoryTierService.virtualPathFor(doc)` 负责生成；`FileTreeNode` 直接复用该字段作为 `key`，前端树天然具备层级。
- 迁移脚本按 `doc_type`+`conversationId` 回填历史数据。

---

## 5. 容量与生命周期管理

### 5.1 L1 压缩审计（触发：L1 文档数或总字符数 ≥ 80% 预算）

- 遍历 `layer='L1'` 文档，按 `access_count` 升序 + `importance` 升序；
- 低访问（近 14 天 `last_accessed_at` 为空或早）且 `importance<=3` → 降为 `L2`；
- 仍然需要但过长 → 提炼摘要（复用现有 LLM 摘要能力）写入索引，原文保留指针。
- 由 `MemoryTierService.compressionAudit(userId)` 执行，可被 `/tier/audit` 手动触发。

### 5.2 L2/L3 归档（定时任务 `MemoryTierScheduler`）

- 每天低峰执行：扫描 `layer IN ('L2','L3')` 且 `status='active'`；
- `last_accessed_at` 距今 ≥ 30 天 → `status='archived'`（保留内容，仅不主动注入）；
- 距今 ≥ 60 天 → 内容写入 `memory_archive`，原 `memory_document.content` 置为摘要指针，`layer='L4'`；`memory_index` 摘要保留以支持检索。
- `restoreFromArchive(docId)` 支持将 L4 内容拉回 L2。

### 5.3 访问计数

`buildMemoryContext` 注入某文档时调用 `recordAccess(docId)`，自增 `access_count` 并更新 `last_accessed_at`，为归档决策提供数据。

---

## 6. 数据模型变更（详见 `deploy/memory_layered_migration.sql`）

**memory_document** 新增列：
- `layer` VARCHAR(8) NOT NULL DEFAULT 'L1'
- `virtual_path` VARCHAR(512)
- `access_count` INT NOT NULL DEFAULT 0
- `last_accessed_at` DATETIME

**memory_index** 新增列：`layer`、`virtual_path`、`access_count`、`last_accessed_at`。

**新增 memory_archive**（L4）：
- `id`, `user_id`, `source_doc_id`, `title`, `category`, `content`, `summary`, `tags`, `archived_at`, `restore_key`。

**索引**：两个 ngram FULLTEXT；`memory_document(layer)`、`memory_document(last_accessed_at)` 普通索引。

**回填**：按定级规则更新历史 `layer` 与 `virtual_path`（幂等，`WHERE layer IS NULL OR virtual_path IS NULL`）。

---

## 7. API 变更（向后兼容）

新增端点（`/api/memory`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/tier/stats` | 各层文档数、容量占用、待归档数 |
| POST | `/tier/audit` | 手动触发压缩审计+归档（ADMIN） |
| POST | `/search/semantic` | 轻量级语义搜索（FULLTEXT ngram） |

`DocumentVO` / `IndexVO` 增加 `layer`、`virtualPath` 字段（不影响旧调用方）。

---

## 8. 项目文件组织建议（app / backend）

当前 `backend/src/.../service` 已有 `MemoryService`（~1700 行，职责偏重）。建议分层收口：

```
backend/src/main/java/com/aiplatform/backend/
├── memory/
│   ├── MemoryLayer.java          # 层级常量 + 定级/路径助手（新增）
│   ├── MemoryTierService.java    # 五层流转 + 语义搜索 + 归档（新增，承接策略层）
│   ├── MemoryTierScheduler.java  # 定时压缩/归档（新增）
│   └── (MemoryService 保留为聚合门面，委托上述类)
├── controller/MemoryController.java   # 增加 tier 端点
├── mapper/MemoryDocumentMapper.java   # 增加 FULLTEXT 方法
└── entity/MemoryDocument.java         # 增加 layer/virtual_path/access 字段
```

`app/src` 侧：记忆相关组件已集中在 `components/chat/Memory*.tsx` 与 `lib/api.ts`，仅需补充 `layer` 类型并在文件树展示层级徽标（见前端任务）。

---

## 9. 部署与回滚

1. 执行 `deploy/memory_layered_migration.sql`（`migrate-db` 已支持幂等 SQL）。
2. 重新构建并上传后端（`build-backend` / `upload-backend`）。
3. 校验：`/api/memory/tier/stats` 返回分层计数；`/api/memory/search/semantic` 关键词命中。
4. **回滚**：新增列均有默认值，新增表独立；若需回退，仅删除 `memory_archive` 表与 `layer/virtual_path/access_*` 列即可，原 `doc_type` 逻辑完全不受影响。

---

## 10. 与提案的偏差说明

| 提案 | 轻量级偏差 | 理由 |
|------|-----------|------|
| L3 用 Milvus 向量库 | MySQL FULLTEXT ngram | 服务器限制，避免重组件；中文 ngram 已满足关键词/短语召回 |
| 索引层用 ES + PostgreSQL 元数据 | MySQL 单库同时承担索引+元数据 | 减少运维面，MyBatis-Plus 直接可用 |
| 真正 VFS 虚拟化 | `virtual_path` 字段 + 服务层映射 | 单用户/单租户阶段无需对象存储抽象 |
| L4 用后台存储桶 | `memory_archive` 同库表 | 数据量小，归档即"内容下沉+摘要指针" |

> 该方案是提案的 **V1（单用户 Agent）** 形态：把方案 A 的记忆策略跑通，存储全部基于 MySQL，VFS 用路径映射代替虚拟化，索引用 FULLTEXT 代替 ES/Milvus。待进入 V2（多用户隔离）再引入对象存储与可选本地 embedding。
