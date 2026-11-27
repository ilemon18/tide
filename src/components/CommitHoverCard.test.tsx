// @vitest-environment jsdom
import React, { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommitDetail, CommitFileDiff } from '../lib/ipc'
const { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff } = vi.hoisted(() => ({
  gitCommitDetail: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitWorkingTreeDiff: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  api: { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff },
  errorText: (error: Error) => error.message,
}))
vi.mock('../i18n', () => ({ t: (key: string) => key, currentLocale: () => 'en' }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button>{text}</button> }))
import {
  clearCommitDetails,
  loadCommitDetail,
  useCommitHover,
  type CommitHoverTarget,
} from '../store/commitHover'
import { CommitHoverCard } from './CommitHoverCard'

const target: CommitHoverTarget = {
  root: '/repo',
  rel: 'a.ts',
  path: 'old/a.ts',
  sha: 'abc1234',
  line: 2,
  origLine: 4,
  author: 'Author',
  authorEmail: 'author@example.com',
  authorTime: 0,
  summary: 'Change',
  currentUserEmail: 'me@example.com',
  lineStart: 2,
  lineCount: 1,
  uncommitted: false,
  rect: { left: 20, top: 200, right: 80, bottom: 220 },
}

const detail: CommitDetail = {
  sha: target.sha,
  shortSha: target.sha,
  author: 'Author',
  email: 'author@example.com',
  authorTime: 0,
  commitTime: 0,
  subject: 'Change',
  body: 'A longer explanation of the change.',
  files: [],
  additions: 1,
  deletions: 1,
  merge: false,
}

const diff: CommitFileDiff = {
  path: 'old/a.ts',
  renamedFrom: null,
  additions: 1,
  deletions: 1,
  hunks: [
    {
      oldStart: 4,
      oldCount: 1,
      newStart: 4,
      newCount: 1,
      header: '@@ -4 +4 @@',
      lines: [
        { kind: 'del', oldLine: 4, newLine: null, text: 'const value = 0' },
        { kind: 'add', oldLine: null, newLine: 4, text: 'const value = 1' },
      ],
    },
  ],
  truncated: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  clearCommitDetails()
  gitCommitDetail.mockReset().mockResolvedValue(detail)
  gitCommitFileDiff.mockReset().mockResolvedValue(diff)
  gitWorkingTreeDiff.mockReset().mockResolvedValue(diff)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(80)
})
afterEach(() => {
  cleanup()
  clearCommitDetails()
  vi.restoreAllMocks()
})

it('renders no partial card while cold, then subject, body, stats and the exact hunk', async () => {
  const pending = deferred<CommitDetail>()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  const { container } = render(<StrictMode><CommitHoverCard /></StrictMode>)
  act(() => useCommitHover.getState().show(target))
  expect(container.childElementCount).toBe(0)
  await act(async () => {
    pending.resolve(detail)
  })
  expect(screen.getByText('Change')).toBeTruthy()
  expect(screen.getByText('A longer explanation of the change.')).toBeTruthy()
  expect(screen.getByText('commit.stats')).toBeTruthy()
  expect(screen.getByText('a.ts')).toBeTruthy()
  expect(screen.getByText('@@ -4 +4 @@')).toBeTruthy()
  const added = screen.getByText('+const value = 1')
  expect(added.className).toContain('bg-accent/15')
  const deleted = screen.getByText('-const value = 0')
  expect(deleted.className).not.toContain('bg-accent/15')
})

it('positions the measured card above the blame text and stays hidden until measured', async () => {
  await loadCommitDetail(target.root, target.sha)
  const { container } = render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show({
    ...target,
    rect: { left: 20, top: 200, right: 80, bottom: 220 },
  }))
  const card = container.firstElementChild as HTMLElement
  expect(card.style.top).toBe('112px')
  expect(card.style.left).toBe('20px')
  expect(card.style.visibility).toBe('visible')
})

it('shows the loading row while the file diff is still being read', async () => {
  const pending = deferred<CommitFileDiff>()
  await loadCommitDetail(target.root, target.sha)
  gitCommitFileDiff.mockReturnValueOnce(pending.promise)
  render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show(target))
  expect(screen.getByText('commit.loadingLine')).toBeTruthy()
  await act(async () => {
    pending.resolve(diff)
  })
  expect(screen.queryByText('commit.loadingLine')).toBeNull()
  expect(screen.getByText('+const value = 1')).toBeTruthy()
})

it('shows no-change when no hunk contains the target line', async () => {
  gitCommitFileDiff.mockResolvedValueOnce({ ...diff, hunks: [] })
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  expect(screen.getByText('commit.noChangeOnLine')).toBeTruthy()
})

it('shows rename information for a rename-only commit', async () => {
  gitCommitFileDiff.mockResolvedValueOnce({
    ...diff,
    renamedFrom: 'old/name.ts',
    hunks: [],
    additions: 0,
    deletions: 0,
  })
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  expect(screen.getByText('commit.renamedFrom')).toBeTruthy()
  expect(screen.queryByText('commit.noChangeOnLine')).toBeNull()
})

it('renders the uncommitted working-tree card without a sha', async () => {
  render(<CommitHoverCard />)
  await act(async () =>
    useCommitHover.getState().show({ ...target, uncommitted: true, sha: '0'.repeat(40) }),
  )
  expect(screen.getByText('blame.uncommitted')).toBeTruthy()
  expect(screen.queryByText('0000000')).toBeNull()
  expect(gitWorkingTreeDiff).toHaveBeenCalledWith('/repo', 'a.ts')
  expect(gitCommitDetail).not.toHaveBeenCalled()
})

it('explains an unborn branch instead of running a working-tree diff', async () => {
  gitWorkingTreeDiff.mockResolvedValueOnce(null)
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show({ ...target, uncommitted: true }))
  expect(screen.getByText('commit.noHead')).toBeTruthy()
})

it('renders the current user as You in the header', async () => {
  gitCommitDetail.mockResolvedValueOnce({ ...detail, email: 'me@example.com' })
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  expect(screen.getByText('blame.you')).toBeTruthy()
})

it('cancels a pending hover on escape or outside scroll and ignores its late answer', async () => {
  const pending = deferred<CommitDetail>()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  const { container } = render(<CommitHoverCard />)
  act(() => useCommitHover.getState().show(target))
  fireEvent.keyDown(window, { key: 'Escape' })
  await act(async () => {
    pending.resolve(detail)
  })
  expect(useCommitHover.getState().target).toBeNull()
  expect(container.childElementCount).toBe(0)
})

it('keeps an open card for internal scrolling', async () => {
  await loadCommitDetail(target.root, target.sha)
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  fireEvent.scroll(screen.getByText('+const value = 1'))
  expect(useCommitHover.getState().target).not.toBeNull()
})

it('shows a read error', async () => {
  gitCommitDetail.mockRejectedValueOnce(new Error('unreadable'))
  render(<CommitHoverCard />)
  await act(async () => useCommitHover.getState().show(target))
  expect(screen.getByText('unreadable')).toBeTruthy()
  expect(screen.queryByText('commit.loadingLine')).toBeNull()
})
