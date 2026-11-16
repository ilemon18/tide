import type { MonoFont } from './ipc'
import type { MessageKey } from '../i18n'

/**
 * Mono font registry: shared by the editor, the terminal and the UI variable. Adding a font means
 * touching only this file and the list in SettingsView; every stack carries the same fallbacks, so
 * missing glyphs and CJK still land on a system mono font.
 */
// CJK glyphs go to system fonts: Hiragino for Japanese, Apple SD Gothic Neo / Malgun Gothic for
// Korean. Without these two, Korean falls back to the default sans-serif and its line height and
// glyph width no longer line up with Chinese.
const FALLBACK =
  "ui-monospace, 'SF Mono', Menlo, Consolas, 'PingFang SC', 'Hiragino Sans', 'Apple SD Gothic Neo', monospace"

export type MonoFontOption = {
  id: MonoFont
  /** Font name comes from the message catalog: brand names are the same everywhere but stay centralized */
  labelKey: MessageKey
  /** Family name bundled into the app; null when following the system */
  family: string | null
  stack: string
}

const bundled = (family: string) => `'${family}', ${FALLBACK}`

export const MONO_FONT_OPTIONS: MonoFontOption[] = [
  {
    id: 'jetbrains',
    labelKey: 'fonts.jetbrains',
    family: 'JetBrains Mono',
    stack: bundled('JetBrains Mono'),
  },
  { id: 'fira', labelKey: 'fonts.fira', family: 'Fira Code', stack: bundled('Fira Code') },
  {
    id: 'ibm-plex',
    labelKey: 'fonts.ibmPlex',
    family: 'IBM Plex Mono',
    stack: bundled('IBM Plex Mono'),
  },
  {
    id: 'source-code',
    labelKey: 'fonts.sourceCode',
    family: 'Source Code Pro',
    stack: bundled('Source Code Pro'),
  },
  { id: 'system', labelKey: 'fonts.system', family: null, stack: FALLBACK },
]

export const DEFAULT_MONO_FONT: MonoFont = 'jetbrains'
export const SYSTEM_MONO_FONT = FALLBACK
export const BUNDLED_MONO_FONT = bundled('JetBrains Mono')

export function monoFontOption(font: MonoFont | string | undefined): MonoFontOption {
  return MONO_FONT_OPTIONS.find((option) => option.id === font) ?? MONO_FONT_OPTIONS[0]
}

export function isMonoFont(value: unknown): value is MonoFont {
  return MONO_FONT_OPTIONS.some((option) => option.id === value)
}

/** Font id → CSS font-family stack */
export function monoStack(font: MonoFont | string | undefined): string {
  return monoFontOption(font).stack
}