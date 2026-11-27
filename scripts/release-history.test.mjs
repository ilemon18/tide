import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { compareVersions, generateHistory } from './release-history.mjs'

test('orders semantic versions, including numeric prerelease identifiers', () => {
  assert(compareVersions('0.0.17', '0.0.9') > 0)
  assert(compareVersions('1.0.0', '1.0.0-beta') > 0)
  assert(compareVersions('1.0.0-beta.10', '1.0.0-beta.2') > 0)
})

test('the update manifest carries only the latest notes, without the full archive', () => {
  const dist = mkdtempSync(join(tmpdir(), 'tide-update-notes-'))
  try {
    const notesFile = join(dist, 'notes.md')
    writeFileSync(notesFile, '- Preview HTML with isolated ports.\n')
    writeFileSync(join(dist, 'tide-macos-0.0.18.dmg'), 'fixture')
    execFileSync(process.execPath, ['scripts/make-latest-json.mjs', '--dist', dist, '--version', '0.0.18', '--repo', 'fixture/tide', '--notes-file', notesFile], { encoding: 'utf8' })
    const manifest = JSON.parse(readFileSync(join(dist, 'latest.json'), 'utf8'))
    assert.equal(manifest.notes, '- Preview HTML with isolated ports.')
    assert(!('releases' in manifest))
    assert.equal(manifest.version, '0.0.18')
  } finally { rmSync(dist, { recursive: true, force: true }) }
})

test('backfills exact tag ranges, skips missing versions, and assigns the current summary to its release', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-release-history-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
  try {
    git('init')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.com')
    const commit = (subject) => git('commit', '--allow-empty', '-m', subject)
    commit('Initial')
    git('tag', 'v0.0.9')
    commit('feat: add configuration')
    git('tag', 'v0.0.10')
    commit('fix: repair backup')
    git('tag', 'v0.0.12')
    commit('feat: add terminal menus')
    mkdirSync(join(root, 'changes'))
    writeFileSync(
      join(root, 'changes/unreleased.md'),
      '# Unreleased\n\n- Terminal menus and safe backups.\n',
    )
    const notesFile = join(root, 'release-notes.md')
    const history = await generateHistory({ root, output: root, version: '0.0.13', notesFile })
    assert.deepEqual(
      history.releases.map((release) => release.version),
      ['0.0.13', '0.0.12', '0.0.10'],
    )
    assert.deepEqual(
      history.releases[1].commits.map((commit) => commit.subject),
      ['fix: repair backup'],
    )
    assert(history.releases[0].notes.includes('Terminal menus and safe backups.'))
    assert(!history.releases[1].notes.includes('Terminal menus and safe backups.'))
    assert(readFileSync(notesFile, 'utf8').includes('feat: add terminal menus'))
    const again = await generateHistory({ root, output: root, version: '0.0.13', notesFile })
    assert.equal(again.releases[0].notes, history.releases[0].notes)
    git('tag', '-d', 'v0.0.12')
    const retained = await generateHistory({ root, output: root, version: '0.0.13', notesFile })
    assert(retained.releases.some(release => release.version === '0.0.12' && release.notes.includes('repair backup')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
