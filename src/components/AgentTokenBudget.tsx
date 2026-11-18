import { useEffect, useId, useRef, useState } from 'react'
import { useAgent } from '../store/agent'
import { useT } from '../i18n'
import { Icon } from './Icon'

type Props = {
  chatId: string
}

export function AgentTokenBudget({ chatId }: Props) {
  const t = useT()
  const draft = useAgent(s => s.chatDrafts[chatId])
  const root = useAgent(s => s.chats[chatId]?.root)
  const estimate = useAgent(s => s.tokenEstimates[chatId])
  const [showDetails, setShowDetails] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()

  useEffect(() => {
    if (!root) return
    const timer = setTimeout(() => void useAgent.getState().updateTokenEstimate(chatId), 300)
    return () => clearTimeout(timer)
  }, [chatId, root, draft])

  useEffect(() => {
    if (!showDetails) return
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setShowDetails(false)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setShowDetails(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [showDetails])

  if (!estimate) return null

  const { total, breakdown } = estimate
  const isLarge = total > 100_000
  const isHuge = total > 150_000

  const statusClass = isHuge ? 'danger' : isLarge ? 'warning' : total > 0 ? 'ok' : 'empty'
  const summary = t('agent.context.estimate', { count: formatTokens(total) })

  return (
    <div ref={containerRef} className="token-budget">
      <button
        ref={buttonRef}
        type="button"
        className={`token-summary ${statusClass}`}
        onClick={() => setShowDetails(open => !open)}
        title={summary}
        aria-label={summary + ' · ' + t('agent.context.tokenDetails')}
        aria-expanded={showDetails}
        aria-controls={showDetails ? detailsId : undefined}
      >
        {/* No provider context limit is available: color conveys size, not a percentage. */}
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7" stroke="currentColor" strokeWidth="2.5" />
          {isLarge && <circle cx="10" cy="10" r={isHuge ? 3 : 1.5} fill="currentColor" />}
        </svg>
      </button>

      {showDetails && (
        <div id={detailsId} className="token-details">
          <div className="details-header">
            <span>{t('agent.context.tokenBreakdown')}</span>
            <button
              type="button"
              aria-label={t('tabs.close')}
              className="close-btn"
              onClick={() => {
                setShowDetails(false)
                buttonRef.current?.focus()
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
          <div className="token-total">{summary}</div>
          <div className="breakdown-list">
            {breakdown.map((item, index) => (
              <div key={index} className="breakdown-item">
                <span className="label">
                  {item.kind === 'prompt' ? t('agent.context.prompt') : item.label}
                </span>
                <span className="tokens">{formatTokens(item.tokens)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function formatTokens(count: number): string {
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}k`
  }
  return count.toString()
}
