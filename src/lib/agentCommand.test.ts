import { describe, expect, it } from 'vitest'
import { normalizeAgentDraft, parseAgentLocalCommand, buildAgentPrompt, matchCommands } from './agentCommand'

describe('command boundaries', () => {
  it('keeps the slash picker in the common command order', () => {
    expect(matchCommands('')).toEqual([
      'new', 'resume', 'fork', 'compact', 'status', 'model', 'permissions',
      'plan', 'goal', 'review', 'test', 'explain', 'help',
    ])
    expect(matchCommands('e')).toEqual(['new', 'resume', 'model', 'permissions', 'review', 'test', 'explain', 'help'])
  })

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
  expect(prompt).toContain('Do not modify files or run commands with side effects')
  expect(prompt).toContain('only after the user explicitly switches to writable mode')
  expect(prompt).not.toContain('return the final decision-ready plan')
})

it('includes a valid structured question example in normal, read-only and planning prompts', () => {
  const prompts = [
    buildAgentPrompt({ text: 'Investigate', mentions: [] }),
    buildAgentPrompt({ text: 'Investigate', mentions: [] }, true),
    buildAgentPrompt({ text: 'Investigate', mentions: [], command: 'plan' }),
  ]
  for (const prompt of prompts) {
    expect(prompt).toContain('at most once per turn')
    expect(prompt).toContain('outside code fences')
    const marker = prompt.match(/<TIDE_QUESTION>(.*?)<\/TIDE_QUESTION>/)
    expect(marker).not.toBeNull()
    const question = JSON.parse(marker![1])
    expect(question.header).toBeTruthy()
    expect(question.question).toBeTruthy()
    expect(question.multiSelect).toBe(false)
    expect(question.options).toHaveLength(2)
    for (const option of question.options) {
      expect(option.label).toBeTruthy()
      expect(option.description).toBeTruthy()
    }
  }
})

it('preserves user whitespace and indentation when normalizing plain text and command bodies', () => {
  const text = '  first\n    nested\n'
  expect(normalizeAgentDraft({ text, mentions: [] }).text).toBe(text)
  expect(normalizeAgentDraft({ text: '/plan\n' + text, mentions: [] }).text).toBe(text)
})
