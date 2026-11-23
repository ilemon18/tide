import type { AgentContextAttachment } from './ipc'
import type { AgentDraft } from './agentCommand'
import { budget } from './memoryBudget'

export type ContextIntent = 'add' | 'explain' | 'refactor'
export const contextBytes = (text: string) => new TextEncoder().encode(text).byteLength
export const attachmentBytes = (items: readonly AgentContextAttachment[] = []) =>
  items.reduce((sum, item) => sum + contextBytes(item.text), 0)

function relativePath(value: unknown, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) &&
    !value.startsWith('/') && !value.includes('\\') && !value.includes(':') &&
    !value.includes('\0') && !value.split('/').includes('..')
}

export function isContextAttachment(value: unknown): value is AgentContextAttachment {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !item.id || item.id.length > 128 ||
    typeof item.sourceRoot !== 'string' || !item.sourceRoot ||
    typeof item.capturedAt !== 'number' || !Number.isFinite(item.capturedAt) || item.capturedAt < 0 || item.capturedAt > 8.64e15 ||
    typeof item.text !== 'string' || !item.text.length ||
    typeof item.label !== 'string' || !item.label || item.label.length > 512) return false
  if (item.kind === 'terminal-selection') return item.startupRel === null || relativePath(item.startupRel, true)
  if (item.kind !== 'editor-selection' || typeof item.unsaved !== 'boolean' ||
    !(item.rel === null || relativePath(item.rel))) return false
  const positions = [item.startLine, item.startColumn, item.endLine, item.endColumn]
  return positions.every(n => typeof n === 'number' && Number.isSafeInteger(n) && n > 0) &&
    (Number(item.endLine) > Number(item.startLine) ||
      (item.endLine === item.startLine && Number(item.endColumn) > Number(item.startColumn)))
}

/** Validate complete additions before mutating a draft; never truncate a snapshot. */
export function validateAttachments(root: string, items: readonly AgentContextAttachment[]):
  'agent.context.invalid' | 'agent.context.limit' | null {
  if (items.some(item => !isContextAttachment(item) || item.sourceRoot !== root) ||
    new Set(items.map(item => item.id)).size !== items.length) return 'agent.context.invalid'
  if (items.length > budget.agentAttachments() ||
    items.some(item => contextBytes(item.text) > budget.agentAttachmentBytes()) ||
    attachmentBytes(items) > budget.agentMessageAttachmentBytes()) return 'agent.context.limit'
  return null
}

/** Keep all metadata on every route through the queue, with no references to mutable draft arrays. */
export function snapshotAgentDraft(draft: AgentDraft): AgentDraft {
  return { ...draft, mentions: draft.mentions.map(item => ({ ...item })),
    skills: draft.skills?.map(item => ({ ...item })),
    attachments: draft.attachments?.map(item => ({ ...item })) }
}

export function serializeAttachments(items: readonly AgentContextAttachment[] = []): string {
  return items.map(item => {
    const location = item.kind === 'editor-selection'
      ? `${item.rel ?? item.label}:${item.startLine}:${item.startColumn}-${item.endLine}:${item.endColumn}${item.unsaved ? ' (unsaved snapshot)' : ''}`
      : `${item.label} (startup location: ${item.startupRel === null ? 'unavailable' : item.startupRel || '.'})`
    return `[${location} · ${new Date(item.capturedAt).toISOString()}]
${item.text}`
  }).join('\n\n')
}
