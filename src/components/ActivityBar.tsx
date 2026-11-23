import { useShortcutTip } from '../lib/useShortcut'
import { Icon, type IconName } from './Icon'
import { useGit } from '../store/git'
import { useWorkspace } from '../store/workspace'
import { useTerminal } from '../store/terminal'
import { toggleTerminal } from '../lib/actions'
import { useT } from '../i18n'
import { useTaskStore } from '../store/tasks'

export type ActivityView = 'explorer' | 'search' | 'git' | 'structure' | 'tasks'

type Props = {
  view: ActivityView
  onChange: (view: ActivityView) => void
  tasksEnabled: boolean
  onOpenSettings: () => void
}

function Item({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: IconName
  label: string
  active?: boolean
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      data-tip={label}
      data-tip-side="right"
      aria-label={label}
      onClick={onClick}
      className={`relative flex h-11 w-11 items-center justify-center rounded-[var(--r-control)] transition-colors duration-fast ${
        active ? 'bg-row-selected text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <span className="relative">
        <Icon name={icon} size={22} strokeWidth={1.5} />
        {badge && badge > 0 ? (
          <span className="absolute -right-1.5 -top-1 min-w-[15px] rounded-full bg-accent px-1 text-2xs font-semibold leading-[15px] text-accent-fg ring-2 ring-activity-bar">
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </span>
    </button>
  )
}

export function ActivityBar({ view, onChange, tasksEnabled, onOpenSettings }: Props) {
  const t = useT()
  const explorerTip = useShortcutTip('view.explorer', 'activity.explorerTip')
  const searchTip = useShortcutTip('view.search', 'activity.searchTip')
  const gitTip = useShortcutTip('view.git', 'activity.gitTip')
  const structureTip = useShortcutTip('view.structure', 'activity.structureTip')
  const tasksTip = t('activity.tasksTip')
  const terminalTip = useShortcutTip('view.panel', 'activity.terminalTip')
  const settingsTip = useShortcutTip('prefs.open', 'activity.settingsTip')
  const statuses = useGit((s) => s.statuses)
  const roots = useWorkspace((s) => s.roots)
  const activeRootId = useWorkspace((s) => s.activeRootId)
  const terminalVisible = useTerminal((s) => s.visible)
  const problemCount = useTaskStore((state) => {
    const root = activeRootId ?? roots[0]?.id
    return root ? (state.problems[root]?.length ?? 0) : 0
  })
  // Count only the currently open projects: if the cache still holds a previous project's status
  // after switching, it won't be counted into the changed-file total
  const changeCount = roots.reduce((acc, root) => {
    const status = statuses[root.id]
    if (!status) return acc
    return (
      acc +
      status.changes.length +
      status.staged.length +
      status.untracked.length +
      status.conflicts.length
    )
  }, 0)

  return (
    <div className="tide-activity-bar flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-line-soft bg-activity-bar py-2">
      <div className="flex flex-col items-center gap-1.5">
        <Item
          icon="files"
          label={explorerTip}
          active={view === 'explorer'}
          onClick={() => onChange('explorer')}
        />
        <Item
          icon="search"
          label={searchTip}
          active={view === 'search'}
          onClick={() => onChange('search')}
        />
        <Item
          icon="git"
          label={gitTip}
          active={view === 'git'}
          badge={changeCount}
          onClick={() => onChange('git')}
        />
        <Item
          icon="structure"
          label={structureTip}
          active={view === 'structure'}
          onClick={() => onChange('structure')}
        />
        {tasksEnabled ? (
          <Item
            icon="warning"
            label={tasksTip}
            active={view === 'tasks'}
            badge={problemCount}
            onClick={() => onChange('tasks')}
          />
        ) : null}
      </div>
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <Item
          icon="terminal-panel"
          label={terminalTip}
          active={terminalVisible}
          onClick={toggleTerminal}
        />
        <Item icon="settings" label={settingsTip} onClick={onOpenSettings} />
      </div>
    </div>
  )
}
