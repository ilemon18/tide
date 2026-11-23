import { budget } from './memoryBudget'

export type ProblemSeverity = 'error' | 'warning' | 'info'
export type Problem = {
  id: string
  root: string
  taskId: string
  rel: string
  line: number
  column: number
  severity: ProblemSeverity
  message: string
  source: string
}

// CSI colors/control codes and OSC titles/hyperlinks are not diagnostic text.
export function stripTaskAnsi(value: string): string {
  return value.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '').replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, '')
}

function severityOf(text: string): ProblemSeverity {
  if (/^(?:fatal\s+)?error\b/i.test(text)) return 'error'
  if (/\bwarn(?:ing)?\b/i.test(text)) return 'warning'
  if (/\binfo(?:rmation)?\b/i.test(text)) return 'info'
  return 'error'
}

/** Diagnostics never nominate an absolute, URL or escaping editor path. */
function problemPath(value: string, cwd: string): string | null {
  const path = value.trim().replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || /[\u0000-\u001f]/.test(path) || path.includes('://')) return null
  const parts = path.split('/')
  if (parts.some(part => part === '..' || part === '')) return null
  const base = cwd.replace(/\\/g, '/')
  if (base.startsWith('/') || /^[A-Za-z]:/.test(base) || base.includes('://') || /[\u0000-\u001f]/.test(base)) return null
  const rel = [...base.split('/'), ...parts].filter(part => part && part !== '.').join('/')
  if (!rel || rel.split('/').some(part => part === '..')) return null
  return rel
}

/** Parse TypeScript/linter locations and Rust's message-before-arrow format. Coordinates are one based. */
export function parseProblems(output: string, root: string, taskId: string, cwd = ''): Problem[] {
  const problems: Problem[] = []
  const seen = new Set<string>()
  let rustMessage: string | null = null
  let legacyArrow: { path: string; line: string; column: string } | null = null
  const add = (path: string, row: string, col: string, message: string) => {
    const rel = problemPath(path, cwd)
    const line = Number(row)
    const column = Number(col)
    if (!rel || !message || !Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return
    const id = taskId + ':' + rel + ':' + line + ':' + column + ':' + message
    if (seen.has(id) || problems.length >= budget.taskProblems()) return
    seen.add(id)
    problems.push({ id, root, taskId, rel, line, column, severity: severityOf(message), message, source: taskId })
  }
  for (const raw of stripTaskAnsi(output).split(/\r?\n|\r/)) {
    const text = raw.trim()
    if (!text) { legacyArrow = null; continue }
    const arrow = text.match(/^-->\s+(.+?):(\d+)(?::(\d+))?\s*$/)
    if (arrow) {
      if (rustMessage) add(arrow[1], arrow[2], arrow[3] ?? '1', rustMessage)
      else legacyArrow = { path: arrow[1], line: arrow[2], column: arrow[3] ?? '1' }
      rustMessage = null
      continue
    }
    const location = text.match(/^(.+?):(\d+):(\d+)(?:\s*[:|-]\s*|\s+)(.+)$/)
      ?? text.match(/^(.+?)\((\d+),\s*(\d+)\)\s*:\s*(.+)$/)
    if (location) {
      add(location[1], location[2], location[3], location[4].trim())
      legacyArrow = null
      rustMessage = null
      continue
    }
    if (/^(?:error|warning|info)(?:\[[^\]]+\])?\s*:/i.test(text)) {
      if (legacyArrow) {
        add(legacyArrow.path, legacyArrow.line, legacyArrow.column, text)
        legacyArrow = null
        rustMessage = null
      } else rustMessage = text
    } else if (!/^(?:\d*\s*\||=|\^)/.test(text)) {
      legacyArrow = null
      rustMessage = null
    }
  }
  return problems
}
