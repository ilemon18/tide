import type { MessageKey } from '../i18n'
import { t } from '../i18n'

/**
 * Optional formatters. Prettier is bundled: if the project has it, use the project's copy (with its
 * config), otherwise fall back to the standalone build in `src/vendor/prettier`; rustfmt / gofmt /
 * Black need the command installed on the system.
 */

/** When to format: off / manual only (⇧⌥F, click the badge) / on save. "Can format" and "rewrite the file on every save" are different things, so manual only by default. */
export type FormatMode = 'off' | 'manual' | 'onSave'

export type FormatToolId = 'auto' | 'prettier' | 'rustfmt' | 'gofmt' | 'black'

export type FormatToolLanguage = 'node' | 'rust' | 'go' | 'python'

export type FormatTool = {
  id: Exclude<FormatToolId, 'auto'>
  /** Tool names are proper nouns, do not translate */
  label: string
  hintKey: MessageKey
  /** Bundled (no system install needed) */
  bundled: boolean
  language: FormatToolLanguage
  extensions: string[]
}

/** Concrete tools (no auto): resolveTool picks auto by extension */
export const FORMAT_TOOLS: FormatTool[] = [
  {
    id: 'prettier',
    label: 'Prettier',
    hintKey: 'format.tool.prettierHint',
    bundled: true,
    language: 'node',
    extensions: [
      'js',
      'jsx',
      'mjs',
      'cjs',
      'ts',
      'tsx',
      'mts',
      'cts',
      'json',
      'jsonc',
      'css',
      'scss',
      'less',
      'html',
      'vue',
      'md',
      'mdx',
      'yaml',
      'yml',
    ],
  },
  {
    id: 'rustfmt',
    label: 'rustfmt',
    hintKey: 'format.tool.rustfmtHint',
    bundled: false,
    language: 'rust',
    extensions: ['rs'],
  },
  {
    id: 'gofmt',
    label: 'gofmt',
    hintKey: 'format.tool.gofmtHint',
    bundled: false,
    language: 'go',
    extensions: ['go'],
  },
  {
    id: 'black',
    label: 'Black',
    hintKey: 'format.tool.blackHint',
    bundled: false,
    language: 'python',
    extensions: ['py'],
  },
]

export const FORMAT_MODES: { id: FormatMode; labelKey: MessageKey; hintKey: MessageKey }[] = [
  { id: 'off', labelKey: 'format.mode.off', hintKey: 'format.mode.offHint' },
  { id: 'manual', labelKey: 'format.mode.manual', hintKey: 'format.mode.manualHint' },
  { id: 'onSave', labelKey: 'format.mode.onSave', hintKey: 'format.mode.onSaveHint' },
]

export function toolById(id: Exclude<FormatToolId, 'auto'>): FormatTool {
  return FORMAT_TOOLS.find((tool) => tool.id === id) ?? FORMAT_TOOLS[0]
}

/**
 * Pick the formatter for a file. "auto" picks by extension (the tool extension sets do not overlap);
 * when a tool is chosen explicitly, it is used only if it handles this file, otherwise the file is
 * unsupported (no silent tool switching).
 */
export function resolveTool(rel: string, preferred: FormatToolId): FormatTool | null {
  if (preferred !== 'auto') {
    const tool = toolById(preferred)
    return ruleFor(tool, rel) ? tool : null
  }
  return FORMAT_TOOLS.find((tool) => ruleFor(tool, rel) !== null) ?? null
}

/** File extension (lowercase, no dot) */
export function extensionOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Does this tool handle the file? Returns the rule to display, e.g. `*.tsx` */
export function ruleFor(tool: FormatTool, rel: string): string | null {
  const ext = extensionOf(rel)
  if (!ext || !tool.extensions.includes(ext)) return null
  return `*.${ext}`
}

/** Display label for the tool source (status bar / tooltip) */
export function sourceLabel(source: string): string {
  switch (source) {
    case 'project':
      return t('format.source.project')
    case 'bundled':
      return t('format.source.bundled')
    case 'system':
      return t('format.source.system')
    default:
      return ''
  }
}
/** Display label for the settings chips and status bar. Tool names stay proper nouns. */
export function toolVersionLabel(label: string, version: string | null | undefined): string {
  return version ? `${label} ${version}` : label
}

/** Human-readable language names used in environment-missing dialogs. */
export function languageLabel(language: FormatToolLanguage): string {
  switch (language) {
    case 'rust':
      return 'Rust'
    case 'go':
      return 'Go'
    case 'python':
      return 'Python'
    case 'node':
      return 'Node.js'
  }
}
