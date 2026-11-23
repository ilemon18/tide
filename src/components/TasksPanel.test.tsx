// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('../store/workspace', async () => {
  const { create } = await import('zustand')
  return { useWorkspace: create(() => ({ roots: [], activeRootId: null })) }
})
vi.mock('../store/tabs', async () => {
  const { create } = await import('zustand')
  return { useTabs: create(() => ({ openAt: vi.fn().mockResolvedValue(undefined) })) }
})
vi.mock('../store/ui', async () => {
  const { create } = await import('zustand')
  return { useUi: create(() => ({ toast: vi.fn() })) }
})
vi.mock('./Icon', () => ({ Icon: () => <span /> }))

import { TasksPanel } from './TasksPanel'
import { useWorkspace, type RootNode } from '../store/workspace'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import { useTaskStore, type TaskExecution } from '../store/tasks'
import { applyLocale, t } from '../i18n'

const root: RootNode = { id: '/repo', name: 'repo', isGitRepo: false, tree: {}, expanded: {}, collapsed: false }
const task = { id: 'build', label: 'Build', command: 'pnpm build', source: 'package.json' }
const execution: TaskExecution = { id: 'run-1', root: '/repo', taskId: 'build', label: 'Build', command: 'pnpm build', cwd: '', output: '\u001b[31mbuild failed\u001b[0m', status: 'failed', code: 2 }

beforeEach(() => {
  applyLocale('en')
  vi.clearAllMocks()
  useWorkspace.setState({ roots: [root], activeRootId: root.id })
  useTaskStore.setState({ tasks: { '/repo': [task] }, loading: {}, executions: {}, activeId: null, problems: {}, load: vi.fn().mockResolvedValue(undefined), run: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) })
})
afterEach(cleanup)

it('renders empty states without unstable store snapshots', () => {
  useWorkspace.setState({ roots: [], activeRootId: null })
  render(<TasksPanel />)
  expect(screen.getByText(t('tasks.noProject'))).toBeTruthy()
})

it('starts a task and refreshes definitions only on request', () => {
  render(<TasksPanel />)
  fireEvent.click(screen.getByRole('button', { name: t('tasks.run') }))
  expect(useTaskStore.getState().run).toHaveBeenCalledWith('/repo', task)
  fireEvent.click(screen.getByRole('button', { name: t('tasks.refresh') }))
  expect(useTaskStore.getState().load).toHaveBeenLastCalledWith('/repo', true)
})

it('selects completed output without rerunning and displays its exit code', () => {
  useTaskStore.setState({ executions: { 'run-1': execution } })
  render(<TasksPanel />)
  fireEvent.click(screen.getByRole('button', { name: /Build pnpm build/ }))
  expect(useTaskStore.getState().activeId).toBe('run-1')
  expect(useTaskStore.getState().run).not.toHaveBeenCalled()
  expect(screen.getByText('build failed')).toBeTruthy()
  expect(screen.getByText(t('tasks.failed') + ' (2)')).toBeTruthy()
})

it('opens a Problem at its owning root and unchanged one based coordinates', () => {
  useTaskStore.setState({ problems: { '/repo': [{ id: 'problem', root: '/repo', taskId: 'build', rel: 'src/main.ts', line: 12, column: 4, severity: 'error', message: 'bad type', source: 'build' }] } })
  render(<TasksPanel />)
  fireEvent.click(screen.getByRole('button', { name: /Problems/ }))
  fireEvent.click(screen.getByRole('button', { name: /bad type/ }))
  expect(useTabs.getState().openAt).toHaveBeenCalledWith('/repo', 'src/main.ts', 12, 4)
  fireEvent.click(screen.getByRole('button', { name: t('tasks.clearProblems') }))
  expect(screen.getByText(t('tasks.noProblems'))).toBeTruthy()
})

it('shows launch failures in a toast', async () => {
  vi.mocked(useTaskStore.getState().run).mockRejectedValueOnce(new Error('spawn failed'))
  render(<TasksPanel />)
  fireEvent.click(screen.getByRole('button', { name: t('tasks.run') }))
  await waitFor(() => expect(useUi.getState().toast).toHaveBeenCalledWith(expect.stringContaining('spawn failed'), 'error'))
})
