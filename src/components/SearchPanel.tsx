import { useEffect, useMemo, useRef } from 'react'
import { useSearch } from '../store/search'
import { useTabs } from '../store/tabs'
import { useWorkspace } from '../store/workspace'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'
import { basename, dirname } from '../lib/paths'
import { tp, useT } from '../i18n'

function OptionButton({
  active,
  label,
  tip,
  onClick,
}: {
  active: boolean
  label: string
  tip: string
  onClick: () => void
}) {
  return (
    <button
      data-tip={tip}
      onClick={onClick}
      className={`flex h-[20px] min-w-[20px] items-center justify-center rounded-[4px] px-1 text-xs ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {label}
    </button>
  )
}

/** Funnel-icon toggle (for file filters; same size as the text buttons) */
function IconOptionButton({
  active,
  tip,
  onClick,
}: {
  active: boolean
  tip: string
  onClick: () => void
}) {
  return (
    <button
      data-tip={tip}
      aria-label={tip}
      onClick={onClick}
      className={`flex h-[20px] w-[20px] items-center justify-center rounded-[4px] ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      <Icon name="filter" size={13} />
    </button>
  )
}

export function SearchPanel({ focusSeq }: { focusSeq: number }) {
  const t = useT()
  const queryRef = useRef<HTMLInputElement>(null)
  const query = useSearch((s) => s.query)
  const replacement = useSearch((s) => s.replacement)
  const caseSensitive = useSearch((s) => s.caseSensitive)
  const regex = useSearch((s) => s.regex)
  const wholeWord = useSearch((s) => s.wholeWord)
  const include = useSearch((s) => s.include)
  const exclude = useSearch((s) => s.exclude)
  const showFilters = useSearch((s) => s.showFilters)
  const showReplace = useSearch((s) => s.showReplace)
  const scope = useSearch((s) => s.scope)
  const results = useSearch((s) => s.results)
  const total = useSearch((s) => s.total)
  const truncated = useSearch((s) => s.truncated)
  const running = useSearch((s) => s.running)
  // The debounce window also counts as searching: old results are stale, so an empty list isn't the final answer
  const pending = useSearch((s) => s.pending)
  const searching = running || pending
  const expanded = useSearch((s) => s.expanded)

  const setQuery = useSearch((s) => s.setQuery)
  const setReplacement = useSearch((s) => s.setReplacement)
  const toggleOption = useSearch((s) => s.toggleOption)
  const setInclude = useSearch((s) => s.setInclude)
  const setExclude = useSearch((s) => s.setExclude)
  const toggleFilters = useSearch((s) => s.toggleFilters)
  const toggleReplace = useSearch((s) => s.toggleReplace)
  const setScope = useSearch((s) => s.setScope)
  const toggleExpanded = useSearch((s) => s.toggleExpanded)
  const replaceAll = useSearch((s) => s.replaceAll)
  const replaceInFile = useSearch((s) => s.replaceInFile)
  const replaceMatchInFile = useSearch((s) => s.replaceMatchInFile)

  const roots = useWorkspace((s) => s.roots)
  const activeRootId = useWorkspace((s) => s.activeRootId)
  const openAt = useTabs((s) => s.openAt)

  // Search always targets the current project; scope only narrows it to a subdirectory
  const project = roots.find((r) => r.id === activeRootId) ?? roots[0] ?? null

  // ⌘⇧F / the title bar button: put the caret in the query box (and select it) even when the panel is
  // already mounted, otherwise the shortcut only shows the list while typing still goes to the editor
  useEffect(() => {
    if (!focusSeq) return
    const id = requestAnimationFrame(() => {
      queryRef.current?.focus()
      queryRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [focusSeq])

  // This label is only needed when scoped to a subdirectory; the default whole-project row is gone
  const scopeLabel = useMemo(() => {
    if (!scope) return ''
    const root = roots.find((r) => r.id === scope.root)
    return `${root?.name ?? ''}/${scope.rel}`.replace(/\/$/, '')
  }, [scope, roots])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pb-1.5 pt-1">
        <div className="flex items-center gap-1">
          <button
            onClick={toggleReplace}
            data-tip={t('search.toggleReplace')}
            className="flex h-[22px] w-[18px] shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name={showReplace ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[4px] border border-line bg-bg px-1.5 focus-within:border-accent">
            <Icon name="search" size={13} className="shrink-0 text-muted" />
            <input
              ref={queryRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('search.placeholder')}
              spellCheck={false}
              className="h-[26px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
            />
            <OptionButton
              active={caseSensitive}
              label="Aa"
              tip={t('search.caseSensitive')}
              onClick={() => toggleOption('caseSensitive')}
            />
            <OptionButton
              active={wholeWord}
              label="ab"
              tip={t('search.wholeWord')}
              onClick={() => toggleOption('wholeWord')}
            />
            <OptionButton active={regex} label=".*" tip={t('search.regex')} onClick={() => toggleOption('regex')} />
            <IconOptionButton
              active={showFilters || Boolean(include || exclude)}
              tip={t('search.fileFilter')}
              onClick={toggleFilters}
            />
          </div>
        </div>

        {showFilters ? (
          <div className="mt-1 flex flex-col gap-1 pl-[22px]">
            <div className="flex min-w-0 items-center gap-1 rounded-[4px] border border-line bg-bg px-1.5 focus-within:border-accent">
              <span className="shrink-0 text-2xs text-muted">{t('search.include')}</span>
              <input
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                placeholder={t('search.includePlaceholder')}
                spellCheck={false}
                className="h-[24px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/50"
              />
            </div>
            <div className="flex min-w-0 items-center gap-1 rounded-[4px] border border-line bg-bg px-1.5 focus-within:border-accent">
              <span className="shrink-0 text-2xs text-muted">{t('search.exclude')}</span>
              <input
                value={exclude}
                onChange={(e) => setExclude(e.target.value)}
                placeholder={t('search.excludePlaceholder')}
                spellCheck={false}
                className="h-[24px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/50"
              />
            </div>
          </div>
        ) : null}

        {showReplace ? (
          <div className="mt-1 flex items-center gap-1 pl-[22px]">
            <div className="flex min-w-0 flex-1 items-center rounded-[4px] border border-line bg-bg px-1.5 focus-within:border-accent">
              <input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder={t('search.replacePlaceholder')}
                spellCheck={false}
                className="h-[26px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
              />
            </div>
            <button
              onClick={() => void replaceAll()}
              disabled={total === 0}
              className="h-[26px] rounded-[4px] border border-line px-2 text-xs text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
            >
              {t('search.replaceAll')}
            </button>
          </div>
        ) : null}

        {scope ? (
          <div className="mt-1.5 flex items-center gap-1 pl-[22px]">
            <button
              onClick={() => setScope(null)}
              data-tip={t('search.backToProject')}
              className="flex h-[20px] max-w-[190px] items-center gap-1 truncate rounded-full border border-accent/50 bg-accent/12 px-2 text-2xs text-accent hover:bg-accent/20"
            >
              <Icon name="folder-open" size={11} />
              <span className="truncate">{scopeLabel}</span>
              <Icon name="close" size={10} className="shrink-0 opacity-70" />
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {searching && query.trim() ? (
          <div className="flex items-center justify-center gap-1.5 px-3 py-4 text-xs text-muted">
            <Icon name="spinner" size={12} className="animate-spin" />
            {t('search.searching')}
          </div>
        ) : null}

        {!searching && query.trim() && results.length === 0 ? (
          <div className="px-3 py-4 text-center text-xs text-muted">{t('search.noResults')}</div>
        ) : null}

        {project
          ? results.map((file) => {
              const open = expanded[file.file] ?? true
              return (
                <div key={file.file}>
                  <div
                    onClick={() => toggleExpanded(file.file)}
                    className="group flex cursor-pointer items-center gap-1.5 px-2 py-[3px] text-sm row-hover"
                  >
                    <Icon
                      name={open ? 'chevron-down' : 'chevron-right'}
                      size={11}
                      className="shrink-0 text-muted"
                    />
                    <FileIcon name={basename(file.file)} size={14} />
                    <span className="min-w-0 truncate text-fg/90">{basename(file.file)}</span>
                    <span className="min-w-0 truncate text-2xs text-muted/70">{dirname(file.file)}</span>
                    {/* Replace every match of this file: sits where VSCode puts it, only while replacing */}
                    {showReplace ? (
                      <button
                        data-tip={t('search.replaceFile')}
                        aria-label={t('search.replaceFile')}
                        onClick={(e) => {
                          e.stopPropagation()
                          void replaceInFile(file.file)
                        }}
                        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[4px] text-muted opacity-0 transition-opacity duration-fast hover:bg-hover hover:text-fg group-hover:opacity-100"
                      >
                        <Icon name="replace" size={12} />
                      </button>
                    ) : null}
                    <span className="ml-auto min-w-[18px] shrink-0 rounded-full bg-accent/12 px-1.5 text-center text-2xs font-medium tabular-nums text-accent">
                      {file.matches.length}
                    </span>
                  </div>

                  {open
                    ? file.matches.map((match, index) => {
                        // Both sides give ranges in characters (not bytes), so indent / CJK / tabs never shift
                        const start = Math.max(0, match.previewStart)
                        const length = Math.max(0, match.previewLength)
                        const before = match.preview.slice(0, start)
                        const middle = match.preview.slice(start, start + length)
                        const after = match.preview.slice(start + length)
                        const previewingReplace = showReplace && replacement.length > 0
                        return (
                          <div
                            key={`${file.file}:${match.line}:${match.column}:${index}`}
                            onClick={() =>
                              void openAt(
                                project.id,
                                file.file,
                                match.line,
                                match.column,
                                match.length,
                              )
                            }
                            className="group flex cursor-pointer items-baseline gap-2 py-[2px] pl-8 pr-2 text-xs row-hover"
                          >
                            <span className="w-8 shrink-0 text-right text-2xs text-muted/60">
                              {match.line}
                            </span>
                            <span className="min-w-0 truncate text-muted">
                              {before}
                              <span
                                className={`rounded-[2px] px-0.5 ${
                                  previewingReplace
                                    ? 'bg-danger/10 text-muted line-through decoration-danger/60'
                                    : 'bg-warning/25 text-fg'
                                }`}
                              >
                                {middle}
                              </span>
                              {previewingReplace ? (
                                <>
                                  <span className="mx-1 text-muted/50">→</span>
                                  <span className="rounded-[2px] bg-success/15 px-0.5 text-fg">
                                    {replacement}
                                  </span>
                                </>
                              ) : null}
                              {after}
                            </span>
                            {/* Replace just this match (VSCode's per-result replace action) */}
                            {showReplace ? (
                              <button
                                data-tip={t('search.replaceOne')}
                                aria-label={t('search.replaceOne')}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  void replaceMatchInFile(file.file, match.line, match.column)
                                }}
                                className="ml-auto flex h-[16px] w-[16px] shrink-0 items-center justify-center self-center rounded-[4px] text-muted opacity-0 transition-opacity duration-fast hover:bg-hover hover:text-fg group-hover:opacity-100"
                              >
                                <Icon name="replace" size={11} />
                              </button>
                            ) : null}
                          </div>
                        )
                      })
                    : null}
                </div>
              )
            })
          : null}
      </div>

      <div className="flex h-[22px] shrink-0 items-center gap-2 border-t border-line px-2 text-2xs text-muted">
        <span className="min-w-0 truncate tabular-nums">
          {results.length > 0
            ? tp('search.results', results.length, { matches: total })
            : t('search.noResults')}
        </span>
        {truncated ? <span className="text-warning">{t('search.truncated')}</span> : null}
      </div>
    </div>
  )
}