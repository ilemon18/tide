import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { relativeTime } from '../lib/format'
import { useCommitHover, type CommitHoverTarget } from '../store/commitHover'
import { CopyButton } from './CopyButton'
import { t } from '../i18n'

const CARD_WIDTH = 360
const MARGIN = 8
/** Show only what this commit did to the cursor's line, not the whole hunk */
const MAX_DIFF_LINES = 1

/** File headers / mode lines say nothing about what changed on this line; keep only the hunk itself */
const DIFF_META = /^(diff --git |index |--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to) |Binary files)/

function diffClass(line: string): string {
  if (line.startsWith('@@')) return 'text-accent'
  if (line.startsWith('+')) return 'text-success'
  if (line.startsWith('-')) return 'text-danger'
  return 'text-muted'
}

/** Inline blame hover card: shows just the diff of the cursor's line in this commit */
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
  const authorTime = target.authorTime
  const allDiffLines = (detail?.fileDiff ?? '')
    .split('\n')
    .filter((line) => line.length > 0 && !DIFF_META.test(line))
  const diffLines = allDiffLines.slice(0, MAX_DIFF_LINES)
  const truncated = allDiffLines.length > MAX_DIFF_LINES

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
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-2xs text-fg/90">{author}</span>
        {authorTime ? (
          <span className="shrink-0 text-2xs text-muted/70">{relativeTime(authorTime)}</span>
        ) : null}
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
      </div>

      {error ? <div className="text-danger">{error}</div> : null}

      {detail ? (
        diffLines.length > 0 ? (
          <div className="overflow-hidden rounded border border-line bg-bg px-1.5 py-1 font-mono text-2xs leading-[1.55]">
            <div className="min-w-max">
              {diffLines.map((item, index) => (
                <div key={index} className={`whitespace-pre ${diffClass(item)}`}>
                  {item || ' '}
                </div>
              ))}
              {truncated ? <div className="whitespace-pre text-muted">…</div> : null}
            </div>
          </div>
        ) : (
          <div className="px-1 text-2xs text-muted">{t('commit.noChangeOnLine')}</div>
        )
      ) : null}
    </div>
  )
}
