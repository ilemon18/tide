import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const archive = createRequire(import.meta.url)('./archive-release-history.cjs')

test('archives only history and the exact consumed summary without forcing Git updates', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tide-history-archive-'))
  const trees = [],
    updates = []
  const version = '0.0.18'
  const source = '# Unreleased\n\n- New feature.\n'
  const files = { 'changes/unreleased.md': source }
  const github = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: async ({ path }) => {
          if (!(path in files)) throw Object.assign(new Error('missing'), { status: 404 })
          return { data: { type: 'file', content: Buffer.from(files[path]).toString('base64') } }
        },
      },
      git: {
        getRef: async () => ({ data: { object: { sha: 'parent' } } }),
        getCommit: async () => ({ data: { tree: { sha: 'base-tree' } } }),
        createTree: async ({ tree }) => {
          trees.push(tree)
          return { data: { sha: 'new-tree' } }
        },
        createCommit: async ({ parents }) => {
          assert.deepEqual(parents, ['parent'])
          return { data: { sha: 'new-commit' } }
        },
        updateRef: async (options) => {
          updates.push(options)
        },
      },
    },
  }
  try {
    mkdirSync(join(directory, 'changes'))
    writeFileSync(
      join(directory, 'changes/releases.json'),
      JSON.stringify({ releases: [{ version, date: '2026-11-27', notes: '- New feature.' }] }),
    )
    writeFileSync(join(directory, 'release-fragment.md'), source)
    const args = {
      github,
      context: { repo: { owner: 'fixture', repo: 'tide' } },
      core: { info() {} },
      version,
      directory,
    }
    await archive(args)
    assert.deepEqual(
      trees[0].map((entry) => entry.path),
      ['changes/releases.json', 'CHANGELOG.md', 'changes/unreleased.md'],
    )
    assert.equal(updates[0].force, false)
    files['changes/unreleased.md'] = '# Unreleased\n\n- Another feature added during the build.\n'
    await archive(args)
    assert(!trees[1].some((entry) => entry.path === 'changes/unreleased.md'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
