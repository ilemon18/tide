import { useEffect, useState } from 'react'
import { useTabs } from '../store/tabs'
import { api, type FormatToolStatus } from '../lib/ipc'
import { resolveTool, sourceLabel } from '../lib/formatters'
import { useGit } from '../store/git'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { fetchRemote, openSettings } from '../lib/actions'
import { Icon } from './Icon'
import { languageLabel } from '../editor/languages'
import { themeLabel } from '../theme/palettes'
import { useT } from '../i18n'

export function StatusBar() {
  const t = useT()
  const roots = useWorkspace((s) => s.roots)
  const activeRootId = useWorkspace((s) => s.activeRootId)
  const statuses = useGit((s) => s.statuses)
  const busy = useGit((s) => s.busy)
  const tabs = useTabs((s) => s.tabs)
  const activeId = useTabs((s) => s.activeId)
  const formatActive = useTabs((s) => s.formatActive)
  const formatting = useTabs((s) => s.formatting)
  const cursors = useTabs((s) => s.cursors)
  const settings = useSettings()
  const openThemeMenu = useUi((s) => s.openThemeMenu)
  const openBranchMenu = useUi((s) => s.openBranchMenu)
  const setOverlay = useUi((s) => s.setOverlay)

  const active = tabs.find((t) => t.id === activeId)
  const cursor = activeId ? cursors[activeId] : undefined
  const dirtyCount = tabs.filter((t) => t.dirty).length
  /** Indent/wrap for text tabs comes from what the file itself reports; global settings are only the fallback */
  const textTab = active && active.kind === 'file' ? active : null
  const indentSize = textTab?.indentSize ?? settings.tabSize
  const indentLabel = textTab?.useTabs
    ? t('status.indentTabs', { size: indentSize })
    : t('status.indentSpaces', { size: indentSize })

  // Bottom right shows the tool picked in settings plus the rule it matched.
  // Ask the backend on every file/tool switch: Prettier needs to know if the project has it installed,
  // system tools whether they exist on PATH
  const [toolStatus, setToolStatus] = useState<FormatToolStatus | null>(null)
  const formatterTab = active && active.kind === 'file' && !active.preview ? active : null
  const formatterRoot = formatterTab?.root ?? null
  const formatterRel = formatterTab?.rel ?? null
  // The "auto" mode resolves a concrete tool by extension first, then asks the backend if it is usable
  const resolvedTool = formatterRel ? resolveTool(formatterRel, settings.formatTool) : null
  const formatMode = settings.formatMode
  useEffect(() => {
    if (formatMode === 'off' || !formatterRoot || !formatterRel || !resolvedTool) {
      setToolStatus(null)
      return
    }
    let alive = true
    void api
      .formatToolStatus(formatterRoot, formatterRel, resolvedTool.id)
      .then((status) => {
        if (alive) setToolStatus(status)
      })
      .catch(() => {
        if (alive) setToolStatus(null)
      })
    return () => {
      alive = false
    }
  }, [formatterRoot, formatterRel, resolvedTool, formatMode, formatting])

  const activeRoot = roots.find((r) => r.id === activeRootId) ?? roots[0] ?? null
  const status = activeRoot ? statuses[activeRoot.id] : undefined
  return (
    <div className="flex h-[28px] shrink-0 items-center gap-3 border-t border-line-soft bg-panel px-2 text-xs text-muted">
      {roots.length > 0 ? (
        <button
          onClick={() => setOverlay('projects')}
          className="flex items-center gap-1 rounded-[var(--r-row)] px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-fg"
          data-tip={t('status.switchProjectTip')}
        >
          <Icon name="folder-open" size={12} />
          <span className="max-w-[160px] truncate">
            {roots.length > 1
              ? t('status.projectCount', { count: roots.length })
              : (activeRoot?.name ?? '')}
          </span>
        </button>
      ) : null}

      {status?.isRepo && activeRoot ? (
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => openBranchMenu({ root: activeRoot.id })}
            className="flex items-center gap-1 rounded-[var(--r-row)] px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-fg"
            data-tip={t('status.switchBranchTip')}
          >
            <Icon name="git" size={11} />
            <span className="max-w-[130px] truncate">
              {busy === 'checkout' ? t('status.checkingOut') : status.branch}
            </span>
            {busy !== 'checkout' && (status.ahead > 0 || status.behind > 0) ? (
              <span className="text-2xs text-warning">
                {status.ahead > 0 ? `↑${status.ahead}` : ''}
                {status.behind > 0 ? `↓${status.behind}` : ''}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => void fetchRemote(activeRoot.id)}
            disabled={busy !== null}
            className="flex h-[20px] w-[20px] items-center justify-center rounded-[var(--r-row)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg disabled:opacity-40"
            data-tip={t('status.fetchTip')}
          >
            <Icon
              name={busy === 'fetch' ? 'spinner' : 'refresh'}
              size={11}
              className={busy === 'fetch' ? 'animate-spin' : ''}
            />
          </button>
        </div>
      ) : null}

      <div className="flex-1" />

      {dirtyCount > 0 ? (
        <span className="text-warning">{t('status.unsaved', { count: dirtyCount })}</span>
      ) : null}

      {active && active.kind !== 'image' && !active.preview && cursor ? (
        <span>{t('status.cursor', { line: cursor.line, col: cursor.col })}</span>
      ) : null}

      {active?.kind === 'image' ||
      active?.kind === 'welcome' ||
      active?.kind === 'settings' ||
      active?.kind === 'chat' ? null : (
        <span>UTF-8</span>
      )}
      {textTab?.eol === 'crlf' ? (
        <span data-tip={t('status.crlfTip')}>CRLF</span>
      ) : null}
      {textTab ? (
        <button
          onClick={() => openSettings('editor')}
          className="rounded-[var(--r-row)] px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          {indentLabel}
        </button>
      ) : null}
      {toolStatus?.rule ? (
        <button
          onClick={() => void formatActive()}
          disabled={formatting || !toolStatus.available}
          className={`flex items-center gap-1 rounded-[var(--r-row)] px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-fg disabled:hover:bg-transparent ${
            toolStatus.available && formatMode === 'onSave' ? 'text-fg/75' : 'text-muted/60'
          }`}
          data-tip={
            toolStatus.available
              ? t(
                  formatMode === 'onSave' ? 'status.formatTipOnSave' : 'status.formatTip',
                  {
                    rule: toolStatus.rule,
                    tool: toolStatus.label,
                    source: sourceLabel(toolStatus.source),
                  },
                )
              : t('status.formatUnavailableTip', {
                  rule: toolStatus.rule,
                  tool: toolStatus.label,
                })
          }
        >
          <Icon
            name={formatting ? 'spinner' : 'format'}
            size={11}
            className={formatting ? 'animate-spin' : formatMode === 'onSave' ? 'text-accent' : ''}
          />
          <span className="tabular-nums">{toolStatus.rule}</span>
          <span className="text-muted/50">·</span>
          <span>{toolStatus.label}</span>
          {toolStatus.available ? null : (
            <span className="text-warning">{t('status.formatUnavailable')}</span>
          )}
        </button>
      ) : null}

      <span className="text-fg/75">
        {active?.kind === 'image'
          ? t('app.imagePreview')
          : active?.kind === 'settings'
            ? t('app.settings')
            : active?.kind === 'welcome'
              ? ''
              : active?.kind === 'chat'
                ? ''
                : active?.preview
                  ? t('app.svgPreview')
                  : active?.kind === 'untitled'
                    ? t('status.plainText')
                    : languageLabel(active?.rel ?? '')}
      </span>

      <button
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          // Opens upward from the status bar's top edge: no menu height measurement, so it can never leave the window
          openThemeMenu({
            left: rect.right - 188,
            bottom: window.innerHeight - rect.top + 6,
            maxHeight: Math.max(200, rect.top - 12),
          })
        }}
        className="flex items-center gap-1 rounded-[var(--r-row)] px-1.5 py-0.5 transition-colors duration-fast hover:bg-hover hover:text-fg"
        data-tip={t('status.themeTip')}
      >
        <span
          className="h-2.5 w-2.5 rounded-full border border-black/20"
          style={{ background: settings.palette.ui.accent }}
        />
        {settings.theme === 'system' ? t('status.themeSystem') : themeLabel(settings.palette, t)}
      </button>
    </div>
  )
}
