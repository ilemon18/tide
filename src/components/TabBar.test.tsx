// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab, TabGroup } from '../store/tabs'
import type { AgentChat } from '../store/agent'

vi.mock('../store/tabs', async () => {
  const { create } = await import('zustand')
  return {
    useTabs: create(() => ({
      tabs: [] as Tab[], groups: [] as TabGroup[], activeGroupId: 'primary', splitOrientation: null,
      closeIn: vi.fn(), setActiveGroup: vi.fn(),
    })),
    groupTabs: (tabs: Tab[], group?: TabGroup) =>
      (group?.order ?? []).flatMap((id) => tabs.filter((tab) => tab.id === id)),
  }
})
vi.mock('../store/agent', async () => {
  const { create } = await import('zustand')
  return { useAgent: create(() => ({ chats: {} as Record<string, AgentChat>, pages: {} })) }
})
vi.mock('../i18n', () => ({ t: (key: string) => key, useT: () => (key: string) => key }))
vi.mock('./EditorContextActions', () => ({ EditorContextActions: () => null }))
vi.mock('./AgentProviderIcon', () => ({ AgentProviderIcon: () => <span data-provider-icon /> }))
vi.mock('./FileIcon', () => ({ FileIcon: () => <span data-file-icon /> }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))
vi.mock('../lib/groupDrop', () => ({ groupUnderPointer: vi.fn(), highlightPane: vi.fn(), insertionIndex: vi.fn() }))

import { useTabs } from '../store/tabs'
import { useAgent } from '../store/agent'
import { TabBar } from './TabBar'

const tab = (id: string, kind: Tab['kind'] = 'chat', pinned = false): Tab => ({
  id, kind, pinned, root: '/repo', rel: kind === 'file' ? 'example.ts' : '', name: 'Example',
  dirty: false, readOnly: false, temporary: false, tier: 'full', mtime: 0,
})
const chat = (status: AgentChat['status']): AgentChat => ({
  v: 1, id: 'one', root: '/repo', title: 'Example', provider: 'codex', model: '', effort: '',
  status, sessionId: null, error: null, createdAt: 0, updatedAt: 0, messages: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  useTabs.setState({
    tabs: [tab('chat:one'), tab('example', 'file'), tab('chat:pinned', 'chat', true)],
    groups: [{ id: 'primary', activeId: 'chat:one', order: ['chat:one', 'example', 'chat:pinned'] }],
    activeGroupId: 'primary', splitOrientation: null,
  })
  useAgent.setState({ chats: { one: chat('running'), pinned: { ...chat('running'), id: 'pinned' } }, pages: {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it('shows saved conversation titles and retains provider icons and execution status', () => {
  const { container } = render(<TabBar groupId="primary" />)
  const item = container.querySelector<HTMLElement>('[data-tab-id="chat:one"]')!
  expect(within(item).getByText('Example')).toBeTruthy()
  expect(item.title).toBe('Example')
  expect(item.querySelector('[data-provider-icon]')).toBeTruthy()
  expect(within(item).getByRole('img', { name: 'agent.working' })).toBeTruthy()
  expect(within(item).queryByText('agent.tabLabel')).toBeNull()
})

it('falls back to new chat and updates its label and tooltip when the title changes or resets', () => {
  useTabs.setState({ tabs: useTabs.getState().tabs.map((item) =>
    item.id === 'chat:one' ? { ...item, name: '' } : item) })
  const { container } = render(<TabBar groupId="primary" />)
  const item = container.querySelector<HTMLElement>('[data-tab-id="chat:one"]')!
  expect(within(item).getByText('agent.newChat')).toBeTruthy()
  expect(item.title).toBe('agent.newChat')

  act(() => useTabs.setState({ tabs: useTabs.getState().tabs.map((current) =>
    current.id === 'chat:one' ? { ...current, name: 'Fix login failure' } : current) }))
  expect(within(item).getByText('Fix login failure')).toBeTruthy()
  expect(within(item).queryByText('agent.newChat')).toBeNull()
  expect(item.title).toBe('Fix login failure')

  act(() => useTabs.setState({ tabs: useTabs.getState().tabs.map((current) =>
    current.id === 'chat:one' ? { ...current, name: '' } : current) }))
  expect(within(item).getByText('agent.newChat')).toBeTruthy()
  expect(item.title).toBe('agent.newChat')
})

it.each(['idle', 'error', 'cancelled'] as const)('restores closing when a running agent becomes %s', (status) => {
  const { container } = render(<TabBar groupId="primary" />)
  const item = container.querySelector<HTMLElement>('[data-tab-id="chat:one"]')!
  expect(within(item).queryByRole('button', { name: 'tabs.closeTip' })).toBeNull()
  expect(within(item).getByRole('img', { name: 'agent.working' })).toBeTruthy()
  fireEvent.mouseEnter(item)
  fireEvent.focus(item)
  expect(within(item).queryByRole('button')).toBeNull()

  // A live store update must reach the memoized tab without rerendering its parent.
  act(() => useAgent.setState({ chats: { ...useAgent.getState().chats, one: chat(status) } }))
  expect(within(item).getByText('Example')).toBeTruthy()
  expect(item.title).toBe('Example')
  fireEvent.click(within(item).getByRole('button', { name: 'tabs.closeTip' }))
  expect(useTabs.getState().closeIn).toHaveBeenCalledWith('chat:one', 'primary')
  act(() => useAgent.setState({ chats: { ...useAgent.getState().chats, one: chat('running') } }))
  expect(within(item).queryByRole('button')).toBeNull()
})

it('keeps ordinary files closable and pinned agents pinned', () => {
  const { container } = render(<TabBar groupId="primary" />)
  const file = container.querySelector<HTMLElement>('[data-tab-id="example"]')!
  fireEvent.click(within(file).getByRole('button', { name: 'tabs.closeTip' }))
  expect(useTabs.getState().closeIn).toHaveBeenCalledWith('example', 'primary')
  const pinned = container.querySelector<HTMLElement>('[data-tab-id="chat:pinned"]')!
  expect(within(pinned).queryByRole('button')).toBeNull()
  expect(pinned.querySelector('[data-tip="tabs.pinnedTip"]')).toBeTruthy()
  act(() => useAgent.setState({ chats: { ...useAgent.getState().chats, pinned: { ...chat('idle'), id: 'pinned' } } }))
  expect(within(pinned).queryByRole('button')).toBeNull()
})

it('keeps inactive running agents protected and missing sessions closable until hydrated', () => {
  useTabs.setState({ groups: [{ id: 'primary', activeId: 'example', order: ['chat:one', 'example'] }] })
  useAgent.setState({ chats: {} })
  const { container } = render(<TabBar groupId="primary" />)
  const item = container.querySelector<HTMLElement>('[data-tab-id="chat:one"]')!
  expect(within(item).getByRole('button', { name: 'tabs.closeTip' })).toBeTruthy()
  act(() => useAgent.setState({ chats: { one: chat('running') } }))
  expect(within(item).queryByRole('button')).toBeNull()
  expect(screen.getByRole('img', { name: 'agent.working' })).toBeTruthy()
})
