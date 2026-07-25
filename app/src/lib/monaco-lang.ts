// 纯函数：根据文件路径推断 Monaco 语言 id。
// 单独成文件、不引入 monaco-editor，可安全被主包直接 import，不影响 monaco 懒加载分包。
export function monacoLanguageForPath(path: string): string {
  const name = (path.split('/').pop() || '').toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  const ext = name.includes('.') ? name.split('.').pop() || '' : ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    json: 'json', jsonc: 'json',
    html: 'html', htm: 'html', vue: 'html', svelte: 'html',
    css: 'css', scss: 'scss', less: 'less',
    py: 'python', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust',
    php: 'php', rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    cs: 'csharp', swift: 'swift', sql: 'sql', sh: 'shell', bash: 'shell', ps1: 'powershell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml',
    md: 'markdown', markdown: 'markdown',
    graphql: 'graphql', gql: 'graphql',
  }
  return map[ext] || 'plaintext'
}
