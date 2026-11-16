// "Monochrome minimal" icon set: hand-drawn 16x16 line icons colored by currentColor,
// legible on dark / light / eye-comfort themes, with no third-party icon package.
//
// Read by scripts/build-file-icons.mjs and merged into src/assets/fileIcons.generated.ts.

/** All glyphs share one canvas, which keeps scaling uniform */
export const VIEW_BOX = '0 0 16 16'

/** glyph name -> SVG inner paths */
export const GLYPHS = {
  file: '<path d="M4.2 2.5h5L12.5 5.8V13a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8Z"/><path d="M9 2.7v3.1h3.3"/>',
  text: '<path d="M4.2 2.5h5L12.5 5.8V13a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8Z"/><path d="M5.4 8h5.2M5.4 10.2h5.2M5.4 12.4h3"/>',
  code: '<path d="M6.2 5.6 3.4 8l2.8 2.4"/><path d="M9.8 5.6 12.6 8l-2.8 2.4"/>',
  markdown:
    '<path d="M4.2 2.5h5L12.5 5.8V13a.8.8 0 0 1-.8.8H4.2a.8.8 0 0 1-.8-.8V3.3a.8.8 0 0 1 .8-.8Z"/><path d="M5.3 11.6V8l1.6 2 1.6-2v3.6"/><path d="M10.6 8.4v3.2M9.6 10.6l1 1 1-1"/>',
  data: '<path d="M6.4 2.8c-1.3 0-1.7.5-1.7 1.7v1.3c0 1-.5 1.5-1.3 1.5v1.4c.8 0 1.3.5 1.3 1.5v1.3c0 1.2.4 1.7 1.7 1.7"/><path d="M9.6 2.8c1.3 0 1.7.5 1.7 1.7v1.3c0 1 .5 1.5 1.3 1.5v1.4c-.8 0-1.3.5-1.3 1.5v1.3c0 1.2-.4 1.7-1.7 1.7"/>',
  config:
    '<circle cx="8" cy="8" r="2.1"/><path d="M8 2.4v1.5M8 12.1v1.5M2.4 8h1.5M12.1 8h1.5M3.9 3.9 5 5M11 11l1.1 1.1M12.1 3.9 11 5M5 11l-1.1 1.1"/>',
  image:
    '<rect x="2.4" y="3.6" width="11.2" height="8.8" rx="1.2"/><circle cx="5.8" cy="6.6" r="1"/><path d="M2.8 11.4 6 8.4l2.1 2 1.8-1.6 3.3 3"/>',
  media:
    '<rect x="2.2" y="4.2" width="8.2" height="7.6" rx="1.2"/><path d="M10.8 8.2l2.9-1.7v4.2l-2.9-1.7"/>',
  audio:
    '<circle cx="6.2" cy="11.4" r="1.9"/><path d="M8.1 11.4V3.6l4.1-1v7.8"/><circle cx="10.3" cy="10.4" r="1.9"/>',
  archive:
    '<rect x="2.6" y="4" width="10.8" height="9.2" rx="1.2"/><path d="M2.6 7.2h10.8M8 4v3.2M6.8 8.7h2.4v2H6.8Z"/>',
  lock: '<rect x="3.6" y="7" width="8.8" height="6.6" rx="1.2"/><path d="M5.8 7V5.4a2.2 2.2 0 0 1 4.4 0V7"/>',
  git: '<circle cx="5.5" cy="4.5" r="1.7"/><circle cx="5.5" cy="11.5" r="1.7"/><circle cx="10.7" cy="5.9" r="1.7"/><path d="M5.5 6.2v3.6"/><path d="M7.2 4.9c1.6 0 1.9 1 1.9 1.6v2.1"/>',
  terminal:
    '<rect x="2.4" y="3.4" width="11.2" height="9.2" rx="1.3"/><path d="M5 6.4 6.8 8 5 9.6M8.4 10h3"/>',
  style: '<path d="M6.4 3.2 5.4 12.8M10.6 3.2 9.6 12.8M3.2 6.2h9.6M2.8 9.8h9.6"/>',
  html: '<path d="M5.8 4.8 2.8 8l3 3.2"/><path d="M10.2 4.8 13.2 8l-3 3.2"/><path d="M9.2 3.4 6.8 12.6"/>',
  table:
    '<rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1"/><path d="M2.6 6.6h10.8M2.6 9.4h10.8M6.2 3.6v8.8M9.8 3.6v8.8"/>',
  folder:
    '<path d="M2.2 4.6a1.2 1.2 0 0 1 1.2-1.2h2.7l1.3 1.6h4.2a1.2 1.2 0 0 1 1.2 1.2v5.6a1.2 1.2 0 0 1-1.2 1.2H3.4a1.2 1.2 0 0 1-1.2-1.2Z"/>',
  'folder-open':
    '<path d="M2.2 11V4.6a1.2 1.2 0 0 1 1.2-1.2h2.7l1.3 1.6h3.9a1.2 1.2 0 0 1 1.2 1.2v1"/><path d="M2.2 11 4 6.5h10l-1.9 4.8a1.2 1.2 0 0 1-1.1.8H3.4a1.2 1.2 0 0 1-1.2-1.1Z"/>',
}

/** extension -> glyph */
export const EXT_GLYPHS = {
  ts: 'code', tsx: 'code', mts: 'code', cts: 'code',
  js: 'code', jsx: 'code', mjs: 'code', cjs: 'code',
  vue: 'code', svelte: 'code', astro: 'html',
  rs: 'code', go: 'code', py: 'code', pyi: 'code', rb: 'code', php: 'code',
  java: 'code', kt: 'code', kts: 'code', scala: 'code', swift: 'code',
  c: 'code', h: 'code', cc: 'code', cpp: 'code', cxx: 'code', hpp: 'code',
  cs: 'code', lua: 'code', dart: 'code', ex: 'code', exs: 'code', erl: 'code',
  clj: 'code', hs: 'code', ml: 'code', zig: 'code', v: 'code', sol: 'code',
  sql: 'data', graphql: 'data', gql: 'data', proto: 'data', prisma: 'data',
  sh: 'terminal', bash: 'terminal', zsh: 'terminal', fish: 'terminal',
  ps1: 'terminal', bat: 'terminal', cmd: 'terminal',
  html: 'html', htm: 'html', xhtml: 'html', xml: 'html',
  css: 'style', scss: 'style', sass: 'style', less: 'style', styl: 'style',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  txt: 'text', rst: 'text', log: 'text', csv: 'table', tsv: 'table',
  pdf: 'text', doc: 'text', docx: 'text',
  xls: 'table', xlsx: 'table', ppt: 'text', pptx: 'text',
  json: 'config', jsonc: 'config', json5: 'config', yml: 'config', yaml: 'config',
  toml: 'config', ini: 'config', cfg: 'config', conf: 'config',
  env: 'config', properties: 'config',
  lock: 'lock',
  svg: 'image', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
  webp: 'image', ico: 'image', bmp: 'image', avif: 'image', tiff: 'image',
  mp4: 'media', mov: 'media', webm: 'media', mkv: 'media', avi: 'media',
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', m4a: 'audio',
  zip: 'archive', tar: 'archive', gz: 'archive', rar: 'archive', '7z': 'archive',
  dmg: 'archive', exe: 'archive', app: 'archive', apk: 'archive', ipa: 'archive',
  wasm: 'config', diff: 'text', patch: 'text', tex: 'text', bib: 'text',
  ipynb: 'data', tf: 'config', tfvars: 'config', hcl: 'config', nix: 'config',
}

/** file name -> glyph */
export const NAME_GLYPHS = {
  'package.json': 'config',
  'package-lock.json': 'lock',
  'pnpm-lock.yaml': 'lock',
  'yarn.lock': 'lock',
  'bun.lockb': 'lock',
  'tsconfig.json': 'config',
  'jsconfig.json': 'config',
  'vite.config.ts': 'config',
  'vite.config.js': 'config',
  'tailwind.config.js': 'config',
  'tailwind.config.ts': 'config',
  'postcss.config.js': 'config',
  'jest.config.js': 'config',
  'vitest.config.ts': 'config',
  'playwright.config.ts': 'config',
  'webpack.config.js': 'config',
  'rollup.config.js': 'config',
  'cargo.toml': 'config',
  'cargo.lock': 'lock',
  'go.mod': 'config',
  'go.sum': 'lock',
  'requirements.txt': 'config',
  'pyproject.toml': 'config',
  'pipfile': 'config',
  'gemfile': 'data',
  'gemfile.lock': 'lock',
  'pom.xml': 'config',
  'build.gradle': 'config',
  'settings.gradle': 'config',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.editorconfig': 'config',
  '.eslintrc': 'config',
  '.eslintrc.json': 'config',
  '.eslintrc.js': 'config',
  '.prettierrc': 'config',
  '.prettierrc.json': 'config',
  '.npmrc': 'config',
  '.nvmrc': 'config',
  '.env': 'config',
  '.env.local': 'config',
  '.env.example': 'config',
  '.dockerignore': 'config',
  'dockerfile': 'config',
  'docker-compose.yml': 'config',
  'docker-compose.yaml': 'config',
  'makefile': 'terminal',
  'cmakelists.txt': 'config',
  'license': 'text',
  'license.md': 'text',
  'readme.md': 'markdown',
  'readme': 'markdown',
  'changelog.md': 'markdown',
  'contributing.md': 'markdown',
  'rust-toolchain': 'config',
  'rust-toolchain.toml': 'config',
}

/** directory name -> glyph (the minimal set only distinguishes plain and special folders) */
export const FOLDER_GLYPHS = {
  '.git': 'git',
  'node_modules': 'archive',
  'dist': 'archive',
  'build': 'archive',
}

export const DEFAULT_FILE = 'file'
export const DEFAULT_FOLDER = 'folder'
export const DEFAULT_FOLDER_OPEN = 'folder-open'