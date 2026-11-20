import { useEffect, useState } from 'react'
import type { AgentMessage } from '../store/agent'
import { useT } from '../i18n'
import { elapsedSeconds, formatAgentDuration } from '../lib/agentDuration'
import { Icon } from './Icon'

/** One clock per live turn; completed history never invents a missing duration. */
export function AgentTurnStatus({ message, running, startedAt }: {
  message: AgentMessage; running: boolean; startedAt?: number
}) {
  const t = useT()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => tick(value => value + 1), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!running && !message.completion) return null
  const waiting = message.items?.some(item => item.type === 'permission' &&
    (item.permissionState === 'pending' || item.permissionState === 'submitting'))
  const duration = running ? formatAgentDuration(startedAt ? elapsedSeconds(startedAt) : 0)
    : message.durationMs === undefined ? null : formatAgentDuration(message.durationMs / 1000)
  return <div role="status" className="flex min-h-5 items-center gap-1.5 text-2xs text-muted">
    {running ? <Icon name="spinner" size={11} className="animate-spin" /> : null}
    <span>{running ? t(waiting ? 'agent.permission.waiting' : 'agent.working')
      : t(`agent.completion.${message.completion!}`)}{duration ? ` · ${t('agent.completion.duration', { duration })}` : ''}</span>
  </div>
}
