#!/usr/bin/env node
/**
 * Guard: a `$var` in a workflow must not be immediately followed by a non-ASCII character
 * (Chinese punctuation, Han characters).
 *
 * When bash parses `$apple_cert，`, the full-width comma bytes may be counted as part of the variable
 * name — so it looks for a variable called `apple_cert<bytes>` and, under `set -u`, fails with
 * "apple_cert: unbound variable". Local macOS bash 3.2 cannot reproduce it, but the release workflow
 * on the runner dies like this in the very first step.
 *
 * The fix is simple: `${apple_cert}，`. This script only scans plain text, it does not parse YAML.
 *
 * Usage: pnpm check:workflows
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const WORKFLOWS = join(ROOT, '.github/workflows')

/**
 * `$name` immediately followed by a non-ASCII character.
 * A trailing newline / CR is not part of this rule: workflows checked out on Windows runners are
 * often CRLF, so only decide after `split(/\r?\n/)`, otherwise a legit line like
 * `-Password $password` gets flagged as "followed by Chinese".
 */
const RISKY = /\$[A-Za-z_][A-Za-z0-9_]*[^\x20-\x7e]/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.ya?ml$/.test(full)) out.push(full)
  }
  return out
}

const findings = []

for (const file of walk(WORKFLOWS)) {
  const rel = relative(ROOT, file)
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      // Comments are not expanded by bash, skip them
      if (line.trim().startsWith('#')) return
      for (const match of line.matchAll(RISKY)) {
        // Wrap just the non-ASCII character, so the log does not look like nothing follows the variable name
        const hit = match[0]
        const char = hit.slice(-1)
        findings.push(`${rel}:${index + 1}  ${hit.slice(0, -1)}「${char}」`)
      }
    })
}

if (findings.length === 0) {
  console.log('No `$variable` immediately followed by Chinese in workflows.')
  process.exit(0)
}

console.error(`Found ${findings.length} place(s) where \`$variable\` is immediately followed by a non-ASCII character (use \${variable}):`)
for (const finding of findings) console.error(`  ${finding}`)
process.exit(1)
