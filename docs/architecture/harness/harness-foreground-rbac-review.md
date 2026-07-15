# Harness 前台化与动态 RBAC 修复审查

## 变更范围

- Harness 演进从后台管理移到前台主导航与移动端更多菜单。
- 前端 Harness API 改为 `/api/harness/**`，后端保留 `/api/admin/harness/**` 兼容别名。
- Harness 页面自身按 `harness:view`、`harness:patch`、`harness:regression` 判断能力；没有权限时显示无权限提示。
- 后台入口仅管理员可进，普通用户即使拥有 Harness 权限也不会被引导进入后台。
- 权限管理中 Harness 相关名称增加前后端兜底显示，避免历史乱码数据继续污染界面。

## RBAC 结论

权限管理不是摆设。用户只要通过角色获得 `harness:view`，刷新权限后即可在前台进入 Harness 页面；获得 `harness:patch` 或 `harness:regression` 后，对应操作按钮会自动放开，不需要再改代码。

## 部署注意

已有数据库如果存在 Harness 权限乱码或缺失，需要执行：

```powershell
.\deploy\deploy.ps1 migrate-db deploy\harness_permission_fix_migration.sql
```

## 验证

- 前端：`npm.cmd run build` 通过。
- 后端：`mvn.cmd -DskipTests compile` 通过。
