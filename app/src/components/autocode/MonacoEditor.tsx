// Monaco 编辑器懒加载封装：首次挂载时完成自托管配置，再渲染 @monaco-editor/react 的 Editor。
// 通过 React.lazy 动态引入本组件，可让 monaco 进入独立 chunk，不拖慢主包。
import Editor, { type OnMount, type OnChange } from '@monaco-editor/react'
import { useEffect, useState } from 'react'
import { setupMonaco } from '@/lib/monaco-setup'

export interface MonacoEditorProps {
  value: string
  language: string
  path?: string
  theme?: string
  readOnly?: boolean
  onChange?: OnChange
  onMount?: OnMount
}

export default function MonacoEditor({ value, language, path, theme = 'vs-dark', readOnly, onChange, onMount }: MonacoEditorProps) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    setupMonaco()
    setReady(true)
  }, [])

  if (!ready) return null

  return (
    <Editor
      value={value}
      language={language}
      path={path}
      theme={theme}
      onChange={onChange}
      onMount={onMount}
      options={{
        readOnly,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        automaticLayout: true,
        tabSize: 2,
        renderWhitespace: 'selection',
        fixedOverflowWidgets: true,
        wordWrap: 'off',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      }}
    />
  )
}
