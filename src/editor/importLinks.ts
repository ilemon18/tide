import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { api } from '../lib/ipc'
import { dirname } from '../lib/paths'
import { signals } from './signals'
import { jumpToImport } from './importJump'

export type ImportLinkContext = {
  /** Workspace root (absolute path) */
  root: string
  /** This file's path relative to root */
  rel: string
}

/** Extensions tried in order when completing */
const EXTS = [
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'html',
  'md',
  'py',
]

/**
 * Import string literals on a line: only `from '…'` / `import '…'` / `import('…')` / `require('…')` /
 * `@import '…'` count, covering TS / JS / Vue / CSS, so plain strings never become links.
 */
const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|@import\s+(?:url\()?\s*)(['"])([^'"\n]{1,300})\1/g

type SpecRange = { from: number; to: number; spec: string }

/** Only relative paths and common aliases are worth resolving, bare package names (react / lodash) are ignored */
function linkable(spec: string): boolean {
  return /^\.{1,2}\//.test(spec) || spec.startsWith('@/') || spec.startsWith('~/')
}

/** Scan one line, returning in-line ranges of all clickable specifiers */
function specRanges(text: string): SpecRange[] {
  const out: SpecRange[] = []
  SPEC_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = SPEC_RE.exec(text))) {
    const spec = match[2]
    if (!linkable(spec)) continue
    // match[0] = prefix + quote + spec + quote
    const from = match.index + match[0].length - spec.length - 1
    out.push({ from, to: from + spec.length, spec })
  }
  return out
}

const linkMark = Decoration.mark({ class: 'cm-import-link' })

/** Lines longer than this are not scanned (minified bundles are often one line of hundreds of thousands of chars) */
const MAX_SCAN_LINE = 4000

/** Only these files can hold JS / CSS style import statements */
const LINKABLE_EXT = new Set([
  'ts',
  'tsx',
  'mts',
  'cts',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'html',
  'md',
])

export function supportsImportLinks(rel: string): boolean {
  const dot = rel.lastIndexOf('.')
  if (dot < 0) return false
  return LINKABLE_EXT.has(rel.slice(dot + 1).toLowerCase())
}

/** Decorate only visible lines so big files never scan the whole document */
function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of view.visibleRanges) {
    const first = doc.lineAt(range.from).number
    const last = doc.lineAt(range.to).number
    for (let n = first; n <= last; n += 1) {
      const line = doc.line(n)
      if (line.length > MAX_SCAN_LINE) continue
      for (const item of specRanges(line.text)) {
        builder.add(line.from + item.from, line.from + item.to, linkMark)
      }
    }
  }
  return builder.finish()
}

const decorationPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/** Holding ⌘ / Ctrl adds a class to the editor root; CSS gives .cm-import-link an underline and pointer cursor. */
const cmdHintPlugin = ViewPlugin.fromClass(
  class {
    private sync = (event: KeyboardEvent) => {
      this.apply(event.metaKey || event.ctrlKey)
    }
    private blur = () => this.apply(false)

    constructor(private view: EditorView) {
      window.addEventListener('keydown', this.sync, true)
      window.addEventListener('keyup', this.sync, true)
      window.addEventListener('blur', this.blur)
      this.apply(false)
    }

    private apply(on: boolean) {
      this.view.dom.classList.toggle('cm-cmd-hint', on)
    }

    destroy() {
      window.removeEventListener('keydown', this.sync, true)
      window.removeEventListener('keyup', this.sync, true)
      window.removeEventListener('blur', this.blur)
      this.view.dom.classList.remove('cm-cmd-hint')
    }
  },
)

// ---- Path resolution ----

type ExistsEntry = { ok: boolean; at: number }

/** Resolution cache: repeated clicks on the same import skip IPC; short TTL tolerates newly created files */
const existsCache = new Map<string, ExistsEntry>()
const CACHE_TTL = 10_000
const CACHE_MAX = 600

/** Drop the path cache (called when the window hides or loses focus for a while) */
export function clearImportCache() {
  existsCache.clear()
}

async function isFile(abs: string): Promise<boolean> {
  const now = Date.now()
  const cached = existsCache.get(abs)
  if (cached && now - cached.at < CACHE_TTL) return cached.ok
  let ok = false
  try {
    ok = (await api.pathInfo(abs)).isFile
  } catch {
    ok = false
  }
  if (existsCache.size > CACHE_MAX) existsCache.clear()
  existsCache.set(abs, { ok, at: now })
  return ok
}

/** Normalize `a/./b/../c` segment by segment, returning null when it escapes the workspace root */
function normalize(parts: string[]): string | null {
  const out: string[] = []
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

/** specifier → base path relative to the workspace root (without extension completion) */
export function baseRel(fromRel: string, spec: string): string | null {
  const clean = spec.replace(/[?#].*$/, '').trim()
  if (!clean) return null
  // `@/x` and `~/x` both map to `src/x`
  if (clean.startsWith('@/') || clean.startsWith('~/')) {
    return normalize(['src', clean.slice(2)])
  }
  if (/^\.{1,2}(\/|$)/.test(clean)) {
    return normalize([dirname(fromRel), clean])
  }
  return null
}

/** Only these extensions are renamed into each other (TS ESM style: `./x.js` really means `x.ts`) */
const SWAPPABLE = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'])

/** Extension / index combinations tried in order */
export function candidateRels(base: string): string[] {
  const out: string[] = []
  const push = (value: string) => {
    if (!out.includes(value)) out.push(value)
  }
  push(base)
  const ext = /\.([a-z0-9]+)$/i.exec(base)
  if (ext) {
    if (!SWAPPABLE.has(ext[1].toLowerCase())) return out
    const stem = base.slice(0, base.length - ext[0].length)
    for (const suffix of EXTS) push(`${stem}.${suffix}`)
  } else {
    for (const suffix of EXTS) push(`${base}.${suffix}`)
    for (const suffix of EXTS) push(`${base}/index.${suffix}`)
  }
  return out
}

/** Resolve a specifier to a path inside the workspace; null when not found */
export async function resolveSpecifier(ctx: ImportLinkContext, spec: string): Promise<string | null> {
  const base = baseRel(ctx.rel, spec)
  if (base === null) return null
  for (const rel of candidateRels(base)) {
    if (await isFile(`${ctx.root}/${rel}`)) return rel
  }
  return null
}

/** Whether the click position lands on an import specifier */
function specAt(view: EditorView, pos: number): string | null {
  const line = view.state.doc.lineAt(pos)
  if (line.length > MAX_SCAN_LINE) return null
  for (const item of specRanges(line.text)) {
    if (pos >= line.from + item.from && pos <= line.from + item.to) return item.spec
  }
  return null
}

/** ⌘+click inside the editor: resolve the import path and open the target file. The context is passed as a getter so renames still yield the latest path. */
export function importLinkExtension(
  ctx: ImportLinkContext | (() => ImportLinkContext),
): Extension {
  const readCtx = typeof ctx === 'function' ? ctx : () => ctx
  return [
    decorationPlugin,
    cmdHintPlugin,
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (event.button !== 0) return false
        if (!event.metaKey && !event.ctrlKey) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos == null) return false
        const spec = specAt(view, pos)
        if (!spec) {
          // Not on an import path: a symbol that comes from an import jumps to that binding's line.
          // Anything else falls through to normal editing.
          if (!jumpToImport(view, pos)) return false
          event.preventDefault()
          return true
        }
        // Consume the default so ⌘-click does not also move the cursor
        event.preventDefault()
        const context = readCtx()
        void resolveSpecifier(context, spec).then((rel) => {
          if (rel) signals.onOpenImport(context.root, rel)
        })
        return true
      },
    }),
  ]
}