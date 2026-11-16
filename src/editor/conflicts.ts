import { StateField, type Range, type Text } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { t } from '../i18n'
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

export type ConflictAction = 'ours' | 'theirs' | 'both'

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
  if (line === block.startLine || line === block.sepLine || line === block.endLine) {
    return 'cm-conflict-marker'
  }
  if (block.baseLine && line === block.baseLine) return 'cm-conflict-marker'
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
  ) {
    super()
  }

  eq(other: ConflictActionsWidget) {
    return (
      other.startPos === this.startPos &&
      other.oursLabel === this.oursLabel &&
      other.theirsLabel === this.theirsLabel &&
      other.nested === this.nested
    )
  }

  toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-conflict-actions'

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
      el.title = `${label}（${action === 'both' ? `${this.oursLabel} + ${this.theirsLabel}` : action === 'ours' ? this.oursLabel : this.theirsLabel}）`
      // mousedown instead of click: the editor would otherwise handle the event first and move the cursor
      el.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
        resolveConflict(view, this.startPos, action)
      })
      return el
    }

    wrap.append(
      button(t('editor.acceptOurs'), 'ours'),
      button(t('editor.acceptTheirs'), 'theirs'),
      button(t('editor.acceptBoth'), 'both'),
    )

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
}

function build(view: EditorView): DecorationSet {
  const blocks = view.state.field(conflictField, false)
  if (!blocks || blocks.length === 0) return Decoration.none

  const doc = view.state.doc
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
        ),
        side: 1,
      }).range(doc.line(block.startLine).to),
    )
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

/** Conflict ruler on the editor's right: one stripe per conflict block, so the count and position are visible without scrolling; click to jump. */
class ConflictRuler {
  dom: HTMLElement
  private view: EditorView
  private marks = new Map<number, HTMLElement>()
  private raf = 0
  private readonly onScroll = () => this.schedule()

  constructor(view: EditorView) {
    this.view = view
    this.dom = document.createElement('div')
    this.dom.className = 'cm-conflict-ruler'
    view.dom.appendChild(this.dom)
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
    this.rebuild()
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged) this.rebuild()
  }

  private schedule() {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.position()
    })
  }

  private rebuild() {
    const blocks = this.view.state.field(conflictField, false) ?? []
    const seen = new Set<number>()
    for (const block of blocks) {
      if (seen.has(block.from)) continue
      seen.add(block.from)
      let mark = this.marks.get(block.from)
      if (!mark) {
        mark = document.createElement('div')
        mark.className = 'cm-conflict-ruler-mark'
        mark.title = t('editor.jumpToConflict')
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
    this.position()
  }

  private position() {
    const view = this.view
    if (!view.dom.isConnected) return
    // documentTop is in screen coords and the ruler lives in view.dom, so subtract the editor's own top
    const base = view.dom.getBoundingClientRect().top
    for (const [from, mark] of this.marks) {
      const block = view.lineBlockAt(from)
      mark.style.top = `${Math.round(view.documentTop + block.top - base)}px`
    }
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
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
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    userEvent: 'input.conflict',
    scrollIntoView: true,
  })
  return true
}