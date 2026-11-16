#!/usr/bin/env node
/**
 * Guard: find Chinese hardcoded in the UI.
 *
 * Chinese comments are house style in this project and are not handled here; this only looks at
 * **string literals**: UI copy must go through `t()` / the glossary, otherwise that spot shows the
 * raw Chinese once the user switches to English / Japanese / Spanish.
 *
 * The allowlist covers only two cases:
 * - developer-facing places (console.* logs), which are not user-facing;
 * - the theme `hint` field: it does not reach any UI today (route it through the glossary if it ever does).
 *
 * Usage: pnpm i18n:scan
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Must go through fileURLToPath: `new URL(...).pathname` is `/D:/a/...` on Windows, so the joined
// path becomes `\D:\a\...` and the CI Windows job cannot read the files at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

// Normalize to forward slashes before comparing, so Windows backslashes do not break the skip rules
const normalize = (path) => path.split(sep).join('/')
const SKIP_DIRS = ['/i18n/', '/vendor/', '/assets/']
const ALLOW_FILES = new Set(['src/theme/palettes.ts'])

const CJK = /[\u4e00-\u9fff]/
const STRING_LITERAL = /'([^'\\]*)'|"([^"\\]*)"|`([^`]*)`/g

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Strip inline comments so quoted words inside a Chinese comment are not mistaken for UI copy */
function stripLineComment(line) {
  const at = line.indexOf('//')
  if (at < 0) return line
  // Simple heuristic: no unclosed quote before `//` (good enough; glossary files are not scanned anyway)
  const before = line.slice(0, at)
  const quotes = (before.match(/'|"|`/g) ?? []).length
  return quotes % 2 === 0 ? before : line
}

const findings = []

for (const file of walk(SRC)) {
  const rel = relative(ROOT, file)
  if (!/\.(ts|tsx)$/.test(file)) continue
  if (SKIP_DIRS.some((dir) => normalize(file).includes(dir))) continue
  if (ALLOW_FILES.has(normalize(rel))) continue

  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((raw, index) => {
    const trimmed = raw.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    // Developer logs are not user-facing
    if (trimmed.includes('console.')) return

    const line = stripLineComment(raw)
    for (const match of line.matchAll(STRING_LITERAL)) {
      const text = match[1] ?? match[2] ?? match[3] ?? ''
      if (CJK.test(text)) {
        findings.push(
          `${normalize(rel)}:${index + 1}  ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`,
        )
        break
      }
    }
  })
}

if (findings.length === 0) {
  console.log('No hardcoded Chinese copy found.')
  process.exit(0)
}

console.error(`Found ${findings.length} place(s) that may be hardcoded Chinese (UI copy should use t()):`)
for (const finding of findings) console.error(`  ${finding}`)
console.error('\nIf a hit really should not be translated (external tool output / data rather than copy), add it to this script allowlist.')
process.exit(1)