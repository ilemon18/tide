#!/usr/bin/env node
/**
 * Glossary health check.
 *
 * 1. All six locale files have exactly the same keys (type checking catches this too; this is a
 *    quick version that does not need tsc);
 * 2. A key's `{name}` placeholders match across locales, so no "English forgot {path}";
 * 3. Plural entries (separated by ` | `) have a valid form count: single-form languages
 *    (zh / ja / ko) have exactly one;
 * 4. Keys nobody references in the source, and error codes the Rust side emits but the glossary lacks.
 *
 * Usage: pnpm i18n
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Must go through fileURLToPath: `new URL(...).pathname` is `/D:/a/...` on Windows, so the joined
// path becomes `\D:\a\...` and the CI Windows job cannot read the glossary at all.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
// Normalize to forward slashes before comparing, so Windows backslashes do not break the skip rules
const normalize = (path) => path.split(sep).join('/')
const MESSAGES = join(ROOT, 'src/i18n/messages')
const LOCALES = [
  { id: 'en', file: 'en.ts', export: 'en' },
  { id: 'zh-CN', file: 'zh-CN.ts', export: 'zhCN' },
  { id: 'zh-TW', file: 'zh-TW.ts', export: 'zhTW' },
  { id: 'ja', file: 'ja.ts', export: 'ja' },
  { id: 'ko', file: 'ko.ts', export: 'ko' },
  { id: 'es', file: 'es.ts', export: 'es' },
]

const PLURAL_SEPARATOR = ' | '
/** Languages without plural forms: Chinese (simplified / traditional), Japanese and Korean have one form only */
const SINGLE_FORM_LOCALES = new Set(['zh-CN', 'zh-TW', 'ja', 'ko'])

const problems = []
const notes = []

function fail(message) {
  problems.push(message)
}

async function loadCatalog({ file, export: name }) {
  // Dynamic import accepts URLs only: passing `D:\...` directly throws ERR_UNSUPPORTED_ESM_URL_SCHEME on Windows
  const mod = await import(pathToFileURL(join(MESSAGES, file)).href)
  return mod[name]
}

const catalogs = {}
for (const locale of LOCALES) catalogs[locale.id] = await loadCatalog(locale)

const base = catalogs.en
const baseKeys = Object.keys(base)

// ---- 1. Key sets match ---------------------------------------------------
for (const { id } of LOCALES) {
  if (id === 'en') continue
  const keys = new Set(Object.keys(catalogs[id]))
  for (const key of baseKeys) {
    if (!keys.has(key)) fail(`[${id}] missing key ${key}`)
  }
  for (const key of keys) {
    if (!(key in base)) fail(`[${id}] extra key ${key} (not in the English glossary)`)
  }
}

// ---- 2/3. Placeholders and plural forms ----------------------------------
const placeholders = (value) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))

for (const key of baseKeys) {
  const baseForms = base[key].split(PLURAL_SEPARATOR)
  const baseNames = new Set(baseForms.flatMap((form) => [...placeholders(form)]))

  for (const { id } of LOCALES) {
    if (id === 'en') continue
    const value = catalogs[id][key]
    if (value === undefined) continue
    const forms = value.split(PLURAL_SEPARATOR)

    for (const form of forms) {
      for (const name of placeholders(form)) {
        if (!baseNames.has(name)) fail(`[${id}] ${key} uses placeholder {${name}} that English does not have`)
      }
    }
    for (const name of baseNames) {
      if (!forms.some((form) => placeholders(form).has(name))) {
        fail(`[${id}] ${key} is missing placeholder {${name}}`)
      }
    }

    const expected = SINGLE_FORM_LOCALES.has(id) ? 1 : baseForms.length
    if (SINGLE_FORM_LOCALES.has(id)) {
      if (forms.length !== 1) fail(`[${id}] ${key} should be a single form (${id} has no plurals), got ${forms.length} forms`)
    } else if (forms.length !== expected) {
      fail(
        `[${id}] ${key} plural form count mismatch: English has ${baseForms.length}, this has ${forms.length}`,
      )
    }
  }
}

// ---- 4. Unused keys / missing error codes ---------------------------------
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const sourceFiles = walk(join(ROOT, 'src')).filter(
  (file) =>
    /\.(ts|tsx)$/.test(file) &&
    !normalize(file).includes('/i18n/messages/') &&
    !normalize(file).includes('/vendor/') &&
    !normalize(file).includes('/assets/'),
)

const used = new Set()
const literal = /'([A-Za-z][\w.]*)'/g
for (const file of sourceFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(literal)) used.add(match[1])
}

for (const key of baseKeys) {
  // Error codes come from the backend and the frontend builds `error.${code}`, so no literal refers to them
  if (key.startsWith('error.')) continue
  if (!used.has(key)) notes.push(`unreferenced: ${key}`)
}

const rustFiles = walk(join(ROOT, 'src-tauri/src')).filter((file) => file.endsWith('.rs'))
const rustText = rustFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
const rustCodes = new Set([
  ...[...rustText.matchAll(/AppError::(?:c|p)\(\s*"([\w.]+)"/g)].map((match) => match[1]),
  // Codes `AppError::io` maps from ErrorKind (in error.rs `ErrorKind::NotFound => "io.notFound"`, `_ => "io.other"`)
  ...rustFiles
    .filter((file) => normalize(file).endsWith('/error.rs'))
    .flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/=>\s*"([\w.]+)"/g)].map((match) => match[1]),
    ),
])
for (const code of rustCodes) {
  if (!(`error.${code}` in base)) fail(`error code error.${code} sent from Rust has no glossary text`)
}
for (const key of baseKeys) {
  if (!key.startsWith('error.')) continue
  const code = key.slice('error.'.length)
  // `message` is raw text; the rest is either sent by the backend or thrown by the frontend
  // (appearing in the source is enough)
  if (code === 'message' || rustCodes.has(code) || used.has(key)) continue
  notes.push(`error code text has no matching backend error: ${key}`)
}

// ---- Results ------------------------------------------------------------
console.log(`Glossary: ${baseKeys.length} entries × ${LOCALES.length} locales`)

if (notes.length > 0) {
  console.log('\nNotes:')
  for (const note of notes) console.log(`  - ${note}`)
}

if (problems.length > 0) {
  console.error(`\nFound ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('\nGlossary check passed.')