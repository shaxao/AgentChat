import katex from 'katex'
import 'katex/dist/katex.min.css'

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function renderMath(latex: string, displayMode: boolean) {
  const content = latex.trim()
  if (!content) return ''

  try {
    const html = katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'htmlAndMathml',
    })
    return `<span class="${displayMode ? 'math-block' : 'math-inline'}">${html}</span>`
  } catch {
    return `<code>${escapeHtml(latex)}</code>`
  }
}

function protectInlineCode(source: string) {
  const codeParts: string[] = []
  const protectedSource = source.replace(/(`+)([\s\S]*?)\1/g, (match) => {
    const index = codeParts.length
    codeParts.push(match)
    return `@@INLINE_CODE_${index}@@`
  })
  return { protectedSource, codeParts }
}

function restoreInlineCode(source: string, codeParts: string[]) {
  return source.replace(/@@INLINE_CODE_(\d+)@@/g, (_match, index) => codeParts[Number(index)] || '')
}

function renderDollarInline(source: string) {
  return source.replace(/(^|[^\\\w$])\$([^\n$]{1,800}?)\$(?![\w$])/g, (match, prefix, latex) => {
    const trimmed = latex.trim()
    if (!trimmed || /^\d[\d,.]*$/.test(trimmed)) return match
    if (/^\s|\s$/.test(latex)) return match
    return `${prefix}${renderMath(trimmed, false)}`
  })
}

export function renderMathInMarkdownSource(source: string) {
  if (!source || !/[\\$]/.test(source)) return source

  const { protectedSource, codeParts } = protectInlineCode(source)
  let next = protectedSource
    .replace(/\$\$([\s\S]+?)\$\$/g, (_match, latex) => renderMath(latex, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_match, latex) => renderMath(latex, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_match, latex) => renderMath(latex, false))

  next = renderDollarInline(next)
  return restoreInlineCode(next, codeParts)
}
