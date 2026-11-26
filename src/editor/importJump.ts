import type { Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { stickyRange } from './highlight'

export type ImportTarget = {
  /** Local binding name (the right-hand side of `a as b`) */
  name: string
  /** Exact range of that binding inside the import statement */
  from: number
  to: number
}

/** Imports live at the top; bounding the scan keeps ⌘-click cheap in huge generated files. */
const MAX_SCAN_CHARS = 256_000
const MAX_SCAN_LINES = 2000

const IDENT = /^[A-Za-z_$][\w$]*/

/** `import ... from '…'`, including multi-line clauses; side-effect-only imports have no binding. */
const IMPORT_RE = /(^|[\n;])\s*import\s+(?:type\s+)?([^;]*?)\s+from\s*(['"])([^'"\n]*)\3/g

const bindingsCache = new WeakMap<Text, Map<string, ImportTarget>>()

function statementOffset(match: RegExpExecArray, clause: string): number {
  // match[1] is the preceding newline / semicolon; skip it so clause offsets start at `import`.
  const clauseAt = match[0].indexOf(clause, match[1].length)
  return match.index + Math.max(0, clauseAt)
}

function addBinding(
  out: Map<string, ImportTarget>,
  doc: Text,
  clauseStart: number,
  offsetInClause: number,
  name: string,
) {
  if (!name || out.has(name)) return
  const abs = clauseStart + offsetInClause
  const line = doc.lineAt(abs)
  // Never let a malformed clause point past the line it was parsed from
  const from = Math.max(line.from, Math.min(abs, line.to - name.length))
  out.set(name, { name, from, to: from + name.length })
}

function parseImportBindings(doc: Text): Map<string, ImportTarget> {
  const cached = bindingsCache.get(doc)
  if (cached) return cached

  const end = Math.min(
    doc.length,
    MAX_SCAN_CHARS,
    doc.line(Math.min(doc.lines, MAX_SCAN_LINES)).to,
  )
  const text = doc.sliceString(0, end)
  const out = new Map<string, ImportTarget>()
  IMPORT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = IMPORT_RE.exec(text))) {
    const clause = match[2]
    const clauseStart = statementOffset(match, clause)

    // Default import: the first token, but not `{ … }` or `* as …`
    const def = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|$)/.exec(clause)
    if (def) {
      addBinding(out, doc, clauseStart, def.index + def[0].indexOf(def[1]), def[1])
    }

    // Namespace import: `* as NS`
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause)
    if (ns) {
      addBinding(out, doc, clauseStart, ns.index + ns[0].lastIndexOf(ns[1]), ns[1])
    }

    // Named imports, with optional inline `type`, aliases, and multiple lines
    const block = /\{([\s\S]*?)\}/.exec(clause)
    if (block) {
      const blockStart = clauseStart + block.index + 1
      const spec = /(?:^|,)\s*(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?/g
      let part: RegExpExecArray | null
      while ((part = spec.exec(block[1]))) {
        const original = part[1]
        const local = part[2] ?? original
        const localAt = part[2]
          ? part.index + part[0].lastIndexOf(part[2])
          : part.index + part[0].indexOf(original)
        addBinding(out, doc, blockStart, localAt, local)
      }
    }
  }

  bindingsCache.set(doc, out)
  return out
}

/** True when `index` sits inside a quoted/template string on that line. */
function insideString(text: string, index: number): boolean {
  let quote: string | null = null
  for (let i = 0; i < index; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    }
  }
  return quote !== null
}

/** Identifier chain under the pointer: `obj.method` resolves to `obj`. */
export function identifierAt(doc: Text, pos: number): { name: string; from: number; to: number } | null {
  const line = doc.lineAt(pos)
  const trimmed = line.text.trimStart()
  // Cheap comment guard: line comments and JSDoc continuation lines are never call sites.
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return null
  const offset = pos - line.from
  if (insideString(line.text, offset)) return null

  const chain = /[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*/g
  let match: RegExpExecArray | null
  while ((match = chain.exec(line.text))) {
    const end = match.index + match[0].length
    if (offset < match.index || offset > end) continue
    const root = IDENT.exec(match[0])
    if (!root) return null
    return {
      name: root[0],
      from: line.from + match.index,
      to: line.from + match.index + root[0].length,
    }
  }
  return null
}

/** Resolve the symbol under the pointer to its local import binding, or null. */
export function importTargetAt(doc: Text, pos: number): ImportTarget | null {
  const ident = identifierAt(doc, pos)
  if (!ident) return null
  return parseImportBindings(doc).get(ident.name) ?? null
}

/**
 * ⌘/Ctrl-click a symbol: move the caret to its import binding and centre it in the viewport.
 * Returns false when the symbol is not imported, so the caller can leave normal editing alone.
 */
export function jumpToImport(view: EditorView, pos: number): boolean {
  const target = importTargetAt(view.state.doc, pos)
  if (!target) return false
  view.dispatch({
    selection: { anchor: target.from },
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  })
  stickyRange(view, target.from, target.to)
  view.focus()
  return true
}
