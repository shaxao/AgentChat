// Monaco 自托管配置：把 @monaco-editor/react 的 loader 指向本地 monaco-editor 包，
// 并通过 Vite 的 ?worker 导入本地打包 worker，完全离线，不走 CDN。
import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'

import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

let configured = false

/** 幂等初始化，仅在首次挂载编辑器面板时调用。 */
export function setupMonaco() {
  if (configured) return
  configured = true

  // Monaco 通过全局 MonacoEnvironment 决定为每种语言加载哪个 worker。
  ;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_moduleId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker()
        case 'typescript':
        case 'javascript':
          return new tsWorker()
        default:
          return new editorWorker()
      }
    },
  }

  // 让 loader 使用打包进产物的本地 monaco，而非默认从 CDN 拉取。
  loader.config({ monaco })
}

// 语言推断为纯函数，单独放在 monaco-lang.ts（不引入 monaco），此处转出以兼容旧引用。
export { monacoLanguageForPath } from './monaco-lang'
