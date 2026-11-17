import { listen } from '@tauri-apps/api/event'
import type { AgentEventPayload } from './ipc'
import { useAgent } from '../store/agent'

let installed = false

/** One listener for the whole window: every running chat is filtered by its id in the store */
export function installAgentEvents() {
  if (installed) return
  installed = true
  void listen<AgentEventPayload>('agent:event', (event) => {
    useAgent.getState().applyEvent(event.payload)
  }).catch(() => {
    /* A listener failure must not break the rest of the window */
  })
}
