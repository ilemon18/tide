import { describe, expect, it } from 'vitest'
import { attachmentBytes, serializeAttachments, snapshotAgentDraft, validateAttachments } from './agentContext'
import type { AgentContextAttachment } from './ipc'
import { budget, setMemoryProfile } from './memoryBudget'

const attachment = (patch: Partial<AgentContextAttachment> = {}): AgentContextAttachment => ({
  id: 'context-1', kind: 'terminal-selection', sourceRoot: '/repo', capturedAt: 1,
  label: 'Terminal 1', startupRel: '', text: 'error', ...patch,
} as AgentContextAttachment)

describe('context snapshots', () => {
  it('counts UTF-8 bytes and rejects invalid roots, paths, dates and duplicate ids', () => {
    expect(attachmentBytes([attachment({ text: '\u4e2d\ud83d\ude42' })])).toBe(7)
    expect(validateAttachments('/other', [attachment()])).toBe('agent.context.invalid')
    for (const startupRel of ['../escape', '/absolute', 'a\\b', 'C:/file', 'a\0b']) {
      expect(validateAttachments('/repo', [attachment({ startupRel })])).toBe('agent.context.invalid')
    }
    expect(validateAttachments('/repo', [attachment(), attachment()])).toBe('agent.context.invalid')
    expect(validateAttachments('/repo', [attachment({ capturedAt: NaN })])).toBe('agent.context.invalid')
  })

  it('accepts exact limits and rejects count, per-item and combined overflow without truncating', () => {
    const max = 'x'.repeat(budget.agentAttachmentBytes())
    const items = Array.from({ length: 4 }, (_, index) => attachment({ id: String(index), text: max }))
    expect(validateAttachments('/repo', items)).toBeNull()
    expect(validateAttachments('/repo', [...items, attachment({ id: 'extra' })])).toBe('agent.context.limit')
    expect(validateAttachments('/repo', [attachment({ text: max + 'x' })])).toBe('agent.context.limit')
    expect(validateAttachments('/repo', Array.from({ length: 9 }, (_, index) => attachment({ id: String(index) })))).toBe('agent.context.limit')
    expect(items[0].text).toHaveLength(budget.agentAttachmentBytes())
  })

  it('copies every mutable draft array and retains exact captured text in copies', () => {
    const original = { text: 'Explain', mentions: [{ rel: 'a.ts', isDir: false }],
      skills: [{ name: 'skill', path: 'SKILL.md', source: 'project' as const }], attachments: [attachment()] }
    const snapshot = snapshotAgentDraft(original)
    original.attachments[0].text = 'changed'
    original.mentions[0].rel = 'b.ts'
    original.skills[0].name = 'changed'
    expect(snapshot.attachments?.[0].text).toBe('error')
    expect(snapshot.mentions[0].rel).toBe('a.ts')
    expect(snapshot.skills?.[0].name).toBe('skill')
    expect(serializeAttachments(snapshot.attachments)).toContain('error')
    expect(serializeAttachments(snapshot.attachments)).toContain('startup location: .')
  })

  it('reads the window budget from the active memory profile', () => {
    setMemoryProfile('light'); expect(budget.agentUnsentAttachmentBytes()).toBe(512 * 1024)
    setMemoryProfile('normal'); expect(budget.agentUnsentAttachmentBytes()).toBe(1024 * 1024)
  })
})
