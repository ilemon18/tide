import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listen } from '@tauri-apps/api/event'
import { api, type TaskDefinition } from '../lib/ipc'
import { budget, setMemoryProfile } from '../lib/memoryBudget'
import { setupTaskEvents, useTaskStore } from './tasks'

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))
vi.mock('../lib/ipc', async () => {
  const actual = await vi.importActual<typeof import('../lib/ipc')>('../lib/ipc')
  return { ...actual, api: { ...actual.api, taskList: vi.fn(), taskRun: vi.fn(), taskStop: vi.fn() } }
})

const build: TaskDefinition = { id: 'build', label: 'Build', command: 'pnpm build', source: 'package.json' }
const state = () => useTaskStore.getState()
const currentId = () => state().activeId!

beforeEach(() => {
  vi.clearAllMocks()
  setMemoryProfile('normal')
  useTaskStore.setState({ tasks: {}, loading: {}, executions: {}, activeId: null, problems: {} })
  vi.mocked(api.taskList).mockResolvedValue([build])
  vi.mocked(api.taskRun).mockResolvedValue(undefined)
  vi.mocked(api.taskStop).mockResolvedValue(undefined)
})

describe('task events', () => {
  it('cleans up partial subscriptions and permits a shared retry before running', async () => {
    const unlisten = vi.fn()
    vi.mocked(listen).mockResolvedValueOnce(unlisten).mockRejectedValueOnce(new Error('listener failed'))
    await expect(setupTaskEvents()).rejects.toThrow('listener failed')
    expect(unlisten).toHaveBeenCalledOnce()
    const ready = setupTaskEvents()
    expect(setupTaskEvents()).toBe(ready)
    await ready
    expect(listen).toHaveBeenCalledTimes(4)
  })
})

describe('task store', () => {
  it('loads once, runs and parses output with one based coordinates', async () => {
    await Promise.all([state().load('/repo'), state().load('/repo')])
    expect(api.taskList).toHaveBeenCalledTimes(1)
    await state().run('/repo', state().tasks['/repo'][0])
    const id = currentId()
    expect(api.taskRun).toHaveBeenCalledWith('/repo', id, 'pnpm build', '')
    state().append(id, 'src/main.ts:3:2: error broken\n')
    expect(state().problems['/repo'][0]).toMatchObject({ rel: 'src/main.ts', line: 3, column: 2 })
    state().finish(id, 1, false)
    expect(state().executions[id]).toMatchObject({ status: 'failed', code: 1 })
  })

  it('keeps output and exit that arrive before taskRun resolves', async () => {
    vi.mocked(api.taskRun).mockImplementation(async (_root, id) => {
      state().append(id, 'instant output')
      state().finish(id, 0, true)
    })
    await state().run('/repo', build)
    expect(state().executions[currentId()]).toMatchObject({ status: 'success', output: 'instant output', code: 0 })
  })

  it('prevents duplicate launches while a task is starting', async () => {
    await Promise.all([state().run('/repo', build), state().run('/repo', build)])
    expect(api.taskRun).toHaveBeenCalledTimes(1)
    expect(Object.values(state().executions)).toHaveLength(1)
  })

  it('keeps stopped status when exit arrives during taskStop', async () => {
    vi.mocked(api.taskStop).mockImplementation(async id => { state().finish(id, null, false) })
    await state().run('/repo', build)
    const id = currentId()
    await state().stop(id)
    expect(api.taskStop).toHaveBeenCalledWith(id)
    expect(state().executions[id].status).toBe('stopped')
  })

  it('restores a running task if stopping fails', async () => {
    await state().run('/repo', build)
    vi.mocked(api.taskStop).mockRejectedValueOnce(new Error('stop failed'))
    await expect(state().stop(currentId())).rejects.toThrow('stop failed')
    expect(state().executions[currentId()].status).toBe('running')
  })

  it('marks failed launches and permits retry', async () => {
    vi.mocked(api.taskRun).mockRejectedValueOnce(new Error('spawn failed'))
    await expect(state().run('/repo', build)).rejects.toThrow('spawn failed')
    expect(state().executions[currentId()].status).toBe('failed')
    await state().run('/repo', build)
    expect(state().executions[currentId()].status).toBe('running')
  })

  it('aggregates diagnostics from different tasks and resolves custom working directories', async () => {
    await state().run('/repo', build)
    state().append(currentId(), 'src/a.ts:1:1: error first\n')
    const other = { ...build, id: 'test', cwd: 'packages/api' }
    await state().run('/repo', other)
    state().append(currentId(), 'src/b.ts:2:3: warning second\n')
    expect(state().problems['/repo'].map(problem => problem.rel)).toEqual(['src/a.ts', 'packages/api/src/b.ts'])
    expect(api.taskRun).toHaveBeenLastCalledWith('/repo', currentId(), 'pnpm build', 'packages/api')
    state().clearProblems('/repo')
    expect(state().problems['/repo']).toEqual([])
  })

  it('discards late discovery after closing a root', async () => {
    let resolve!: (tasks: TaskDefinition[]) => void
    vi.mocked(api.taskList).mockImplementationOnce(() => new Promise(done => { resolve = done }))
    const load = state().load('/repo', true)
    state().clearRoot('/repo')
    resolve([build])
    await load
    expect(state().tasks['/repo']).toBeUndefined()
    expect(state().loading['/repo']).toBeUndefined()
  })

  it('keeps a stopped run\'s late output from replacing its rerun diagnostics', async () => {
    await state().run('/repo', build)
    const first = currentId()
    await state().stop(first)
    await state().run('/repo', build)
    state().append(currentId(), 'src/new.ts:1:1: error new\n')
    state().append(first, 'src/old.ts:1:1: error old\n')
    expect(state().problems['/repo'].map(problem => problem.rel)).toEqual(['src/new.ts'])
  })

  it('cancels a task while listener setup or native launch is pending', async () => {
    const launch = state().run('/repo', build)
    await state().stop(currentId())
    await launch
    expect(api.taskRun).not.toHaveBeenCalled()
    expect(state().executions[currentId()].status).toBe('stopped')
  })

  it('stops a launch that resolves after its workspace was closed', async () => {
    let resolve!: () => void
    vi.mocked(api.taskRun).mockImplementationOnce(async () => {
      await new Promise<void>(done => { resolve = done })
    })
    const launch = state().run('/repo', build)
    await vi.waitFor(() => expect(api.taskRun).toHaveBeenCalledOnce())
    const id = currentId()
    state().clearRoot('/repo')
    resolve()
    await launch
    expect(api.taskStop).toHaveBeenCalledWith(id)
    expect(state().executions).toEqual({})
  })

  it('bounds output without splitting surrogate pairs and bounds completed history', async () => {
    await state().run('/repo', build)
    const id = currentId()
    state().append(id, '😀' + 'x'.repeat(budget.taskOutputChars() - 1))
    expect(state().executions[id].output).toBe('x'.repeat(budget.taskOutputChars() - 1))
    state().finish(id, 0, true)
    for (let index = 0; index < budget.taskHistory() + 2; index++) {
      await state().run('/repo', build)
      state().finish(currentId(), 0, true)
    }
    expect(Object.values(state().executions)).toHaveLength(budget.taskHistory())
    setMemoryProfile('light')
    state().append(currentId(), 'y'.repeat(budget.taskOutputChars() + 10))
    state().trim()
    expect(Object.values(state().executions)).toHaveLength(budget.taskHistory())
    expect(state().executions[currentId()].output).toHaveLength(budget.taskOutputChars())
    setMemoryProfile('normal')
  })
})
