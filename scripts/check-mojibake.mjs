import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const scanRoots = [
  'app/src',
  'backend/src/main/java',
  'backend/src/main/resources',
  'deploy',
].map(p => path.join(root, p))

const includeExt = new Set(['.ts', '.tsx', '.js', '.jsx', '.java', '.yml', '.yaml', '.properties', '.xml', '.ps1', '.sh'])
const ignoredDirs = new Set(['node_modules', 'dist', 'target', '.git', 'build'])

const mojibakePattern = /[\ufffd]|\u95b3\u5149\u5053|\u95c1|\u9227|\u9239|\u9983|[\u947e\u93c3\u93c7\u5a13\u72bb\u4ebe\u7487\u950b\u7730\u93c9\u51ae\u6aba\u9422\u71b8\u579a\u59af\u2033\u7037\u6d63\u6b13\ue582\u6fb6\u8fab\u89e6\u6769\u65bf\u6d16\u95bf\u6b12\ue1e4]{2,}|[\u9477\u699b\u95ca\u7f08\u7627\u934f\u5d88\u5782\u951b\u93c3\u95c7\u9a9e\u6f4e\u7487\u52eb\u93cd\u89c4\u5d41\u6748\u64b3\u53c6\u9356\u5f52\u53a4\u93b6\u9473\u6d5c\u5b29\u6b22\u9352\u55db\u6ba7\u6d93\u3087\u93cc\u8bf2\u59df\u9418\u6924\u572d\u6d30\u7ee0\u9358\u71b7\u7037\u6dc7\u6fc6\u74e8\u7459\u6395\u58ca\u9352\u6d98\u7f13\u6d93\u9e3f\u578e\u95b0\u95ab\u6c31\u7161\u93c0\u7caf\u95b0\u5d87\u7586\u6fc2\u6945]{2,}|\u7ee0\uff04\u608a\u935b|\u5bb8\u30e4\u7d94\u5a34|\u9366\u70d8\u6ad9|\u9353\u5d86\ue18c|\u59dd\uff45\u6e6a|\u7490\ufe3d\u57db|\u93ad\u3220\ue632|\u5a34\uff46\u7469|\u9420\u6136\u9644|\u95bd\u535e\u5bd8/
const runtimeMarkers = [
  'throw new',
  'new Error(',
  'RuntimeException',
  'Result.fail',
  'toast.',
  'console.warn',
  'console.error',
  'log.warn',
  'log.info',
  'log.error',
  'logSuccess(',
  'logFail(',
  'content:',
  'yield {',
  'setDescription(',
  'setErrorMsg(',
  'setVerifyMsg(',
]

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (includeExt.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

function isNormalizerLine(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('[/') || line.includes('normalizeMojibake') || line.includes('replace(/[\\ufffd]')
    || line.includes('mojibakeScore') || line.includes('suspicious = text.match') || line.includes('.replace(/')
}

function isCommentOnly(line) {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')
}

const runtimeHits = []
const warningHits = []

for (const file of scanRoots.flatMap(dir => walk(dir))) {
  const rel = path.relative(root, file).replaceAll(path.sep, '/')
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach((line, index) => {
    if (!mojibakePattern.test(line) || isNormalizerLine(line)) return
    const hit = `${rel}:${index + 1}: ${line.trim().slice(0, 180)}`
    const isRuntime = runtimeMarkers.some(marker => line.includes(marker)) && !isCommentOnly(line)
    if (isRuntime) runtimeHits.push(hit)
    else warningHits.push(hit)
  })
}

if (warningHits.length) {
  console.error(`[mojibake] comments/non-runtime mojibake found: ${warningHits.length}`)
  const warningsToShow = process.env.MOJIBAKE_SHOW_ALL === '1' ? warningHits : warningHits.slice(0, 30)
  for (const hit of warningsToShow) console.error(`  ${hit}`)
  if (warningHits.length > warningsToShow.length) console.error(`  ... ${warningHits.length - warningsToShow.length} more`)
}

if (runtimeHits.length) {
  console.error(`[mojibake] runtime-facing mojibake found: ${runtimeHits.length}`)
  for (const hit of runtimeHits) console.error(`  ${hit}`)
  process.exit(1)
}

if (warningHits.length) {
  process.exit(1)
}

console.log('[mojibake] source text looks clean')
