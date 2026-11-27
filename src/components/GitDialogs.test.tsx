// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { git, api, create } = vi.hoisted(() => ({
  git: {
    busy: null,
    identities: {
      '/repo': {
        global: { name: 'Global', email: 'g@example.invalid' },
        effective: { name: 'Project', email: 'p@example.invalid' },
        useGlobal: false,
      },
    },
    temporaryIdentity: null,
    setTemporaryIdentity: vi.fn(),
    loadIdentity: vi.fn(),
    popStash: vi.fn(),
    clearStash: vi.fn(),
    deleteBranch: vi.fn(),
    stashChanges: vi.fn(),
  },
  api: { gitStashList: vi.fn() },
  create: vi.fn(),
}))
vi.mock('../store/git', () => ({
  useGit: Object.assign((select: (state: unknown) => unknown) => select(git), {
    getState: () => git,
  }),
}))
vi.mock('../lib/ipc', () => ({ api, errorText: (error: unknown) => String(error) }))
vi.mock('../lib/actions', () => ({ createBranch: create }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key, currentLocale: () => 'en' }))
import { GitDialogs } from './GitDialogs'
beforeEach(() => {
  vi.clearAllMocks()
  api.gitStashList.mockResolvedValue({
    entries: [
      { selector: 'stash@{0}', sha: 'new', time: 1, message: 'newest' },
      { selector: 'stash@{1}', sha: 'old', time: 0, message: 'older' },
    ],
    hasMore: false,
  })
  create.mockResolvedValue(true)
  git.clearStash.mockResolvedValue(true)
  git.deleteBranch.mockResolvedValue(true)
})
afterEach(cleanup)
it('selects an exact older stash and does nothing before confirmation', async () => {
  const close = vi.fn()
  render(
    <GitDialogs dialog={{ kind: 'popStash', root: '/repo', current: 'main' }} onClose={close} />,
  )
  const rows = await screen.findAllByRole('radio')
  expect(rows[0].textContent).toContain('newest')
  expect(git.popStash).not.toHaveBeenCalled()
  fireEvent.click(rows[1])
  fireEvent.click(screen.getByRole('button', { name: 'git.popStash' }))
  await waitFor(() => expect(git.popStash).toHaveBeenCalledWith('/repo', 'old'))
  expect(close).toHaveBeenCalled()
})
it('requires confirmation before clearing all stashes and supports cancellation', () => {
  const close = vi.fn()
  render(
    <GitDialogs dialog={{ kind: 'clearStash', root: '/repo', current: 'main' }} onClose={close} />,
  )
  expect(git.clearStash).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'git.clearStash' }).className).toContain('bg-danger')
  fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(close).toHaveBeenCalled()
  expect(git.clearStash).not.toHaveBeenCalled()
})
it('offers copy-HEAD creation without checkout and keeps errors reviewable', async () => {
  const close = vi.fn()
  create.mockResolvedValue(false)
  render(<GitDialogs dialog={{ kind: 'create', root: '/repo', current: 'main' }} onClose={close} />)
  fireEvent.change(screen.getByRole('textbox', { name: 'git.newBranchName' }), {
    target: { value: 'feature' },
  })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: 'git.createBranch' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith('/repo', 'feature', false))
  expect(close).not.toHaveBeenCalled()
})
it('force delete starts checked and forbids deleting the current local branch', async () => {
  const branch = {
    name: 'main',
    kind: 'local' as const,
    current: true,
    upstream: 'origin/main',
    sha: 'abc',
    time: 0,
    subject: '',
  }
  render(
    <GitDialogs
      dialog={{ kind: 'delete', root: '/repo', current: 'main', branch, force: true }}
      onClose={vi.fn()}
    />,
  )
  expect(
    (screen.getByRole('checkbox', { name: 'git.forceDeleteBranch' }) as HTMLInputElement).checked,
  ).toBe(true)
  expect(
    (screen.getByRole('button', { name: 'common.delete' }) as HTMLButtonElement).disabled,
  ).toBe(true)
})
it('defaults to the explicit project identity and stores temporary information only in the window store', async () => {
  const close = vi.fn()
  render(<GitDialogs dialog={{ kind: 'identity', root: '/repo' }} onClose={close} />)
  expect(
    (screen.getByRole('textbox', { name: 'git.identityName' }) as HTMLInputElement).value,
  ).toBe('Project')
  fireEvent.click(screen.getByRole('button', { name: 'git.temporaryIdentity' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'git.identityName' }), {
    target: { value: 'Temp' },
  })
  fireEvent.change(screen.getByRole('textbox', { name: 'git.identityEmail' }), {
    target: { value: 'temp@example.invalid' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  expect(git.setTemporaryIdentity).toHaveBeenCalledWith({
    name: 'Temp',
    email: 'temp@example.invalid',
  })
  expect(close).toHaveBeenCalled()
})

it('shows project and global identities separately even when they are identical', () => {
  const info = git.identities['/repo']
  const original = info.global
  info.global = { ...info.effective }
  try {
    const { container } = render(<GitDialogs dialog={{ kind: 'identity', root: '/repo' }} onClose={vi.fn()} />)
    expect(screen.getByText('git.projectIdentity')).toBeTruthy()
    expect(screen.getByText('git.globalIdentity')).toBeTruthy()
    expect(screen.getAllByText('Project (p@example.invalid)')).toHaveLength(2)
    expect(container.querySelector('[aria-label="git.identityMode"]')?.parentElement?.className).toContain('justify-center')
  } finally { info.global = original }
})
