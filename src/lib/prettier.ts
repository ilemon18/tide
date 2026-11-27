import { extensionOf } from './formatters'
import { t } from '../i18n'

/**
 * On-demand loading and calling of bundled Prettier (`src/vendor/prettier`). Dynamic `import()`
 * lets Vite split the standalone build and the parser plugins into separate chunks, so users who
 * never enable Prettier do not download ~2MB; only common parsers are included.
 */

type PluginName = 'estree' | 'babel' | 'typescript' | 'postcss' | 'html' | 'markdown' | 'yaml'

/** Keep in sync with src/vendor/prettier/standalone.mjs; the formatter settings page shows it. */
export const BUNDLED_PRETTIER_VERSION = '3.9.10'

type ParserSpec = { parser: string; plugins: PluginName[] }

const BABEL: ParserSpec = { parser: 'babel', plugins: ['estree', 'babel'] }

const PARSERS: Record<string, ParserSpec> = {
  js: BABEL,
  jsx: BABEL,
  mjs: BABEL,
  cjs: BABEL,
  json: { parser: 'json', plugins: ['estree', 'babel'] },
  jsonc: { parser: 'jsonc', plugins: ['estree', 'babel'] },
  ts: { parser: 'typescript', plugins: ['estree', 'typescript'] },
  tsx: { parser: 'typescript', plugins: ['estree', 'typescript'] },
  mts: { parser: 'typescript', plugins: ['estree', 'typescript'] },
  cts: { parser: 'typescript', plugins: ['estree', 'typescript'] },
  css: { parser: 'css', plugins: ['postcss'] },
  scss: { parser: 'scss', plugins: ['postcss'] },
  less: { parser: 'less', plugins: ['postcss'] },
  // Embedded <script>/<style> also need babel / postcss / typescript
  html: { parser: 'html', plugins: ['html', 'babel', 'estree', 'postcss', 'typescript'] },
  vue: { parser: 'vue', plugins: ['html', 'babel', 'estree', 'postcss', 'typescript'] },
  md: { parser: 'markdown', plugins: ['markdown'] },
  mdx: { parser: 'mdx', plugins: ['markdown'] },
  yaml: { parser: 'yaml', plugins: ['yaml'] },
  yml: { parser: 'yaml', plugins: ['yaml'] },
}

/** Does bundled Prettier support this extension */
export function supportsBundledPrettier(rel: string): boolean {
  return Boolean(PARSERS[extensionOf(rel)])
}

const PLUGIN_LOADERS: Record<PluginName, () => Promise<unknown>> = {
  estree: () => import('../vendor/prettier/plugins/estree.mjs'),
  babel: () => import('../vendor/prettier/plugins/babel.mjs'),
  typescript: () => import('../vendor/prettier/plugins/typescript.mjs'),
  postcss: () => import('../vendor/prettier/plugins/postcss.mjs'),
  html: () => import('../vendor/prettier/plugins/html.mjs'),
  markdown: () => import('../vendor/prettier/plugins/markdown.mjs'),
  yaml: () => import('../vendor/prettier/plugins/yaml.mjs'),
}

/** Only the module's default export is the plugin object prettier expects */
const pluginCache = new Map<PluginName, Promise<unknown>>()

function loadPlugin(name: PluginName): Promise<unknown> {
  let pending = pluginCache.get(name)
  if (!pending) {
    pending = PLUGIN_LOADERS[name]().then((mod) => {
      const holder = mod as { default?: unknown }
      return holder.default ?? mod
    })
    pluginCache.set(name, pending)
  }
  return pending
}

/** Pass through whitelisted options only: project configs may hold keys Prettier itself ignores, and passing them all makes the API throw. */
const OPTION_KEYS = [
  'printWidth',
  'tabWidth',
  'useTabs',
  'semi',
  'singleQuote',
  'quoteProps',
  'jsxSingleQuote',
  'trailingComma',
  'bracketSpacing',
  'bracketSameLine',
  'arrowParens',
  'proseWrap',
  'htmlWhitespaceSensitivity',
  'vueIndentScriptAndStyle',
  'endOfLine',
  'embeddedLanguageFormatting',
  'singleAttributePerLine',
  'experimentalTernaries',
  'objectWrap',
  'insertPragma',
  'requirePragma',
]

function pickOptions(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object') return {}
  const source = config as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of OPTION_KEYS) {
    if (source[key] !== undefined) out[key] = source[key]
  }
  return out
}

type PrettierModule = {
  format: (text: string, options: Record<string, unknown>) => Promise<string> | string
  version?: string
}

/** Format with bundled Prettier; `config` is the project's Prettier config (may be empty) */
export async function formatWithBundledPrettier(
  rel: string,
  text: string,
  config: unknown,
): Promise<string> {
  const spec = PARSERS[extensionOf(rel)]
  if (!spec) throw new Error(t('error.prettierUnsupported'))

  const [prettier, ...plugins] = await Promise.all([
    import('../vendor/prettier/standalone.mjs') as unknown as Promise<PrettierModule>,
    ...spec.plugins.map(loadPlugin),
  ])

  const formatted = await prettier.format(text, {
    ...pickOptions(config),
    parser: spec.parser,
    plugins,
  })
  return formatted
}