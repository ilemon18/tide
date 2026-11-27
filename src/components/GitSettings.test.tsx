// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useGit, DEFAULT_GIT_PREFERENCES } from '../store/git'

const { api, workspace, ui, tabs } = vi.hoisted(() => ({
  api: {
    gitPreferences: vi.fn(),
    gitSetPreferences: vi.fn(), gitProjectPreferences: vi.fn(), gitSetProjectPreferences: vi.fn(),
    gitIdentity: vi.fn(),
    gitRemotes: vi.fn(),
    gitSetRemote: vi.fn(),
    gitRemoveRemote: vi.fn(),
    gitSetIdentity: vi.fn(),
    gitPrepareConfig: vi.fn(),
    gitBranches: vi.fn(),
  },
  workspace: { roots: [{ id: '/repo', name: 'Repo', isGitRepo: true }], activeRootId: '/repo' },
  ui: { toast: vi.fn(), confirm: vi.fn(), confirmReq: null },
  tabs: { openExternalFile: vi.fn() },
}))
vi.mock('../lib/ipc', () => ({ api, errorText: (error: unknown) => String(error) }))
vi.mock('../store/workspace', () => ({
  useWorkspace: Object.assign((select: (state: unknown) => unknown) => select(workspace), {
    getState: () => workspace,
  }),
}))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => tabs } }))
vi.mock('../lib/actions', () => ({ openRemoteRepository: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key, englishText: (key: string) => 'English ' + key, t: (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { GitSettings } from './GitSettings'

beforeEach(() => {
  vi.clearAllMocks()
  useGit.getState().reset()
  useGit.setState({ preferences: DEFAULT_GIT_PREFERENCES, temporaryIdentity: null })
  api.gitPreferences.mockResolvedValue({ ...DEFAULT_GIT_PREFERENCES, mergeLog: false })
  api.gitProjectPreferences.mockResolvedValue({ ...DEFAULT_GIT_PREFERENCES, mergeLog: true })
  api.gitSetProjectPreferences.mockImplementation(async (_root, patch) => ({ ...useGit.getState().projectPreferences['/repo'], ...patch }))
  api.gitSetPreferences.mockImplementation(async (patch) => ({
    ...useGit.getState().preferences,
    ...patch,
  }))
  api.gitIdentity.mockResolvedValue({
    global: { name: 'Global', email: 'global@example.invalid' },
    effective: { name: 'Project', email: 'project@example.invalid' },
    useGlobal: false,
  })
  api.gitRemotes.mockResolvedValue([{ name: 'origin', url: 'git@example.com:team/repo.git' }])
  api.gitBranches.mockResolvedValue({ current: 'main', detached: false, branches: [] })
  ui.confirm.mockResolvedValue(true)
})
afterEach(cleanup)

it('reads project settings and writes only the changed project switch', async () => {
  render(<GitSettings root="/repo" onClose={vi.fn()} />)
  const toggle = await screen.findByRole('switch', { name: 'git.settings.mergeLog' })
  await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(toggle)
  await waitFor(() =>
    expect(api.gitSetProjectPreferences).toHaveBeenCalledExactlyOnceWith('/repo', { mergeLog: false }),
  )
  expect(api.gitSetIdentity).not.toHaveBeenCalled()
  expect(api.gitSetPreferences).not.toHaveBeenCalled()
})
it('saves project use-global identity without an invalid empty override and preserves temporary identity', async () => {
  useGit.setState({ temporaryIdentity: { name: 'Temporary', email: 'temporary@example.invalid' } })
  render(<GitSettings root="/repo" onClose={vi.fn()} />)
  await waitFor(() => expect(api.gitIdentity).toHaveBeenCalled())
  fireEvent.click(screen.getByRole('button', { name: 'git.commitIdentity' }))
  fireEvent.click(screen.getByRole('button', { name: 'git.settings.project' }))
  fireEvent.click(screen.getByRole('switch', { name: 'git.settings.useGlobal' }))
  fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
  await waitFor(() => expect(api.gitSetIdentity).toHaveBeenCalledWith('/repo', true, null))
  expect(useGit.getState().temporaryIdentity?.name).toBe('Temporary')
})
it('edits the actual project config path through the file editor', async () => {
  const close = vi.fn()
  api.gitPrepareConfig.mockResolvedValue('/repo/.git/config')
  render(<GitSettings root="/repo" onClose={close} />)
  await act(async () => {})
  fireEvent.click(screen.getAllByRole('button', { name: 'common.edit' })[1])
  await waitFor(() => expect(tabs.openExternalFile).toHaveBeenCalledWith('/repo/.git/config'))
  expect(close).toHaveBeenCalled()
})

it('keeps an edited identity draft when a background configuration refresh arrives', async () => {
  render(<GitSettings root="/repo" onClose={vi.fn()} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'git.commitIdentity' }))
  const name = screen.getByRole('textbox', { name: 'git.identityName' }) as HTMLInputElement
  fireEvent.change(name, { target: { value: 'My draft' } })
  await act(async () => {
    useGit.setState({
      identities: {
        '/repo': {
          ...useGit.getState().identities['/repo'],
          global: { name: 'Reloaded', email: 'global@example.invalid' },
        },
      },
    })
  })
  expect(name.value).toBe('My draft')
})
