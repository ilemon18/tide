export type FuzzyTarget = { path: string; name: string }

export type FuzzyHit = FuzzyTarget & { score: number; positions: number[] }

/**
 * File search scoring (quick-open style, but supports "directory + filename" queries): split on
 * spaces, every word must hit; a word containing `/` matches a sequence of path segments
 * (`pages/OutboundWorkbench` aligns with the segments of `src/pages/…`, no cross-directory
 * subsequence); a word without `/` is looked up in the file name first; segment start / camelCase /
 * contiguous / prefix hits score, gaps cost.
 */

const SEGMENT_EXACT = 26
const SEGMENT_PREFIX = 18
const SEGMENT_INCLUDES = 8
const SEGMENT_CONTIGUOUS = 10
const BASENAME_BONUS = 22
const FULL_SUBSTRING_BONUS = 24

/** Is this position a word boundary: after a path separator, before a camelCase capital */
function isBoundary(path: string, index: number): boolean {
  if (index === 0) return true
  const prev = path[index - 1]
  if (prev === '/' || prev === '.' || prev === '-' || prev === '_') return true
  const current = path[index]
  return current >= 'A' && current <= 'Z' && prev === prev.toLowerCase()
}

/** Subsequence match: returns the score and positions; more skipped characters cost more */
function subsequence(term: string, text: string): { score: number; positions: number[] } | null {
  const lower = text.toLowerCase()
  const positions: number[] = []
  let score = 0
  let qi = 0
  let last = -2

  for (let i = 0; i < text.length && qi < term.length; i += 1) {
    if (lower[i] !== term[qi]) continue
    positions.push(i)
    score += 1
    if (i === last + 1) score += 2
    else if (last >= 0) score -= Math.min(6, (i - last - 1) * 0.6)
    if (isBoundary(text, i)) score += 4
    last = i
    qi += 1
  }

  if (qi < term.length) return null
  return { score, positions }
}

/** Segment match: every query segment must hit a path segment in order */
function matchSegments(terms: string[], segments: string[]): { score: number; positions: number[] } | null {
  let cursor = 0
  let score = 0
  let prevMatched = -2

  for (const term of terms) {
    let found = -1
    let bonus = 0
    for (let i = cursor; i < segments.length; i += 1) {
      const candidate = segments[i].toLowerCase()
      if (candidate === term) {
        found = i
        bonus = SEGMENT_EXACT
        break
      }
      if (candidate.startsWith(term)) {
        found = i
        bonus = SEGMENT_PREFIX
        break
      }
      if (candidate.includes(term)) {
        found = i
        bonus = SEGMENT_INCLUDES
        break
      }
    }
    if (found === -1) return null
    score += bonus
    if (found === prevMatched + 1) score += SEGMENT_CONTIGUOUS
    prevMatched = found
    cursor = found + 1
  }

  return { score, positions: [] }
}

export function fuzzyMatch(query: string, target: FuzzyTarget): FuzzyHit | null {
  // Accept pasted forms like `./src/foo`, `/src/foo`, `src/foo/`
  const q = query.trim().toLowerCase().replace(/^\.?\//, '').replace(/\/+$/, '')
  if (!q) return { ...target, score: 0, positions: [] }

  const path = target.path
  const name = target.name
  const segments = path.split('/')
  const words = q.split(/\s+/).filter(Boolean)

  let score = 0
  const positions: number[] = []
  // The last query segment is compared against the file name (`pages/OutboundWorkbench` ends in a name candidate)
  let lastTerm = ''

  for (const word of words) {
    if (word.includes('/')) {
      const terms = word.split('/').filter(Boolean)
      lastTerm = terms[terms.length - 1] ?? ''
      const hit = matchSegments(terms, segments)
      if (!hit) return null
      score += hit.score
      continue
    }
    lastTerm = word

    // Look in the file name first: for the same query, name hits rank higher
    const inName = subsequence(word, name)
    if (inName) {
      score += inName.score + BASENAME_BONUS
      if (inName.positions[0] === 0) score += 8
      continue
    }
    const inPath = subsequence(word, path)
    if (!inPath) return null
    score += inPath.score
    positions.push(...inPath.positions)
  }

  // Whole-string contiguous hit (including path queries with /): jump to the top tier
  if (!q.includes(' ') && path.toLowerCase().includes(q)) score += FULL_SUBSTRING_BONUS

  const lowerName = name.toLowerCase()
  if (lastTerm) {
    if (lowerName === lastTerm) score += BASENAME_BONUS
    else if (lowerName.startsWith(lastTerm)) score += BASENAME_BONUS * 0.6
    else if (lowerName.includes(lastTerm)) score += 6
  }

  // Shallow, short paths are easier to reach
  score -= segments.length * 0.5
  score -= path.length * 0.01

  return { ...target, score, positions }
}

export function topMatches(query: string, files: FuzzyTarget[], limit = 50): FuzzyHit[] {
  const hits: FuzzyHit[] = []
  for (const file of files) {
    const hit = fuzzyMatch(query, file)
    if (hit) hits.push(hit)
  }
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return hits.slice(0, limit)
}