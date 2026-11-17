import { Icon, type IconName } from './Icon'
import { useGit } from '../store/git'
import { useWorkspace } from '../store/workspace'
import { useTerminal } from '../store/terminal'
import { toggleTerminal } from '../lib/actions'
import { isMac, modKey } from '../lib/paths'
import { useT } from '../i18n'

export type ActivityView = 'explorer' | 'search' | 'git' | 'structure'

type Props = {
  view: ActivityView
  onChange: (view: ActivityView) => void
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

export function ActivityBar({ view, onChange, onOpenSettings }: Props) {
  const t = useT()
  const statuses = useGit((s) => s.statuses)
  const roots = useWorkspace((s) => s.roots)
  const terminalVisible = useTerminal((s) => s.visible)
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
          label={t('activity.explorerTip')}
          active={view === 'explorer'}
          onClick={() => onChange('explorer')}
        />
        <Item
          icon="search"
          label={t('activity.searchTip')}
          active={view === 'search'}
          onClick={() => onChange('search')}
        />
        <Item
          icon="git"
          label={t('activity.gitTip')}
          active={view === 'git'}
          badge={changeCount}
          onClick={() => onChange('git')}
        />
        <Item
          icon="structure"
          label={t('activity.structureTip', { keys: isMac() ? `${modKey()}U` : 'Ctrl+U' })}
          active={view === 'structure'}
          onClick={() => onChange('structure')}
        />
      </div>
      <div className="flex flex-col items-center gap-1.5 pb-1">
        <Item
          icon="terminal-panel"
          label={t('activity.terminalTip')}
          active={terminalVisible}
          onClick={toggleTerminal}
        />
        <Item icon="settings" label={t('activity.settingsTip')} onClick={onOpenSettings} />
      </div>
    </div>
  )
}
