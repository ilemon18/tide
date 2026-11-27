import { expect, it } from 'vitest'
import {
  COMMIT_MESSAGE_LIMITS as limits, commitMessageKey, normalizeCommitTemplates,
  recentCommitMessages, sortCommitTemplates,
} from './commitMessages'

it('normalizes global templates, deduplicates full messages and enforces count/UTF-8 bounds', () => {
  const values = ['  common  ', 'common', null, '\u754c'.repeat(limits.messageBytes), ...Array.from({ length: limits.templates + 3 }, (_, i) => `message ${i}`)]
  const templates = normalizeCommitTemplates(values)
  expect(templates).toHaveLength(limits.templates)
  expect(templates[0]).toBe('common')
  expect(templates).not.toContain('\u754c'.repeat(limits.messageBytes))
  expect(normalizeCommitTemplates({ messages: values })).toEqual([])
})

it('keeps recent messages distinct from common templates and from duplicate commits', () => {
  const recent = recentCommitMessages([' common ', 'first', 'first', '', 'first\n\nbody', 'second'], ['common'])
  expect(recent).toEqual(['first', 'first\n\nbody', 'second'])
  expect(recentCommitMessages(Array.from({ length: limits.recent + 4 }, (_, i) => `message ${i}`), [])).toHaveLength(limits.recent)
})

it('prioritizes project-used common messages without changing configured ordering for unused ones', () => {
  expect(sortCommitTemplates(['unused', 'used earlier', 'used recently', 'also unused'], [], [commitMessageKey('used recently'), commitMessageKey('used earlier')]))
    .toEqual(['used recently', 'used earlier', 'unused', 'also unused'])
})
