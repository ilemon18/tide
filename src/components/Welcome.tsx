import { useState } from 'react'
import { useShortcut } from '../lib/useShortcut'
import { useWorkspace } from '../store/workspace'
import { newWindow, openFileDialog, openFolderDialog, openWorkspace } from '../lib/actions'
import { Icon } from './Icon'
import { FileIcon } from './FileIcon'
import { TideMark } from './TideMark'
import { ContextMenu } from './ContextMenu'
import { useUi } from '../store/ui'
import { useT } from '../i18n'

/** Keep the bottom quick-switch row readable at the welcome page's 620px content width. */
const RECENT_PROJECT_LIMIT = 6

/** Welcome page: the empty state with all tabs closed, also a normal tab opened from the home icon (closes via its ×). */
export function Welcome() {
  const t = useT()
  const folderKeys = useShortcut('folder.open')
  const fileKeys = useShortcut('file.open')
  const quickKeys = useShortcut('view.quickOpen')
  const windowKeys = useShortcut('app.newWindow')
  const commandKeys = useShortcut('view.commands')
  const roots = useWorkspace((s) => s.roots)
  const recent = useWorkspace((s) => s.recent)
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null)
  // Projects already open in this window are listed separately as "current projects" and kept out of recents:
  // a project only occupies one window, so "open in new window" makes no sense here
  const recentOnly = recent.filter((item) => !roots.some((root) => root.id === item.path))
    .slice(0, RECENT_PROJECT_LIMIT)
  const setOverlay = useUi((s) => s.setOverlay)
  const openQuickOpen = useUi((s) => s.openQuickOpen)
  return (
    <div className="tide-welcome absolute inset-0 overflow-y-auto bg-bg">
      <div className="mx-auto flex min-h-full w-[620px] max-w-[88%] flex-col justify-center py-8">
        <div className="mb-8 flex items-center gap-4">
          <TideMark size={84} />
          <h1 className="text-[32px] font-semibold tracking-tight">Tide</h1>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => void openFileDialog()}
            className="flex items-center gap-2 rounded-[7px] border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent/60 hover:bg-hover"
          >
            <Icon name="files" size={16} className="text-accent" />
            <span className="flex-1">{t('welcome.openFile')}</span>
            {fileKeys ? <span className="text-xs text-muted">{fileKeys}</span> : null}
          </button>
          <button
            onClick={() => void openFolderDialog()}
            className="flex items-center gap-2 rounded-[7px] border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent/60 hover:bg-hover"
          >
            <Icon name="folder-open" size={16} className="text-accent" />
            <span className="flex-1">{t('welcome.openFolder')}</span>
            <span className="text-xs text-muted">{folderKeys}</span>
          </button>
          <button
            onClick={() => openQuickOpen()}
            disabled={roots.length === 0}
            className="flex items-center gap-2 rounded-[7px] border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent/60 hover:bg-hover disabled:opacity-40 disabled:hover:border-line"
          >
            <Icon name="search" size={16} className="text-accent" />
            <span className="flex-1">{t('welcome.quickOpen')}</span>
            <span className="text-xs text-muted">{quickKeys}</span>
          </button>
          <button
            onClick={() => void newWindow()}
            className="flex items-center gap-2 rounded-[7px] border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent/60 hover:bg-hover"
          >
            <Icon name="window" size={16} className="text-accent" />
            <span className="flex-1">{t('welcome.newWindow')}</span>
            <span className="text-xs text-muted">{windowKeys}</span>
          </button>
          <button
            onClick={() => setOverlay('commands')}
            className="flex items-center gap-2 rounded-[7px] border border-line bg-panel px-3 py-2 text-left text-sm hover:border-accent/60 hover:bg-hover"
          >
            <Icon name="command" size={16} className="text-accent" />
            <span className="flex-1">{t('welcome.commandPalette')}</span>
            <span className="text-xs text-muted">{commandKeys}</span>
          </button>
        </div>

        {roots.length > 0 ? (
          <div className="mt-5">
            <div className="mb-1.5 text-2xs font-medium text-muted">
              {t('welcome.currentProject')}
            </div>
            {roots.map((node) => (
              <div
                key={node.id}
                className="group flex w-full items-center rounded text-sm text-muted hover:bg-hover hover:text-fg"
              >
                <button
                  onClick={() => useWorkspace.getState().setActiveRoot(node.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
                  title={node.id}
                >
                  <Icon name="folder-open" size={13} className="shrink-0 text-accent/80" />
                  <span className="truncate">{node.name}</span>
                  {node.isGitRepo ? (
                    <span className="shrink-0 text-2xs text-muted/60">git</span>
                  ) : null}
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {recentOnly.length > 0 ? (
          <section aria-label={t('welcome.recent')} className="mt-4 border-t border-line/60 pt-4">
            <div className="mb-2 text-2xs font-medium text-muted">{t('welcome.recent')}</div>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {recentOnly.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => void openWorkspace(item.path)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({ path: item.path, x: event.clientX, y: event.clientY })
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    setMenu({ path: item.path, x: rect.left, y: rect.bottom + 4 })
                  }}
                  className="flex h-8 min-w-[90px] flex-1 cursor-pointer items-center gap-1.5 rounded-[7px] border border-line bg-panel px-2 text-left text-xs text-muted transition-colors duration-fast hover:border-accent/60 hover:bg-hover hover:text-fg"
                  title={item.path}
                >
                  <FileIcon name={item.name} isDir isOpen={false} size={13} className="shrink-0" />
                  <span className="min-w-0 truncate">{item.name}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      {menu ? <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={[
        { label: t('projects.openInNewWindowTip'), onClick: () => void newWindow(menu.path) },
        { label: t('projects.removeRecentTip'), onClick: () => useWorkspace.getState().removeRecent(menu.path) },
      ]} /> : null}
    </div>
  )
}
