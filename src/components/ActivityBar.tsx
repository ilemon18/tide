import { useState } from 'react'
import { useShortcutTip } from '../lib/useShortcut'
import { Icon, type IconName } from './Icon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { useGit } from '../store/git'
import { useWorkspace } from '../store/workspace'
import { useTerminal } from '../store/terminal'
import { useTabs } from '../store/tabs'
import { useSettings } from '../store/settings'
import { toggleTerminal } from '../lib/actions'
import { useT } from '../i18n'
import { useTaskStore } from '../store/tasks'
import {
  ACTIVITY_BAR_ITEMS,
  type ActivityBarVisibility,
} from '../lib/activityBar'

export type ActivityView = 'explorer' | 'search' | 'git' | 'structure' | 'tasks'

type Props = {
  view: ActivityView
  onChange: (view: ActivityView) => void
  welcomeActive: boolean
  visibility: ActivityBarVisibility
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
      onClick={(event) => {
        // A double-click opens the visibility menu. Do not run the button twice on its second click.
        if (event.detail <= 1) onClick()
      }}
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

export function ActivityBar({
  view,
  onChange,
  welcomeActive,
  visibility,
  tasksEnabled,
  onOpenSettings,
}: Props) {
  const t = useT()
  const explorerTip = useShortcutTip('view.explorer', 'activity.explorerTip')
  const searchTip = useShortcutTip('view.search', 'activity.searchTip')
  const gitTip = useShortcutTip('view.git', 'activity.gitTip')
  const structureTip = useShortcutTip('view.structure', 'activity.structureTip')
  const tasksTip = t('activity.tasksTip')
  const welcomeTip = t('activity.welcomeTip')
  const terminalTip = useShortcutTip('view.panel', 'activity.terminalTip')
  const settingsTip = useShortcutTip('prefs.open', 'activity.settingsTip')
  const statuses = useGit((s) => s.statuses)
  const roots = useWorkspace((s) => s.roots)
  const activeRootId = useWorkspace((s) => s.activeRootId)
  const terminalVisible = useTerminal((s) => s.visible)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
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

  const menuItems: MenuItem[] = ACTIVITY_BAR_ITEMS.map((item) => {
    const visible = visibility[item.id]
    const disabled = item.id === 'tasks' && !tasksEnabled
    return {
      label: t(item.labelKey),
      checked: visible,
      disabled,
      keepOpen: true,
      onClick: () => {
        useSettings.getState().patch({ [item.settingKey]: !visible })
      },
    }
  })

  return (
    <div
      className="tide-activity-bar relative flex w-[52px] shrink-0 flex-col items-center justify-between border-r border-line-soft bg-activity-bar py-2"
      onDoubleClick={(event) => {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        setMenu({ x: rect.right + 6, y: event.clientY })
      }}
    >
      <div className="flex flex-col items-center gap-1.5">
        {visibility.welcome ? (
          <Item
            icon="home"
            label={welcomeTip}
            active={welcomeActive}
            onClick={() => useTabs.getState().openWelcome()}
          />
        ) : null}
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
        {visibility.git ? (
          <Item
            icon="git"
            label={gitTip}
            active={view === 'git'}
            badge={changeCount}
            onClick={() => onChange('git')}
          />
        ) : null}
        {visibility.structure ? (
          <Item
            icon="structure"
            label={structureTip}
            active={view === 'structure'}
            onClick={() => onChange('structure')}
          />
        ) : null}
        {tasksEnabled && visibility.tasks ? (
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
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </div>
  )
}
