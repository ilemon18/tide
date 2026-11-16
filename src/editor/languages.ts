import type { Extension } from '@codemirror/state'
import { StreamLanguage } from '@codemirror/language'
import { basename, extname } from '../lib/paths'
import { t } from '../i18n'

export type LangInfo = {
  key: string
  label: string
  load: () => Promise<Extension | null>
}

/** Every language pack is a dynamic import: the first paint loads only the core, syntax packs are pulled when a file opens (Vite splits them into separate chunks). */
const byExt: Record<string, LangInfo> = {
  ts: {
    key: 'ts',
    label: 'TypeScript',
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true }),
  },
  tsx: {
    key: 'tsx',
    label: 'TypeScript JSX',
    load: async () =>
      (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }),
  },
  js: {
    key: 'js',
    label: 'JavaScript',
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  },
  mjs: {
    key: 'mjs',
    label: 'JavaScript',
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  },
  cjs: {
    key: 'cjs',
    label: 'JavaScript',
    load: async () => (await import('@codemirror/lang-javascript')).javascript(),
  },
  jsx: {
    key: 'jsx',
    label: 'JavaScript JSX',
    load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }),
  },
  json: {
    key: 'json',
    label: 'JSON',
    load: async () => (await import('@codemirror/lang-json')).json(),
  },
  jsonc: {
    key: 'jsonc',
    label: 'JSON',
    load: async () => (await import('@codemirror/lang-json')).json(),
  },
  html: {
    key: 'html',
    label: 'HTML',
    load: async () => (await import('@codemirror/lang-html')).html(),
  },
  htm: {
    key: 'htm',
    label: 'HTML',
    load: async () => (await import('@codemirror/lang-html')).html(),
  },
  vue: {
    key: 'vue',
    label: 'Vue',
    load: async () => (await import('@codemirror/lang-html')).html(),
  },
  css: {
    key: 'css',
    label: 'CSS',
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  scss: {
    key: 'scss',
    label: 'SCSS',
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  less: {
    key: 'less',
    label: 'Less',
    load: async () => (await import('@codemirror/lang-css')).css(),
  },
  py: {
    key: 'py',
    label: 'Python',
    load: async () => (await import('@codemirror/lang-python')).python(),
  },
  rs: {
    key: 'rs',
    label: 'Rust',
    load: async () => (await import('@codemirror/lang-rust')).rust(),
  },
  go: {
    key: 'go',
    label: 'Go',
    load: async () => (await import('@codemirror/lang-go')).go(),
  },
  c: { key: 'c', label: 'C', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  h: { key: 'h', label: 'C Header', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  cc: { key: 'cc', label: 'C++', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  cpp: { key: 'cpp', label: 'C++', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  cxx: { key: 'cxx', label: 'C++', load: async () => (await import('@codemirror/lang-cpp')).cpp() },
  hpp: {
    key: 'hpp',
    label: 'C++ Header',
    load: async () => (await import('@codemirror/lang-cpp')).cpp(),
  },
  hh: {
    key: 'hh',
    label: 'C++ Header',
    load: async () => (await import('@codemirror/lang-cpp')).cpp(),
  },
  java: {
    key: 'java',
    label: 'Java',
    load: async () => (await import('@codemirror/lang-java')).java(),
  },
  md: {
    key: 'md',
    label: 'Markdown',
    load: async () => (await import('@codemirror/lang-markdown')).markdown(),
  },
  markdown: {
    key: 'markdown',
    label: 'Markdown',
    load: async () => (await import('@codemirror/lang-markdown')).markdown(),
  },
  yml: {
    key: 'yml',
    label: 'YAML',
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  },
  yaml: {
    key: 'yaml',
    label: 'YAML',
    load: async () => (await import('@codemirror/lang-yaml')).yaml(),
  },
  toml: {
    key: 'toml',
    label: 'TOML',
    load: async () => {
      const mode = await import('@codemirror/legacy-modes/mode/toml')
      return StreamLanguage.define(mode.toml as never)
    },
  },
  sh: {
    key: 'sh',
    label: 'Shell',
    load: async () => {
      const mode = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(mode.shell as never)
    },
  },
  bash: {
    key: 'bash',
    label: 'Shell',
    load: async () => {
      const mode = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(mode.shell as never)
    },
  },
  zsh: {
    key: 'zsh',
    label: 'Shell',
    load: async () => {
      const mode = await import('@codemirror/legacy-modes/mode/shell')
      return StreamLanguage.define(mode.shell as never)
    },
  },
  dockerfile: {
    key: 'dockerfile',
    label: 'Dockerfile',
    load: async () => {
      const mode = await import('@codemirror/legacy-modes/mode/dockerfile')
      return StreamLanguage.define(mode.dockerFile as never)
    },
  },
}

const byName: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'sh',
  '.zshrc': 'zsh',
  '.zprofile': 'zsh',
  '.bashrc': 'bash',
  '.bash_profile': 'bash',
  '.gitignore': 'sh',
  '.gitattributes': 'sh',
  '.env': 'sh',
  '.npmrc': 'sh',
  '.editorconfig': 'toml',
}

const cached = new Map<string, Extension | null>()

export function resolveLang(rel: string): LangInfo | null {
  if (!rel) return null
  const name = basename(rel).toLowerCase()
  const byFileName = byName[name]
  if (byFileName && byExt[byFileName]) return byExt[byFileName]
  const ext = extname(rel)
  return byExt[ext] ?? null
}

export function languageLabel(rel: string): string {
  if (!rel) return t('editor.plainText')
  return resolveLang(rel)?.label ?? t('editor.plainText')
}

/** Load the syntax extension (cached, each language is constructed once) */
export async function loadLanguage(rel: string): Promise<Extension | null> {
  const info = resolveLang(rel)
  if (!info) return null
  if (cached.has(info.key)) return cached.get(info.key) ?? null
  try {
    const ext = await info.load()
    cached.set(info.key, ext)
    return ext
  } catch {
    cached.set(info.key, null)
    return null
  }
}