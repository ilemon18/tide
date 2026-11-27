// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { displayToolLabel, displayToolVersion } from './formatterActions'
import { languageLabel, resolveTool, toolVersionLabel } from './formatters'
import type { FormatToolInfo } from './ipc'

const info = (overrides: Partial<FormatToolInfo>): FormatToolInfo => ({
  id: 'rustfmt',
  label: 'rustfmt',
  installed: true,
  source: 'system',
  version: '1.9.0-stable',
  language: 'rust',
  languageInstalled: true,
  languageVersion: '1.95.0',
  canInstall: false,
  canUpdate: true,
  installKind: 'rustup',
  ...overrides,
})

describe('formatter resolution', () => {
  it('resolves auto by extension and respects an explicit tool that cannot handle the file', () => {
    expect(resolveTool('src/App.tsx', 'auto')?.id).toBe('prettier')
    expect(resolveTool('src/main.rs', 'auto')?.id).toBe('rustfmt')
    expect(resolveTool('main.go', 'auto')?.id).toBe('gofmt')
    expect(resolveTool('tool.py', 'auto')?.id).toBe('black')
    expect(resolveTool('src/App.tsx', 'rustfmt')).toBeNull()
    expect(resolveTool('README', 'prettier')).toBeNull()
  })

  it('keeps proper tool names and adds a version only when known', () => {
    expect(toolVersionLabel('rustfmt', '1.9.0-stable')).toBe('rustfmt 1.9.0-stable')
    expect(toolVersionLabel('rustfmt', null)).toBe('rustfmt')
  })

  it('uses the bundled Prettier version when the backend reports no project version', () => {
    expect(displayToolVersion(info({
      id: 'prettier', label: 'Prettier', source: 'bundled', version: null, language: 'node',
      languageInstalled: false, languageVersion: null, canUpdate: false, installKind: 'bundled',
    }))).toBe('3.9.10')
    expect(displayToolLabel(info({
      id: 'prettier', label: 'Prettier', source: 'bundled', version: null, language: 'node',
      languageInstalled: false, languageVersion: null, canUpdate: false, installKind: 'bundled',
    }))).toBe('Prettier 3.9.10')
  })

  it('names language environments for missing-environment dialogs', () => {
    expect(languageLabel('rust')).toBe('Rust')
    expect(languageLabel('go')).toBe('Go')
    expect(languageLabel('python')).toBe('Python')
    expect(languageLabel('node')).toBe('Node.js')
  })
})
