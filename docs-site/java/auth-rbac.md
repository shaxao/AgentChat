# JWT + RBAC 权限

这一章讲清楚一件事：**一个带着 token 的 HTTP 请求，是怎么在进入任何业务代码之前，就被鉴权并挂上权限的。**

理解它，你就理解了整个 Java 主系统的安全底座——所有 controller 拿到的 `userId`、所有 `@PreAuthorize` 判断的权限，都来自这一步。

## 一次请求的鉴权旅程

<FlowTimeline
  title="带 token 的请求进入后端的鉴权流程"
  :steps='[
    { system: "React", title: "带上 Authorization 头", detail: "Bearer <jwt>", file: "app/src/lib/api" },
    { system: "Nginx", title: "反向代理转发", detail: "/api/ → backend:8080", file: "app/nginx.conf:43" },
    { system: "Spring Boot", title: "JwtFilter 拦截", detail: "OncePerRequestFilter，每请求一次", file: "backend/.../config/JwtFilter.java:31" },
    { system: "Spring Boot", title: "公共路径直接放行", detail: "login/register/plans 等无需 token", file: "backend/.../config/JwtFilter.java:37" },
    { system: "Spring Boot", title: "校验 token 有效性", detail: "jwtUtil.isValid(token)", file: "backend/.../config/JwtFilter.java:49" },
    { system: "Spring Boot", title: "解析 userId 与 role", detail: "写入 request attribute", file: "backend/.../config/JwtFilter.java:54" },
    { system: "Spring Boot", title: "加载 RBAC 权限码", detail: "rbacService.getUserPermissionCodes", file: "backend/.../config/JwtFilter.java:65" },
    { system: "Spring Boot", title: "构建 Authentication", detail: "ROLE_ / PERM_ 前缀写入 SecurityContext", file: "backend/.../config/JwtFilter.java:81" },
    { system: "Spring Boot", title: "进入 Controller", detail: "@RequestAttribute Long userId 直接可用", file: "backend/.../controller" }
  ]'
/>

## JwtFilter：一切的入口

整个鉴权逻辑集中在一个类里：`JwtFilter extends OncePerRequestFilter`。「OncePerRequest」保证一次请求只过一次过滤器，这是 Spring 提供的标准基类。

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/config/JwtFilter.java:35"
  :notes="[
    { lines: '1-5', text: '第一步：拿到请求路径，若命中公共白名单（登录/注册/发验证码/套餐查询等）直接放行，不校验 token。这是为什么未登录也能访问登录接口。' },
    { lines: '7-11', text: '第二步：没有 Authorization 头、或不是 Bearer 开头，直接返回 401。这是最外层的门。' },
    { lines: '13-18', text: '第三步：截取 token（去掉 Bearer 前缀 7 个字符），交给 JwtUtil 校验签名与过期。无效即 401。' },
    { lines: '20-24', text: '第四步：从 token 里解析出 userId 和 role，写入 request attribute。role 为空时兜底为 user。' }
  ]">

```java
String path = request.getRequestURI();
if (isPublicPath(path)) {
    filterChain.doFilter(request, response);
    return;
}

String header = request.getHeader("Authorization");
if (header == null || !header.startsWith("Bearer ")) {
    sendUnauthorized(response, "未登录或 Token 已过期");
    return;
}

String token = header.substring(7);
if (!jwtUtil.isValid(token)) {
    sendUnauthorized(response, "Token 无效或已过期");
    return;
}

Long userId = jwtUtil.getUserId(token);
String role = jwtUtil.getRole(token);
if (role == null || role.isBlank()) {
    role = "user";
}
```

</SourceExplainer>

::: tip 为什么 userId 放进 request attribute
后面所有 Controller 方法只要写 `@RequestAttribute Long userId` 就能直接拿到当前登录用户，不用再解析 token。过滤器在最前面把「你是谁」这件事一次性算好，业务代码专注「做什么」。这是一种典型的关注点分离。
:::

## 从 role 到 authorities：两个前缀

拿到 userId 和 role 之后，`JwtFilter` 会去 `RbacService` 查这个用户拥有的**权限码集合**，然后组装成 Spring Security 的 authorities：

<SourceExplainer
  file="backend/src/main/java/com/aiplatform/backend/config/JwtFilter.java:63"
  :notes="[
    { lines: '1-6', text: '查询该用户的权限码集合。即使查询失败也只是 warn，用空集合兜底——避免 RBAC 表异常导致所有请求 500。' },
    { lines: '8-11', text: '角色本身作为一个 authority，加 ROLE_ 前缀（Spring Security 约定）。super_admin 自动叠加 ROLE_ADMIN，实现超管天然拥有管理员权限。' },
    { lines: '13-15', text: '每个权限码加 PERM_ 前缀，成为独立 authority。于是 Controller 上的 @PreAuthorize（hasAuthority PERM_xxx）就能生效。' },
    { lines: '17-19', text: '把 userId 作为 principal 构建 Authentication，塞进 SecurityContext。至此本请求线程「已登录」。' }
  ]">

```java
Set<String> permissionCodes = Set.of();
try {
    permissionCodes = rbacService.getUserPermissionCodes(userId, role);
} catch (Exception e) {
    log.warn("Failed to load permissions for user {}: {}", userId, e.getMessage());
}

List<SimpleGrantedAuthority> authorities = new ArrayList<>();
String roleUpper = role.toUpperCase();
authorities.add(new SimpleGrantedAuthority("ROLE_" + roleUpper));
if ("SUPER_ADMIN".equals(roleUpper)) {
    authorities.add(new SimpleGrantedAuthority("ROLE_ADMIN"));
}
for (String permCode : permissionCodes) {
    authorities.add(new SimpleGrantedAuthority("PERM_" + permCode));
}

UsernamePasswordAuthenticationToken authentication =
        new UsernamePasswordAuthenticationToken(userId, null, authorities);
SecurityContextHolder.getContext().setAuthentication(authentication);
```

</SourceExplainer>

## RBAC 三层模型

`RbacService` 管理的是经典的 **用户 — 角色 — 权限** 三层关系：

```text
用户 (sys_user)
  └─(多对多)─ 角色 (sys_role)
                └─(多对多)─ 权限 (sys_permission)
```

- 用户挂多个角色（`assignRolesToUser`）
- 角色挂多个权限（`assignPermissionsToRole`）
- 用户的最终权限 = 所有角色权限的并集（`getUserPermissionCodes`）

`RbacService` 里有大量成对的方法重载，一个收 `Long userId`、一个收 `String userIdOrUuid`——这是为了兼容「内部用主键、对外用 uuid」的两套标识体系。

## 两套权限判断：新 RBAC 与 legacy role

留意 `JwtFilter` 调用的是 `getUserPermissionCodes(userId, role)`——它同时传了细粒度 RBAC 需要的 `userId`，也传了老的 `legacyRoleCode`。这说明系统正处在**从「单一 role 字段」向「细粒度 RBAC」迁移的过渡态**：

- 老逻辑：一个 `role` 字段（user / admin / super_admin）粗粒度判断
- 新逻辑：`sys_permission` 表里的权限码，细粒度到每个操作

两者并存，`JwtFilter` 把它们统一成 authorities，让上层 `@PreAuthorize` 不用关心权限到底来自哪套体系。这是一个很实用的渐进式重构策略——**不推倒重来，而是让新老机制在同一个出口汇合**。

## 前端如何拿到自己的权限

后端负责鉴权，前端负责「按权限显示 UI」。回顾 `App.tsx`，登录后会调一次：

```ts
rbacApi.getMyPermissions()
  .then(setPermissions)
  .catch(() => {})
```

把权限码存进 Zustand，前端据此决定「管理入口显不显示」「某个按钮能不能点」。**注意：前端隐藏按钮只是体验优化，真正的安全边界永远在后端的 `JwtFilter` + `@PreAuthorize`。** 前端能绕过，后端不能。

## 小结

- `JwtFilter` 是唯一的鉴权入口，`OncePerRequestFilter` 保证每请求一次。
- token → userId/role → 权限码 → authorities，一条链在业务代码之前算完。
- `ROLE_` 与 `PERM_` 两个前缀，分别承载角色和细粒度权限。
- 新 RBAC 与 legacy role 并存，在过滤器出口统一——渐进式重构的范例。
- 安全边界在后端，前端权限只用于 UI 呈现。

下一篇看 [模型路由](/java/model-routing)，理解请求鉴权之后，「用哪个模型来响应」是怎么智能决策的。
