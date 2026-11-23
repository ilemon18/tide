import { useEffect, useState } from 'react'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useT, type MessageKey } from '../i18n'
import { COMMANDS, commandDefinition, type ShortcutScope } from '../lib/commandRegistry'
import { isMac } from '../lib/paths'
import {
  assignShortcuts, captureShortcutRecording, formatBinding, isReservedShortcut, resolveShortcuts,
  shortcutConflicts, shortcutFromEvent, startShortcutRecording,
} from '../lib/shortcuts'

const SCOPE_KEYS: Record<ShortcutScope, MessageKey> = {
  app: 'shortcuts.scope.app', editor: 'shortcuts.scope.editor', tree: 'shortcuts.scope.tree',
  terminal: 'shortcuts.scope.terminal', context: 'shortcuts.scope.context',
}

type Recording = { id: string; index: number | null; candidate: string | null; invalid: boolean }
const buttonClass = 'rounded border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-40'

export function ShortcutSettings() {
  const t = useT()
  const mac = isMac()
  const overrides = useSettings(state => state.shortcutOverrides) ?? {}
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  const resolved = resolveShortcuts(overrides, mac)

  useEffect(() => {
    if (!recording) return
    const stop = startShortcutRecording(event => {
      if (event.key === 'Escape') { setRecording(null); return }
      if (event.repeat || ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph'].includes(event.key)) return
      const key = shortcutFromEvent(event, mac)
      const invalid = !key || isReservedShortcut(key, mac) || event.isComposing || event.keyCode === 229
      setRecording(previous => previous && { ...previous, candidate: invalid ? null : key, invalid })
    })
    // Also work when this surface is mounted by itself. App dispatch calls the same recorder first.
    const capture = (event: KeyboardEvent) => { captureShortcutRecording(event) }
    window.addEventListener('keydown', capture, true)
    return () => { stop(); window.removeEventListener('keydown', capture, true) }
  }, [Boolean(recording), mac])

  const replace = (id: string, keys: readonly string[], reset = false) => {
    const current = useSettings.getState().shortcutOverrides ?? {}
    const conflicts = shortcutConflicts(id, keys, current, mac)
    const next = assignShortcuts(id, keys, current, mac)
    if (reset) delete next[id]
    useSettings.getState().patch({ shortcutOverrides: next })
    if (conflicts.length) useUi.getState().toast(t('shortcuts.replaced', {
      commands: conflicts.map(other => t(commandDefinition(other)!.titleKey)).join(', '),
    }))
  }
  const save = () => {
    if (!recording?.candidate) return
    const current = resolveShortcuts(useSettings.getState().shortcutOverrides, mac)[recording.id] ?? []
    const next = [...current]
    if (recording.index === null) next.push(recording.candidate)
    else next[recording.index] = recording.candidate
    replace(recording.id, next)
    setRecording(null)
  }
  const q = query.trim().toLowerCase()
  const commands = COMMANDS.filter(command => !q || [command.id, t(command.titleKey), t(command.groupKey),
    ...(resolved[command.id] ?? []).flatMap(key => [key, formatBinding(key, mac)])]
    .some(text => text.toLowerCase().includes(q)))
  const groups = [...new Set(commands.map(command => command.groupKey))]
  const conflicts = recording?.candidate ? shortcutConflicts(recording.id, [recording.candidate], overrides, mac) : []

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <input aria-label={t('shortcuts.search')} placeholder={t('shortcuts.search')} value={query}
          onChange={event => setQuery(event.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-accent" />
        <button className={buttonClass} onClick={() => {
          setRecording(null)
          useSettings.getState().patch({ shortcutOverrides: {} })
        }}>{t('shortcuts.resetAll')}</button>
      </div>
      <p className="text-xs leading-relaxed text-muted">{t('shortcuts.help')}</p>
      {recording && (
        <section role="dialog" aria-label={t('shortcuts.recordTitle')} className="rounded border border-accent bg-panel p-4">
          <h3 className="text-sm font-medium">{t(commandDefinition(recording.id)!.titleKey)}</h3>
          <p className="my-3 text-sm" aria-live="polite">
            {recording.invalid ? t('shortcuts.invalid') : recording.candidate
              ? formatBinding(recording.candidate, mac) : t('shortcuts.recordHint')}
          </p>
          {conflicts.length > 0 && <p className="mb-3 text-xs text-warning">{t('shortcuts.conflict', {
            commands: conflicts.map(id => t(commandDefinition(id)!.titleKey)).join(', '),
          })}</p>}
          <div className="flex gap-2">
            <button className={buttonClass} disabled={!recording.candidate} onClick={save}>{t('shortcuts.save')}</button>
            <button className={buttonClass} onClick={() => setRecording(null)}>{t('common.cancel')}</button>
          </div>
        </section>
      )}
      {groups.map(group => (
        <section key={group}>
          <h3 className="mb-2 text-xs font-medium text-muted">{t(group)}</h3>
          <div className="rounded border border-line-soft bg-panel">
            {commands.filter(command => command.groupKey === group).map(command => {
              const keys = resolved[command.id] ?? []
              const modified = Object.prototype.hasOwnProperty.call(overrides, command.id)
              return (
                <div key={command.id} data-command-id={command.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line/40 px-4 py-3 last:border-b-0">
                  <div className="min-w-0">
                    <div className="text-sm">{t(command.titleKey)}{modified && <span className="ml-2 text-xs text-accent">{t('shortcuts.modified')}</span>}</div>
                    <div className="mt-1 text-xs text-muted">{t(SCOPE_KEYS[command.scope])} · <span className="font-mono">{command.id}</span></div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!keys.length && <span className="text-xs text-muted">{t('shortcuts.unbound')}</span>}
                    {keys.map((key, index) => <span key={key} className="flex items-center rounded border border-line">
                      <button className="px-2 py-1 font-mono text-xs hover:bg-hover" aria-label={t('shortcuts.editBinding', { keys: formatBinding(key, mac) })}
                        onClick={() => setRecording({ id: command.id, index, candidate: null, invalid: false })}>{formatBinding(key, mac)}</button>
                      <button className="border-l border-line px-2 py-1 text-xs text-muted hover:text-danger" aria-label={t('shortcuts.removeBinding', { keys: formatBinding(key, mac) })}
                        onClick={() => replace(command.id, keys.filter((_, i) => i !== index))}>×</button>
                    </span>)}
                    <button className={buttonClass} onClick={() => setRecording({ id: command.id, index: null, candidate: null, invalid: false })}>{t('shortcuts.add')}</button>
                    {modified && <button className={buttonClass} onClick={() => replace(command.id, command.defaults, true)}>{t('shortcuts.reset')}</button>}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ))}
      {!commands.length && <p className="text-sm text-muted">{t('commands.noResults')}</p>}
    </div>
  )
}
