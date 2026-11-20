#!/usr/bin/env node
/** Regenerate only the route table inside .ai/context.md from area-doc frontmatter. */
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAreaMetadataFile, syncGeneratedRoutes } from './ai-docs-lib.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const AI_DIR = join(ROOT, '.ai')
const CONTEXT_FILE = join(AI_DIR, 'context.md')

const entries = []
for (const name of readdirSync(AI_DIR).sort((a, b) => a.localeCompare(b))) {
  if (!name.endsWith('.md') || name === 'context.md' || !statSync(join(AI_DIR, name)).isFile()) {
    continue
  }
  const metadata = readAreaMetadataFile(join(AI_DIR, name))
  if (metadata.error) {
    console.error(`.ai/${name}: ${metadata.error}`)
    process.exit(1)
  }
  entries.push({ doc: name, summary: metadata.summary })
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
