#!/usr/bin/env node
/** Regenerate only the route table inside .ai/context.md from area-doc frontmatter. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAreaDocs, syncGeneratedRoutes } from './ai-docs-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')
const CONTEXT_FILE = join(AI_DIR, 'context.md')

let entries
try {
  entries = readAreaDocs(AI_DIR)
} catch (error) {
  console.error('.ai/' + error.message)
  process.exit(1)
}

const context = readFileSync(CONTEXT_FILE, 'utf8')
const result = syncGeneratedRoutes(context, entries)
if (result.error) {
  console.error(`.ai/context.md: ${result.error}`)
  process.exit(1)
}

if (result.text === context) {
  console.log('AI doc routes are already current.')
} else {
  writeFileSync(CONTEXT_FILE, result.text)
  console.log(`Updated AI doc routes for ${entries.length} area docs.`)
}
