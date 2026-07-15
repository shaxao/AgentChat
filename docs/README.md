# 工作文件索引 (L4 归档层)

本目录按主题组织项目工作文件，对应「Agent 记忆与文件分层管理」方案的 **L4 归档层**（文件系统、永久、目录组织）。

> 记忆系统的五层模型见 `.workbuddy/memory/_README.md`。

## 目录结构

| 目录 | 内容 | 来源（原根目录 / 原位置） |
|------|------|--------------------------|
| `planning/` | 战略规划、执行计划、遗留计划产物 | `AI工作平台战略规划方案_v1.md`、`战略改造执行计划_v1.md`、`legacy-plan-artifact.md`(损坏的计划产物，已隔离) |
| `architecture/` | 后端结构、Harness、模型路由、Provider 重构、工作流引擎 V2、用户模型偏好 | `backend-project-structure-report.md`、`Harness 架构.md`、`model_routing_implementation.md`、`refactor-provider-architecture.md`、`user-model-preference-design.md`、`workflow-engine-v2/`、`harness/` |
| `ops/` | 部署文档、OOM 监控 | `部署文档.md`、`OOM-MONITORING.md` |
| `skills/` | 技能商店对话式编辑方案/指南/总结 | `技能商店对话式编辑优化*.md` |
| `testing/` | 功能测试报告 | `场景管理功能测试报告.md` |
| `portfolio/` | 简历与平台项目描述优化 | `AI智能对话与Agent开放平台_简历优化.md` |

## 索引文件

- `current-task-status.md` — 当前任务状态总览（最新验证结果、剩余任务）。**保持在本目录根，作为入口索引，请勿移动。**

## 维护规则

- 根目录只保留 `README.md` 和 `overview.md`。新的工作文件产出后应归入上述对应子目录。
- 单篇超过 ~15KB 且不再频繁变更的设计文档归入本 L4 层；仍在高频演进的内容可保留在对话级记忆（L1/L2）。
- 子目录内文件如形成系列（如 `workflow-engine-v2/`），可再建二级目录归类。
