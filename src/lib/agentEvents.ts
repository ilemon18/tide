import { listen } from '@tauri-apps/api/event'
import type { AgentEventPayload } from './ipc'
import { useAgent } from '../store/agent'

/** Keep adjacent deltas in source order; structural events always flush before delivery. */
export function createAgentEventBuffer(deliver: (event: AgentEventPayload) => void) {
  const pending = new Map<string, AgentEventPayload>()
  const seen = new Map<string, { sequence: number; finished: boolean }>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    if (timer) clearTimeout(timer)
    timer = undefined
    const events = [...pending.values()]
    pending.clear()
    for (const event of events) deliver(event)
  }
  return {
    push(payload: AgentEventPayload) {
      const event = payload.event
      const key = `${payload.chatId}\0${payload.runId}`
      const watermark = seen.get(key)
      if (watermark && (watermark.finished || payload.sequence <= watermark.sequence)) return
      seen.set(key, { sequence: payload.sequence, finished: event.kind === 'done' })
      // Keep recent runs bounded; the store still rejects events for an evicted/stale run ID.
      if (seen.size > 256) seen.delete(seen.keys().next().value!)
      if (event.kind !== 'textDelta' && event.kind !== 'thinking' && event.kind !== 'toolOutputDelta') {
        flush()
        deliver(payload)
        return
      }
      const previous = pending.get(payload.chatId)
      if (previous && previous.runId === payload.runId && payload.sequence <= previous.sequence) return
      if (previous && (previous.runId !== payload.runId || previous.event.kind !== event.kind ||
        !('itemId' in previous.event) || previous.event.itemId !== event.itemId)) flush()
      const before = pending.get(payload.chatId)
      pending.set(payload.chatId, before && 'text' in before.event ? {
        ...payload, event: { ...event, text: before.event.text + event.text },
      } : payload)
      if (!timer) timer = setTimeout(flush, 100)
    },
    flush,
  }
}

let installed = false

/** One listener for the whole window: every running chat is filtered by its id in the store */
export function installAgentEvents() {
  if (installed) return
  installed = true
  const buffer = createAgentEventBuffer(payload => useAgent.getState().applyEvent(payload))
  window.addEventListener('pagehide', buffer.flush)
  void listen<AgentEventPayload>('agent:event', (event) => {
    buffer.push(event.payload)
  }).catch(() => {
    /* A listener failure must not break the rest of the window */
  })
}
