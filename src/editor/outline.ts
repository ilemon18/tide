import type { EditorState } from '@codemirror/state'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { fuzzyMatch } from '../lib/fuzzy'

/** What a row in the structure view represents. The glyph table lives in components/SymbolGlyph. */
export type OutlineKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'type'
  | 'function'
  | 'method'
  | 'property'
  | 'variable'
  | 'module'
  | 'heading'
  | 'rule'
  | 'key'

export type OutlineSymbol = {
  id: string
  name: string
  kind: OutlineKind
  /** 1-based line of the symbol name */
  line: number
  /** 1-based column of the symbol name */
  column: number
  /** Last line of the declaration/body, used to follow the caret */
  endLine: number
  children: OutlineSymbol[]
}

export type OutlineResult = {
  symbols: OutlineSymbol[]
  /** false when the language has no classifier yet (shell, TOML, HTML, …) */
  supported: boolean
  truncated: boolean
}

export type FlatOutlineSymbol = {
  symbol: OutlineSymbol
  depth: number
  /** `Parent/Child` path, used by the filter and by quick open */
  path: string
}

/** Local structural shape of a Lezer node: only what the outline walker needs. */
type SyntaxNode = {
  readonly name: string
  readonly from: number
  readonly to: number
  readonly firstChild: SyntaxNode | null
  readonly nextSibling: SyntaxNode | null
}

type Meta = {
  kind: OutlineKind
  nameNode: SyntaxNode
  /** Override when the node text is not the symbol name (CSS selectors, Markdown headings, …) */
  name?: string
  /** Containers are descended into; everything else stops at the declaration */
  container?: boolean
}

type Classifier = (
  node: SyntaxNode,
  parent: OutlineSymbol | null,
  state: EditorState,
) => Meta | null

/** Keep the sidebar bounded even in generated files. */
const MAX_SYMBOLS = 600
const MAX_NAME = 120
/** Force a full parse only below this size; larger files use whatever Lezer already has. */
const FORCE_PARSE_LIMIT = 512 * 1024
const PARSE_TIMEOUT = 100

const JS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'])
const CSS = new Set(['css', 'scss', 'less'])
const CPP = new Set(['c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh'])
const JSON_LIKE = new Set(['json', 'jsonc'])
const YAML = new Set(['yml', 'yaml'])
const MARKDOWN = new Set(['md', 'markdown'])

const SUPPORTED = new Set<string>([
  ...JS,
  ...CSS,
  ...CPP,
  ...JSON_LIKE,
  ...YAML,
  ...MARKDOWN,
  'py',
  'rs',
  'go',
  'java',
])

function empty(supported: boolean): OutlineResult {
  return { symbols: [], supported, truncated: false }
}

/** Compute the structure of one editor state. Cheap enough to call on tab switch; debounce keystrokes. */
export function computeOutline(state: EditorState, langKey: string | null): OutlineResult {
  if (!langKey || !SUPPORTED.has(langKey)) return empty(false)
  if (MARKDOWN.has(langKey)) {
    return { symbols: markdownOutline(state), supported: true, truncated: false }
  }

  const classify = classifierFor(langKey)
  if (!classify) return empty(false)
  const top = parseTree(state)
  const built = buildTree(state, top, classify, stopFor(langKey))
  return { ...built, supported: true }
}

function parseTree(state: EditorState): SyntaxNode {
  const length = state.doc.length
  // ensureSyntaxTree gives a complete outline in normal files; on very large files it would parse the whole
  // document just to fill a sidebar, so use the incremental tree (possibly viewport-only) instead.
  const forced = length <= FORCE_PARSE_LIMIT ? ensureSyntaxTree(state, length, PARSE_TIMEOUT) : null
  return (forced?.topNode ?? syntaxTree(state).topNode) as unknown as SyntaxNode
}

function buildTree(
  state: EditorState,
  top: SyntaxNode,
  classify: Classifier,
  stop: (node: SyntaxNode, parent: OutlineSymbol | null) => boolean,
): { symbols: OutlineSymbol[]; truncated: boolean } {
  const symbols: OutlineSymbol[] = []
  let count = 0
  let truncated = false

  const visit = (node: SyntaxNode, parent: OutlineSymbol | null) => {
    if (truncated) return
    const meta = classify(node, parent, state)
    let nextParent = parent

    if (meta) {
      const symbol = makeSymbol(state, node, meta)
      if (parent) parent.children.push(symbol)
      else symbols.push(symbol)
      count += 1
      if (count >= MAX_SYMBOLS) {
        truncated = true
        return
      }
      if (!meta.container) return
      nextParent = symbol
    } else if (stop(node, parent)) {
      return
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child, nextParent)
    }
  }

  visit(top, null)
  return { symbols, truncated }
}

function makeSymbol(state: EditorState, node: SyntaxNode, meta: Meta): OutlineSymbol {
  const nameNode = meta.nameNode
  let name = meta.name ?? state.sliceDoc(nameNode.from, nameNode.to)
  name = name.replace(/\s+/g, ' ').trim()
  if (meta.kind === 'key') name = name.replace(/^["']|["']$/g, '')
  const line = state.doc.lineAt(nameNode.from)
  return {
    id: `${meta.kind}:${node.from}`,
    name: limitName(name || '—'),
    kind: meta.kind,
    line: line.number,
    column: nameNode.from - line.from + 1,
    endLine: state.doc.lineAt(node.to).number,
    children: [],
  }
}

function limitName(name: string): string {
  return name.length > MAX_NAME ? `${name.slice(0, MAX_NAME - 1)}…` : name
}

function childNamed(node: SyntaxNode, ...names: string[]): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (names.includes(child.name)) return child
  }
  return null
}

function descendantNamed(
  node: SyntaxNode,
  names: string[],
  maxDepth: number,
): SyntaxNode | null {
  let level: SyntaxNode[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) level.push(child)
  for (let depth = 0; depth < maxDepth && level.length > 0; depth += 1) {
    const next: SyntaxNode[] = []
    for (const candidate of level) {
      if (names.includes(candidate.name)) return candidate
      for (let child = candidate.firstChild; child; child = child.nextSibling) next.push(child)
    }
    level = next
  }
  return null
}

function classifierFor(langKey: string): Classifier | null {
  if (JS.has(langKey)) return jsClassifier
  if (CPP.has(langKey)) return cppClassifier
  if (CSS.has(langKey)) return cssClassifier
  if (JSON_LIKE.has(langKey)) return jsonClassifier
  if (YAML.has(langKey)) return yamlClassifier
  switch (langKey) {
    case 'py':
      return pythonClassifier
    case 'rs':
      return rustClassifier
    case 'go':
      return goClassifier
    case 'java':
      return javaClassifier
    default:
      return null
  }
}

const JS_STOP = new Set([
  'StaticBlock',
  // Unnamed declarations (export default function / class) have no symbol to anchor a subtree; descend into
  // their body and every local would look like a top-level symbol.
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
  'PropertyDeclaration',
  'ClassDeclaration',
  'ObjectExpression',
])

function stopFor(
  langKey: string,
): (node: SyntaxNode, parent: OutlineSymbol | null) => boolean {
  if (JS.has(langKey)) {
    return (node, parent) =>
      // A namespace body is a Block and must be walked; a function / if / for block is not.
      node.name === 'Block' ? parent?.kind !== 'module' : JS_STOP.has(node.name)
  }
  if (CPP.has(langKey)) {
    // Namespace bodies are CompoundStatements and must be walked; a top-level if / loop block is not.
    return (node, parent) =>
      node.name === 'CompoundStatement' ? parent?.kind !== 'module' : false
  }
  if (CSS.has(langKey)) return (node) => node.name === 'Declaration'
  // A JSON array of objects would otherwise list every object's keys as if they were siblings.
  if (JSON_LIKE.has(langKey)) return (node) => node.name === 'Array'
  if (YAML.has(langKey)) {
    return (node) => node.name === 'BlockSequence' || node.name === 'FlowSequence'
  }
  // Java initializer blocks are class-level but their locals are not members.
  if (langKey === 'java') return (node) => node.name === 'StaticInitializer' || node.name === 'Block'
  return () => false
}

// ---------------------------------------------------------------- JavaScript / TypeScript

const jsClassifier: Classifier = (node) => {
  switch (node.name) {
    case 'ClassDeclaration': {
      const name = childNamed(node, 'VariableDefinition')
      return name ? { kind: 'class', nameNode: name, container: true } : null
    }
    case 'InterfaceDeclaration': {
      const name = childNamed(node, 'TypeDefinition')
      return name ? { kind: 'interface', nameNode: name, container: true } : null
    }
    case 'EnumDeclaration': {
      const name = childNamed(node, 'TypeDefinition')
      return name ? { kind: 'enum', nameNode: name, container: true } : null
    }
    case 'TypeAliasDeclaration': {
      const name = childNamed(node, 'TypeDefinition')
      return name ? { kind: 'type', nameNode: name } : null
    }
    case 'FunctionDeclaration': {
      const name = childNamed(node, 'VariableDefinition')
      return name ? { kind: 'function', nameNode: name } : null
    }
    case 'MethodDeclaration': {
      const name = childNamed(node, 'PropertyDefinition')
      return name ? { kind: 'method', nameNode: name } : null
    }
    case 'PropertyDeclaration': {
      const name = childNamed(node, 'PropertyDefinition')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'PropertyType': {
      const name = childNamed(node, 'PropertyDefinition')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'MethodType': {
      const name = childNamed(node, 'PropertyDefinition')
      return name ? { kind: 'method', nameNode: name } : null
    }
    // Enum members. No other reached node uses PropertyName: classes stop at PropertyDeclaration /
    // MethodDeclaration, interfaces stop at PropertyType / MethodType, object literals stop at their variable.
    case 'PropertyName':
      return { kind: 'property', nameNode: node }
    case 'NamespaceDeclaration':
    case 'ModuleDeclaration': {
      const name = childNamed(node, 'VariableDefinition', 'TypeDefinition', 'PropertyDefinition')
      return name ? { kind: 'module', nameNode: name, container: true } : null
    }
    case 'VariableDeclaration': {
      const name = childNamed(node, 'VariableDefinition')
      if (!name) return null
      const callable = descendantNamed(node, ['ArrowFunction', 'FunctionExpression'], 2)
      const klass = descendantNamed(node, ['ClassExpression'], 2)
      return {
        kind: klass ? 'class' : callable ? 'function' : 'variable',
        nameNode: name,
        container: Boolean(klass),
      }
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------- Python

const pythonClassifier: Classifier = (node, parent) => {
  if (node.name === 'ClassDefinition') {
    const name = childNamed(node, 'VariableName')
    return name ? { kind: 'class', nameNode: name, container: true } : null
  }
  if (node.name === 'FunctionDefinition') {
    const name = childNamed(node, 'VariableName')
    if (!name) return null
    return { kind: parent?.kind === 'class' ? 'method' : 'function', nameNode: name }
  }
  return null
}

// ---------------------------------------------------------------- Rust

const rustClassifier: Classifier = (node, parent, state) => {
  switch (node.name) {
    case 'FunctionItem': {
      const name = childNamed(node, 'BoundIdentifier')
      if (!name) return null
      const method =
        parent?.kind === 'class' ||
        parent?.kind === 'trait' ||
        (parent?.kind === 'module' && parent.name.startsWith('impl '))
      return { kind: method ? 'method' : 'function', nameNode: name }
    }
    case 'StructItem': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'struct', nameNode: name, container: true } : null
    }
    case 'EnumItem': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'enum', nameNode: name, container: true } : null
    }
    case 'EnumVariant': {
      const name = childNamed(node, 'Identifier')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'TraitItem': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'trait', nameNode: name, container: true } : null
    }
    case 'ImplItem': {
      const target = rustImplTarget(node)
      if (!target) return null
      return {
        kind: 'module',
        nameNode: target,
        name: `impl ${state.sliceDoc(target.from, target.to)}`,
        container: true,
      }
    }
    case 'ModItem': {
      const name = childNamed(node, 'BoundIdentifier')
      return name ? { kind: 'module', nameNode: name, container: true } : null
    }
    case 'ConstItem':
    case 'StaticItem': {
      const name = childNamed(node, 'BoundIdentifier')
      return name ? { kind: 'variable', nameNode: name } : null
    }
    case 'TypeItem': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'type', nameNode: name } : null
    }
    case 'MacroDefinition': {
      const name = childNamed(node, 'Identifier')
      return name ? { kind: 'function', nameNode: name } : null
    }
    case 'FieldDeclaration': {
      const name = childNamed(node, 'FieldIdentifier')
      return name ? { kind: 'property', nameNode: name } : null
    }
    default:
      return null
  }
}

/** `impl Foo` / `impl Trait for Foo`: prefer the type after `for`, else the first type. */
function rustImplTarget(node: SyntaxNode): SyntaxNode | null {
  let afterFor = false
  let first: SyntaxNode | null = null
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'for') {
      afterFor = true
      continue
    }
    if (child.name === 'TypeIdentifier' || child.name === 'GenericType') {
      if (afterFor) return child
      if (!first) first = child
    }
  }
  return first
}

// ---------------------------------------------------------------- Go

const goClassifier: Classifier = (node) => {
  switch (node.name) {
    case 'FunctionDecl': {
      const name = childNamed(node, 'DefName')
      return name ? { kind: 'function', nameNode: name } : null
    }
    case 'MethodDecl': {
      // The receiver also has a DefName, so the method name is the direct FieldName.
      const name = childNamed(node, 'FieldName')
      return name ? { kind: 'method', nameNode: name } : null
    }
    case 'TypeSpec': {
      const name = childNamed(node, 'DefName')
      if (!name) return null
      if (childNamed(node, 'StructType')) return { kind: 'struct', nameNode: name, container: true }
      if (childNamed(node, 'InterfaceType')) {
        return { kind: 'interface', nameNode: name, container: true }
      }
      return { kind: 'type', nameNode: name }
    }
    case 'FieldDecl': {
      const name = childNamed(node, 'FieldName')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'MethodElem': {
      const name = childNamed(node, 'FieldName')
      return name ? { kind: 'method', nameNode: name } : null
    }
    case 'ConstSpec':
    case 'VarSpec': {
      const name = childNamed(node, 'DefName')
      return name ? { kind: 'variable', nameNode: name } : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------- Java

const javaClassifier: Classifier = (node) => {
  switch (node.name) {
    case 'ClassDeclaration':
    case 'RecordDeclaration': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'class', nameNode: name, container: true } : null
    }
    case 'InterfaceDeclaration': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'interface', nameNode: name, container: true } : null
    }
    case 'AnnotationTypeDeclaration': {
      const name = childNamed(node, 'Identifier')
      return name ? { kind: 'interface', nameNode: name, container: true } : null
    }
    case 'EnumDeclaration': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'enum', nameNode: name, container: true } : null
    }
    case 'MethodDeclaration':
    case 'ConstructorDeclaration': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'method', nameNode: name } : null
    }
    case 'AnnotationTypeElementDeclaration': {
      const name = childNamed(node, 'Identifier')
      return name ? { kind: 'method', nameNode: name } : null
    }
    case 'VariableDeclarator': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'RecordComponent': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'EnumConstant': {
      const name = childNamed(node, 'Definition')
      return name ? { kind: 'property', nameNode: name } : null
    }
    default:
      return null
  }
}

// ---------------------------------------------------------------- C / C++

const cppClassifier: Classifier = (node, parent, state) => {
  switch (node.name) {
    case 'NamespaceDefinition': {
      // Nested namespaces (`namespace A::B`) have one Identifier per segment.
      const parts: SyntaxNode[] = []
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === 'Identifier') parts.push(child)
      }
      if (parts.length === 0) return null
      return {
        kind: 'module',
        nameNode: parts[0],
        name: parts.map((part) => state.sliceDoc(part.from, part.to)).join('::'),
        container: true,
      }
    }
    case 'ClassSpecifier': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'class', nameNode: name, container: true } : null
    }
    case 'StructSpecifier': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'struct', nameNode: name, container: true } : null
    }
    case 'EnumSpecifier': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'enum', nameNode: name, container: true } : null
    }
    case 'Enumerator': {
      const name = childNamed(node, 'Identifier')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'FunctionDefinition': {
      const name = cppDeclaratorName(childNamed(node, 'FunctionDeclarator'), state)
      if (!name) return null
      return {
        ...name,
        kind: parent?.kind === 'class' || parent?.kind === 'struct' ? 'method' : 'function',
      }
    }
    case 'FieldDeclaration': {
      const declarator = childNamed(node, 'FunctionDeclarator')
      if (declarator) {
        const name = cppDeclaratorName(declarator, state)
        return name ? { ...name, kind: 'method' } : null
      }
      const name = childNamed(node, 'FieldIdentifier')
      return name ? { kind: 'property', nameNode: name } : null
    }
    case 'Declaration': {
      const declarator = childNamed(node, 'FunctionDeclarator')
      if (declarator) {
        const name = cppDeclaratorName(declarator, state)
        if (!name) return null
        return {
          ...name,
          kind: parent?.kind === 'class' || parent?.kind === 'struct' ? 'method' : 'function',
        }
      }
      const name = childNamed(node, 'Identifier')
      if (!name) return null
      return {
        kind: parent?.kind === 'class' || parent?.kind === 'struct' ? 'property' : 'variable',
        nameNode: name,
      }
    }
    case 'TypeDefinition':
    case 'AliasDeclaration': {
      const name = childNamed(node, 'TypeIdentifier')
      return name ? { kind: 'type', nameNode: name } : null
    }
    default:
      return null
  }
}

function cppDeclaratorName(
  declarator: SyntaxNode | null,
  state: EditorState,
): { nameNode: SyntaxNode; name?: string } | null {
  if (!declarator) return null
  const named = descendantNamed(declarator, ['Identifier', 'FieldIdentifier', 'DestructorName'], 2)
  if (named) return { nameNode: named }
  // operator overloads have no Identifier: use the declarator text before the parameter list
  const text = state.sliceDoc(declarator.from, declarator.to)
  const cut = text.indexOf('(')
  const fallback = (cut >= 0 ? text.slice(0, cut) : text).trim()
  return fallback ? { nameNode: declarator, name: fallback } : null
}

// ---------------------------------------------------------------- CSS / SCSS / Less

const cssClassifier: Classifier = (node, _parent, state) => {
  if (node.name === 'RuleSet') {
    const block = childNamed(node, 'Block')
    const name = state.sliceDoc(node.from, block ? block.from : node.to).trim()
    return name ? { kind: 'rule', nameNode: node, name, container: true } : null
  }
  if (node.name.endsWith('Statement')) {
    const block = childNamed(node, 'Block')
    if (!block) return null
    const name = state.sliceDoc(node.from, block.from).trim()
    return name ? { kind: 'module', nameNode: node, name, container: true } : null
  }
  return null
}

// ---------------------------------------------------------------- JSON / YAML

const jsonClassifier: Classifier = (node) => {
  if (node.name !== 'Property') return null
  const name = childNamed(node, 'PropertyName')
  if (!name) return null
  return { kind: 'key', nameNode: name, container: Boolean(childNamed(node, 'Object')) }
}

const yamlClassifier: Classifier = (node) => {
  if (node.name !== 'Pair') return null
  const name = childNamed(node, 'Key')
  if (!name) return null
  return { kind: 'key', nameNode: name, container: Boolean(childNamed(node, 'BlockMapping')) }
}

// ---------------------------------------------------------------- Markdown

function markdownOutline(state: EditorState): OutlineSymbol[] {
  const root: OutlineSymbol[] = []
  const stack: { level: number; symbol: OutlineSymbol }[] = []
  const top = parseTree(state)

  for (let node = top.firstChild; node; node = node.nextSibling) {
    const level = headingLevel(node.name)
    if (!level) continue
    const name = headingText(state.sliceDoc(node.from, node.to))
    if (!name) continue
    const line = state.doc.lineAt(node.from)
    const symbol: OutlineSymbol = {
      id: `heading:${node.from}`,
      name: limitName(name),
      kind: 'heading',
      line: line.number,
      column: 1,
      endLine: state.doc.lineAt(node.to).number,
      children: [],
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop()
    const parent = stack[stack.length - 1]?.symbol
    if (parent) parent.children.push(symbol)
    else root.push(symbol)
    stack.push({ level, symbol })
  }
  return root
}

function headingLevel(name: string): number | null {
  const match = /^(?:ATX|Setext)Heading([1-6])$/.exec(name)
  return match ? Number(match[1]) : null
}

function headingText(text: string): string {
  const first = text.split('\n')[0] ?? ''
  return first.replace(/^#{1,6}\s*/, '').replace(/\s*#+\s*$/, '').trim()
}

// ---------------------------------------------------------------- Flattening helpers

export function flattenOutline(
  symbols: OutlineSymbol[],
  depth = 0,
  parentPath = '',
): FlatOutlineSymbol[] {
  const rows: FlatOutlineSymbol[] = []
  for (const symbol of symbols) {
    const path = parentPath ? `${parentPath}/${symbol.name}` : symbol.name
    rows.push({ symbol, depth, path })
    if (symbol.children.length > 0) {
      rows.push(...flattenOutline(symbol.children, depth + 1, path))
    }
  }
  return rows
}

export function flattenVisible(
  symbols: OutlineSymbol[],
  collapsed: ReadonlySet<string>,
  depth = 0,
  parentPath = '',
): FlatOutlineSymbol[] {
  const rows: FlatOutlineSymbol[] = []
  for (const symbol of symbols) {
    const path = parentPath ? `${parentPath}/${symbol.name}` : symbol.name
    rows.push({ symbol, depth, path })
    // Collapse by path, not by node offset: typing above a declaration shifts every offset and would
    // otherwise reopen the whole tree after one keystroke.
    if (!collapsed.has(path) && symbol.children.length > 0) {
      rows.push(...flattenVisible(symbol.children, collapsed, depth + 1, path))
    }
  }
  return rows
}

/** Filtered tree: keep matching symbols and their ancestors, so the hierarchy stays readable. */
export function filterOutline(symbols: OutlineSymbol[], query: string): FlatOutlineSymbol[] {
  const matched = new Set<string>()
  for (const row of flattenOutline(symbols)) {
    if (fuzzyMatch(query, { path: row.path, name: row.symbol.name })) matched.add(row.symbol.id)
  }

  const rows: FlatOutlineSymbol[] = []
  const walk = (
    list: OutlineSymbol[],
    depth: number,
    parentPath: string,
    target: FlatOutlineSymbol[],
  ): boolean => {
    let any = false
    for (const symbol of list) {
      const path = parentPath ? `${parentPath}/${symbol.name}` : symbol.name
      const children: FlatOutlineSymbol[] = []
      const childMatched = walk(symbol.children, depth + 1, path, children)
      if (matched.has(symbol.id) || childMatched) {
        target.push({ symbol, depth, path })
        target.push(...children)
        any = true
      }
    }
    return any
  }
  walk(symbols, 0, '', rows)
  return rows
}

/** Deepest symbol whose declaration contains the 1-based line. */
export function deepestAt(symbols: OutlineSymbol[], line: number): string | null {
  let bestId: string | null = null
  let bestLine = -Infinity
  const walk = (list: OutlineSymbol[]) => {
    for (const symbol of list) {
      if (symbol.line <= line && line <= symbol.endLine) {
        if (symbol.line >= bestLine) {
          bestLine = symbol.line
          bestId = symbol.id
        }
        walk(symbol.children)
      }
    }
  }
  walk(symbols)
  return bestId
}
