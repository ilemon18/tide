import type { IconName } from '../components/Icon'
import type { UpdateInfo } from './update'
import { useUpdate } from '../store/update'
import { t } from '../i18n'

/**
 * The one place that turns update state into what the user sees.
 *
 * Two controls render the same state machine — the title-bar icon and the button in
 * "Settings → About". If each answered "what comes next" itself, we would end up with two
 * string tables and two copies of `formatSize`, kept in sync by a "change one, change the
 * other" comment. Unified here, they cannot disagree.
 */

/** What one click does. `wait` = nothing to do yet. */
export type UpdateActionKind = 'check' | 'retry' | 'download' | 'openPage' | 'install' | 'wait'

export type UpdateAction = {
  kind: UpdateActionKind
  label: string
  icon: IconName
  /** Icon animation, kept identical across both controls */
  motion: 'none' | 'spin' | 'pulse'
  /** 0–100: the part already on disk */
  percent: number
  tone: 'accent' | 'muted' | 'danger'
}

/** Everything both controls read, gathered so callers stay one line */
export type UpdateView = {
  status: ReturnType<typeof useUpdate.getState>['status']
  info: UpdateInfo | null
  percent: number
  error: string | null
  installedTo: string
  /** Version on disk; null when unavailable */
  version: string | null
}

export function updateAction(view: UpdateView): UpdateAction {
  switch (view.status) {
    case 'downloading':
      return {
        kind: 'wait',
        // The percentage is the label itself; do not translate it
        label: `${view.percent}%`,
        icon: 'download',
        motion: 'none',
        percent: Math.max(2, Math.min(100, view.percent)),
        tone: 'muted',
      }
    case 'installing':
      return {
        kind: 'wait',
        label: t('settings.about.installing'),
        icon: 'refresh',
        motion: 'spin',
        percent: 100,
        tone: 'muted',
      }
    case 'ready':
      return {
        kind: 'install',
        label: t('settings.about.restartUpdate'),
        icon: 'refresh',
        motion: 'pulse',
        percent: 100,
        tone: 'accent',
      }
    case 'checking':
      return {
        kind: 'wait',
        label: t('settings.about.checking'),
        icon: 'refresh',
        motion: 'spin',
        percent: 0,
        tone: 'muted',
      }
    case 'error':
      return {
        kind: 'retry',
        label: t('settings.about.retry'),
        icon: 'warning',
        motion: 'none',
        percent: 0,
        tone: 'danger',
      }
    case 'available':
      // A release without a manifest has no installer URL: the release page is the only way to
      // get the package, so the button says so instead of offering a download that cannot start
      if (!view.info?.downloadUrl) {
        return {
          kind: 'openPage',
          label: t('settings.about.openRelease'),
          icon: 'external',
          motion: 'none',
          percent: 0,
          tone: 'accent',
        }
      }
      return {
        kind: 'download',
        label: t('settings.about.download'),
        icon: 'download',
        motion: 'none',
        percent: 0,
        tone: 'accent',
      }
    default:
      return {
        kind: 'check',
        label: t('settings.about.checkUpdates'),
        icon: 'refresh',
        motion: 'none',
        percent: 0,
        tone: 'muted',
      }
  }
}

/** The step the action button currently offers. */
export function runUpdateAction(kind: UpdateActionKind): void {
  const { info, download, install, check, openPage } = useUpdate.getState()
  switch (kind) {
    case 'download':
      void download()
      return
    case 'openPage':
      void openPage()
      return
    case 'install':
      void install()
      return
    // A failed download retries from the asset whose URL we know; with no usable release
    // in hand, the only useful answer is a fresh check
    case 'retry':
      if (info?.available && info.downloadUrl) void download()
      else void check(true)
      return
    case 'check':
      void check(true)
      return
    default:
      return
  }
}

/** Tooltip on the title-bar icon: one line stating the current step. */
export function updateTip(view: UpdateView): string {
  switch (view.status) {
    case 'downloading':
      return t('update.downloading', { percent: view.percent })
    case 'installing':
      return t('update.installing')
    case 'ready':
      return t('update.clickToInstall')
    case 'error':
      return view.error ?? t('settings.about.updateFailed')
    case 'checking':
      return t('settings.about.checking')
    case 'available':
      return view.info?.downloadUrl
        ? t('update.clickToDownload', {
            version: view.info ? `${view.info.latest} · ${formatSize(view.info.assetSize)}` : '',
          })
        : t('settings.about.openRelease')
    default:
      return t('settings.about.checkUpdates')
  }
}

/** Caption under the "Settings → About" button; null when there is nothing to say. */
export function updateDetail(view: UpdateView): string | null {
  const text = detailText(view)
  if (!text) return null
  // A cached answer from a failed check must not read like today's result
  return view.info?.stale ? `${text} · ${t('update.stale')}` : text
}

function detailText(view: UpdateView): string | null {
  switch (view.status) {
    case 'checking':
      return t('settings.about.checking')
    case 'downloading':
      return t('update.downloading', { percent: view.percent })
    case 'installing':
      return t('update.installing')
    case 'ready':
      return view.installedTo
        ? t('settings.about.downloadedInto', { path: view.installedTo })
        : t('settings.about.downloaded')
    case 'error':
      return view.error ?? t('settings.about.updateFailed')
    case 'available':
      if (!view.info) return null
      // No installer attached: name the version and send the user to the release page
      if (!view.info.downloadUrl) return t('settings.about.noInstaller', { version: view.info.latest })
      return t('settings.about.available', {
        version: view.info.latest,
        size: formatSize(view.info.assetSize),
      })
    case 'uptodate':
      // Nothing newer either way, so the caption always reads as "you are up to date": a separate
      // "no published release yet" line only made a fresh install look broken
      return view.version ? t('settings.about.upToDate', { version: view.version }) : null
    default:
      return null
  }
}

/** 1.2 MB / 640 KB; empty string for 0 (do not show "0 KB" when there is nothing) */
export function formatSize(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}
