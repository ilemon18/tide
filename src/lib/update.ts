import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/**
 * The only entry point into the Rust update side (implemented in `src-tauri/src/update.rs`).
 *
 * A separate file instead of more lines in `ipc.ts`: updating is a cross-cutting feature, not a
 * filesystem / Git / terminal command, and mixing it in only makes that already long object harder
 * to read.
 */

export type UpdateInfo = {
  /** A newer release exists and ships an installer for this platform */
  available: boolean
  /** false = the repo has no published release yet. The UI no longer says that on its own: with nothing to
   * compare against, "you are on the latest version" is the honest answer either way */
  hasRelease: boolean
  current: string
  latest: string
  name: string
  pageUrl: string
  publishedAt: string
  assetName: string
  assetSize: number
  downloadUrl: string
  /** Installer SHA-256; empty when the release has no manifest */
  checksum: string
  /** When this answer was fetched (ms since epoch); 0 = never cached */
  checkedAt: number
  /** true = this answer is older than the check that returned it (a fresh one failed) */
  stale: boolean
}

export type UpdateProgress = {
  received: number
  total: number
  percent: number
  done: boolean
}

export type InstallOutcome = {
  /** 'restart' = the helper swaps the bundle and restarts; 'manual' = only revealed in the file manager */
  mode: 'restart' | 'manual'
  path: string
  /** Where it will install (the .app on macOS); empty for 'manual' */
  installedTo: string
  /** Where the current process runs from; only set when the update landed elsewhere */
  previous: string
  logPath: string
}

export type UpdateReport = {
  attempted: string
  current: string
  /** false = the file swap did not take effect: this launch is still the old build */
  ok: boolean
  installedTo: string
  previous: string
  logPath: string
}

export const updateApi = {
  /** Running app version; used by the about page so the frontend stops hardcoding one */
  appVersion: () => invoke<string>('app_version'),
  /** Debug builds only offer updates from Settings → About; the title bar stays quiet */
  isDebugBuild: () => invoke<boolean>('is_debug_build'),
  /**
   * `manual` = the user clicked: re-checks the network, while startup may answer from the cache.
   * `force` = a fresh manual check: bypasses the local cache and forbids a cached fallback.
   */
  check: (manual: boolean, force = false) => invoke<UpdateInfo>('update_check', { manual, force }),
  download: (url: string, fileName: string, checksum: string) =>
    invoke<string>('update_download', { url, fileName, checksum }),
  install: (version: string) => invoke<InstallOutcome>('update_install', { version }),
  startupReport: () => invoke<UpdateReport | null>('update_startup_report'),
  /** Opens the release page; the only next step for a release with no installer attached */
  openPage: (url: string) => invoke<void>('update_open_page', { url }),
}

/** Subscribe to download progress; returns an unsubscribe function */
export async function onUpdateProgress(
  cb: (progress: UpdateProgress) => void,
): Promise<() => void> {
  return listen<UpdateProgress>('update:progress', (event) => cb(event.payload))
}

/**
 * Broadcast to all windows before installing: `update_install` ends the whole process,
 * so each window must flush settings / session / unsaved edits like a normal quit.
 */
export async function onUpdateFlush(cb: () => void): Promise<() => void> {
  return listen('update:flush', () => cb())
}
