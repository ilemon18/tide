import { useMemo } from 'react'
import { activeRoot, IS_PRIMARY_WINDOW, useWorkspace } from '../store/workspace'
import { useTabs } from '../store/tabs'
import { useSettings } from '../store/settings'
import { useAgent } from '../store/agent'
import { Icon } from './Icon'
import { UpdateBadge } from './UpdateBadge'
import { newWindow, revealInExplorer } from '../lib/actions'
import { useT } from '../i18n'

/**
 * Project badge: first two letters/digits of the name (for CJK, the first two chars),
 * uppercased, accent background with inverted text. Clicking reveals the project root; full name in a tooltip.
 */
function ProjectBadge({ name, root }: { name: string; root: string }) {
  const t = useT()
  const initials = useMemo(() => {
    // Same rule as avatars: multiple words take one initial each (my-app → MA),
    // a single word takes its first two chars (flash → FL)
    const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    const first = Array.from(words[0] ?? '')
    const two = Array.from(words[1] ?? '')
    const raw =
      words.length >= 2 && first[0] && two[0] ? first[0] + two[0] : first.slice(0, 2).join('')
    if (!raw) return '·'
    // The badge is square: two full-width chars (CJK/kana/Hangul) don't fit, keep only the first
    const wide = Array.from(raw).some((ch) => (ch.codePointAt(0) ?? 0) > 0x2e7f)
    return (wide ? Array.from(raw)[0] : raw).toUpperCase()
  }, [name])

  return (
    <button
      type="button"
      onClick={() => revealInExplorer(root, '', true)}
      data-tip={t('titlebar.projectTip', { name })}
      aria-label={t('titlebar.projectAria', { name })}
      className="flex h-[20px] w-[20px] shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-accent p-0 text-[10px] font-semibold uppercase leading-none text-accent-fg transition-opacity duration-fast hover:opacity-90"
    >
      {initials}
    </button>
  )
}

/** Custom title bar: room for the traffic lights on the left, clickable breadcrumbs in the middle, actions on the right */
export function TitleBar() {
  const t = useT()
  const roots = useWorkspace((s) => s.roots)
  const activeId = useTabs((s) => s.activeId)
  const tabs = useTabs((s) => s.tabs)
  const agentEnabled = useSettings((s) => s.agentEnabled)
  const runningChats = useAgent((s) => Object.keys(s.running).length)

  const active = tabs.find((t) => t.id === activeId)
  // Breadcrumbs follow the active tab's project so they can't disagree with activeRoot
  const root = roots.find((r) => r.id === active?.root) ?? activeRoot()

  const crumbs = useMemo(() => {
    // Welcome/settings tabs have no file path, so only the project badge is shown
    if (
      !active ||
      active.kind === 'welcome' ||
      active.kind === 'settings' ||
      active.kind === 'chat' ||
      !root
    )
      return []
    const parts = active.rel.split('/')
    return parts.map((part, index) => ({
      label: part,
      rel: parts.slice(0, index + 1).join('/'),
      isDir: index < parts.length - 1,
    }))
  }, [active?.rel, active?.root, root?.id, root?.name])

  return (
    <div
      data-tauri-drag-region
      className="flex h-[35px] shrink-0 select-none items-center gap-2 border-b border-line bg-panel pl-[92px] pr-2"
    >
      <div data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1.5">
        {root ? (
          <ProjectBadge name={root.name} root={root.id} />
        ) : (
          <span data-tauri-drag-region className="truncate text-sm font-medium text-fg/90">
            Tide
          </span>
        )}
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1
          return (
            <span key={`${crumb.rel}-${index}`} className="flex min-w-0 items-center gap-1.5">
              <span className="text-xs text-muted/50">›</span>
              <button
                type="button"
                onClick={() => {
                  if (root) revealInExplorer(root.id, crumb.rel, crumb.isDir)
                }}
                className={`min-w-0 truncate rounded-[var(--r-row)] px-1 text-sm transition-colors duration-fast hover:bg-hover hover:text-fg ${
                  last ? 'text-fg/85' : 'text-muted'
                }`}
              >
                {crumb.label}
              </button>
            </span>
          )
        })}
      </div>

      <div className="app-region-no-drag flex shrink-0 items-center gap-1">
        <UpdateBadge primary={IS_PRIMARY_WINDOW} />
        {agentEnabled ? (
          <button
            data-tip={t('titlebar.agentTip')}
            aria-label={t('titlebar.agentTip')}
            onClick={() => useAgent.getState().newChat()}
            className="relative flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <Icon name="agent" size={15} />
            {runningChats > 0 ? (
              <span className="absolute right-[3px] top-[3px] h-1.5 w-1.5 rounded-full bg-accent" />
            ) : null}
          </button>
        ) : null}
        <button
          data-tip={t('titlebar.welcomeTip')}
          onClick={() => useTabs.getState().openWelcome()}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <Icon name="home" size={15} />
        </button>
        <button
          data-tip={t('titlebar.newWindowTip')}
          onClick={() => void newWindow()}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <Icon name="window" size={15} />
        </button>
      </div>
    </div>
  )
}
