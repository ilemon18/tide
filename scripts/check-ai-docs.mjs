#!/usr/bin/env node
/**
 * Guard: AI docs must not point at things that no longer exist.
 *
 * `.ai/*.md` is the context agents load at the start of every session, so a stale path or a stale
 * `pnpm xxx` costs a wasted turn each time it is read — and it stays wrong for months because nobody
 * reads the doc in a review. Two cheap checks catch nearly all of it:
 *
 * 1. every repo path written in backticks / links exists;
 * 2. every `pnpm <script>` written in the doc is a real script in package.json.
 *
 * The size cap is only a warning: splitting a file is a judgement call, not a build error.
 *
 * Usage: pnpm check:docs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const CONTEXT_LIMIT = 10 * 1024
const OTHER_LIMIT = 8 * 1024

/** Repo-relative prefixes we check for existence (everything else in a doc is prose) */
const REPO_PREFIXES = [
  '.ai/',
  '.github/',
  'assets/',
  'docs/',
  'public/',
  'release/',
  'scripts/',
  'src/',
  'src-tauri/',
  'website/',
]

/** `pnpm` subcommands that are not entries in package.json `scripts` */
const PNPM_BUILTINS = new Set(['add', 'exec', 'install', 'ls', 'remove', 'run', 'store', 'update', 'why'])

const problems = []
const warnings = []

function fail(message) {
  problems.push(message)
}

/** Read a doc, one line per entry, so findings can say `file:line` */
function readLines(file) {
  return readFileSync(file, 'utf8').split(/\r?\n/)
}

/** Inline code spans plus markdown link targets: the only places a path is meant literally */
function pathTokensIn(line) {
  const tokens = []
  for (const match of line.matchAll(/`([^`]+)`/g)) tokens.push(match[1])
  for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) tokens.push(match[1])
  return tokens
}

/** `src-tauri/src/commands/{fs,git}.rs` -> both files; keeps the doc compact without lying */
function expandBraces(token) {
  const match = /\{([^{}]*)\}/.exec(token)
  if (!match) return [token]
  const [whole, body] = [match[0], match[1]]
  return body
    .split(',')
    .flatMap((part) =>
      expandBraces(token.slice(0, match.index) + part.trim() + token.slice(match.index + whole.length)),
    )
}

function isRepoPath(token) {
  if (REPO_PREFIXES.some((prefix) => token.startsWith(prefix))) return true
  // Links between AI docs are written relative (`./checks.md`, `../README.md`)
  return token.startsWith('./') || token.startsWith('../')
}

/** Strip the decoration docs put around a path: trailing comma / full stop / parenthetical note */
function cleanToken(token) {
  return token
    .replace(/[，、]+$/, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+.*$/, '')
}

const files = readdirSync(AI_DIR)
  .filter((name) => name.endsWith('.md'))
  .map((name) => join(AI_DIR, name))

if (files.length === 0) {
  fail('.ai/ contains no markdown file')
}

for (const file of files) {
  const rel = relative(ROOT, file)
  const size = statSync(file).size
  const limit = file.endsWith('context.md') ? CONTEXT_LIMIT : OTHER_LIMIT
  if (size > limit) {
    warnings.push(`${rel} is ${(size / 1024).toFixed(1)}KB (soft limit ${limit / 1024}KB) — split it`)
  }

  const lines = readLines(file)

  lines.forEach((line, index) => {
    for (const raw of pathTokensIn(line)) {
      const token = cleanToken(raw)
      if (!token || !isRepoPath(token)) continue
      // Globs and `<placeholder>` are patterns, not paths
      if (/[*<>$|]/.test(token)) continue

      for (const candidate of expandBraces(token)) {
        // Relative links resolve against the doc that contains them, repo paths against the root
        const target = candidate.startsWith('./') || candidate.startsWith('../')
          ? resolve(file, '..', candidate)
          : join(ROOT, candidate.split('/').join(sep))
        if (!existsSync(target)) fail(`${rel}:${index + 1}  ${candidate} does not exist`)
      }
    }
  })

  // `pnpm <script>`: the doc tells the agent to run it, so the script has to be there
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\bpnpm (?:run )?([a-z][\w:-]*)/g)) {
      const script = match[1]
      if (script in PKG.scripts || PNPM_BUILTINS.has(script)) continue
      fail(`${rel}:${index + 1}  pnpm ${script} is not a script in package.json`)
    }
  })
}

if (warnings.length > 0) {
  console.warn('Warnings:')
  for (const warning of warnings) console.warn(`  - ${warning}`)
}

if (problems.length === 0) {
  console.log(`AI docs check passed (${files.length} file(s)).`)
  process.exit(0)
}

console.error(`Found ${problems.length} stale reference(s) in .ai/:`)
for (const problem of problems) console.error(`  ${problem}`)
console.error('\nFix the doc if the code moved, or fix the path if it was a typo.')
process.exit(1)
