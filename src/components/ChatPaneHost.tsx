import { Activity, useEffect, useState } from 'react'
import { AgentChat } from './AgentChat'

/** Keep the active chat plus one previously used chat hot in this pane. */
const MAX_RETAINED_CHATS = 2

/**
 * Keeps recently used chat panes mounted across tab switches. Activity preserves their DOM and
 * component state while hidden, so returning to a long transcript only shows it again instead of
 * rebuilding every message and tool card.
 */
export function ChatPaneHost({
  activeTabId,
  openChatTabIds,
}: {
  activeTabId: string | null
  /** Chat tabs in this pane, in tab order. Everything else is unmounted. */
  openChatTabIds: string[]
}) {
  const [recentChatTabIds, setRecentChatTabIds] = useState<string[]>([])
  const visibleChatTabId = activeTabId && openChatTabIds.includes(activeTabId) ? activeTabId : null

  useEffect(() => {
    if (!visibleChatTabId) return
    setRecentChatTabIds((previous) => {
      const next = [visibleChatTabId, ...previous.filter(id => id !== visibleChatTabId)]
        .filter(id => openChatTabIds.includes(id))
        .slice(0, MAX_RETAINED_CHATS)
      return next.length === previous.length && next.every((id, index) => id === previous[index])
        ? previous
        : next
    })
  }, [visibleChatTabId, openChatTabIds])

  const shown = [visibleChatTabId, ...recentChatTabIds]
    .filter((id): id is string => id !== null && openChatTabIds.includes(id))
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, MAX_RETAINED_CHATS)

  return <>
    {shown.map((tabId) => (
      <Activity
        key={tabId}
        mode={tabId === visibleChatTabId ? 'visible' : 'hidden'}
        name={`agent-chat:${tabId.slice('chat:'.length)}`}
      >
        <AgentChat chatId={tabId.slice('chat:'.length)} visible={tabId === visibleChatTabId} />
      </Activity>
    ))}
  </>
}
