#!/usr/bin/env node
/** Route paths exactly, or recommend candidates using bounded area metadata. */
import { statSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_TARGET, explainPathRoutes, parseRouteArgs, queryAreaDocs, readAreaDocs, roughTokens,
} from './ai-docs-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')

function normalizePath(path) {
  const repoRelative = isAbsolute(path) ? relative(ROOT, path) : path
  return repoRelative.replace(/^\.\//, '').split('\\').join('/')
}

const options = parseRouteArgs(process.argv.slice(2))
if (options.error) {
  console.error(options.error)
  console.error('Usage: pnpm docs:route [--explain] <repo-relative-file> [...more files]')
  console.error('       pnpm docs:route --query "task description"')
  process.exit(1)
}

let docs
try {
  docs = readAreaDocs(AI_DIR)
} catch (error) {
  console.error('.ai/' + error.message)
  process.exit(1)
}
const paths = [...new Set(options.paths.map(normalizePath).filter(Boolean))]
const candidates = options.query !== null
const loaded = candidates ? queryAreaDocs(docs, options.query) : explainPathRoutes(docs, paths)
if (loaded.length === 0) {
  console.log(candidates ? 'No area docs match the query. Locate code, then route its paths.'
    : 'No area docs match the supplied paths.')
} else {
  console.log(candidates ? 'Candidates (locate code and confirm path scopes before loading):'
    : 'Load ' + loaded.length + ' area doc(s):')
}
let loadedBytes = 0
for (const record of loaded) {
  const size = statSync(record.file).size
  loadedBytes += size
  console.log('- .ai/' + record.doc + ' — ' + record.summary + ' (' + (size / 1024).toFixed(2)
    + 'KB, ~' + roughTokens(size) + ' tokens)')
  if (candidates) {
    const reasons = [...record.keywordsMatched.map((word) => 'keyword: ' + word),
      ...record.summaryMatched.map((word) => 'summary: ' + word)]
    console.log('  score ' + record.score + '; ' + reasons.join('; '))
  } else if (options.explain) {
    for (const { path, glob } of record.matches) console.log('  ' + path + ' matches ' + glob)
  }
}
const resident = ['AGENTS.md', '.ai/context.md'].reduce((sum, file) => sum + statSync(join(ROOT, file)).size, 0)
const total = resident + loadedBytes
console.log('Resident: ' + resident + ' bytes; ' + (candidates ? 'candidate' : 'routed') + ' docs: '
  + loadedBytes + ' bytes; bundle: ' + total + ' bytes (~' + roughTokens(total)
  + ' tokens; rough bytes/4 estimate).')
if (total > BUNDLE_TARGET) console.log('Above 16KB target; all matches retained. Narrow the task before loading candidates.')
