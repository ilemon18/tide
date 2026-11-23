import { expect, it } from 'vitest'
import type { DirEntryInfo } from './ipc'
import { mentionDirectory, rankMentionCandidates } from './agentMentions'

const entry = (path: string, isDir = true, isSymlink = false): DirEntryInfo => ({
  path, name: path.split('/').at(-1)!, isDir, isSymlink, ignored: false, size: 0, mtime: 0,
})

it('derives and deduplicates unopened ancestors, preferring exact directory matches', () => {
  const hits = rankMentionCandidates('src', ['src/a.ts', 'src/a.ts', 'src/deep/b.ts'], [])
  expect(hits[0]).toEqual({ path: 'src', name: 'src', isDir: true })
  expect(hits.filter(hit => hit.path === 'src')).toHaveLength(1)
  expect(hits.some(hit => hit.path === 'src/deep' && hit.isDir)).toBe(true)
})

it('includes empty directories and lets real metadata override an inferred directory', () => {
  const hits = rankMentionCandidates('', ['link/old.ts', 'src/a.ts'], [entry('empty'), entry('link', false, true)])
  expect(hits.some(hit => hit.path === 'empty' && hit.isDir)).toBe(true)
  expect(hits.some(hit => hit.path === 'link')).toBe(false)
  expect(hits.some(hit => hit.path.startsWith('link/'))).toBe(false)
})

it('ranks name prefixes ahead of fuzzy matches and bounds results to eight', () => {
  const files = ['other.ts', 'abacus.ts', ...Array.from({ length: 20 }, (_, i) => `about${i}.ts`)]
  const hits = rankMentionCandidates('ab', files, [])
  expect(hits).toHaveLength(8)
  expect(hits.every(hit => hit.name.startsWith('ab'))).toBe(true)
})

it.each([
  ['', ''], ['src', ''], ['src/', 'src'], ['src/empty/', 'src/empty'],
  ['./src/comp', 'src'], ['../escape/', null], ['src/../escape/', null],
  ['/outside/', null], ['src\\outside', null],
])('finds the contained directory for %s', (query, directory) => {
  expect(mentionDirectory(query!)).toBe(directory)
})
