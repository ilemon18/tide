import { useEffect, useMemo, useRef, useState } from 'react'
import { useUpdate } from '../store/update'
import { runUpdateAction, updateAction, updateTip, type UpdateView } from '../lib/updateView'
import { Icon } from './Icon'
import { useT } from '../i18n'

/**
 * The "update available" entry, drawn first in the titlebar's right-side button row.
 *
 * One button, one action: click starts the download, the label becomes a percentage and the icon ring
 * fills with progress; once the file is down the same button becomes "Restart to update" and a click
 * installs. Labels come from `lib/updateView.ts`, which the Settings -> About button also reads, so the
 * two never disagree.
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

  const ringRef = useRef<HTMLSpanElement>(null)
  const [ring, setRing] = useState<{ w: number; h: number } | null>(null)

  const view: UpdateView = useMemo(
    () => ({ status, info, percent, error, installedTo, version: null }),
    [status, info, percent, error, installedTo],
  )
  const action = updateAction(view)
  const tip = updateTip(view)
  const busy = action.kind === 'wait'
  const hasLabel =
    status === 'downloading' || status === 'installing' || status === 'ready'

  // The label changes (download update -> 42% -> restart): the ring must follow it
  useEffect(() => {
    const element = ringRef.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      if (!box.width || !box.height) return
      setRing((prev) =>
        prev && Math.abs(prev.w - box.width) < 0.5 && Math.abs(prev.h - box.height) < 0.5
          ? prev
          : { w: box.width, h: box.height },
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [status])

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
      onClick={() => runUpdateAction(action.kind)}
      // aria-disabled instead of disabled: a disabled button swallows pointer events,
      // and the "downloading 42%" tooltip is exactly what the busy state should say
      aria-disabled={busy}
      aria-label={tip}
      aria-busy={busy}
      data-tip={tip}
      className={`relative flex h-6 items-center rounded-[var(--r-control)] transition-colors duration-fast ${
        hasLabel ? 'gap-1.5 px-2' : 'w-6 justify-center'
      } ${
        busy
          ? 'cursor-default text-muted'
          : action.tone === 'accent'
            ? 'text-accent hover:bg-hover'
            : action.tone === 'danger'
              ? 'text-warning hover:bg-hover'
              : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <Icon
        name={action.icon}
        size={15}
        className={
          action.motion === 'spin'
            ? 'animate-spin'
            : action.motion === 'pulse'
              ? 'animate-pulse'
              : ''
        }
      />
      {hasLabel ? (
        <span
          ref={ringRef}
          className="relative inline-flex items-center px-1.5 text-2xs tabular-nums leading-none"
        >
          <span>{action.label}</span>
          {ring && status === 'downloading' ? (
            <svg
              aria-hidden
              width={ring.w}
              height={ring.h}
              viewBox={`0 0 ${ring.w} ${ring.h}`}
              className="pointer-events-none absolute inset-0 overflow-visible"
            >
              {/* Track ring: the full outline the progress fills */}
              <rect
                x={0.75}
                y={0.75}
                width={Math.max(0, ring.w - 1.5)}
                height={Math.max(0, ring.h - 1.5)}
                rx={(ring.h - 1.5) / 2}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.22}
                strokeWidth={1.5}
              />
              <rect
                x={0.75}
                y={0.75}
                width={Math.max(0, ring.w - 1.5)}
                height={Math.max(0, ring.h - 1.5)}
                rx={(ring.h - 1.5) / 2}
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
          ) : null}
        </span>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {status === 'downloading'
          ? t('update.downloading', {
              // Announce every 10%: ten announcements per file instead of hundreds
              percent: Math.min(100, Math.max(10, Math.floor(percent / 10) * 10)),
            })
          : action.label}
      </span>
    </button>
  )
}
