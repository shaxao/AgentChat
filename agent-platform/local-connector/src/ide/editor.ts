import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { Compartment, EditorState, StateEffect, StateField, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, rectangularSelection, WidgetType } from '@codemirror/view'
import { oneDark } from '@codemirror/theme-one-dark'
import { cpp } from '@codemirror/lang-cpp'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { java } from '@codemirror/lang-java'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { sql } from '@codemirror/lang-sql'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import type { EditorTab } from './types'

const language = new Compartment()

const localWords = [
  'async',
  'await',
  'const',
  'let',
  'function',
  'return',
  'import',
  'export',
  'class',
  'interface',
  'type',
  'try',
  'catch',
  'AutoCode',
  'workspace',
  'task',
  'review',
]

let projectWords: string[] = []

export type AiCompletionContext = {
  path: string
  language: string
  prefix: string
  suffix: string
  linePrefix: string
}

type AiCompletionProvider = (context: AiCompletionContext) => Promise<string>

const setGhostCompletion = StateEffect.define<{ from: number; text: string } | null>()
const setDiffHighlights = StateEffect.define<{ addedLines: number[]; removedNearLines: number[] } | null>()

class GhostCompletionWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-ai-ghost'
    span.textContent = this.text
    return span
  }
}

const ghostCompletionField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setGhostCompletion)) {
        const payload = effect.value
        next = payload?.text
          ? Decoration.set([Decoration.widget({ widget: new GhostCompletionWidget(payload.text), side: 1 }).range(payload.from)])
          : Decoration.none
      }
    }
    if (transaction.docChanged && !transaction.effects.some(effect => effect.is(setGhostCompletion))) {
      next = Decoration.none
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

function buildDiffDecorations(state: EditorState, payload: { addedLines: number[]; removedNearLines: number[] } | null) {
  if (!payload) return Decoration.none
  const decorations: Range<Decoration>[] = []
  const addLine = (lineNo: number, className: string) => {
    if (!Number.isFinite(lineNo) || lineNo < 1 || lineNo > state.doc.lines) return
    decorations.push(Decoration.line({ class: className }).range(state.doc.line(lineNo).from))
  }
  for (const lineNo of payload.addedLines) addLine(lineNo, 'cm-diff-added-line')
  for (const lineNo of payload.removedNearLines) addLine(lineNo, 'cm-diff-removed-near-line')
  return Decoration.set(decorations, true)
}

const diffHighlightField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none
  },
  update(value, transaction) {
    let next = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (effect.is(setDiffHighlights)) next = buildDiffDecorations(transaction.state, effect.value)
    }
    return next
  },
  provide: field => EditorView.decorations.from(field),
})

function completionSource(context: CompletionContext) {
  const word = context.matchBefore(/[\w$.-]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return {
    from: word.from,
    options: [...new Set([...localWords, ...projectWords])]
      .filter(label => label.toLowerCase().includes(word.text.toLowerCase()) || context.explicit)
      .slice(0, 160)
      .map(label => ({
        label,
        type: label.includes('/') ? 'file' : /^[A-Z]/.test(label) ? 'class' : 'keyword',
      })),
  }
}

function languageSupport(tab?: EditorTab | null) {
  const lang = tab?.language || 'text'
  const path = tab?.path || ''
  switch (lang) {
    case 'typescript':
      return javascript({ typescript: true })
    case 'tsx':
      return javascript({ typescript: true, jsx: true })
    case 'javascript':
      return javascript()
    case 'jsx':
      return javascript({ jsx: true })
    case 'json':
      return json()
    case 'python':
      return python()
    case 'rust':
      return rust()
    case 'java':
      return java()
    case 'cpp':
      return cpp()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'markdown':
      return markdown()
    case 'yaml':
      return yaml()
    case 'xml':
      return xml()
    case 'sql':
      return sql()
    default:
      if (path.endsWith('.json')) return json()
      return []
  }
}

export class CodeEditor {
  private view: EditorView | null = null
  private activePath = ''
  private saveHandler: () => void = () => {}
  private changeHandler: (value: string) => void = () => {}
  private activeTab: EditorTab | null = null
  private aiCompletionProvider: AiCompletionProvider | null = null
  private aiCompletionTimer = 0
  private aiCompletionToken = 0
  private ghostCompletion = ''
  private ghostFrom = 0
  private aiCompletionDebounceMs = 750

  mount(parent: HTMLElement, onChange: (value: string) => void, onSave: () => void) {
    this.changeHandler = onChange
    this.saveHandler = onSave
    this.view = new EditorView({
      parent,
      state: EditorState.create({
        doc: '',
        extensions: this.extensions(null),
      }),
    })
  }

  private extensions(tab: EditorTab | null) {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      autocompletion({ override: [completionSource] }),
      language.of(languageSupport(tab)),
      ghostCompletionField,
      diffHighlightField,
      oneDark,
      keymap.of([
        { key: 'Mod-s', run: () => (this.saveHandler(), true) },
        { key: 'Tab', run: () => this.acceptGhostCompletion() },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...searchKeymap,
      ]),
      EditorView.lineWrapping,
      EditorView.updateListener.of(update => {
        if (update.docChanged) this.changeHandler(update.state.doc.toString())
        if (update.docChanged || update.selectionSet) this.scheduleAiCompletion(update.view)
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: 'var(--code-font-size, 13px)' },
        '.cm-scroller': { fontFamily: 'var(--code-font-family, "Cascadia Code", Consolas, monospace)' },
        '.cm-content': { padding: '14px 0' },
        '.cm-gutters': { backgroundColor: '#090d12', color: '#59677a', borderRight: '1px solid #1e2938' },
        '.cm-activeLine': { backgroundColor: 'rgba(77, 132, 255, 0.10)' },
        '.cm-activeLineGutter': { backgroundColor: 'rgba(77, 132, 255, 0.12)' },
      }),
    ]
  }

  setTab(tab: EditorTab | null) {
    if (!this.view) return
    this.activeTab = tab
    const nextPath = tab?.path || ''
    const nextDoc = tab?.draft || ''
    const currentDoc = this.view.state.doc.toString()
    const effects = [language.reconfigure(languageSupport(tab))]
    if (nextPath !== this.activePath || currentDoc !== nextDoc) {
      this.view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: nextDoc },
        effects,
      })
    } else {
      this.view.dispatch({ effects })
    }
    this.activePath = nextPath
    this.clearGhostCompletion()
    if (!tab) this.setDiffHighlights([], [])
  }

  value() {
    return this.view?.state.doc.toString() || ''
  }

  selectionText() {
    if (!this.view) return ''
    const range = this.view.state.selection.main
    return this.view.state.sliceDoc(range.from, range.to)
  }

  setCompletionWords(words: string[]) {
    projectWords = words
  }

  setAiCompletionProvider(provider: AiCompletionProvider | null) {
    this.aiCompletionProvider = provider
  }

  setAiCompletionOptions(options: { debounceMs?: number } = {}) {
    this.aiCompletionDebounceMs = Math.max(250, Math.min(2500, options.debounceMs || 750))
  }

  setDiffHighlights(addedLines: number[], removedNearLines: number[]) {
    this.view?.dispatch({
      effects: setDiffHighlights.of({
        addedLines: addedLines.slice(0, 2000),
        removedNearLines: removedNearLines.slice(0, 2000),
      }),
    })
  }

  private scheduleAiCompletion(view: EditorView) {
    window.clearTimeout(this.aiCompletionTimer)
    this.ghostCompletion = ''
    this.aiCompletionToken += 1
    window.setTimeout(() => this.view?.dispatch({ effects: setGhostCompletion.of(null) }), 0)
    if (!this.aiCompletionProvider || !this.activeTab) return
    const range = view.state.selection.main
    if (!range.empty) return
    const line = view.state.doc.lineAt(range.head)
    const linePrefix = view.state.sliceDoc(line.from, range.head)
    if (!linePrefix.trim() || /[{}\[\];,]\s*$/.test(linePrefix)) return
    const token = ++this.aiCompletionToken
    this.aiCompletionTimer = window.setTimeout(async () => {
      if (!this.view || token !== this.aiCompletionToken || !this.aiCompletionProvider || !this.activeTab) return
      const current = this.view.state.selection.main
      if (!current.empty || current.head !== range.head) return
      const doc = this.view.state.doc
      const prefix = doc.sliceString(Math.max(0, current.head - 5000), current.head)
      const suffix = doc.sliceString(current.head, Math.min(doc.length, current.head + 2000))
      try {
        const text = (await this.aiCompletionProvider({
          path: this.activeTab.path,
          language: this.activeTab.language,
          prefix,
          suffix,
          linePrefix,
        })).trimEnd()
        if (!text || token !== this.aiCompletionToken || !this.view || this.view.state.selection.main.head !== range.head) return
        this.ghostCompletion = text.slice(0, 3000)
        this.ghostFrom = range.head
        this.view.dispatch({ effects: setGhostCompletion.of({ from: range.head, text: this.ghostCompletion }) })
      } catch {
        // Inline completion should never interrupt typing.
      }
    }, this.aiCompletionDebounceMs)
  }

  private acceptGhostCompletion() {
    if (!this.view || !this.ghostCompletion) return false
    const from = this.ghostFrom || this.view.state.selection.main.head
    this.view.dispatch({
      changes: { from, to: from, insert: this.ghostCompletion },
      selection: { anchor: from + this.ghostCompletion.length },
      effects: setGhostCompletion.of(null),
    })
    this.ghostCompletion = ''
    return true
  }

  private clearGhostCompletion() {
    window.clearTimeout(this.aiCompletionTimer)
    this.ghostCompletion = ''
    this.aiCompletionToken += 1
    this.view?.dispatch({ effects: setGhostCompletion.of(null) })
  }

  focus() {
    this.view?.focus()
  }

  revealLine(line: number, character = 0) {
    if (!this.view) return
    const targetLine = this.view.state.doc.line(Math.min(Math.max(1, line || 1), this.view.state.doc.lines))
    const position = Math.min(targetLine.to, targetLine.from + Math.max(0, character || 0))
    this.view.dispatch({
      selection: { anchor: position },
      effects: EditorView.scrollIntoView(position, { y: 'center' }),
    })
    this.view.focus()
  }

  destroy() {
    this.view?.destroy()
    this.view = null
  }
}
