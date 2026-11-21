import { useEffect, useRef } from 'react'
import { useTabs, type TabGroupId } from '../store/tabs'
import { useWorkspace } from '../store/workspace'
import { setFocusedGroup } from '../editor/viewRef'
import { EditorHost } from './EditorHost'
import { TabBar } from './TabBar'
import { SearchBar } from './SearchBar'
import { Splitter } from './Splitter'
import { TideMark } from './TideMark'
import { Welcome } from './Welcome'

type PaneProps = {
  groupId: TabGroupId
  searchOpen: boolean
  /** Bumped on every ⌘F: the open find bar takes the focus back */
  searchFocus: number
  onCloseSearch: () => void
  /** Show the welcome page when the window has no tabs at all */
  showWelcome: boolean
}

function EditorPane({ groupId, searchOpen, searchFocus, onCloseSearch, showWelcome }: PaneProps) {
  const activeGroupId = useTabs((s) => s.activeGroupId)
  const tabCount = useTabs((s) => s.groups.find((g) => g.id === groupId)?.order.length ?? 0)
  const activeKind = useTabs((s) => {
    const group = s.groups.find((g) => g.id === groupId)
    return s.tabs.find((t) => t.id === group?.activeId)?.kind ?? null
  })
  const activePreview = useTabs((s) => {
    const group = s.groups.find((g) => g.id === groupId)
    return Boolean(s.tabs.find((t) => t.id === group?.activeId)?.preview)
  })

  return (
    /* Dropping a file from explorer / source control onto this pane opens it here.
       Hit testing lives in lib/fileDragState.ts: matches on data-group, no event bubbling. */
    <div
      data-group={groupId}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
    >
      <TabBar groupId={groupId} />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <EditorHost groupId={groupId} />
        {tabCount === 0 ? (
          showWelcome ? (
            <Welcome />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-bg">
              <TideMark size={96} tone="muted" />
            </div>
          )
        ) : null}
        {searchOpen &&
        activeGroupId === groupId &&
        (activeKind === 'file' || activeKind === 'untitled') &&
        !activePreview ? (
          <SearchBar onClose={onCloseSearch} focusSeq={searchFocus} />
        ) : null}
      </div>
    </div>
  )
}

export function EditorArea({
  searchOpen,
  searchFocus,
  onCloseSearch,
}: {
  searchOpen: boolean
  searchFocus: number
  onCloseSearch: () => void
}) {
  const splitOrientation = useTabs((s) => s.splitOrientation)
  const splitRatio = useTabs((s) => s.splitRatio)
  const setSplitRatio = useTabs((s) => s.setSplitRatio)
  const activeGroupId = useTabs((s) => s.activeGroupId)
  const totalTabs = useTabs((s) => s.tabs.length)
  const noProject = useWorkspace((s) => s.roots.length === 0)
  const containerRef = useRef<HTMLDivElement>(null)

  // The focused pane decides which side ⌘F / ⌘W / save act on
  useEffect(() => {
    setFocusedGroup(activeGroupId)
  }, [activeGroupId])

  // With no project open the empty state is the welcome page (the project picker);
  // with a project it is just a normal tab, and closing it leaves an empty pane
  const showWelcome = totalTabs === 0 && noProject

  const onDrag = (delta: number) => {
    const el = containerRef.current
    if (!el) return
    const size =
      splitOrientation === 'row' ? el.clientWidth : el.clientHeight
    if (!size) return
    setSplitRatio(useTabs.getState().splitRatio + delta / size)
  }

  if (!splitOrientation) {
    return (
      <div ref={containerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        <EditorPane
          groupId="primary"
          searchOpen={searchOpen}
          searchFocus={searchFocus}
          onCloseSearch={onCloseSearch}
          showWelcome={showWelcome}
        />
      </div>
    )
  }

  const primaryStyle = { flexGrow: splitRatio, flexBasis: 0 }
  const secondaryStyle = { flexGrow: 1 - splitRatio, flexBasis: 0 }

  return (
    <div
      ref={containerRef}
      className={`relative flex min-h-0 min-w-0 flex-1 overflow-hidden ${
        splitOrientation === 'row' ? 'flex-row' : 'flex-col'
      }`}
    >
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={primaryStyle}>
        <EditorPane
          groupId="primary"
          searchOpen={searchOpen}
          searchFocus={searchFocus}
          onCloseSearch={onCloseSearch}
          showWelcome={showWelcome}
        />
      </div>
      <Splitter direction={splitOrientation === 'row' ? 'v' : 'h'} onDrag={onDrag} tone="editor" />
      <div className="flex min-h-0 min-w-0 flex-col overflow-hidden" style={secondaryStyle}>
        <EditorPane
          groupId="secondary"
          searchOpen={searchOpen}
          searchFocus={searchFocus}
          onCloseSearch={onCloseSearch}
          showWelcome={false}
        />
      </div>
    </div>
  )
}
