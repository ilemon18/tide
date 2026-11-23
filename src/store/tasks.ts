import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { api, errorText, type TaskDefinition } from '../lib/ipc'
import { budget } from '../lib/memoryBudget'
import { parseProblems, type Problem } from '../lib/problemParser'
import { useUi } from './ui'

export type { Problem } from '../lib/problemParser'
export type TaskExecution = {
  id: string
  root: string
  taskId: string
  label: string
  command: string
  cwd: string
  output: string
  status: 'starting' | 'running' | 'success' | 'failed' | 'stopped'
  code: number | null
}

type TaskStore = {
  tasks: Record<string, TaskDefinition[]>
  loading: Record<string, boolean>
  executions: Record<string, TaskExecution>
  activeId: string | null
  problems: Record<string, Problem[]>
  load: (root: string, force?: boolean) => Promise<void>
  run: (root: string, task: TaskDefinition) => Promise<void>
  stop: (id: string) => Promise<void>
  select: (id: string) => void
  clearProblems: (root: string) => void
  append: (id: string, data: string) => void
  finish: (id: string, code: number | null, success: boolean) => void
  clearRoot: (root: string) => void
  trim: () => void
}

const loadRequests = new Map<string, symbol>()
let eventSetup: Promise<void> | null = null

/** Share concurrent installation, and release partial subscriptions before allowing a retry. */
export function setupTaskEvents(): Promise<void> {
  if (!eventSetup) {
    eventSetup = (async () => {
      const listeners = await Promise.allSettled([
        listen<{ id: string; data: string }>('task:data', ({ payload }) => useTaskStore.getState().append(payload.id, payload.data)),
        listen<{ id: string; code: number | null; success: boolean }>('task:exit', ({ payload }) => useTaskStore.getState().finish(payload.id, payload.code, payload.success)),
      ])
      const failure = listeners.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') {
        for (const result of listeners) if (result.status === 'fulfilled') result.value()
        throw failure.reason
      }
    })().catch(error => { eventSetup = null; throw error })
  }
  return eventSetup
}

function active(execution: TaskExecution): boolean {
  return execution.status === 'starting' || execution.status === 'running'
}

function trimHistory(executions: Record<string, TaskExecution>): Record<string, TaskExecution> {
  const completed = Object.values(executions).filter(execution => !active(execution))
  const remove = new Set(completed.slice(0, Math.max(0, completed.length - budget.taskHistory())).map(execution => execution.id))
  return Object.fromEntries(Object.entries(executions).filter(([id]) => !remove.has(id)))
}

export const useTaskStore = create<TaskStore>((set, get) => ({
  tasks: {}, loading: {}, executions: {}, activeId: null, problems: {},
  load: async (root, force = false) => {
    if (!root || (!force && (get().tasks[root] || get().loading[root]))) return
    const request = Symbol(root)
    loadRequests.set(root, request)
    set(state => ({ loading: { ...state.loading, [root]: true } }))
    try {
      const tasks = await api.taskList(root)
      if (loadRequests.get(root) !== request) return
      set(state => ({ tasks: { ...state.tasks, [root]: tasks }, loading: { ...state.loading, [root]: false } }))
    } catch (error) {
      if (loadRequests.get(root) !== request) return
      set(state => ({ loading: { ...state.loading, [root]: false } }))
      useUi.getState().toast(errorText(error), 'error')
    } finally {
      if (loadRequests.get(root) === request) loadRequests.delete(root)
    }
  },
  run: async (root, task) => {
    const existing = Object.values(get().executions).find(execution => execution.root === root && execution.taskId === task.id && active(execution))
    if (existing) { set({ activeId: existing.id }); return }
    const id = crypto.randomUUID()
    const execution: TaskExecution = { id, root, taskId: task.id, label: task.label, command: task.command, cwd: task.cwd ?? '', output: '', status: 'starting', code: null }
    set(state => ({ executions: trimHistory({ ...state.executions, [id]: execution }), activeId: id, problems: { ...state.problems, [root]: (state.problems[root] ?? []).filter(problem => problem.taskId !== task.id) } }))
    try {
      await setupTaskEvents()
      if (!get().executions[id] || get().executions[id].status === 'stopped') return
      // The client id and execution exist before native output/exit can arrive, even for instant tasks.
      await api.taskRun(root, id, task.command, task.cwd ?? '')
      const current = get().executions[id]
      if (!current) { await api.taskStop(id); return }
      if (current.status === 'stopped') { await api.taskStop(id); return }
      if (current.status === 'starting') set(state => ({ executions: { ...state.executions, [id]: { ...current, status: 'running' } } }))
    } catch (error) {
      get().finish(id, null, false)
      throw error
    }
  },
  stop: async (id) => {
    const execution = get().executions[id]
    if (!execution || !active(execution)) return
    // Reserve the stopped state before native exit arrives. A failed stop restores the live state.
    set(state => ({ executions: { ...state.executions, [id]: { ...execution, status: 'stopped' } } }))
    if (execution.status === 'starting') return
    try { await api.taskStop(id) }
    catch (error) {
      if (get().executions[id]?.status === 'stopped') set(state => ({ executions: { ...state.executions, [id]: { ...state.executions[id], status: 'running' } } }))
      throw error
    }
  },
  select: (id) => { if (get().executions[id]) set({ activeId: id }) },
  clearProblems: (root) => set(state => ({ problems: { ...state.problems, [root]: [] } })),
  append: (id, data) => {
    const execution = get().executions[id]
    if (!execution) return
    let output = (execution.output + data).slice(-budget.taskOutputChars())
    if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1)
    const latest = Object.values(get().executions).filter(item => item.root === execution.root && item.taskId === execution.taskId).at(-1)
    if (latest?.id !== id) {
      set(state => ({ executions: { ...state.executions, [id]: { ...execution, output } } }))
      return
    }
    const others = (get().problems[execution.root] ?? []).filter(problem => problem.taskId !== execution.taskId)
    const problems = [...others, ...parseProblems(output, execution.root, execution.taskId, execution.cwd)].slice(-budget.taskProblems())
    set(state => ({ executions: { ...state.executions, [id]: { ...execution, output } }, problems: { ...state.problems, [execution.root]: problems } }))
  },
  finish: (id, code, success) => {
    const execution = get().executions[id]
    if (!execution) return
    const status = execution.status === 'stopped' ? 'stopped' : success ? 'success' : 'failed'
    set(state => ({ executions: trimHistory({ ...state.executions, [id]: { ...execution, code, status } }) }))
  },
  clearRoot: (root) => {
    loadRequests.delete(root)
    const executions = Object.fromEntries(Object.entries(get().executions).filter(([, execution]) => execution.root !== root))
    const activeId = get().activeId
    set(state => ({ tasks: Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== root)), loading: Object.fromEntries(Object.entries(state.loading).filter(([key]) => key !== root)), executions, problems: Object.fromEntries(Object.entries(state.problems).filter(([key]) => key !== root)), activeId: activeId && executions[activeId] ? activeId : null }))
  },
  trim: () => {
    const executions = trimHistory(Object.fromEntries(Object.entries(get().executions).map(([id, execution]) => {
      let output = execution.output.slice(-budget.taskOutputChars())
      if (/^[\uDC00-\uDFFF]/.test(output)) output = output.slice(1)
      return [id, { ...execution, output }]
    })))
    set(state => ({ executions, problems: Object.fromEntries(Object.entries(state.problems).map(([root, problems]) => [root, problems.slice(-budget.taskProblems())])), activeId: state.activeId && executions[state.activeId] ? state.activeId : null }))
  },
}))
