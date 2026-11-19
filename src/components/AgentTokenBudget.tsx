import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useAgent } from '../store/agent'
import { useT } from '../i18n'
import type { AgentUsage } from '../lib/ipc'
import {
  cumulativeAgentUsage,
  formatAgentTokens,
  formatAgentUsd,
  latestAgentUsage,
} from '../lib/agentUsage'
import { Icon } from './Icon'

type Props = {
  chatId: string
}

export function AgentTokenBudget({ chatId }: Props) {
  const t = useT()
  const draft = useAgent(s => s.chatDrafts[chatId])
  const root = useAgent(s => s.chats[chatId]?.root)
  const estimate = useAgent(s => s.tokenEstimates[chatId])
  const messages = useAgent(s => s.chats[chatId]?.messages)
  const [showDetails, setShowDetails] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const detailsId = useId()
  const cumulative = useMemo(() => (messages ? cumulativeAgentUsage(messages) : undefined), [messages])
  const latest = useMemo(() => (messages ? latestAgentUsage(messages) : undefined), [messages])

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

  if (!estimate && !cumulative) return null

  const total = estimate?.total ?? 0
  const isLarge = total > 100_000
  const isHuge = total > 150_000

  const statusClass = isHuge ? 'danger' : isLarge ? 'warning' : total > 0 ? 'ok' : 'empty'
  const summary = cumulative
    ? t('agent.usage.summary', {
        tokens: formatAgentTokens(cumulative.totalTokens),
        cost: usageCost(cumulative, t('agent.usage.costUnavailable')),
      })
    : t('agent.context.estimate', { count: formatAgentTokens(total) })

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
        {cumulative ? <span className="token-summary-text">{summary}</span> : null}
      </button>

      {showDetails && (
        <div id={detailsId} className="token-details">
          <div className="details-header">
            <span>{cumulative ? t('agent.usage.title') : t('agent.context.tokenBreakdown')}</span>
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
          {cumulative ? <UsageSection title={t('agent.usage.cumulative')} usage={cumulative} /> : null}
          {latest ? <UsageSection title={t('agent.usage.latest')} usage={latest} /> : null}
          {estimate ? (
            <div className="token-estimate-section">
              <div className="usage-section-title">{t('agent.context.tokenBreakdown')}</div>
              <div className="token-total">
                {t('agent.context.estimate', { count: formatAgentTokens(estimate.total) })}
              </div>
              <div className="breakdown-list">
                {estimate.breakdown.map((item, index) => (
                  <div key={index} className="breakdown-item">
                    <span className="label">
                      {item.kind === 'prompt' ? t('agent.context.prompt') : item.label}
                    </span>
                    <span className="tokens">{formatAgentTokens(item.tokens)}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

function usageCost(usage: AgentUsage, unavailable: string): string {
  return formatAgentUsd(usage.costUsd) ?? unavailable
}

function UsageSection({ title, usage }: { title: string; usage: AgentUsage }) {
  const t = useT()
  const rows: Array<[string, string]> = [
    [t('agent.usage.input'), formatAgentTokens(usage.inputTokens)],
    [t('agent.usage.cachedInput'), formatAgentTokens(usage.cachedInputTokens)],
    [t('agent.usage.cacheWrite'), formatAgentTokens(usage.cacheWriteInputTokens)],
    [t('agent.usage.output'), formatAgentTokens(usage.outputTokens)],
    [t('agent.usage.reasoning'), formatAgentTokens(usage.reasoningOutputTokens)],
    [t('agent.usage.total'), formatAgentTokens(usage.totalTokens)],
    [t('agent.usage.cost'), usageCost(usage, t('agent.usage.costUnavailable'))],
  ]
  return (
    <div className="usage-section">
      <div className="usage-section-title">{title}</div>
      <div className="breakdown-list">
        {rows.map(([label, value]) => (
          <div key={label} className="breakdown-item">
            <span className="label">{label}</span>
            <span className="tokens">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
