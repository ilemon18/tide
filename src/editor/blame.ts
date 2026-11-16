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
import { useCommitHover } from '../store/commitHover'
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
    /** Hover card shows author/time right away instead of waiting for git details */
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

function build(view: EditorView, suppressed: boolean): DecorationSet {
  // Hidden while typing: trailing grey commit text distracts and makes fresh keystrokes jump
  if (suppressed) return EMPTY
  const data = view.state.field(blameField, false)
  if (!data || data.disabled || data.ranges.length === 0) return EMPTY

  // Only on the cursor line (GitLens current-line blame), not on every line
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const range = rangeFor(data.ranges, line.number)
  if (!range) return EMPTY

  // Trailing text carries the commit title; hover reveals the full message
  const text = range.uncommitted
    ? t('editor.uncommitted')
    : [range.author, relativeTime(range.authorTime), shortSha(range.sha), range.summary]
        .filter(Boolean)
        .join(' · ')

  // The cursor may sit mid-range: map it to the original line in that commit
  const origLine = range.origLine ? range.origLine + (line.number - range.startLine) : 0

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

    constructor(view: EditorView) {
      this.decorations = build(view, false)
      this.unwatch = watchLocale(view)
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
        this.decorations = build(update.view, Date.now() < this.typingUntil)
      }
      // The hover card holds only while the mouse stays on the grey blame text:
      // moving the cursor, editing or switching files hides it before it shows stale info
      const hover = useCommitHover.getState().target
      if (hover && (update.docChanged || update.selectionSet)) {
        const line = update.state.doc.lineAt(update.state.selection.main.head).number
        if (update.docChanged || line !== hover.line) useCommitHover.getState().hide()
      }
    }

    destroy() {
      if (this.timer) clearTimeout(this.timer)
      this.unwatch()
    }
  },
  { decorations: (v) => v.decorations },
)

export const blameExtension = [blameField, blamePlugin]