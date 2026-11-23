import { useEffect, useMemo, useState } from 'react'
import { useWorkspace } from '../store/workspace'
import { useTaskStore, type Problem } from '../store/tasks'
import { useTabs } from '../store/tabs'
import { useT } from '../i18n'
import { Icon } from './Icon'
import { useUi } from '../store/ui'
import { errorText, type TaskDefinition } from '../lib/ipc'
import { stripTaskAnsi } from '../lib/problemParser'

const EMPTY_TASKS: TaskDefinition[] = []
const EMPTY_PROBLEMS: Problem[] = []

function ProblemRow({ problem, onOpen }: { problem: Problem; onOpen: (problem: Problem) => void }) {
  const t = useT()
  const icon = problem.severity === 'warning' ? 'warning' : problem.severity === 'info' ? 'info' : 'alert-circle'
  return (
    <button type="button" onClick={() => onOpen(problem)} className="group flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-hover" title={problem.message}>
      <Icon name={icon} size={13} className={problem.severity === 'error' ? 'shrink-0 text-danger' : problem.severity === 'warning' ? 'shrink-0 text-warning' : 'shrink-0 text-muted'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-fg/90">{problem.message}</span>
        <span className="block truncate text-2xs text-muted">{problem.rel}:{problem.line}:{problem.column}</span>
      </span>
      <span className="sr-only">{t('tasks.openProblem')}</span>
    </button>
  )
}

export function TasksPanel() {
  const t = useT()
  const roots = useWorkspace((state) => state.roots)
  const activeRootId = useWorkspace((state) => state.activeRootId)
  const root = roots.find((item) => item.id === activeRootId) ?? roots[0] ?? null
  const [view, setView] = useState<'tasks' | 'problems'>('tasks')
  const tasks = useTaskStore((state) => root ? state.tasks[root.id] ?? EMPTY_TASKS : EMPTY_TASKS)
  const loading = useTaskStore((state) => root ? Boolean(state.loading[root.id]) : false)
  const problems = useTaskStore((state) => root ? state.problems[root.id] ?? EMPTY_PROBLEMS : EMPTY_PROBLEMS)
  const executions = useTaskStore((state) => state.executions)
  const activeId = useTaskStore((state) => state.activeId)
  const load = useTaskStore((state) => state.load)
  const run = useTaskStore((state) => state.run)
  const stop = useTaskStore((state) => state.stop)
  const select = useTaskStore((state) => state.select)
  const clearProblems = useTaskStore((state) => state.clearProblems)
  const openAt = useTabs((state) => state.openAt)

  useEffect(() => {
    if (root) void load(root.id)
  }, [root?.id, load])

  const latestByTask = useMemo(() => {
    const map = new Map<string, (typeof executions)[string]>()
    for (const execution of Object.values(executions)) {
      if (root && execution.root === root.id) map.set(execution.taskId, execution)
    }
    return map
  }, [executions, root])

  if (!root) {
    return <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted">{t('tasks.noProject')}</div>
  }

  const runTask = async (task: (typeof tasks)[number]) => {
    try {
      await run(root.id, task)
    } catch (error) {
      useUi.getState().toast(errorText(error), 'error')
    }
  }

  const active = activeId ? executions[activeId] : null
  const openProblem = (problem: Problem) => {
    void openAt(problem.root, problem.rel, problem.line, problem.column).catch(error => useUi.getState().toast(errorText(error), 'error'))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-line-soft px-2 py-1.5">
        <button type="button" onClick={() => setView('tasks')} className={`rounded px-2 py-1 text-xs ${view === 'tasks' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}>{t('tasks.title')}</button>
        <button type="button" onClick={() => setView('problems')} className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${view === 'problems' ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}>
          {t('tasks.problems')}
          {problems.length > 0 ? <span className="rounded-full bg-danger/15 px-1.5 text-2xs text-danger">{problems.length}</span> : null}
        </button>
        <span className="flex-1" />
        {view === 'tasks' ? (
          <button type="button" onClick={() => void load(root.id, true)} disabled={loading} aria-label={t('tasks.refresh')} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-30" data-tip={t('tasks.refresh')}>
            <Icon name={loading ? 'spinner' : 'refresh'} size={13} className={loading ? 'animate-spin' : ''} />
          </button>
        ) : (
          <button type="button" onClick={() => clearProblems(root.id)} disabled={problems.length === 0} aria-label={t('tasks.clearProblems')} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:opacity-30" data-tip={t('tasks.clearProblems')}>
            <Icon name="trash" size={13} />
          </button>
        )}
      </div>

      {view === 'problems' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {problems.length === 0 ? <div className="px-3 py-5 text-center text-xs text-muted">{t('tasks.noProblems')}</div> : problems.map((problem) => <ProblemRow key={problem.id} problem={problem} onOpen={openProblem} />)}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.length === 0 && !loading ? <div className="px-3 py-5 text-center text-xs leading-relaxed text-muted">{t('tasks.empty')}</div> : null}
          {tasks.map((task) => {
            const execution = latestByTask.get(task.id)
            const running = execution?.status === 'running' || execution?.status === 'starting'
            return (
              <div key={task.id} className="group border-b border-line-soft/60 px-2.5 py-2 hover:bg-hover">
                <div className="flex items-center gap-2">
                  <Icon name={running ? 'spinner' : execution?.status === 'success' ? 'check-circle' : execution?.status === 'failed' ? 'alert-circle' : 'terminal'} size={14} className={running ? 'animate-spin text-accent' : execution?.status === 'failed' ? 'text-danger' : execution?.status === 'success' ? 'text-success' : 'text-muted'} />
                  <button type="button" onClick={() => execution ? select(execution.id) : void runTask(task)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-sm text-fg/90">{task.label}</span>
                    <span className="block truncate text-2xs text-muted">{task.command} · {task.source}</span>
                  </button>
                  {running ? (
                    <button type="button" onClick={() => void stop(execution!.id).catch(error => useUi.getState().toast(errorText(error), 'error'))} aria-label={t('tasks.stop')} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover-strong hover:text-danger" data-tip={t('tasks.stop')}><Icon name="stop" size={12} /></button>
                  ) : (
                    <button type="button" onClick={() => void runTask(task)} aria-label={t('tasks.run')} className="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-hover-strong hover:text-accent" data-tip={t('tasks.run')}><Icon name="chevron-right" size={14} /></button>
                  )}
                </div>
              </div>
            )
          })}
          {active && active.root === root.id ? (
            <div className="border-t border-line bg-bg/50 px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
                <span className="truncate">{active.label}</span>
                <span className="ml-auto">{active.status === 'running' || active.status === 'starting' ? t('tasks.running') : active.status === 'success' ? t('tasks.success') : active.status === 'stopped' ? t('tasks.stopped') : t('tasks.failed')}{active.code !== null ? ' (' + active.code + ')' : ''}</span>
              </div>
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words rounded bg-bg p-2 font-mono text-2xs leading-relaxed text-fg/80">{stripTaskAnsi(active.output) || t('tasks.noOutput')}</pre>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
