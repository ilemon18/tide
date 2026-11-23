import { memo, useEffect, useState } from 'react'
import type { AgentMessage } from '../store/agent'
import { useT } from '../i18n'
import { elapsedSeconds, formatAgentDuration } from '../lib/agentDuration'
import { AgentSpinner } from './AgentSpinner'

type Props = {
  completion?: AgentMessage['completion']
  durationMs?: number
  completedAt?: number
  waiting: boolean
  running: boolean
  startedAt?: number
}

/** One clock per live turn; completed history never invents a missing duration.
 *
 * Keep the status input primitive. Assistant message objects are replaced for every streamed
 * markdown/tool update; accepting the whole message here would make the footer participate in
 * those renders and can make the live status line flash.
 */
export const AgentTurnStatus = memo(function AgentTurnStatus({
  completion,
  durationMs,
  completedAt: completedAtValue,
  waiting,
  running,
  startedAt,
}: Props) {
  const t = useT()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!running && !completion) return null
  const duration = running ? formatAgentDuration(startedAt ? elapsedSeconds(startedAt) : 0)
    : durationMs === undefined ? null : formatAgentDuration(durationMs / 1000)
  const completedAt = !running && completedAtValue !== undefined ? new Date(completedAtValue) : null
  const completionTime = completedAt && Number.isFinite(completedAt.getTime())
    ? `${String(completedAt.getHours()).padStart(2, '0')}:${String(completedAt.getMinutes()).padStart(2, '0')}`
    : null
  return <div role="status" className="flex min-h-5 items-center gap-1.5 text-2xs text-muted">
    {running ? <AgentSpinner /> : null}
    <span>{running ? t(waiting ? 'agent.permission.waiting' : 'agent.working')
      : t(`agent.completion.${completion!}`)}{duration ? ` · ${t('agent.completion.duration', { duration })}` : ''}{completionTime ? ` · ${completionTime}` : ''}</span>
  </div>
}, (previous, next) =>
  previous.completion === next.completion &&
  previous.durationMs === next.durationMs &&
  previous.completedAt === next.completedAt &&
  previous.waiting === next.waiting &&
  previous.running === next.running &&
  previous.startedAt === next.startedAt,
)
