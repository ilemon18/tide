/** Shared metadata, routing and generated-index helpers for Tide's AI docs. */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const GENERATED_ROUTES_BEGIN = '<!-- BEGIN GENERATED ROUTES -->'
export const GENERATED_ROUTES_END = '<!-- END GENERATED ROUTES -->'

/** Total resident context plus the area docs selected by one routing fixture. */
export const FIXTURE_LIMIT = 24 * 1024
export const BUNDLE_TARGET = 16 * 1024

export function fixtureBudgetError(name, bundleBytes) {
  if (bundleBytes <= FIXTURE_LIMIT) return null
  return `routing fixture '${name}' bundle is ${(bundleBytes / 1024).toFixed(2)}KB (hard limit ${FIXTURE_LIMIT / 1024}KB)`
}

/** Paths that exercise precise routing, including one legitimate cross-domain change. */
export const ROUTING_FIXTURES = Object.freeze([
  {
    name: 'Agent composer',
    paths: ['src/components/AgentComposer.tsx'],
    expected: ['agent-composer.md'],
  },
  {
    name: 'Agent composer settings migration',
    paths: [
      'src/components/AgentComposer.tsx',
      'src/store/settings.ts',
      'src-tauri/src/commands/theme.rs',
    ],
    expected: ['agent-composer.md', 'runtime.md'],
  },
  {
    name: 'Agent history',
    paths: ['src-tauri/src/agent/store.rs'],
    expected: ['agent-storage.md'],
  },
  {
    name: 'Shared agent state',
    paths: ['src/store/agent.ts'],
    expected: ['agent-composer.md', 'agent-storage.md', 'agent.md'],
  },
  {
    name: 'Settings migration',
    paths: ['src/store/settings.ts', 'src-tauri/src/commands/theme.rs'],
    expected: ['runtime.md'],
  },
  {
    name: 'Editor',
    paths: ['src/components/EditorArea.tsx', 'src/store/tabs.test.ts'],
    expected: ['editor.md'],
  },
  {
    name: 'Git and watcher',
    paths: ['src/store/git.ts', 'src/store/watcher.ts'],
    expected: ['file-tree.md', 'git.md'],
  },
  {
    name: 'Update backend',
    paths: ['src-tauri/src/update.rs'],
    expected: ['updates.md'],
  },
  {
    name: 'Locale catalog',
    paths: ['src/i18n/messages/en.ts'],
    expected: ['i18n.md'],
  },
  {
    name: 'Guard and CI workflow',
    paths: ['scripts/check-ai-docs.mjs', '.github/workflows/ci.yml'],
    expected: ['checks.md'],
  },
])

/** Candidate order is part of the metadata search contract, including no-hit behavior. */
export const QUERY_FIXTURES = Object.freeze([
  { query: 'history', expected: ['agent-storage.md'] },
  { query: 'Agent 历史恢复', expected: ['agent-storage.md', 'agent.md'] },
  { query: '历史分页', expected: ['agent-storage.md'] },
  { query: ' COMPOSER ', expected: ['agent-composer.md'] },
  { query: 'settings', expected: ['runtime.md'] },
  { query: 'Git watcher', expected: ['git.md', 'file-tree.md'] },
  { query: 'quantumzebra', expected: [] },
])

function decodeScalar(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * Parse the deliberately small area-doc frontmatter contract:
 * a scalar summary, repository-relative scope globs and optional keyword aliases.
 */
export function parseAreaMetadata(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!frontmatter) return { error: 'missing frontmatter' }

  const fields = new Map()
  const scope = []
  const keywords = []
  let activeList = null

  for (const [index, raw] of frontmatter[1].split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const listItem = /^\s+-\s*(.*?)\s*$/.exec(raw)
    if (listItem) {
      if (activeList !== 'scope' && activeList !== 'keywords') {
        return { error: `frontmatter line ${index + 2} has a list item outside scope/keywords` }
      }
      const item = decodeScalar(listItem[1])
      if (!item || /[\r\n]/.test(item)) return { error: activeList + ' contains an empty or multiline entry' }
      const list = activeList === 'scope' ? scope : keywords
      list.push(item)
      continue
    }

    const field = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(raw)
    if (!field || /^\s/.test(raw)) {
      return { error: `invalid frontmatter line ${index + 2}` }
    }
    const [, key, rawValue] = field
    if (fields.has(key)) return { error: `duplicate frontmatter field '${key}'` }
    fields.set(key, rawValue)
    activeList = rawValue === '' ? key : null
  }

  if (!fields.has('summary')) return { error: 'missing non-empty summary' }
  const summary = decodeScalar(fields.get('summary'))
  if (!summary || /[\r\n]/.test(summary)) return { error: 'missing non-empty summary' }

  if (!fields.has('scope')) return { error: 'missing non-empty scope' }
  if (fields.get('scope') !== '') return { error: 'scope must be a block list' }
  if (scope.length === 0) return { error: 'missing non-empty scope' }

  const uniqueScope = new Set()
  for (const glob of scope) {
    if (uniqueScope.has(glob)) return { error: `duplicate scope '${glob}'` }
    uniqueScope.add(glob)
  }

  if (fields.has('keywords')) {
    if (fields.get('keywords') !== '' || keywords.length === 0) {
      return { error: 'keywords must be a non-empty block list' }
    }
    const unique = new Set()
    for (const keyword of keywords) {
      const normalized = normalizeQuery(keyword)
      if (!normalized) return { error: 'keywords contains an empty entry' }
      if (unique.has(normalized)) return { error: "duplicate keyword '" + keyword + "'" }
      unique.add(normalized)
    }
    return { summary, scope, keywords }
  }
  // Older metadata remains readable; the repository guard requires aliases on current area docs.
  return { summary, scope }
}

/**
 * Compile a POSIX glob used by area-doc scope. `*` and `?` stay within one path
 * segment; `**` spans segments and must occupy a complete segment.
 */
export function compileScopeGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) return { error: 'scope glob is empty' }
  if (glob.includes('\\')) return { error: `scope '${glob}' must use POSIX '/' separators` }
  if (glob.startsWith('/')) return { error: `scope '${glob}' must be repository-relative` }
  if (glob.endsWith('/')) return { error: `scope '${glob}' must name a file pattern, not a directory` }

  const segments = glob.split('/')
  for (const segment of segments) {
    if (!segment) return { error: `scope '${glob}' contains an empty segment` }
    if (segment === '.' || segment === '..') {
      return { error: `scope '${glob}' must not traverse outside the repository` }
    }
  }

  let source = '^'
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        const previous = glob[index - 1]
        const next = glob[index + 2]
        if ((previous && previous !== '/') || (next && next !== '/')) {
          return { error: `scope '${glob}' must use '**' as a complete segment` }
        }
        if (next === '/') {
          source += '(?:[^/]+/)*'
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const close = glob.indexOf(']', index + 1)
      if (close === -1) return { error: `scope '${glob}' has an unterminated character class` }
      let body = glob.slice(index + 1, close)
      if (!body) return { error: `scope '${glob}' has an empty character class` }
      if (body.startsWith('!')) body = `^${body.slice(1)}`
      source += `[${body.replace(/\\/g, '\\\\')}]`
      index = close
      continue
    }
    source += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char
  }
  source += '$'

  try {
    return { regexp: new RegExp(source) }
  } catch {
    return { error: `scope '${glob}' is not a valid glob` }
  }
}

export function scopeMatchesPath(glob, path) {
  const compiled = compileScopeGlob(glob)
  return !compiled.error && compiled.regexp.test(path)
}

/** Read only a bounded frontmatter prefix; routing never needs the document body. */
export function readAreaMetadataFile(file) {
  const maxBytes = 16 * 1024
  const buffer = Buffer.allocUnsafe(maxBytes)
  const descriptor = openSync(file, 'r')
  let bytesRead = 0
  try {
    bytesRead = readSync(descriptor, buffer, 0, maxBytes, 0)
  } finally {
    closeSync(descriptor)
  }
  return parseAreaMetadata(buffer.subarray(0, bytesRead).toString('utf8'))
}

/** Resolve the exact set of area docs whose scope matches any changed path. */
export function resolveAreaDocsForPaths(docs, paths) {
  return docs
    .filter((doc) =>
      paths.some((path) => doc.scope.some((glob) => scopeMatchesPath(glob, path))),
    )
    .map((doc) => doc.doc)
    .sort((a, b) => a.localeCompare(b))
}

/** Shared discovery for route/sync; only bounded frontmatter metadata is returned. */
export function readAreaDocs(dir) {
  return readdirSync(dir).sort((a, b) => a.localeCompare(b))
    .filter((doc) => doc.endsWith('.md') && doc !== 'context.md' && statSync(join(dir, doc)).isFile())
    .map((doc) => {
      const file = join(dir, doc)
      const metadata = readAreaMetadataFile(file)
      if (metadata.error) throw new Error(doc + ': ' + metadata.error)
      return { doc, file, ...metadata }
    })
}

/** Explain every path hit; shared files deliberately retain all matching documents. */
export function explainPathRoutes(docs, paths) {
  return docs.map((doc) => ({
    ...doc,
    matches: paths.flatMap((path) => doc.scope.filter((glob) => scopeMatchesPath(glob, path))
      .map((glob) => ({ path, glob }))),
  })).filter((doc) => doc.matches.length > 0).sort((a, b) => a.doc.localeCompare(b.doc))
}

function normalizeQuery(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

function containsTerm(query, term) {
  // Latin terms match complete words (plan must not match planet); CJK aliases match phrases.
  if (/^[a-z0-9 -]+$/.test(term)) {
    const escaped = term.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&')
    return new RegExp('(?:^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])', 'u').test(query)
  }
  return query.includes(term)
}

/** Metadata-only candidate search. Scores rank results; they never truncate path contracts. */
export function queryAreaDocs(docs, query) {
  const normalized = normalizeQuery(query)
  if (!normalized) return []
  const stopWords = new Set(['and', 'the', 'for', 'with', 'from'])
  return docs.map((doc) => {
    const keywords = (doc.keywords ?? []).filter((word) => containsTerm(normalized, normalizeQuery(word)))
    const summary = [...new Set(normalizeQuery(doc.summary).match(/[a-z]{3,}/g) ?? [])]
      .filter((word) => !stopWords.has(word) && containsTerm(normalized, word))
    return { ...doc, keywordsMatched: keywords, summaryMatched: summary,
      score: keywords.length * 4 + summary.length }
  }).filter((doc) => doc.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.localeCompare(b.doc))
}

/** Keep positional paths compatible; -- ends option parsing for dash-prefixed filenames. */
export function parseRouteArgs(args) {
  const paths = []
  let query = null
  let explain = false
  let positional = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (positional) paths.push(arg)
    else if (arg === '--') positional = true
    else if (arg === '--explain') explain = true
    else if (arg === '--query') {
      if (query !== null || !args[index + 1]?.trim() || args[index + 1].startsWith('--')) {
        return { error: '--query requires one non-empty query and cannot be repeated' }
      }
      query = args[++index]
    } else if (arg.startsWith('--')) return { error: 'Unknown option: ' + arg }
    else if (arg) paths.push(arg)
  }
  if (query !== null && paths.length) return { error: 'Use either paths or --query, not both' }
  if (query === null && !paths.length) return { error: 'Supply paths or --query' }
  return { paths, query, explain }
}

/** Advisory only: repeated long prose deserves review, never automatic deletion. */
export function duplicateParagraphs(docs) {
  const seen = new Map()
  for (const { doc, text } of docs) {
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
    for (const paragraph of body.split(/\r?\n\s*\r?\n/)) {
      const normalized = paragraph.replace(/\s+/g, ' ').trim()
      if (normalized.length < 180 || normalized.startsWith('#') || normalized.startsWith('|')) continue
      if (!seen.has(normalized)) seen.set(normalized, new Set())
      seen.get(normalized).add(doc)
    }
  }
  return [...seen].filter(([, docs]) => docs.size > 1)
    .map(([text, docs]) => ({ text, docs: [...docs].sort() }))
}

export function roughTokens(bytes) {
  return Math.ceil(bytes / 4)
}

export function renderRouteTable(entries) {
  const rows = [...entries]
    .sort((a, b) => a.doc.localeCompare(b.doc))
    .map(({ doc, summary }) => `| [${doc}](./${doc}) | ${summary.replace(/\|/g, '\\|')} |`)
  return ['| Doc | Summary |', '|---|---|', ...rows].join('\n')
}

/**
 * Replace only the generated route region. Returns an error instead of touching a
 * malformed or missing marker pair.
 */
export function syncGeneratedRoutes(contextText, entries) {
  const begin = contextText.indexOf(GENERATED_ROUTES_BEGIN)
  const end = contextText.indexOf(GENERATED_ROUTES_END)
  if (begin === -1 || end === -1) {
    return { error: 'missing generated-route markers' }
  }
  if (contextText.indexOf(GENERATED_ROUTES_BEGIN, begin + 1) !== -1) {
    return { error: 'duplicate BEGIN generated-route marker' }
  }
  if (contextText.indexOf(GENERATED_ROUTES_END, end + 1) !== -1) {
    return { error: 'duplicate END generated-route marker' }
  }
  if (end < begin) return { error: 'generated-route markers are out of order' }

  const region = `${GENERATED_ROUTES_BEGIN}\n${renderRouteTable(entries)}\n${GENERATED_ROUTES_END}`
  return { text: `${contextText.slice(0, begin)}${region}${contextText.slice(end + GENERATED_ROUTES_END.length)}` }
}

export function isGeneratedRouteTableCurrent(contextText, entries) {
  const result = syncGeneratedRoutes(contextText, entries)
  return !result.error && result.text === contextText
}
