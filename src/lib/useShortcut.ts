import { useT, type MessageKey } from '../i18n'
import { useSettings } from '../store/settings'
import { isMac } from './paths'
import { formatBinding, resolveShortcuts, shortcutFromEvent, shortcutIdentity, type ShortcutEvent } from './shortcuts'

export function shortcutLabel(id: string): string {
  const mac = isMac()
  return (resolveShortcuts(useSettings.getState().shortcutOverrides, mac)[id] ?? [])
    .map(key => formatBinding(key, mac)).join(' / ')
}

export function useShortcut(id: string): string {
  const overrides = useSettings(state => state.shortcutOverrides)
  const mac = isMac()
  return (resolveShortcuts(overrides, mac)[id] ?? []).map(key => formatBinding(key, mac)).join(' / ')
}

export function matchesShortcut(id: string, event: ShortcutEvent): boolean {
  const mac = isMac()
  const key = shortcutFromEvent(event, mac)
  return Boolean(key && (resolveShortcuts(useSettings.getState().shortcutOverrides, mac)[id] ?? [])
    .some(binding => shortcutIdentity(binding, mac) === shortcutIdentity(key, mac)))
}

export function useShortcutTip(id: string, label: MessageKey): string {
  const t = useT()
  const keys = useShortcut(id)
  return keys ? t(label) + ' (' + keys + ')' : t(label)
}
