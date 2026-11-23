import { api, errorCode, type DirEntryInfo } from './ipc'
import { basename, dirname } from './paths'

// Match the explorer's request size; read_dir owns the scan and per-page ceilings.
const PAGE_SIZE = 200

/** Read one directory, stopping between IPC pages when the consumer becomes obsolete. */
export async function readDirectoryEntries(
  root: string,
  rel: string,
  current: () => boolean = () => true,
): Promise<DirEntryInfo[]> {
  const entries: DirEntryInfo[] = []
  while (current()) {
    const page = await api.readDir(root, rel, entries.length, PAGE_SIZE)
    if (!current()) return []
    entries.push(...page.entries)
    if (!page.hasMore || page.entries.length === 0) break
  }
  return current() ? entries : []
}

/** Inspect the entry itself (including symlinks), using only root-contained directory reads. */
export async function readWorkspaceEntry(
  root: string,
  path: string,
  current: () => boolean = () => true,
): Promise<DirEntryInfo | undefined> {
  const rel = path.replace(/\/+$/, '')
  let offset = 0
  while (current()) {
    const page = await api.readDir(root, dirname(rel), offset, PAGE_SIZE).catch(error => {
      // Removing an entire parent directory also confirms that this entry is absent.
      if (errorCode(error) === 'io.notFound') return null
      throw error
    })
    if (!current()) return undefined
    if (!page) return undefined
    const entry = page.entries.find(item => item.name === basename(rel))
    if (entry) return entry
    if (!page.hasMore || page.entries.length === 0) break
    offset += page.entries.length
  }
  return undefined
}
