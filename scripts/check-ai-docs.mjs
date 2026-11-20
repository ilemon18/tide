#!/usr/bin/env node
/**
 * Guard: AI docs must stay routed, discoverable and honest.
 *
 * Agents load `.ai/context.md` first and then only routed area docs, so a missing route or stale path costs a
 * wasted turn every time that doc is read. This check validates:
 *
 * 1. every top-level area doc is linked from `.ai/context.md` and has `Load when` / `Code` metadata;
 * 2. every skill wrapper has matching frontmatter and links to its canonical `.ai/skills/<name>/SKILL.md`;
 * 3. `CLAUDE.md` imports the root policy instead of maintaining a second copy;
 * 4. repo paths, relative links and `pnpm <script>` names still exist;
 * 5. the on-demand doc set stays within its soft size targets.
 *
 * Size findings are warnings: the budget is a prompt to remove duplication, not a reason to split blindly.
 *
 * Usage: pnpm check:docs
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')
const CONTEXT_FILE = join(AI_DIR, 'context.md')
const SKILLS_DIR = join(AI_DIR, 'skills')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const CONTEXT_LIMIT = 4 * 1024
const OTHER_LIMIT = 6 * 1024
const AI_TOTAL_TARGET = 36 * 1024
const ROOT_POLICY_FILES = ['AGENTS.md', 'CLAUDE.md']

/**
 * Skill wrappers outside `.ai`: each one only links to the canonical skill. A stale link there hides the
 * gate from every agent that discovers skills through that directory, so they get the metadata and path check.
 */
const WRAPPER_DIRS = ['.claude/skills', '.codex/skills', '.agents/skills']

/** Repo-relative prefixes we check for existence (everything else in a doc is prose) */
const REPO_PREFIXES = [
  '.agents/',
  '.ai/',
  '.claude/',
  '.codex/',
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
  const text = readFileSync(file, 'utf8')
  return text.split(/\r?\n/)
}

function isFile(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Recursively collect Markdown docs so nested skills and future area docs are covered. Symlinks are
 * followed once and deduplicated by real path, because `.agents/skills` is linked to `.claude/skills`.
 */
function markdownFilesUnder(dir) {
  const files = []
  const seen = new Set()
  if (!existsSync(dir)) return files

  function walk(current) {
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const entry of entries) {
      const full = join(current, entry.name)
      let isDirectory = entry.isDirectory()
      let isRegularFile = entry.isFile()
      if (entry.isSymbolicLink()) {
        try {
          const stat = statSync(full)
          isDirectory = stat.isDirectory()
          isRegularFile = stat.isFile()
        } catch {
          continue
        }
      }
      if (isDirectory) {
        walk(full)
        continue
      }
      if (!isRegularFile || !entry.name.endsWith('.md')) continue
      const real = realpathSync(full)
      if (seen.has(real)) continue
      seen.add(real)
      files.push(full)
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

function markdownLinkTargets(text) {
  return Array.from(text.matchAll(/\]\(([^)\s]+)\)/g), (match) => match[1])
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

function isPathInside(parent, child) {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line)
    if (field) fields[field[1]] = field[2]
  }
  return fields
}

function roughTokens(bytes) {
  return Math.ceil(bytes / 4)
}

const aiFiles = markdownFilesUnder(AI_DIR)
if (aiFiles.length === 0) fail('.ai/ contains no markdown file')
if (!existsSync(CONTEXT_FILE)) fail('.ai/context.md is missing')

const rootPolicyFiles = []
for (const name of ROOT_POLICY_FILES) {
  const file = join(ROOT, name)
  if (!existsSync(file)) fail(`${name} is missing`)
  else rootPolicyFiles.push(file)
}

const areaDocs = readdirSync(AI_DIR)
  .filter((name) => name.endsWith('.md') && name !== 'context.md' && isFile(join(AI_DIR, name)))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => join(AI_DIR, name))

if (existsSync(CONTEXT_FILE)) {
  const contextText = readFileSync(CONTEXT_FILE, 'utf8')
  const routed = new Set()
  for (const raw of markdownLinkTargets(contextText)) {
    const token = cleanToken(raw)
    if (!token || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(token)) continue
    const target = resolve(dirname(CONTEXT_FILE), token)
    if (existsSync(target) && isFile(target)) routed.add(realpathSync(target))
  }
  for (const doc of areaDocs) {
    if (!routed.has(realpathSync(doc))) {
      fail(`${relative(ROOT, CONTEXT_FILE)} does not route ${relative(ROOT, doc)}`)
    }
  }
}

for (const doc of areaDocs) {
  const rel = relative(ROOT, doc)
  const text = readFileSync(doc, 'utf8')
  if (!/^\*\*Load when:\*\*\s+\S/m.test(text)) fail(`${rel} is missing non-empty **Load when:** metadata`)
  if (!/^\*\*Code:\*\*\s+\S/m.test(text)) fail(`${rel} is missing non-empty **Code:** metadata`)
}

const files = [...aiFiles, ...rootPolicyFiles]
const wrapperFiles = []
const wrapperReal = new Set()
for (const file of WRAPPER_DIRS.flatMap((dir) => markdownFilesUnder(join(ROOT, dir)))) {
  const real = realpathSync(file)
  if (wrapperReal.has(real)) continue
  wrapperReal.add(real)
  wrapperFiles.push(file)
}

for (const file of wrapperFiles.filter((candidate) => basename(candidate) === 'SKILL.md')) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')
  const frontmatter = parseFrontmatter(text)
  const expectedName = basename(dirname(file))
  if (!frontmatter) {
    fail(`${rel} is missing frontmatter`)
  } else {
    if (!frontmatter.name) fail(`${rel} is missing a skill name`)
    else if (frontmatter.name !== expectedName) {
      fail(`${rel} skill name '${frontmatter.name}' must match directory '${expectedName}'`)
    }
    if (!frontmatter.description) fail(`${rel} is missing a skill description`)
  }

  let hasCanonicalLink = false
  for (const raw of markdownLinkTargets(text)) {
    const token = cleanToken(raw)
    if (!token || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(token)) continue
    const target = resolve(dirname(file), token)
    if (!existsSync(target) || !isFile(target)) continue
    const real = realpathSync(target)
    if (isPathInside(SKILLS_DIR, real) && basename(real) === 'SKILL.md') {
      hasCanonicalLink = true
      break
    }
  }
  if (!hasCanonicalLink) fail(`${rel} does not link to a canonical .ai/skills/**/SKILL.md`)
}

if (existsSync(join(ROOT, 'CLAUDE.md'))) {
  const claudeLines = readLines(join(ROOT, 'CLAUDE.md'))
  if (!claudeLines.some((line) => /^@AGENTS\.md\s*$/.test(line))) {
    fail('CLAUDE.md must import AGENTS.md with a standalone @AGENTS.md line')
  }
}

const checkedFiles = [...files]
const checkedReal = new Set(checkedFiles.map((file) => realpathSync(file)))
for (const file of wrapperFiles) {
  const real = realpathSync(file)
  if (checkedReal.has(real)) continue
  checkedReal.add(real)
  checkedFiles.push(file)
}

const aiTotal = aiFiles.reduce((sum, file) => sum + statSync(file).size, 0)
if (aiTotal > AI_TOTAL_TARGET) {
  warnings.push(
    `.ai Markdown is ${(aiTotal / 1024).toFixed(1)}KB (~${roughTokens(aiTotal)} tokens; target <= ${AI_TOTAL_TARGET / 1024}KB) — keep only routed, non-duplicated docs`,
  )
}

for (const file of files) {
  const rel = relative(ROOT, file)
  const size = statSync(file).size
  const limit = file === CONTEXT_FILE ? CONTEXT_LIMIT : OTHER_LIMIT
  if (size > limit) {
    warnings.push(
      `${rel} is ${(size / 1024).toFixed(1)}KB (~${roughTokens(size)} tokens; soft limit ${limit / 1024}KB) — remove duplication or tighten it before splitting`,
    )
  }
}

for (const file of checkedFiles) {
  const rel = relative(ROOT, file)
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
          ? resolve(dirname(file), candidate)
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

console.log(
  `AI docs: ${(aiTotal / 1024).toFixed(1)}KB (~${roughTokens(aiTotal)} tokens, rough bytes/4 estimate)`,
)

if (warnings.length > 0) {
  console.warn('Warnings:')
  for (const warning of warnings) console.warn(`  - ${warning}`)
}

if (problems.length === 0) {
  console.log(`AI docs check passed (${checkedFiles.length} file(s)).`)
  process.exit(0)
}

console.error(`Found ${problems.length} documentation problem(s):`)
for (const problem of problems) console.error(`  - ${problem}`)
console.error('\nFix the route, metadata or link, or update the guard if its contract changed.')
process.exit(1)
