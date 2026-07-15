import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// 预加载 Shiki 语法高亮引擎（避免首次代码块渲染时延迟）
import { preloadHighlighter } from './hooks/useHighlight'
preloadHighlighter()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
