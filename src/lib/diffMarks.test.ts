import { expect, it } from 'vitest'
import { parseDiffMarks } from './diffMarks'

it('maps added lines to new-side editor line numbers', () => {
  const patch = ['@@ -1,3 +1,4 @@', ' context', '+new', ' context', ' context'].join('\n')
  expect(parseDiffMarks(patch)).toEqual({
    marks: [{ from: 2, to: 2, kind: 'add' }],
    lines: 4,
  })
})

it('turns a removed and added group into one modified block', () => {
  const patch = ['@@ -1,2 +1,2 @@', '-old', '+new'].join('\n')
  expect(parseDiffMarks(patch)).toEqual({
    marks: [{ from: 1, to: 1, kind: 'mod' }],
    lines: 1,
  })
})

it('places a pure deletion on the following new-side line and clamps at the end', () => {
  const patch = ['@@ -2 +1,0 @@', '-gone'].join('\n')
  expect(parseDiffMarks(patch)).toEqual({
    marks: [{ from: 1, to: 1, kind: 'del' }],
    lines: 0,
  })
})

it('covers multi-line additions and ignores no-newline markers', () => {
  const patch = ['@@ -0,0 +1,3 @@', '+a', '+b', '+c', '\\ No newline at end of file'].join('\n')
  expect(parseDiffMarks(patch)).toEqual({
    marks: [{ from: 1, to: 3, kind: 'add' }],
    lines: 3,
  })
})

it('resets line offsets at each hunk', () => {
  const patch = [
    '@@ -1,2 +1,2 @@',
    ' one',
    '+two',
    '@@ -10,2 +11,2 @@',
    ' ten',
    '+eleven',
  ].join('\n')
  expect(parseDiffMarks(patch).marks).toEqual([
    { from: 2, to: 2, kind: 'add' },
    { from: 12, to: 12, kind: 'add' },
  ])
})

it('returns no marks for an empty patch', () => {
  expect(parseDiffMarks('')).toEqual({ marks: [], lines: 0 })
})
