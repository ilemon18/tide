import { expect, it } from 'vitest'
import { monoStack, terminalStack, normalizedFontWeight } from './fonts'

it('retains the existing Fira choice and system fallbacks for new font ids', () => {
  expect(monoStack('fira')).toMatch(/^'Fira Code',/)
  expect(monoStack('consolas')).toMatch(/^'Consolas',/)
  expect(monoStack('smiley-sans')).toMatch(/^'Smiley Sans',/)
  expect(monoStack('consolas')).toContain('ui-monospace')
  expect(monoStack('smiley-sans')).toContain('Hiragino Sans')
})

it.each([100, 400, 700, 900])('keeps valid CSS weight %s', weight => {
  expect(normalizedFontWeight(weight)).toBe(weight)
})
it.each([0, 350, 900.5, 1000, NaN, '700', null])('defaults invalid CSS weight %s', weight => {
  expect(normalizedFontWeight(weight)).toBe(400)
})

it('uses intrinsic terminal oblique families without changing code fonts', () => {
  expect(terminalStack('jetbrains', false)).toBe(monoStack('jetbrains'))
  expect(terminalStack('fira', true)).toMatch(/^'Tide Terminal Oblique B'/)
  expect(terminalStack('consolas', true)).toContain('Tide Terminal Consolas Oblique')
  expect(terminalStack('smiley-sans', true)).toBe(monoStack('smiley-sans'))
  expect(terminalStack('unknown', true)).toContain('Tide Terminal Oblique A')
})
