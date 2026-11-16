// Generates src/assets/fileIcons.generated.ts: several "by file name / extension" icon mappings.
//
// Design notes:
// - Each set is an SVG sprite (symbol + use), so at runtime one icon costs a single <svg><use/></svg>
// - The output is plain static TS with no icon package as a runtime dependency
// - Two sets today:
//   material  -- colorful icons extracted from material-icon-theme (~200 icons, common extensions only)
//   minimal   -- monochrome line icons hand-drawn in scripts/icon-themes/minimal.mjs, follow the theme color
//
// Usage: node scripts/build-file-icons.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as minimalTheme from './icon-themes/minimal.mjs'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')
const pkgDir = resolve(projectRoot, 'node_modules/material-icon-theme')

// ---------------------------------------------------------------- material

// Languages / file types to cover
const EXT_WHITELIST = [
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs',
  'json', 'jsonc', 'json5', 'jsonl',
  'html', 'htm', 'xhtml', 'vue', 'svelte', 'astro', 'pug', 'ejs', 'hbs', 'twig', 'liquid', 'erb', 'haml', 'slim',
  'css', 'scss', 'sass', 'less', 'styl',
  'md', 'markdown', 'mdx', 'rst', 'txt', 'log', 'csv', 'tsv', 'pdf',
  'rs', 'go', 'py', 'pyi', 'rb', 'php', 'java', 'kt', 'kts', 'scala', 'swift', 'm', 'mm',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'fs', 'fsx',
  'lua', 'pl', 'r', 'jl', 'dart', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'ml', 'nim', 'zig', 'v', 'sol',
  'sql', 'graphql', 'gql', 'proto', 'prisma',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
  'xml', 'plist', 'diff', 'patch', 'asm', 's', 'wasm', 'wat',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'dockerfile', 'makefile', 'cmake', 'gradle', 'lock', 'ipynb', 'tex', 'bib',
  'tf', 'tfvars', 'hcl', 'nix',
  'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'tiff',
  'mp4', 'mov', 'webm', 'mp3', 'wav', 'flac',
  'zip', 'tar', 'gz', 'rar', '7z', 'dmg', 'exe', 'app', 'apk', 'ipa',
  'xls', 'xlsx', 'doc', 'docx', 'ppt', 'pptx',
]

const NAME_WHITELIST = [
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json', 'vite.config.ts', 'vite.config.js',
  'tailwind.config.js', 'tailwind.config.ts', 'postcss.config.js',
  '.gitignore', '.gitattributes', '.gitmodules', '.gitkeep',
  '.editorconfig', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.prettierrc', '.prettierrc.json',
  '.npmrc', '.nvmrc', '.env', '.env.local', '.env.example', '.dockerignore',
  'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'makefile', 'cmakelists.txt',
  'cargo.toml', 'cargo.lock', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml',
  'pipfile', 'gemfile', 'gemfile.lock', 'pom.xml', 'build.gradle', 'settings.gradle',
  'license', 'license.md', 'readme.md', 'readme', 'changelog.md', 'contributing.md',
  'rust-toolchain', 'rust-toolchain.toml', '.babelrc', '.browserslistrc', 'jest.config.js',
  'vitest.config.ts', 'playwright.config.ts', 'webpack.config.js', 'rollup.config.js',
]

const FOLDER_WHITELIST = [
  'src', 'dist', 'build', 'out', 'node_modules', 'test', 'tests', 'spec', 'docs', 'doc',
  'config', '.github', '.vscode', 'assets', 'images', 'img', 'public', 'static',
  'components', 'lib', 'api', 'server', 'client', 'app', 'pages', 'hooks', 'utils', 'store',
  'styles', 'css', 'js', 'ts', 'views', 'models', 'controllers', 'routes', 'migrations',
  'scripts', 'bin', 'temp', 'coverage', 'logs', 'package', 'android', 'ios', 'linux',
  'windows', 'macos', 'docker', 'kubernetes', 'terraform', 'git', 'database', 'types', 'icons',
]

/**
 * Take the inner content of the <svg>.
 * The root viewBox must be preserved (icons are drawn on 16/24/32/512... canvases)
 * along with fill (some icons use fill="none", which is what makes their backing path transparent).
 */
function readIconSvg(iconDefinitions, name) {
  const def = iconDefinitions[name]
  if (!def?.iconPath) return null
  const path = resolve(pkgDir, def.iconPath.replace('./../', ''))
  if (!existsSync(path)) return null
  const svg = readFileSync(path, 'utf8')

  const svgTag = svg.match(/<svg([^>]*)>/)
  if (!svgTag) return null
  const attrs = svgTag[1]
  const viewBox = (attrs.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 16 16'
  const rootFill = (attrs.match(/\sfill="([^"]+)"/) || [])[1]

  let inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  // Drop the transparent full-canvas background (some icons use it as a placeholder; left in place it turns into a black box)
  inner = inner.replace(/<path d="M0 0h(?:16|24|32)v(?:16|24|32)H0z"\s*\/>/g, '')

  inner = inner
    .replace(/\s+/g, ' ')
    .replace(/>\s+</g, '><')
    .replace(/fill-rule="evenodd"\s*/g, '')
    .trim()

  // The root fill has to be inherited explicitly by the child nodes
  if (rootFill && rootFill !== 'none') {
    inner = `<g fill="${rootFill}">${inner}</g>`
  } else if (rootFill === 'none') {
    inner = `<g fill="none">${inner}</g>`
  }

  return { inner, viewBox }
}

function buildMaterial(manifest) {
  const { iconDefinitions, fileExtensions, fileNames, folderNames, folderNamesExpanded } = manifest
  const iconNames = new Set(['file', 'folder', 'folder-open'])

  const ext = {}
  for (const name of EXT_WHITELIST) {
    const icon = fileExtensions[name]
    if (icon) {
      ext[name] = icon
      iconNames.add(icon)
    }
  }

  const names = {}
  for (const name of NAME_WHITELIST) {
    const icon = fileNames[name]
    if (icon) {
      names[name] = icon
      iconNames.add(icon)
    }
  }

  const folder = {}
  const folderOpen = {}
  for (const name of FOLDER_WHITELIST) {
    const icon = folderNames[name]
    const openIcon = folderNamesExpanded[name]
    if (icon) {
      folder[name] = icon
      iconNames.add(icon)
    }
    if (openIcon) {
      folderOpen[name] = openIcon
      iconNames.add(openIcon)
    }
  }

  const sprite = {}
  const viewBoxes = {}
  let missing = 0
  for (const name of [...iconNames].sort()) {
    const parsed = readIconSvg(iconDefinitions, name)
    if (!parsed) {
      missing += 1
      continue
    }
    sprite[name] = parsed.inner
    viewBoxes[name] = parsed.viewBox
  }

  return {
    set: {
      viewBoxes,
      sprite,
      ext,
      names,
      folder,
      folderOpen,
      defaultFile: 'file',
      defaultFolder: 'folder',
      defaultFolderOpen: 'folder-open',
    },
    missing,
  }
}

// ---------------------------------------------------------------- minimal

function buildMinimal() {
  const sprite = {}
  const viewBoxes = {}
  // Add one common stroke wrapper: glyphs only carry geometry, color comes from currentColor
  for (const [name, inner] of Object.entries(minimalTheme.GLYPHS)) {
    sprite[name] =
      '<g fill="none" stroke="currentColor" stroke-width="1.25" ' +
      `stroke-linecap="round" stroke-linejoin="round">${inner}</g>`
    viewBoxes[name] = minimalTheme.VIEW_BOX
  }

  return {
    viewBoxes,
    sprite,
    ext: minimalTheme.EXT_GLYPHS,
    names: minimalTheme.NAME_GLYPHS,
    folder: minimalTheme.FOLDER_GLYPHS,
    // Special folders reuse the same glyph when expanded; only plain folders switch to folder-open
    folderOpen: minimalTheme.FOLDER_GLYPHS,
    defaultFile: minimalTheme.DEFAULT_FILE,
    defaultFolder: minimalTheme.DEFAULT_FOLDER,
    defaultFolderOpen: minimalTheme.DEFAULT_FOLDER_OPEN,
  }
}

// ---------------------------------------------------------------- emit

const manifestPath = resolve(pkgDir, 'dist/material-icons.json')
let material
let missing = 0
if (existsSync(manifestPath)) {
  const built = buildMaterial(require(manifestPath))
  material = built.set
  missing = built.missing
} else {
  // Without node_modules fall back to emitting minimal only, so an existing output is not wiped
  console.warn('warning: material-icon-theme not found, the material icon set will be empty')
  material = { viewBoxes: {}, sprite: {}, ext: {}, names: {}, folder: {}, folderOpen: {} }
}

const sets = { material, minimal: buildMinimal() }

const serializeSets = (sets) =>
  Object.entries(sets)
    .map(
      ([id, s]) => `  ${id}: {
    viewBoxes: ${JSON.stringify(s.viewBoxes)},
    sprite: ${JSON.stringify(s.sprite)},
    ext: ${JSON.stringify(s.ext)},
    names: ${JSON.stringify(s.names)},
    folder: ${JSON.stringify(s.folder)},
    folderOpen: ${JSON.stringify(s.folderOpen)},
    defaultFile: ${JSON.stringify(s.defaultFile ?? 'file')},
    defaultFolder: ${JSON.stringify(s.defaultFolder ?? 'folder')},
    defaultFolderOpen: ${JSON.stringify(s.defaultFolderOpen ?? 'folder-open')},
  },`,
    )
    .join('\n')

const out = `// Generated by scripts/build-file-icons.mjs; do not edit by hand.
// Icon sources: material-icon-theme (MIT) https://github.com/material-extensions/vscode-material-icon-theme
//               minimal is hand-drawn in this repo (scripts/icon-themes/minimal.mjs)
/* eslint-disable */

export type IconSetId = 'material' | 'minimal'

export type IconSet = {
  viewBoxes: Record<string, string>
  sprite: Record<string, string>
  ext: Record<string, string>
  names: Record<string, string>
  folder: Record<string, string>
  folderOpen: Record<string, string>
  defaultFile: string
  defaultFolder: string
  defaultFolderOpen: string
}

export const ICON_SETS: Record<IconSetId, IconSet> = {
${serializeSets(sets)}
}

/** Display order in dropdowns / menus */
export const ICON_SET_ORDER: IconSetId[] = ['material', 'minimal']
`

const outPath = resolve(projectRoot, 'src/assets/fileIcons.generated.ts')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, out)

const sizes = Object.entries(sets)
  .map(([id, s]) => {
    const bytes = Object.values(s.sprite).reduce((acc, inner) => acc + inner.length, 0)
    return `${id}: ${Object.keys(s.sprite).length} symbols / ${(bytes / 1024).toFixed(1)} KB`
  })
  .join('  ')
console.log(`file icons → ${sizes}  ts=${(out.length / 1024).toFixed(1)} KB  missing=${missing}`)