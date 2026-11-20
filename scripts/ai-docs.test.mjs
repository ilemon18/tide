import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  ROUTING_FIXTURES,
  compileScopeGlob,
  fixtureBudgetError,
  isGeneratedRouteTableCurrent,
  parseAreaMetadata,
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
      return { doc: name, summary: metadata.summary, scope: metadata.scope }
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
