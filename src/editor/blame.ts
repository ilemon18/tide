import { StateEffect, StateField } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { BlameRange, BlameResult } from '../lib/ipc'
import { relativeTime, shortSha } from '../lib/format'
import { commitDetailKey, scheduleCommitPrefetch, useCommitHover } from '../store/commitHover'
import { t } from '../i18n'
import { hasLocaleEffect, watchLocale } from './locale'

export const setBlameEffect = StateEffect.define<BlameResult | null>()

/** Blame data sits on the EditorState so tab switches and theme reconfigures keep it */
export const blameField = StateField.define<BlameResult | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setBlameEffect)) return effect.value
    }
    return value
  },
})

class BlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly root: string,
    readonly rel: string,
    /** Metadata travels with the target so the completed card needs no extra lookup. */
    readonly author: string,
    readonly authorTime: number,
    readonly summary: string,
    /** Uncommitted lines have no sha, so no hover card */
    readonly sha: string,
    readonly lineStart: number,
    readonly lineCount: number,
    /** Actual line number the hover text sits on (cursor line) */
    readonly line: number,
    /** Line number inside the introducing commit, used to locate the diff hunk */
    readonly origLine: number,
  ) {
    super()
  }

  eq(other: BlameWidget) {
    return (
      other.text === this.text &&
      other.root === this.root &&
      other.rel === this.rel &&
      other.author === this.author &&
      other.authorTime === this.authorTime &&
      other.summary === this.summary &&
      other.sha === this.sha &&
      other.lineStart === this.lineStart &&
      other.lineCount === this.lineCount &&
      other.line === this.line &&
      other.origLine === this.origLine
    )
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-blame'
    span.textContent = this.text

    if (this.sha) {
      span.addEventListener('mouseenter', () => {
        const rect = span.getBoundingClientRect()
        useCommitHover.getState().show({
          root: this.root,
          rel: this.rel,
          author: this.author,
          authorTime: this.authorTime,
          summary: this.summary,
          sha: this.sha,
          lineStart: this.lineStart,
          lineCount: this.lineCount,
          line: this.line,
          origLine: this.origLine,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
        })
      })
      span.addEventListener('mouseleave', () => useCommitHover.getState().hideSoon())
    }
    return span
  }

  ignoreEvent() {
    return true
  }
}

const EMPTY = Decoration.none

/** Find the blame range a line belongs to */
function rangeFor(ranges: BlameRange[], line: number): BlameRange | null {
  // Ranges are sorted by startLine; a linear scan is fast enough for a few lines (one cursor line per build)
  for (const range of ranges) {
    if (line >= range.startLine && line < range.startLine + range.lineCount) return range
  }
  return null
}

/** Open the one-line commit card for a line in a blame result, used by the diff gutter. */
export function showBlameRange(
  data: BlameResult,
  lineNumber: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  if (data.disabled) return false
  const range = rangeFor(data.ranges, lineNumber)
  if (!range || range.uncommitted || !range.sha) return false

  const origLine = range.origLine ? range.origLine + (lineNumber - range.startLine) : 0
  useCommitHover.getState().show({
    root: data.root,
    rel: data.rel,
    author: range.author,
    authorTime: range.authorTime,
    summary: range.summary,
    sha: range.sha,
    lineStart: range.startLine,
    lineCount: range.lineCount,
    line: lineNumber,
    origLine,
    rect,
  })
  return true
}

/** Use the mounted blame field first; the diff gutter also has an on-demand fallback. */
export function showBlameAtLine(
  view: EditorView,
  lineNumber: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  const data = view.state.field(blameField, false)
  return data ? showBlameRange(data, lineNumber, rect) : false
}

function cursorBlame(view: EditorView, suppressed: boolean) {
  // Hidden while typing: trailing grey commit text distracts and makes fresh keystrokes jump
  if (suppressed) return null
  const data = view.state.field(blameField, false)
  if (!data || data.disabled || data.ranges.length === 0) return null

  // Only on the cursor line (GitLens current-line blame), not on every line
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const range = rangeFor(data.ranges, line.number)
  if (!range) return null

  const origLine = range.origLine ? range.origLine + (line.number - range.startLine) : 0
  return { data, line, range, origLine }
}

function build(cursor: ReturnType<typeof cursorBlame>): DecorationSet {
  if (!cursor) return EMPTY
  const { data, line, range, origLine } = cursor

  // Trailing text carries the commit title; hover reveals the full message
  const text = range.uncommitted
    ? t('editor.uncommitted')
    : [range.author, relativeTime(range.authorTime), shortSha(range.sha), range.summary]
        .filter(Boolean)
        .join(' · ')

  return Decoration.set(
    [
      Decoration.widget({
        widget: new BlameWidget(
          text,
          data.root,
          data.rel,
          range.author,
          range.authorTime,
          range.summary,
          range.uncommitted ? '' : range.sha,
          range.startLine,
          range.lineCount,
          line.number,
          origLine,
        ),
        side: 1,
      }).range(line.to),
    ],
    true,
  )
}

/** Trailing blame is reattached only after this much idle time */
const TYPE_IDLE = 700
/** Forces a redraw during typing, otherwise decorations stay hidden forever */
const rebuildEffect = StateEffect.define<null>()

const blamePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private typingUntil = 0
    private timer: ReturnType<typeof setTimeout> | null = null
    private unwatch: () => void = () => {}
    private prefetchKey: string | null = null
    private cancelPrefetch: () => void = () => {}
    private source: { root: string; rel: string } | null = null

    constructor(view: EditorView) {
      this.decorations = EMPTY
      this.refresh(view)
      this.unwatch = watchLocale(view)
    }

    private refresh(view: EditorView) {
      const cursor = cursorBlame(view, Date.now() < this.typingUntil)
      if (!cursor) this.hideHover()
      const data = view.state.field(blameField, false)
      this.decorations = build(cursor)
      const query = cursor && !cursor.range.uncommitted ? {
        root: cursor.data.root,
        rel: cursor.data.rel,
        sha: cursor.range.sha,
        line: cursor.line.number,
        origLine: cursor.origLine,
      } : null
      const key = query ? commitDetailKey(query) : null
      if (key !== this.prefetchKey) {
        const hover = useCommitHover.getState().target
        const sameTarget = Boolean(
          cursor &&
          hover &&
          !cursor.range.uncommitted &&
          hover.root === cursor.data.root &&
          hover.rel === cursor.data.rel &&
          hover.sha === cursor.range.sha &&
          hover.line === cursor.line.number,
        )
        if (!sameTarget) this.hideHover()
        this.cancelPrefetch()
        this.prefetchKey = key
        this.cancelPrefetch = query ? scheduleCommitPrefetch(query) : () => {}
      }
      this.source = data ? { root: data.root, rel: data.rel } : null
    }

    private hideHover() {
      const hover = useCommitHover.getState().target
      if (hover && hover.root === this.source?.root && hover.rel === this.source.rel) {
        useCommitHover.getState().hide()
      }
    }

    private arm(view: EditorView) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => {
        this.timer = null
        try {
          view.dispatch({ effects: rebuildEffect.of(null) })
        } catch {
          /* The view may already be destroyed */
        }
      }, TYPE_IDLE + 20)
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        this.typingUntil = Date.now() + TYPE_IDLE
        this.arm(update.view)
      }
      const blameChanged = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setBlameEffect) || e.is(rebuildEffect)),
      )
      if (
        blameChanged ||
        update.selectionSet ||
        update.docChanged ||
        update.viewportChanged ||
        hasLocaleEffect(update)
      ) {
        this.refresh(update.view)
      }
      // The hover card holds only while the mouse stays on the grey blame text:
      // moving the cursor, editing or switching files hides it before it shows stale info
      const hover = useCommitHover.getState().target
      if (hover && (update.docChanged || update.selectionSet)) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number
        if (update.docChanged || line !== hover.line) this.hideHover()
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer)
      this.cancelPrefetch()
      this.hideHover()
      this.unwatch()
    }
  },
  { decorations: (v) => v.decorations },
)

export const blameExtension = [blameField, blamePlugin]
