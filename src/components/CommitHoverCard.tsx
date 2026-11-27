import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { absoluteTime, relativeTime } from '../lib/format'
import {
  useCommitHover,
  type CommitHoverContent,
  type CommitHoverTarget,
} from '../store/commitHover'
import { CopyButton } from './CopyButton'
import { currentLocale, t } from '../i18n'

const CARD_WIDTH = 400
const MARGIN = 8

/** The added line at the target position on the new side; no nearest-line or whole-hunk fallback. */
function targetLineFor(content: CommitHoverContent, target: CommitHoverTarget) {
  const source = target.uncommitted ? content.work : content.diff
  const line = target.uncommitted ? target.line : target.origLine
  const hunk = source?.hunks.find(
    (item) =>
      item.newCount > 0 && line >= item.newStart && line < item.newStart + item.newCount,
  )
  const changed = hunk?.lines.find((item) => item.kind === 'add' && item.newLine === line) ?? null
  return { source, changed }
}

/** Inline blame hover card: commit metadata plus the exact added line at the cursor line */
export function CommitHoverCard() {
  const { target, content, cancelHide, hide } = useCommitHover()

  const cardRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{
    left: number
    top: number
    target: CommitHoverTarget
    content: typeof content
  } | null>(null)
  const detail = content?.detail ?? null
  const error = content?.error ?? null

  // Measure the card before positioning: flip below when it doesn't fit, clamp horizontally to the viewport
  useLayoutEffect(() => {
    const el = cardRef.current
    if (!target || !content || !el) {
      setPos(null)
      return
    }
    const width = el.offsetWidth
    const height = el.offsetHeight
    const rect = target.rect

    let top = rect.top - height - MARGIN
    if (top < MARGIN) {
      top = Math.min(rect.bottom + MARGIN, window.innerHeight - height - MARGIN)
    }
    if (top < MARGIN) top = MARGIN
    const left = Math.min(
      Math.max(MARGIN, rect.left),
      Math.max(MARGIN, window.innerWidth - width - MARGIN),
    )
    setPos({ left, top, target, content })
  }, [target, content])

  // Esc closes it; scrolling the editor/list closes it too, so the card stays aligned with the blame text.
  // Scrolling the diff inside the card must not close it.
  useEffect(() => {
    if (!target) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = (e: Event) => {
      // The card may mount after this listener was installed for a pending hover.
      if (e.target instanceof Node && cardRef.current?.contains(e.target)) return
      hide()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [target, hide])

  if (!target || !content) return null
  const positioned = pos?.target === target && pos.content === content

  const fullSha = detail?.sha ?? target.sha
  const shortSha = detail?.shortSha ?? target.sha.slice(0, 7)
  // Keep the blame metadata while showing the completed diff or error in one paint.
  const author = detail?.author || target.author
  const email = detail?.email || target.authorEmail
  const commitEmail = (detail?.email || target.authorEmail).toLowerCase()
  const isYou =
    target.uncommitted ||
    (Boolean(target.currentUserEmail) &&
      commitEmail === target.currentUserEmail.toLowerCase())
  const authorTime = target.authorTime
  const { source, changed } = targetLineFor(content, target)
  const showNoHead = target.uncommitted && content.workLoaded && content.work === null
  const showNoChange =
    Boolean(source) && !changed && !source?.renamedFrom && !content.loadingDiff && !error

  return (
    <div
      ref={cardRef}
      className="fixed z-[60] flex flex-col gap-1.5 rounded-popup border border-line-soft bg-panel p-2.5 text-xs shadow-popup"
      style={{
        left: positioned ? pos.left : 0,
        top: positioned ? pos.top : 0,
        visibility: positioned ? 'visible' : 'hidden',
        width: CARD_WIDTH,
        maxWidth: 'calc(100vw - 16px)',
      }}
      onMouseEnter={cancelHide}
      onMouseLeave={hide}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-2xs font-medium text-fg/90">
          {isYou ? t('blame.you') : author}
        </span>
        {!isYou && email ? (
          <span className="min-w-0 truncate text-2xs text-muted/70">{email}</span>
        ) : null}
        {authorTime ? (
          <span
            className="shrink-0 text-2xs text-muted/70"
            title={absoluteTime(authorTime, currentLocale())}
          >
            {relativeTime(authorTime)}
          </span>
        ) : null}
        {!target.uncommitted ? (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            <code className="rounded bg-panel-alt px-1 py-[1px] font-mono text-2xs text-accent">
              {shortSha}
            </code>
            <CopyButton
              tip={t('commit.copyShaTip')}
              text={fullSha}
              label={t('commit.copyShaLabel')}
              iconOnly
              className="h-[18px] w-[18px]"
            />
          </span>
        ) : null}
      </div>

      {target.uncommitted ? (
        <div className="text-2xs font-medium text-fg/90">{t('blame.uncommitted')}</div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <div className="break-words text-2xs font-medium text-fg/90">
            {detail?.subject || target.summary}
          </div>
          {detail?.body ? (
            <div className="max-h-24 overflow-auto whitespace-pre-wrap text-2xs text-muted">
              {detail.body}
            </div>
          ) : null}
        </div>
      )}

      <div className="flex min-w-0 items-center gap-1.5 text-2xs">
        <span className="min-w-0 truncate font-mono text-muted/80">{target.rel}</span>
        {source ? (
          <span className="ml-auto shrink-0 font-mono text-muted">
            {t('commit.stats', {
              additions: String(source.additions),
              deletions: String(source.deletions),
            })}
          </span>
        ) : null}
      </div>
      {source?.renamedFrom ? (
        <div className="truncate text-2xs text-muted">
          {t('commit.renamedFrom', { path: source.renamedFrom })}
        </div>
      ) : null}

      {error ? <div className="text-danger">{error}</div> : null}

      {content.loadingDiff && !source ? (
        <div className="px-1 text-2xs text-muted">{t('commit.loadingLine')}</div>
      ) : null}

      {showNoHead ? (
        <div className="px-1 text-2xs text-muted">{t('commit.noHead')}</div>
      ) : null}

      {changed ? (
        <div className="rounded border border-line bg-bg px-1.5 py-1 font-mono text-2xs leading-[1.55]">
          <div className="whitespace-pre rounded-sm bg-accent/15 text-success">
            {`+${changed.text || ' '}`}
          </div>
        </div>
      ) : null}

      {showNoChange ? (
        <div className="px-1 text-2xs text-muted">{t('commit.noChangeOnLine')}</div>
      ) : null}
    </div>
  )
}
