# Zustand 状态管理

这个前端没有用 Redux，而是选了 **Zustand**——一个极简的状态管理库。这一章讲它怎么用几十行代码管住「登录态、主题、对话列表」这些全局状态，以及一个容易被忽视的设计：**流式消息为什么不放进 store 的 action 里做**。

## 为什么是 Zustand

Redux 的心智负担在于 action / reducer / dispatch / connect 那一整套样板。Zustand 把它压缩成一句话：**`create` 一个 store，里面既有 state 也有改 state 的方法，组件用 hook 直接读。**

store 全部集中在 `app/src/store/index.ts`，分了几个独立 store：`useAuthStore`（登录）、`useThemeStore`（主题）、`useChatStore`（对话）、以及 admin 相关的状态。

## 登录态：persist 中间件

登录信息要跨刷新保留，否则一刷新就退出登录。Zustand 的 `persist` 中间件把 store 自动同步到 localStorage：

<SourceExplainer
  file="app/src/store/index.ts"
  :notes="[
    { lines: '1', text: 'persist 包裹整个 store 定义，第二个参数 name 是 localStorage 的键名。' },
    { lines: '3-6', text: '初始状态：未登录、无 token、权限为空。' },
    { lines: '7', text: 'login 一次性写入 user + token + isAuthenticated，组件只要调这一个方法。' },
    { lines: '8', text: 'logout 把所有字段清空，包括权限列表——这很重要，避免退出后残留旧权限。' },
    { lines: '11', text: 'name: auth-store 就是 localStorage 里那一条的键。刷新后 persist 自动回填。' }
  ]">

```ts
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      permissions: [],
      login: (user, token) => set({ user, token: token || null, isAuthenticated: true }),
      logout: () => set({ user: null, token: null, isAuthenticated: false, permissions: [] }),
      updateUser: (updates) => set((state) => ({ user: state.user ? { ...state.user, ...updates } : null })),
      setPermissions: (permissions) => set({ permissions }),
    }),
    { name: 'auth-store' }
  )
)
```

</SourceExplainer>

组件里用起来就一行：`const { user, isAuthenticated, login } = useAuthStore()`。这也是 `App.tsx` 顶部判断「显示登录页还是主界面」的依据。

## 对话状态：乐观更新

`useChatStore` 管对话列表、消息、当前选中模型等。这里有个关键设计——**`sendMessage` 这个 action 只做乐观更新，不做真正的网络流式**：

<SourceExplainer
  file="app/src/store/index.ts"
  :notes="[
    { lines: '2-3', text: '注释写得很清楚：真正的流式收发在 ChatPage 里用 fetch + ReadableStream 处理，store 只负责乐观更新和状态维护。' },
    { lines: '9-14', text: '立即插入一条用户消息到列表——不等网络返回，界面先动起来。这就是乐观更新。' }
  ]">

```ts
sendMessage: async (content, model, opts) => {
  // 说明：真正的流式收发在 ChatPage/MessageList 中通过 fetch + ReadableStream 处理，
  // 这里的 store action 仅负责乐观更新消息列表与状态维护。
  const conversationId = get().activeConversationId
  if (!conversationId) return
  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content,
    timestamp: new Date().toISOString(),
  }
  get().addMessage(conversationId, userMessage)
},
```

</SourceExplainer>

::: tip 为什么流式不放进 store
流式响应是一个持续几秒到几分钟的过程，中间要不断把 token 追加到某条消息上。如果把这个循环塞进 store action，会让 store 变得很重、很难测试，还容易和组件的生命周期打架（组件卸载了流还在跑）。

把「读流 + 逐字追加」留在 ChatPage 组件里，store 只提供 `updateMessage` 这样的原子操作，是一种干净的职责划分：**store 管数据的形状，组件管数据的流动。**
:::

## Message 接口：藏着产品的演进史

`Message` 接口的字段能看出这个产品走过的路——除了常规的 `role` / `content` / `timestamp`，还有一批「动态干预」相关的字段：

| 字段 | 含义 |
|------|------|
| `isStreaming` | 这条消息还在流式生成中 |
| `thinkingContent` | 深度思考（reasoning）内容，单独渲染 |
| `preempted` | 被抢占中断——用户发了方向不同的新消息 |
| `splitPoint` | 抢占时的分割点（有效输出的字符长度） |
| `discardedContent` | 被废弃的内容，UI 以灰色/删除线显示 |
| `toolCalls` | Agent 模式下的工具调用记录 |
| `autocode` | 嵌入式 AutoCode 任务卡片（taskId / 预览地址） |

这些字段告诉你：这不是一个「一问一答」的玩具聊天框，而是支持思考流、工具调用、任务嵌入、甚至「说到一半改主意打断它」的复杂交互。

## 小结

- Zustand + persist：登录/主题这类需要持久化的全局状态，几十行搞定。
- 乐观更新：界面先动，网络后到，体验更跟手。
- 流式留在组件、store 只管数据形状：一条容易被忽视但很关键的职责边界。

下一章 [流式渲染管线](/frontend/streaming-render)，我们就去看 ChatPage 里那个「读流 + 逐字追加 + Markdown 实时渲染」的完整循环。
