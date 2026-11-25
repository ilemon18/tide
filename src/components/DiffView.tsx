import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from 'react'
import { api, errorText } from '../lib/ipc'
import type { Tab } from '../store/tabs'
import { useTabs } from '../store/tabs'
import { useGit } from '../store/git'
import { useSettings } from '../store/settings'
import { basename } from '../lib/paths'
import type { SyntaxColors } from '../theme/palettes'
import { diffTokenStyle } from '../theme/syntax'
import { Icon } from './Icon'
import { useT } from '../i18n'
import { FileIcon } from './FileIcon'
import { HIGHLIGHT_MAX_LINES, highlightSide, type LineTokens, type Token } from './diffHighlight'
import { budget } from '../lib/memoryBudget'
import { createDiffScroll } from './diffScroll'

/**
 * Side-by-side diff view (VSCode style). Data comes from git's full-context patch (-U100000): each
 * hunk already carries line numbers for both sides, so splitting on +/-/space yields aligned rows and
 * no diff algorithm is needed in the frontend.
 *
 * Both panes are `flex-1`, so they structurally cannot stack vertically; each pane scrolls horizontally
 * on its own, so a very long line only adds a scrollbar to its own pane (an earlier `minmax(<longest
 * line>ch, 1fr)` squeezed the other side); both panes sync their scroll positions.
 */

type Side = { no: number; text: string } | null

type Row =
  | { kind: 'context' | 'change'; left: Side; right: Side }
  | { kind: 'gap'; count: number }

type Parsed = {
  rows: Row[]
  adds: number
  dels: number
  overLimit: boolean
}

/** One row actually rendered after folding (both panes share it, so row heights stay aligned) */
type DisplayRow =
  | { kind: 'gap'; id: number; count: number }
  | { kind: 'fold'; id: number; count: number; folded: boolean }
  | { kind: 'line'; id: number; left: Side; right: Side; changed: boolean; inline: Inline | null }

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const META =
  /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode |new mode |similarity index|dissimilarity index|rename from |rename to |copy from |copy to )/
/** New file name from the patch header: more accurate than tab.rel for renames / untracked files, used to pick a language pack */
const PATCH_PATH = /^\+\+\+ b\/(.+)$/m
/** Only runs of at least this many unchanged lines offer folding */
const FOLD_MIN = 10
/** Context rows kept above the first change when a diff opens; fixed so the terminal height cannot shift it */
const FIRST_CHANGE_CONTEXT_ROWS = 3
/** Lines longer than this skip inline diff highlighting: the char compare degrades to O(n) and looks meaningless */
const MAX_INTRALINE = 2000

function parsePatch(patch: string, maxRows: number): Parsed {
  const lines = patch.split('\n')
  const rows: Row[] = []
  let oldLine = 0
  let newLine = 0
  let adds = 0
  let dels = 0
  let started = false
  let pendingDel: { no: number; text: string }[] = []
  let pendingAdd: { no: number; text: string }[] = []

  const flush = () => {
    const count = Math.max(pendingDel.length, pendingAdd.length)
    for (let i = 0; i < count; i += 1) {
      rows.push({
        kind: 'change',
        left: pendingDel[i] ?? null,
        right: pendingAdd[i] ?? null,
      })
    }
    pendingDel = []
    pendingAdd = []
  }

  for (const raw of lines) {
    // Large patches are common on generated files: stop before building tens of thousands of rows.
    if (rows.length >= maxRows) {
      return { rows, adds, dels, overLimit: true }
    }
    if (HUNK.test(raw)) {
      flush()
      const match = HUNK.exec(raw)!
      const nextOld = Number(match[1])
      const nextNew = Number(match[2])
      // In the -U3 fallback some lines between blocks are skipped: show a hint so it is not read as continuous content
      if (started && nextOld > oldLine) {
        rows.push({ kind: 'gap', count: nextOld - oldLine })
      }
      oldLine = nextOld
      newLine = nextNew
      started = true
      continue
    }

    // The patch header only appears before the first hunk; inside a hunk, lines starting with + / - are real code
    if (!started && (META.test(raw) || raw.startsWith('\\ '))) {
      flush()
      continue
    }

    if (raw.startsWith('+')) {
      pendingAdd.push({ no: newLine, text: raw.slice(1) })
      newLine += 1
      adds += 1
      if (pendingAdd.length >= maxRows) {
        flush()
        return { rows: rows.slice(0, maxRows), adds, dels, overLimit: true }
      }
      continue
    }

    if (raw.startsWith('-')) {
      pendingDel.push({ no: oldLine, text: raw.slice(1) })
      oldLine += 1
      dels += 1
      if (pendingDel.length >= maxRows) {
        flush()
        return { rows: rows.slice(0, maxRows), adds, dels, overLimit: true }
      }
      continue
    }

    if (raw.startsWith(' ')) {
      flush()
      rows.push({
        kind: 'context',
        left: { no: oldLine, text: raw.slice(1) },
        right: { no: newLine, text: raw.slice(1) },
      })
      oldLine += 1
      newLine += 1
      continue
    }

    if (raw.startsWith('\\')) continue
    if (raw === '') flush()
  }
  flush()
  if (rows.length > maxRows) {
    return { rows: rows.slice(0, maxRows), adds, dels, overLimit: true }
  }

  return { rows, adds, dels, overLimit: false }
}

/** Start -> end (inclusive) of each unchanged run; only long enough runs, so files do not grow a pile of fold bars */
function foldRuns(rows: Row[]): Map<number, number> {
  const runs = new Map<number, number>()
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind !== 'context') continue
    let end = i
    while (end + 1 < rows.length && rows[end + 1].kind === 'context') end += 1
    if (end - i + 1 >= FOLD_MIN) runs.set(i, end)
    i = end
  }
  return runs
}

/** Common prefix / suffix length of the two sides: only deepen what really changed, closer to VSCode */
type Inline = { prefix: number; suffix: number }

function inlineDiff(left: string, right: string): Inline | null {
  if (!left || !right) return null
  if (left.length > MAX_INTRALINE || right.length > MAX_INTRALINE) return null
  const max = Math.min(left.length, right.length)
  let prefix = 0
  while (prefix < max && left.charCodeAt(prefix) === right.charCodeAt(prefix)) prefix += 1
  let suffix = 0
  // Do not compare the suffix once the prefix covers the whole line, or both sides degenerate to empty pieces
  while (
    suffix < max - prefix &&
    left.charCodeAt(left.length - 1 - suffix) === right.charCodeAt(right.length - 1 - suffix)
  ) {
    suffix += 1
  }
  if (prefix === 0 && suffix === 0) return null
  return { prefix, suffix }
}

/**
 * Build one "whole text" array for syntax parsing: an index is real line number - 1.
 * The -U3 patch skips lines in between, so unknown lines get empty strings (they are not rendered,
 * so tokens never shift).
 */
function sideText(rows: Row[], side: 'left' | 'right'): string[] | null {
  let max = 0
  for (const row of rows) {
    if (row.kind === 'gap') continue
    const cell = row[side]
    if (cell && cell.no > max) max = cell.no
  }
  if (max === 0 || max > HIGHLIGHT_MAX_LINES) return null
  const lines = new Array<string>(max).fill('')
  for (const row of rows) {
    if (row.kind === 'gap') continue
    const cell = row[side]
    if (cell && cell.no >= 1 && cell.no <= max) lines[cell.no - 1] = cell.text
  }
  return lines
}

type Props = { tab: Tab }

export function DiffView({ tab }: Props) {
  const t = useT()
  const maxRows = budget.diffRows()
  const [patch, setPatch] = useState<string | null>(null)
  const [binary, setBinary] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /** Start (row index) of each folded unchanged region */
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  /** Syntax segments for both sides: plain text first, colors after parsing */
  const [tokens, setTokens] = useState<{ left: LineTokens | null; right: LineTokens | null }>({
    left: null,
    right: null,
  })

  const syntax = useSettings((s) => s.palette.syntax)
  const leftRef = useRef<HTMLDivElement | null>(null)
  const rightRef = useRef<HTMLDivElement | null>(null)
  const scroll = useMemo(
    () => createDiffScroll((side) => (side === 'left' ? leftRef.current : rightRef.current)),
    [],
  )
  /** Which tab the current content belongs to: only a tab change clears the view, same-tab refreshes replace in place */
  const loadedFor = useRef<string | null>(null)
  /** Freshly loaded content still has to land on its first change; in-place refreshes keep the reader's position */
  const pendingLocate = useRef(true)
  /** Scroll ratio captured before an in-place refresh, applied once the next view has laid out */
  const pendingScroll = useRef<number | null>(null)
  /** Scroll progress captured before a refresh: handed to the file tab when the diff turns out empty */
  const switchRatio = useRef(0)
  /** The file view was already requested for this tab, so one refresh cannot ask twice */
  const requestedFile = useRef(false)
  /** Incremented on external edits / staging changes: keeps the tab open, just refetches and re-diffs */
  const epoch = useTabs((s) => (s.diffEpoch[tab.root] ?? 0) + (s.diffEpoch[tab.id] ?? 0))

  useLayoutEffect(() => {
    scroll.reset()
    pendingLocate.current = true
    pendingScroll.current = null
    requestedFile.current = false
    return scroll.cancel
  }, [scroll, tab.id])

  /** Apply the captured ratio to the diff panes that are mounted now */
  const restorePendingScroll = useCallback(() => {
    const ratio = pendingScroll.current
    if (ratio === null) return
    const el = leftRef.current
    if (!el) return
    if (el.scrollHeight <= el.clientHeight) {
      pendingScroll.current = null
      return
    }
    const top = Math.min(el.scrollHeight - el.clientHeight, ratio * el.scrollHeight)
    scroll.jumpTo(top)
    pendingScroll.current = null
  }, [scroll])

  useEffect(() => {
    let alive = true
    let restoreFrame: number | null = null
    // An in-place refresh of the same tab (external edit / staging change) does not clear existing content:
    // fetch the new patch in the background, then swap it in whole to avoid flashing "loading diff"
    // and jumping scrollbars
    const sameTab = loadedFor.current === tab.id
    if (!sameTab) {
      pendingLocate.current = true
      pendingScroll.current = null
      setLoading(true)
      setError(null)
      setPatch(null)
      setBinary(false)
      setTruncated(false)
      setCollapsed(new Set())
    }

    void api
      .gitDiffFull(tab.root, tab.rel, Boolean(tab.staged))
      .then((res) => {
        if (!alive) return
        // Capture at application time: input during the background request owns the reading position.
        if (sameTab) {
          scroll.flush()
          const pane = leftRef.current
          if (pane) {
            const max = Math.max(0, pane.scrollHeight - pane.clientHeight)
            switchRatio.current = max > 0 ? pane.scrollTop / max : 0
            pendingScroll.current = pane.scrollHeight > 0 ? pane.scrollTop / pane.scrollHeight : null
          }
        }
        loadedFor.current = tab.id
        setBinary(res.binary)
        setTruncated(res.truncated)
        setPatch(res.patch)
        setLoading(false)
        // Also covers a refresh whose patch did not change: no re-render, so the layout effect never runs
        restoreFrame = requestAnimationFrame(() => {
          if (alive) restorePendingScroll()
        })
      })
      .catch((e) => {
        if (!alive) return
        if (sameTab) {
          // In-place refresh failed (file just deleted / that diff is gone): keep the current content;
          // the tab is closed by git status, so do not toast an error here
          console.warn('[Tide] 刷新差异失败', errorText(e))
          pendingScroll.current = null
          setLoading(false)
          return
        }
        setError(errorText(e))
        setLoading(false)
      })

    return () => {
      alive = false
      if (restoreFrame !== null) cancelAnimationFrame(restoreFrame)
    }
  }, [tab.id, tab.root, tab.rel, tab.staged, epoch, restorePendingScroll, scroll])

  // null = not fetched yet; an empty string is a fetched, unchanged file and must parse to zero rows
  const parsed = useMemo(
    () => (patch !== null ? parsePatch(patch, maxRows) : null),
    [patch, maxRows],
  )
  const runs = useMemo(() => (parsed ? foldRuns(parsed.rows) : new Map<number, number>()), [parsed])
  const langPath = useMemo(
    () => (patch ? (PATCH_PATH.exec(patch)?.[1] ?? tab.rel) : tab.rel),
    [patch, tab.rel],
  )

  /** Flattened render sequence after folding: left and right panes read the same list, so heights align naturally */
  const display = useMemo(() => {
    if (!parsed) return []
    const out: DisplayRow[] = []
    const rows = parsed.rows
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      if (row.kind === 'gap') {
        out.push({ kind: 'gap', id: i, count: row.count })
        continue
      }

      const runEnd = runs.get(i)
      if (runEnd !== undefined) {
        const count = runEnd - i + 1
        const folded = collapsed.has(i)
        out.push({ kind: 'fold', id: i, count, folded })
        if (folded) {
          i = runEnd
          continue
        }
      }

      const changed = row.kind === 'change'
      out.push({
        kind: 'line',
        id: i,
        left: row.left,
        right: row.right,
        changed,
        inline:
          changed && row.left && row.right ? inlineDiff(row.left.text, row.right.text) : null,
      })
    }
    return out
  }, [parsed, runs, collapsed])

  // A replaced/folded layout must not receive a queued position from the previous layout.
  useLayoutEffect(() => {
    scroll.reset()
  }, [display, scroll])

  /**
   * Opening a diff (a file in the staged / changes / untracked list) starts at the first change instead of
   * line 1, so the edit itself is on screen. Only for freshly loaded content: the refresh path above keeps
   * whatever position the reader had.
   */
  useLayoutEffect(() => {
    if (!pendingLocate.current || loadedFor.current !== tab.id) return
    const locate = () => {
      const container = leftRef.current
      if (!container) return false
      const target = container.querySelector<HTMLElement>('[data-diff-change="1"]')
      if (!target) return false
      const targetRect = target.getBoundingClientRect()
      const top = targetRect.top - container.getBoundingClientRect().top + container.scrollTop
      // Keep a fixed number of rows above the change instead of a fraction of the viewport: opening the
      // terminal shrinks the pane, and a viewport-relative offset made the same diff land elsewhere.
      const context = targetRect.height * FIRST_CHANGE_CONTEXT_ROWS
      const max = Math.max(0, container.scrollHeight - container.clientHeight)
      const scrollTop = Math.min(max, Math.max(0, top - context))
      scroll.jumpTo(scrollTop)
      return true
    }
    if (!locate()) return
    // A second pass after paint uses the final pane height (the terminal panel and the scrollbars may
    // still settle in the first frame), then releases the one-shot jump.
    const frame = requestAnimationFrame(() => {
      if (pendingLocate.current) locate()
      pendingLocate.current = false
    })
    return () => cancelAnimationFrame(frame)
  }, [display, scroll, tab.id])

  /** Marks for the right-hand ruler: add / delete / modify placed by rendered-row ratio (folds and skips included) */
  const rulerMarks = useMemo(() => {
    const total = display.length
    if (total === 0) return []
    const marks: RulerMark[] = []
    // Merge adjacent same-kind marks (including consecutive mods): a fully rewritten file still yields few nodes
    const push = (kind: RulerMark['kind'], from: number, to: number) => {
      const last = marks[marks.length - 1]
      const index = from / total
      const size = (to - from) / total
      if (last && last.kind === kind && Math.abs(last.top + last.height - index) < 1e-9) {
        last.height = size + last.height
        return
      }
      marks.push({ top: index, height: size, kind })
    }
    let runKind: RulerMark['kind'] | null = null
    let runStart = 0
    const flush = (end: number) => {
      if (runKind) push(runKind, runStart, end)
      runKind = null
    }
    display.forEach((row, index) => {
      const kind: RulerMark['kind'] | null =
        row.kind !== 'line' || !row.changed
          ? null
          : row.left && row.right
            ? 'mod'
            : row.left
              ? 'del'
              : 'add'
      if (kind === runKind) return
      flush(index)
      if (kind) {
        runKind = kind
        runStart = index
      }
    })
    flush(total)
    return marks
  }, [display])

  // Syntax highlighting goes into the next macrotask: let the text paint first, do not stall the first frame on parsing
  useEffect(() => {
    setTokens((current) =>
      current.left === null && current.right === null ? current : { left: null, right: null },
    )
    if (!parsed) return
    if (parsed.overLimit || truncated) return
    const left = sideText(parsed.rows, 'left')
    const right = sideText(parsed.rows, 'right')
    if (!left && !right) return

    let alive = true
    const timer = setTimeout(() => {
      void Promise.all([
        left ? highlightSide(langPath, left) : Promise.resolve(null),
        right ? highlightSide(langPath, right) : Promise.resolve(null),
      ]).then(([leftTokens, rightTokens]) => {
        if (!alive) return
        setTokens({ left: leftTokens, right: rightTokens })
      })
    }, 0)

    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [parsed, langPath, truncated])

  /**
   * An empty diff means the file already matches its index side: just added to the staging area, committed,
   * or the change was unstaged. The diff has nothing left to say, so the tab is replaced by the normal file
   * view, which continues at the reader's relative position (switchRatio was captured before the refetch).
   */
  const emptyDiff = parsed !== null && parsed.rows.length === 0
  const handOver = emptyDiff && !binary && !error

  useEffect(() => {
    if (!handOver || requestedFile.current) return
    requestedFile.current = true
    void useTabs.getState().switchDiffToFile(tab.id, switchRatio.current)
  }, [handOver, tab.id])

  // Restore after a same-tab refresh: wait until the new rows have laid out
  useLayoutEffect(() => {
    // No scrollable content (loading / binary / error): drop the saved ratio instead of replaying it later
    if (error || binary) {
      pendingScroll.current = null
      return
    }
    restorePendingScroll()
  }, [display, error, binary, restorePendingScroll])

  const toggleRun = (index: number) => {
    // Settle either side's latest input before folding changes the scrollable height.
    pendingScroll.current = null
    pendingLocate.current = false
    scroll.flush()
    setCollapsed((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  /** Scroll sync: vertical and horizontal both follow, matching VSCode's side-by-side diff */
  const syncScroll = (from: 'left' | 'right') => (event: UIEvent<HTMLDivElement>) => {
    if (scroll.onScroll(from, event.currentTarget)) {
      pendingScroll.current = null
      pendingLocate.current = false
    }
  }

  /** Click the right-hand ruler: scroll the hit position to the middle of the viewport (both panes) */
  const jumpToRatio = (ratio: number) => {
    pendingScroll.current = null
    pendingLocate.current = false
    const el = leftRef.current ?? rightRef.current
    if (!el) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const top = Math.min(max, Math.max(0, ratio * el.scrollHeight - el.clientHeight / 2))
    scroll.jumpTo(top)
  }

  /** Left side is "before", right side is "after" */
  const before = tab.staged ? 'HEAD' : t('diff.index')
  const after = tab.staged ? t('diff.index') : t('diff.worktree')

  /** Deleted from the worktree, so do not offer "open file" (it would only error). Only unstaged D. */
  const goneInWorktree = useGit((s) =>
    Boolean(s.statuses[tab.root]?.changes.some((f) => f.path === tab.rel && f.status.includes('D'))),
  )

  const placeholder = (content: ReactNode) => (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-muted">
      {content}
    </div>
  )

  const stateBody = (): ReactNode => {
    if (loading) {
      return placeholder(
        <span className="inline-flex items-center gap-1.5">
          <Icon name="refresh" size={12} className="animate-spin" />
          {t('diff.loading')}
        </span>,
      )
    }
    if (error) return placeholder(<span className="text-danger">{error}</span>)
    if (binary) return placeholder(t('diff.binary'))
    // 空差异：标签页马上换成文件视图，这里只留一个过渡，不再放提示文案
    if (handOver) {
      return placeholder(
        <span className="inline-flex items-center gap-1.5">
          <Icon name="refresh" size={12} className="animate-spin" />
          {t('diff.loadingFile')}
        </span>,
      )
    }
    return null
  }

  const renderRow = (row: DisplayRow, side: 'left' | 'right') => {
    if (row.kind === 'gap') {
      return (
        <div
          key={`gap-${row.id}`}
          className="flex h-6 w-full items-center justify-center border-y border-line/40 bg-panel-alt/40 text-2xs text-muted"
        >
          {t('diff.skipped', { count: row.count })}
        </div>
      )
    }

    if (row.kind === 'fold') {
      return (
        <button
          key={`fold-${row.id}`}
          type="button"
          onClick={() => toggleRun(row.id)}
          className="flex h-6 w-full items-center justify-center gap-1 border-y border-line/40 bg-panel-alt/40 text-2xs text-muted hover:text-fg"
        >
          <Icon name={row.folded ? 'chevron-right' : 'chevron-down'} size={11} />
          {row.folded ? t('diff.expandLines', { count: row.count }) : t('diff.foldLines', { count: row.count })}
        </button>
      )
    }

    const cell = side === 'left' ? row.left : row.right
    const tone: Tone = row.changed ? (cell ? (side === 'left' ? 'del' : 'add') : 'void') : 'none'
    const sideTokens = side === 'left' ? tokens.left : tokens.right
    const lineTokens = cell && sideTokens ? (sideTokens.get(cell.no) ?? null) : null

    return (
      <div
        key={`row-${row.id}`}
        data-diff-change={row.changed ? '1' : undefined}
        className="flex w-full hover:bg-hover"
      >
        <LineNo no={cell?.no ?? null} tone={tone} />
        <Cell
          text={cell?.text ?? ''}
          tone={tone}
          inline={row.inline}
          tokens={lineTokens}
          syntax={syntax}
        />
      </div>
    )
  }

  const renderPane = (side: 'left' | 'right') => {
    const isLeft = side === 'left'
    return (
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Pane header: does not scroll with the content, so it survives narrow windows */}
        <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line/60 bg-panel px-2 text-2xs">
          <span
            className={`shrink-0 rounded-[3px] px-1 font-semibold ${
              isLeft ? 'bg-danger/15 text-danger' : 'bg-success/15 text-success'
            }`}
          >
            {isLeft ? '−' : '+'}
          </span>
          <span className="shrink-0 font-semibold text-fg/85">
            {isLeft ? t('diff.before') : t('diff.after')}
          </span>
          <span className="shrink-0 rounded-[3px] bg-panel-alt px-1 text-muted">
            {isLeft ? before : after}
          </span>
          <FileIcon name={basename(tab.rel)} size={13} className="shrink-0" />
          <span className="min-w-0 truncate text-muted/80">{basename(tab.rel)}</span>
        </div>
        <div className="flex min-h-0 flex-1">
          <div
            ref={isLeft ? leftRef : rightRef}
            onScroll={syncScroll(side)}
            className="diff-selectable min-h-0 min-w-0 flex-1 overflow-auto font-mono"
            style={{ fontSize: 'var(--text-xs)' }}
          >
            {/* Size every row to the pane's longest line, so row backgrounds also cover the empty
                horizontal tail exposed when a long line is scrolled to the right. */}
            <div className="w-max min-w-full">
              {display.map((row) => renderRow(row, side))}
            </div>
          </div>
          {rulerMarks.length > 0 ? (
            <DiffRuler marks={rulerMarks} scrollRef={isLeft ? leftRef : rightRef} onJump={jumpToRatio} />
          ) : null}
        </div>
      </div>
    )
  }

  const body = stateBody()

  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/60 px-3 text-2xs text-muted">
        <Icon name="git" size={12} className="shrink-0" />
        <span className="min-w-0 truncate text-fg/80">{tab.rel}</span>
        {tab.staged ? (
          <span className="shrink-0 rounded bg-panel-alt px-1 text-2xs text-muted">
            {t('git.section.staged')}
          </span>
        ) : null}
        {parsed && parsed.rows.length > 0 && !parsed.overLimit && !truncated ? (
          <span className="shrink-0 tabular-nums">
            <span className="text-success">+{parsed.adds}</span>{' '}
            <span className="text-danger">−{parsed.dels}</span>
          </span>
        ) : null}
        {parsed?.overLimit ? (
          <span className="shrink-0 text-warning">{t('diff.overLimit', { count: maxRows })}</span>
        ) : truncated ? (
          <span className="shrink-0 text-warning">{t('diff.truncated')}</span>
        ) : null}

        {/* Edit it directly: open this file in the worktree, which closes this diff tab (openFile does that).
            A newly opened tab starts at line 1, an already open tab returns to where it left off. */}
        {goneInWorktree ? null : (
          <button
            onClick={() =>
              void useTabs.getState().openFile(tab.root, tab.rel, { temporary: false })
            }
            data-tip={t('diff.openWorkingTip')}
            className="ml-auto flex h-5 shrink-0 items-center gap-1 rounded-[var(--r-control)] px-1.5 text-2xs text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <Icon name="pen" size={11} />
            {t('diff.openFile')}
          </button>
        )}
      </div>

      {body ?? (
        <div className="flex min-h-0 flex-1">
          {renderPane('left')}
          <div className="w-px shrink-0 bg-line" />
          {renderPane('right')}
        </div>
      )}
    </div>
  )
}

type Tone = 'add' | 'del' | 'none' | 'void'

/** One mark on the right-hand ruler: top / height are ratios in 0..1 */
type RulerMark = { top: number; height: number; kind: 'add' | 'del' | 'mod' }

/**
 * Change overview bar on the scroll container's right edge: green = add, red = delete, two colors = modify;
 * click / drag to jump. Only the viewport slider subscribes to scroll; marks stay static while scrolling.
 */
function DiffRuler({
  marks,
  scrollRef,
  onJump,
}: {
  marks: RulerMark[]
  scrollRef: RefObject<HTMLDivElement | null>
  onJump: (ratio: number) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const t = useT()

  const jump = (clientY: number) => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (!rect.height) return
    onJump(Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)))
  }

  return (
    <div
      ref={ref}
      title={t('diff.overviewTitle')}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        jump(event.clientY)
      }}
      onPointerMove={(event) => {
        if (event.buttons !== 1) return
        jump(event.clientY)
      }}
      className="relative w-[10px] shrink-0 cursor-pointer border-l border-line/40 bg-panel/40"
    >
      {/* Current viewport, a reference for "where am I in the file" */}
      <DiffViewport scrollRef={scrollRef} marks={marks} />
      {marks.map((mark, index) => (
        <span
          key={index}
          className="pointer-events-none absolute inset-x-[1px] rounded-[1px]"
          style={{
            top: `${mark.top * 100}%`,
            height: `max(2px, ${mark.height * 100}%)`,
          }}
        >
          {mark.kind === 'mod' ? (
            <span className="flex h-full w-full">
              <span className="h-full w-1/2 bg-danger/80" />
              <span className="h-full w-1/2 bg-success/80" />
            </span>
          ) : (
            <span
              className={`block h-full w-full ${
                mark.kind === 'add' ? 'bg-success/80' : 'bg-danger/80'
              }`}
            />
          )}
        </span>
      ))}
    </div>
  )
}

function DiffViewport({
  scrollRef,
  marks,
}: {
  scrollRef: RefObject<HTMLDivElement | null>
  marks: RulerMark[]
}) {
  const [viewport, setViewport] = useState({ top: 0, height: 1 })

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame: number | null = null
    const measure = () => {
      frame = null
      if (!el.scrollHeight) return
      const height = Math.min(1, el.clientHeight / el.scrollHeight)
      const top = Math.min(1 - height, Math.max(0, el.scrollTop / el.scrollHeight))
      setViewport((current) =>
        Math.abs(current.top - top) < 0.0005 && Math.abs(current.height - height) < 0.0005
          ? current
          : { top, height },
      )
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(measure)
    }
    measure()
    el.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(el)
    return () => {
      el.removeEventListener('scroll', schedule)
      observer.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [scrollRef, marks])

  return (
    <div
      className="pointer-events-none absolute inset-x-0 rounded-[1px] bg-fg/10"
      style={{ top: `${viewport.top * 100}%`, height: `${viewport.height * 100}%` }}
    />
  )
}

function LineNo({ no, tone }: { no: number | null; tone: Tone }) {
  const color =
    tone === 'del' ? 'text-danger/70' : tone === 'add' ? 'text-success/70' : 'text-muted/50'
  const bg = tone === 'del' ? 'bg-danger/10' : tone === 'add' ? 'bg-success/10' : ''
  return (
    <span
      className={`diff-line-no w-11 shrink-0 pr-2 text-right leading-[1.6] tabular-nums ${color} ${bg}`}
    >
      {no ?? ''}
    </span>
  )
}

/** A piece of text to render: syntax cls (null = default foreground) and whether it falls inside the inline diff range */
type Piece = { text: string; cls: string | null; marked: boolean }

/**
 * Cut "syntax segments" and "inline diff ranges" at the union of their boundaries into non-overlapping
 * pieces, so colors (tokens) and backgrounds (inline diff) can stack.
 */
function buildPieces(text: string, tokens: Token[] | null, inline: Inline | null): Piece[] {
  if (!text) return []
  const markFrom = inline ? inline.prefix : 0
  const markTo = inline ? text.length - inline.suffix : text.length

  const cuts = new Set<number>([0, text.length])
  if (inline) {
    cuts.add(markFrom)
    cuts.add(markTo)
  }
  if (tokens) {
    for (const token of tokens) {
      cuts.add(Math.max(0, Math.min(text.length, token.from)))
      cuts.add(Math.max(0, Math.min(text.length, token.to)))
    }
  }

  const points = Array.from(cuts).sort((a, b) => a - b)
  const out: Piece[] = []
  let cursor = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = points[i]
    const to = points[i + 1]
    if (to <= from) continue

    let cls: string | null = null
    if (tokens) {
      while (cursor < tokens.length && tokens[cursor].to <= from) cursor += 1
      const token = tokens[cursor]
      if (token && token.from <= from && token.to >= to) cls = token.cls
    }

    const marked = inline !== null && from >= markFrom && to <= markTo
    const last = out[out.length - 1]
    if (last && last.cls === cls && last.marked === marked) last.text += text.slice(from, to)
    else out.push({ text: text.slice(from, to), cls, marked })
  }
  return out
}

/** One code line: tone sets the row background, inline deepens only the changed slice, tokens pick syntax colors. */
function Cell({
  text,
  tone,
  inline,
  tokens,
  syntax,
}: {
  text: string
  tone: Tone
  inline?: Inline | null
  tokens: Token[] | null
  syntax: SyntaxColors
}) {
  const bg =
    tone === 'add'
      ? 'bg-success/10'
      : tone === 'del'
        ? 'bg-danger/10'
        : tone === 'void'
          ? 'bg-panel-alt/40'
          : ''
  const markBg = tone === 'add' ? 'bg-success/30' : tone === 'del' ? 'bg-danger/30' : ''

  if (!text) {
    return <span className={`flex-1 whitespace-pre pr-3 leading-[1.6] ${bg}`}>{' '}</span>
  }

  const pieces = buildPieces(text, tokens, inline ?? null)
  return (
    <span className={`flex-1 whitespace-pre pr-3 leading-[1.6] text-fg/90 ${bg}`}>
      {pieces.map((piece, index) => {
        const style = piece.cls ? diffTokenStyle(piece.cls, syntax) : null
        if (!style && !piece.marked) return piece.text
        return (
          <span
            key={index}
            style={style ?? undefined}
            className={piece.marked ? `rounded-[2px] ${markBg}` : undefined}
          >
            {piece.text}
          </span>
        )
      })}
    </span>
  )
}
