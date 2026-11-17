import type { IconName } from '../components/Icon'
import type { MessageKey } from '../i18n'

/**
 * Settings section list. Lives in lib so that `store/ui.ts` (remembers the last section / deep links)
 * and `SettingsView.tsx` share one definition without a cycle. label / hint hold catalog keys so they
 * follow the language.
 */
export type SettingsSectionId =
  | 'general'
  | 'appearance'
  | 'editor'
  | 'files'
  | 'terminal'
  | 'agent'
  | 'keys'
  | 'about'

export type SettingsSection = {
  id: SettingsSectionId
  labelKey: MessageKey
  icon: IconName
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'general',
    labelKey: 'settings.section.general.label',
    icon: 'settings',
  },
  {
    id: 'appearance',
    labelKey: 'settings.section.appearance.label',
    icon: 'palette',
  },
  {
    id: 'editor',
    labelKey: 'settings.section.editor.label',
    icon: 'pen',
  },
  {
    id: 'files',
    labelKey: 'settings.section.files.label',
    icon: 'files',
  },
  {
    id: 'terminal',
    labelKey: 'settings.section.terminal.label',
    icon: 'terminal',
  },
  {
    id: 'agent',
    labelKey: 'settings.section.agent.label',
    icon: 'agent',
  },
  {
    id: 'keys',
    labelKey: 'settings.section.keys.label',
    icon: 'command',
  },
  {
    id: 'about',
    labelKey: 'settings.section.about.label',
    icon: 'dot',
  },
]

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = 'general'

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}