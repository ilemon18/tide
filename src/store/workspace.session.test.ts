import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { saveSession, closeFolder, readDir, toast } = vi.hoisted(() => ({
  saveSession: vi.fn().mockResolvedValue(undefined), closeFolder: vi.fn().mockResolvedValue(undefined),
  readDir: vi.fn(), toast: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'win-test-1' }) }))
vi.mock('../lib/ipc', () => ({
  api: { readDir, closeFolder, saveSession },
  errorCode: (error: { code?: string }) => error.code,
  errorText: String,
}))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast }) } }))
vi.mock('./fileIndex', () => ({ useFileIndex: { getState: () => ({ forget: vi.fn(), invalidate: vi.fn() }) } }))
vi.mock('./folderChain', () => ({ useFolderChain: { getState: () => ({ forget: vi.fn(), invalidate: vi.fn() }) } }))
vi.mock('../lib/memoryBudget', () => ({ feature: { eagerFileIndex: () => false } }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

import { emptyRoot, useWorkspace } from './workspace'

beforeEach(() => {
  saveSession.mockClear()
  useWorkspace.setState({ roots: [], activeRootId: null, recent: [], lastWorkspace: null })
})
afterEach(() => useWorkspace.setState({ roots: [], activeRootId: null }))

it('lets a secondary project window persist the project layout restored at startup', () => {
  const project = emptyRoot('/project-b', 'project-b', false)
  useWorkspace.setState({ roots: [project], activeRootId: project.id })

  useWorkspace.getState().flushSession()

  expect(saveSession).toHaveBeenLastCalledWith({
    recent: [], lastWorkspace: '/project-b', roots: ['/project-b'], activeRoot: '/project-b',
    expanded: { '/project-b': [] },
  })
})
