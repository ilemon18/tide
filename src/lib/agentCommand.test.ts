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

it('keeps a permissions-only read-only query on the requested topic', () => {
  const prompt = buildAgentPrompt({ text: 'Explain this function', mentions: [] }, true)
  expect(prompt).toContain('Read-only mode:')
  expect(prompt).toContain('Explain this function')
  expect(prompt).not.toContain('return the final decision-ready plan')
})

it('preserves user whitespace and indentation when normalizing plain text and command bodies', () => {
  const text = '  first\n    nested\n'
  expect(normalizeAgentDraft({ text, mentions: [] }).text).toBe(text)
  expect(normalizeAgentDraft({ text: '/plan\n' + text, mentions: [] }).text).toBe(text)
})
