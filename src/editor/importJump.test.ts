import { Text } from '@codemirror/state'
import { expect, it } from 'vitest'
import { identifierAt, importTargetAt } from './importJump'

function docOf(source: string): Text {
  return Text.of(source.split('\n'))
}

function at(source: string, needle: string, occurrence: 'first' | 'last' = 'last') {
  const index = occurrence === 'first' ? source.indexOf(needle) : source.lastIndexOf(needle)
  if (index < 0) throw new Error(`missing ${needle}`)
  return { index, line: source.slice(0, index).split('\n').length }
}

it('resolves a named import to the binding line', () => {
  const source = "import { useTabs } from '../store/tabs'\nuseTabs()"
  const doc = docOf(source)
  const { index, line } = at(source, 'useTabs')
  const target = importTargetAt(doc, index)
  expect(target).not.toBeNull()
  expect(target!.name).toBe('useTabs')
  expect(doc.lineAt(target!.from).number).toBe(1)
  expect(doc.sliceString(target!.from, target!.to)).toBe('useTabs')
  expect(line).toBe(2)
})

it('handles multi-line named imports, aliases and inline type specifiers', () => {
  const source = [
    "import Default, {",
    '  plain,',
    '  type Kind,',
    '  original as local,',
    "} from './mod'",
    'local()',
  ].join('\n')
  const doc = docOf(source)
  for (const [needle, expectedLine, expectedName] of [
    ['local', 4, 'local'],
    ['Kind', 3, 'Kind'],
    ['plain', 2, 'plain'],
    ['Default', 1, 'Default'],
  ] as const) {
    // The last occurrence is the call for `local`; target the import occurrence explicitly.
    const importIndex = source.indexOf(needle)
    const target = importTargetAt(doc, importIndex)
    expect(target, needle).not.toBeNull()
    expect(target!.name).toBe(expectedName)
    expect(doc.lineAt(target!.from).number).toBe(expectedLine)
  }
})

it('resolves namespace and default imports, and member chains to their root', () => {
  const source = "import * as api from './api'\napi.method()"
  const doc = docOf(source)
  const target = importTargetAt(doc, at(source, 'method').index)
  expect(target?.name).toBe('api')

  const defaultSource = "import Foo from './foo'\nnew Foo()"
  const defaultDoc = docOf(defaultSource)
  expect(importTargetAt(defaultDoc, at(defaultSource, 'Foo').index)?.name).toBe('Foo')
})

it('returns null for symbols that are not imported and for re-exports', () => {
  const local = 'const value = 1\nvalue'
  expect(importTargetAt(docOf(local), at(local, 'value').index)).toBeNull()

  const reexport = "export { useTabs } from './tabs'\nuseTabs()"
  expect(importTargetAt(docOf(reexport), at(reexport, 'useTabs', 'first').index)).toBeNull()
})

it('ignores matches inside strings and comments', () => {
  const source = "import { value } from './mod'\nconst text = \"value\"\n// value"
  const doc = docOf(source)
  expect(importTargetAt(doc, at(source, '"value"').index + 1)).toBeNull()
  expect(importTargetAt(doc, at(source, '// value').index + 3)).toBeNull()
})

it('identifierAt returns the root of a member chain', () => {
  const source = 'api.method.other'
  const doc = docOf(source)
  const ident = identifierAt(doc, source.indexOf('other'))
  expect(ident?.name).toBe('api')
  expect(doc.sliceString(ident!.from, ident!.to)).toBe('api')
})
