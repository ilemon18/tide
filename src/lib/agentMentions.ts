import type { DirEntryInfo } from './ipc'
import { basename, dirname } from './paths'
import { fuzzyMatch } from './fuzzy'

export type MentionCandidate = { path: string; name: string; isDir: boolean }

/** A typed directory prefix is read directly, including directories absent from the file index. */
export function mentionDirectory(query: string): string | null {
  const normalized = query.replace(/^\.\//, '')
  if (normalized.startsWith('/') || normalized.includes('\\') || normalized.split('/').includes('..')) return null
  return dirname(normalized)
}

/** Merge indexed paths/ancestors and real directory entries without changing the quick-open index. */
export function rankMentionCandidates(
  query: string,
  files: readonly string[],
  entries: readonly DirEntryInfo[],
  limit = 8,
): MentionCandidate[] {
  const candidates = new Map<string, MentionCandidate>()
  for (const path of files) {
    candidates.set(path, { path, name: basename(path), isDir: false })
    let parent = dirname(path)
    while (parent) {
      if (candidates.has(parent)) break
      candidates.set(parent, { path: parent, name: basename(parent), isDir: true })
      parent = dirname(parent)
    }
  }
  // Live/cached metadata wins over ancestors inferred from a possibly stale index.
  const symlinks = new Set(entries.filter(entry => entry.isSymlink).map(entry => entry.path))
  for (const entry of entries) {
    if (entry.isSymlink) candidates.delete(entry.path)
    else candidates.set(entry.path, { path: entry.path, name: entry.name, isDir: entry.isDir })
  }
  const q = query.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
  return [...candidates.values()]
    .filter(candidate => {
      let path = candidate.path
      while (path) {
        if (symlinks.has(path)) return false
        path = dirname(path)
      }
      return true
    })
    .map(candidate => {
      const hit = fuzzyMatch(query, candidate)
      const exact = candidate.path.toLowerCase() === q
      const prefix = candidate.name.toLowerCase().startsWith(q.split('/').at(-1) ?? '')
      return { candidate, score: hit ? hit.score + (exact ? 1000 : prefix ? 100 : 0) : -Infinity }
    })
    .filter(hit => Number.isFinite(hit.score))
    .sort((a, b) => b.score - a.score || Number(b.candidate.isDir) - Number(a.candidate.isDir) || a.candidate.path.localeCompare(b.candidate.path))
    .slice(0, limit)
    .map(hit => hit.candidate)
}
