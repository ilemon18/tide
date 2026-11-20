import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('../store/agent', () => ({ useAgent: {} }))
import { createAgentEventBuffer } from './agentEvents'
import type { AgentEventPayload } from './ipc'
afterEach(() => vi.useRealTimers())
const delta = (sequence: number, text: string, kind: 'textDelta' | 'thinking' = 'textDelta'): AgentEventPayload => ({
  chatId: 'chat', runId: 'run', sequence, event: { kind, itemId: kind, text },
})
it('coalesces adjacent text for 100ms, ignores duplicate sequence and flushes before structural events', () => {
  vi.useFakeTimers()
  const deliver = vi.fn()
  const buffer = createAgentEventBuffer(deliver)
  buffer.push(delta(1, 'a')); buffer.push(delta(2, 'b')); buffer.push(delta(2, 'duplicate'))
  vi.advanceTimersByTime(99)
  expect(deliver).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(deliver).toHaveBeenLastCalledWith(delta(2, 'ab'))
  buffer.push(delta(3, 'c'))
  buffer.push({ chatId: 'chat', runId: 'run', sequence: 4, event: { kind: 'done', ok: true, cancelled: false, code: 0 } })
  expect(deliver.mock.calls.map(call => call[0].event.kind)).toEqual(['textDelta', 'textDelta', 'done'])
  expect(deliver.mock.calls[1][0].event.text).toBe('c')
})
it('flushes thinking before text to preserve item order and final Markdown bytes', () => {
  vi.useFakeTimers()
  const deliver = vi.fn()
  const buffer = createAgentEventBuffer(deliver)
  buffer.push(delta(1, 'inspect', 'thinking'))
  buffer.push(delta(2, '```ts\n'))
  buffer.push(delta(3, 'const a = 1\n```'))
  buffer.flush()
  expect(deliver.mock.calls.map(call => call[0].event.text)).toEqual(['inspect', '```ts\nconst a = 1\n```'])
})
