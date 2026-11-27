import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions } from './release-history.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function developmentVersion(root = ROOT) {
  const fallback = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
  try {
    const tags = execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split('\n')
      .filter(tag => SEMVER_TAG.test(tag))
      .map(tag => tag.slice(1)).sort(compareVersions)
    return tags.at(-1) || fallback
  } catch { return fallback }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args[0] === 'dev') {
    execFileSync(process.execPath, [resolve(ROOT, 'scripts/set-version.mjs'), developmentVersion()], { cwd: ROOT, stdio: 'inherit' })
  }
  const cli = resolve(ROOT, 'node_modules/@tauri-apps/cli/tauri.js')
  const child = spawn(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit' })
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}
