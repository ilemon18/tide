// @vitest-environment jsdom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommitDetail } from '../lib/ipc'
const { gitCommitDetail } = vi.hoisted(() => ({ gitCommitDetail: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { gitCommitDetail }, errorText: (error: Error) => error.message }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))
import { clearCommitDetails, loadCommitDetail, useCommitHover, type CommitHoverTarget } from '../store/commitHover'
import { CommitHoverCard } from './CommitHoverCard'

const target: CommitHoverTarget = {
  root: '/repo', rel: 'a.ts', sha: 'abc1234', line: 2, origLine: 4,
  author: 'Author', authorTime: 0, summary: 'Change', lineStart: 2, lineCount: 1,
  rect: { left: 20, top: 200, right: 80, bottom: 220 },
}
const detail: CommitDetail = {
  sha: target.sha, shortSha: target.sha, author: 'Author', email: '', authorTime: 0,
  commitTime: 0, subject: 'Change', body: '', files: [], additions: 1, deletions: 0,
  fileDiff: '+const value = 1', merge: false,
}
function deferred() {
  let resolve!: (value: CommitDetail) => void
  const promise = new Promise<CommitDetail>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  clearCommitDetails()
  gitCommitDetail.mockReset().mockResolvedValue(detail)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
})
afterEach(() => {
  cleanup()
  clearCommitDetails()
  vi.restoreAllMocks()
})

it('renders no partial card while cold and measures completed content before showing it', async () => {
  const pending = deferred()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  const measurements: string[] = []
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    measurements.push(this.style.visibility)
    return 80
  })
  const { container } = render(<StrictMode><CommitHoverCard /></StrictMode>)
  act(() => useCommitHover.getState().show(target))
  expect(container.childElementCount).toBe(0)
  expect(screen.queryByText('commit.loadingLine')).toBeNull()
  await act(async () => { pending.resolve(detail) })
  const card = container.firstElementChild as HTMLElement
  expect(screen.getByText(detail.fileDiff)).toBeTruthy()
  expect(measurements.length).toBeGreaterThan(0)
  expect(measurements.every((visibility) => visibility === 'hidden')).toBe(true)
  expect(card.style.visibility).toBe('visible')
  expect(card.style.top).toBe('112px')
  expect(card.style.left).toBe('20px')
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
})

it('shows cached content synchronously and flips below the anchor using its real height', async () => {
  await loadCommitDetail(target)
  const { container } = render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show({
    ...target, rect: { left: 20, top: 20, right: 80, bottom: 40 },
  }))
  expect(screen.getByText(detail.fileDiff)).toBeTruthy()
  const card = container.firstElementChild as HTMLElement
  expect(card.style.top).toBe('48px')
  expect(card.style.visibility).toBe('visible')
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
})

it('removes the previous line immediately while waiting for a different line', async () => {
  await loadCommitDetail(target)
  render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show(target))
  const pending = deferred()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  act(() => useCommitHover.getState().show({ ...target, line: 3, origLine: 5 }))
  expect(screen.queryByText(detail.fileDiff)).toBeNull()
  expect(screen.queryByText('Author')).toBeNull()
  await act(async () => { pending.resolve({ ...detail, fileDiff: '+next line' }) })
  expect(screen.getByText('+next line')).toBeTruthy()
  expect(screen.queryByText(detail.fileDiff)).toBeNull()
})

it.each(['escape', 'scroll'])('cancels a pending hover on %s and ignores its late answer', async (event) => {
  const pending = deferred()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  const { container } = render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show(target))
  if (event === 'escape') fireEvent.keyDown(window, { key: 'Escape' })
  else fireEvent.scroll(document)
  await act(async () => { pending.resolve(detail) })
  expect(useCommitHover.getState().target).toBeNull()
  expect(container.childElementCount).toBe(0)
})

it('keeps a newly mounted card open for internal scrolling, then closes on leave', async () => {
  const pending = deferred()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  const { container } = render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show(target))
  await act(async () => { pending.resolve(detail) })
  fireEvent.scroll(screen.getByText(detail.fileDiff))
  expect(screen.getByText(detail.fileDiff)).toBeTruthy()
  fireEvent.mouseLeave(container.firstElementChild as HTMLElement)
  expect(container.childElementCount).toBe(0)
})

it('shows the empty-change message for an empty result and an error when reading fails', async () => {
  gitCommitDetail.mockResolvedValueOnce({ ...detail, fileDiff: '' })
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  expect(screen.getByText('commit.noChangeOnLine')).toBeTruthy()
  gitCommitDetail.mockRejectedValueOnce(new Error('unreadable'))
  await act(async () => useCommitHover.getState().show({ ...target, line: 3 }))
  expect(screen.getByText('unreadable')).toBeTruthy()
  expect(screen.queryByText('commit.noChangeOnLine')).toBeNull()
  expect(screen.queryByText('commit.loadingLine')).toBeNull()
})
