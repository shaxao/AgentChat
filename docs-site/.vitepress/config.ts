import { defineConfig } from 'vitepress'

// WorkBuddy learning docs site. It is deployed under the main frontend at /learn/.
export default defineConfig({
  base: '/learn/',
  lang: 'zh-CN',
  title: 'WorkBuddy 学习手册',
  description: '带你深入源码理解 Java 主系统、Python AutoCode 和 Rust 本地连接器。',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: true,

  head: [
    ['meta', { name: 'theme-color', content: '#3b82f6' }],
    ['meta', { name: 'viewport', content: 'width=device-width, initial-scale=1.0' }],
  ],

  markdown: {
    lineNumbers: true,
    theme: {
      light: 'github-light',
      dark: 'github-dark',
    },
  },

  themeConfig: {
    outline: {
      level: [2, 3],
      label: '本页目录',
    },
    docFooter: {
      prev: '上一篇',
      next: '下一篇',
    },
    lastUpdatedText: '最后更新',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '菜单',
    returnToTopLabel: '返回顶部',

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            noResultsText: '无法找到相关结果',
            resetButtonTitle: '清除查询条件',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    nav: [
      { text: '开始', link: '/guide/overview' },
      { text: 'Java 主系统', link: '/java/architecture' },
      { text: 'React 前端', link: '/frontend/build' },
      { text: 'AutoCode', link: '/autocode/vision' },
      { text: 'Rust 连接器', link: '/connector/why' },
      { text: '全链路专题', link: '/deep-dive/chat-lifecycle' },
    ],

    sidebar: {
      '/guide/': [
        {
          text: '项目全景',
          collapsed: false,
          items: [
            { text: '这是什么项目', link: '/guide/overview' },
            { text: '三系统整体架构', link: '/guide/architecture' },
            { text: '技术栈全景', link: '/guide/tech-stack' },
            { text: '本地启动指南', link: '/guide/getting-started' },
            { text: '如何阅读本手册', link: '/guide/how-to-read' },
          ],
        },
      ],
      '/java/': [
        {
          text: 'Java 主系统',
          collapsed: false,
          items: [
            { text: '分层架构总览', link: '/java/architecture' },
            { text: 'JWT + RBAC 权限', link: '/java/auth-rbac' },
            { text: 'SSE 流式对话', link: '/java/sse-chat' },
            { text: 'Provider 架构', link: '/java/provider' },
            { text: '模型路由', link: '/java/model-routing' },
            { text: 'CacheLedger 计费桥接', link: '/java/cache-ledger' },
            { text: '记忆五层模型', link: '/java/memory' },
            { text: '技能系统', link: '/java/skills' },
            { text: '工作流引擎 V2', link: '/java/workflow' },
            { text: '钱包与订阅', link: '/java/wallet' },
            { text: 'Harness 进化引擎', link: '/java/harness' },
          ],
        },
      ],
      '/frontend/': [
        {
          text: 'React 前端',
          collapsed: false,
          items: [
            { text: 'Vite 构建体系', link: '/frontend/build' },
            { text: 'Zustand 状态管理', link: '/frontend/state' },
            { text: '流式渲染管线', link: '/frontend/streaming-render' },
            { text: 'shadcn 组件体系', link: '/frontend/components' },
            { text: '代码执行预览', link: '/frontend/code-preview' },
            { text: '页面导航', link: '/frontend/pages' },
          ],
        },
      ],
      '/autocode/': [
        {
          text: 'Python AutoCode',
          collapsed: false,
          items: [
            { text: '愿景与定位', link: '/autocode/vision' },
            { text: 'Agentic Loop', link: '/autocode/agentic-loop' },
            { text: 'SystemContext Epoch', link: '/autocode/system-context' },
            { text: 'Tool Registry', link: '/autocode/tool-registry' },
            { text: 'Permission Engine', link: '/autocode/permission-engine' },
            { text: 'Docker 隔离执行', link: '/autocode/docker-isolation' },
            { text: 'Git Manager', link: '/autocode/git-manager' },
            { text: '编排器', link: '/autocode/orchestrator' },
            { text: 'Local Runner', link: '/autocode/local-runner' },
            { text: 'Review Agent', link: '/autocode/review-agent' },
          ],
        },
      ],
      '/connector/': [
        {
          text: 'Rust 本地连接器',
          collapsed: false,
          items: [
            { text: '为什么需要连接器', link: '/connector/why' },
            { text: '会话代次机制', link: '/connector/session-generation' },
            { text: 'Tauri 架构', link: '/connector/tauri' },
          ],
        },
      ],
      '/deep-dive/': [
        {
          text: '全链路专题',
          collapsed: false,
          items: [
            { text: '一次对话的一生', link: '/deep-dive/chat-lifecycle' },
            { text: '一次 AutoCode 任务', link: '/deep-dive/autocode-task' },
            { text: '一次计费的流转', link: '/deep-dive/billing-flow' },
          ],
        },
      ],
    },

    socialLinks: [],
  },
})
