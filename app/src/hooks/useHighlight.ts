import { useRef, useCallback } from 'react'
import type { HighlighterCore, LanguageInput } from 'shiki/types'

// ─── 类型 ────────────────────────────────────────────────────────────────────

interface HighlightCacheEntry {
  html: string
  timestamp: number
}

// ─── 全局单例（跨组件复用） ─────────────────────────────────────────────────

let _highlighterPromise: Promise<HighlighterCore> | null = null
let _highlighter: HighlighterCore | null = null
let _initError: Error | null = null
let _initRetryTimer: ReturnType<typeof setTimeout> | null = null
const INIT_RETRY_DELAY = 15_000 // 15 秒后允许重试

const CACHE_MAX_SIZE = 300
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 分钟过期

const _cache = new Map<string, HighlightCacheEntry>()

const _languageAliases: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  jsx: 'javascript',
  tsx: 'typescript',
  py: 'python',
  rb: 'text',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  svg: 'xml',        // Shiki v4 不含 svg 语言，映射到 xml
  gitignore: 'shell',
  env: 'shell',
}

const _languageLoaders: Record<string, () => Promise<LanguageInput>> = {
  javascript: () => import('shiki/langs/javascript.mjs').then(m => m.default),
  typescript: () => import('shiki/langs/typescript.mjs').then(m => m.default),
  python: () => import('shiki/langs/python.mjs').then(m => m.default),
  java: () => import('shiki/langs/java.mjs').then(m => m.default),
  go: () => import('shiki/langs/go.mjs').then(m => m.default),
  rust: () => import('shiki/langs/rust.mjs').then(m => m.default),
  c: () => import('shiki/langs/c.mjs').then(m => m.default),
  csharp: () => import('shiki/langs/csharp.mjs').then(m => m.default),
  php: () => import('shiki/langs/php.mjs').then(m => m.default),
  swift: () => import('shiki/langs/swift.mjs').then(m => m.default),
  kotlin: () => import('shiki/langs/kotlin.mjs').then(m => m.default),
  sql: () => import('shiki/langs/sql.mjs').then(m => m.default),
  json: () => import('shiki/langs/json.mjs').then(m => m.default),
  yaml: () => import('shiki/langs/yaml.mjs').then(m => m.default),
  xml: () => import('shiki/langs/xml.mjs').then(m => m.default),
  html: () => import('shiki/langs/html.mjs').then(m => m.default),
  css: () => import('shiki/langs/css.mjs').then(m => m.default),
  scss: () => import('shiki/langs/scss.mjs').then(m => m.default),
  bash: () => import('shiki/langs/bash.mjs').then(m => m.default),
  shell: () => import('shiki/langs/shellscript.mjs').then(m => m.default),
  powershell: () => import('shiki/langs/powershell.mjs').then(m => m.default),
  markdown: () => import('shiki/langs/markdown.mjs').then(m => m.default),
  dockerfile: () => import('shiki/langs/docker.mjs').then(m => m.default),
  graphql: () => import('shiki/langs/graphql.mjs').then(m => m.default),
  nginx: () => import('shiki/langs/nginx.mjs').then(m => m.default),
  toml: () => import('shiki/langs/toml.mjs').then(m => m.default),
  ini: () => import('shiki/langs/ini.mjs').then(m => m.default),
  diff: () => import('shiki/langs/diff.mjs').then(m => m.default),
  vue: () => import('shiki/langs/vue.mjs').then(m => m.default),
  svelte: () => import('shiki/langs/svelte.mjs').then(m => m.default),
  jsx: () => import('shiki/langs/jsx.mjs').then(m => m.default),
  tsx: () => import('shiki/langs/tsx.mjs').then(m => m.default),
}

// ─── 初始化（懒加载） ────────────────────────────────────────────────────────

function _initHighlighter(): Promise<HighlighterCore> {
  if (_highlighter) return Promise.resolve(_highlighter)
  // 失败后 15 秒允许重试（避免永久卡死）
  if (_initError) {
    if (!_initRetryTimer) {
      _initRetryTimer = setTimeout(() => {
        console.log('[useHighlight] Clearing init error, will retry on next call')
        _initError = null
        _initRetryTimer = null
      }, INIT_RETRY_DELAY)
    }
    return Promise.reject(_initError)
  }
  if (_highlighterPromise) return _highlighterPromise

  console.log('[useHighlight] Initializing Shiki (dynamic import)...')
  _highlighterPromise = (async () => {
    try {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, githubDark, githubLight] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
        import('shiki/themes/github-dark.mjs').then(m => m.default),
        import('shiki/themes/github-light.mjs').then(m => m.default),
      ])
      const langs = await Promise.all(Object.values(_languageLoaders).map(loader => loader()))
      console.log('[useHighlight] Shiki module loaded, creating highlighter...')
      _highlighter = await createHighlighterCore({
        themes: [githubDark, githubLight],
        langs,
        engine: createJavaScriptRegexEngine(),
      })
      console.log('[useHighlight] Shiki initialized successfully ✓')
      return _highlighter
    } catch (e) {
      console.error('[useHighlight] Failed to initialize Shiki:', e)
      _initError = e as Error
      _highlighterPromise = null
      throw e
    }
  })()

  return _highlighterPromise
}

// ─── 缓存管理 ────────────────────────────────────────────────────────────────

function _cacheKey(code: string, lang: string): string {
  // 截断长代码 key（1KB 足够区分）
  const codePart = code.length > 1024 ? code.slice(0, 1024) : code
  return `${lang}:${codePart}`
}

function _evictCache(): void {
  if (_cache.size <= CACHE_MAX_SIZE) return
  // 删除最老的条目
  const entries = Array.from(_cache.entries()).sort((a, b) => a[1].timestamp - b[1].timestamp)
  const toDelete = entries.slice(0, entries.length - Math.floor(CACHE_MAX_SIZE * 0.8))
  for (const [key] of toDelete) {
    _cache.delete(key)
  }
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useHighlight() {
  const pendingRef = useRef<Map<string, Promise<string>>>(new Map())

  /**
   * 高亮代码（默认 dark 主题）
   * 返回 HTML 字符串，可直接 dangerouslySetInnerHTML
   */
  const highlight = useCallback(async (code: string, language: string, theme: 'dark' | 'light' = 'dark'): Promise<string> => {
    // 空代码返回空字符串
    if (!code || !code.trim()) return ''

    // 语言别名映射
    const lang = _languageAliases[language] || language

    // 检查缓存
    const key = _cacheKey(code, lang)
    const cached = _cache.get(key)
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.html
    }

    // 去重：同一 key 的并发请求只发一次
    const pending = pendingRef.current.get(key)
    if (pending) return pending

    const promise = (async () => {
      try {
        const highlighter = await _initHighlighter()
        const themeName = theme === 'dark' ? 'github-dark' : 'github-light'
        const html = highlighter.codeToHtml(code, {
          lang,
          theme: themeName,
        })

        // 存入缓存
        _cache.set(key, { html, timestamp: Date.now() })
        _evictCache()

        return html
      } catch (e) {
        // Shiki 无法高亮时回退到纯文本 + language class
        console.warn(`[useHighlight] Failed to highlight ${lang}:`, e)
        const escaped = code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
        return `<pre><code class="language-${lang}">${escaped}</code></pre>`
      } finally {
        pendingRef.current.delete(key)
      }
    })()

    pendingRef.current.set(key, promise)
    return promise
  }, [])

  return { highlight }
}

/**
 * 预加载 Shiki（可在应用启动时调用，避免首次代码块渲染时延迟）
 */
export function preloadHighlighter() {
  if (!_highlighter && !_initError && !_highlighterPromise) {
    console.log('[useHighlight] Preloading Shiki...')
    _initHighlighter().catch(() => {})
  }
}
