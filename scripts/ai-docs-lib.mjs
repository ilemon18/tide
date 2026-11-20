/** Shared metadata, routing and generated-index helpers for Tide's AI docs. */
import { closeSync, openSync, readSync } from 'node:fs'

export const GENERATED_ROUTES_BEGIN = '<!-- BEGIN GENERATED ROUTES -->'
export const GENERATED_ROUTES_END = '<!-- END GENERATED ROUTES -->'

/** Total resident context plus the area docs selected by one routing fixture. */
export const FIXTURE_LIMIT = 24 * 1024

export function fixtureBudgetError(name, bundleBytes) {
  if (bundleBytes <= FIXTURE_LIMIT) return null
  return `routing fixture '${name}' bundle is ${(bundleBytes / 1024).toFixed(2)}KB (hard limit ${FIXTURE_LIMIT / 1024}KB)`
}

/** Paths that exercise precise routing, including one legitimate cross-domain change. */
export const ROUTING_FIXTURES = Object.freeze([
  {
    name: 'Agent composer',
    paths: ['src/components/AgentComposer.tsx'],
    expected: ['agent.md'],
  },
  {
    name: 'Agent composer settings migration',
    paths: [
      'src/components/AgentComposer.tsx',
      'src/store/settings.ts',
      'src-tauri/src/commands/theme.rs',
    ],
    expected: ['agent.md', 'runtime.md'],
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
 * a scalar `summary` and a block list of repository-relative POSIX globs in `scope`.
 */
export function parseAreaMetadata(text) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!frontmatter) return { error: 'missing frontmatter' }

  const fields = new Map()
  const scope = []
  let activeList = null

  for (const [index, raw] of frontmatter[1].split(/\r?\n/).entries()) {
    if (!raw.trim()) continue
    const listItem = /^\s+-\s*(.*?)\s*$/.exec(raw)
    if (listItem) {
      if (activeList !== 'scope') {
        return { error: `frontmatter line ${index + 2} has a list item outside scope` }
      }
      const item = decodeScalar(listItem[1])
      if (!item) return { error: 'scope contains an empty entry' }
      scope.push(item)
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
