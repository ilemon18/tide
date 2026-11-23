/**
 * Memory budgets in one place.
 *
 * Lightweight mode (settings.lightweightMode) trades some conveniences for a smaller footprint. Every
 * limit that costs memory reads through here instead of hard-coding its own constant, so the switch has
 * one owner and a single place to see what it actually changes.
 *
 * This module imports nothing: the editor state cache, the stores and the settings store all depend on
 * it, and pulling the settings store in would create a cycle (settings → stateCache → settings).
 */

export type MemoryProfile = 'normal' | 'light'

let profile: MemoryProfile = 'normal'

export function setMemoryProfile(next: MemoryProfile) {
  profile = next
}

export function currentMemoryProfile(): MemoryProfile {
  return profile
}

/** Lightweight mode on / off */
export function lightMemory(): boolean {
  return profile === 'light'
}

/**
 * Limits, read at use time (never captured at module load, so toggling the setting takes effect without
 * a restart). Byte / char limits describe resident documents; count limits describe cached entries.
 */
export const budget = {
  /** Project task output characters, completed runs and parsed diagnostics per workspace. */
  taskOutputChars: () => (lightMemory() ? 64 * 1024 : 256 * 1024),
  taskHistory: () => (lightMemory() ? 3 : 8),
  taskProblems: () => (lightMemory() ? 200 : 500),
  /** Context snapshot limits; request hard limits mirror agent/mod.rs. */
  agentAttachments: () => 8,
  agentAttachmentBytes: () => 32 * 1024,
  agentMessageAttachmentBytes: () => 128 * 1024,
  agentUnsentAttachmentBytes: () => (lightMemory() ? 512 * 1024 : 1024 * 1024),
  /** EditorStates kept resident (doc + syntax tree + undo history per tab) */
  editorStates: () => (lightMemory() ? 3 : 8),
  /** Large / preview documents kept resident at once */
  heavyEditorStates: () => (lightMemory() ? 1 : 2),
  /** Total character budget for evictable documents (~2 bytes/char, and the syntax tree multiplies it) */
  editorChars: () => (lightMemory() ? 600_000 : 2_000_000),
  /** Blame results (each can hold thousands of line ranges) */
  blameEntries: () => (lightMemory() ? 4 : 24),
  /** Commit hover details (each carries diff hunks) */
  commitDetails: () => (lightMemory() ? 4 : 24),
  /** Quick-open file index cap */
  quickOpenFiles: () => (lightMemory() ? 10_000 : 50_000),
  /** Terminal scrollback lines actually allocated */
  terminalScrollback: (setting: number) => (lightMemory() ? Math.min(setting, 1000) : setting),
  /** Files restored into tabs at startup */
  restoredTabs: () => (lightMemory() ? 4 : 12),
  /** Matches returned per file-search run */
  searchResults: () => (lightMemory() ? 200 : 500),
  /** Delay before caches are dropped after the window loses focus */
  idleReclaimDelay: () => (lightMemory() ? 5_000 : 30_000),
  /** Fallback git status poll (the file watcher is the main path) */
  gitPollInterval: () => (lightMemory() ? 60_000 : 10_000),
  /** Above this size the editor drops syntax highlighting extras (see editor/largeFile.ts) */
  largeFileBytes: () => (lightMemory() ? 512 * 1024 : 1024 * 1024),
  /** Above this size a file opens read-only in the plain preview */
  previewFileBytes: () => (lightMemory() ? 2 * 1024 * 1024 : 5 * 1024 * 1024),
  /** Rows rendered by the side-by-side diff / full-file diff view; parsing stops at this cap too */
  diffRows: () => (lightMemory() ? 1500 : 3000),
}

/** Feature switches: what lightweight mode turns off outright (surfaced in the settings hint) */
export const feature = {
  /** Inline git blame: a `git blame` run per file switch, plus the range data */
  inlineBlame: () => !lightMemory(),
  /** Import-path links: a viewport scan on every update */
  importLinks: () => !lightMemory(),
  /** Background quick-open index build on project open (still built on first ⌘P) */
  eagerFileIndex: () => !lightMemory(),
}

/**
 * Set by lib/memory at startup. Turning lightweight mode on has to free what the smaller budget excludes
 * right away, but the settings store cannot import lib/memory (lib/memory reaches into the stores, which
 * import the settings store). A callback keeps the direction one-way.
 */
let profileHook: (() => void) | null = null

export function onMemoryProfileChange(hook: () => void) {
  profileHook = hook
}

/** Call after setMemoryProfile when switching to lightweight mode */
export function applyMemoryProfileChange() {
  profileHook?.()
}
