import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab, TabGroup, TabGroupId, SplitOrientation } from './tabs'

vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: {}, errorText: String }))
vi.mock('../i18n', () => ({ t: (key: string) => key, tp: (key: string) => key }))
vi.mock('../editor/stateCache', () => ({
  cacheEditorState: vi.fn(), clearEditorStates: vi.fn(), createFileState: vi.fn(),
  dropEditorState: vi.fn(), getEditorState: vi.fn(), markCleanDoc: vi.fn(),
  reconfigureTheme: vi.fn(), rekeyEditorState: vi.fn(), setEditorRel: vi.fn(), setWordWrap: vi.fn(),
}))
vi.mock('../editor/viewRef', () => ({ getEditorView: () => null }))
vi.mock('../editor/mirror', () => ({ createMirrorState: vi.fn(), forwardDocChange: vi.fn() }))
vi.mock('../editor/scrollMemory', () => ({
  dropScrollRatio: vi.fn(), forgetScrollForTab: vi.fn(), handOffScrollRatio: vi.fn(), rekeyScroll: vi.fn(),
}))
vi.mock('../editor/conflicts', () => ({ conflictField: {}, looksLikeConflict: () => false }))
vi.mock('../lib/formatting', () => ({ formatWithSelectedTool: vi.fn() }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ autoSave: false }) } }))
vi.mock('./workspace', () => ({ useWorkspace: { getState: () => ({ setActiveRoot: vi.fn() }) }, activeRoot: () => null }))
vi.mock('./git', () => ({ useGit: { getState: () => ({}) } }))
vi.mock('./blame', () => ({ useBlame: { getState: () => ({ invalidate: vi.fn() }) } }))
vi.mock('./fileIndex', () => ({ useFileIndex: { getState: () => ({}) } }))
const { confirm, onTabClosed } = vi.hoisted(() => ({ confirm: vi.fn(), onTabClosed: vi.fn() }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ confirm }) } }))
vi.mock('../lib/agentBridge', () => ({ agentBridge: { onTabClosed } }))

import { dropEditorState } from '../editor/stateCache'
import { useTabs } from './tabs'

const tab = (id: string, kind: Tab['kind'] = 'file'): Tab => ({
  id, kind, root: '/repo', rel: kind === 'file' ? `${id}.ts` : '', name: id,
  dirty: false, readOnly: false, pinned: false, temporary: false, tier: 'full', mtime: 0,
})
const file = tab('file')
const chat = tab('chat:one', 'chat')

function split(left: Tab[] = [file], right: Tab[] = [chat], orientation: SplitOrientation = 'row') {
  const groups: TabGroup[] = [
    { id: 'primary', order: left.map(tab => tab.id), activeId: left.at(-1)?.id ?? null },
    { id: 'secondary', order: right.map(tab => tab.id), activeId: right.at(-1)?.id ?? null },
  ]
  useTabs.setState({
    tabs: [...new Map([...left, ...right].map(tab => [tab.id, tab])).values()],
    groups, activeGroupId: 'secondary', activeId: groups[1].activeId,
    splitOrientation: orientation, splitRatio: 0.6, closedTabs: [], cursors: {}, diffEpoch: {},
  })
}
function expectSinglePane(order: string[], activeId = order.at(-1) ?? null) {
  expect(useTabs.getState()).toMatchObject({
    splitOrientation: null, activeGroupId: 'primary', activeId,
    groups: [{ id: 'primary', order, activeId }],
  })
  expect(useTabs.getState().groups).toHaveLength(1)
}

beforeEach(() => {
  vi.clearAllMocks()
  confirm.mockResolvedValue(true)
  split()
})

describe('collapse empty panes', () => {
  it.each(['row', 'column'] as const)('expands a remaining Agent after closing the last primary tab in a %s split', async orientation => {
    split([file], [chat], orientation)
    await useTabs.getState().closeIn(file.id, 'primary')
    expectSinglePane([chat.id])
    expect(useTabs.getState().tabs).toEqual([chat])
    expect(onTabClosed).not.toHaveBeenCalled()
  })

  it('expands the primary after closing the final secondary Agent', async () => {
    await useTabs.getState().closeIn(chat.id, 'secondary')
    expectSinglePane([file.id])
    expect(onTabClosed).toHaveBeenCalledExactlyOnceWith('one')
  })

  it('keeps a split while both panes still have any tab kind', async () => {
    const settings = tab('settings', 'settings')
    split([file, settings], [chat])
    await useTabs.getState().closeIn(file.id, 'primary')
    expect(useTabs.getState().splitOrientation).toBe('row')
    expect(useTabs.getState().groups.map(group => group.order)).toEqual([[settings.id], [chat.id]])
  })

  it.each(['primary', 'secondary'] as const)('removes a shared file only from %s and retains its unsaved buffer', async groupId => {
    const dirty = { ...file, dirty: true }
    split([dirty], [dirty])
    await useTabs.getState().closeIn(file.id, groupId)
    expectSinglePane([file.id])
    expect(useTabs.getState().tabs).toEqual([dirty])
    expect(confirm).not.toHaveBeenCalled()
    expect(dropEditorState).not.toHaveBeenCalledWith(file.id)
    expect(useTabs.getState().closedTabs).toEqual([])
  })

  it.each(['primary', 'secondary'] as const)('collapses after closing all tabs in %s', async groupId => {
    split([file, tab('image', 'image')], [chat, tab('welcome', 'welcome')])
    useTabs.setState({ activeGroupId: groupId })
    await useTabs.getState().closeAll()
    expectSinglePane(groupId === 'primary' ? [chat.id, 'welcome'] : [file.id, 'image'])
  })

  it('collapses a pane after a batch close by id', async () => {
    await useTabs.getState().closeTabs([file.id])
    expectSinglePane([chat.id])
  })

  it('returns to one empty primary after closing every tab', async () => {
    await useTabs.getState().closeTabs([file.id, chat.id])
    expectSinglePane([])
    expect(useTabs.getState().tabs).toEqual([])
  })

  it.each(['primary', 'secondary'] as const)('collapses after dragging the last tab away from %s', source => {
    const target: TabGroupId = source === 'primary' ? 'secondary' : 'primary'
    const moved = source === 'primary' ? file.id : chat.id
    useTabs.getState().moveTabToGroup(moved, target)
    expectSinglePane(source === 'primary' ? [chat.id, file.id] : [file.id, chat.id], moved)
    expect(useTabs.getState().tabs).toHaveLength(2)
    expect(onTabClosed).not.toHaveBeenCalled()
  })

  it('preserves the surviving pane selection and Markdown preview when promoted to primary', async () => {
    const markdown = { ...tab('notes'), rel: 'notes.md' }
    split([file], [chat, markdown])
    const groups = useTabs.getState().groups.map(group => group.id === 'secondary'
      ? { ...group, activeId: chat.id, markdownPreview: { [markdown.id]: 0.4 } } : group)
    useTabs.setState({ groups })
    await useTabs.getState().closeIn(file.id, 'primary')
    expectSinglePane([chat.id, markdown.id], chat.id)
    expect(useTabs.getState().groups[0].markdownPreview).toEqual({ [markdown.id]: 0.4 })
  })

  it.each(['single', 'all'] as const)('leaves the layout intact when an unsaved %s close is cancelled', async method => {
    split([{ ...file, dirty: true }], [chat])
    useTabs.setState({ activeGroupId: 'primary', activeId: file.id })
    const before = useTabs.getState()
    confirm.mockResolvedValue(false)
    if (method === 'single') await useTabs.getState().closeIn(file.id, 'primary')
    else await useTabs.getState().closeAll()
    expect(confirm).toHaveBeenCalledOnce()
    expect(useTabs.getState().groups).toBe(before.groups)
    expect(useTabs.getState().tabs).toBe(before.tabs)
    expect(useTabs.getState().splitOrientation).toBe('row')
    expect(dropEditorState).not.toHaveBeenCalled()
  })
})
