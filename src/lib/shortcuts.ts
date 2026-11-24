import { COMMANDS, commandDefinition } from './commandRegistry'
import { shortcutKey } from './keys'

/** Canonical single strokes, e.g. Mod+Shift+a. Empty arrays explicitly disable defaults. */
export type ShortcutOverrides = Record<string, string[]>
export type ShortcutEvent = {
  key: string; code?: string; keyCode?: number
  metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean
}
const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'] as const
const NAMED_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'backspace', 'delete',
  'home', 'end', 'pageup', 'pagedown', 'insert', 'enter', 'tab', 'space'])

export function normalizeShortcut(value: string): string | null {
  const parts = value.split('+')
  const key = parts.pop()?.toLowerCase()
  if (!key || !(key.length === 1 && /^[a-z0-9\x20-\x7e]$/.test(key) ||
    NAMED_KEYS.has(key) || /^f([1-9]|1[0-9]|2[0-4])$/.test(key))) return null
  if (parts.some(part => !MODIFIERS.includes(part as typeof MODIFIERS[number]))) return null
  if (!parts.some(part => part !== 'Shift') && !/^f\d+$/.test(key) && key !== 'delete') return null
  if (new Set(parts).size !== parts.length) return null
  return [...MODIFIERS.filter(mod => parts.includes(mod)), key].join('+')
}

/** Expand Mod before matching/conflict detection; Ctrl and Mod are equal on Windows/Linux. */
export function shortcutIdentity(value: string, mac: boolean): string {
  const parts = value.split('+')
  const key = parts.pop()!
  const mods = new Set(parts.map(part => part === 'Mod' ? (mac ? 'Meta' : 'Ctrl') : part))
  return [...MODIFIERS.filter(mod => mods.has(mod)), key].join('+')
}

export function isReservedShortcut(value: string, mac: boolean): boolean {
  const identity = shortcutIdentity(value, mac)
  return ['Meta', 'Ctrl'].some(mod => ['a', 'c', 'v', 'x', 'z', 'y'].some(key =>
    identity === mod + '+' + key || (['z', 'v'].includes(key) && identity === mod + '+Shift+' + key)))
}

export function shortcutFromEvent(event: ShortcutEvent, mac: boolean): string | null {
  if (['Meta', 'Control', 'Alt', 'Shift', 'AltGraph'].includes(event.key)) return null
  // Option may produce a different printable letter on macOS. Preserve its physical shortcut key.
  const key = event.altKey && /^Key[A-Z]$/.test(event.code ?? '')
    ? event.code!.slice(3).toLowerCase() : shortcutKey(event)
  const mods: string[] = []
  if (mac ? event.metaKey : event.ctrlKey) mods.push('Mod')
  if (mac && event.ctrlKey) mods.push('Ctrl')
  if (!mac && event.metaKey) mods.push('Meta')
  if (event.altKey) mods.push('Alt')
  if (event.shiftKey) mods.push('Shift')
  return normalizeShortcut([...mods, key === ' ' ? 'space' : key].join('+'))
}

export function normalizeOverrides(raw: unknown): ShortcutOverrides {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: ShortcutOverrides = Object.create(null)
  for (const [id, values] of Object.entries(raw)) {
    if (!Array.isArray(values)) continue
    const valid = values.filter((value): value is string => typeof value === 'string')
      .map(normalizeShortcut).filter((value): value is string => value !== null)
    // A corrupt entry must not silently disable a valid default. Explicit [] remains meaningful.
    if (!values.length || valid.length) result[id] = [...new Set(valid)]
  }
  return result
}

export function overridesEqual(a: unknown, b: unknown): boolean {
  const left = normalizeOverrides(a), right = normalizeOverrides(b)
  const ids = Object.keys(left)
  return ids.length === Object.keys(right).length && ids.every(id =>
    right[id] && left[id].length === right[id].length && left[id].every((key, i) => key === right[id][i]))
}

/** Defaults first, explicit overrides last. A malformed file cannot dispatch two actions for one key. */
export function resolveShortcuts(overrides: ShortcutOverrides = {}, mac = false): Record<string, string[]> {
  const resolved: Record<string, string[]> = {}
  const owners = new Map<string, string>()
  const commands = [...COMMANDS.filter(c => !Object.prototype.hasOwnProperty.call(overrides, c.id)),
    ...Object.keys(overrides).map(commandDefinition).filter((c): c is NonNullable<typeof c> => Boolean(c))]
  for (const command of commands) {
    resolved[command.id] = []
    for (const value of overrides[command.id] ?? command.defaults) {
      const binding = normalizeShortcut(value)
      if (!binding || isReservedShortcut(binding, mac)) continue
      const identity = shortcutIdentity(binding, mac)
      const previous = owners.get(identity)
      if (previous) resolved[previous] = resolved[previous].filter(key => shortcutIdentity(key, mac) !== identity)
      resolved[command.id].push(binding)
      owners.set(identity, command.id)
    }
  }
  return resolved
}

export function shortcutConflicts(id: string, bindings: readonly string[], overrides: ShortcutOverrides, mac: boolean): string[] {
  const identities = new Set(bindings.map(key => shortcutIdentity(key, mac)))
  return Object.entries(resolveShortcuts(overrides, mac)).filter(([other, keys]) =>
    other !== id && keys.some(key => identities.has(shortcutIdentity(key, mac)))).map(([other]) => other)
}

/** One immutable settings patch transfers ownership and persists explicit removals atomically. */
export function assignShortcuts(id: string, bindings: readonly string[], overrides: ShortcutOverrides, mac: boolean): ShortcutOverrides {
  const next = { ...normalizeOverrides(overrides) }
  const valid = [...new Set(bindings.map(normalizeShortcut).filter((key): key is string =>
    key !== null && !isReservedShortcut(key, mac)))]
  const identities = new Set(valid.map(key => shortcutIdentity(key, mac)))
  const current = resolveShortcuts(next, mac)
  for (const other of shortcutConflicts(id, valid, next, mac)) {
    next[other] = current[other].filter(key => !identities.has(shortcutIdentity(key, mac)))
  }
  // Reinsert so explicit edits also win over malformed/legacy duplicate overrides.
  delete next[id]
  next[id] = valid
  return next
}

const KEY_LABELS: Record<string, string> = { arrowdown: '↓', arrowup: '↑', arrowleft: '←', arrowright: '→',
  backspace: 'Backspace', delete: 'Delete', enter: 'Enter', tab: 'Tab', space: 'Space',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert' }
export function formatBinding(value: string, mac: boolean): string {
  const parts = shortcutIdentity(value, mac).split('+')
  const key = parts.pop()!
  const labels: Record<string, string> = mac
    ? { Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
    : { Meta: 'Meta', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  return [...parts.map(part => labels[part] ?? part), KEY_LABELS[key] ?? key.toUpperCase()].join(mac ? '' : '+')
}

let recorder: { handler: (event: KeyboardEvent) => void; accepts: (event: KeyboardEvent) => boolean } | null = null
export function startShortcutRecording(handler: (event: KeyboardEvent) => void,
  accepts: (event: KeyboardEvent) => boolean = () => true): () => void {
  const current = { handler, accepts }
  recorder = current
  return () => { if (recorder === current) recorder = null }
}
export function captureShortcutRecording(event: KeyboardEvent): boolean {
  if (!recorder || !recorder.accepts(event)) return false
  const { handler } = recorder
  event.preventDefault()
  event.stopImmediatePropagation()
  handler(event)
  return true
}
