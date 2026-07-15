import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import './custom.css'

// 交互可视化组件 —— 全局注册，任意 markdown 页面可直接使用
import ArchitectureDiagram from './components/ArchitectureDiagram.vue'
import AgenticLoopAnimation from './components/AgenticLoopAnimation.vue'
import SSEStreamDemo from './components/SSEStreamDemo.vue'
import PyodidePlayground from './components/PyodidePlayground.vue'
import SandboxPlayground from './components/SandboxPlayground.vue'
import FlowTimeline from './components/FlowTimeline.vue'
import SourceExplainer from './components/SourceExplainer.vue'

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ArchitectureDiagram', ArchitectureDiagram)
    app.component('AgenticLoopAnimation', AgenticLoopAnimation)
    app.component('SSEStreamDemo', SSEStreamDemo)
    app.component('PyodidePlayground', PyodidePlayground)
    app.component('SandboxPlayground', SandboxPlayground)
    app.component('FlowTimeline', FlowTimeline)
    app.component('SourceExplainer', SourceExplainer)
  },
} satisfies Theme
