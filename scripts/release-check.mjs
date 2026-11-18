#!/usr/bin/env node
/**
 * Tide release preflight.
 *
 *   pnpm release:check 0.0.2
 *   pnpm release:check 0.0.2 --allow-dirty
 *
 * This script is read-only and never uses the network. It checks the local git state, version
 * files, Tauri bundle configuration, the release/CI workflow contract and the update manifest.
 * The release skill runs the verification gate, frontend build, Rust tests and optional local
 * installer build after this static pass.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RELEASE_TARGETS } from './release-targets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKFLOW_CI = '.github/workflows/ci.yml'
const WORKFLOW_RELEASE = '.github/workflows/release.yml'
const PACKAGE_JSON = 'package.json'
const TAURI_CONF = 'src-tauri/tauri.conf.json'
const CARGO_TOML = 'src-tauri/Cargo.toml'
const CARGO_LOCK = 'src-tauri/Cargo.lock'
const UPDATE_RS = 'src-tauri/src/update.rs'

/** semver.org; groups: major, minor, patch, prerelease, build */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

const passes = []
const warnings = []
const failures = []

function pass(message) {
  passes.push(message)
}

function warn(message, hint) {
  warnings.push({ message, hint: hint || '' })
}

function fail(message, hint) {
  failures.push({ message, hint: hint || '' })
}

function usage() {
  console.log('Usage: pnpm release:check <version> [--allow-dirty]')
  console.log('')
  console.log('  <version>      Target tag without v, for example 0.0.2')
  console.log('  --allow-dirty  Keep checking after fixes; git cleanliness becomes a warning')
  console.log('')
  console.log('Read-only: no network, no tag, no push, no tracked-file writes.')
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  usage()
  process.exit(0)
}

const allowDirty = argv.includes('--allow-dirty')
const unknown = argv.find((arg) => arg.startsWith('-') && arg !== '--allow-dirty')
if (unknown) {
  console.error('Unknown argument: ' + unknown)
  usage()
  process.exit(2)
}

const positional = argv.filter((arg) => !arg.startsWith('-'))
if (positional.length !== 1) {
  console.error('Expected exactly one version argument')
  usage()
  process.exit(2)
}

const requested = positional[0].trim()
const version = requested.replace(/^v(?=\d)/, '')
if (!SEMVER.test(version)) {
  console.error('"' + requested + '" is not valid semver (expected MAJOR.MINOR.PATCH[-prerelease])')
  process.exit(2)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    status: result.status,
    out: (result.stdout || '').trim(),
    err: (result.stderr || '').trim() || (result.error ? result.error.message : ''),
    error: result.error,
  }
}

function readText(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), 'utf8')
  } catch (err) {
    fail('cannot read ' + relPath + ': ' + err.message, 'check that the file exists')
    return null
  }
}

function readJson(relPath) {
  const text = readText(relPath)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch (err) {
    fail(relPath + ' is not valid JSON: ' + err.message)
    return null
  }
}

function exists(relPath) {
  return existsSync(join(ROOT, relPath))
}

function existsAbs(path) {
  return existsSync(path)
}

function escapeRe(value) {
  return value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&')
}

function parseSemver(value) {
  const match = SEMVER.exec(value)
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

function compareSemver(a, b) {
  const left = parseSemver(a)
  const right = parseSemver(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key]
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    const x = left.pre[index]
    const y = right.pre[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y)
      if (diff !== 0) return diff
    } else if (xNumeric) {
      return -1
    } else if (yNumeric) {
      return 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function parseRepoSlug(url) {
  const isGitHub =
    /^https?:\/\/(?:www\.)?github\.com\//.test(url) ||
    /^[^@/]+@github\.com:/.test(url) ||
    /^ssh:\/\/[^/]*github\.com\//.test(url)
  if (!isGitHub) return null

  let value = url.trim().replace(/\.git$/, '').replace(/\/+$/, '')
  const https = /^https?:\/\/[^/]+\/(.+)$/.exec(value)
  const scp = /^[^@/]+@[^:]+:(.+)$/.exec(value)
  const ssh = /^ssh:\/\/[^/]+\/(.+)$/.exec(value)
  if (https) value = https[1]
  else if (scp) value = scp[1]
  else if (ssh) value = ssh[1]

  const parts = value.split('/')
  return parts.length === 2 ? parts.join('/') : null
}

function checkGit(version) {
  const gitVersion = run('git', ['--version'])
  if (!gitVersion.ok) {
    fail('git is not available', 'install git and retry')
    return null
  }

  const top = run('git', ['rev-parse', '--show-toplevel'])
  if (!top.ok || resolve(top.out) !== ROOT) {
    fail('not running inside the Tide repository', 'run from the repository root')
    return null
  }
  pass('git repository: ' + ROOT)

  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.ok && branch.out !== 'main') {
    warn('current branch is ' + branch.out + ', not main', 'release tags normally come from main')
  } else if (branch.ok) {
    pass('branch is main')
  }

  const status = run('git', ['status', '--porcelain'])
  if (!status.ok) {
    fail('git status failed', status.err)
  } else if (status.out) {
    if (allowDirty) warn('working tree is dirty (allowed by --allow-dirty)', 'commit the fixes, then rerun without --allow-dirty')
    else fail('working tree is dirty', 'commit or stash your changes, then rerun')
  } else {
    pass('working tree is clean')
  }

  const head = run('git', ['rev-parse', 'HEAD'])
  const origin = run('git', ['rev-parse', '--verify', 'origin/main'])
  if (!origin.ok) {
    warn('origin/main is not available', 'run git fetch origin yourself; this check does not use the network')
  } else if (head.ok && head.out !== origin.out) {
    const ahead = run('git', ['rev-list', '--count', 'origin/main..HEAD'])
    const behind = run('git', ['rev-list', '--count', 'HEAD..origin/main'])
    const message =
      'HEAD is not origin/main (ahead ' + (ahead.out || '?') + ', behind ' + (behind.out || '?') + ')'
    if (allowDirty) warn(message, 'commit and push, then rerun without --allow-dirty')
    else fail(message, 'commit and push your changes, then rerun')
  } else if (head.ok) {
    pass('HEAD matches origin/main')
  }

  const tag = 'v' + version
  const localTag = run('git', ['rev-parse', '--verify', '--quiet', 'refs/tags/' + tag])
  if (localTag.ok) fail('local tag ' + tag + ' already exists', 'choose a new version; do not delete a published tag')
  else pass('local tag ' + tag + ' does not exist')

  const tags = run('git', ['tag', '--list', 'v*'])
  if (!tags.ok) {
    fail('could not list local tags', tags.err)
  } else {
    const localVersions = tags.out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((name) => name.replace(/^v/, ''))
      .filter((name) => SEMVER.test(name))
    const latest = localVersions.sort(compareSemver).at(-1)
    if (latest) {
      if (compareSemver(version, latest) <= 0) {
        fail('target ' + version + ' is not newer than local tag v' + latest, 'choose a higher version')
      } else {
        pass('target ' + version + ' is newer than local tag v' + latest)
      }
    } else {
      pass('no local semver release tags yet')
    }
  }

  const trackedLatest = run('git', ['ls-files', '--error-unmatch', 'latest.json'])
  if (trackedLatest.ok) fail('latest.json is tracked by git', 'remove it; it is generated at release time')
  else pass('latest.json is not tracked')

  for (const dir of ['dist', 'release', 'src-tauri/target']) {
    const ignored = run('git', ['check-ignore', '-q', dir])
    if (ignored.ok) pass(dir + '/ is gitignored')
    else warn(dir + '/ is not gitignored', 'add it to .gitignore')
  }

  const remote = run('git', ['remote', 'get-url', 'origin'])
  if (!remote.ok) {
    fail('origin remote is missing', 'add the GitHub origin remote')
    return null
  }
  const repoSlug = parseRepoSlug(remote.out)
  if (!repoSlug) {
    fail('cannot parse origin URL: ' + remote.out, 'expected https://github.com/owner/repo.git or git@github.com:owner/repo.git')
    return null
  }
  pass('origin repository: ' + repoSlug)
  return repoSlug
}

function cargoPackageVersion(text) {
  const lines = text.split(/\r?\n/)
  let inPackage = false
  for (const line of lines) {
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackage = true
      continue
    }
    if (inPackage && /^\s*\[[^\]]+\]\s*$/.test(line)) break
    if (!inPackage) continue
    const match = /^\s*version\s*=\s*"([^"]*)"/.exec(line)
    if (match) return match[1]
  }
  return null
}

function cargoLockVersion(text) {
  const entries = [...text.matchAll(/\[\[package\]\]\r?\nname = "tide"\r?\nversion = "([^"]*)"/g)]
  return entries.length === 1 ? entries[0][1] : null
}

function checkVersions(version) {
  const pkg = readJson(PACKAGE_JSON)
  const tauri = readJson(TAURI_CONF)
  const cargoText = readText(CARGO_TOML)
  const lockText = readText(CARGO_LOCK)
  if (!pkg || !tauri || cargoText === null || lockText === null) return

  const versions = [
    [PACKAGE_JSON, pkg.version],
    [TAURI_CONF, tauri.version],
    [CARGO_TOML, cargoPackageVersion(cargoText)],
    [CARGO_LOCK, cargoLockVersion(lockText)],
  ]
  for (const [file, value] of versions) {
    if (!value) fail(file + ' has no readable version', 'fix the file, then run the preflight again')
    else if (!SEMVER.test(value)) fail(file + ' version "' + value + '" is not semver')
  }

  const unique = new Set(versions.map(([, value]) => value).filter(Boolean))
  if (unique.size === 1) {
    pass('version fields agree: ' + [...unique][0])
  } else {
    warn(
      'version fields disagree: ' + versions.map(([file, value]) => file + '=' + value).join(', '),
      'the release workflow sets all four from the tag; keeping them equal avoids a confusing local build',
    )
  }

  if (pkg.scripts && pkg.scripts.verify && pkg.scripts.build && pkg.scripts['release:check']) {
    pass('package scripts: verify, build, release:check')
  } else {
    fail('package.json is missing verify, build or release:check script', 'restore the scripts before releasing')
  }
  if (!pkg.packageManager) {
    warn('package.json has no packageManager field', 'optional: pin pnpm so local and CI use the same version')
  }
  if (exists('pnpm-lock.yaml')) pass('pnpm-lock.yaml exists')
  else fail('pnpm-lock.yaml is missing', 'commit the lockfile')
  if (exists('src-tauri/Cargo.lock')) pass('src-tauri/Cargo.lock exists')
  else fail('src-tauri/Cargo.lock is missing', 'commit the lockfile')

  const check = run(process.execPath, ['scripts/set-version.mjs', '--check', version])
  if (check.ok) pass('set-version --check ' + version + ' passed')
  else fail('set-version --check ' + version + ' failed', check.err || check.out || 'fix the version files or scripts/set-version.mjs')
}

function checkTauri() {
  const tauri = readJson(TAURI_CONF)
  if (!tauri) return

  if (tauri.bundle && tauri.bundle.active === true) pass('Tauri bundle is active')
  else fail('Tauri bundle.active is not true', 'enable bundle.active in tauri.conf.json')

  const before = (tauri.build && tauri.build.beforeBuildCommand) || ''
  if (/\bpnpm build\b/.test(before)) pass('beforeBuildCommand runs pnpm build')
  else fail('beforeBuildCommand does not run pnpm build', 'set build.beforeBuildCommand to "pnpm build"')

  const frontendDist = tauri.build && tauri.build.frontendDist
  if (!frontendDist) {
    fail('build.frontendDist is missing')
  } else if (existsAbs(resolve(ROOT, 'src-tauri', frontendDist))) {
    pass('frontendDist exists: ' + frontendDist)
  } else {
    warn('frontendDist does not exist yet: ' + frontendDist, 'run pnpm build before the deep packaging check')
  }

  const icons = tauri.bundle && tauri.bundle.icon
  if (!Array.isArray(icons) || icons.length === 0) {
    fail('bundle.icon is empty', 'restore the icon list in tauri.conf.json')
  } else {
    let all = true
    for (const icon of icons) {
      if (existsAbs(resolve(ROOT, 'src-tauri', icon))) pass('bundle icon exists: ' + icon)
      else {
        all = false
        fail('bundle icon is missing: ' + icon, 'run pnpm icon or restore the file')
      }
    }
    if (all) pass('all bundle icons exist')
  }

  for (const icon of ['src-tauri/icons/icon.ico', 'src-tauri/icons/icon.icns']) {
    if (exists(icon)) pass(icon + ' exists')
    else fail(icon + ' is missing', 'run pnpm icon or restore the file; packaging needs it')
  }

  const targets = tauri.bundle && tauri.bundle.targets
  const list = Array.isArray(targets) ? targets : targets === 'all' ? ['app', 'dmg', 'nsis'] : []
  if (list.includes('app') && list.includes('dmg')) pass('bundle targets include app and dmg')
  else fail('bundle targets do not include app and dmg', 'keep app/dmg for macOS; the release workflow overrides Windows with nsis')
}

function checkGeneratedFiles() {
  for (const file of [
    'src/assets/fileIcons.generated.ts',
    'src/vendor/prettier',
    'public/theme-boot.js',
    'index.html',
  ]) {
    if (exists(file)) pass(file + ' exists')
    else fail(file + ' is missing', 'restore generated or vendored files before packaging')
  }
}

function checkWorkflowPatterns(file, text, patterns) {
  for (const [pattern, label, hint] of patterns) {
    if (pattern.test(text)) pass(file + ': ' + label)
    else fail(file + ': missing ' + label, hint)
  }
}

function stripWorkflowComments(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

function checkWorkflows() {
  const releaseText = readText(WORKFLOW_RELEASE)
  const ciText = readText(WORKFLOW_CI)
  if (releaseText === null || ciText === null) return
  const releaseCode = stripWorkflowComments(releaseText)
  const ciCode = stripWorkflowComments(ciText)

  checkWorkflowPatterns(WORKFLOW_RELEASE, releaseCode, [
    [/tags:\s*\["v\*"\]/, 'v* tag trigger', 'restore the tag trigger in release.yml'],
    [/workflow_dispatch:/, 'workflow_dispatch trigger', 'restore manual dispatch'],
    [/description:\s*"?Version to build and publish/, 'workflow_dispatch version input', 'restore the version input'],
    [/node scripts\/set-version\.mjs/, 'set-version step', 'the build must set the version from the tag'],
    [/pnpm check\b/, 'pnpm check step', 'run the frontend guards before packaging'],
    [/pnpm tauri build\b/, 'tauri build step', 'restore the release build step'],
    [/node scripts\/make-latest-json\.mjs/, 'latest.json generation', 'restore manifest generation'],
    [/dist\/latest\.json/, 'latest.json upload', 'latest.json must ship with the installers'],
    [/fail_on_unmatched_files:\s*true/, 'fail_on_unmatched_files', 'do not publish a release with missing assets'],
    [/contents:\s*write/, 'contents: write', 'the release job needs write permission'],
    [/softprops\/action-gh-release@v2/, 'GitHub release action', 'restore the publish step'],
    [/actions\/upload-artifact@v4/, 'artifact upload', 'restore artifact upload'],
    [/actions\/download-artifact@v4/, 'artifact download', 'restore artifact download'],
    [/pnpm install --frozen-lockfile/, 'frozen lockfile install', 'CI must install from the lockfile'],
    [/src-tauri\/icons\/icon\.ico/, 'Windows icon prerequisite', 'Windows packaging requires icon.ico'],
    [/needs:\s*version/, 'build depends on version', 'the version job must run first'],
    [/needs:\s*\[version, build\]/, 'release depends on build', 'do not publish before both builds finish'],
    [/tag_name:\s*v\$\{\{\s*needs\.version\.outputs\.value\s*\}\}/, 'tag_name from version', 'the release tag must come from the resolved version'],
    [/contains\(needs\.version\.outputs\.value,\s*'-'\)/, 'prerelease detection', 'prerelease versions must not become latest'],
  ])

  checkWorkflowPatterns(WORKFLOW_CI, ciCode, [
    [/tags:\s*\["v\*"\]/, 'v* tag trigger', 'CI must run for release tags'],
    [/pull_request:/, 'pull_request trigger', 'restore pull request checks'],
    [/pnpm check\b/, 'pnpm check', 'restore the frontend guard step'],
    [/pnpm build\b/, 'pnpm build', 'restore the frontend build step'],
    [/cargo test\b/, 'cargo test', 'restore the Rust test step'],
    [/src-tauri\/icons\/icon\.ico/, 'Windows icon prerequisite', 'Windows packaging requires icon.ico'],
    [/node-version:\s*22/, 'Node 22', 'match the release workflow Node version'],
    [/\bversion:\s*10\b/, 'pnpm 10', 'match the release workflow pnpm version'],
  ])

  for (const [key, target] of Object.entries(RELEASE_TARGETS)) {
    const label = WORKFLOW_RELEASE + ': ' + key + ' matrix'
    const patterns = [
      [new RegExp('os:\\s*' + escapeRe(target.runner)), 'runner ' + target.runner],
      [new RegExp('target:\\s*' + escapeRe(target.target)), 'target ' + target.target],
      [new RegExp('bundles:\\s*' + escapeRe(target.bundles)), 'bundles ' + target.bundles],
      [new RegExp('bundle_dir:\\s*' + escapeRe(target.bundleDir)), 'bundle_dir ' + target.bundleDir],
      [new RegExp('asset_prefix:\\s*' + escapeRe(target.assetPrefix)), 'asset_prefix ' + target.assetPrefix],
      [new RegExp('extension:\\s*' + escapeRe(target.extension)), 'extension ' + target.extension],
      [new RegExp('rust_targets:\\s*' + escapeRe(target.rustTargets.join(','))), 'rust_targets ' + target.rustTargets.join(',')],
    ]
    for (const [pattern, labelText] of patterns) {
      if (pattern.test(releaseCode)) pass(label + ': ' + labelText)
      else fail(label + ': missing ' + labelText, 'update the workflow matrix or scripts/release-targets.mjs together')
    }
  }

  for (const [file, text] of [
    [WORKFLOW_RELEASE, releaseCode],
    [WORKFLOW_CI, ciCode],
  ]) {
    for (const match of text.matchAll(/node\s+(scripts\/[\w.-]+\.mjs)/g)) {
      if (exists(match[1])) pass(file + ': ' + match[1] + ' exists')
      else fail(file + ': references missing ' + match[1], 'restore the script or update the workflow')
    }
  }

  if (!/^\s+branches:\s*\[?['"]?main/m.test(ciCode)) {
    warn('ci.yml does not run on main pushes', 'consider adding branches: [main] under push; this check does not change workflows')
  }
  if (!/cargo test/.test(releaseCode)) {
    warn('release.yml does not run cargo test; ci.yml does', 'the preflight runs cargo test locally; gate the release on CI if you want it enforced')
  }

  const ruby = run('ruby', [
    '-e',
    'require "yaml"; ARGV.each { |f| YAML.load_file(f) }',
    join(ROOT, WORKFLOW_CI),
    join(ROOT, WORKFLOW_RELEASE),
  ])
  if (ruby.ok) pass('workflow YAML parses')
  else if (ruby.error && ruby.error.code === 'ENOENT') {
    warn('Ruby is not available; skipped workflow YAML syntax parse', 'optional: install Ruby or run actionlint')
  } else {
    fail('workflow YAML does not parse', ruby.err)
  }
}

function checkManifestSmoke(repoSlug, version) {
  const temp = mkdtempSync(join(tmpdir(), 'tide-release-check-'))
  try {
    writeFileSync(join(temp, 'tide-macos-' + version + '.dmg'), 'fake macOS installer')
    writeFileSync(join(temp, 'tide-win-' + version + '.exe'), 'fake Windows installer')
    const result = run(process.execPath, [
      'scripts/make-latest-json.mjs',
      '--dist',
      temp,
      '--version',
      version,
      '--repo',
      repoSlug,
    ])
    if (!result.ok) {
      fail('make-latest-json smoke test failed', result.err || result.out)
      return
    }

    const manifestPath = join(temp, 'latest.json')
    if (!existsSync(manifestPath)) {
      fail('make-latest-json did not write latest.json')
      return
    }

    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (err) {
      fail('latest.json is not valid JSON: ' + err.message)
      return
    }
    if (!manifest || typeof manifest !== 'object') {
      fail('latest.json is not an object')
      return
    }

    if (manifest.version !== version) fail('latest.json version is ' + manifest.version + ', expected ' + version)
    else if (manifest.tag !== 'v' + version) fail('latest.json tag is ' + manifest.tag + ', expected v' + version)
    else if (manifest.pageUrl !== 'https://github.com/' + repoSlug + '/releases/tag/v' + version) {
      fail('latest.json pageUrl is wrong')
    } else pass('latest.json smoke test: version/tag/pageUrl')

    for (const [key, target] of Object.entries(RELEASE_TARGETS)) {
      const name = target.assetPrefix + '-' + version + '.' + target.extension
      const asset = manifest.assets && manifest.assets[key]
      if (!asset) fail('latest.json is missing the ' + key + ' asset')
      else if (asset.name !== name) fail('latest.json ' + key + ' name is ' + asset.name + ', expected ' + name)
      else if (asset.url !== 'https://github.com/' + repoSlug + '/releases/download/v' + version + '/' + name) {
        fail('latest.json ' + key + ' URL is wrong')
      } else if (!Number.isInteger(asset.size) || asset.size <= 0) fail('latest.json ' + key + ' size is invalid')
      else if (!/^[a-f0-9]{64}$/.test(asset.sha256)) fail('latest.json ' + key + ' sha256 is invalid')
      else pass('latest.json smoke test: ' + key + ' asset')
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }

  const duplicate = mkdtempSync(join(tmpdir(), 'tide-release-check-dup-'))
  try {
    writeFileSync(join(duplicate, 'tide-macos-' + version + '.dmg'), 'one')
    writeFileSync(join(duplicate, 'tide-macos-' + version + '-2.dmg'), 'two')
    writeFileSync(join(duplicate, 'tide-win-' + version + '.exe'), 'win')
    const result = run(process.execPath, [
      'scripts/make-latest-json.mjs',
      '--dist',
      duplicate,
      '--version',
      version,
      '--repo',
      repoSlug,
    ])
    if (result.ok) fail('make-latest-json accepted two macOS installers', 'it must fail instead of picking one silently')
    else pass('make-latest-json rejects duplicate installers')
  } finally {
    rmSync(duplicate, { recursive: true, force: true })
  }
}

function checkUpdater(repoSlug, version) {
  const update = readText(UPDATE_RS)
  if (update === null) return

  const repoMatch = /const REPO: &str = "([^"]+)"/.exec(update)
  if (!repoMatch) fail('update.rs has no REPO constant', 'restore the release repository constant')
  else if (repoSlug && repoMatch[1] !== repoSlug) {
    fail('update.rs REPO is ' + repoMatch[1] + ', origin is ' + repoSlug, 'make them match or the updater will read another repository')
  } else if (repoSlug) pass('update.rs REPO matches origin: ' + repoSlug)

  for (const fragment of ['/releases/latest/download/latest.json', '/releases/download/{tag}/latest.json']) {
    if (update.includes(fragment)) pass('update.rs uses ' + fragment)
    else fail('update.rs is missing ' + fragment, 'keep the manifest URLs aligned with the release workflow')
  }

  if (repoSlug) checkManifestSmoke(repoSlug, version)
}

function checkToolchain() {
  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor === 22) pass('Node ' + process.versions.node + ' matches CI (22)')
  else warn('Node ' + process.versions.node + ' differs from CI (22)')

  const pnpm = run('pnpm', ['--version'])
  if (!pnpm.ok) {
    warn('pnpm is not available', 'install pnpm 10')
  } else if (pnpm.out.replace(/^v/, '').split('.')[0] === '10') {
    pass('pnpm ' + pnpm.out + ' matches CI (10)')
  } else {
    warn('pnpm ' + pnpm.out + ' differs from CI (10)', 'use the same major locally to avoid lockfile surprises')
  }

  const rustc = run('rustc', ['--version'])
  if (!rustc.ok) {
    warn('rustc is not available', 'install the stable Rust toolchain')
  } else {
    const match = /rustc\s+(\d+)\.(\d+)\.(\d+)/.exec(rustc.out)
    const cargoText = readText(CARGO_TOML)
    const required = cargoText && /rust-version\s*=\s*"(\d+)\.(\d+)"/.exec(cargoText)
    if (match && required) {
      const installed = [Number(match[1]), Number(match[2])]
      const needed = [Number(required[1]), Number(required[2])]
      if (installed[0] > needed[0] || (installed[0] === needed[0] && installed[1] >= needed[1])) {
        pass('rustc ' + match[1] + '.' + match[2] + ' meets rust-version ' + required[1] + '.' + required[2])
      } else {
        fail('rustc ' + match[1] + '.' + match[2] + ' is older than rust-version ' + required[1] + '.' + required[2], 'update Rust before releasing')
      }
    } else {
      pass('rustc is available')
    }
  }

  const targets =
    process.platform === 'darwin'
      ? RELEASE_TARGETS.macos.rustTargets
      : process.platform === 'win32'
        ? RELEASE_TARGETS.windows.rustTargets
        : []
  if (targets.length === 0) {
    warn('deep packaging is only supported on macOS and Windows')
    return
  }

  const rustup = run('rustup', ['target', 'list', '--installed'])
  if (!rustup.ok) {
    warn('rustup is not available; cannot check installed Rust targets', 'install rustup if you plan to run the deep packaging check')
    return
  }
  const installed = new Set(rustup.out.split(/\s+/).filter(Boolean))
  for (const target of targets) {
    if (installed.has(target)) pass('Rust target installed: ' + target)
    else warn('Rust target ' + target + ' is not installed; the deep packaging check will fail', 'rustup target add ' + target)
  }
}

function printReport() {
  for (const message of passes) console.log('PASS  ' + message)
  for (const warning of warnings) {
    console.warn('WARN  ' + warning.message)
    if (warning.hint) console.warn('      ' + warning.hint)
  }
  for (const failure of failures) {
    console.error('FAIL  ' + failure.message)
    if (failure.hint) console.error('      ' + failure.hint)
  }

  const summary =
    failures.length + ' failure(s), ' + warnings.length + ' warning(s), ' + passes.length + ' passed'
  if (failures.length > 0) {
    console.error('\n' + summary)
    process.exitCode = 1
  } else {
    console.log('\n' + summary)
  }
}

console.log('Release preflight: ' + version + (allowDirty ? ' (allow dirty)' : ''))
const repoSlug = checkGit(version)
checkVersions(version)
checkTauri()
checkGeneratedFiles()
checkWorkflows()
checkUpdater(repoSlug, version)
checkToolchain()
warn('remote tags/releases/CI were not checked', 'run git fetch --tags and watch Actions after pushing')
printReport()
