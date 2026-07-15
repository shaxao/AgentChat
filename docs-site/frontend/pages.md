# 页面导览

前面几章讲的是前端的"横切能力"（构建、状态、流式渲染、代码执行）。这一章换个视角，带你把 13 个页面快速走一遍，让你知道每个功能大概在哪、由谁负责。

## 入口与视图切换

前端不是传统的多路由 SPA，而是**单壳 + 视图切换**。`app/src/App.tsx` 里用一个 `activeView` 状态在主视图间切换，页面组件全部 `lazy` 懒加载：

<SourceExplainer
  file="app/src/App.tsx"
  :notes="[
    { lines: '1-6', text: '所有页面用 React.lazy 懒加载，配合 Suspense。首屏只加载当前视图的代码，其余按需拉取——这是 vite.config 里 manualChunks 分包策略能生效的前提。' },
    { lines: '8-11', text: 'activeView 决定主内容区渲染哪个页面。adminMode / subscriptionMode 是覆盖层，优先级更高。' }
  ]">

```typescript
const ChatPage = lazy(() => import('@/pages/ChatPage'))
const AutoCodePage = lazy(() => import('@/pages/AutoCodePage'))
const WalletPage = lazy(() => import('@/pages/WalletPage'))
const WorkflowPage = lazy(() => import('@/pages/WorkflowPage'))
// ... 其余页面

const [activeView, setActiveView] = useState<MainView>(getInitialView)
const [adminMode, setAdminMode] = useState(false)
const [subscriptionMode, setSubscriptionMode] = useState(false)
```

</SourceExplainer>

导航由左侧 `IconNavBar`（桌面端）和 `MobileBottomNav`（移动端）驱动，切换 `activeView` 即可。

## 13 个页面速览

| 页面 | 文件 | 职责 | 对应后端 |
|------|------|------|----------|
| 对话 | `ChatPage.tsx` | 核心聊天，SSE 流式、技能、场景、Agent | `/api/chat` |
| AutoCode | `AutoCodePage.tsx` | 自主编程 Agent 控制台，任务/预览/终端 | `/autocode-api` |
| 模型路由 | `ModelRoutingPage.tsx` | 路由规则、熔断器状态可视化 | `/api/admin/routing` |
| 技能商店 | `SkillStoreView` | 技能浏览、安装、对话式编辑 | `/api/skills` |
| 钱包 | `WalletPage.tsx` | 余额、充值、消费流水、提现 | `/api/wallet` |
| 场景广场 | `ScenarioSquarePage.tsx` | 职业场景（SOP）浏览与激活 | `/api/scenarios` |
| 工作流 | `WorkflowPage.tsx` | 节点编辑器（@xyflow）、执行 | `/api/workflow` |
| 工作流模板 | `WorkflowTemplatePage.tsx` | 模板市场 | `/api/workflow/templates` |
| 订阅 | `SubscriptionPage.tsx` | 套餐、订单、支付 | `/api/plans`、`/api/orders` |
| 管理后台 | `AdminPage.tsx` | 用户/渠道/模型/日志管理 | `/api/admin` |
| 记忆时间线 | `MemoryTimelinePage.tsx` | 用户记忆的时间线可视化 | `/api/memory` |
| API 文档 | `ApiDocsPage.tsx` | 对外 OpenAI 兼容 API 文档 | `/v1` |
| 登录 | `LoginPage.tsx` | 登录/注册/OAuth | `/api/auth` |

## 几个值得单独看的页面

### ChatPage — 前端最重的页面

它是流式对话的落点。[流式渲染管线](/frontend/streaming-render) 里讲的 `fetch + getReader + SE 解析`就在这里。它还要协调技能、场景、Agent、文件上传、深度思考等一大堆状态，是全项目最复杂的单页。

### AutoCodePage — 跨系统的枢纽

它连的是 Python AutoCode 后端（`/autocode-api`），还要和 Rust 本地连接器配合建立本地执行会话。[会话代次机制](/connector/session-generation) 那个 bug 的前端修复点就在这个页面约 1937 行的 effect 里。

### WorkflowPage — 可视化编辑器

用 `@xyflow/react`（React Flow）画节点拓扑。[工作流引擎 V2](/java/workflow) 讲的节点执行、SE 进度推送，前端就在这里订阅和渲染。

## 移动端适配

`App.tsx` 里有专门处理移动端键盘的 effect（`useMobileKeyboard`）——聚焦输入框时浏览器会自动滚动页面导致跳动，代码通过监听 `visualViewport` 的 scroll 事件并重置 `scrollY`、配合 `position:fixed` 来抵消。这类细节是"能用"和"好用"之间的距离。

## 相关源码

- `app/src/App.tsx` — 视图切换与懒加载
- `app/src/pages/` — 13 个页面组件
- `app/src/components/layout/` — 导航栏

至此前端区就走完了。接下来可以进入 [Python AutoCode](/autocode/vision) 深入自主编程 Agent，或直接看 [全链路专题](/deep-dive/chat-lifecycle) 把前后端串成一条线。
