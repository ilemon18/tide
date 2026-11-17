import { create } from 'zustand'
import { api, errorText, type MonoFont, type Settings } from '../lib/ipc'
import {
  applyLigatures,
  applyMonoFont,
  applyTheme,
  applyUiFontSize,
  watchSystemTheme,
} from '../theme/apply'
import {
  palettes,
  CYCLE_ORDER,
  DEFAULT_THEME,
  paletteFor,
  type Palette,
  type ThemeMode,
} from '../theme/palettes'
import { monoStack, setEditorLook } from '../editor/stateCache'
import { DEFAULT_ICON_THEME } from '../lib/iconTheme'
import { DEFAULT_MONO_FONT } from '../lib/fonts'
import { applyLocale, DEFAULT_LOCALE, isLocale } from '../i18n'
import { applyMemoryProfileChange, setMemoryProfile } from '../lib/memoryBudget'

export const SETTINGS_SCHEMA_VERSION = 9

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  locale: DEFAULT_LOCALE,
  theme: DEFAULT_THEME,
  iconTheme: DEFAULT_ICON_THEME,
  fontFamily: DEFAULT_MONO_FONT,
  uiFontSize: 13,
  fontSize: 13,
  terminalFontSize: 12,
  terminalScrollback: 2000,
  tabSize: 2,
  autoSave: true,
  wordWrap: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  indentGuides: true,
  ligatures: false,
  formatMode: 'off',
  formatTool: 'auto',
  showHidden: true,
  compactFolders: true,
  inlineBlame: false,
  terminalWebgl: false,
  lightweightMode: false,
  sidebarWidth: 220,
  panelHeight: 240,
  sidebarVisible: true,
  panelVisible: false,
}

type SettingsStore = Settings & {
  loaded: boolean
  palette: Palette
  load: () => Promise<void>
  patch: (patch: Partial<Settings>) => void
  setTheme: (theme: string) => void
  cycleTheme: () => void
  /** Another window changed settings: apply locally, do not write back to disk */
  applyExternal: (next: Settings) => void
  /** Write to disk now (window hide / quit), dropping the pending debounced save */
  flush: () => void
}

/**
 * Fields that must match across windows. Layout fields (sidebar width, panel height, visibility) belong to each
 * window and stay out of sync, otherwise windows fight each other.
 */
const SHARED_KEYS = [
  'locale',
  'theme',
  'iconTheme',
  'fontFamily',
  'uiFontSize',
  'fontSize',
  'terminalFontSize',
  'terminalScrollback',
  'tabSize',
  'autoSave',
  'wordWrap',
  'trimTrailingWhitespace',
  'insertFinalNewline',
  'indentGuides',
  'ligatures',
  'formatMode',
  'formatTool',
  'showHidden',
  'compactFolders',
  'inlineBlame',
  'terminalWebgl',
  'lightweightMode',
] as const satisfies readonly (keyof Settings)[]

/** Compare field by field so JSON key order does not matter */
function settingsEqual(a: Settings, b: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every((key) => a[key] === b[key])
}

/**
 * Fields on disk this version does not know yet are written back as-is: otherwise a newer version's config
 * loses them after one open in an older version, and the user sees "settings reset after the update".
 */
let unknownFields: Record<string, unknown> = {}

/** Retired settings: unknown and no longer written back. Without this list old keys stay "unknown" forever. */
const RETIRED_KEYS = new Set(['breadcrumbs'])

/** Pick the keys this version does not know from the loaded config */
function pickUnknownFields(raw: Settings): Record<string, unknown> {
  const known = new Set(Object.keys(DEFAULT_SETTINGS))
  const extras: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key) && !RETIRED_KEYS.has(key)) extras[key] = value
  }
  return extras
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Serial write queue: IPC commands run concurrently, two quick theme clicks can land out of order, chaining keeps it ordered */
let saveChain: Promise<unknown> = Promise.resolve()

/**
 * The settings:changed broadcast echoes back to us, and during fast edits (arrow-key preview, repeated clicks)
 * those echoes can arrive after a newer local state and roll the theme back. Remember what we just wrote and
 * ignore matching echoes.
 */
const ECHO_WINDOW_MS = 5000
const recentWrites: { at: number; settings: Settings }[] = []

function rememberWrite(settings: Settings) {
  const now = Date.now()
  while (recentWrites.length > 0 && now - recentWrites[0].at > ECHO_WINDOW_MS) recentWrites.shift()
  recentWrites.push({ at: now, settings })
  if (recentWrites.length > 16) recentWrites.shift()
}

function isSelfEcho(next: Settings): boolean {
  const now = Date.now()
  return recentWrites.some((w) => now - w.at <= ECHO_WINDOW_MS && settingsEqual(w.settings, next))
}

function writeSettings(settings: Settings) {
  rememberWrite(settings)
  saveChain = saveChain
    .then(() => api.saveSettings(settings))
    .catch((e) => console.error('保存设置失败', errorText(e)))
}

function snapshot(s: SettingsStore): Settings {
  return {
    // Unknown fields first, then known ones: on conflict this version wins
    ...unknownFields,
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    locale: s.locale,
    theme: s.theme,
    iconTheme: s.iconTheme,
    fontFamily: s.fontFamily,
    uiFontSize: s.uiFontSize,
    fontSize: s.fontSize,
    terminalFontSize: s.terminalFontSize,
    terminalScrollback: s.terminalScrollback,
    tabSize: s.tabSize,
    autoSave: s.autoSave,
    wordWrap: s.wordWrap,
    trimTrailingWhitespace: s.trimTrailingWhitespace,
    insertFinalNewline: s.insertFinalNewline,
    indentGuides: s.indentGuides,
    formatMode: s.formatMode,
    formatTool: s.formatTool,
    showHidden: s.showHidden,
    compactFolders: s.compactFolders,
    inlineBlame: s.inlineBlame,
    terminalWebgl: s.terminalWebgl,
    lightweightMode: s.lightweightMode,
    sidebarWidth: s.sidebarWidth,
    panelHeight: s.panelHeight,
    sidebarVisible: s.sidebarVisible,
    panelVisible: s.panelVisible,
  }
}

/** Persist. Appearance settings (theme / icon set) pass delay = 0 to write at once, else a new window opened right after a theme switch reads the old config. */
function persist(get: () => SettingsStore, delay = 400) {
  if (saveTimer) clearTimeout(saveTimer)
  if (delay <= 0) {
    saveTimer = null
    writeSettings(snapshot(get()))
    return
  }
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeSettings(snapshot(get()))
  }, delay)
}

/** Migrate old configs */
function migrate(raw: Settings): Settings {
  const next = { ...DEFAULT_SETTINGS, ...raw }
  const version = raw.schemaVersion ?? 0

  // v1 → v2: the old default theme was 'system' (really light); unify onto the new default Dracula.
  // Only for v1, otherwise it would override "follow system" chosen by the user in v2.
  if (version < 2) {
    if (!raw.theme || raw.theme === 'system') next.theme = DEFAULT_THEME
    if (raw.theme === 'dark') next.theme = 'dracula'
  }

  // v2→v3 adds iconTheme (DEFAULT_SETTINGS covers it); v3→v4 changes the default theme to Dark Modern: only
  // migrate configs still on the old default Dracula, leave explicit choices alone.
  if (version < 4 && next.theme === 'dracula') next.theme = DEFAULT_THEME

  // v4 → v5: default theme becomes grey-white Tide. Only migrate configs still on the previous default Dark Modern.
  if (version < 5 && next.theme === 'dark-modern') next.theme = DEFAULT_THEME

  // v5 → v6: default sidebar width narrows from 260 to 220.
  // Saved values dragged very wide (>320) converge once, otherwise every start needs a manual shrink.
  if (version < 6 && (raw.sidebarWidth ?? 0) > 320) {
    next.sidebarWidth = DEFAULT_SETTINGS.sidebarWidth
  }

  // v6 → v7: adds locale. Old configs lack it and default to English;
  // an unknown value (added later, then downgraded) also falls back, so the UI never renders empty.
  if (!isLocale(next.locale)) next.locale = DEFAULT_LOCALE

  // v8 -> v9 adds ligatures: DEFAULT_SETTINGS covers it, off by default.
  next.schemaVersion = SETTINGS_SCHEMA_VERSION

  // Theme / icon set / font: only check the type, keep unknown-but-valid strings so an older version does not
  // erase values from a newer config; the render side already falls back (paletteFor → tide, FileIcon → material,
  // font → default).
  if (typeof next.theme !== 'string' || !next.theme) next.theme = DEFAULT_THEME
  if (typeof next.iconTheme !== 'string' || !next.iconTheme) next.iconTheme = DEFAULT_ICON_THEME
  if (typeof next.fontFamily !== 'string' || !next.fontFamily) next.fontFamily = DEFAULT_MONO_FONT

  // Formatting switches have a fixed value set: unknown values fall back to default,
  // so a dirty value cannot suddenly rewrite files on save
  if (!['off', 'manual', 'onSave'].includes(next.formatMode)) {
    next.formatMode = DEFAULT_SETTINGS.formatMode
  }
  if (!['auto', 'prettier', 'rustfmt', 'gofmt', 'black'].includes(next.formatTool)) {
    next.formatTool = DEFAULT_SETTINGS.formatTool
  }
  return next
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  loaded: false,
  palette: palettes.tide,

  load: async () => {
    let settings = DEFAULT_SETTINGS
    // Write back only if the migration changed something: otherwise every window start would overwrite the
    // file with the snapshot it just read and clobber a theme another window just set
    let migrated = false
    try {
      const loaded = await api.loadSettings()
      // Keep fields this version does not know, to write them back unchanged
      unknownFields = pickUnknownFields(loaded)
      settings = migrate(loaded)
      migrated = !settingsEqual(settings, { ...DEFAULT_SETTINGS, ...loaded })
    } catch (e) {
      console.error('读取设置失败，使用默认值', errorText(e))
    }
    const palette = applyTheme(settings.theme as ThemeMode)
    applyLocale(settings.locale)
    applyUiFontSize(settings.uiFontSize)
    applyLigatures(settings.ligatures)
    applyMonoFont(monoStack(settings.fontFamily))
    setMemoryProfile(settings.lightweightMode ? 'light' : 'normal')
    setEditorLook(palette, settings.fontSize, settings.fontFamily)
    set({ ...settings, palette, loaded: true })

    watchSystemTheme(
      () => get().theme as ThemeMode,
      (p) => {
        setEditorLook(p, get().fontSize, get().fontFamily)
        set({ palette: p })
      },
    )

    // Write the migrated config back to disk
    if (migrated) persist(get)
  },

  patch: (patch) => {
    set(patch as Partial<SettingsStore>)
    if (patch.locale) applyLocale(patch.locale)
    if (patch.lightweightMode !== undefined) {
      setMemoryProfile(patch.lightweightMode ? 'light' : 'normal')
      // Free right away what the smaller budget excludes (see lib/memory.ts)
      if (patch.lightweightMode) applyMemoryProfileChange()
    }
    if (patch.theme) {
      const palette = applyTheme(patch.theme as ThemeMode)
      setEditorLook(palette, get().fontSize, get().fontFamily)
      set({ palette })
    } else if (patch.fontSize !== undefined || patch.fontFamily !== undefined) {
      setEditorLook(get().palette, get().fontSize, get().fontFamily)
    }
    if (patch.uiFontSize !== undefined) applyUiFontSize(patch.uiFontSize)
    if (patch.ligatures !== undefined) applyLigatures(patch.ligatures)
    if (patch.fontFamily !== undefined) applyMonoFont(monoStack(patch.fontFamily as MonoFont))
    // Appearance settings persist at once: new / other windows must read the current value
    const immediate =
      patch.locale !== undefined ||
      patch.theme !== undefined ||
      patch.iconTheme !== undefined ||
      patch.fontFamily !== undefined ||
      patch.uiFontSize !== undefined
    persist(get, immediate ? 0 : 400)
  },

  setTheme: (theme) => get().patch({ theme }),

  cycleTheme: () => {
    const current = get().theme
    const index = CYCLE_ORDER.indexOf(current as never)
    const next = CYCLE_ORDER[(index + 1) % CYCLE_ORDER.length]
    get().patch({ theme: next as string })
  },

  applyExternal: (next) => {
    // Our own write echoed back: local state is newer, ignore it
    if (isSelfEcho(next)) return
    const current = get()
    // Follow all shared fields, else this window's stale value writes the other side's change back on next save
    const patch: Partial<SettingsStore> = {}
    for (const key of SHARED_KEYS) {
      if (next[key] !== current[key]) (patch as Record<string, unknown>)[key] = next[key]
    }
    // Layout fields (sidebar width, panel height, ...) are per window, leave them alone
    if (Object.keys(patch).length === 0) return
    if (patch.lightweightMode !== undefined) {
      setMemoryProfile(patch.lightweightMode ? 'light' : 'normal')
      if (patch.lightweightMode) applyMemoryProfileChange()
    }
    set(patch)
    if (patch.locale) applyLocale(patch.locale)
    if (patch.theme) {
      const palette = applyTheme(patch.theme as ThemeMode)
      setEditorLook(palette, get().fontSize, get().fontFamily)
      set({ palette })
    } else if (patch.fontSize !== undefined || patch.fontFamily !== undefined) {
      setEditorLook(get().palette, get().fontSize, get().fontFamily)
    }
    if (patch.uiFontSize !== undefined) applyUiFontSize(patch.uiFontSize)
    if (patch.ligatures !== undefined) applyLigatures(patch.ligatures)
    if (patch.fontFamily !== undefined) applyMonoFont(monoStack(patch.fontFamily as MonoFont))

    // This window may still have a debounced save pending: it holds the pre-merge snapshot and must be dropped
    // here, otherwise it writes the other window's theme change back to the old value
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    writeSettings(snapshot(get()))
  },

  flush: () => {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    writeSettings(snapshot(get()))
  },
}))

export function resolvePalette(theme: string): Palette {
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
  return paletteFor(theme as never, systemDark)
}
