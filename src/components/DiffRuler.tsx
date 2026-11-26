import { useGit } from '../store/git'
import { useTabs, type TabGroupId } from '../store/tabs'
import { useFileDiffMarks } from '../store/diffMarks'
import { useT } from '../i18n'

/**
 * The "change overview" bar on the editor's right edge (VSCode's overview ruler).
 *
 * Data comes from git's full-context patch (-U100000): line numbers on the new side are editor line
 * numbers, so no diff algorithm is needed in the frontend. It reads disk content, so unsaved edits
 * only show up after saving. The same parsed marks feed the line-number gutter (store/diffMarks).
 */

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
  const entry = useFileDiffMarks(root, rel, true, dirty, mtime, epoch)

  // Untracked / freshly staged new file: git diff is empty, but the whole file counts as added
  const isNew =
    Boolean(status?.untracked.some((file) => file.path === rel)) ||
    Boolean(status?.staged.some((file) => file.path === rel && file.status.trim().startsWith('A')))

  // A brand-new file keeps the single full-height green bar; per-line marks would draw inside it.
  const marks = isNew ? [] : entry?.marks ?? []
  const total = isNew ? 0 : entry?.lines ?? 0

  /** Jump to a line on mark click. reveal is consumed only by the focused pane, so activate pane+tab first. */
  const jumpTo = (line: number) => {
    const tabs = useTabs.getState()
    tabs.activate(tabId, groupId)
    tabs.jumpToLine(line)
  }

  // Hide the ruler when there are no changes: saves 10px of horizontal space
  const hasChanges = marks.length > 0 || isNew

  return (
    <div className={`pointer-events-none absolute inset-y-0 right-0 overflow-hidden ${hasChanges ? 'w-[10px]' : 'w-0'}`}>
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
