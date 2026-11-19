#!/usr/bin/env node
/**
 * Guard: AI docs must not point at things that no longer exist.
 *
 * Agents load `.ai/context.md` first and then only routed area docs, so a stale path or a stale
 * `pnpm xxx` costs a wasted turn every time that doc is read. This check validates:
 *
 * 1. every repo path written in backticks / links exists;
 * 2. every `pnpm <script>` written in the doc is a real script in package.json;
 * 3. the on-demand doc set stays within its soft size targets.
 *
 * Size findings are warnings: splitting a file is a judgement call, not a build error.
 *
 * Usage: pnpm check:docs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const CONTEXT_LIMIT = 6 * 1024
const OTHER_LIMIT = 8 * 1024
const AI_TOTAL_TARGET = 48 * 1024
const ROOT_POLICY_FILES = ['AGENTS.md', 'CLAUDE.md']

/** Repo-relative prefixes we check for existence (everything else in a doc is prose) */
const REPO_PREFIXES = [
  '.ai/',
  '.github/',
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  'assets/',
  'docs/',
  'package.json',
  'public/',
  'release/',
  'scripts/',
  'src/',
  'src-tauri/',
  'vite.config.ts',
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

/** Recursively collect Markdown docs so nested skills and future area docs are covered. */
function markdownFilesUnder(dir) {
  const files = []
  if (!existsSync(dir)) return files

  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full)
    }
  }

  walk(dir)
  return files
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
  // Links between docs are written relative (`./editor.md`, `../README.md`)
  return token.startsWith('./') || token.startsWith('../')
}

/** Strip decoration docs put around a path: fragment, punctuation and parenthetical notes */
function cleanToken(token) {
  return token
    .split('#', 1)[0]
    .replace(/[，、]+$/, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\s+.*$/, '')
}

const aiFiles = markdownFilesUnder(AI_DIR)
if (aiFiles.length === 0) fail('.ai/ contains no markdown file')
if (!existsSync(join(AI_DIR, 'context.md'))) fail('.ai/context.md is missing')

const rootPolicyFiles = []
for (const name of ROOT_POLICY_FILES) {
  const file = join(ROOT, name)
  if (!existsSync(file)) fail(`${name} is missing`)
  else rootPolicyFiles.push(file)
}

const files = [...aiFiles, ...rootPolicyFiles]
const aiTotal = aiFiles.reduce((sum, file) => sum + statSync(file).size, 0)
if (aiTotal > AI_TOTAL_TARGET) {
  warnings.push(
    `.ai Markdown is ${(aiTotal / 1024).toFixed(1)}KB (target <= ${AI_TOTAL_TARGET / 1024}KB) — keep only routed, non-duplicated docs`,
  )
}

for (const file of files) {
  const rel = relative(ROOT, file)
  const size = statSync(file).size
  const limit = file === join(AI_DIR, 'context.md') ? CONTEXT_LIMIT : OTHER_LIMIT
  if (size > limit) {
    warnings.push(`${rel} is ${(size / 1024).toFixed(1)}KB (soft limit ${limit / 1024}KB) — split it`)
  }

  const lines = readLines(file)

  lines.forEach((line, index) => {
    for (const raw of pathTokensIn(line)) {
      const token = cleanToken(raw)
      if (!token || !isRepoPath(token)) continue
      // Globs and `<placeholder>` / shell-expansion patterns are not literal paths
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

  // `pnpm <script>`: the doc tells an agent to run it, so the script has to be there
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

console.error(`Found ${problems.length} stale reference(s) in AI docs:`)
for (const problem of problems) console.error(`  - ${problem}`)
console.error('\nFix the doc if the code moved, or fix the path if it was a typo.')
process.exit(1)
