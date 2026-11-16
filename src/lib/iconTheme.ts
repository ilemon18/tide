import { ICON_SET_ORDER, type IconSetId } from '../assets/fileIcons.generated'
import type { MessageKey } from '../i18n'

/** Icon set: material is colored / minimal is monochrome / none hides icons */
export type IconThemeId = IconSetId | 'none'

export const DEFAULT_ICON_THEME: IconThemeId = 'material'

/** Display order and text for menus / settings (text lives in the catalog and follows the language) */
export const ICON_THEME_OPTIONS: { id: IconThemeId; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { id: 'material', labelKey: 'icons.material', hintKey: 'icons.materialHint' },
  { id: 'minimal', labelKey: 'icons.minimal', hintKey: 'icons.minimalHint' },
  { id: 'none', labelKey: 'icons.none', hintKey: 'icons.noneHint' },
]

export function isIconThemeId(value: unknown): value is IconThemeId {
  return value === 'none' || ICON_SET_ORDER.includes(value as IconSetId)
}