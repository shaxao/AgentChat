import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XtermTerminal } from '@xterm/xterm'

export class TerminalPanel {
  private terminal: XtermTerminal | null = null
  private fitAddon: FitAddon | null = null
  private inputHandler: (data: string) => void = () => {}
  private resizeHandler: (cols: number, rows: number) => void = () => {}

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
      theme: {
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
      },
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
    parent.addEventListener('pointerdown', () => window.setTimeout(() => this.focus(), 0))
    parent.addEventListener('click', () => this.focus())
    parent.addEventListener('focus', () => this.focus())
    this.fit()
    window.setTimeout(() => this.focus(), 20)
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
}
