import { dispatchShortcut } from './lib/shortcutDispatch'
import { registerCommandHandlers } from './lib/commandRuntime'
import { dragTerminalHeight, terminalAvailableHeight } from './lib/terminalLayout'
import { Suspense, lazy, useEffect, useRef, useState } from 'react'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { listen } from '@tauri-apps/api/event'
import { TitleBar } from './components/TitleBar'
import { ActivityBar } from './components/ActivityBar'
import { FileTree, ExplorerHeader } from './components/FileTree'
import { SearchPanel } from './components/SearchPanel'
import { GitPanel } from './components/GitPanel'
import { StructurePanel } from './components/StructurePanel'
import { EditorArea } from './components/EditorArea'
import { StatusBar } from './components/StatusBar'
import { Splitter } from './components/Splitter'
import { Overlays } from './components/Overlays'
import { ThemeMenu } from './components/ThemeMenu'
import { BranchMenu } from './components/BranchMenu'
import { ConfirmDialog, PromptDialog } from './components/Dialogs'
import { CommitHoverCard } from './components/CommitHoverCard'
import { Toasts } from './components/Toasts'
import { FileDragGhost } from './components/FileDragGhost'
import { TooltipLayer } from './components/Tooltip'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileIconSprite } from './components/FileIconSprite'
import { useSettings } from './store/settings'
import { useTabs } from './store/tabs'
import { IS_PRIMARY_WINDOW, useWorkspace } from './store/workspace'
import { useUi } from './store/ui'
import { useGit } from './store/git'
import { setupPtyEvents, useTerminal } from './store/terminal'
import {
  openDroppedPaths,
  openFolderDialog,
  openSettings,
  openWorkspace,
} from './lib/actions'
import { api, type RecentWorkspace, type Settings } from './lib/ipc'
import { installMemoryLifecycle } from './lib/memory'
import {
  armEditorSession,
  flushEditorSession,
  installEditorSession,
  restoreEditorSession,
} from './lib/editorSession'
import { useSearch } from './store/search'
import { flushBeforeInstall, startUpdateWatcher } from './store/update'
import { onUpdateFlush } from './lib/update'
import { useT, onLocaleChange } from './i18n'
import { refreshEditorDomLabels } from './editor/locale'
import { ensureEditorState } from './editor/openState'
import { useAgent } from './store/agent'
import { installAgentEvents } from './lib/agentEvents'
import { flushAgentTabs, installAgentBridge, restoreAgentChats } from './lib/agentSession'

// The terminal is heavy (xterm + webgl): load on demand so the first screen does not carry it
const TerminalPanel = lazy(() => import('./components/TerminalPanel'))

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

export function App() {
  const t = useT()
  // Subscribe only to fields actually used: a splitter drag changes height every frame, and subscribing to
  // the whole settings object would re-render the entire tree
  const sidebarVisibleSetting = useSettings((s) => s.sidebarVisible)
  const panelVisibleSetting = useSettings((s) => s.panelVisible)
  const sidebarWidth = useSettings((s) => s.sidebarWidth)
  const agentEnabled = useSettings((s) => s.agentEnabled)
  const patchSettings = useSettings((s) => s.patch)
  const activeTabId = useTabs((s) => s.activeId)
  const terminalVisible = useTerminal((s) => s.visible)
  const panelVisible = panelVisibleSetting && terminalVisible
  const terminalCount = useTerminal((s) => s.tabs.length)
  const activityView = useUi((s) => s.activityView)
  const setActivityView = useUi((s) => s.setActivityView)
  const [searchOpen, setSearchOpen] = useState(false)
  /** Bumped on every ⌘F: an already open find bar takes focus back (and selects) instead of ignoring the key */
  const editorRegionRef = useRef<HTMLDivElement>(null)
  const [editorRegionHeight, setEditorRegionHeight] = useState(0)
  const terminalMaximized = useTerminal(state => state.maximized)
  const normalPanelHeight = useSettings(state => state.panelHeight)
  useEffect(() => {
    const region = editorRegionRef.current
    if (!region) return
    const measure = () => setEditorRegionHeight(region.getBoundingClientRect().height)
    const observer = new ResizeObserver(measure)
    observer.observe(region)
    measure()
    return () => observer.disconnect()
  })
  useEffect(() => {
    if (!panelVisible) useTerminal.getState().setMaximized(false)
  }, [panelVisible])
  const [searchFocus, setSearchFocus] = useState(0)
  /** Same for the sidebar's search view (⌘⇧F / title bar button): land in the query box, not just on the list */
  const [panelSearchFocus, setPanelSearchFocus] = useState(0)
  /**
   * Nothing is drawn until the session is restored.
   *
   * Restoring paints in several steps (project opens → explorer reads the root → the restored folder chain
   * expands → tabs appear), and each step was a visible pop. Holding the first frame back makes the window
   * come up already complete. A timer guards against a slow disk / network project: after it the UI shows
   * whatever is there rather than an empty window.
   */
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    // Release editor documents and caches on blur / hide
    installMemoryLifecycle()
    installEditorSession()
    installAgentEvents()
    installAgentBridge()
    let cancelled = false
    void (async () => {
      try {
        await useWorkspace.getState().initSession()
        if (cancelled) return
        const params = new URLSearchParams(window.location.search)
        // A new window can pass ?open= with the project to open. The backend already reserved it for this
        // window, so the placeholder check here recognizes "our own" and opens it as usual.
        const target = params.get('open')
        if (target) {
          await openWorkspace(target)
          return
        }
        if (!IS_PRIMARY_WINDOW) return
        // Command line / Finder launch args take priority over restoring the last session
        try {
          const started = await api.startTarget()
          if (cancelled) return
          if (started.roots.length > 0) {
            await useWorkspace.getState().openFolders(started.roots)
            if (started.file) {
              const root = useWorkspace.getState().activeRootId
              if (root) await useTabs.getState().openFile(root, started.file)
            }
            return
          }
        } catch {
          /* No launch args */
        }
        if (!cancelled) await restoreEditorSession()
        if (!cancelled) useTabs.getState().restoreUntitledDrafts()
      } finally {
        // Chat tabs are restored on every startup path (launch args / saved project / blank):
        // they are filtered by the roots that are actually open.
        if (!cancelled) await restoreAgentChats()
        // Warm the active file's state before the first frame: the gate below opens on an editor that already
        // has its text (and its language pack), instead of an empty pane that fills in a frame later
        const snapshot = useTabs.getState()
        const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeId)
        if (activeTab) await ensureEditorState(activeTab, snapshot.activeGroupId).catch(() => null)
        // Startup (including restore) is done: only from here on may open files be written back to the session
        armEditorSession()
        setHydrated(true)
      }
    })()
    // Safety net: a stalled restore must not leave the window blank
    const revealTimer = setTimeout(() => setHydrated(true), 1500)
    void setupPtyEvents()

    // Global safety net: an uncaught error only toasts, never blanks the UI
    const onError = (event: ErrorEvent) => {
      console.error('[Tide] uncaught', event.error ?? event.message)
    }
    const onRejection = (event: PromiseRejectionEvent) => {
      console.error('[Tide] unhandled rejection', event.reason)
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      cancelled = true
      clearTimeout(revealTimer)
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  // After a language switch, CodeMirror's own DOM (fold arrow titles) follows too
  useEffect(() => onLocaleChange(refreshEditorDomLabels), [])

  // Drag files / folders into the window
  useEffect(() => {
    let unlisten: (() => void) | null = null
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          void openDroppedPaths(event.payload.paths)
        }
      })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  // Sync recent-workspace add/remove from any window to the others
  useEffect(() => {
    let unlisten: (() => void) | null = null
    void listen<RecentWorkspace[]>('session:recent-changed', (event) => {
      useWorkspace.setState({ recent: event.payload })
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  // Appearance settings (theme / icon set / font size) sync across windows: this one follows immediately
  useEffect(() => {
    let unlisten: (() => void) | null = null
    void listen<Settings>('settings:changed', (event) => {
      useSettings.getState().applyExternal(event.payload)
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  // In-app update: release builds report the last install and run one quiet check at startup; debug
  // builds leave Settings → About as the manual entry. Only the main window starts this watcher.
  // `startUpdateWatcher` guards itself once, safe for StrictMode double mounts / HMR reloads.
  useEffect(() => {
    if (!IS_PRIMARY_WINDOW) return
    startUpdateWatcher()
  }, [])

  // Installing a new version ends the whole process: when Rust broadcasts `update:flush`,
  // every window flushes its settings / session / unsaved edits like a normal quit
  useEffect(() => {
    let unlisten: (() => void) | null = null
    void onUpdateFlush(() => {
      // Same flush as a normal quit: settings (400ms debounced) + editor session + unsaved edits
      void flushBeforeInstall()
    })
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    return () => {
      unlisten?.()
    }
  }, [])

  // Settings may still be in the 400ms debounce: flush on window hide / unload, so "edit then quit" keeps config
  useEffect(() => {
    const flush = () => {
      useSettings.getState().flush()
      // Flush the editor session (open files + caret) too
      flushEditorSession()
      // Layout (roots + which folders are open): the next start paints the same tree
      useWorkspace.getState().flushSession()
      // Agent transcripts and open chat tabs
      useAgent.getState().flushChats()
      flushAgentTabs()
    }
    let unlisten: (() => void) | null = null
    void listen('app:hidden', flush)
      .then((fn) => {
        unlisten = fn
      })
      .catch(() => {})
    window.addEventListener('beforeunload', flush)
    return () => {
      unlisten?.()
      window.removeEventListener('beforeunload', flush)
    }
  }, [])

  // Turning the agent off must not leave a CLI writing into the project behind
  useEffect(() => {
    return useSettings.subscribe((state, previous) => {
      if (!previous.agentEnabled || state.agentEnabled) return
      const running = useAgent.getState().running
      for (const chatId of Object.keys(running)) void useAgent.getState().stop(chatId)
    })
  }, [])

  // Detect local agent CLIs after the first paint: a new chat then starts with a usable agent
  // instead of showing an empty picker for a couple of seconds
  useEffect(() => {
    if (!hydrated || !agentEnabled) return
    const timer = setTimeout(() => void useAgent.getState().loadProviders(), 1200)
    return () => clearTimeout(timer)
  }, [hydrated, agentEnabled])

  // Keep git caches in sync on project switch / close: the old project's state is dropped at once and the
  // new one probed immediately, so the Source Control badge does not keep the previous project's count.
  // (openWorkspace resets on switch; this covers close, startup restore, remove and other entries)
  useEffect(() => {
    let ids = useWorkspace.getState().roots.map((r) => r.id)
    return useWorkspace.subscribe((state) => {
      const next = state.roots.map((r) => r.id)
      if (next.length === ids.length && next.every((id, i) => id === ids[i])) return
      const git = useGit.getState()
      for (const id of ids) if (!next.includes(id)) git.forget(id)
      const added = next.filter((id) => !ids.includes(id))
      ids = next
      for (const id of added) void git.refresh(id)

      // The branch menu is bound to a workspace: after a switch its root is unregistered
      const branchMenu = useUi.getState().branchMenu
      if (branchMenu && !next.includes(branchMenu.root)) useUi.getState().closeBranchMenu()

      // Search results belong to the previous project too: otherwise the list still shows old paths and a
      // click looks for a missing file in the new project. The scope (subdir) is void as well.
      const search = useSearch.getState()
      const staleScope = Boolean(search.scope && !next.includes(search.scope.root))
      search.dropResults()
      if (staleScope) {
        // setScope reruns the search for the new project itself
        search.setScope(null)
      } else if (useUi.getState().activityView === 'search' && search.query.trim()) {
        void useSearch.getState().run()
      }
    })
  }, [])

  // Incremental git refresh on window focus
  useEffect(() => {
    const onFocus = () => void useGit.getState().refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])

  useEffect(() => registerCommandHandlers({
    'view.search': { run: () => {
      useUi.getState().setActivityView('search')
      if (!useSettings.getState().sidebarVisible) useSettings.getState().patch({ sidebarVisible: true })
      setPanelSearchFocus(n => n + 1)
    } },
    'editor.find': {
      available: () => {
        const tabs = useTabs.getState()
        const active = tabs.tabs.find(tab => tab.id === tabs.activeId)
        return Boolean(active && (active.kind === 'file' || active.kind === 'untitled') && !active.preview)
      },
      run: () => { setSearchOpen(true); setSearchFocus(n => n + 1) },
    },
  }), [])

  useEffect(() => {
    // Capture before CodeMirror/xterm; recording is handled before all app commands.
    const handler = (event: KeyboardEvent) => { dispatchShortcut(event) }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Esc closes the in-editor search bar
  useEffect(() => {
    if (!searchOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useUi.getState().overlay) setSearchOpen(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [searchOpen])

  // A new terminal makes sure the panel is visible
  useEffect(() => {
    if (terminalVisible && !panelVisibleSetting) patchSettings({ panelVisible: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalVisible])

  // Collapse the search bar on tab switch (it must not show on an unrelated file)
  useEffect(() => {
    setSearchOpen(false)
  }, [activeTabId])

  // Drop results when leaving the search view: hundreds of matches with preview text need not stay in memory.
  // Coming back with a query reruns it, so an empty list is not read as "no matches".
  useEffect(() => {
    if (activityView !== 'search') {
      useSearch.getState().dropResults()
      return
    }
    const search = useSearch.getState()
    if (search.query.trim() && search.results.length === 0 && !search.running) void search.run()
  }, [activityView])

  const hasRoots = useWorkspace((s) => s.roots.length > 0)
  // The structure view has its own empty state and does not need a project.
  const sidebarVisible = sidebarVisibleSetting && (hasRoots || activityView === 'structure')
  const sidebarTitle =
    activityView === 'explorer'
      ? t('sidebar.explorer')
      : activityView === 'search'
        ? t('sidebar.search')
        : activityView === 'git'
          ? t('sidebar.git')
          : t('sidebar.structure')

  // Before the first frame: themed background only, no half-restored layout (see `hydrated`)
  if (!hydrated) return <div className="h-full w-full bg-bg" />

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg text-fg">
      <FileIconSprite />
      <TitleBar />

      <div className="flex min-h-0 flex-1">
        <ActivityBar
          view={activityView}
          onChange={(v) => {
            if (activityView === v && sidebarVisible) {
              patchSettings({ sidebarVisible: false })
            } else {
              setActivityView(v)
              patchSettings({ sidebarVisible: true })
            }
          }}
          onOpenSettings={() => openSettings()}
        />

        {sidebarVisible ? (
          <>
            <aside
              className="tide-sidebar flex min-h-0 shrink-0 flex-col overflow-hidden bg-panel"
              style={{ width: sidebarWidth }}
            >
              <header className="flex h-[32px] shrink-0 items-center pl-3 pr-1.5">
                {activityView === 'explorer' ? (
                  <ExplorerHeader />
                ) : (
                  <span className="min-w-0 truncate text-xs font-semibold text-fg/80">
                    {sidebarTitle}
                  </span>
                )}
              </header>
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                <ErrorBoundary label={sidebarTitle}>
                  {activityView === 'explorer' ? (
                    <FileTree />
                  ) : activityView === 'search' ? (
                    <SearchPanel focusSeq={panelSearchFocus} />
                  ) : activityView === 'git' ? (
                    <GitPanel />
                  ) : (
                    <StructurePanel />
                  )}
                </ErrorBoundary>
              </div>
            </aside>
            <Splitter
              direction="v"
              onDrag={(dx) =>
                patchSettings({
                  // Read the store directly: React may not have committed the previous frame's width yet
                  sidebarWidth: clamp(useSettings.getState().sidebarWidth + dx, 180, 560),
                })
              }
              onCommit={() => useSettings.getState().flush()}
            />
          </>
        ) : null}

        <div ref={editorRegionRef} className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className={terminalMaximized && panelVisible ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}>
          <ErrorBoundary label={t('app.editor')}>
            <EditorArea
              searchOpen={searchOpen}
              searchFocus={searchFocus}
              onCloseSearch={() => setSearchOpen(false)}
            />
          </ErrorBoundary>

          </div>
          {panelVisible ? (
            <Splitter
              direction="h"
              onDrag={(dy) => {
                const next = dragTerminalHeight(useSettings.getState().panelHeight,
                  useTerminal.getState().maximized, dy, editorRegionRef.current?.getBoundingClientRect().height ?? 0)
                useTerminal.getState().setMaximized(next.maximized)
                if (!next.maximized) patchSettings({ panelHeight: next.height })
              }}
            />
          ) : null}

          {/* Don't unmount the terminal when the panel collapses: the xterm instance (scrollback and glyph
              cache) stays, so reopening shows the same screen. Hidden via display:none; on expand the
              ResizeObserver / active change triggers a fit + full redraw */}
          {terminalCount > 0 ? (
            <div className={panelVisible ? 'shrink-0 overflow-hidden' : 'hidden'}>
              <Suspense fallback={null}>
                <TerminalPanel height={terminalMaximized ? terminalAvailableHeight(editorRegionHeight) : Math.min(normalPanelHeight, terminalAvailableHeight(editorRegionHeight))} />
              </Suspense>
            </div>
          ) : null}
        </div>
      </div>

      <StatusBar />

      <Overlays />
      <ThemeMenu />
      <BranchMenu />
      <CommitHoverCard />
      <ConfirmDialog />
      <PromptDialog />
      <Toasts />
      <FileDragGhost />
      <TooltipLayer />
    </div>
  )
}
