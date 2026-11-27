export { relativeTime } from '../i18n/format'

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_MS = 30 * DAY_MS
const YEAR_MS = 365 * DAY_MS

/** Compact age for dense lists: 30s, 5min, 2h, 10d, 2m (months), 1y. */
export function compactAge(timestampMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestampMs) || !Number.isFinite(now)) return ''
  const diff = now - timestampMs
  if (diff <= 0) return '0s'
  if (diff < MINUTE_MS) return `${Math.floor(diff / SECOND_MS)}s`
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)}min`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)}h`
  if (diff < MONTH_MS) return `${Math.floor(diff / DAY_MS)}d`
  if (diff < YEAR_MS) return `${Math.floor(diff / MONTH_MS)}m`
  return `${Math.floor(diff / YEAR_MS)}y`
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

const graphemeSegmenter =
  typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * Truncate by user-perceived characters, so an emoji family or a CJK glyph is never split.
 * Falls back to code points where Intl.Segmenter is unavailable.
 */
export function truncateGraphemes(text: string, max: number): string {
  if (max <= 0) return ''
  if (graphemeSegmenter) {
    let out = ''
    let count = 0
    for (const { segment } of graphemeSegmenter.segment(text)) {
      if (count >= max) return `${out}…`
      out += segment
      count += 1
    }
    return text
  }
  const chars = Array.from(text)
  if (chars.length <= max) return text
  return `${chars.slice(0, max).join('')}…`
}

/** Absolute local date/time for tooltips; empty for a missing timestamp */
export function absoluteTime(unixSeconds: number, locale?: string): string {
  if (!unixSeconds) return ''
  const date = new Date(unixSeconds * 1000)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale)
}
