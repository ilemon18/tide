import { expect, it } from 'vitest'
import { resolveAgentFileLink } from './agentLinks'

it.each([
  ['./src/main.ts', { rel: 'src/main.ts' }],
  ['src/../README.md', { rel: 'README.md' }],
  ['/repo/src/main.ts:12:3', { rel: 'src/main.ts', line: 12, col: 3 }],
  ['README.md:12', { rel: 'README.md', line: 12, col: 1 }],
  ['src/main.ts#L12C3', { rel: 'src/main.ts', line: 12, col: 3 }],
  ['src/my%20file.ts', { rel: 'src/my file.ts' }],
])('resolves %s within the chat workspace', (href, result) => {
  expect(resolveAgentFileLink('/repo', href)).toEqual(result)
})

it.each([
  '', '#heading', '../private.txt', 'src/../../private.txt', '/repo-other/file',
  '/repo/../private.txt', '/elsewhere/file', '//server/share', 'https://example.com',
  'javascript:123', 'javascript:alert(1)', 'data:text/html,test', 'file:///repo/file',
  '%2e%2e/private.txt', '%2F%2Fserver/share', '%00file', 'src/%zz', 'src/main.ts:0',
  'src/main.ts#L9007199254740992', 'src\\..\\file',
])('rejects unsafe or unsupported references: %s', href => {
  expect(resolveAgentFileLink('/repo', href)).toBeNull()
})

it('uses the owning root and handles Windows drive paths without sending absolute paths', () => {
  expect(resolveAgentFileLink('', 'src/file.ts')).toBeNull()
  expect(resolveAgentFileLink('C:\\repo', 'C:/repo/src/file.ts:2')).toEqual({ rel: 'src/file.ts', line: 2, col: 1 })
  expect(resolveAgentFileLink('C:/repo', 'D:/repo/src/file.ts')).toBeNull()
})
