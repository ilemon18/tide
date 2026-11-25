import { describe, expect, it } from 'vitest'
import { compactAge } from './format'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => NOW - ms

describe('compactAge', () => {
  it('uses seconds, minutes and hours below one day', () => {
    expect(compactAge(ago(0), NOW)).toBe('0s')
    expect(compactAge(ago(30 * SEC), NOW)).toBe('30s')
    expect(compactAge(ago(59 * SEC + 999), NOW)).toBe('59s')
    expect(compactAge(ago(MIN), NOW)).toBe('1min')
    expect(compactAge(ago(5 * MIN), NOW)).toBe('5min')
    expect(compactAge(ago(HOUR - 1), NOW)).toBe('59min')
    expect(compactAge(ago(HOUR), NOW)).toBe('1h')
    expect(compactAge(ago(2 * HOUR), NOW)).toBe('2h')
    expect(compactAge(ago(DAY - 1), NOW)).toBe('23h')
  })

  it('uses days, months and years at their boundaries', () => {
    expect(compactAge(ago(DAY), NOW)).toBe('1d')
    expect(compactAge(ago(2 * DAY), NOW)).toBe('2d')
    expect(compactAge(ago(10 * DAY), NOW)).toBe('10d')
    expect(compactAge(ago(30 * DAY - 1), NOW)).toBe('29d')
    expect(compactAge(ago(30 * DAY), NOW)).toBe('1m')
    expect(compactAge(ago(60 * DAY), NOW)).toBe('2m')
    expect(compactAge(ago(365 * DAY - 1), NOW)).toBe('12m')
    expect(compactAge(ago(365 * DAY), NOW)).toBe('1y')
    expect(compactAge(ago(800 * DAY), NOW)).toBe('2y')
  })

  it('clamps future times and rejects invalid timestamps', () => {
    expect(compactAge(ago(-MIN), NOW)).toBe('0s')
    expect(compactAge(Number.NaN, NOW)).toBe('')
    expect(compactAge(Number.POSITIVE_INFINITY, NOW)).toBe('')
    expect(compactAge(ago(MIN), Number.NaN)).toBe('')
  })
})
