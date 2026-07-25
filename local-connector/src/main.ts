import './style.css'
import '@xterm/xterm/css/xterm.css'
import { AutoCodeIde } from './ide/app'

const root = document.querySelector<HTMLDivElement>('#app')

if (!root) {
  throw new Error('Missing #app root')
}

const ide = new AutoCodeIde(root)
void ide.start()
