import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntryInfo, DirPage } from '../lib/ipc'

const { readDir, toast, forget } = vi.hoisted(() => ({ readDir: vi.fn(), toast: vi.fn(), forget: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ label: 'main' }) }))
vi.mock('../lib/ipc', () => ({
  api: { readDir, closeFolder: vi.fn().mockResolvedValue(undefined), saveSession: vi.fn().mockResolvedValue(undefined) },
  errorCode: (error: { code?: string }) => error.code,
  errorText: String,
}))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast }) } }))
vi.mock('./fileIndex', () => ({ useFileIndex: { getState: () => ({ forget: vi.fn(), invalidate: vi.fn() }) } }))
vi.mock('./folderChain', () => ({ useFolderChain: { getState: () => ({ forget, invalidate: vi.fn() }) } }))
vi.mock('../lib/memoryBudget', () => ({ feature: { eagerFileIndex: () => false } }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
import { useWorkspace, emptyRoot, type DirState } from './workspace'

const root = '/repo'
const entry = (path: string, isDir = false): DirEntryInfo => ({
  path, name: path.split('/').at(-1)!, isDir, isSymlink: false, ignored: false, size: 1, mtime: 1,
})
const page = (entries: DirEntryInfo[], total = entries.length): DirPage => ({
  entries, total, hasMore: entries.length < total, truncated: false,
})
const dir = (entries: DirEntryInfo[], total = entries.length): DirState => ({
  entries, total, hasMore: entries.length < total, loading: false,
})
function deferred() {
  let resolve!: (value: DirPage) => void
  const promise = new Promise<DirPage>((done) => { resolve = done })
  return { promise, resolve }
}
function seed(tree: Record<string, DirState>) {
  useWorkspace.setState({ roots: [{ ...emptyRoot(root, 'repo', true), tree,
    expanded: Object.fromEntries(Object.keys(tree).map((rel) => [rel, true])) }], activeRootId: root })
}
beforeEach(() => { readDir.mockReset(); toast.mockClear(); forget.mockClear() })
afterEach(async () => { await useWorkspace.getState().closeWorkspace() })

it('keeps old directories until the batch is ready, then commits once', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/old')]) })
  const first = deferred()
  const second = deferred()
  readDir.mockImplementation((_root, rel) => rel === '' ? first.promise : second.promise)
  const previous = useWorkspace.getState().roots
  const published = vi.fn()
  const stop = useWorkspace.subscribe(published)
  const work = useWorkspace.getState().refreshDirs(root, ['', 'a'], { quiet: true })
  await Promise.resolve()
  first.resolve(page([entry('a', true), entry('new')]))
  await Promise.resolve()
  expect(useWorkspace.getState().roots).toBe(previous)
  second.resolve(page([entry('a/new')]))
  await work
  expect(published).toHaveBeenCalledTimes(1)
  expect(useWorkspace.getState().roots[0].tree.a.entries[0].path).toBe('a/new')
  stop()
})

it('retains all loaded pages and publishes nothing when entries are unchanged', async () => {
  const entries = Array.from({ length: 600 }, (_, i) => entry(`f${i}`))
  seed({ '': dir(entries, 800) })
  const previous = useWorkspace.getState().roots
  readDir.mockImplementation((_root, _rel, offset) => Promise.resolve({
    ...page(entries.slice(offset, offset + 200), 800), hasMore: true,
  }))
  await useWorkspace.getState().refreshDir(root, '')
  expect(readDir.mock.calls.map((call) => call[2])).toEqual([0, 200, 400])
  expect(useWorkspace.getState().roots).toBe(previous)
})

it('coalesces new notifications and never publishes an obsolete response', async () => {
  seed({ '': dir([entry('old')]) })
  const old = deferred()
  readDir.mockReturnValueOnce(old.promise).mockResolvedValueOnce(page([entry('new')]))
  const published: string[] = []
  const stop = useWorkspace.subscribe((state) => published.push(state.roots[0].tree[''].entries[0].path))
  const first = useWorkspace.getState().refreshDir(root, '')
  await Promise.resolve()
  const second = useWorkspace.getState().refreshDir(root, '')
  const third = useWorkspace.getState().refreshDir(root, '')
  old.resolve(page([entry('obsolete')]))
  await Promise.all([first, second, third])
  expect(readDir).toHaveBeenCalledTimes(2)
  expect(published).toEqual(['new'])
  stop()
})

it('does not restore descendant caches after a user collapses their parent', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/b', true)]), 'a/b': dir([entry('a/b/old')]) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)
  const work = useWorkspace.getState().refreshDir(root, 'a/b')
  await Promise.resolve()
  await useWorkspace.getState().toggleDir(root, 'a')
  pending.resolve(page([entry('a/b/new')]))
  await work
  expect(useWorkspace.getState().roots[0].tree['a/b']).toBeUndefined()
  expect(useWorkspace.getState().roots[0].expanded.a).toBeUndefined()
})

it('does not write old results into a closed and reopened root', async () => {
  seed({ '': dir([entry('old')]) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)
  const work = useWorkspace.getState().refreshDir(root, '')
  await Promise.resolve()
  await useWorkspace.getState().closeWorkspace()
  seed({ '': dir([entry('reopened')]) })
  pending.resolve(page([entry('obsolete')]))
  await work
  expect(useWorkspace.getState().roots[0].tree[''].entries[0].path).toBe('reopened')
})

it('keeps unreadable directories and removes only confirmed missing subtrees', async () => {
  seed({ '': dir([entry('a', true), entry('b', true)]), a: dir([entry('a/old')]), b: dir([entry('b/old')]) })
  const oldA = useWorkspace.getState().roots[0].tree.a
  readDir.mockImplementation((_root, rel) => Promise.reject({ code: rel === 'a' ? 'io.permissionDenied' : 'io.notFound' }))
  await useWorkspace.getState().refreshDirs(root, ['a', 'b'], { quiet: true })
  expect(useWorkspace.getState().roots[0].tree.a).toBe(oldA)
  expect(useWorkspace.getState().roots[0].tree.b).toBeUndefined()
  expect(forget).toHaveBeenCalledWith(root, 'b')
  expect(toast).not.toHaveBeenCalled()
})

it('does not re-expand a chain after the parent is collapsed while its missing children load', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/b', true)]) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)
  const work = useWorkspace.getState().expandChain(root, ['a', 'a/b'])
  await useWorkspace.getState().toggleDir(root, 'a')
  pending.resolve(page([entry('a/b/old')]))
  await work
  expect(useWorkspace.getState().roots[0].expanded.a).toBeUndefined()
  expect(useWorkspace.getState().roots[0].tree['a/b']).toBeUndefined()
})

it('does not merge an old expand-all snapshot over a newer cache refresh', async () => {
  seed({ '': dir([entry('a', true)]) })
  const pending = deferred()
  let started!: () => void
  const readingChild = new Promise<void>(resolve => { started = resolve })
  readDir.mockImplementation((_root, rel) => {
    if (rel === 'a') { started(); return pending.promise }
    return Promise.resolve(page([entry('new')]))
  })
  const work = useWorkspace.getState().expandAll(root, true)
  await readingChild
  await useWorkspace.getState().refreshDir(root, '')
  pending.resolve(page([entry('a/old')]))
  await work
  expect(useWorkspace.getState().roots[0].tree[''].entries[0].path).toBe('new')
  expect(useWorkspace.getState().roots[0].tree.a).toBeUndefined()
})

it('does not append pagination after collapse and re-expansion of the same path', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/first')], 300) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)
  const work = useWorkspace.getState().loadMore(root, 'a')
  await useWorkspace.getState().toggleDir(root, 'a')
  await useWorkspace.getState().expandDir(root, 'a')
  pending.resolve(page([entry('a/obsolete')]))
  await work
  expect(useWorkspace.getState().roots[0].tree.a.entries.map(item => item.path)).toEqual(['a/first'])
  expect(useWorkspace.getState().roots[0].tree.a.loading).toBe(false)
})

it('does not restore an expand-chain result into a reopened workspace with the same path', async () => {
  seed({ '': dir([entry('a', true)]) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)
  const work = useWorkspace.getState().expandChain(root, ['a'])
  await useWorkspace.getState().closeWorkspace()
  seed({ '': dir([entry('new')]) })
  pending.resolve(page([entry('a/obsolete')]))
  await work
  expect(useWorkspace.getState().roots[0].tree.a).toBeUndefined()
})

it('pages every ancestor until a deep file row is loaded, then commits once', async () => {
  const rootPage = Array.from({ length: 200 }, (_, i) => entry(`root-${i}`))
  seed({ '': dir(rootPage, 201) })
  const parentPage = [...Array.from({ length: 500 }, (_, i) => entry(`a/f-${i}`)), entry('a/b', true)]
  const childPage = [...Array.from({ length: 500 }, (_, i) => entry(`a/b/f-${i}`)), entry('a/b/target.ts')]
  readDir.mockImplementation((_root, rel, offset) => {
    if (rel === '') return Promise.resolve(offset === 200 ? page([entry('a', true)], 201) : page(rootPage, 201))
    if (rel === 'a') return Promise.resolve(page(parentPage.slice(offset, offset + 500), 501))
    if (rel === 'a/b') return Promise.resolve(page(childPage.slice(offset, offset + 500), 501))
    return Promise.reject(new Error(`unexpected read ${rel}`))
  })
  const published = vi.fn()
  const stop = useWorkspace.subscribe(published)

  const result = await useWorkspace.getState().revealPath(root, 'a/b/target.ts', false)

  expect(result).toEqual({ found: true, fallbackRel: 'a/b/target.ts' })
  expect(readDir).toHaveBeenCalledWith(root, '', 200, 500)
  expect(readDir).toHaveBeenCalledWith(root, 'a', 0, 500)
  expect(readDir).toHaveBeenCalledWith(root, 'a', 500, 500)
  expect(readDir).toHaveBeenCalledWith(root, 'a/b', 0, 500)
  expect(readDir).toHaveBeenCalledWith(root, 'a/b', 500, 500)
  const node = useWorkspace.getState().roots[0]
  expect(node.expanded).toMatchObject({ '': true, a: true, 'a/b': true })
  expect(node.tree['a/b'].entries.some((item) => item.path === 'a/b/target.ts')).toBe(true)
  expect(published).toHaveBeenCalledTimes(1)
  stop()
})

it('continues a reveal from the cached page and reaches the target on the next page', async () => {
  const cached = Array.from({ length: 200 }, (_, i) => entry(`a/f-${i}`))
  seed({ '': dir([entry('a', true)]), a: dir(cached, 201) })
  readDir.mockResolvedValueOnce({ entries: [entry('a/target.ts')], total: 201, hasMore: false, truncated: false })

  const result = await useWorkspace.getState().revealPath(root, 'a/target.ts', false)

  expect(result).toEqual({ found: true, fallbackRel: 'a/target.ts' })
  expect(readDir).toHaveBeenCalledWith(root, 'a', 200, 500)
  expect(useWorkspace.getState().roots[0].tree.a.entries.at(-1)?.path).toBe('a/target.ts')
})

it('re-reads a stale cached prefix from offset zero when the target moved into it', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/old-0')], 201) })
  readDir
    .mockResolvedValueOnce({ entries: [entry('a/old-1')], total: 2, hasMore: false, truncated: false })
    .mockResolvedValueOnce(page([entry('a/target.ts')], 1))

  const result = await useWorkspace.getState().revealPath(root, 'a/target.ts', false)

  expect(result).toEqual({ found: true, fallbackRel: 'a/target.ts' })
  expect(readDir.mock.calls.map((call) => call[2])).toEqual([1, 0])
  expect(useWorkspace.getState().roots[0].tree.a.entries.map((item) => item.path)).toEqual(['a/target.ts'])
})

it('does not resurrect a revealed directory after its parent collapses mid-read', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/b', true)]), 'a/b': dir([entry('a/b/old')], 2) })
  const pending = deferred()
  readDir.mockReturnValue(pending.promise)

  const work = useWorkspace.getState().revealPath(root, 'a/b/target.ts', false)
  await useWorkspace.getState().toggleDir(root, 'a')
  pending.resolve(page([entry('a/b/target.ts')], 2))
  const result = await work

  expect(result).toEqual({ found: false, fallbackRel: 'a' })
  expect(useWorkspace.getState().roots[0].tree.a).toBeDefined()
  expect(useWorkspace.getState().roots[0].tree['a/b']).toBeUndefined()
  expect(useWorkspace.getState().roots[0].expanded.a).toBeUndefined()
})

it('loads the target directory itself so a directory reveal arrives expanded', async () => {
  seed({ '': dir([entry('a', true)]), a: dir([entry('a/b', true)]) })
  readDir.mockResolvedValueOnce(page([entry('a/b/file.ts')], 1))

  const result = await useWorkspace.getState().revealPath(root, 'a/b', true)

  expect(result).toEqual({ found: true, fallbackRel: 'a/b' })
  expect(readDir).toHaveBeenCalledWith(root, 'a/b', 0, 500)
  const node = useWorkspace.getState().roots[0]
  expect(node.expanded['a/b']).toBe(true)
  expect(node.tree['a/b'].entries[0].path).toBe('a/b/file.ts')
})

it('keeps the centered reveal flag on tree reveal requests', () => {
  useWorkspace.setState({ treeReveal: null })
  useWorkspace.getState().requestTreeReveal({ root, rel: 'src/a.ts', isDir: false, center: true })
  const reveal = useWorkspace.getState().treeReveal
  expect(reveal).toMatchObject({ root, rel: 'src/a.ts', isDir: false, center: true })
  useWorkspace.getState().clearTreeReveal(reveal!.nonce)
  expect(useWorkspace.getState().treeReveal).toBeNull()
})
