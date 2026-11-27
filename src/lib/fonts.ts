import type { MonoFont } from './ipc'
import type { MessageKey } from '../i18n'

/**
 * Code font registry: editor, terminal and settings share these choices and fallbacks.
 * Add ids to MonoFont; bundled families also need CSS resources and their distribution license.
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
  /** Preferred bundled/local CSS family; null when following the system */
  family: string | null
  stack: string
}

const withFallback = (family: string) => `'${family}', ${FALLBACK}`

export const FONT_WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900] as const
const TERMINAL_OBLIQUE: Record<MonoFont, string> = { jetbrains: 'Tide Terminal Oblique A', fira: 'Tide Terminal Oblique B',
  'ibm-plex': 'Tide Terminal Oblique C', 'source-code': 'Tide Terminal Oblique D', system: 'Tide Terminal System Oblique',
  consolas: 'Tide Terminal Consolas Oblique', 'smiley-sans': 'Smiley Sans' }
/** Intrinsic oblique faces support xterm's public fontFamily API without changing ANSI output. */
export function terminalStack(font: MonoFont | string | undefined, italic: boolean): string {
  const option = monoFontOption(font)
  if (!italic || option.id === 'smiley-sans') return option.stack
  return `'${TERMINAL_OBLIQUE[option.id]}', 'Tide Terminal System Oblique', ${FALLBACK}`
}
export function normalizedFontWeight(value: unknown): number {
  return typeof value === 'number' && FONT_WEIGHTS.some(weight => weight === value) ? value : 400
}

export const MONO_FONT_OPTIONS: MonoFontOption[] = [
  {
    id: 'jetbrains',
    labelKey: 'fonts.jetbrains',
    family: 'JetBrains Mono',
    stack: withFallback('JetBrains Mono'),
  },
  { id: 'fira', labelKey: 'fonts.fira', family: 'Fira Code', stack: withFallback('Fira Code') },
  { id: 'consolas', labelKey: 'fonts.consolas', family: 'Consolas', stack: withFallback('Consolas') },
  { id: 'smiley-sans', labelKey: 'fonts.smileySans', family: 'Smiley Sans', stack: withFallback('Smiley Sans') },
  {
    id: 'ibm-plex',
    labelKey: 'fonts.ibmPlex',
    family: 'IBM Plex Mono',
    stack: withFallback('IBM Plex Mono'),
  },
  {
    id: 'source-code',
    labelKey: 'fonts.sourceCode',
    family: 'Source Code Pro',
    stack: withFallback('Source Code Pro'),
  },
  { id: 'system', labelKey: 'fonts.system', family: null, stack: FALLBACK },
]

export const DEFAULT_MONO_FONT: MonoFont = 'jetbrains'
export const SYSTEM_MONO_FONT = FALLBACK
export const BUNDLED_MONO_FONT = withFallback('JetBrains Mono')

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
