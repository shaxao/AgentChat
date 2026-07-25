import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XtermTerminal } from '@xterm/xterm'

export class TerminalPanel {
  private terminal: XtermTerminal | null = null
  private fitAddon: FitAddon | null = null
  private inputHandler: (data: string) => void = () => {}
  private resizeHandler: (cols: number, rows: number) => void = () => {}

  private themeFor(light: boolean) {
    return light
      ? {
          background: '#f7f9fc',
          foreground: '#263445',
          cursor: '#16836a',
          selectionBackground: '#c9ddf5',
          black: '#334155',
          blue: '#2563a8',
          cyan: '#0f766e',
          green: '#16834f',
          red: '#b42335',
          yellow: '#a16207',
        }
      : {
          background: '#070a0e',
          foreground: '#d9e5f2',
          cursor: '#73d6b8',
          selectionBackground: '#26415f',
          black: '#0b1118',
          blue: '#6ba7ff',
          cyan: '#73d6b8',
          green: '#5ede98',
          red: '#ff6b76',
          yellow: '#f1c460',
        }
  }

  mount(parent: HTMLElement, onInput: (data: string) => void, onResize: (cols: number, rows: number) => void) {
    this.inputHandler = onInput
    this.resizeHandler = onResize
    this.fitAddon = new FitAddon()
    parent.tabIndex = 0
    this.terminal = new XtermTerminal({
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"Cascadia Code", Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 12000,
      windowsMode: true,
      theme: this.themeFor(false),
    })
    this.terminal.loadAddon(this.fitAddon)
    this.terminal.open(parent)
    this.terminal.onData(data => this.inputHandler(data))
    this.terminal.onResize(size => this.resizeHandler(size.cols, size.rows))
    this.terminal.attachCustomKeyEventHandler(event => {
      if (event.type !== 'keydown') return true
      if (event.ctrlKey && event.shiftKey && event.code === 'KeyC' && !event.altKey) {
        void this.copySelection()
        return false
      }
      if (event.ctrlKey && event.code === 'KeyC' && !event.shiftKey && !event.altKey) {
        const selected = this.terminal?.getSelection() || ''
        if (selected) void this.copySelection()
        else this.inputHandler('\u0003')
        return false
      }
      if ((event.ctrlKey && event.code === 'KeyV' && !event.altKey) || (event.shiftKey && event.code === 'Insert')) {
        void this.pasteFromClipboard()
        return false
      }
      return true
    })
    parent.addEventListener('contextmenu', event => {
      event.preventDefault()
      void this.pasteFromClipboard()
    })
    const focusTerminal = () => {
      parent.focus({ preventScroll: true })
      this.focus()
    }
    parent.addEventListener('keydown', event => this.handleHostKeydown(parent, event))
    parent.addEventListener('pointerdown', () => window.setTimeout(focusTerminal, 0))
    parent.addEventListener('click', focusTerminal)
    parent.addEventListener('focus', () => this.focus())
    this.fit()
    window.setTimeout(() => this.focus(), 20)
  }

  setTheme(theme: 'dark' | 'light') {
    if (!this.terminal) return
    this.terminal.options.theme = this.themeFor(theme === 'light')
  }

  setAppearance(options: { fontFamily?: string; fontSize?: number }) {
    if (!this.terminal) return
    if (options.fontFamily?.trim()) this.terminal.options.fontFamily = options.fontFamily
    if (Number.isFinite(options.fontSize)) this.terminal.options.fontSize = Math.max(10, Math.min(20, Math.round(options.fontSize || 12)))
    this.fit()
  }

  async copySelection() {
    const text = this.terminal?.getSelection() || ''
    if (text) await navigator.clipboard.writeText(text)
  }

  getSelection() {
    return this.terminal?.getSelection() || ''
  }

  async pasteFromClipboard() {
    const text = await navigator.clipboard.readText().catch(() => '')
    if (text) this.inputHandler(text)
  }

  fit() {
    window.setTimeout(() => {
      this.fitAddon?.fit()
      if (this.terminal) this.resizeHandler(this.terminal.cols, this.terminal.rows)
    }, 0)
  }

  write(text: string) {
    this.terminal?.write(text)
  }

  writeln(text: string) {
    this.write(`${text}\r\n`)
  }

  clear() {
    this.terminal?.clear()
  }

  focus() {
    this.terminal?.focus()
  }

  private handleHostKeydown(parent: HTMLElement, event: KeyboardEvent) {
    if (document.activeElement !== parent) return
    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase()
      if (key === 'c') {
        event.preventDefault()
        const selected = this.terminal?.getSelection() || ''
        if (selected) void this.copySelection()
        else this.inputHandler('\u0003')
      } else if (key === 'v') {
        event.preventDefault()
        void this.pasteFromClipboard()
      }
      return
    }
    const sequences: Record<string, string> = {
      Enter: '\r',
      Backspace: '\u007f',
      Tab: '\t',
      ArrowUp: '\u001b[A',
      ArrowDown: '\u001b[B',
      ArrowRight: '\u001b[C',
      ArrowLeft: '\u001b[D',
      Home: '\u001b[H',
      End: '\u001b[F',
      Delete: '\u001b[3~',
      Escape: '\u001b',
    }
    const data = sequences[event.key] || (event.key.length === 1 ? event.key : '')
    if (!data) return
    event.preventDefault()
    this.inputHandler(data)
  }
}
