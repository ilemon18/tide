import { describe, expect, it } from 'vitest'
import { normalizeAgentDraft, parseAgentLocalCommand, buildAgentPrompt } from './agentCommand'

describe('command boundaries', () => {
  it('keeps local commands out of prompt tags', () => {
    expect(parseAgentLocalCommand('/resume chat-1')).toEqual({ id: 'resume', args: 'chat-1' })
    expect(normalizeAgentDraft({ text: '/fork', mentions: [] }).command).toBeUndefined()
    expect(parseAgentLocalCommand('explain /fork')).toBeNull()
  })
  it('keeps plan turns read-only and preserves skill references', () => {
    const draft = normalizeAgentDraft({ text: '/plan investigate', mentions: [],
      skills: [{ name: 'audit', path: '.agents/skills/audit/SKILL.md', source: 'project' }] })
    expect(draft.command).toBe('plan')
    expect(buildAgentPrompt(draft)).toContain('strictly read-only')
    expect(buildAgentPrompt(draft)).toContain('.agents/skills/audit/SKILL.md')
  })
})
