import { normalizeCommitTemplates } from '../lib/commitMessages'
import { normalizeOverrides, overridesEqual } from '../lib/shortcuts'
import { create } from 'zustand'
import { api, errorText, type MonoFont, type Settings } from '../lib/ipc'
import {
  applyLigatures,
  applyMonoFont,
  applyTheme,
  applyUiFontSize,
  applyUiFontStyle,
  applyCodeFontStyle,
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
import { DEFAULT_MONO_FONT, normalizedFontWeight } from '../lib/fonts'
import { applyLocale, DEFAULT_LOCALE, isLocale } from '../i18n'
import { applyMemoryProfileChange, setMemoryProfile } from '../lib/memoryBudget'

export const SETTINGS_SCHEMA_VERSION = 20
export const AGENT_COMPOSER_MIN_HEIGHT = 90
export const AGENT_COMPOSER_MAX_HEIGHT = 480

export const DEFAULT_SETTINGS: Settings = {
  shortcutOverrides: {},
  schemaVersion: SETTINGS_SCHEMA_VERSION,
  locale: DEFAULT_LOCALE,
  theme: DEFAULT_THEME,
  iconTheme: DEFAULT_ICON_THEME,
  fontFamily: DEFAULT_MONO_FONT,
  fontWeight: 400,
  fontItalic: false,
  uiFontWeight: 400,
  uiFontItalic: false,
  uiFontSize: 13,
  fontSize: 13,
  commitMessageTemplates: [],
  terminalFontSize: 12,
  terminalFontWeight: 400,
  terminalFontItalic: false,
  terminalScrollback: 2000,
  terminalShell: '',
  tabSize: 2,
  autoSave: false,
  wordWrap: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  indentGuides: true,
  rainbowBrackets: true,
  ligatures: false,
  formatMode: 'off',
  formatTool: 'auto',
  showHidden: true,
  compactFolders: true,
  inlineBlame: false,
  terminalWebgl: false,
  lightweightMode: false,
  autoUpdate: false,
  configBackupEnabled: false,
  configBackupFolder: '',
  configBackupInterval: 'daily',
  configBackupMode: 'dated',
  configBackupLastAt: 0,
  agentEnabled: true,
  tasksEnabled: true,
  goLiveEnabled: true,
  agentHistoryEnabled: true,
  activityBarWelcomeVisible: true,
  activityBarGitVisible: true,
  activityBarStructureVisible: true,
  agentDefaultProvider: '',
  agentDefaultModel: '',
  agentDefaultEffort: '',
  agentDefaultPermissionMode: 'workspace-write',
  agentComposerHeight: AGENT_COMPOSER_MIN_HEIGHT,
  sidebarWidth: 220,
  panelHeight: 240,
  sidebarVisible: true,
  panelVisible: false,
}

type SettingsStore = Settings & {
  exportSettings: () => Settings
  importSettings: (raw: Settings) => Promise<void>
  flushAsync: () => Promise<void>
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
  'schemaVersion',
  'shortcutOverrides',
  'locale',
  'theme',
  'iconTheme',
  'fontFamily',
  'fontWeight',
  'fontItalic',
  'uiFontWeight',
  'uiFontItalic',
  'uiFontSize',
  'fontSize',
  'commitMessageTemplates',
  'terminalFontSize',
  'terminalFontWeight',
  'terminalFontItalic',
  'terminalScrollback',
  'terminalShell',
  'tabSize',
  'autoSave',
  'wordWrap',
  'trimTrailingWhitespace',
  'insertFinalNewline',
  'indentGuides',
  'rainbowBrackets',
  'ligatures',
  'formatMode',
  'formatTool',
  'showHidden',
  'compactFolders',
  'inlineBlame',
  'terminalWebgl',
  'lightweightMode',
  'autoUpdate',
  'configBackupEnabled',
  'configBackupFolder',
  'configBackupInterval',
  'configBackupMode',
  'configBackupLastAt',
  'agentEnabled',
  'tasksEnabled',
  'goLiveEnabled',
  'agentHistoryEnabled',
  'activityBarWelcomeVisible',
  'activityBarGitVisible',
  'activityBarStructureVisible',
  'agentDefaultProvider',
  'agentDefaultModel',
  'agentDefaultEffort',
  'agentDefaultPermissionMode',
  'agentComposerHeight',
] as const satisfies readonly (keyof Settings)[]

/** Compare content, including cloned arrays in native cross-window broadcasts. */
function settingEqual(key: keyof Settings, a: Settings, b: Settings): boolean {
  if (key === 'shortcutOverrides') return overridesEqual(a[key], b[key])
  if (key === 'commitMessageTemplates') return a[key].length === b[key].length && a[key].every((value, index) => value === b[key][index])
  return a[key] === b[key]
}
function settingsEqual(a: Settings, b: Settings): boolean {
  return (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]).every(key => settingEqual(key, a, b))
}

/**
 * Fields on disk this version does not know yet are written back as-is: otherwise a newer version's config
 * loses them after one open in an older version, and the user sees "settings reset after the update".
 */
let unknownFields: Record<string, unknown> = {}

/** Retired settings: unknown and no longer written back. Without this list old keys stay "unknown" forever. */
const RETIRED_KEYS = new Set(['breadcrumbs', 'activityBarTasksVisible'])

/** Pick the keys this version does not know from the loaded config */
function pickUnknownFields(raw: Settings): Record<string, unknown> {
  const known = new Set(Object.keys(DEFAULT_SETTINGS))
  const extras: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key) && !RETIRED_KEYS.has(key)) extras[key] = value
  }
  return extras
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** Serial write queue: IPC commands run concurrently, two quick theme clicks can land out of order, chaining keeps it ordered */
let saveChain: Promise<unknown> = Promise.resolve()
let saveError: unknown = null

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
    .then(async () => { await api.saveSettings(settings); saveError = null })
    .catch((e) => { saveError = e; console.error('保存设置失败', errorText(e)) })
}

function snapshot(s: SettingsStore): Settings {
  const values = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, s[key as keyof Settings]]))
  return { ...unknownFields, ...values, schemaVersion: Math.max(SETTINGS_SCHEMA_VERSION, s.schemaVersion) } as Settings
}

/** Appearance and Agent defaults write at once so a new window can read the latest choices. */
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
export function migrateSettings(raw: Settings): Settings {
  const next = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const value = raw[key]
    const fallback = DEFAULT_SETTINGS[key]
    if (typeof value !== typeof fallback) continue
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0 || (key !== 'configBackupLastAt' && value > 0xffffffff) || (!['schemaVersion', 'configBackupLastAt'].includes(key) && value === 0))) continue
    // Date's calendar range is narrower than the native timestamp integer; reject unusable backups.
    if (key === 'configBackupLastAt' && typeof value === 'number' && !Number.isFinite(new Date(value).getTime())) continue
    ;(next as Record<string, unknown>)[key] = value
  }
  for (const key of RETIRED_KEYS) delete (next as unknown as Record<string, unknown>)[key]
  const version = typeof raw.schemaVersion === 'number' && Number.isFinite(raw.schemaVersion) ? raw.schemaVersion : 0

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

  // v8 -> v9 adds ligatures, v9 -> v10 adds agentComposerHeight, v10 -> v11 adds
  // agentDefaultPermissionMode, v11 -> v12 adds autoUpdate, v12 -> v13 adds agentHistoryEnabled,
  // v15 -> v16 adds the activity bar visibility switches. DEFAULT_SETTINGS covers
  // v16 -> v17 adds configuration backup preferences; missing values use DEFAULT_SETTINGS.
  // v17 -> v18 adds Go Live visibility, independent font styling and rainbow brackets, preserving existing preferences.
  // v18 -> v19 adds terminal styling; v19 -> v20 adds bounded common commit messages.
  // Keep larger stored heights when the current window is short: the composer clamps them for display only.
  next.shortcutOverrides = normalizeOverrides(next.shortcutOverrides)
  next.schemaVersion = Math.max(SETTINGS_SCHEMA_VERSION, next.schemaVersion)
  next.fontWeight = normalizedFontWeight(next.fontWeight)
  next.uiFontWeight = normalizedFontWeight(next.uiFontWeight)
  next.commitMessageTemplates = normalizeCommitTemplates(raw.commitMessageTemplates)
  next.terminalFontWeight = normalizedFontWeight(next.terminalFontWeight)
  if (!['daily', 'threeDays', 'weekly', 'monthly'].includes(next.configBackupInterval)) next.configBackupInterval = DEFAULT_SETTINGS.configBackupInterval
  if (!['overwrite', 'dated'].includes(next.configBackupMode)) next.configBackupMode = DEFAULT_SETTINGS.configBackupMode
  if (!next.configBackupFolder) next.configBackupEnabled = false
  // Native integer settings must remain JSON integers after importing hand-edited files.
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (typeof next[key] === 'number') (next as Record<string, unknown>)[key] = Math.round(next[key] as number)
  }

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

  // Agent defaults: free-form ids stay as written (a provider may add models later); only
  // the switch itself is normalized, so a corrupt value cannot hide the feature.
  if (typeof next.agentEnabled !== 'boolean') next.agentEnabled = true
  if (typeof next.tasksEnabled !== 'boolean') next.tasksEnabled = true
  if (typeof next.goLiveEnabled !== 'boolean') next.goLiveEnabled = true
  if (typeof next.agentHistoryEnabled !== 'boolean') next.agentHistoryEnabled = true
  if (typeof next.activityBarWelcomeVisible !== 'boolean') next.activityBarWelcomeVisible = true
  if (typeof next.activityBarGitVisible !== 'boolean') next.activityBarGitVisible = true
  if (typeof next.activityBarStructureVisible !== 'boolean') next.activityBarStructureVisible = true
  if (typeof next.autoUpdate !== 'boolean') next.autoUpdate = false
  if (typeof next.agentDefaultProvider !== 'string') next.agentDefaultProvider = ''
  if (typeof next.agentDefaultModel !== 'string') next.agentDefaultModel = ''
  if (typeof next.agentDefaultEffort !== 'string') next.agentDefaultEffort = ''
  if (!['read-only', 'workspace-write', 'full-access'].includes(next.agentDefaultPermissionMode)) {
    next.agentDefaultPermissionMode = DEFAULT_SETTINGS.agentDefaultPermissionMode
  }
  if (
    typeof next.agentComposerHeight !== 'number' ||
    !Number.isFinite(next.agentComposerHeight)
  ) {
    next.agentComposerHeight = AGENT_COMPOSER_MIN_HEIGHT
  } else {
    next.agentComposerHeight = Math.max(
      AGENT_COMPOSER_MIN_HEIGHT,
      Math.round(next.agentComposerHeight),
    )
  }
  return next
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...DEFAULT_SETTINGS,
  exportSettings: () => snapshot(get()),
  importSettings: async raw => {
    const next = migrateSettings(raw)
    await api.configRecovery(snapshot(get()))
    unknownFields = pickUnknownFields(raw)
    get().patch(next)
    await get().flushAsync()
  },
  flushAsync: async () => { get().flush(); await saveChain; if (saveError) throw saveError },
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
      settings = migrateSettings(loaded)
      migrated = !settingsEqual(settings, { ...DEFAULT_SETTINGS, ...loaded })
    } catch (e) {
      console.error('读取设置失败，使用默认值', errorText(e))
    }
    const palette = applyTheme(settings.theme as ThemeMode)
    applyLocale(settings.locale)
    applyUiFontSize(settings.uiFontSize)
    applyUiFontStyle(settings.uiFontWeight, settings.uiFontItalic)
    applyCodeFontStyle(settings.fontWeight, settings.fontItalic)
    applyLigatures(settings.ligatures)
    applyMonoFont(monoStack(settings.fontFamily))
    setMemoryProfile(settings.lightweightMode ? 'light' : 'normal')
    setEditorLook(palette, settings.fontSize, settings.fontFamily, settings.fontWeight, settings.fontItalic)
    set({ ...settings, palette, loaded: true })

    watchSystemTheme(
      () => get().theme as ThemeMode,
      (p) => {
        setEditorLook(p, get().fontSize, get().fontFamily, get().fontWeight, get().fontItalic)
        set({ palette: p })
      },
    )

    // Write the migrated config back to disk
    if (migrated) persist(get)
  },

  patch: (patch) => {
    if (patch.shortcutOverrides !== undefined) patch = { ...patch, shortcutOverrides: normalizeOverrides(patch.shortcutOverrides) }
    set(patch as Partial<SettingsStore>)
    if (patch.locale) applyLocale(patch.locale)
    if (patch.lightweightMode !== undefined) {
      setMemoryProfile(patch.lightweightMode ? 'light' : 'normal')
      // Free right away what the smaller budget excludes (see lib/memory.ts)
      if (patch.lightweightMode) applyMemoryProfileChange()
    }
    if (patch.theme) {
      const palette = applyTheme(patch.theme as ThemeMode)
      setEditorLook(palette, get().fontSize, get().fontFamily, get().fontWeight, get().fontItalic)
      set({ palette })
    } else if (patch.fontSize !== undefined || patch.fontFamily !== undefined || patch.fontWeight !== undefined || patch.fontItalic !== undefined) {
      setEditorLook(get().palette, get().fontSize, get().fontFamily, get().fontWeight, get().fontItalic)
    }
    if (patch.uiFontSize !== undefined) applyUiFontSize(patch.uiFontSize)
    if (patch.uiFontWeight !== undefined || patch.uiFontItalic !== undefined) applyUiFontStyle(get().uiFontWeight, get().uiFontItalic)
    if (patch.fontWeight !== undefined || patch.fontItalic !== undefined) applyCodeFontStyle(get().fontWeight, get().fontItalic)
    if (patch.ligatures !== undefined) applyLigatures(patch.ligatures)
    if (patch.fontFamily !== undefined) applyMonoFont(monoStack(patch.fontFamily as MonoFont))
    // Appearance and Agent defaults persist at once for new / other windows.
    const immediate =
      patch.shortcutOverrides !== undefined ||
      patch.locale !== undefined ||
      patch.theme !== undefined ||
      patch.iconTheme !== undefined ||
      patch.fontFamily !== undefined ||
      patch.fontWeight !== undefined ||
      patch.fontItalic !== undefined ||
      patch.uiFontWeight !== undefined ||
      patch.uiFontItalic !== undefined ||
      patch.commitMessageTemplates !== undefined ||
      patch.terminalFontWeight !== undefined ||
      patch.terminalFontItalic !== undefined ||
      patch.uiFontSize !== undefined ||
      patch.autoUpdate !== undefined ||
      patch.configBackupEnabled !== undefined ||
      patch.configBackupFolder !== undefined ||
      patch.configBackupLastAt !== undefined ||
      patch.tasksEnabled !== undefined ||
      patch.goLiveEnabled !== undefined ||
      patch.agentHistoryEnabled !== undefined ||
      patch.agentDefaultProvider !== undefined ||
      patch.agentDefaultModel !== undefined ||
      patch.agentDefaultEffort !== undefined ||
      patch.agentDefaultPermissionMode !== undefined
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
    const extras = pickUnknownFields(next)
    next = migrateSettings(next)
    if (isSelfEcho(next)) return
    unknownFields = extras
    const current = get()
    // Follow all shared fields, else this window's stale value writes the other side's change back on next save
    const patch: Partial<SettingsStore> = {}
    for (const key of SHARED_KEYS) {
      if (!settingEqual(key, next, current)) (patch as Record<string, unknown>)[key] = next[key]
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
      setEditorLook(palette, get().fontSize, get().fontFamily, get().fontWeight, get().fontItalic)
      set({ palette })
    } else if (patch.fontSize !== undefined || patch.fontFamily !== undefined || patch.fontWeight !== undefined || patch.fontItalic !== undefined) {
      setEditorLook(get().palette, get().fontSize, get().fontFamily, get().fontWeight, get().fontItalic)
    }
    if (patch.uiFontSize !== undefined) applyUiFontSize(patch.uiFontSize)
    if (patch.uiFontWeight !== undefined || patch.uiFontItalic !== undefined) applyUiFontStyle(get().uiFontWeight, get().uiFontItalic)
    if (patch.fontWeight !== undefined || patch.fontItalic !== undefined) applyCodeFontStyle(get().fontWeight, get().fontItalic)
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
