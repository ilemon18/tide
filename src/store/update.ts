import { create } from 'zustand'
import { errorText } from '../lib/ipc'
import { onUpdateProgress, updateApi, type UpdateInfo, type UpdateReport } from '../lib/update'
import { useTabs } from './tabs'
import { useSettings } from './settings'
import { flushEditorSession } from '../lib/editorSession'
import { useUi } from './ui'
import { t } from '../i18n'

/**
 * In-app update state (GitHub Releases).
 *
 * Release builds check once per start: cheap and quiet, and the only way the update entry appears without
 * the user looking for it. Debug builds skip that path and keep Settings → About as the manual entry.
 * Downloading is user-driven: the title-bar icon and the button in Settings → About both drive the same
 * state machine, so the two can never disagree.
 *
 * Each status maps to exactly one button label (mapping in `lib/updateView.ts`):
 *
 *   idle/uptodate → check for updates   available → download update
 *   downloading   → 42%                 ready     → restart to update
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
  /** `update.log`: go look when install fails instead of guessing */
  logPath: string
  check: (manual?: boolean) => Promise<void>
  download: () => Promise<void>
  install: () => Promise<void>
  /** Opens the release page in the browser (the step after a release without an installer) */
  openPage: () => Promise<void>
  revealLog: () => Promise<void>
}

let progressSubscription: (() => void) | null = null
let started = false
let installTimer: ReturnType<typeof setTimeout> | null = null

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

  check: async (manual = false) => {
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
      const info = await updateApi.check(manual)
      set({ info })
      // The fresh check failed and the answer came from the cache: say that instead of presenting
      // an older result as today's
      const stale = info.stale ? t('update.stale') : null
      if (info.available) {
        set({ status: 'available' })
        // The button already becomes "download update": a toast with the same action is a second copy
        if (manual) toast(stale ?? t('update.available', { version: info.latest }))
      } else {
        set({ status: 'uptodate' })
        if (manual) {
          toast(
            stale ?? t('settings.about.upToDate', { version: info.current }),
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

  download: async () => {
    const { info, status } = get()
    // Needs a package for the current platform; the UI only offers this when available, this blocks a double click
    if (!info?.available || !info.downloadUrl || status === 'downloading') return
    set({ status: 'downloading', percent: 0, error: null })
    await watchProgress()
    try {
      await updateApi.download(info.downloadUrl, info.assetName, info.checksum)
      clearInstallTimer()
      // The file is on disk now, nothing left to watch
      unwatchProgress()
      set({ status: 'ready', percent: 100 })
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
    // The app exits right after this: the last edit must not be lost
    await flushBeforeInstall()
    try {
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

  revealLog: async () => {
    try {
      const path = await updateApi.revealLog()
      set({ logPath: path })
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
    toast(t('update.updated', { version: report.current }))
    return report
  }
  const message = t('update.notEffective', {
    version: report.attempted,
    current: report.current,
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

    // Debug builds keep Settings → About as the only update entry: no install report and no
    // startup network/cache read. Manual checks and their download/install flow remain available.
    if (debugBuild) return

    const report = await reportStartup()
    // A "last install failed" report is the most important thing on screen:
    // a quiet check would replace it with "new version available" and bury it
    if (report && !report.ok) return
    void useUpdate.getState().check(false)
  })()
}
