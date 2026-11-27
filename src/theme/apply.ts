import { getCurrentWindow } from '@tauri-apps/api/window'
import { paletteFor, cssVars, type Palette, type ThemeMode } from './palettes'

let systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
let currentPalette: Palette = paletteFor('tide', true)

export function activePalette(): Palette {
  return currentPalette
}

/** First-paint fallback: public/theme-boot.js reads this cache synchronously before the bundle */
const APPEARANCE_KEY = 'tide:appearance'

function rememberAppearance(p: Palette) {
  try {
    localStorage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ theme: p.id, bg: p.ui.bg, fg: p.ui.fg, dark: p.dark }),
    )
  } catch {
    /* Cannot write in private mode; only the first-paint fallback is affected */
  }
}

function paint(p: Palette) {
  const root = document.documentElement
  const vars = cssVars(p)
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
  root.dataset.theme = p.id
  root.style.colorScheme = p.dark ? 'dark' : 'light'
  currentPalette = p
  rememberAppearance(p)
}

/** Apply a theme: CSS variables + native window appearance + editor/terminal colors (handled by subscribers) */
export function applyTheme(mode: ThemeMode): Palette {
  const p = paletteFor(mode, systemDark)
  paint(p)
  // Make the macOS native title bar, scrollbars and traffic lights follow the theme
  getCurrentWindow()
    .setTheme(p.dark ? 'dark' : 'light')
    .catch(() => {})
  return p
}

/** UI font size: every --text-* token derives from --ui-fs */
export function applyUiFontSize(size: number) {
  document.documentElement.style.setProperty('--ui-fs', `${size}px`)
}

/** Base UI weight/style; emphasis tokens preserve their relative hierarchy. */
export function applyUiFontStyle(weight: number, italic: boolean) {
  const root = document.documentElement
  root.style.setProperty('--ui-font-weight', String(weight))
  root.style.setProperty('--ui-font-style', italic ? 'italic' : 'normal')
}

export function applyCodeFontStyle(weight: number, italic: boolean) {
  const root = document.documentElement
  root.style.setProperty('--code-font-weight', String(weight))
  root.style.setProperty('--code-font-style', italic ? 'italic' : 'normal')
}

/** Mono font: the CSS font-mono and the editor/terminal share one stack */
export function applyMonoFont(stack: string) {
  document.documentElement.style.setProperty('--font-mono', stack)
}

/** Code ligatures (== / => drawn as one glyph): off unless the setting turns them on */
export function applyLigatures(enabled: boolean) {
  const root = document.documentElement
  if (enabled) root.dataset.ligatures = 'on'
  else delete root.dataset.ligatures
}

/** Watch system appearance changes (only effective when mode === 'system') */
export function watchSystemTheme(getMode: () => ThemeMode, onChange: (p: Palette) => void) {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  if (!mq) return () => {}
  const handler = (e: MediaQueryListEvent) => {
    systemDark = e.matches
    if (getMode() === 'system') {
      const p = applyTheme('system')
      onChange(p)
    }
  }
  mq.addEventListener('change', handler)
  return () => mq.removeEventListener('change', handler)
}
