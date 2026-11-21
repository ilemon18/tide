import { create } from 'zustand'
import { errorText } from '../lib/ipc'
import { onUpdateProgress, updateApi, type UpdateInfo, type UpdateReport } from '../lib/update'
import { useTabs } from './tabs'
import { useSettings } from './settings'
import { flushEditorSession } from '../lib/editorSession'
import { useUi } from './ui'
import { t } from '../i18n'
import { formatVersion } from '../lib/version'

/**
 * In-app update state (GitHub Releases).
 *
 * Release builds may check and download in the background when the user enables automatic updates.
 * Debug builds skip that path and keep Settings → About as the manual entry. Downloading never installs
 * on its own: a background download asks for confirmation, while manual downloads stop at the ready state.
 *
 * Each status maps to exactly one button label (mapping in `lib/updateView.ts`):
 *
 *   idle/uptodate → check for updates   available → download update
 *   downloading   → downloading 42%    ready     → install update
 *   installing    → installing…         error     → retry
 */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'uptodate'
  | 'error'

type UpdateStore = {
  status: UpdateStatus
  /** null until the build-mode command answers; true hides the title-bar update entry */
  debugBuild: boolean | null
  /** Whether this check was user-triggered or ran automatically at startup */
  manual: boolean
  info: UpdateInfo | null
  /** Download progress 0-100; stays at 100 when done */
  percent: number
  error: string | null
  /** Where install put the app (only set when it differs from the running location) */
  installedTo: string
  /** Internal update log path returned by the native installer; no longer exposed in Settings. */
  logPath: string
  /** Check for updates; a forced manual check bypasses the local cache and cached fallback. */
  check: (manual?: boolean, force?: boolean) => Promise<void>
  /** User action: download and verify through Rust. Background downloads ask before installing. */
  download: (background?: boolean) => Promise<void>
  install: () => Promise<void>
  /** Opens the release page in the browser (the step after a release without an installer) */
  openPage: () => Promise<void>
}

let progressSubscription: (() => void) | null = null
let started = false
let installTimer: ReturnType<typeof setTimeout> | null = null
let autoSettingsUnsubscribe: (() => void) | null = null

async function watchProgress() {
  if (progressSubscription) return
  progressSubscription = await onUpdateProgress((progress) => {
    useUpdate.setState({ percent: progress.percent })
  })
}

function unwatchProgress() {
  progressSubscription?.()
  progressSubscription = null
}

function clearInstallTimer() {
  if (installTimer) clearTimeout(installTimer)
  installTimer = null
}

/**
 * Flush this window's work to disk before install: settings / session (400ms debounced) and unsaved edits.
 * Other windows do the same via the Rust `update:flush` broadcast (see `App.tsx`).
 */
export async function flushBeforeInstall() {
  useSettings.getState().flush()
  flushEditorSession()
  await useTabs.getState().saveAll()
}

export const useUpdate = create<UpdateStore>((set, get) => ({
  status: 'idle',
  debugBuild: null,
  manual: false,
  info: null,
  percent: 0,
  error: null,
  installedTo: '',
  logPath: '',

  check: async (manual = false, force = false) => {
    const state = get()
    if (!manual && state.debugBuild === true) return
    if (
      state.status === 'checking' ||
      state.status === 'downloading' ||
      state.status === 'ready' ||
      state.status === 'installing'
    ) {
      return
    }
    // A downloaded package beats a fresh check
    if (!manual && state.status === 'available') return

    set({ status: 'checking', manual, error: null })
    const toast = useUi.getState().toast
    try {
      const info = await updateApi.check(manual, force)
      set({ info })
      // The fresh check failed and the answer came from the cache: say that instead of presenting
      // an older result as today's
      const stale = info.stale ? t('update.stale') : null
      if (info.available) {
        set({ status: 'available' })
        // The button already offers the update: a toast with the same action is a second copy
        if (manual) toast(stale ?? t('update.available', { version: formatVersion(info.latest) }))
      } else {
        set({ status: 'uptodate' })
        if (manual) {
          toast(
            stale ?? t('settings.about.upToDate', { version: formatVersion(info.current) }),
          )
        }
      }
    } catch (err) {
      const message = errorText(err)
      // A failed background check is noise: the next start retries
      set({ status: manual ? 'error' : 'idle', error: message })
      if (manual) toast(message, 'error')
    }
  },

  download: async (background = false) => {
    const { info, status } = get()
    // Needs a package for the current platform; the UI only offers this when available, this blocks a double click
    if (!info?.available || !info.downloadUrl || (status !== 'available' && status !== 'error')) return
    set({ status: 'downloading', percent: 0, error: null })
    try {
      await watchProgress()
      await updateApi.download(info.downloadUrl, info.assetName, info.checksum)
      clearInstallTimer()
      // The file is on disk now, nothing left to watch
      unwatchProgress()
      set({ status: 'ready', percent: 100 })
      if (background && useSettings.getState().autoUpdate) {
        const info = get().info
        const confirmed = await useUi.getState().confirm({
          title: t('settings.about.installUpdate'),
          message: t('settings.about.installPrompt', {
            version: formatVersion(info?.latest ?? ''),
          }),
          confirmText: t('settings.about.install'),
        })
        if (confirmed) await get().install()
      }
    } catch (err) {
      set({ status: 'error', error: errorText(err) })
      useUi.getState().toast(errorText(err), 'error')
      unwatchProgress()
    }
  },

  install: async () => {
    const { status, info } = get()
    if (status !== 'ready') return
    set({ status: 'installing', error: null })
    try {
      // The app exits right after this: the last edit must not be lost
      await flushBeforeInstall()
      // Save As can be cancelled and individual saves may fail without rejecting saveAll.
      if (useTabs.getState().tabs.some((tab) => tab.dirty)) {
        throw new Error(t('update.unsavedEdits'))
      }
      const outcome = await updateApi.install(info?.latest ?? '')
      set({ installedTo: outcome.installedTo, logPath: outcome.logPath })
      if (outcome.mode === 'manual') {
        set({ status: 'available' })
        useUi.getState().toast(t('update.shownInFileManager', { path: outcome.path }))
        return
      }
      const moved = Boolean(outcome.previous && outcome.installedTo !== outcome.previous)
      useUi
        .getState()
        .toast(
          moved
            ? t('update.installingInto', { path: outcome.installedTo })
            : t('update.restarting'),
        )
      // The helper ends the app within a second. If it does not, the install never started and
      // the button must not stay stuck on "installing".
      clearInstallTimer()
      installTimer = setTimeout(() => {
        installTimer = null
        if (useUpdate.getState().status !== 'installing') return
        useUpdate.setState({
          status: 'ready',
          error: t('update.didNotRestart'),
        })
      }, 15_000)
    } catch (err) {
      clearInstallTimer()
      set({ status: 'error', error: errorText(err) })
      useUi.getState().toast(errorText(err), 'error')
      unwatchProgress()
    }
  },

  openPage: async () => {
    const url = get().info?.pageUrl
    if (!url) return
    try {
      await updateApi.openPage(url)
    } catch (err) {
      useUi.getState().toast(errorText(err), 'error')
    }
  },

}))

/**
 * Report the outcome of the install attempt from the previous launch.
 *
 * "Restart to update" used to sound trustworthy by itself: the helper can fail after the app exits and nothing
 * says so. The version marker makes it visible — the one case nobody could explain, "it restarted but is
 * still the old version".
 */
async function reportStartup(): Promise<UpdateReport | null> {
  let report: UpdateReport | null = null
  try {
    report = await updateApi.startupReport()
  } catch {
    return null
  }
  if (!report) return null
  const toast = useUi.getState().toast
  useUpdate.setState({ logPath: report.logPath })
  if (report.ok) {
    toast(t('update.updated', { version: formatVersion(report.current) }))
    return report
  }
  const message = t('update.notEffective', {
    version: formatVersion(report.attempted),
    current: formatVersion(report.current),
  })
  useUpdate.setState({
    // Not ready: the downloaded file went away with the old process,
    // the only useful next step is downloading again
    status: 'error',
    info: null,
    error: message,
  })
  toast(message, 'error')
  return report
}

async function runAutomaticUpdate() {
  if (!useSettings.getState().autoUpdate) return
  await useUpdate.getState().check(false)
  const state = useUpdate.getState()
  if (useSettings.getState().autoUpdate && state.status === 'available') {
    await useUpdate.getState().download(true)
  }
}

/**
 * Startup work: report the last install, then check for updates.
 * Called once by the app shell; safe across React StrictMode remounts and HMR reloads.
 */
export function startUpdateWatcher() {
  if (started) return
  started = true
  void (async () => {
    let debugBuild = false
    try {
      debugBuild = await updateApi.isDebugBuild()
    } catch {
      // A failed probe must not disable updates in a packaged release build.
    }
    useUpdate.setState({ debugBuild })

    autoSettingsUnsubscribe?.()
    autoSettingsUnsubscribe = useSettings.subscribe((state, previous) => {
      if (
        debugBuild ||
        !state.loaded ||
        !state.autoUpdate ||
        state.autoUpdate === previous.autoUpdate
      ) {
        return
      }
      void runAutomaticUpdate()
    })

    // Debug builds keep Settings → About as the only update entry: no install report and no
    // startup network/cache read. Manual checks and their download/install flow remain available.
    if (debugBuild) return

    const report = await reportStartup()
    // A "last install failed" report is the most important thing on screen:
    // a quiet check would replace it with "new version available" and bury it
    if (report && !report.ok) return
    if (useSettings.getState().autoUpdate) await runAutomaticUpdate()
  })()
}
