import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { developmentVersion } from './run-tauri.mjs'

test('development stamps the newest reachable version, ignoring other branches and invalid tags', () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-dev-version-'))
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe', encoding: 'utf8' }).trim()
  try {
    writeFileSync(join(root, 'package.json'), '{"version":"0.0.1"}')
    git('init')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.com')
    git('commit', '--allow-empty', '-m', 'Initial')
    git('tag', 'v0.0.9')
    git('tag', 'v0.0.17-beta.2')
    git('tag', 'v0.0.17-beta.10')
    git('tag', 'v0.0.17')
    git('tag', 'v99.invalid')
    git('tag', 'v99.01.0')
    git('tag', 'v99.1.0-beta.01')
    const head = git('rev-parse', 'HEAD')
    git('checkout', '-b', 'future')
    git('commit', '--allow-empty', '-m', 'Future')
    git('tag', 'v9.0.0')
    git('checkout', '--detach', head)
    assert.equal(developmentVersion(root), '0.0.17')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('development falls back to package metadata without reachable tags or Git', () => {
  const root = mkdtempSync(join(tmpdir(), 'tide-dev-fallback-'))
  try {
    writeFileSync(join(root, 'package.json'), '{"version":"1.2.3"}')
    assert.equal(developmentVersion(root), '1.2.3')
    execFileSync('git', ['init'], { cwd: root, stdio: 'pipe' })
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-m', 'Initial'], { cwd: root, stdio: 'pipe' })
    assert.equal(developmentVersion(root), '1.2.3')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
