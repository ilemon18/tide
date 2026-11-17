import { StateField, type Range, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { currentLocale, t } from '../i18n'
import { hasLocaleEffect, localeEffect, watchLocale } from './locale'

/**
 * In-place fix for Git conflict markers (VSCode style): the three sections are tinted and the block end gets
 * "accept current / incoming / both". Accepting is a plain text replacement (undoable, autosaved). Mounted only
 * when git reports the file unmerged, so plain files with marker-like text are not mistaken for conflicts.
 */

const START = /^(<{7,})(?:[ \t](.*))?\r?$/
const BASE = /^(\|{7,})(?:[ \t](.*))?\r?$/
const SEPARATOR = /^(={7,})\r?$/
const END = /^(>{7,})(?:[ \t](.*))?\r?$/

const MAX_LAYOUT_LINES = 20000
const MAX_REPARSE_CHARS = 2_000_000
/** Above this many lines a conflict gets block actions only: one widget per line would cost too much */
const MAX_LINE_ACTION_LINES = 2000

export type ConflictAction = 'ours' | 'theirs' | 'both'
export type ConflictLineSide = 'ours' | 'theirs'

export type ConflictBlock = {
  /** Start of the opening marker line .. end of the closing marker line */
  from: number
  to: number
  startLine: number
  endLine: number
  /** 0 means no diff3 base section */
  baseLine: number
  sepLine: number
  /** Character ranges of the three sections (marker lines excluded) */
  oursFrom: number
  oursTo: number
  baseFrom: number
  baseTo: number
  theirsFrom: number
  theirsTo: number
  oursLabel: string
  theirsLabel: string
  depth: number
}

type Pending = {
  startLine: number
  size: number
  oursLabel: string
  baseLine: number
  sepLine: number
}

/** Whether the content may hold conflict markers (cheap pre-check) */
export function looksLikeConflict(text: string): boolean {
  return /^<{7,}/m.test(text) && /^={7,}/m.test(text) && /^>{7,}/m.test(text)
}

/** Scan the whole document for conflict blocks: handles diff3 (||||||| base), nested conflicts (stack), CRLF and marker lines of 7+ chars. */
export function parseConflicts(doc: Text): ConflictBlock[] {
  if (doc.lines > MAX_LAYOUT_LINES) return []
  const out: ConflictBlock[] = []
  const stack: Pending[] = []

  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n)
    const text = line.text

    const start = START.exec(text)
    if (start) {
      stack.push({
        startLine: n,
        size: start[1].length,
        oursLabel: (start[2] ?? '').trim() || t('editor.oursLabel'),
        baseLine: 0,
        sepLine: 0,
      })
      continue
    }

    const top = stack[stack.length - 1]
    if (!top) continue

    const base = BASE.exec(text)
    if (base && base[1].length === top.size && !top.sepLine && !top.baseLine) {
      top.baseLine = n
      continue
    }

    const sep = SEPARATOR.exec(text)
    if (sep && sep[1].length === top.size && !top.sepLine) {
      top.sepLine = n
      continue
    }

    const end = END.exec(text)
    if (end && end[1].length === top.size && top.sepLine > top.startLine) {
      stack.pop()
      const startLine = doc.line(top.startLine)
      const sepLine = doc.line(top.sepLine)
      const endLine = line
      const baseLineNo =
        top.baseLine > top.startLine && top.baseLine < top.sepLine ? top.baseLine : 0
      const baseLine = baseLineNo ? doc.line(baseLineNo) : null

      // Section bounds always use the next line's start: with CRLF, line.to + 1 lands after the \n
      // and pulls the line's \r into the content
      const nextLineFrom = (line: number, limit: number) =>
        line < limit ? doc.line(line + 1).from : doc.line(limit).from
      const oursFrom = nextLineFrom(top.startLine, top.sepLine)
      // With diff3 the current side ends at the base marker, the base section is not ours
      const oursTo = baseLine ? baseLine.from : sepLine.from
      const baseFrom = baseLineNo ? nextLineFrom(baseLineNo, top.sepLine) : -1
      const theirsFrom = nextLineFrom(top.sepLine, n)

      out.push({
        from: startLine.from,
        to: endLine.to,
        startLine: top.startLine,
        endLine: n,
        baseLine: baseLineNo,
        sepLine: top.sepLine,
        oursFrom: Math.min(oursFrom, oursTo),
        oursTo,
        baseFrom: baseFrom < 0 ? -1 : Math.min(baseFrom, sepLine.from),
        baseTo: baseFrom < 0 ? -1 : sepLine.from,
        theirsFrom: Math.min(theirsFrom, endLine.from),
        theirsTo: endLine.from,
        oursLabel: top.oursLabel,
        theirsLabel: (end[2] ?? '').trim(),
        depth: stack.length,
      })
    }
  }

  return out
}

export const conflictField = StateField.define<ConflictBlock[]>({
  create: (state) => parseConflicts(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value
    // Conflicted files are usually small; this only guards against huge ones
    if (tr.state.doc.length > MAX_REPARSE_CHARS) return []
    return parseConflicts(tr.state.doc)
  },
})

function lineClass(block: ConflictBlock, line: number): string | null {
  if (line === block.startLine) return 'cm-conflict-marker cm-conflict-start'
  if (line === block.sepLine) return 'cm-conflict-marker cm-conflict-sep'
  if (line === block.endLine) return 'cm-conflict-marker cm-conflict-end'
  if (block.baseLine && line === block.baseLine) {
    return 'cm-conflict-marker cm-conflict-base-marker'
  }
  if (line > block.startLine && line < (block.baseLine || block.sepLine)) {
    return 'cm-conflict-ours'
  }
  if (block.baseLine && line > block.baseLine && line < block.sepLine) {
    return 'cm-conflict-base'
  }
  if (line > block.sepLine && line < block.endLine) return 'cm-conflict-theirs'
  return null
}

class ConflictActionsWidget extends WidgetType {
  constructor(
    readonly startPos: number,
    readonly oursLabel: string,
    readonly theirsLabel: string,
    /** This outer conflict still contains unresolved inner ones: never overwrite blindly */
    readonly nested: boolean,
    readonly locale: string,
  ) {
    super()
  }

  eq(other: ConflictActionsWidget) {
    return (
      other.startPos === this.startPos &&
      other.oursLabel === this.oursLabel &&
      other.theirsLabel === this.theirsLabel &&
      other.nested === this.nested &&
      other.locale === this.locale
    )
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-conflict-lens'

    if (this.nested) {
      const hint = document.createElement('span')
      hint.className = 'cm-conflict-hint'
      hint.textContent = t('editor.nestedConflictHint')
      wrap.append(hint)
      return wrap
    }

    const button = (label: string, action: ConflictAction) => {
      const el = document.createElement('button')
      el.type = 'button'
      el.className = 'cm-conflict-btn'
      el.textContent = label
      const side =
        action === 'both'
          ? `${this.oursLabel} + ${this.theirsLabel}`
          : action === 'ours'
            ? this.oursLabel
            : this.theirsLabel
      el.title = `${label} · ${side}`
      // mousedown instead of click: the editor would otherwise handle the event first and move the cursor
      el.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        resolveConflict(view, this.startPos, action)
      })
      return el
    }

    const actions = document.createElement('span')
    actions.className = 'cm-conflict-lens-actions'
    actions.append(
      button(t('editor.acceptOurs'), 'ours'),
      button(t('editor.acceptTheirs'), 'theirs'),
      button(t('editor.acceptBoth'), 'both'),
    )
    wrap.append(actions)

    if (this.theirsLabel) {
      const tag = document.createElement('span')
      tag.className = 'cm-conflict-hint'
      tag.textContent = this.theirsLabel
      wrap.append(tag)
    }
    return wrap
  }

  /** The buttons handle their own events; CodeMirror must not process them again */
  ignoreEvent() {
    return true
  }

  get estimatedHeight() {
    return 24
  }
}

/** One hover action at the end of a current / incoming line: take only this line out of the conflict */
class ConflictLineActionWidget extends WidgetType {
  constructor(
    readonly startPos: number,
    readonly lineNumber: number,
    readonly side: ConflictLineSide,
    readonly locale: string,
  ) {
    super()
  }

  eq(other: ConflictLineActionWidget) {
    return (
      other.startPos === this.startPos &&
      other.lineNumber === this.lineNumber &&
      other.side === this.side &&
      other.locale === this.locale
    )
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-conflict-line-actions'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-conflict-line-btn'
    button.textContent =
      this.side === 'ours' ? t('editor.acceptCurrentLine') : t('editor.acceptIncomingLine')
    button.title = t('editor.acceptLineAt', { line: this.lineNumber })
    // mousedown instead of click: the editor would otherwise handle the event first and move the cursor
    button.addEventListener('mousedown', (event) => {
      event.preventDefault()
      event.stopPropagation()
      acceptConflictLine(view, this.startPos, this.lineNumber)
    })
    wrap.append(button)
    return wrap
  }

  ignoreEvent() {
    return true
  }
}

function build(view: EditorView): DecorationSet {
  const blocks = view.state.field(conflictField, false)
  if (!blocks || blocks.length === 0) return Decoration.none

  const doc = view.state.doc
  const locale = currentLocale()
  const ranges: Range<Decoration>[] = []
  const seen = new Set<number>()

  for (const block of blocks) {
    for (let n = block.startLine; n <= block.endLine; n += 1) {
      // With nesting the outer block claims these lines first, inner ones only add their buttons
      if (seen.has(n)) continue
      seen.add(n)
      const cls = lineClass(block, n)
      if (!cls) continue
      const line = doc.line(n)
      ranges.push(Decoration.line({ class: cls }).range(line.from))
    }

    const nested = blocks.some(
      (other) => other !== block && other.from > block.from && other.to <= block.to,
    )
    ranges.push(
      Decoration.widget({
        widget: new ConflictActionsWidget(
          block.from,
          block.oursLabel,
          block.theirsLabel,
          nested,
          locale,
        ),
        block: true,
        side: -1,
      }).range(doc.line(block.startLine).from),
    )

    // Per-line actions are deliberately off for outer nested blocks: a line there may be part of an
    // inner conflict, and pulling it out would corrupt that block's markers.
    if (!nested && block.endLine - block.startLine + 1 <= MAX_LINE_ACTION_LINES) {
      const sep = block.baseLine || block.sepLine
      for (let n = block.startLine + 1; n < block.endLine; n += 1) {
        if (n === block.baseLine || n === block.sepLine) continue
        const side: ConflictLineSide | null = n < sep ? 'ours' : n > block.sepLine ? 'theirs' : null
        if (!side) continue
        const line = doc.line(n)
        ranges.push(
          Decoration.widget({
            widget: new ConflictLineActionWidget(block.from, n, side, locale),
            side: 1,
          }).range(line.to),
        )
      }
    }
  }

  // Nesting does not guarantee ascending insert order, let Decoration.set sort
  return Decoration.set(ranges, true)
}

const conflictPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private unwatch: () => void
    constructor(view: EditorView) {
      this.decorations = build(view)
      // Locale switch: rebuild the button labels instead of waiting for the next doc change
      this.unwatch = watchLocale(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || hasLocaleEffect(update)) {
        this.decorations = build(update.view)
      }
    }
    destroy() {
      this.unwatch()
    }
  },
  { decorations: (v) => v.decorations },
)

export const conflictExtension = [conflictField, conflictPlugin]

/** Conflict overview on the editor's right: one proportional region per conflict block; click to jump. */
class ConflictRuler {
  dom: HTMLElement
  private view: EditorView
  private marks = new Map<number, HTMLElement>()
  private unwatch: () => void

  constructor(view: EditorView) {
    this.view = view
    this.dom = document.createElement('div')
    this.dom.className = 'cm-conflict-ruler'
    view.dom.appendChild(this.dom)
    this.unwatch = watchLocale(view)
    this.rebuild()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || hasLocaleEffect(update)) this.rebuild()
  }

  private rebuild() {
    const blocks = this.view.state.field(conflictField, false) ?? []
    const lines = this.view.state.doc.lines
    this.dom.style.display = blocks.length > 0 ? '' : 'none'
    const seen = new Set<number>()
    for (const block of blocks) {
      if (seen.has(block.from)) continue
      seen.add(block.from)
      let mark = this.marks.get(block.from)
      if (!mark) {
        mark = document.createElement('div')
        mark.className = 'cm-conflict-ruler-mark'
        mark.title = t('editor.conflictRange', {
          from: block.startLine,
          to: block.endLine,
        })
        mark.addEventListener('mousedown', (event) => {
          event.preventDefault()
          event.stopPropagation()
          const current = this.view.state.field(conflictField, false) ?? []
          const target = current.find((b) => b.from === block.from)
          if (!target) return
          this.view.dispatch({
            selection: { anchor: target.from },
            scrollIntoView: true,
          })
          this.view.focus()
        })
        this.dom.appendChild(mark)
        this.marks.set(block.from, mark)
      }
    }
    for (const [from, mark] of this.marks) {
      if (seen.has(from)) continue
      mark.remove()
      this.marks.delete(from)
    }
    // Positions use document-line ratios so the overview stays fixed while scrolling. The CSS min-height
    // keeps a one-line conflict clickable in a very large file.
    for (const block of blocks) {
      const mark = this.marks.get(block.from)
      if (!mark) continue
      const top = ((block.startLine - 1) / lines) * 100
      const height = ((block.endLine - block.startLine + 1) / lines) * 100
      mark.style.top = `${top}%`
      mark.style.height = `${height}%`
      mark.title = t('editor.conflictRange', {
        from: block.startLine,
        to: block.endLine,
      })
    }
  }

  destroy() {
    this.unwatch()
    this.dom.remove()
    this.marks.clear()
  }
}

export const conflictRulerExtension = ViewPlugin.fromClass(ConflictRuler)

/** Drop the single trailing newline of a section (it separates the marker line and is not content) */
function trimTrailingNewline(text: string): string {
  if (text.endsWith('\r\n')) return text.slice(0, -2)
  if (text.endsWith('\n')) return text.slice(0, -1)
  return text
}

function joinSides(ours: string, theirs: string): string {
  if (!ours) return theirs
  if (!theirs) return ours
  return `${ours}\n${theirs}`
}

/** Compute the replacement range for accepting a block (pure, so newline handling is easy to verify) */
export function conflictReplacement(
  doc: Text,
  block: ConflictBlock,
  action: ConflictAction,
): { from: number; to: number; insert: string } {
  const ours = trimTrailingNewline(doc.sliceString(block.oursFrom, block.oursTo))
  const theirs = trimTrailingNewline(doc.sliceString(block.theirsFrom, block.theirsTo))
  const insert =
    action === 'ours' ? ours : action === 'theirs' ? theirs : joinSides(ours, theirs)

  // Accepting empty content leaves the newline after the end marker behind, becoming a blank line
  let to = block.to
  if (!insert) {
    const two = doc.sliceString(to, Math.min(to + 2, doc.length))
    if (two === '\r\n') to += 2
    else if (two.startsWith('\n')) to += 1
  }
  return { from: block.from, to, insert }
}

/** Apply a conflict edit without moving the reader: accept actions must leave the scrollbar where it was. */
function keepScroll(view: EditorView, changes: Parameters<EditorView['dispatch']>[0]['changes'], anchor: number) {
  const top = view.scrollDOM.scrollTop
  const left = view.scrollDOM.scrollLeft
  view.dispatch({
    changes,
    selection: { anchor },
    userEvent: 'input.conflict',
  })
  // The write happens after CodeMirror has measured the new document, so a shrink cannot pull the
  // viewport back to the top before this runs.
  view.requestMeasure({
    read: () => ({ top, left }),
    write: (value, target) => {
      if (!target.dom.isConnected) return
      target.scrollDOM.scrollTop = value.top
      target.scrollDOM.scrollLeft = value.left
    },
  })
}

/**
 * Take one line out of a conflict block. Accepted lines are appended above the block in click order;
 * the rest keeps its markers so a block can be merged line by line. When both sides are empty the
 * markers themselves are removed.
 */
export function acceptConflictLine(
  view: EditorView,
  startPos: number,
  lineNumber: number,
): boolean {
  const blocks = view.state.field(conflictField, false)
  if (!blocks) return false
  const block = blocks.find((b) => b.from === startPos)
  if (!block) return false
  if (blocks.some((b) => b !== block && b.from > block.from && b.to <= block.to)) return false
  if (lineNumber <= block.startLine || lineNumber >= block.endLine) return false

  const doc = view.state.doc
  const oursEnd = block.baseLine || block.sepLine
  const side: ConflictLineSide | null =
    lineNumber > block.startLine && lineNumber < oursEnd
      ? 'ours'
      : lineNumber > block.sepLine && lineNumber < block.endLine
        ? 'theirs'
        : null
  if (!side) return false

  const line = doc.line(lineNumber)
  const text = line.text
  const removed = lineNumber < doc.lines ? doc.line(lineNumber + 1).from : line.to
  const oursLines = oursEnd - block.startLine - 1
  const theirsLines = block.endLine - block.sepLine - 1
  const remainingOurs = oursLines - (side === 'ours' ? 1 : 0)
  const remainingTheirs = theirsLines - (side === 'theirs' ? 1 : 0)

  if (remainingOurs <= 0 && remainingTheirs <= 0) {
    // Last content line: replacing the whole block also drops the base section and both markers.
    const insert = text || '\n'
    keepScroll(
      view,
      { from: block.from, to: block.to, insert },
      block.from + insert.length,
    )
    return true
  }

  const insert = `${text}\n`
  const insertedAt = block.from + insert.length
  keepScroll(
    view,
    [
      { from: block.from, insert },
      { from: line.from, to: removed },
    ],
    insertedAt,
  )
  return true
}

/** Accept a conflict block. Re-reads the block from the current doc to avoid stale ranges; returns whether the doc actually changed. */
export function resolveConflict(
  view: EditorView,
  startPos: number,
  action: ConflictAction,
): boolean {
  const blocks = view.state.field(conflictField, false)
  if (!blocks) return false
  const block = blocks.find((b) => b.from === startPos)
  if (!block) return false
  if (blocks.some((b) => b !== block && b.from > block.from && b.to <= block.to)) return false

  const change = conflictReplacement(view.state.doc, block, action)
  keepScroll(view, change, change.from + change.insert.length)
  return true
}
