#!/usr/bin/env node
/** Print only the area docs whose frontmatter scope matches the supplied repo paths. */
import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAreaMetadataFile, resolveAreaDocsForPaths, roughTokens } from './ai-docs-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')

function normalizePath(path) {
  const repoRelative = isAbsolute(path) ? relative(ROOT, path) : path
  return repoRelative.replace(/^\.\//, '').split('\\').join('/')
}

const paths = process.argv.slice(2).map(normalizePath).filter(Boolean)
if (paths.length === 0) {
  console.error('Usage: pnpm docs:route <repo-relative-file> [...more files]')
  process.exit(1)
}

const docs = []
for (const name of readdirSync(AI_DIR).sort((a, b) => a.localeCompare(b))) {
  if (!name.endsWith('.md') || name === 'context.md') continue
  const file = join(AI_DIR, name)
  if (!statSync(file).isFile()) continue
  const metadata = readAreaMetadataFile(file)
  if (metadata.error) {
    console.error(`.ai/${name}: ${metadata.error}`)
    process.exit(1)
  }
  docs.push({ doc: name, file, summary: metadata.summary, scope: metadata.scope })
}

const loaded = resolveAreaDocsForPaths(docs, paths)
if (loaded.length === 0) {
  console.log('No area docs match the supplied paths.')
  process.exit(0)
}

console.log(`Load ${loaded.length} area doc(s):`)
for (const name of loaded) {
  const record = docs.find((candidate) => candidate.doc === name)
  const size = statSync(record.file).size
  console.log(
    `- .ai/${name} — ${record.summary} (${(size / 1024).toFixed(2)}KB, ~${roughTokens(size)} tokens)`,
  )
}
