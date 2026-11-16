export { relativeTime } from '../i18n/format'

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}