import { Text } from '@codemirror/state'
import { expect, it } from 'vitest'
import { buildDiffGutterRanges } from './diffGutter'

function collect(ranges: ReturnType<typeof buildDiffGutterRanges>) {
  const out: { from: number; kind: string }[] = []
  for (const iter = ranges.iter(); iter.value; iter.next()) {
    out.push({ from: iter.from, kind: (iter.value as unknown as { kind: string }).kind })
  }
  return out
}

it('draws one marker per changed line', () => {
  const doc = Text.of(['a', 'b', 'c', 'd'])
  const ranges = buildDiffGutterRanges(doc, [{ from: 1, to: 2, kind: 'add' }])
  const lineStarts = [0, 2, 4, 6]
  expect(collect(ranges)).toEqual([
    { from: lineStarts[0], kind: 'add' },
    { from: lineStarts[1], kind: 'add' },
  ])
})

it('clamps out-of-range marks to the last line', () => {
  const doc = Text.of(['a', 'b', 'c'])
  const ranges = buildDiffGutterRanges(doc, [{ from: 99, to: 120, kind: 'del' }])
  expect(collect(ranges)).toEqual([{ from: 4, kind: 'del' }])
})

it('draws overlapping marks only once, first kind wins', () => {
  const doc = Text.of(['a', 'b', 'c'])
  const ranges = buildDiffGutterRanges(doc, [
    { from: 2, to: 2, kind: 'mod' },
    { from: 2, to: 3, kind: 'add' },
  ])
  expect(collect(ranges)).toEqual([
    { from: 2, kind: 'mod' },
    { from: 4, kind: 'add' },
  ])
})

it('returns an empty set for no marks', () => {
  const ranges = buildDiffGutterRanges(Text.of(['a']), [])
  expect(ranges.size).toBe(0)
})
