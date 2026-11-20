import { useAgent } from '../store/agent'
import { useT } from '../i18n'
import { Icon } from './Icon'

/** Derive the current result, never a successful tool or a completion from an older page. */
export function AgentTabStatus({ chatId }: { chatId: string }) {
  const t = useT()
  const status = useAgent(state => {
    const chat = state.chats[chatId]
    if (!chat) return null
    if (chat.status === 'running') return 'running'
    if (chat.status === 'error') return 'failed'
    if (chat.status === 'cancelled') return 'stopped'
    if (state.pages[chatId]?.hasLater) return null
    const last = chat.messages[chat.messages.length - 1]
    return last?.role === 'assistant' ? last.completion ?? null : null
  })
  if (!status) return null
  const label = t(status === 'running' ? 'agent.working' : `agent.completion.${status}`)
  return <span role="img" aria-label={label} title={label} className="flex shrink-0 items-center">
    <Icon size={12}
      name={status === 'running' ? 'spinner' : status === 'completed' ? 'check' : status === 'failed' ? 'alert-circle' : 'stop'}
      className={status === 'running' ? 'agent-spinner text-accent' : status === 'completed' ? 'text-success' : status === 'failed' ? 'text-danger' : 'text-muted'} />
  </span>
}
