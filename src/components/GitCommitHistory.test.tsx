// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { COMMIT_MESSAGE_LIMITS as limits, commitMessageKey } from '../lib/commitMessages'

const { history, pick, close, settings } = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  const settings = create<{ commitMessageTemplates: string[]; patch: (value: { commitMessageTemplates: string[] }) => void }>((set) => ({
    commitMessageTemplates: [], patch: value => set(value),
  }))
  return { history: vi.fn(), pick: vi.fn(), close: vi.fn(), settings }
})
vi.mock('../store/settings', () => ({ useSettings: settings }))
vi.mock('../lib/ipc', () => ({ api: { gitCommitHistory: history }, errorText: (error: Error) => error.message }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { GitCommitHistory } from './GitCommitHistory'

beforeEach(() => {
  vi.clearAllMocks()
  settings.setState({ commitMessageTemplates: ['common', 'unused'] })
  history.mockResolvedValue({ messages: ['recent', 'recent', 'common'], usedTemplates: [commitMessageKey('common')], limit: limits.recent })
})
afterEach(cleanup)
const popup = () => <GitCommitHistory root="/repo" x={400} y={40} onPick={pick} onClose={close} />

it('keeps the popup stable, separates deduplicated recents and common messages, and fills the selected message', async () => {
  const { rerender } = render(popup())
  await screen.findByRole('button', { name: 'recent' })
  const recent = screen.getByRole('region', { name: 'git.recentCommitMessages' })
  const common = screen.getByRole('region', { name: 'git.commonCommitMessages' })
  expect(within(recent).getAllByRole('button')).toHaveLength(1)
  expect(within(recent).queryByRole('button', { name: 'common' })).toBeNull()
  expect(within(common).getByRole('button', { name: 'common' }).title).toBe('common')
  rerender(popup())
  fireEvent.mouseEnter(within(common).getByRole('button', { name: 'common' }))
  await act(async () => {})
  fireEvent.click(within(common).getByRole('button', { name: 'common' }))
  expect(pick).toHaveBeenCalledExactlyOnceWith('common')
  expect(history).toHaveBeenCalledExactlyOnceWith('/repo')
})

it('adds common messages to shared settings and prevents exceeding the configured limit', async () => {
  render(popup())
  await screen.findByRole('button', { name: 'recent' })
  fireEvent.click(screen.getByRole('button', { name: 'git.addCommitTemplate' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'git.commitTemplateMessage' }), { target: { value: 'new common' } })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  expect(settings.getState().commitMessageTemplates).toEqual(['common', 'unused', 'new common'])
  await act(async () => { settings.setState({ commitMessageTemplates: Array.from({ length: limits.templates }, (_, i) => `common ${i}`) }) })
  expect((screen.getByRole('button', { name: 'git.addCommitTemplate' }) as HTMLButtonElement).disabled).toBe(true)
  expect(history).toHaveBeenCalledTimes(1)
})

it('filters both sections and releases the popup through dismissal', async () => {
  render(popup())
  await screen.findByRole('button', { name: 'recent' })
  fireEvent.change(screen.getByRole('textbox', { name: 'git.searchCommitHistory' }), { target: { value: 'unused' } })
  expect(screen.queryByRole('button', { name: 'recent' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'unused' }))
  expect(pick).toHaveBeenCalledWith('unused')
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
  expect(close).toHaveBeenCalledWith(true)
})
