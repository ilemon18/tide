import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { rust } from '@codemirror/lang-rust'
import { EditorState, type Extension } from '@codemirror/state'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { pathInfo, readFile } = vi.hoisted(() => ({
  pathInfo: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock('../lib/ipc', () => ({
  api: { pathInfo, readFile },
}))

import { clearImportCache } from './importLinks'
import {
  clearCompletionCache,
  createSmartCompletionSources,
  type SmartCompleteContext,
} from './smartComplete'

const ROOT = '/repo'
const REL = 'src/App.tsx'

function context(overrides: Partial<SmartCompleteContext> = {}): SmartCompleteContext {
  return {
    root: ROOT,
    rel: () => REL,
    langKey: () => 'tsx',
    project: true,
    ...overrides,
  }
}

function stateOf(doc: string, lang: Extension): EditorState {
  return EditorState.create({ doc, extensions: [lang] })
}

async function run(
  source: (context: CompletionContext) => CompletionResult | null | Promise<CompletionResult | null>,
  state: EditorState,
  pos = state.doc.length,
  explicit = false,
): Promise<CompletionResult | null> {
  return source(new CompletionContext(state, pos, explicit))
}

afterEach(() => {
  vi.restoreAllMocks()
})

beforeEach(() => {
  clearCompletionCache()
  clearImportCache()
  pathInfo.mockReset()
  readFile.mockReset()
})

it('lists top-level symbols with their lines', async () => {
  const doc = ['class Button {', '  internalMethod() {}', '}', 'const useTabs = () => {}', '', 'useT'].join(
    '\n',
  )
  const sources = createSmartCompletionSources(context())
  const result = await run(sources.main, stateOf(doc, javascript({ typescript: true, jsx: true })))

  const useTabs = result?.options.find((option) => option.label === 'useTabs')
  expect(useTabs?.detail).toBe('L4')
  expect(String(useTabs?.info)).toContain('const useTabs')
  expect(result?.options.filter((option) => option.label === 'useTabs')).toHaveLength(1)
})

it('offers an imported component in a JSX tag', async () => {
  const doc = ["import Button from './Button'", '', '<But'].join('\n')
  const sources = createSmartCompletionSources(context())
  const result = await run(sources.main, stateOf(doc, javascript({ typescript: true, jsx: true })))

  const button = result?.options.find((option) => option.label === 'Button')
  expect(button?.detail).toBe('./Button')
})

it('resolves a typed local object to its class members', async () => {
  const doc = [
    'class Button {',
    '  save() {}',
    "  label = ''",
    '}',
    'const b: Button = new Button()',
    'b.',
  ].join('\n')
  const sources = createSmartCompletionSources(context())
  const state = stateOf(doc, javascript({ typescript: true }))
  const result = await run(sources.main, state)

  expect(result?.options.map((option) => [option.label, option.type, option.detail])).toEqual([
    ['save', 'method', 'L2'],
    ['label', 'property', 'L3'],
  ])
})

it('adds JavaScript function parameters from the local scope', async () => {
  const doc = ['function use(button: Button) {', '  but', '}'].join('\n')
  const sources = createSmartCompletionSources(context({ langKey: () => 'ts' }))
  const state = stateOf(doc, javascript({ typescript: true }))
  const pos = doc.indexOf('but') + 'but'.length
  const result = await run(sources.main, state, pos)

  const parameter = result?.options.find((option) => option.label === 'button')
  expect(parameter?.type).toBe('variable')
})

it('adds block-local variables from the language scope', async () => {
  const doc = ['function use() {', '  const button = 1', '  but', '}'].join('\n')
  const sources = createSmartCompletionSources(context({ langKey: () => 'ts' }))
  const state = stateOf(doc, javascript({ typescript: true }))
  const pos = doc.lastIndexOf('but') + 'but'.length
  const result = await run(sources.main, state, pos)

  const local = result?.options.find((option) => option.label === 'button')
  expect(local?.type).toBe('variable')
})

it('resolves this. to the deepest class', async () => {
  const doc = ['class Button {', '  save() {}', '  open() {', '    this.', '  }', '}'].join('\n')
  const sources = createSmartCompletionSources(context())
  const state = stateOf(doc, javascript({ typescript: true }))
  const pos = doc.indexOf('this.') + 'this.'.length
  const result = await run(sources.main, state, pos)

  expect(result?.options.some((option) => option.label === 'save')).toBe(true)
})

it('resolves Python self. to the enclosing class', async () => {
  const doc = ['class Button:', '  def save(self):', '    self.'].join('\n')
  const sources = createSmartCompletionSources(
    context({ rel: () => 'src/button.py', langKey: () => 'py' }),
  )
  const state = stateOf(doc, python())
  const pos = doc.indexOf('self.') + 'self.'.length
  const result = await run(sources.main, state, pos)

  expect(result?.options.map((option) => option.label)).toEqual(['save'])
})

it('resolves Rust self. inside an impl block', async () => {
  const doc = ['struct Button;', 'impl Button {', '  fn save(&self) {', '    self.', '  }', '}'].join(
    '\n',
  )
  const sources = createSmartCompletionSources(
    context({ rel: () => 'src/button.rs', langKey: () => 'rs' }),
  )
  const state = stateOf(doc, rust())
  const pos = doc.indexOf('self.') + 'self.'.length
  const result = await run(sources.main, state, pos)

  expect(result?.options.map((option) => option.label)).toEqual(['save'])
})

it('resolves aliased imports and caches target files', async () => {
  let now = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const doc = [
    "import { Card as C } from './ui'",
    'const b = new C()',
    'b.',
  ].join('\n')
  const target = ['export class Card {', '  render() {}', '}'].join('\n')
  pathInfo.mockImplementation(async (path: string) => ({
    isDir: false,
    isFile: path === `${ROOT}/src/ui.ts`,
    name: 'ui.ts',
  }))
  readFile.mockResolvedValue({ content: target, size: target.length, mtime: 0, binary: false })

  const sources = createSmartCompletionSources(context())
  const state = stateOf(doc, javascript({ typescript: true }))
  const result = await run(sources.imported, state)

  const render = result?.options.find((option) => option.label === 'render')
  expect(render?.detail).toBe('L2')
  expect(String(render?.info)).toContain('src/ui.ts:2')
  expect(readFile).toHaveBeenCalledTimes(1)

  now += 61_000
  await run(sources.imported, state)
  expect(readFile).toHaveBeenCalledTimes(2)
})

it('skips imported files above the completion size limit', async () => {
  const doc = ["import { Card } from './card'", 'const b = new Card()', 'b.'].join('\n')
  const huge = 'x'.repeat(256 * 1024 + 1)
  pathInfo.mockImplementation(async (path: string) => ({
    isDir: false,
    isFile: path === `${ROOT}/src/card.ts`,
    name: 'card.ts',
  }))
  readFile.mockResolvedValue({ content: huge, size: huge.length, mtime: 0, binary: false })

  const sources = createSmartCompletionSources(context())
  const state = stateOf(doc, javascript({ typescript: true }))
  expect(await run(sources.imported, state)).toBeNull()
  expect(await run(sources.imported, state)).toBeNull()
  expect(readFile).toHaveBeenCalledTimes(1)
})

it('does not complete inside comments or strings', async () => {
  const doc = 'const text = "Button"\nconst comment = /* Button */ 1'
  const sources = createSmartCompletionSources(context())
  const state = stateOf(doc, javascript({ typescript: true }))
  const stringPos = doc.indexOf('Button') + 2
  const commentPos = doc.lastIndexOf('Button') + 2

  expect(await run(sources.main, state, stringPos, true)).toBeNull()
  expect(await run(sources.main, state, commentPos, true)).toBeNull()
})

it('does not complete inside Python strings', async () => {
  const doc = 'text = "Button"'
  const sources = createSmartCompletionSources(
    context({ rel: () => 'src/button.py', langKey: () => 'py' }),
  )
  const state = stateOf(doc, python())
  expect(await run(sources.main, state, doc.indexOf('Button') + 2, true)).toBeNull()
})

it('deduplicates labels between document symbols and imports', async () => {
  const doc = ["import { Button } from './Button'", 'class Button { save() {} }', 'But'].join('\n')
  const sources = createSmartCompletionSources(context())
  const result = await run(sources.main, stateOf(doc, javascript({ typescript: true })))

  expect(result?.options.filter((option) => option.label === 'Button')).toHaveLength(1)
})
