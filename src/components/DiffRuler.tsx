import { useEffect, useState } from 'react'
import { api } from '../lib/ipc'
import { useGit } from '../store/git'
import { useTabs, type TabGroupId } from '../store/tabs'
import { useT } from '../i18n'

/**
 * The "change overview" bar on the editor's right edge (VSCode's overview ruler).
 *
 * Data comes from git's full-context patch (-U100000): line numbers on the new side are editor line
 * numbers, so no diff algorithm is needed in the frontend. It reads disk content, so unsaved edits
 * only show up after saving.
 */

export type DiffMark = { from: number; to: number; kind: 'add' | 'mod' | 'del' }

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Derive change positions from the full patch: consecutive `+` lines = add (a `-` in the same group
 * makes it a mod); only `-` lines = pure delete (placed just before the line after the deletion).
 * `lines` is the new file's line count, used for percentages.
 */
export function parseDiffMarks(patch: string): { marks: DiffMark[]; lines: number } {
  const marks: DiffMark[] = []
  let newLine = 0
  let adds: number[] = []
  let dels = 0
  let inHunk = false

  const flush = () => {
    if (adds.length > 0) {
      marks.push({ from: adds[0], to: adds[adds.length - 1], kind: dels > 0 ? 'mod' : 'add' })
    } else if (dels > 0) {
      const at = Math.max(1, newLine)
      marks.push({ from: at, to: at, kind: 'del' })
    }
    adds = []
    dels = 0
  }

  for (const line of patch.split('\n')) {
    if (!line) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      flush()
      newLine = Number(hunk[1])
      inHunk = true
      continue
    }
    if (!inHunk) continue
    // "\ No newline at end of file" is not a content line
    if (line.startsWith('\\')) continue
    if (line.startsWith('+')) {
      adds.push(newLine)
      newLine += 1
    } else if (line.startsWith('-')) {
      dels += 1
    } else {
      // Context line (starts with a space in a unified diff)
      flush()
      newLine += 1
    }
  }
  flush()
  return { marks, lines: Math.max(0, newLine - 1) }
}

type Props = {
  root: string
  rel: string
  /** Recompute after saving (dirty goes true -> false) */
  dirty: boolean
  /** mtime changes on external edits / saves, so recompute too */
  mtime: number
  /** Clicking a mark jumps to this tab (with split panes it must name the group and tab) */
  tabId: string
  groupId: TabGroupId
}

export function DiffRuler({ root, rel, dirty, mtime, tabId, groupId }: Props) {
  const t = useT()
  const epoch = useTabs((s) => (s.diffEpoch[root] ?? 0) + (s.diffEpoch[tabId] ?? 0))
  const status = useGit((s) => s.statuses[root])
  const key = `${root}\u0000${rel}`

  const [state, setState] = useState<{ key: string; marks: DiffMark[]; lines: number }>({
    key: '',
    marks: [],
    lines: 0,
  })

  // Untracked / freshly staged new file: git diff is empty, but the whole file counts as added
  const isNew =
    Boolean(status?.untracked.some((file) => file.path === rel)) ||
    Boolean(status?.staged.some((file) => file.path === rel && file.status.trim().startsWith('A')))

  useEffect(() => {
    if (isNew) return
    let alive = true

    /**
     * Prefer "worktree vs index" (line numbers on the new side are editor line numbers); when every
     * change is staged the worktree side is empty, so fall back to "index vs HEAD", same line numbers.
     */
    const load = async (): Promise<string> => {
      const plain = await api.gitDiffFull(root, rel, false)
      if (plain.binary || plain.truncated) return ''
      if (plain.patch.trim()) return plain.patch
      const staged = await api.gitDiffFull(root, rel, true)
      if (staged.binary || staged.truncated) return ''
      return staged.patch
    }

    // Saving is a chain of "write disk -> refresh git status"; wait a bit to avoid reading mid-state
    const timer = setTimeout(() => {
      void load()
        .then((patch) => {
          if (!alive) return
          if (!patch.trim()) {
            setState({ key, marks: [], lines: 0 })
            return
          }
          const parsed = parseDiffMarks(patch)
          setState({ key, marks: parsed.marks, lines: parsed.lines })
        })
        .catch(() => {
          // Not a git repo / file already deleted: treat as no changes, do not bother the user
          if (alive) setState({ key, marks: [], lines: 0 })
        })
    }, 100)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [key, root, rel, epoch, dirty, mtime, isNew])

  const fresh = state.key === key
  const marks = fresh ? state.marks : []
  const total = fresh ? state.lines : 0

  /** Jump to a line on mark click. reveal is consumed only by the focused pane, so activate pane+tab first. */
  const jumpTo = (line: number) => {
    const tabs = useTabs.getState()
    tabs.activate(tabId, groupId)
    tabs.jumpToLine(line)
  }

  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 w-[10px] overflow-hidden">
      {isNew ? (
        <button
          onClick={() => jumpTo(1)}
          data-tip={t('ruler.allAdded')}
          aria-label={t('ruler.allAddedAria')}
          tabIndex={-1}
          className="pointer-events-auto absolute inset-x-[2px] inset-y-0 rounded-[1px] bg-success/70 hover:bg-success"
        />
      ) : null}

      {total > 0
        ? marks.map((mark, index) => {
            const top = ((Math.min(mark.from, total) - 1) / total) * 100
            const height = ((mark.to - mark.from + 1) / total) * 100
            const label =
              mark.to > mark.from
                ? t('ruler.range', { from: mark.from, to: mark.to })
                : t('ruler.rangeSingle', { from: mark.from })
            const fullLabel = mark.kind === 'del' ? `${label}${t('ruler.deletedSuffix')}` : label
            return (
              <button
                key={index}
                onClick={() => jumpTo(mark.from)}
                data-tip={t('ruler.jump', { label: fullLabel })}
                aria-label={t('ruler.jumpAria', { label: fullLabel })}
                tabIndex={-1}
                className="group/ruler pointer-events-auto absolute right-[2px] w-[6px] cursor-pointer rounded-[1px] transition-shadow duration-fast hover:ring-1 hover:ring-accent/70"
                style={{
                  top: `${top}%`,
                  height: mark.kind === 'del' ? '2px' : `max(2px, ${height}%)`,
                }}
              >
                {mark.kind === 'mod' ? (
                  // Modified block: red left, green right, matching the side-by-side diff view
                  <span className="flex h-full w-full">
                    <span className="h-full w-1/2 bg-danger/80 group-hover/ruler:bg-danger" />
                    <span className="h-full w-1/2 bg-success/80 group-hover/ruler:bg-success" />
                  </span>
                ) : (
                  <span
                    className={`block h-full w-full ${
                      mark.kind === 'add'
                        ? 'bg-success/80 group-hover/ruler:bg-success'
                        : 'bg-danger/80 group-hover/ruler:bg-danger'
                    }`}
                  />
                )}
                {/* The bar is only 2-6px wide: pad 3px above and below for an easier hit target */}
                <span className="absolute -top-[3px] -bottom-[3px] left-0 right-0" />
              </button>
            )
          })
        : null}
    </div>
  )
}
