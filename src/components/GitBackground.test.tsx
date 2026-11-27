// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { git, listen, unlisten } = vi.hoisted(() => ({
  git: {
    preferences: { backgroundFetch: false },
    projectPreferences: {} as Record<string, { backgroundFetch: boolean }>,
    loadProjectPreferences: vi.fn(),
    loadPreferences: vi.fn(),
    loadIdentity: vi.fn(),
    fetch: vi.fn(),
    busy: null as string | null,
    isIndexPending: vi.fn(),
  },
  listen: vi.fn(),
  unlisten: vi.fn(),
}))
vi.mock('../store/git', () => ({
  useGit: Object.assign((select: (state: unknown) => unknown) => select(git), {
    getState: () => git,
  }),
}))
vi.mock('../store/workspace', () => {
  const state = { roots: [{ id: '/repo', isGitRepo: true }, { id: '/other', isGitRepo: false }] }
  return { useWorkspace: Object.assign((select: (value: unknown) => unknown) => select(state), { getState: () => state }) }
})
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('../lib/memoryBudget', () => ({ budget: { gitFetchInterval: () => 300000 } }))
import { GitBackground } from './GitBackground'
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  git.preferences.backgroundFetch = false
  git.projectPreferences = {}
  git.busy = null
  git.isIndexPending.mockReturnValue(false)
  listen.mockResolvedValue(unlisten)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
it('creates no periodic timer or remote fetch when disabled', async () => {
  render(<GitBackground />)
  await act(async () => {})
  expect(git.loadPreferences).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3600000)
  })
  expect(git.fetch).not.toHaveBeenCalled()
})
it('fetches only eligible roots serially and releases the timer/listener', async () => {
  git.preferences.backgroundFetch = true
  const { unmount } = render(<GitBackground />)
  await act(async () => {})
  expect(git.fetch).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300000)
  })
  expect(git.fetch).toHaveBeenCalledExactlyOnceWith('/repo', true)
  unmount()
  expect(vi.getTimerCount()).toBe(0)
  expect(unlisten).toHaveBeenCalledOnce()
})
it('skips background fetch when an exclusive Git operation is running', async () => {
  git.preferences.backgroundFetch = true
  git.busy = 'commit'
  render(<GitBackground />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300000)
  })
  expect(git.fetch).not.toHaveBeenCalled()
})
