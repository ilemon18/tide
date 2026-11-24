import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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

type Recording = { id: string; original: string | null; candidate: string | null; invalid: boolean }
const buttonClass = 'rounded border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-40'

export function ShortcutSettings() {
  const t = useT()
  const mac = isMac()
  const overrides = useSettings(state => state.shortcutOverrides) ?? {}
  const [query, setQuery] = useState('')
  const [recording, setRecording] = useState<Recording | null>(null)
  const recordingInput = useRef<HTMLInputElement>(null)
  const recordingDialog = useRef<HTMLDivElement>(null)
  const recordingTrigger = useRef<HTMLButtonElement | null>(null)
  const titleId = useId()
  const hintId = useId()
  const resolved = resolveShortcuts(overrides, mac)

  useEffect(() => {
    if (!recording) return
    const trigger = recordingTrigger.current
    const row = trigger?.closest('[data-command-id]')
    const bindingIndex = trigger?.getAttribute('data-binding-index')
    recordingInput.current?.focus()
    const stop = startShortcutRecording(event => {
      if (event.key === 'Escape') { setRecording(null); return }
      if (event.repeat || ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph'].includes(event.key)) return
      const key = shortcutFromEvent(event, mac)
      const invalid = !key || isReservedShortcut(key, mac) || event.isComposing || event.keyCode === 229
      setRecording(previous => previous && { ...previous, candidate: invalid ? null : key, invalid })
    }, event => event.key === 'Escape' || (document.activeElement === recordingInput.current &&
      !(event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey)))
    // Also work when this surface is mounted by itself. App dispatch calls the same recorder first.
    const capture = (event: KeyboardEvent) => { captureShortcutRecording(event) }
    window.addEventListener('keydown', capture, true)
    const keepFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !recordingDialog.current?.contains(event.target)) recordingInput.current?.focus()
    }
    document.addEventListener('focusin', keepFocus)
    return () => {
      stop()
      window.removeEventListener('keydown', capture, true)
      document.removeEventListener('focusin', keepFocus)
      const replacement = bindingIndex !== null && bindingIndex !== undefined
        ? row?.querySelector<HTMLButtonElement>(`button[data-binding-index="${bindingIndex}"]`) : null
      const target = trigger?.isConnected ? trigger : replacement ?? row?.querySelector<HTMLButtonElement>('button[data-add-binding]')
      if (target?.isConnected) target.focus()
    }
  }, [Boolean(recording), mac])

  const beginRecording = (id: string, index: number | null, trigger: HTMLButtonElement) => {
    recordingTrigger.current = trigger
    setRecording({ id, original: index === null ? null : resolved[id][index], candidate: null, invalid: false })
  }

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
    const index = recording.original ? current.indexOf(recording.original) : -1
    if (index < 0) next.push(recording.candidate)
    else next[index] = recording.candidate
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
      {recording && createPortal(
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4"
          onMouseDown={event => { if (event.target === event.currentTarget) setRecording(null) }}>
          <div ref={recordingDialog} data-shortcut-dialog role="dialog" aria-modal="true" aria-labelledby={titleId}
            className="w-full max-w-[420px] overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
            onKeyDownCapture={event => {
              if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return
              const controls = Array.from(recordingDialog.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])
              const index = controls.indexOf(document.activeElement as HTMLElement)
              event.preventDefault()
              controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus()
            }}>
            <div className="px-4 pb-4 pt-4">
              <h2 id={titleId} className="text-md font-semibold text-fg">{t('shortcuts.recordTitle')}</h2>
              <p className="mt-2 text-sm text-fg">{t(commandDefinition(recording.id)!.titleKey)}</p>
              <p className="mt-1 text-xs text-muted">{t(SCOPE_KEYS[commandDefinition(recording.id)!.scope])}</p>
              {recording.original && <p className="mt-2 text-xs text-muted">{t('shortcuts.currentBinding', {
                keys: formatBinding(recording.original, mac),
              })}</p>}
              <input ref={recordingInput} readOnly aria-label={t('shortcuts.recordTitle')} aria-describedby={hintId}
                aria-invalid={recording.invalid} value={recording.candidate ? formatBinding(recording.candidate, mac) : ''}
                placeholder={t('shortcuts.unbound')} spellCheck={false}
                className="mt-4 w-full rounded border border-line bg-bg px-3 py-4 text-center font-mono text-lg outline-none placeholder:font-sans placeholder:text-sm focus:border-accent" />
              <p id={hintId} className={`mt-2 text-xs leading-relaxed ${recording.invalid ? 'text-warning' : 'text-muted'}`} aria-live="polite">
                {t(recording.invalid ? 'shortcuts.invalid' : 'shortcuts.recordHint')}
              </p>
              {conflicts.length > 0 && <p className="mt-3 text-xs text-warning" role="status">{t('shortcuts.conflict', {
                commands: conflicts.map(id => t(commandDefinition(id)!.titleKey)).join(', '),
              })}</p>}
            </div>
            <div className="flex justify-end gap-2 border-t border-line px-3 py-2.5">
              <button className={buttonClass} onClick={() => setRecording(null)}>{t('common.cancel')}</button>
              <button className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg disabled:opacity-40"
                disabled={!recording.candidate} onClick={save}>{t('shortcuts.save')}</button>
            </div>
          </div>
        </div>, document.body,
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
                      <button data-binding-index={index} className="px-2 py-1 font-mono text-xs hover:bg-hover" aria-label={t('shortcuts.editBinding', { keys: formatBinding(key, mac) })}
                        onClick={event => beginRecording(command.id, index, event.currentTarget)}>{formatBinding(key, mac)}</button>
                      <button className="border-l border-line px-2 py-1 text-xs text-muted hover:text-danger" aria-label={t('shortcuts.removeBinding', { keys: formatBinding(key, mac) })}
                        onClick={() => replace(command.id, keys.filter((_, i) => i !== index))}>×</button>
                    </span>)}
                    <button data-add-binding className={buttonClass} onClick={event => beginRecording(command.id, null, event.currentTarget)}>{t('shortcuts.add')}</button>
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
