import type { EditorTab, WorkspaceEntry } from './types'

export function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

export function normalizeBaseUrl(value: string) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export function displayPath(path: string) {
  return String(path || '')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\')
    .replace(/^\/\/\?\/UNC\//i, '//')
    .replace(/^\\\\\?\\/i, '')
    .replace(/^\/\/\?\//i, '')
}

export function basename(path: string) {
  return displayPath(path).split(/[\\/]/).filter(Boolean).pop() || ''
}

export function projectName(path: string) {
  return basename(path) || '未打开项目'
}

export function compactPath(path: string) {
  path = displayPath(path)
  const parts = String(path || '').split(/[\\/]/).filter(Boolean)
  if (parts.length <= 3) return path || '选择本地目录'
  return `...\\${parts.slice(-3).join('\\')}`
}

export function bytesLabel(size: number) {
  if (!Number.isFinite(size) || size < 0) return '-'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export function formatTime(value: string) {
  if (!value) return '-'
  const date = /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function flattenEntries(entries: WorkspaceEntry[]) {
  const out: WorkspaceEntry[] = []
  const visit = (items: WorkspaceEntry[]) => {
    for (const item of items) {
      out.push(item)
      if (item.children?.length) visit(item.children)
    }
  }
  visit(entries)
  return out
}

export function findEntry(entries: WorkspaceEntry[], path: string): WorkspaceEntry | null {
  for (const item of entries) {
    if (item.path === path) return item
    const found = findEntry(item.children || [], path)
    if (found) return found
  }
  return null
}

export function dirty(tab: EditorTab) {
  return tab.draft !== tab.original
}

export function guessLanguage(path: string) {
  const ext = (path.split('.').pop() || '').toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    mjs: 'javascript',
    cjs: 'javascript',
    rs: 'rust',
    py: 'python',
    java: 'java',
    c: 'cpp',
    cc: 'cpp',
    cpp: 'cpp',
    h: 'cpp',
    hpp: 'cpp',
    css: 'css',
    scss: 'css',
    html: 'html',
    htm: 'html',
    json: 'json',
    md: 'markdown',
    yml: 'yaml',
    yaml: 'yaml',
    xml: 'xml',
    sql: 'sql',
    toml: 'toml',
    vue: 'html',
    svelte: 'html',
  }
  return map[ext] || 'text'
}

export function relativeParent(path: string) {
  const normalized = path.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  parts.pop()
  return parts.join('/')
}

export function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function debounce<T extends (...args: any[]) => void>(fn: T, wait: number) {
  let timer = 0
  return (...args: Parameters<T>) => {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => fn(...args), wait)
  }
}
