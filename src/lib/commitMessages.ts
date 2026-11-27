import limits from './commitMessageLimits.json'
export const COMMIT_MESSAGE_LIMITS = limits
export function normalizeCommitTemplates(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const encoder = new TextEncoder()
  for (const item of value) {
    if (result.length >= limits.templates) break
    if (typeof item !== 'string') continue
    const message = item.trim()
    if (
      message &&
      encoder.encode(message).length <= limits.messageBytes &&
      !result.includes(message)
    )
      result.push(message)
  }
  return result
}
export function sortCommitTemplates(
  templates: readonly string[],
  recent: readonly string[],
  usedKeys: readonly string[] = [],
): string[] {
  const rank = (message: string) => {
    const index = recent.indexOf(message)
    if (index >= 0) return index
    const used = usedKeys.indexOf(commitMessageKey(message))
    return used < 0 ? recent.length + usedKeys.length : recent.length + used
  }
  const ranks = new Map(templates.map(message => [message, rank(message)]))
  return [...templates].sort((a, b) => ranks.get(a)! - ranks.get(b)!)
}

/** Ordering marker only: equality/de-duplication always compares the complete message. */
export function commitMessageKey(message: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(message.trim()))
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  return hash.toString(16).padStart(8, '0')
}
export function recentCommitMessages(
  messages: readonly string[],
  templates: readonly string[],
  limit = limits.recent,
): string[] {
  const result: string[] = [],
    common = new Set(templates.map((message) => message.trim()))
  for (const value of messages) {
    const message = value.trim()
    if (message && !common.has(message) && !result.includes(message)) result.push(message)
    if (result.length >= limit) break
  }
  return result
}
