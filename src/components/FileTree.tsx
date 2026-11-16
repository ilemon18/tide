import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace, type DirState, type RootNode } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useGit } from '../store/git'
import { useUi } from '../store/ui'
import type { GitStatus } from '../lib/ipc'
import { FileIcon } from './FileIcon'
import { Icon, type IconName } from './Icon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { deleteEntryFlow, newEntry, revealEntry } from '../lib/actions'
import { useTabs } from '../store/tabs'
import { useSearch } from '../store/search'
import { useTerminal } from '../store/terminal'
import { useFolderChain } from '../store/folderChain'
import { openFolderDialog } from '../lib/actions'
import { beginFilePointerDrag, wasFileDragJustFinished } from '../lib/fileDragState'
import { dirname, parentChain, basename, isUnder } from '../lib/paths'
import { shortcutKey } from '../lib/keys'
import { t as translate, useLocale, useT } from '../i18n'

const ROW_H = 24
const OVERSCAN = 10
const INDENT = 14

/**
 * The sidebar shows one view at a time (explorer / search / git), so switching to search or the Git panel
 * unmounts the tree. Its offset, the highlighted row and the "already followed this file" marker are kept out
 * here, else coming back started at the top of the list with nothing marked as open.
 */
let remembered = { roots: '', top: 0, followed: '', selected: '' }

/** Git status colors in the file tree, same values as the GitPanel badges */
type MarkKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted'

const MARK_CLASS: Record<MarkKind, string> = {
  modified: 'text-warning',
  added: 'text-success',
  deleted: 'text-danger',
  renamed: 'text-accent',
  conflicted: 'text-danger',
}

/** Dot on a directory's right side: same semantic colors as the file name coloring */
const DOT_CLASS: Record<MarkKind, string> = {
  modified: 'bg-warning',
  added: 'bg-success',
  deleted: 'bg-danger',
  renamed: 'bg-accent',
  conflicted: 'bg-danger',
}

/** Files: added wins (an M after an A still shows green); directories: deleted / modified rank higher */
const FILE_RANK: Record<MarkKind, number> = {
  conflicted: 5,
  added: 4,
  modified: 3,
  deleted: 2,
  renamed: 1,
}

const DIR_RANK: Record<MarkKind, number> = {
  conflicted: 5,
  deleted: 4,
  modified: 3,
  added: 2,
  renamed: 1,
}

function markOfStatus(status: string): MarkKind | null {
  // A conflict is a two-letter XY (UU / AA / DU / ...), marked in red on its own
  if (status.length === 2) return 'conflicted'
  switch (status) {
    case 'M':
    case 'T':
      return 'modified'
    case 'A':
    case '?':
      return 'added'
    case 'D':
    case 'U':
      return 'deleted'
    case 'R':
    case 'C':
      return 'renamed'
    default:
      return null
  }
}

type GitMarks = {
  files: Map<string, MarkKind>
  dirs: Map<string, MarkKind>
}

function better(
  current: MarkKind | undefined,
  next: MarkKind,
  rank: Record<MarkKind, number>,
): MarkKind {
  if (!current) return next
  return rank[next] > rank[current] ? next : current
}

/** Flatten statuses once into "file -> mark" and "dir -> mark" so rows do not re-scan them */
function buildGitMarks(statuses: Record<string, GitStatus>): GitMarks {
  const files = new Map<string, MarkKind>()
  const dirs = new Map<string, MarkKind>()
  for (const [root, status] of Object.entries(statuses)) {
    if (!status?.isRepo) continue
    for (const file of [
      ...status.staged,
      ...status.changes,
      ...status.untracked,
      ...status.conflicts,
    ]) {
      const kind = markOfStatus(file.status)
      if (!kind) continue
      const key = `${root}:${file.path}`
      files.set(key, better(files.get(key), kind, FILE_RANK))
      // The file itself is already colored; only fill in its ancestor directories (incl. project root)
      const segments = file.path.split('/')
      segments.pop()
      for (let i = 0; i <= segments.length; i += 1) {
        const dirKey = `${root}:${segments.slice(0, i).join('/')}`
        dirs.set(dirKey, better(dirs.get(dirKey), kind, DIR_RANK))
      }
    }
  }
  return { files, dirs }
}

/** Strongest mark along a folder chain: a merged row must show that something inside it changed */
function chainMark(
  marks: GitMarks,
  root: string,
  start: string,
  end: string,
): MarkKind | undefined {
  let best: MarkKind | undefined
  const consider = (rel: string) => {
    const mark = marks.dirs.get(`${root}:${rel}`)
    if (mark && (!best || DIR_RANK[mark] > DIR_RANK[best])) best = mark
  }
  consider(start)
  if (end !== start) {
    let acc = start
    for (const segment of end.slice(start.length + 1).split('/')) {
      acc = `${acc}/${segment}`
      consider(acc)
    }
  }
  return best
}

type Row =
  | {
      kind: 'node'
      key: string
      root: string
      rel: string
      /** Rel as listed by the parent dir; differs from `rel` when a folder chain was merged */
      start: string
      name: string
      isDir: boolean
      depth: number
      ignored: boolean
    }
  | { kind: 'more'; key: string; root: string; rel: string; depth: number; label: string }

/** `express/base` for a folder merged up to `base`; plain `express` when the chain ends there */
function compactName(name: string, rel: string, deepest: string): string {
  if (deepest.length <= rel.length) return name
  return `${name}/${deepest.slice(rel.length + 1)}`
}

function buildRows(
  roots: RootNode[],
  showHidden: boolean,
  compact: boolean,
  chains: Record<string, string>,
): Row[] {
  const rows: Row[] = []

  for (const node of roots) {
    // The project name shows in the sidebar header, so the tree keeps no root row
    if (node.collapsed) continue

    const walk = (rel: string, depth: number) => {
      const state: DirState | undefined = node.tree[rel]
      if (!state) return
      const entries = showHidden ? state.entries : state.entries.filter((e) => !e.name.startsWith('.'))
      for (const entry of entries) {
        // Compacted folders draw as one row: the row (and its expand/rename/context actions) targets the
        // deepest folder of the chain, so no intermediate row is emitted at all
        let target = entry.path
        if (compact && entry.isDir) {
          // Unknown chain: draw the plain folder for now, the caller resolves it for visible rows
          target = chains[`${node.id}:${entry.path}`] ?? entry.path
        }
        rows.push({
          kind: 'node',
          key: `${node.id}:${target}`,
          root: node.id,
          rel: target,
          start: entry.path,
          name: compact ? compactName(entry.name, entry.path, target) : entry.name,
          isDir: entry.isDir,
          depth,
          ignored: entry.ignored,
        })
        if (entry.isDir && node.expanded[target]) walk(target, depth + 1)
      }
      if (state.hasMore) {
        rows.push({
          kind: 'more',
          key: `${node.id}:${rel}::more`,
          root: node.id,
          rel,
          depth,
          label: translate('explorer.loadMore', { loaded: state.entries.length, total: state.total }),
        })
      }
    }
    walk('', 0)
  }

  return rows
}

export function FileTree() {
  const t = useT()
  const locale = useLocale()
  const roots = useWorkspace((s) => s.roots)
  const showHidden = useSettings((s) => s.showHidden)
  const compactFolders = useSettings((s) => s.compactFolders)
  const chains = useFolderChain((s) => s.chains)
  const toggleDir = useWorkspace((s) => s.toggleDir)
  const loadMore = useWorkspace((s) => s.loadMore)
  const toggleRootCollapsed = useWorkspace((s) => s.toggleRootCollapsed)
  const moveEntry = useWorkspace((s) => s.moveEntry)
  const treeReveal = useWorkspace((s) => s.treeReveal)
  const openFile = useTabs((s) => s.openFile)
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId) ?? null)

  const [selected, setSelected] = useState<string | null>(remembered.selected || null)
  const [renaming, setRenaming] = useState<{ root: string; rel: string } | null>(null)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    root: string
    rel: string
    isDir: boolean
  } | null>(null)
  const [scrollTop, setScrollTop] = useState(remembered.top)
  const [viewportH, setViewportH] = useState(600)
  const rootKey = useMemo(() => roots.map((root) => root.id).join('|'), [roots])

  const containerRef = useRef<HTMLDivElement>(null)
  const handledReveal = useRef(0)
  /** The file the list was last scrolled to: survives the view switch, so coming back does not re-follow */
  const followed = useRef(remembered.followed)
  /** The first run of "scroll the selection into view" must not move the list: the restored offset wins */
  const skipSelectScroll = useRef(true)
  const activeRoot = activeTab?.root ?? null
  const activeRel =
    activeTab && activeTab.kind !== 'welcome' && activeTab.kind !== 'settings' ? activeTab.rel : null
  const rows = useMemo(
    () => buildRows(roots, showHidden, compactFolders, chains),
    [roots, showHidden, compactFolders, chains, locale],
  )
  const statuses = useGit((s) => s.statuses)
  const marks = useMemo(() => buildGitMarks(statuses), [statuses])

  // The list can shrink under a scrolled viewport (folder compaction merging rows, collapsing, a refresh
  // replacing the tree). The offset then sits past the new content height: the browser cannot clamp it
  // because absolutely positioned rows keep stretching the scroll area. Pull it back before painting.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const max = Math.max(0, rows.length * ROW_H - el.clientHeight)
    if (el.scrollTop > max) el.scrollTop = max
    if (scrollTop > max) setScrollTop(max)
  }, [rows.length, scrollTop])

  // Chain results depend on whether hidden entries count: drop them when the setting flips
  const prevShowHidden = useRef(showHidden)
  useEffect(() => {
    if (prevShowHidden.current === showHidden) return
    prevShowHidden.current = showHidden
    const store = useFolderChain.getState()
    for (const root of useWorkspace.getState().roots) store.invalidate(root.id)
  }, [showHidden])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight))
    ro.observe(el)
    setViewportH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  // Coming back from search / Git: put the list where the user left it, before the first paint (a later
  // effect would draw the top of the tree for one frame and then jump). A different project has different
  // rows, so its offset is not reused.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const sameProject = remembered.roots === rootKey
    if (!sameProject) {
      remembered = { roots: rootKey, top: 0, followed: '', selected: '' }
      followed.current = ''
      setScrollTop(0)
      setSelected(null)
    }
    // The row of the file that is open in the editor stays marked (VSCode does this): after a view switch the
    // tree otherwise looked as if nothing was open. A remembered row that still exists wins over it.
    const activeKey = activeRoot && activeRel ? `${activeRoot}:${activeRel}` : null
    const kept = sameProject && remembered.selected && rows.some((row) => row.key === remembered.selected)
    if (!kept && activeKey && rows.some((row) => row.key === activeKey)) setSelected(activeKey)
    if (!sameProject || remembered.top <= 0) return
    const max = Math.max(0, rows.length * ROW_H - el.clientHeight)
    const top = Math.min(remembered.top, max)
    el.scrollTop = top
    setScrollTop(top)
    // Mount only: later row rebuilds must not yank the list back here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Breadcrumb click: expand the directory chain level by level, then select the target; refresh the
  // parent when the cache missed
  useEffect(() => {
    if (!treeReveal || treeReveal.nonce === handledReveal.current) return
    handledReveal.current = treeReveal.nonce
    const { root, rel, isDir, nonce } = treeReveal
    const ws = useWorkspace.getState()
    const node = ws.roots.find((r) => r.id === root)
    if (!node) {
      ws.clearTreeReveal(nonce)
      return
    }
    if (node.collapsed) ws.toggleRootCollapsed(root)

    const chain = parentChain(rel)
    // A directory target expands itself; a file target expands only its parent
    const dirs = isDir ? chain : chain.slice(0, -1)
    void (async () => {
      // Expand the whole chain at once: awaiting each level makes directories pop out one by one,
      // which looks like a stuttering animation
      await ws.expandChain(root, dirs)
      if (rel) {
        const parent = dirname(rel)
        const entries =
          useWorkspace.getState().roots.find((r) => r.id === root)?.tree[parent]?.entries ?? []
        // Parent was a cache hit (not re-read): the target may be just created / renamed, so refetch once
        if (!entries.some((entry) => entry.path === rel)) await ws.refreshDir(root, parent)
      }
      // If something else was clicked meanwhile, the old request must not override the new selection
      if (useWorkspace.getState().treeReveal?.nonce !== nonce) return
      setSelected(rel ? `${root}:${rel}` : null)
      ws.clearTreeReveal(nonce)
    })()
  }, [treeReveal])

  // A selection can point inside a merged folder chain (breadcrumb click on a middle folder): fold it onto
  // the row that is actually drawn, so the highlight and the scroll-into-view keep working. Only merged rows
  // count, otherwise a selection hidden by a collapsed parent would jump to that parent.
  useEffect(() => {
    if (!compactFolders || !selected || rows.some((row) => row.key === selected)) return
    let best: { root: string; rel: string } | null = null
    for (const row of rows) {
      if (row.kind !== 'node' || !row.isDir || row.start === row.rel) continue
      const prefix = `${row.root}:`
      if (!selected.startsWith(prefix)) continue
      const selRel = selected.slice(prefix.length)
      if (!isUnder(selRel, row.rel)) continue
      if (!best || row.rel.length > best.rel.length) best = { root: row.root, rel: row.rel }
    }
    if (best) setSelected(`${best.root}:${best.rel}`)
  }, [compactFolders, selected, rows])

  // Clamp the window to real rows: a stale offset (list shrank under the cursor) would otherwise place
  // virtual rows past the new content height, and absolutely positioned rows inflate the scroll area —
  // the pane then scrolls far past the last entry with a thumb that suggests far more content
  const maxScroll = Math.max(0, rows.length * ROW_H - viewportH)
  const windowTop = Math.min(scrollTop, maxScroll)
  const start = Math.max(0, Math.floor(windowTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((windowTop + viewportH) / ROW_H) + OVERSCAN)
  const visible = rows.slice(start, end)

  // Folder chains are resolved only for the rows on screen: an "expand all" tree can hold hundreds of
  // folders, and each probe costs one round-trip even though it never leaves the disk cache
  useEffect(() => {
    if (!compactFolders) return
    const store = useFolderChain.getState()
    for (const row of visible) {
      if (row.kind !== 'node' || !row.isDir) continue
      if (`${row.root}:${row.start}` in chains) continue
      store.resolve(row.root, row.start, showHidden)
    }
  }, [visible, chains, compactFolders, showHidden])

  // An empty tree has three different causes: project collapsed / not read yet / truly no files.
  // Sharing one "empty directory" message would make users think the project was wiped.
  const allCollapsed = roots.length > 0 && roots.every((root) => root.collapsed)
  const rootLoaded = roots.every((root) => root.collapsed || Boolean(root.tree['']))

  // Scroll the selected row into place before paint: in useEffect it would draw one frame at the old
  // Keep the highlighted row for the next mount (the sidebar unmounts when search / Git is shown)
  useEffect(() => {
    remembered.selected = selected ?? ''
  }, [selected])

  // position first and then jump, which looks like a scroll animation
  useLayoutEffect(() => {
    if (!selected) return
    // First run after mounting: the list was just put back where the user left it, and scrolling to the
    // restored selection would throw that away
    if (skipSelectScroll.current) {
      skipSelectScroll.current = false
      return
    }
    const index = rows.findIndex((r) => r.key === selected)
    if (index === -1) return
    const el = containerRef.current
    if (!el) return
    const top = index * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
  }, [selected, rows])

  // With many files open the tree is often scrolled away from the current one: bring the active file back into
  // view. Expansion is left untouched on purpose — only the scroll moves, and once a file was followed the user
  // keeps control (a row rebuild must not yank the view again)
  useLayoutEffect(() => {
    if (!activeRoot || !activeRel) return
    const key = `${activeRoot}:${activeRel}`
    if (key === followed.current) return

    const el = containerRef.current
    if (!el) return
    const viewTop = el.scrollTop
    const viewBottom = viewTop + el.clientHeight
    const isVisible = (index: number) =>
      index >= 0 && index * ROW_H < viewBottom && (index + 1) * ROW_H > viewTop

    // The file's own row is the target. This used to scroll to the deepest folder row above the file instead,
    // which is often far above the viewport (a merged chain row like `src`, or the folder the user just
    // scrolled into): clicking a file that was already on screen yanked the list upwards and read as
    // "the tree jumped back to the top".
    let index = rows.findIndex(
      (row) => row.kind === 'node' && !row.isDir && row.root === activeRoot && row.rel === activeRel,
    )
    if (index === -1) {
      // File row not drawn (collapsed parent / merged chain): fall back to the deepest folder row holding it
      let bestLen = -1
      rows.forEach((row, i) => {
        if (row.kind !== 'node' || !row.isDir || row.root !== activeRoot) return
        if (!isUnder(activeRel, row.rel) || row.rel.length <= bestLen) return
        bestLen = row.rel.length
        index = i
      })
    }
    // Nothing drawn for this file yet: retry when the rows change
    if (index === -1) return

    followed.current = key
    remembered.followed = key
    // Already on screen: leave the list exactly where the user left it
    if (isVisible(index)) return

    const top = index * ROW_H
    const bottom = top + ROW_H
    if (top < viewTop) el.scrollTop = top
    else if (bottom > viewBottom) el.scrollTop = bottom - el.clientHeight
  }, [activeRoot, activeRel, rows])

  const openRow = (row: Row) => {
    if (row.kind === 'more') {
      void loadMore(row.root, row.rel)
      return
    }
    if (row.isDir) void toggleDir(row.root, row.rel)
    else void openFile(row.root, row.rel)
  }

  const searchInFolder = (root: string, rel: string) => {
    useSearch.getState().setScope({ root, rel })
    useUi.getState().setActivityView('search')
    void useSearch.getState().run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const index = rows.findIndex((r) => r.key === selected)
    const row = index >= 0 ? rows[index] : null

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      const next = rows[Math.min(rows.length - 1, index + 1)]
      if (next) setSelected(next.key)
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const prev = rows[Math.max(0, index - 1)]
      if (prev) setSelected(prev.key)
      return
    }
    if (e.key === 'ArrowRight' && row) {
      e.preventDefault()
      if (row.kind === 'node' && row.isDir) {
        const node = roots.find((r) => r.id === row.root)
        if (node && !node.expanded[row.rel]) void toggleDir(row.root, row.rel)
        else {
          const child = rows[index + 1]
          if (child) setSelected(child.key)
        }
      }
      return
    }
    if (e.key === 'ArrowLeft' && row) {
      e.preventDefault()
      if (row.kind === 'node') {
        const node = roots.find((r) => r.id === row.root)
        if (row.isDir && node?.expanded[row.rel]) void toggleDir(row.root, row.rel)
        else {
          const parent = rows
            .slice(0, index)
            .reverse()
            .find(
              (r) =>
                r.kind === 'node' &&
                r.root === row.root &&
                row.rel.startsWith(r.rel + '/'),
            )
          if (parent) setSelected(parent.key)
        }
      }
      return
    }
    // ⌘↓ follows Finder's "Open": open a file / expand a directory; Enter is used for renaming
    if ((e.metaKey || e.ctrlKey) && e.key === 'ArrowDown' && row) {
      e.preventDefault()
      openRow(row)
      return
    }
    // Enter follows Finder: it renames the selection (whole name selected),
    // while opening is left to ⌘↓, single click and double click.
    if (e.key === 'Enter' && row) {
      e.preventDefault()
      if (row.kind === 'node') setRenaming({ root: row.root, rel: row.rel })
      else openRow(row)
      return
    }
    // ⌘R / ⌃R renames (that combo means "rename symbol" in VSCode, but this tree has no symbols,
    // so renaming is a better fit); F2 also works
    if ((e.metaKey || e.ctrlKey) && shortcutKey(e) === 'r' && row?.kind === 'node') {
      e.preventDefault()
      e.stopPropagation()
      setRenaming({ root: row.root, rel: row.rel })
      return
    }
    if (e.key === 'F2' && row?.kind === 'node') {
      e.preventDefault()
      setRenaming({ root: row.root, rel: row.rel })
      return
    }
    // ⌘⌫ (macOS) / Delete (Windows habit) deletes the selection, matching VSCode's explorer.
    // Plain ⌫ does not delete: on macOS that is backspace and a mispress is too costly.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'Backspace' || e.key === 'Delete') && row?.kind === 'node') {
      e.preventDefault()
      e.stopPropagation()
      void deleteEntryFlow(row.root, row.rel)
      return
    }
    if (e.key === 'Delete' && row?.kind === 'node') {
      e.preventDefault()
      void deleteEntryFlow(row.root, row.rel)
    }
  }

  if (roots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-sm text-muted">{t('explorer.empty')}</p>
        <button
          onClick={() => void openFolderDialog()}
          className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg"
        >
          {t('explorer.openFolder')}
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={containerRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => {
          const top = e.currentTarget.scrollTop
          remembered.top = top
          setScrollTop(top)
        }}
        className="tree-pane min-h-0 flex-1 overflow-x-auto overflow-y-auto outline-none"
      >
        <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
          {visible.map((row, i) => {
            const top = (start + i) * ROW_H
            const mark =
              row.kind === 'node'
                ? row.isDir
                  ? chainMark(marks, row.root, row.start, row.rel)
                  : marks.files.get(`${row.root}:${row.rel}`)
                : undefined
            // A merged row's name is the whole chain (`com/lm/base`), so the icon and the rename box follow
            // the deepest folder's own name
            const baseName = row.kind === 'node' ? basename(row.rel) : row.label

            const isOpen = row.kind === 'node' && row.isDir && Boolean(roots.find((r) => r.id === row.root)?.expanded[row.rel])
            const paddingLeft = 4 + (row.kind === 'more' ? row.depth + 1 : row.depth) * INDENT + 12

            return (
              <div
                key={row.key}
                style={{
                  position: 'absolute',
                  top,
                  left: 6,
                  // No right / width: width follows content (narrow rows fill the space, long names extend)
                  // so the x scrollbar only appears when it truly does not fit
                  minWidth: 'calc(100% - 12px)',
                  height: ROW_H,
                  paddingLeft,
                }}
                data-selected={selected === row.key}
                /* Folder rows accept a dragged file / folder (move): resolved by lib/fileDragState via elementFromPoint */
                data-drop-dir={row.kind === 'node' && row.isDir ? 'true' : undefined}
                data-drop-root={row.kind === 'node' && row.isDir ? row.root : undefined}
                data-drop-rel={row.kind === 'node' && row.isDir ? row.rel : undefined}
                onPointerDown={(e) => {
                  // Rows can be dragged: a file opens in a pane / moves into a folder, a folder only moves
                  if (row.kind !== 'node') return
                  // Do not start a drag from the icon (expand arrow) or the rename input
                  if ((e.target as HTMLElement).closest('button, input')) return
                  setSelected(row.key)
                  beginFilePointerDrag(
                    e,
                    { root: row.root, rel: row.rel, name: row.name, isDir: row.isDir },
                    {
                      // Released over a folder row: move the file there instead of opening it
                      onDropDir: (target) => {
                        void moveEntry(row.root, row.rel, target.rel).then((to) => {
                          if (to) useTabs.getState().onRenamed(row.root, row.rel, to)
                        })
                      },
                    },
                  )
                }}
                onClick={() => {
                  // The last gesture was a drag: do not open the row again on release
                  if (wasFileDragJustFinished()) return
                  setSelected(row.key)
                  openRow(row)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (row.kind !== 'node') return
                  setSelected(row.key)
                  setMenu({ x: e.clientX, y: e.clientY, root: row.root, rel: row.rel, isDir: row.isDir })
                }}
                className={`tree-row group relative flex cursor-default items-center gap-1.5 pr-2 text-sm ${
                  selected === row.key ? 'text-fg' : 'text-fg/90'
                } ${row.kind === 'more' ? 'text-muted' : ''} ${
                  row.kind === 'node' && row.ignored ? 'opacity-45' : ''
                }`}
              >
                {row.kind === 'node' ? (
                  row.isDir ? (
                    <Icon
                      name={isOpen ? 'chevron-down' : 'chevron-right'}
                      size={13}
                      className="shrink-0 text-muted"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSelected(row.key)
                        void toggleDir(row.root, row.rel)
                      }}
                    />
                  ) : (
                    <span className="w-[13px] shrink-0" />
                  )
                ) : (
                  <Icon name="refresh" size={12} className="shrink-0 text-muted" />
                )}

                {row.kind === 'node' ? (
                  <FileIcon name={baseName} isDir={row.isDir} isOpen={isOpen} size={16} />
                ) : null}

                {renaming && row.kind === 'node' && renaming.root === row.root && renaming.rel === row.rel ? (
                  <RenameInput
                    initial={baseName}
                    onDone={(value) => {
                      const target = renaming
                      setRenaming(null)
                      if (value && value !== baseName && target) {
                        void useWorkspace
                          .getState()
                          .renameEntry(target.root, target.rel, value)
                          .then((to) => {
                            if (to) useTabs.getState().onRenamed(target.root, target.rel, to)
                          })
                      }
                    }}
                  />
                ) : (
                  <span
                    className={`whitespace-nowrap ${row.kind === 'node' && row.isDir ? 'font-medium' : ''} ${
                      mark ? MARK_CLASS[mark] : ''
                    }`}
                  >
                    {row.kind === 'more' ? row.label : row.name}
                  </span>
                )}

                {/* Small dot on the right when a directory has Git changes (VSCode habit) */}
                {row.kind === 'node' && row.isDir && mark ? (
                  <span
                    className={`ml-auto mr-1 h-[6px] w-[6px] shrink-0 rounded-full ${DOT_CLASS[mark]}`}
                    aria-hidden="true"
                  />
                ) : null}

                </div>
            )
          })}
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-muted">
            {allCollapsed ? (
              <button
                type="button"
                onClick={() => {
                  for (const root of roots) if (root.collapsed) toggleRootCollapsed(root.id)
                }}
                className="rounded-[var(--r-row)] px-2 py-1 transition-colors duration-fast hover:bg-hover hover:text-fg"
              >
                {t('explorer.collapsed')}
              </button>
            ) : rootLoaded ? (
              t('explorer.emptyDir')
            ) : (
              t('explorer.reading')
            )}
          </div>
        ) : null}
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={
            [
                  ...(menu.isDir
                    ? ([
                        { label: t('explorer.newFile'), onClick: () => void newEntry(menu.root, menu.rel, 'file') },
                        { label: t('explorer.newFolder'), onClick: () => void newEntry(menu.root, menu.rel, 'dir') },
                        { type: 'separator' },
                        { label: t('explorer.searchInFolder'), onClick: () => searchInFolder(menu.root, menu.rel) },
                        {
                          label: t('explorer.openTerminalHere'),
                          onClick: () => useTerminal.getState().open(menu.root, menu.rel),
                        },
                        { type: 'separator' },
                      ] as MenuItem[])
                    : []),
                  { label: t('explorer.rename'), shortcut: '⌘R / F2', onClick: () => setRenaming({ root: menu.root, rel: menu.rel }) },
                  { label: t('explorer.delete'), shortcut: '⌘⌫', danger: true, onClick: () => void deleteEntryFlow(menu.root, menu.rel) },
                  { type: 'separator' },
                  { label: t('explorer.revealInFinder'), onClick: () => void revealEntry(menu.root, menu.rel) },
                  {
                    label: t('explorer.copyRelativePath'),
                    onClick: () => void navigator.clipboard?.writeText(menu.rel),
                  },
                  {
                    label: t('explorer.copyAbsolutePath'),
                    onClick: () => void navigator.clipboard?.writeText(`${menu.root}/${menu.rel}`),
                  },
                  {
                    label: t('explorer.copyName'),
                    onClick: () => void navigator.clipboard?.writeText(basename(menu.rel)),
                  },
                ] as MenuItem[]
          }
        />
      ) : null}
    </div>
  )
}


function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    // Select the whole name for both files and directories: renaming usually replaces it entirely,
    // and stopping before the extension would leave a ".ts" tail in the box.
    el.select()
  }, [initial])

  return (
    <input
      ref={ref}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(value.trim())}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') onDone(value.trim())
        if (e.key === 'Escape') onDone(null)
      }}
      className="min-w-[100px] flex-1 rounded-[4px] border border-accent bg-bg px-1 py-[1px] text-sm outline-none"
    />
  )
}

/** Common actions in the sidebar header */
export function ExplorerHeader() {
  const t = useT()
  const roots = useWorkspace((s) => s.roots)
  const activeRootId = useWorkspace((s) => s.activeRootId)
  const refreshTree = useWorkspace((s) => s.refreshTree)
  const collapseAll = useWorkspace((s) => s.collapseAll)
  const expandAll = useWorkspace((s) => s.expandAll)
  const toggleRootCollapsed = useWorkspace((s) => s.toggleRootCollapsed)
  const showHidden = useSettings((s) => s.showHidden)
  const [expanding, setExpanding] = useState(false)
  const root = roots.find((r) => r.id === activeRootId) ?? roots[0] ?? null

  // With any subdirectory expanded we treat the tree as expanded and switch the button to "collapse all"
  const expandedCount = root
    ? Object.keys(root.expanded).filter((key) => key && root.expanded[key]).length
    : 0
  const isExpanded = Boolean(root && !root.collapsed && expandedCount > 0)

  const toggleAll = async () => {
    if (!root || expanding) return
    if (isExpanded) {
      collapseAll()
      return
    }
    setExpanding(true)
    try {
      await expandAll(root.id, showHidden)
    } finally {
      setExpanding(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 items-center gap-2">
      {/* Project name: the tree's root row is gone, so this doubles as the whole tree's collapse toggle */}
      <button
        type="button"
        onClick={() => {
          if (root) toggleRootCollapsed(root.id)
        }}
        data-tip={root?.id ?? t('app.project')}
        data-tip-side="bottom"
        aria-label={t('explorer.toggleProjectAria')}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-[var(--r-row)] px-1 py-[2px] text-left text-xs font-semibold text-fg/85 transition-colors duration-fast hover:bg-hover hover:text-fg"
      >
        <Icon
          name={root?.collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
          className="shrink-0 text-muted"
        />
        <span className="min-w-0 truncate">{root?.name ?? t('explorer.noProject')}</span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5">
        <HeaderButton icon="plus" tip={t('explorer.newFileTip')} onClick={() => void newEntry(root?.id ?? null, '', 'file')} disabled={!root} />
        <HeaderButton
          icon="folder-plus"
          tip={t('explorer.newFolderTip')}
          onClick={() => void newEntry(root?.id ?? null, '', 'dir')}
          disabled={!root}
        />
        <HeaderButton icon="refresh" tip={t('explorer.refreshTip')} onClick={() => void refreshTree()} disabled={!root} />
        <HeaderButton
          icon={expanding ? 'spinner' : isExpanded ? 'collapse' : 'expand'}
          tip={isExpanded ? t('explorer.collapseAll') : t('explorer.expandAll')}
          onClick={() => void toggleAll()}
          disabled={!root}
          className={expanding ? 'animate-spin' : undefined}
        />
      </div>
    </div>
  )
}

export function HeaderButton({
  icon,
  tip,
  onClick,
  disabled,
  className,
}: {
  icon: IconName
  tip: string
  onClick: () => void
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      data-tip={tip}
      data-tip-side="bottom"
      aria-label={tip}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent ${className ?? ''}`}
    >
      <Icon name={icon} size={16} />
    </button>
  )
}