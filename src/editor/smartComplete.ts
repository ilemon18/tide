import {
  autocompletion,
  completeAnyWord,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import { EditorState, type Extension, type Text } from '@codemirror/state'
import { api } from '../lib/ipc'
import { budget } from '../lib/memoryBudget'
import { parseImports, type ImportTarget, type ParsedImport } from './importJump'
import { resolveSpecifier } from './importLinks'
import { loadJSCompletion, loadLanguage, resolveLang, type JSCompletion } from './languages'
import {
  computeOutline,
  type OutlineKind,
  type OutlineResult,
  type OutlineSymbol,
} from './outline'

export type SmartCompleteContext = {
  root: string
  rel: () => string
  langKey: () => string | null
  /** False for external files: document symbols stay available, cross-file imports do not. */
  project: boolean
}

type MemberPath = { path: readonly string[]; name: string }
type ImportBinding = {
  spec: string
  target: ImportTarget
  kind: 'default' | 'namespace' | 'named'
}
type MemberRoot = { symbol?: OutlineSymbol; imported?: ImportBinding }
type ImportedFile = { outline: OutlineResult; doc: Text }
type ImportCacheEntry = { at: number; file: ImportedFile | null }

const JS_KEYS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'])
const SMART_KEYS = new Set([
  ...JS_KEYS,
  'py',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cc',
  'cpp',
  'cxx',
  'hpp',
  'hh',
])
const CONTAINER_KINDS = new Set<OutlineKind>([
  'class',
  'interface',
  'enum',
  'struct',
  'trait',
  'module',
])

const IMPORT_CACHE_TTL = 60_000

let symbolCache = new WeakMap<Text, { langKey: string | null; result: OutlineResult }>()
let importedCache = new Map<string, ImportCacheEntry>()
/** specifier → resolved target, so plain import completions can show cached target info synchronously. */
let resolvedSpecs = new Map<string, string>()

export function supportsSmartCompletion(langKey: string | null | undefined): boolean {
  return Boolean(langKey && SMART_KEYS.has(langKey))
}

/** Drop every rebuildable completion cache. Called through lib/memory's idle/hidden reclamation. */
export function clearCompletionCache() {
  symbolCache = new WeakMap()
  importedCache.clear()
  resolvedSpecs.clear()
}

function symbolsForState(state: EditorState, langKey: string | null): OutlineResult {
  const cached = symbolCache.get(state.doc)
  if (cached && cached.langKey === langKey) return cached.result
  const result = computeOutline(state, langKey)
  symbolCache.set(state.doc, { langKey, result })
  return result
}

function kindToType(kind: OutlineKind): string {
  switch (kind) {
    case 'class':
    case 'struct':
      return 'class'
    case 'interface':
    case 'trait':
      return 'interface'
    case 'enum':
      return 'enum'
    case 'type':
      return 'type'
    case 'function':
      return 'function'
    case 'method':
      return 'method'
    case 'property':
    case 'key':
      return 'property'
    case 'module':
      return 'namespace'
    default:
      return 'variable'
  }
}

function signature(doc: Text, symbol: OutlineSymbol): string {
  const first = doc.line(Math.min(Math.max(1, symbol.line), doc.lines))
  let text = first.text.trim()
  const last = Math.min(symbol.endLine, first.number + 5)
  for (let number = first.number + 1; number <= last && text.length < 240; number += 1) {
    if (/\{\s*$|;\s*$|=>/.test(text)) break
    const next = doc.line(number).text.trim()
    if (next) text = `${text} ${next}`
  }
  return text.length > 240 ? `${text.slice(0, 239)}…` : text
}

function makeOption(
  label: string,
  type: string,
  detail: string,
  info: string,
  boost: number,
): Completion {
  return { label, type, detail, info, boost }
}

function topLevelOptions(result: OutlineResult, doc: Text, rel: string): Completion[] {
  const out: Completion[] = []
  const seen = new Set<string>()
  for (const symbol of result.symbols) {
    if (seen.has(symbol.name)) continue
    seen.add(symbol.name)
    out.push(
      makeOption(
        symbol.name,
        kindToType(symbol.kind),
        `L${symbol.line}`,
        `${rel}:${symbol.line}\n${signature(doc, symbol)}`,
        30,
      ),
    )
  }
  return out
}

function allImportBindings(imports: ParsedImport[]): ImportBinding[] {
  const out: ImportBinding[] = []
  const seen = new Set<string>()
  const add = (spec: string, target: ImportTarget, kind: ImportBinding['kind']) => {
    if (seen.has(target.name)) return
    seen.add(target.name)
    out.push({ spec, target, kind })
  }
  for (const parsed of imports) {
    if (parsed.defaultName) add(parsed.spec, parsed.defaultName, 'default')
    if (parsed.namespace) add(parsed.spec, parsed.namespace, 'namespace')
    for (const target of parsed.names) add(parsed.spec, target, 'named')
  }
  return out
}

function bindingFor(imports: ParsedImport[], local: string): ImportBinding | null {
  return allImportBindings(imports).find((binding) => binding.target.name === local) ?? null
}

function importedSymbol(file: ImportedFile, binding: ImportBinding): OutlineSymbol | null {
  if (binding.kind === 'namespace') return null
  const name = binding.target.original ?? binding.target.name
  const exact = file.outline.symbols.find(
    (symbol) => symbol.name === name && CONTAINER_KINDS.has(symbol.kind),
  )
  if (exact) return exact
  // A default import often renames the declaration; fall back to the file's primary container.
  if (binding.kind === 'default') {
    return file.outline.symbols.find((symbol) => CONTAINER_KINDS.has(symbol.kind)) ?? null
  }
  return null
}

function memberOptions(
  symbol: OutlineSymbol,
  doc: Text,
  sourceRel: string | null = null,
): Completion[] {
  const out: Completion[] = []
  const seen = new Set<string>()
  for (const child of symbol.children) {
    if (child.kind !== 'method' && child.kind !== 'property') continue
    if (seen.has(child.name)) continue
    seen.add(child.name)
    out.push(
      makeOption(
        child.name,
        child.kind,
        `L${child.line}`,
        sourceRel ? `${sourceRel}:${child.line}\n${signature(doc, child)}` : signature(doc, child),
        30,
      ),
    )
  }
  return out
}

function importOptions(
  imports: ParsedImport[],
  root: string,
  fromRel: string,
): Completion[] {
  const out: Completion[] = []
  const seen = new Set<string>()
  for (const binding of allImportBindings(imports)) {
    if (seen.has(binding.target.name)) continue
    seen.add(binding.target.name)

    const targetRel = resolvedSpecs.get(specKey(root, fromRel, binding.spec))
    const entry = targetRel ? cacheEntry(importKey(root, targetRel)) : undefined
    const file = entry?.file ?? null
    const symbol = file ? importedSymbol(file, binding) : null
    const type =
      binding.kind === 'namespace'
        ? 'namespace'
        : symbol
          ? kindToType(symbol.kind)
          : 'variable'
    const info =
      file && symbol
        ? `${targetRel}:${symbol.line}\n${signature(file.doc, symbol)}`
        : undefined
    out.push({
      label: binding.target.name,
      type,
      detail: binding.spec,
      ...(info ? { info } : {}),
      boost: 20,
    })
  }
  return out
}

function addOptions(
  out: Completion[],
  seen: Set<string>,
  options: readonly Completion[] | null | undefined,
  boost = 0,
) {
  if (!options) return
  for (const option of options) {
    if (seen.has(option.label)) continue
    seen.add(option.label)
    out.push(boost && option.boost === undefined ? { ...option, boost } : option)
  }
}

function protectedPosition(context: CompletionContext): boolean {
  let node: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null =
    syntaxTree(context.state).resolveInner(context.pos, -1)
  while (node) {
    const name = node.name.toLowerCase()
    if (
      name.includes('comment') ||
      name.includes('string') ||
      name.includes('template') ||
      name === 'jsxtext'
    ) {
      return true
    }
    node = node.parent
  }
  return false
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
])

function descendantNamed(node: SyntaxNode, name: string, depth: number): SyntaxNode | null {
  if (depth < 0) return null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) return child
    const nested = descendantNamed(child, name, depth - 1)
    if (nested) return nested
  }
  return null
}

/** localCompletionSource omits function parameters, so add the nearest function's ParamList entries. */
function parameterOptions(context: CompletionContext): Completion[] {
  let owner: SyntaxNode | null = syntaxTree(context.state).resolveInner(context.pos, -1)
  while (owner && !FUNCTION_NODES.has(owner.name)) owner = owner.parent
  if (!owner) return []

  const params = descendantNamed(owner, 'ParamList', 2)
  if (!params) return []
  const options: Completion[] = []
  const seen = new Set<string>()
  const visit = (node: SyntaxNode) => {
    if (node.name === 'VariableDefinition') {
      const label = context.state.sliceDoc(node.from, node.to)
      if (label && !seen.has(label)) {
        seen.add(label)
        options.push({ label, type: 'variable', boost: 10 })
      }
      return
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child)
  }
  visit(params)
  return options
}

function jsMemberPath(context: CompletionContext, js: JSCompletion | null): MemberPath | null {
  const fromCompletion = js?.path(context)
  if (fromCompletion) return fromCompletion
  // completionPath does not recognize `this.` (this-expression roots have no VariableName); keep a
  // lexical fallback for that case and for non-JavaScript languages.
  const line = context.state.doc.lineAt(context.pos)
  const before = line.text.slice(0, context.pos - line.from)
  const match = /([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)?$/.exec(before)
  if (!match) return null
  // `a.b.` is a nested path; this first version only expands a single owner.
  if (/\.\s*$/.test(before.slice(0, match.index))) {
    return { path: [match[1], match[2] ?? match[1]], name: match[2] ?? '' }
  }
  return { path: [match[1]], name: match[2] ?? '' }
}

function deepestContainer(
  symbols: OutlineSymbol[],
  line: number,
  accept: (symbol: OutlineSymbol) => boolean,
): OutlineSymbol | null {
  let best: OutlineSymbol | null = null
  let bestDepth = -1
  const visit = (list: OutlineSymbol[], depth: number) => {
    for (const symbol of list) {
      if (symbol.line <= line && line <= symbol.endLine) {
        if (accept(symbol) && depth >= bestDepth) {
          best = symbol
          bestDepth = depth
        }
        visit(symbol.children, depth + 1)
      }
    }
  }
  visit(symbols, 0)
  return best
}

function directContainer(symbols: OutlineSymbol[], name: string): OutlineSymbol | null {
  return (
    symbols.find((symbol) => symbol.name === name && CONTAINER_KINDS.has(symbol.kind)) ?? null
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Heuristic declaration lookup for `const b: Button` / `new Button()` / `function f(): Button`. */
function variableType(doc: Text, name: string): string | null {
  const escaped = escapeRegExp(name)
  const patterns = [
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*:\\s*([A-Za-z_$][\\w$]*)`),
    new RegExp(`\\b(?:const|let|var)\\s+${escaped}\\s*=\\s*new\\s+([A-Za-z_$][\\w$]*)`),
    new RegExp(`\\bfunction\\s+${escaped}\\s*\\([^)]*\\)\\s*:\\s*([A-Za-z_$][\\w$]*)`),
  ]
  const limit = Math.min(doc.lines, 5000)
  for (let number = 1; number <= limit; number += 1) {
    const text = doc.line(number).text
    for (const pattern of patterns) {
      const match = pattern.exec(text)
      if (match) return match[1]
    }
  }
  return null
}

function memberRoot(
  state: EditorState,
  langKey: string,
  symbols: OutlineSymbol[],
  imports: ParsedImport[],
  root: string,
  line: number,
): MemberRoot | null {
  if (root === 'this' || (root === 'self' && (langKey === 'py' || langKey === 'rs'))) {
    const symbol =
      root === 'self' && langKey === 'rs'
        ? deepestContainer(
            symbols,
            line,
            (candidate) => candidate.kind === 'module' && candidate.name.startsWith('impl '),
          )
        : deepestContainer(symbols, line, (candidate) => candidate.kind === 'class')
    return symbol ? { symbol } : null
  }

  const direct = directContainer(symbols, root)
  if (direct) return { symbol: direct }

  const type = variableType(state.doc, root)
  if (type) {
    const typed = directContainer(symbols, type)
    if (typed) return { symbol: typed }
    const imported = bindingFor(imports, type)
    if (imported) return { imported }
  }

  const imported = bindingFor(imports, root)
  return imported ? { imported } : null
}

function specKey(root: string, fromRel: string, spec: string): string {
  return `${root}\0${fromRel}\0${spec}`
}

function importKey(root: string, rel: string): string {
  return `${root}\0${rel}`
}

function cacheEntry(key: string): ImportCacheEntry | undefined {
  const entry = importedCache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at < IMPORT_CACHE_TTL) return entry
  importedCache.delete(key)
  return undefined
}

function putCache(key: string, file: ImportedFile | null) {
  const max = Math.max(1, budget.completionFiles())
  if (!importedCache.has(key) && importedCache.size >= max) {
    const oldest = importedCache.keys().next().value
    if (oldest) importedCache.delete(oldest)
  }
  importedCache.set(key, { at: Date.now(), file })
}

async function loadImportedFile(root: string, rel: string): Promise<ImportedFile | null> {
  const key = importKey(root, rel)
  const cached = cacheEntry(key)
  if (cached) return cached.file

  let file: ImportedFile | null = null
  try {
    const payload = await api.readFile(root, rel)
    const limit = budget.completionFileBytes()
    if (!payload.binary && payload.size <= limit && payload.content.length <= limit) {
      const lang = await loadLanguage(rel)
      if (lang) {
        const state = EditorState.create({ doc: payload.content, extensions: [lang] })
        file = { outline: computeOutline(state, resolveLang(rel)?.key ?? null), doc: state.doc }
      }
    }
  } catch {
    file = null
  }
  putCache(key, file)
  return file
}

function completionResult(
  from: number,
  options: readonly Completion[],
): CompletionResult | null {
  if (options.length === 0) return null
  return { from, options, validFor: /^[\w$]*$/ }
}

/** @internal Exposed for focused tests; public callers use `smartCompletion`. */
export function createSmartCompletionSources(ctx: SmartCompleteContext): {
  main: CompletionSource
  imported: CompletionSource
} {
  const main: CompletionSource = async (context) => {
    const langKey = ctx.langKey()
    if (!supportsSmartCompletion(langKey) || protectedPosition(context)) return null

    const js = langKey && JS_KEYS.has(langKey) ? await loadJSCompletion() : null
    if (context.aborted) return null
    const state = context.state
    const symbols = symbolsForState(state, langKey)
    const imports = ctx.project ? parseImports(state.doc) : []
    const path = jsMemberPath(context, js)

    if (path && path.path.length > 0) {
      if (path.path.length !== 1) return null
      const line = state.doc.lineAt(context.pos).number
      const resolved = memberRoot(
        state,
        langKey ?? '',
        symbols.symbols,
        imports,
        path.path[0],
        line,
      )
      if (!resolved?.symbol) return null
      return completionResult(
        context.pos - path.name.length,
        memberOptions(resolved.symbol, state.doc),
      )
    }

    const token = context.matchBefore(/[A-Za-z_$][\w$]*/)
    if (!context.explicit && !token && !path?.name) return null
    const from = token?.from ?? context.pos - (path?.name.length ?? 0)
    const options: Completion[] = []
    const seen = new Set<string>()

    addOptions(options, seen, topLevelOptions(symbols, state.doc, ctx.rel()))
    if (ctx.project) addOptions(options, seen, importOptions(imports, ctx.root, ctx.rel()))

    if (js) {
      addOptions(options, seen, parameterOptions(context), 10)
      const local = await js.local(context)
      if (context.aborted) return null
      addOptions(options, seen, local?.options, 10)
    }

    const words = await completeAnyWord(context)
    addOptions(options, seen, words?.options)
    return completionResult(from, options)
  }

  const imported: CompletionSource = async (context) => {
    if (!ctx.project) return null
    const langKey = ctx.langKey()
    if (!supportsSmartCompletion(langKey) || protectedPosition(context)) return null

    const js = langKey && JS_KEYS.has(langKey) ? await loadJSCompletion() : null
    if (context.aborted) return null
    const state = context.state
    const path = jsMemberPath(context, js)
    if (!path || path.path.length !== 1) return null

    const symbols = symbolsForState(state, langKey)
    const imports = parseImports(state.doc)
    const line = state.doc.lineAt(context.pos).number
    const resolved = memberRoot(
      state,
      langKey ?? '',
      symbols.symbols,
      imports,
      path.path[0],
      line,
    )
    const binding = resolved?.imported
    if (!binding || binding.kind === 'namespace') return null

    const fromRel = ctx.rel()
    const targetRel = await resolveSpecifier({ root: ctx.root, rel: fromRel }, binding.spec)
    if (!targetRel) return null
    resolvedSpecs.set(specKey(ctx.root, fromRel, binding.spec), targetRel)

    const file = await loadImportedFile(ctx.root, targetRel)
    if (context.aborted || !file) return null
    const symbol = importedSymbol(file, binding)
    if (!symbol) return null
    return completionResult(
      context.pos - path.name.length,
      memberOptions(symbol, file.doc, targetRel),
    )
  }

  return { main, imported }
}

export function smartCompletion(ctx: SmartCompleteContext): Extension {
  const { main, imported } = createSmartCompletionSources(ctx)
  return autocompletion({
    override: [main, imported],
    activateOnTyping: true,
    activateOnTypingDelay: 120,
  })
}
