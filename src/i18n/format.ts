import { currentLocale, t } from './index'

/**
 * Locale-aware formatting. Numbers and relative times go through `Intl`: per-locale wording
 * (1 minute ago / hace 2 días) differs far more than a hand-written template can cover.
 */
const relativeFormatters = new Map<string, Intl.RelativeTimeFormat>()

function relativeFormatter(): Intl.RelativeTimeFormat {
  const locale = currentLocale()
  let formatter = relativeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
    relativeFormatters.set(locale, formatter)
  }
  return formatter
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 86400 * 365],
  ['month', 86400 * 30],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

/** unix seconds → "3 days ago" in the current locale */
export function relativeTime(unixSeconds: number): string {
  if (!unixSeconds) return ''
  const diff = Date.now() / 1000 - unixSeconds
  if (diff < 60) return t('time.justNow')
  for (const [unit, seconds] of UNITS) {
    if (diff >= seconds || unit === 'minute') {
      return relativeFormatter().format(-Math.floor(diff / seconds), unit)
    }
  }
  return t('time.justNow')
}

/** Digit grouping etc.: left to Intl instead of hand-written separators per locale */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(currentLocale()).format(value)
}