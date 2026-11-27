// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { instances, nextInstance } = vi.hoisted(() => ({
  instances: new Map<string, number>(),
  nextInstance: { value: 0 },
}))

vi.mock('./AgentChat', async () => {
  const { useState } = await import('react')
  return {
    AgentChat: ({ chatId, visible }: { chatId: string; visible: boolean }) => {
      const [instance] = useState(() => {
        const next = ++nextInstance.value
        instances.set(chatId, next)
        return next
      })
      return <div
        data-testid={`chat-${chatId}`}
        data-instance={instance}
        data-visible={String(visible)}
      />
    },
  }
})

import { ChatPaneHost } from './ChatPaneHost'

beforeEach(() => {
  instances.clear()
  nextInstance.value = 0
})
afterEach(cleanup)

it('keeps a chat mounted when a file tab is active and restores it on return', () => {
  const openChatTabIds = ['chat:a', 'chat:b']
  const { rerender } = render(
    <ChatPaneHost activeTabId="chat:a" openChatTabIds={openChatTabIds} />,
  )
  const chat = screen.getByTestId('chat-a')
  expect(chat.getAttribute('data-visible')).toBe('true')
  expect(instances.get('a')).toBe(1)

  rerender(<ChatPaneHost activeTabId="file:src/main.ts" openChatTabIds={openChatTabIds} />)
  expect(screen.getByTestId('chat-a')).toBe(chat)
  expect(chat.getAttribute('data-visible')).toBe('false')
  expect(chat.style.display).toBe('none')

  rerender(<ChatPaneHost activeTabId="chat:a" openChatTabIds={openChatTabIds} />)
  expect(screen.getByTestId('chat-a')).toBe(chat)
  expect(chat.getAttribute('data-visible')).toBe('true')
  expect(chat.style.display).toBe('')
  expect(instances.get('a')).toBe(1)
})

it('retains the active chat and one previous chat, then evicts the oldest', () => {
  const openChatTabIds = ['chat:a', 'chat:b', 'chat:c']
  const { rerender } = render(
    <ChatPaneHost activeTabId="chat:a" openChatTabIds={openChatTabIds} />,
  )
  rerender(<ChatPaneHost activeTabId="chat:b" openChatTabIds={openChatTabIds} />)
  expect(screen.getByTestId('chat-a').getAttribute('data-visible')).toBe('false')
  expect(screen.getByTestId('chat-b').getAttribute('data-visible')).toBe('true')

  rerender(<ChatPaneHost activeTabId="chat:c" openChatTabIds={openChatTabIds} />)
  expect(screen.queryByTestId('chat-a')).toBeNull()
  expect(screen.getByTestId('chat-b').getAttribute('data-visible')).toBe('false')
  expect(screen.getByTestId('chat-c').getAttribute('data-visible')).toBe('true')
})

it('unmounts a retained chat as soon as its tab leaves the pane', () => {
  const { rerender } = render(
    <ChatPaneHost activeTabId="chat:a" openChatTabIds={['chat:a', 'chat:b']} />,
  )
  expect(screen.getByTestId('chat-a')).toBeTruthy()
  rerender(<ChatPaneHost activeTabId="file:src/main.ts" openChatTabIds={['chat:b']} />)
  expect(screen.queryByTestId('chat-a')).toBeNull()
})
