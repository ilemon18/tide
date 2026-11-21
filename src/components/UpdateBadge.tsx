import { useMemo } from 'react'
import { useUpdate } from '../store/update'
import { runUpdateAction, updateAction, updateTip, type UpdateView } from '../lib/updateView'
import { Icon } from './Icon'
import { useT } from '../i18n'

/**
 * The "update available" entry, drawn first in the titlebar's right-side button row.
 *
 * Each click advances the explicit download/install step currently offered. A fixed circular indicator
 * sits beside the label. Labels and actions are shared with Settings → About through updateView.
 *
 * Rendered only in the **main window of a release build**: check / download / install are owned by the
 * main window (with several windows open there is no point downloading N copies); debug builds keep
 * Settings → About as their only update entry.
 */
export function UpdateBadge({ primary }: { primary: boolean }) {
  const t = useT()
  const status = useUpdate((s) => s.status)
  const debugBuild = useUpdate((s) => s.debugBuild)
  const manual = useUpdate((s) => s.manual)
  const info = useUpdate((s) => s.info)
  const percent = useUpdate((s) => s.percent)
  const error = useUpdate((s) => s.error)
  const installedTo = useUpdate((s) => s.installedTo)

  const view: UpdateView = useMemo(
    () => ({ status, info, percent, error, installedTo, version: null }),
    [status, info, percent, error, installedTo],
  )
  const action = updateAction(view)
  const tip = updateTip(view)
  const busy = action.kind === 'wait'
  // Stay quiet in the titlebar when there is no update and no download in progress
  const visible =
    debugBuild === false &&
    primary &&
    (status === 'available' ||
      status === 'downloading' ||
      status === 'ready' ||
      status === 'installing' ||
      status === 'error' ||
      (status === 'checking' && manual))
  if (!visible) return null

  return (
    <button
      type="button"
      onClick={() => {
        if (!busy) runUpdateAction(action.kind)
      }}
      // aria-disabled instead of disabled: a disabled button swallows pointer events,
      // and the "downloading 42%" tooltip is exactly what the busy state should say
      aria-disabled={busy}
      aria-label={tip}
      aria-busy={busy}
      data-tip={tip}
      className={`relative flex h-6 shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--r-control)] px-2 transition-colors duration-fast ${
        busy
          ? 'cursor-default text-muted'
          : action.tone === 'accent'
            ? 'text-accent hover:bg-hover'
            : action.tone === 'danger'
              ? 'text-warning hover:bg-hover'
              : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {status === 'downloading' ? (
        <svg aria-hidden="true" width={16} height={16} viewBox="0 0 16 16" className="shrink-0 -rotate-90">
          <circle cx={8} cy={8} r={6.5} fill="none" stroke="currentColor" strokeOpacity={0.22} strokeWidth={1.5} />
          <circle
            cx={8}
            cy={8}
            r={6.5}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100 - action.percent}
            className="transition-[stroke-dashoffset] duration-200 ease-linear"
          />
        </svg>
      ) : (
        <Icon
          name={action.icon}
          size={16}
          className={
            action.motion === 'spin'
              ? 'shrink-0 animate-spin'
              : action.motion === 'pulse'
                ? 'shrink-0 animate-pulse'
                : 'shrink-0'
          }
        />
      )}
      <span className="text-2xs tabular-nums leading-none">{action.label}</span>
      <span role="status" aria-live="polite" className="sr-only">
        {status === 'downloading'
          ? t('update.downloading', {
              // Announce every 10%: ten announcements per file instead of hundreds
              percent: Math.min(100, Math.max(0, Math.floor(percent / 10) * 10)),
            })
          : action.label}
      </span>
    </button>
  )
}
