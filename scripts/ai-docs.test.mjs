import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ROUTING_FIXTURES,
  QUERY_FIXTURES,
  BUNDLE_TARGET,
  duplicateParagraphs,
  explainPathRoutes,
  parseRouteArgs,
  queryAreaDocs,
  compileScopeGlob,
  fixtureBudgetError,
  isGeneratedRouteTableCurrent,
  parseAreaMetadata,
  readAreaDocs,
  readAreaMetadataFile,
  resolveAreaDocsForPaths,
  scopeMatchesPath,
  syncGeneratedRoutes,
} from './ai-docs-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')

test('routing bundles allow up to 24KB including resident context', () => {
  const residentBytes = 4 * 1024
  assert.equal(fixtureBudgetError('expanded', residentBytes + 13 * 1024), null)
  assert.equal(fixtureBudgetError('boundary', residentBytes + 20 * 1024), null)
  assert.match(
    fixtureBudgetError('oversized', residentBytes + 20 * 1024 + 1),
    /routing fixture 'oversized'.*hard limit 24KB/,
  )
})

function areaDocs() {
  return readdirSync(AI_DIR)
    .filter((name) => name.endsWith('.md') && name !== 'context.md')
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const metadata = parseAreaMetadata(readFileSync(join(AI_DIR, name), 'utf8'))
      assert.equal(metadata.error, undefined, `${name}: ${metadata.error}`)
      return { doc: name, ...metadata }
    })
}

test('area frontmatter requires one-line summary and non-empty scope', () => {
  const valid = `---\nsummary: Agent routing scope\nscope:\n  - src/components/Agent*.tsx\n  - src-tauri/src/agent/**\n---\n# Doc\n`
  assert.deepEqual(parseAreaMetadata(valid), {
    summary: 'Agent routing scope',
    scope: ['src/components/Agent*.tsx', 'src-tauri/src/agent/**'],
  })

  for (const invalid of [
    '# no frontmatter\n',
    '---\nsummary: Missing scope\n---\n',
    '---\nsummary:\nscope:\n  - src/lib/foo.ts\n---\n',
    '---\nsummary: Empty scope\nscope:\n---\n',
    '---\nsummary: Empty entry\nscope:\n  -\n---\n',
  ]) {
    assert.ok(parseAreaMetadata(invalid).error)
  }
})

test('scope globs are repository-relative POSIX patterns', () => {
  assert.equal(compileScopeGlob('src/components/Agent*.tsx').error, undefined)
  assert.equal(scopeMatchesPath('src/components/Agent*.tsx', 'src/components/AgentComposer.tsx'), true)
  assert.equal(scopeMatchesPath('src/components/Agent*.tsx', 'src/components/Editor.tsx'), false)
  assert.equal(scopeMatchesPath('src/**/*.ts', 'src/store/settings.ts'), true)
  assert.equal(scopeMatchesPath('src/*.ts', 'src/store/settings.ts'), false)

  for (const invalid of ['/src/**', '../src/**', 'src//**', 'src/***.ts', 'src/[abc', 'src/']) {
    assert.ok(compileScopeGlob(invalid).error, invalid)
  }
})

test('generated route region is deterministic and rejects stale tables', () => {
  const entries = [
    { doc: 'runtime.md', summary: 'Runtime settings' },
    { doc: 'agent.md', summary: 'Agent composer' },
  ]
  const context = `# Context\n\n<!-- BEGIN GENERATED ROUTES -->\nstale\n<!-- END GENERATED ROUTES -->\n\n## Contracts\n`
  const first = syncGeneratedRoutes(context, entries)
  assert.equal(first.error, undefined)
  assert.equal(isGeneratedRouteTableCurrent(first.text, entries), true)

  const second = syncGeneratedRoutes(first.text, entries)
  assert.equal(second.text, first.text)
  assert.equal(
    isGeneratedRouteTableCurrent(first.text.replace('| [runtime.md]', '| [runtime.md](./r.md) |'), entries),
    false,
  )
})

test('metadata reader ignores document bodies and stays bounded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-ai-docs-'))
  const file = join(dir, 'area.md')
  try {
    writeFileSync(
      file,
      `---\nsummary: Bounded routing\nscope:\n  - src/lib/ipc.ts\n---\n${'body '.repeat(8 * 1024)}\n`,
    )
    assert.deepEqual(readAreaMetadataFile(file), {
      summary: 'Bounded routing',
      scope: ['src/lib/ipc.ts'],
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('candidate discovery searches metadata only and rejects oversized frontmatter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tide-ai-metadata-'))
  const file = join(dir, 'area.md')
  try {
    writeFileSync(file, '---\nsummary: Scoped input\nscope:\n  - src/lib/ipc.ts\n'
      + 'keywords:\n  - composer\n---\n' + 'bodyonlyword '.repeat(4096))
    const docs = readAreaDocs(dir)
    assert.deepEqual(queryAreaDocs(docs, 'bodyonlyword'), [])
    assert.deepEqual(queryAreaDocs(docs, 'composer').map(({ doc }) => doc), ['area.md'])
    writeFileSync(file, '---\nsummary: ' + 'x'.repeat(16 * 1024)
      + '\nscope:\n  - src/lib/ipc.ts\n---\n')
    assert.ok(readAreaMetadataFile(file).error)
    assert.throws(() => readAreaDocs(dir), /area\.md: missing frontmatter/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('routing fixtures resolve exactly their expected area docs', () => {
  const docs = areaDocs()
  for (const fixture of ROUTING_FIXTURES) {
    assert.deepEqual(resolveAreaDocsForPaths(docs, fixture.paths), fixture.expected)
  }
})

test('context routes every current area doc exactly once', () => {
  const docs = areaDocs()
  const entries = docs.map(({ doc, summary }) => ({ doc, summary }))
  const context = readFileSync(join(AI_DIR, 'context.md'), 'utf8')
  assert.equal(isGeneratedRouteTableCurrent(context, entries), true)

  for (const doc of docs) {
    assert.ok(statSync(join(AI_DIR, doc.doc)).isFile())
    const rows = context.split('\n').filter((line) => line.includes(`](./${doc.doc})`))
    assert.equal(rows.length, 1, `${doc.doc} must have one generated route row`)
  }
})

test('keyword lists reject empty, scalar, multiline and normalized duplicate aliases', () => {
  const prefix = '---\nsummary: Input\nscope:\n  - src/components/Agent*.tsx\n'
  const parsed = parseAreaMetadata(prefix + 'keywords:\n  - Composer\n  - 输入\n---\n')
  assert.deepEqual(parsed.keywords, ['Composer', '输入'])
  for (const suffix of [
    'keywords:', 'keywords: input', 'keywords:\n  -',
    'keywords:\n  - Composer\n  - composer',
    'keywords:\n  - ＡＧＥＮＴ\n  - agent',
    'keywords:\n  - "line\\nbreak"',
  ]) assert.ok(parseAreaMetadata(prefix + suffix + '\n---\n').error, suffix)
})

test('queries use bounded metadata, rank deterministically and never fall back to every doc', () => {
  const docs = areaDocs()
  for (const fixture of QUERY_FIXTURES) {
    const first = queryAreaDocs(docs, fixture.query)
    assert.deepEqual(first.map(({ doc }) => doc), fixture.expected, fixture.query)
    assert.deepEqual(queryAreaDocs([...docs].reverse(), fixture.query), first)
    for (const hit of first) {
      assert.ok(hit.score > 0)
      assert.ok(hit.keywordsMatched.length + hit.summaryMatched.length > 0)
    }
  }
  assert.deepEqual(queryAreaDocs(docs, '  '), [])
  assert.deepEqual(queryAreaDocs(docs, 'planet'), [])
  assert.deepEqual(queryAreaDocs(docs, 'ＣＯＭＰＯＳＥＲ').map(({ doc }) => doc), ['agent-composer.md'])
})

test('shared paths retain all contracts and explanation identifies matching paths and scopes', () => {
  const docs = areaDocs()
  const paths = ['src/store/agent.ts', 'src/components/AgentComposer.tsx']
  const hits = explainPathRoutes(docs, paths)
  assert.deepEqual(hits.map(({ doc }) => doc), resolveAreaDocsForPaths(docs, paths))
  assert.deepEqual(hits.map(({ doc }) => doc), ['agent-composer.md', 'agent.md'])
  for (const hit of hits) for (const match of hit.matches) {
    assert.ok(paths.includes(match.path))
    assert.ok(hit.scope.includes(match.glob))
    assert.ok(scopeMatchesPath(match.glob, match.path))
  }
})

test('current fixtures include resident context within hard budget; 16KB remains advisory', () => {
  const docs = areaDocs()
  const resident = statSync(join(ROOT, 'AGENTS.md')).size + statSync(join(AI_DIR, 'context.md')).size
  assert.ok(statSync(join(AI_DIR, 'context.md')).size <= 2560)
  assert.ok(resident <= 4608)
  for (const fixture of ROUTING_FIXTURES) {
    const bytes = resident + resolveAreaDocsForPaths(docs, fixture.paths)
      .reduce((sum, doc) => sum + statSync(join(AI_DIR, doc)).size, 0)
    assert.equal(fixtureBudgetError(fixture.name, bytes), null)
  }
  assert.equal(fixtureBudgetError('advisory', BUNDLE_TARGET + 1), null)
})

test('current area docs have keywords and route their own maintenance', () => {
  const docs = areaDocs()
  for (const doc of docs) {
    assert.ok(doc.keywords?.length, doc.doc)
    assert.ok(resolveAreaDocsForPaths(docs, ['.ai/' + doc.doc]).includes(doc.doc), doc.doc)
  }
})

test('CLI argument parsing keeps positional paths and rejects ambiguous options', () => {
  assert.deepEqual(parseRouteArgs(['src/store/agent.ts']), {
    paths: ['src/store/agent.ts'], query: null, explain: false,
  })
  assert.deepEqual(parseRouteArgs(['--explain', '--', '--query']), {
    paths: ['--query'], query: null, explain: true,
  })
  assert.deepEqual(parseRouteArgs(['--query', '历史']), { paths: [], query: '历史', explain: false })
  for (const args of [[], ['--query'], ['--query', ' '], ['--unknown'],
    ['src/App.tsx', '--query', 'window'], ['--query', 'a', '--query', 'b']]) {
    assert.ok(parseRouteArgs(args).error, JSON.stringify(args))
  }
})

function route(...args) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts/route-ai-docs.mjs'), ...args], {
    cwd: tmpdir(), encoding: 'utf8',
  })
}

test('CLI preserves path use from any cwd, absolute paths, exit status and explain output', () => {
  const relative = route('src/components/AgentComposer.tsx')
  const absolute = route('--explain', join(ROOT, 'src/components/AgentComposer.tsx'))
  assert.equal(relative.status, 0, relative.stderr)
  assert.match(relative.stdout, /Load 1 area doc/)
  assert.match(relative.stdout, /agent-composer\.md/)
  assert.doesNotMatch(relative.stdout, /agent-storage\.md/)
  assert.equal(absolute.status, 0, absolute.stderr)
  assert.match(absolute.stdout, /matches src\/components\/AgentComposer/)
  assert.match(absolute.stdout, /Resident:.*routed docs:.*bundle:.*rough bytes\/4/)
  assert.equal(route('--query').status, 1)
})

test('CLI query distinguishes advice from loading and no-hit does not leak unrelated docs', () => {
  const found = route('--query', '历史分页')
  assert.equal(found.status, 0, found.stderr)
  assert.match(found.stdout, /Candidates/)
  assert.match(found.stdout, /keyword: 历史/)
  assert.match(found.stdout, /agent-storage\.md/)
  const missing = route('--query', 'quantumzebra')
  assert.equal(missing.status, 0, missing.stderr)
  assert.match(missing.stdout, /No area docs match the query/)
  assert.doesNotMatch(missing.stdout, /- \.ai\//)
  const pathMissing = route('unowned-file.xyz')
  assert.equal(pathMissing.status, 0, pathMissing.stderr)
  assert.match(pathMissing.stdout, /No area docs match the supplied paths/)
})

test('long repeated prose is advisory, ignores metadata/headings and deduplicates by document', () => {
  const paragraph = 'Keep the complete persistence contract. '.repeat(8)
  const matches = duplicateParagraphs([
    { doc: 'a.md', text: '# A\n\n' + paragraph + '\n\n' + paragraph },
    { doc: 'b.md', text: '# B\n\n' + paragraph.replaceAll(' ', '  ') },
  ])
  assert.deepEqual(matches.map(({ docs }) => docs), [['a.md', 'b.md']])
  assert.deepEqual(duplicateParagraphs([{ doc: 'a.md', text: paragraph + '\n\n' + paragraph }]), [])
})
