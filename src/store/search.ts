import { create } from 'zustand'
import { api, errorText, type SearchFile } from '../lib/ipc'
import { useUi } from './ui'
import { activeRoot } from './workspace'
import { useTabs } from './tabs'
import { useGit } from './git'
import { t, tp } from '../i18n'
import { budget } from '../lib/memoryBudget'

/** null means the whole current project; with rel it narrows to a subdirectory inside the project */
export type SearchScope = { root: string; rel: string } | null

type SearchStore = {
  query: string
  replacement: string
  caseSensitive: boolean
  regex: boolean
  wholeWord: boolean
  /** Search only files matching these globs (comma / space separated) */
  include: string
  /** Exclude files matching these globs */
  exclude: string
  showFilters: boolean
  showReplace: boolean
  scope: SearchScope
  results: SearchFile[]
  total: number
  scanned: number
  truncated: boolean
  /** A scan is actually running */
  running: boolean
  /** Conditions just changed and a debounce is queued: the UI must treat this as "searching", not final */
  pending: boolean
  expanded: Record<string, boolean>

  setQuery: (query: string) => void
  setReplacement: (value: string) => void
  toggleOption: (key: 'caseSensitive' | 'regex' | 'wholeWord') => void
  setInclude: (value: string) => void
  setExclude: (value: string) => void
  toggleFilters: () => void
  toggleReplace: () => void
  setScope: (scope: SearchScope) => void
  toggleExpanded: (key: string) => void
  run: () => Promise<void>
  replaceAll: () => Promise<void>
  /** Replace every match in one result file (no confirm: one explicit click) */
  replaceInFile: (file: string) => Promise<void>
  /** Replace a single match of one result file */
  replaceMatchInFile: (file: string, line: number, column: number) => Promise<void>
  /** Drop results but keep the query conditions: called when leaving the search view */
  dropResults: () => void
  clear: () => void
}

let debounce: ReturnType<typeof setTimeout> | null = null
let runId = 0

/** Search always targets the current project only: scope applies only when it points at that project */
function currentScope(scope: SearchScope): string | null {
  const root = activeRoot()
  if (!root) return null
  return scope && scope.root === root.id ? scope.rel : null
}

/** Single entry after conditions change: typed input is debounced, toggles re-run at once */
function scheduleRun() {
  if (debounce) clearTimeout(debounce)
  useSearch.setState({ pending: true })
  debounce = setTimeout(() => {
    debounce = null
    void useSearch.getState().run()
  }, 250)
}

/**
 * Kill old results as soon as conditions change; otherwise the 250ms debounce still shows the previous results
 * (or an empty list + "no matches"), which looks finished. runId moves on to void in-flight responses;
 * pending = true means another search is queued.
 */
function clearResults(pending: boolean) {
  runId += 1
  if (!pending && debounce) {
    clearTimeout(debounce)
    debounce = null
  }
  useSearch.setState({
    results: [],
    total: 0,
    scanned: 0,
    truncated: false,
    running: false,
    pending,
  })
}

const markStale = () => clearResults(true)

export const useSearch = create<SearchStore>((set, get) => ({
  query: '',
  replacement: '',
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  include: '',
  exclude: '',
  showFilters: false,
  showReplace: false,
  scope: null,
  results: [],
  total: 0,
  scanned: 0,
  truncated: false,
  running: false,
  pending: false,
  expanded: {},

  setQuery: (query) => {
    set({ query })
    // Clearing the input skips the debounce: drop results now, without a flash of "searching"
    if (!query.trim()) {
      clearResults(false)
      return
    }
    markStale()
    scheduleRun()
  },

  setInclude: (include) => {
    set({ include })
    markStale()
    scheduleRun()
  },

  setExclude: (exclude) => {
    set({ exclude })
    markStale()
    scheduleRun()
  },

  toggleFilters: () => set({ showFilters: !get().showFilters }),

  setReplacement: (replacement) => set({ replacement }),

  toggleOption: (key) => {
    set({ [key]: !get()[key] } as never)
    markStale()
    void get().run()
  },

  toggleReplace: () => set({ showReplace: !get().showReplace }),

  setScope: (scope) => {
    set({ scope })
    markStale()
    void get().run()
  },

  toggleExpanded: (key) => set({ expanded: { ...get().expanded, [key]: !get().expanded[key] } }),

  run: async () => {
    const { query, scope, caseSensitive, regex, wholeWord, include, exclude } = get()
    // A manual run consumes the queued one, so it does not run twice
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    if (!query.trim()) {
      set({ results: [], total: 0, scanned: 0, truncated: false, running: false, pending: false })
      return
    }

    const root = activeRoot()
    if (!root) {
      set({ results: [], total: 0, scanned: 0, truncated: false, running: false, pending: false })
      return
    }

    const current = ++runId
    set({ running: true, pending: false })

    try {
      const response = await api.searchFiles(root.id, query, {
        caseSensitive,
        regex,
        wholeWord,
        scope: currentScope(scope),
        include: include.trim() || null,
        exclude: exclude.trim() || null,
        maxResults: budget.searchResults(),
      })
      if (current !== runId) return
      set({
        results: response.files,
        total: response.total,
        scanned: response.scanned,
        truncated: response.truncated,
        running: false,
      })
    } catch (e) {
      if (current !== runId) return
      set({ running: false })
      useUi.getState().toast(errorText(e), 'error')
    }
  },

  replaceAll: async () => {
    const { query, replacement, caseSensitive, regex, wholeWord, scope, results } = get()
    if (!query.trim() || results.length === 0) return

    const root = activeRoot()
    if (!root) return

    const ok = await useUi.getState().confirm({
      title: t('dialog.replaceAll.title'),
      message: t('dialog.replaceAll.message', {
        query,
        replacement,
        count: results.length,
      }),
      confirmText: t('dialog.replaceAll.confirm'),
      danger: true,
    })
    if (!ok) return

    // Clear old results now: during write + full rescan the listed line numbers are invalid, no clicking
    set({ running: true, results: [], total: 0, expanded: {} })

    try {
      const res = await api.replaceInFiles(
        root.id,
        query,
        {
          caseSensitive,
          regex,
          wholeWord,
          scope: currentScope(scope),
          maxResults: budget.searchResults(),
        },
        replacement,
        results.map((f) => f.file),
      )
      // Open files must reload; dirty ones are skipped so unsaved edits are not clobbered
      const dirty: string[] = []
      for (const file of results) {
        const tab = useTabs
          .getState()
          .tabs.find((t) => t.kind === 'file' && t.root === root.id && t.rel === file.file)
        if (tab?.dirty) {
          dirty.push(file.file)
          continue
        }
        await useTabs.getState().reload(root.id, file.file, { silent: true })
      }
      // Replace rewrites files: refresh git state / file tree marks too
      useGit.getState().scheduleRefresh(root.id)
      useUi
        .getState()
        .toast(tp('toast.replaced', res.replacedFiles, { matches: res.replacedMatches }), 'success')
      if (dirty.length > 0) {
        useUi
          .getState()
          .toast(tp('toast.replacedDirty', dirty.length), 'info')
      }
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    }
    await get().run()
  },

  replaceInFile: async (file) => {
    await replaceInOneFile(file)
  },

  replaceMatchInFile: async (file, line, column) => {
    await replaceInOneFile(file, { line, column })
  },

  dropResults: () => {
    if (debounce) {
      clearTimeout(debounce)
      debounce = null
    }
    runId += 1
    set({
      results: [],
      total: 0,
      scanned: 0,
      truncated: false,
      running: false,
      pending: false,
      expanded: {},
    })
  },

  clear: () => {
    if (debounce) clearTimeout(debounce)
    debounce = null
    runId += 1
    set({
      query: '',
      results: [],
      total: 0,
      scanned: 0,
      truncated: false,
      running: false,
      pending: false,
      expanded: {},
    })
  },
}))
/**
 * Replace inside one result file: the whole file, or a single match at a known line / column.
 *
 * Writes go to disk (the backend owns matching rules), so an open tab with unsaved edits is skipped
 * instead: the editor buffer would win the next save and silently undo the replacement.
 */
async function replaceInOneFile(file: string, single?: { line: number; column: number }) {
  const { query, replacement, caseSensitive, regex, wholeWord, scope } = useSearch.getState()
  const root = activeRoot()
  if (!root || !query.trim()) return

  const open = useTabs
    .getState()
    .tabs.find((tab) => tab.kind === 'file' && tab.root === root.id && tab.rel === file)
  if (open?.dirty) {
    useUi.getState().toast(tp('toast.replacedDirty', 1), 'info')
    return
  }

  const options = {
    caseSensitive,
    regex,
    wholeWord,
    scope: currentScope(scope),
    maxResults: budget.searchResults(),
  }
  try {
    const res = single
      ? await api.replaceMatch(
          root.id,
          file,
          query,
          options,
          replacement,
          single.line,
          single.column,
        )
      : await api.replaceInFiles(root.id, query, options, replacement, [file])

    if (res.replacedMatches === 0) {
      // The file changed since the search: results are stale, rescan instead of pretending it worked
      await useSearch.getState().run()
      return
    }
    // Line numbers below this point moved: reload the tab, refresh git marks, then rescan
    await useTabs.getState().reload(root.id, file, { silent: true })
    useGit.getState().scheduleRefresh(root.id)
    await useSearch.getState().run()
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
  }
}
