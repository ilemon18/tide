import { StateEffect, StateField, type EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import type { BlameRange, BlameResult } from '../lib/ipc'
import { absoluteTime, relativeTime, truncateGraphemes } from '../lib/format'
import {
  commitHoverKey,
  scheduleCommitPrefetch,
  useCommitHover,
  type CommitHoverTarget,
} from '../store/commitHover'
import { currentLocale, t } from '../i18n'
import { hasLocaleEffect, watchLocale } from './locale'

/** Long commit subjects must not push the code sideways. Counted in graphemes, not UTF-16 units. */
const MAX_SUMMARY_GRAPHEMES = 50
/** Idle delay before the buffer is guilted again. */
const CONTENT_IDLE = 450
/** Relative timestamps go stale while the editor sits idle. */
const TIME_REFRESH = 60_000

export type BlameState = {
  result: BlameResult | null
  /** The buffer changed and its content-aware blame has not arrived yet: hide the old rows. */
  awaiting: boolean
  /** Incremented per document change; buffer results carry the version they were computed from. */
  version: number
}

export const setBlameEffect = StateEffect.define<BlameResult | null>()

/** Blame data sits on the EditorState so tab switches and theme reconfigures keep it */
export const blameField = StateField.define<BlameState>({
  create: () => ({ result: null, awaiting: false, version: 0 }),
  update(value, tr) {
    let next = value
    if (tr.docChanged) next = { ...next, awaiting: true, version: next.version + 1 }
    for (const effect of tr.effects) {
      if (!effect.is(setBlameEffect)) continue
      const result = effect.value
      // A buffer result computed for an older document must not replace the current rows, and a
      // disk result (version 0) must never land on a document that is still waiting for its buffer.
      const stale = Boolean(
        result &&
          ((result.version > 0 && result.version !== next.version) ||
            (result.version === 0 && next.awaiting)),
      )
      // Ignore stale answers entirely: a late old request must not hide (or replace) a result that
      // already matches the current document.
      if (!stale) next = { ...next, result, awaiting: false }
    }
    return next
  },
})

export function blameResultOf(state: EditorState): BlameResult | null {
  return state.field(blameField, false)?.result ?? null
}

export function isBlameAwaiting(state: EditorState): boolean {
  return Boolean(state.field(blameField, false)?.awaiting)
}

/** EditorHost installs this once the view is mounted: it forwards the dirty buffer to the store. */
export type BlameContentProvider = (contents: string, version: number) => void
const providers = new WeakMap<EditorView, BlameContentProvider>()

export function setBlameContentProvider(
  view: EditorView,
  provider: BlameContentProvider | null,
): void {
  if (provider) providers.set(view, provider)
  else providers.delete(view)
}

function isCurrentUser(range: BlameRange, data: BlameResult): boolean {
  const authorEmail = range.authorEmail.trim().toLowerCase()
  const userEmail = data.currentUserEmail.trim().toLowerCase()
  if (userEmail) return authorEmail === userEmail
  // Older repositories may have no configured email: fall back to the display name.
  return Boolean(data.currentUserName) && range.author === data.currentUserName
}

function authorLabel(range: BlameRange, data: BlameResult): string {
  return isCurrentUser(range, data) ? t('blame.you') : range.author
}

/** `Author, 3 days ago • message`, or `You, Uncommitted changes`. No SHA: that lives in the card. */
export function formatBlameText(range: BlameRange, data: BlameResult): string {
  // A dirty line belongs to the person editing right now; blame reports "Not Committed Yet".
  if (range.uncommitted) return `${t('blame.you')}, ${t('blame.uncommitted')}`
  const author = authorLabel(range, data)
  const when = relativeTime(range.authorTime)
  const summary = truncateGraphemes(range.summary, MAX_SUMMARY_GRAPHEMES)
  const head = when ? `${author}, ${when}` : author
  return summary ? `${head} • ${summary}` : head
}

function fullTooltip(range: BlameRange, data: BlameResult): string {
  if (range.uncommitted) return `${t('blame.you')} — ${t('blame.uncommitted')}`
  const author = authorLabel(range, data)
  return [author, absoluteTime(range.authorTime, currentLocale()), range.summary]
    .filter(Boolean)
    .join(' — ')
}

class BlameWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly tooltip: string,
    readonly target: CommitHoverTarget,
  ) {
    super()
  }

  eq(other: BlameWidget) {
    return (
      other.text === this.text &&
      other.tooltip === this.tooltip &&
      other.target.root === this.target.root &&
      other.target.rel === this.target.rel &&
      other.target.path === this.target.path &&
      other.target.sha === this.target.sha &&
      other.target.line === this.target.line &&
      other.target.origLine === this.target.origLine &&
      other.target.author === this.target.author &&
      other.target.authorEmail === this.target.authorEmail &&
      other.target.authorTime === this.target.authorTime &&
      other.target.summary === this.target.summary &&
      other.target.lineStart === this.target.lineStart &&
      other.target.lineCount === this.target.lineCount &&
      other.target.currentUserEmail === this.target.currentUserEmail &&
      other.target.uncommitted === this.target.uncommitted
    )
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-blame'
    span.textContent = this.text
    span.title = this.tooltip
    span.setAttribute('aria-label', this.tooltip)
    // Hover previews; a click pins the card open (GitLens-style) until the card itself is left.
    let pinned = false
    const open = () => {
      const rect = span.getBoundingClientRect()
      useCommitHover.getState().show({
        ...this.target,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      })
    }
    span.addEventListener('mouseenter', open)
    span.addEventListener('click', (event) => {
      event.preventDefault()
      event.stopPropagation()
      pinned = true
      open()
    })
    span.addEventListener('mouseleave', () => {
      if (!pinned) useCommitHover.getState().hideSoon()
    })
    return span
  }

  ignoreEvent() {
    return true
  }
}

const EMPTY = Decoration.none

/** Find the blame range a line belongs to (ranges are sorted by startLine) */
function rangeFor(ranges: BlameRange[], line: number): BlameRange | null {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (line < range.startLine) high = mid - 1
    else if (line >= range.startLine + range.lineCount) low = mid + 1
    else return range
  }
  return null
}

/** Build the hover target for one line of a blame result. */
export function hoverTargetFor(
  data: BlameResult,
  lineNumber: number,
  rect: { left: number; top: number; right: number; bottom: number },
): CommitHoverTarget | null {
  if (data.disabled) return null
  const range = rangeFor(data.ranges, lineNumber)
  if (!range) return null
  const origLine = range.origLine ? range.origLine + (lineNumber - range.startLine) : 0
  return {
    root: data.root,
    rel: data.rel,
    path: range.origPath || data.rel,
    sha: range.sha,
    line: lineNumber,
    origLine,
    author: range.author,
    authorEmail: range.authorEmail,
    authorTime: range.authorTime,
    summary: range.summary,
    currentUserEmail: data.currentUserEmail,
    lineStart: range.startLine,
    lineCount: range.lineCount,
    uncommitted: range.uncommitted,
    rect,
  }
}

/** Open the commit card for a line in a blame result, used by the diff gutter. */
export function showBlameRange(
  data: BlameResult,
  lineNumber: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  const target = hoverTargetFor(data, lineNumber, rect)
  if (!target) return false
  useCommitHover.getState().show(target)
  return true
}

/** Use the mounted blame field first; the diff gutter also has an on-demand fallback. */
export function showBlameAtLine(
  view: EditorView,
  lineNumber: number,
  rect: { left: number; top: number; right: number; bottom: number },
): boolean {
  // While the buffer changed, the stored rows describe the previous document.
  if (isBlameAwaiting(view.state)) return false
  const data = blameResultOf(view.state)
  return data ? showBlameRange(data, lineNumber, rect) : false
}

function cursorBlame(view: EditorView) {
  const state = view.state.field(blameField, false)
  if (!state || state.awaiting) return null
  const data = state.result
  if (!data || data.disabled || data.ranges.length === 0) return null

  // Only on the cursor line (GitLens current-line blame), not on every line
  const head = view.state.selection.main.head
  const line = view.state.doc.lineAt(head)
  const range = rangeFor(data.ranges, line.number)
  if (!range) return null
  return { data, line, range }
}

function build(cursor: ReturnType<typeof cursorBlame>): DecorationSet {
  if (!cursor) return EMPTY
  const { data, line, range } = cursor
  const target = hoverTargetFor(data, line.number, { left: 0, top: 0, right: 0, bottom: 0 })
  if (!target) return EMPTY

  return Decoration.set(
    [
      Decoration.widget({
        widget: new BlameWidget(
          formatBlameText(range, data),
          fullTooltip(range, data),
          // The stored rect is a placeholder; the live DOM node is measured when the card opens.
          target,
        ),
        side: 1,
      }).range(line.to),
    ],
    true,
  )
}

/** Forces a redraw for the periodic relative-time refresh */
const rebuildEffect = StateEffect.define<null>()

const blamePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    private contentTimer: ReturnType<typeof setTimeout> | null = null
    private clockTimer: ReturnType<typeof setInterval> | null = null
    private unwatch: () => void = () => {}
    private prefetchKey: string | null = null
    private cancelPrefetch: () => void = () => {}
    private source: { root: string; rel: string } | null = null

    constructor(view: EditorView) {
      this.decorations = EMPTY
      this.refresh(view)
      this.unwatch = watchLocale(view)
      this.clockTimer = setInterval(() => {
        try {
          view.dispatch({ effects: rebuildEffect.of(null) })
        } catch {
          /* The view may already be destroyed */
        }
      }, TIME_REFRESH)
    }

    private refresh(view: EditorView) {
      const cursor = cursorBlame(view)
      if (!cursor) this.hideHover()
      const data = view.state.field(blameField, false)?.result ?? null
      this.decorations = build(cursor)

      const target = cursor ? hoverTargetFor(cursor.data, cursor.line.number, { left: 0, top: 0, right: 0, bottom: 0 }) : null
      const key = target ? commitHoverKey(target) : null
      if (key !== this.prefetchKey) {
        const hover = useCommitHover.getState().target
        const sameTarget = Boolean(
          target && hover && commitHoverKey(hover) === key,
        )
        if (!sameTarget) this.hideHover()
        this.cancelPrefetch()
        this.prefetchKey = key
        this.cancelPrefetch = target ? scheduleCommitPrefetch(target) : () => {}
      }
      this.source = data ? { root: data.root, rel: data.rel } : null
    }

    private hideHover() {
      const hover = useCommitHover.getState().target
      if (hover && hover.root === this.source?.root && hover.rel === this.source.rel) {
        useCommitHover.getState().hide()
      }
    }

    /** Debounce buffer blame: one request after the user stops typing, never per keystroke. */
    private scheduleContent(view: EditorView) {
      const state = view.state.field(blameField, false)
      const provider = providers.get(view)
      if (!provider || !state?.awaiting) return
      if (this.contentTimer) clearTimeout(this.contentTimer)
      this.contentTimer = setTimeout(() => {
        this.contentTimer = null
        try {
          const current = view.state.field(blameField, false)
          if (!current?.awaiting) return
          provider(view.state.doc.toString(), current.version)
        } catch {
          /* The view may already be destroyed */
        }
      }, CONTENT_IDLE)
    }

    update(update: ViewUpdate) {
      if (update.docChanged) {
        // Hide immediately: the old rows describe lines the user may have just shifted.
        this.decorations = EMPTY
        this.hideHover()
        this.scheduleContent(update.view)
      }
      const blamed = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(setBlameEffect) || e.is(rebuildEffect)),
      )
      if (
        blamed ||
        update.selectionSet ||
        update.docChanged ||
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
      if (this.contentTimer) clearTimeout(this.contentTimer)
      if (this.clockTimer) clearInterval(this.clockTimer)
      this.cancelPrefetch()
      this.hideHover()
      this.unwatch()
    }
  },
  { decorations: (v) => v.decorations },
)

export const blameExtension = [blameField, blamePlugin]
