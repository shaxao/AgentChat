# Vite 构建体系

前端工程在 `app/`，是一个标准的 React 18 + TypeScript + Vite 项目。这一章带你看懂它的构建配置——尤其是几个和「性能」「部署」直接相关的决定。

## 技术栈一览

| 维度 | 选型 |
|------|------|
| 框架 | React 18 + TypeScript |
| 构建工具 | Vite 5 |
| 样式 | Tailwind CSS 3 + shadcn/ui |
| 状态管理 | Zustand 5 |
| 路由 | 自研视图切换 + react-router-dom（部分页面） |
| Markdown | marked + KaTeX + Shiki |
| 图标 | lucide-react + @lobehub/icons |

入口是 `app/src/main.tsx` → `App.tsx`。`App.tsx` 里所有页面都用 `React.lazy` 懒加载，这是首屏性能的第一道优化。

## 别名与代理

`app/vite.config.ts` 里两块最值得看：**路径别名**和**开发代理**。

<SourceExplainer
  file="app/vite.config.ts"
  :notes="[
    { lines: '1-3', text: '@ 别名指向 src 目录。于是全项目都写 @/store、@/components/ui/button，不用写一长串 ../../.. 相对路径。' },
    { lines: '5-13', text: '开发代理是关键：把不同前缀的请求分别转发到两个后端。这样本地开发时前端直连 localhost，不用配 CORS。' }
  ]">

```ts
resolve: {
  alias: {
    '@': path.resolve(__dirname, './src'),
  },
},
server: {
  proxy: {
    '/api/v1/ledger': { target: 'http://localhost:8080', changeOrigin: true },
    '/api/chat':      { target: 'http://localhost:8080', changeOrigin: true },
    '/api/v1':        { target: 'http://localhost:8080', changeOrigin: true },
    '/api':           { target: 'http://localhost:8000', changeOrigin: true },
    '/tasks':         { target: 'http://localhost:3000', changeOrigin: true },
  },
},
```

</SourceExplainer>

::: warning 代理顺序有讲究
`/api/chat`、`/api/v1` 必须排在通配 `/api` 前面。Vite 代理按声明顺序匹配，更具体的规则要先声明，否则所有 `/api/*` 都会被最后那条 `/api → :8000`（AutoCode）截胡，Java 后端的 chat 接口就转发错地方了。这一点和生产环境 Nginx 里 `/api/` 与 `/autocode-api/` 分开是同一个道理。
:::

## 手动分包（manualChunks）

大型前端最怕「一个 JS 文件几 MB，首屏白屏」。这个项目用 Vite 的 `manualChunks` 把重量级第三方库拆成独立 chunk：

<SourceExplainer
  file="app/vite.config.ts"
  :notes="[
    { lines: '1-2', text: '只对 node_modules 里的依赖分包，业务代码不动。' },
    { lines: '3', text: 'KaTeX（数学公式渲染）单独一个 chunk——它很大，且不是每个页面都用。' },
    { lines: '4', text: 'React 全家桶合并成 vendor-react，长期缓存，版本不变就不用重新下载。' },
    { lines: '5-7', text: '图标、图表、Markdown 各自成包。按需加载，用到哪个下载哪个。' }
  ]">

```ts
manualChunks(id) {
  if (!id.includes('node_modules')) return undefined
  if (id.includes('katex')) return 'vendor-katex'
  if (id.includes('react') || id.includes('react-dom') || id.includes('scheduler')) return 'vendor-react'
  if (id.includes('lucide-react')) return 'vendor-icons'
  if (id.includes('recharts') || id.includes('d3-')) return 'vendor-charts'
  if (id.includes('marked') || id.includes('dompurify')) return 'vendor-markdown'
  return undefined
}
```

</SourceExplainer>

分包的收益：带 hash 的 vendor chunk 可以被浏览器长期缓存（对应 Nginx 里 `expires 1y; immutable`）。你改业务代码时，React/KaTeX 这些包的 hash 不变，用户不用重新下载几 MB 的依赖。

## 构建与部署

```bash
cd app
npm install
npm run build      # tsc 类型检查 + vite build → 产物在 app/dist
```

`package.json` 的 `build` 脚本是 `tsc && vite build`——**先做类型检查，类型不过就不构建**。这保证了上线的代码至少类型是自洽的。

产物 `app/dist` 由 `deploy/deploy.sh` 的 `build_frontend` 构建、rsync 到 Server A 的 `/var/www/muhugochat-frontend/`，由 Nginx 直接服务。本学习站 `/learn/` 就是它的邻居。

## 小结

- `@` 别名 + 分前缀代理，是本地开发顺畅的基础。
- `manualChunks` + 长期缓存，是首屏性能的关键。
- `tsc && vite build`，把类型安全卡在构建这一关。

下一章看 [Zustand 状态管理](/frontend/state)，理解前端怎么在不引入 Redux 那套样板的前提下管住全局状态。
