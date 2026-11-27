import { beforeEach, describe, expect, it, vi } from 'vitest'

const { formatText, prettierConfig, formatWithBundledPrettier } = vi.hoisted(() => ({
  formatText: vi.fn(),
  prettierConfig: vi.fn(),
  formatWithBundledPrettier: vi.fn(),
}))

vi.mock('./ipc', () => ({
  api: { formatText, prettierConfig },
  errorText: (value: unknown) => {
    if (value && typeof value === 'object' && 'code' in value) return `translated:${(value as { code: string }).code}`
    return String(value)
  },
}))
vi.mock('./prettier', () => ({ formatWithBundledPrettier }))
vi.mock('../store/settings', () => ({
  useSettings: { getState: () => ({ formatMode: 'manual', formatTool: 'auto' }) },
}))

import { formatWithSelectedTool } from './formatting'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('formatWithSelectedTool', () => {
  it('returns the project Prettier result without falling back', async () => {
    formatText.mockResolvedValue({
      text: 'const x = 1;\n', changed: true, source: 'project', error: null, fallback: false,
    })
    await expect(formatWithSelectedTool('/repo', 'src/App.tsx', 'const x=1')).resolves.toEqual({
      text: 'const x = 1;\n', changed: true, error: null, source: 'project',
    })
    expect(formatWithBundledPrettier).not.toHaveBeenCalled()
  })

  it('uses bundled Prettier with the project config when the backend asks for a fallback', async () => {
    formatText.mockResolvedValue({
      text: null, changed: false, source: 'bundled', error: null, fallback: true,
    })
    prettierConfig.mockResolvedValue({ semi: false })
    formatWithBundledPrettier.mockResolvedValue('const x = 1\n')
    await expect(formatWithSelectedTool('/repo', 'src/App.tsx', 'const x=1')).resolves.toEqual({
      text: 'const x = 1\n', changed: true, error: null, source: 'bundled',
    })
    expect(formatWithBundledPrettier).toHaveBeenCalledWith('src/App.tsx', 'const x=1', { semi: false })
  })

  it('translates coded errors returned by a system formatter', async () => {
    formatText.mockResolvedValue({
      text: null, changed: false, source: 'system', error: 'format.missingBinary', fallback: false,
    })
    await expect(formatWithSelectedTool('/repo', 'main.go', 'package main')).resolves.toEqual({
      text: null, changed: false, error: 'translated:format.missingBinary', source: 'system',
    })
  })
})
