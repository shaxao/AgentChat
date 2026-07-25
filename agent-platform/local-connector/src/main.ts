import './style.css'
import '@xterm/xterm/css/xterm.css'
import { AutoCodeIde } from './ide/app'
import { startStartupSplash } from './startup-splash'

const root = document.querySelector<HTMLDivElement>('#app')

if (!root) {
  throw new Error('Missing #app root')
}

const ide = new AutoCodeIde(root)
const splash = startStartupSplash()

const recordStartupError = (reason: unknown) => {
  const message = reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason)
  console.error('[AutoCode] startup/runtime error', reason)
  try {
    localStorage.setItem('autocode.ide.lastStartupError', JSON.stringify({
      at: new Date().toISOString(),
      message,
    }))
  } catch {
    // Ignore localStorage failures during crash reporting.
  }
}

window.addEventListener('error', event => recordStartupError(event.error || event.message))
window.addEventListener('unhandledrejection', event => recordStartupError(event.reason))

void ide.start().catch(error => {
  recordStartupError(error)
}).finally(() => {
  splash.finish()
})
