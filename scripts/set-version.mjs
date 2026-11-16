#!/usr/bin/env node
/**
 * The single entry point for the app version number.
 *
 *   node scripts/set-version.mjs 0.0.2      # or v0.0.2, both forms work
 *
 * Idempotently rewrites four files:
 *   package.json                .version
 *   src-tauri/tauri.conf.json   .version
 *   src-tauri/Cargo.toml        only the version line inside [package]
 *   src-tauri/Cargo.lock        only the [[package]] entry with name = "tide"
 *
 * Any surprise exits non-zero with a clear reason: missing file, invalid version,
 * or a section / entry that did not match exactly once.
 *
 * CI runs it when tagging, so the tag, the About page and the installer always share one version.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_JSON = 'package.json'
const TAURI_CONF = 'src-tauri/tauri.conf.json'
const CARGO_TOML = 'src-tauri/Cargo.toml'
const CARGO_LOCK = 'src-tauri/Cargo.lock'

/** semver.org; groups: major, minor, patch, prerelease, build */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

// Cargo.toml: only accept the version line between [package] and the next section
const PACKAGE_SECTION = /^\s*\[package\]\s*$/
const ANY_SECTION = /^\s*\[[^\]]+\]\s*$/
const PACKAGE_VERSION_LINE = /^(\s*version\s*=\s*")([^"]*)(")/

// Cargo.lock: cargo writes name before version inside [[package]],
// so match them as a pair, otherwise a dependency version gets rewritten
const LOCK_ENTRY = /(\[\[package\]\]\r?\nname = "tide"\r?\nversion = ")([^"\r\n]*)(")/

function fail(message) {
  console.error(`\n[set-version] error: ${message}\n`)
  process.exit(1)
}

function read(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), 'utf8')
  } catch (err) {
    fail(`cannot read ${relPath}: ${err.message}`)
  }
}

function writeIfChanged(relPath, next) {
  if (read(relPath) === next) return false
  writeFileSync(join(ROOT, relPath), next, 'utf8')
  return true
}

const detectEol = (text) => (text.includes('\r\n') ? '\r\n' : '\n')

// Replace that line precisely instead of parse + stringify: serializing re-wraps every array in the
// file, so a single version bump becomes a dozens-of-lines diff. Both files have one top-level "version" key.
const JSON_VERSION_FIELD = /^(\s*"version"\s*:\s*")([^"}]*)(\s*")/gm

function rewriteJson(relPath, version) {
  const raw = read(relPath)
  try {
    JSON.parse(raw)
  } catch (err) {
    fail(`${relPath} is not valid JSON: ${err.message}`)
  }
  const matches = [...raw.matchAll(JSON_VERSION_FIELD)]
  if (matches.length !== 1) {
    fail(`${relPath}: expected exactly one "version" field, found ${matches.length}`)
  }
  const previous = matches[0][2]
  const text = raw.replace(JSON_VERSION_FIELD, (_m, head, _old, tail) => `${head}${version}${tail}`)
  return { previous, text }
}

function rewriteCargoToml(version) {
  const raw = read(CARGO_TOML)
  const eol = detectEol(raw)
  const lines = raw.split(/\r?\n/)
  let inPackage = false
  let previous = null

  for (let i = 0; i < lines.length; i += 1) {
    if (PACKAGE_SECTION.test(lines[i])) {
      inPackage = true
      continue
    }
    if (inPackage && ANY_SECTION.test(lines[i])) {
      inPackage = false
      continue
    }
    if (!inPackage || previous !== null) continue
    const match = PACKAGE_VERSION_LINE.exec(lines[i])
    if (match) {
      previous = match[2]
      lines[i] = `${match[1]}${version}${match[3]}`
    }
  }

  if (previous === null) {
    fail(`${CARGO_TOML}: no version line found in [package]`)
  }
  return { previous, text: lines.join(eol) }
}

function rewriteCargoLock(version) {
  const raw = read(CARGO_LOCK)
  const matches = [...raw.matchAll(new RegExp(LOCK_ENTRY.source, 'g'))]
  if (matches.length !== 1) {
    fail(`${CARGO_LOCK}: expected exactly one [[package]] with name = "tide", found ${matches.length}`)
  }
  const previous = matches[0][2]
  const text = raw.replace(LOCK_ENTRY, (_m, head, _old, tail) => `${head}${version}${tail}`)
  return { previous, text }
}

const requested = (process.argv[2] ?? '').trim()
if (!requested) {
  fail('missing version argument; usage: node scripts/set-version.mjs vX.Y.Z')
}

const version = requested.replace(/^v(?=\d)/, '')
if (!SEMVER.test(version)) {
  fail(`"${requested}" is not valid semver (expected MAJOR.MINOR.PATCH[-prerelease])`)
}
if (version !== requested) {
  console.log(`[set-version] stripped tag prefix: ${requested} -> ${version}`)
}

const results = []
for (const relPath of [PACKAGE_JSON, TAURI_CONF]) {
  const { previous, text } = rewriteJson(relPath, version)
  results.push({ file: relPath, previous, written: writeIfChanged(relPath, text) })
}
{
  const { previous, text } = rewriteCargoToml(version)
  results.push({ file: CARGO_TOML, previous, written: writeIfChanged(CARGO_TOML, text) })
}
{
  const { previous, text } = rewriteCargoLock(version)
  results.push({ file: CARGO_LOCK, previous, written: writeIfChanged(CARGO_LOCK, text) })
}

// Read everything back: never trust "it was written"
if (JSON.parse(read(PACKAGE_JSON)).version !== version) {
  fail(`${PACKAGE_JSON} verification failed`)
}
if (JSON.parse(read(TAURI_CONF)).version !== version) {
  fail(`${TAURI_CONF} verification failed`)
}
{
  const section = read(CARGO_TOML).split(/^\s*\[package\]\s*$/m)[1]
  // [package] body runs up to the next section header
  const body = section === undefined ? '' : section.split(/^\s*\[[^\]]+\]\s*$/m)[0]
  const found = body
    .split(/\r?\n/)
    .map((line) => PACKAGE_VERSION_LINE.exec(line))
    .find(Boolean)
  if (!found || found[2] !== version) {
    fail(`${CARGO_TOML} verification failed: [package] has ${found ? found[2] : 'no version line'}`)
  }
}
{
  const entries = [...read(CARGO_LOCK).matchAll(new RegExp(LOCK_ENTRY.source, 'g'))]
  if (entries.length !== 1 || entries[0][2] !== version) {
    fail(`${CARGO_LOCK} verification failed: expected exactly one tide entry with version ${version}`)
  }
}

const width = Math.max(...results.map((r) => r.file.length))
for (const { file, previous, written } of results) {
  console.log(
    `[set-version] ${file.padEnd(width)}  ${previous} -> ${version}  (${written ? 'written' : 'unchanged'})`,
  )
}
console.log(`[set-version] done: ${version}`)
