import { useEffect, useRef, useState } from 'react'
import {
  SearchQuery,
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  setSearchQuery,
} from '@codemirror/search'
import { getEditorView } from '../editor/viewRef'
import { Icon } from './Icon'
import { useT } from '../i18n'

type Props = {
  onClose: () => void
  /** Bumped on every ⌘F: the input takes the focus back even while the bar is already open */
  focusSeq: number
}

function OptionToggle({
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
      className={`flex h-[19px] min-w-[19px] items-center justify-center rounded-[4px] px-1 text-2xs ${
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-hover hover:text-fg'
      }`}
    >
      {label}
    </button>
  )
}

/**
 * Last find text and options, kept across openings (the bar unmounts when it closes). Reopening shows what was
 * searched last, already selected, so a new search can be typed over it — VSCode does the same. The replace
 * text is deliberately not kept: a stale "Replace all" value would be too easy to fire by accident.
 */
const lastFind = { query: '', caseSensitive: false, wholeWord: false, regex: false }

/** VSCode-style in-editor find / replace bar */
export function SearchBar({ onClose, focusSeq }: Props) {
  const t = useT()
  const [query, setQuery] = useState(lastFind.query)
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(lastFind.caseSensitive)
  const [wholeWord, setWholeWord] = useState(lastFind.wholeWord)
  const [regex, setRegex] = useState(lastFind.regex)
  const [showReplace, setShowReplace] = useState(false)
  const [count, setCount] = useState(0)
  const [index, setIndex] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const replaceRef = useRef<HTMLInputElement>(null)

  // The editor selection beats the remembered text: searching what is selected is the most common intent.
  // Runs on open and on every later ⌘F (the bar unmounts when it closes, so `lastFind` carries the previous
  // query over), and always selects the box content so a new search can be typed straight over it.
  useEffect(() => {
    const view = getEditorView()
    const selection = view?.state.selection.main
    if (view && selection && !selection.empty) {
      const text = view.state.sliceDoc(selection.from, selection.to)
      if (text && !text.includes('\n')) setQuery(text)
    }
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [focusSeq])

  const recount = (query: SearchQuery) => {
    const view = getEditorView()
    if (!view) return
    if (view.state.doc.length > 1024 * 1024) {
      setCount(0)
      setIndex(0)
      return
    }
    let total = 0
    let current = 0
    const head = view.state.selection.main.head
    try {
      const cursor = query.getCursor(view.state)
      for (let step = cursor.next(); !step.done; step = cursor.next()) {
        const { from, to } = step.value
        total += 1
        if (from <= head && head <= to) current = total
        if (total > 2000) break
      }
    } catch {
      return
    }
    setCount(total)
    setIndex(current)
  }

  useEffect(() => {
    // Remember the query for the next opening (also when the bar closes right after)
    lastFind.query = query
    lastFind.caseSensitive = caseSensitive
    lastFind.wholeWord = wholeWord
    lastFind.regex = regex
    const view = getEditorView()
    if (!view) return
    const query2 = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: regex,
      wholeWord,
      replace: replacement,
    })
    view.dispatch({ effects: setSearchQuery.of(query2) })
    recount(query2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex])

  const step = (dir: 1 | -1) => {
    const view = getEditorView()
    if (!view) return
    if (dir === 1) findNext(view)
    else findPrevious(view)
    const q = new SearchQuery({
      search: query,
      caseSensitive,
      regexp: regex,
      wholeWord,
      replace: replacement,
    })
    recount(q)
  }

  return (
    <div
      className="absolute right-3 top-2 z-30 w-[470px] overflow-hidden rounded-popup border border-line-soft bg-panel shadow-popup"
    >
      <div className="flex items-center gap-1 px-1.5 py-1">
        <button
          onClick={() => {
            setShowReplace((v) => !v)
            requestAnimationFrame(() => replaceRef.current?.focus())
          }}
          data-tip={showReplace ? t('findbar.collapseReplace') : t('findbar.expandReplace')}
          className="flex h-[22px] w-[18px] shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name={showReplace ? 'chevron-down' : 'chevron-right'} size={12} />
        </button>

        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-[6px] border border-line bg-bg px-1.5 focus-within:border-accent">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
            placeholder={t('findbar.placeholder')}
            spellCheck={false}
            className="h-[24px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
          />
          <span className="shrink-0 whitespace-nowrap text-2xs text-muted">
            {query ? (count === 0 ? t('findbar.noResults') : `${index || 1} / ${count}`) : ''}
          </span>
          <OptionToggle
            active={caseSensitive}
            label="Aa"
            tip={t('findbar.caseSensitive')}
            onClick={() => setCaseSensitive((v) => !v)}
          />
          <OptionToggle
            active={wholeWord}
            label="ab"
            tip={t('findbar.wholeWord')}
            onClick={() => setWholeWord((v) => !v)}
          />
          <OptionToggle
            active={regex}
            label=".*"
            tip={t('findbar.regex')}
            onClick={() => setRegex((v) => !v)}
          />
        </div>

        <button
          onClick={() => step(-1)}
          data-tip={t('findbar.prev')}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="arrow-up" size={13} />
        </button>
        <button
          onClick={() => step(1)}
          data-tip={t('findbar.next')}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="arrow-down" size={13} />
        </button>
        <button
          onClick={onClose}
          data-tip={t('findbar.close')}
          className="flex h-[22px] w-[22px] items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="close" size={12} />
        </button>
      </div>

      {showReplace ? (
        <div className="flex items-center gap-1 px-1.5 pb-1.5 pl-[26px]">
          <div className="flex min-w-0 flex-1 items-center rounded-[6px] border border-line bg-bg px-1.5 focus-within:border-accent">
            <input
              ref={replaceRef}
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const view = getEditorView()
                  if (view) replaceNext(view)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  onClose()
                }
              }}
              placeholder={t('findbar.replacePlaceholder')}
              spellCheck={false}
              className="h-[24px] min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
            />
          </div>
          <button
            onClick={() => {
              const view = getEditorView()
              if (view) replaceNext(view)
            }}
            className="h-[24px] rounded-[5px] border border-line px-2 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            {t('findbar.replace')}
          </button>
          <button
            onClick={() => {
              const view = getEditorView()
              if (view) replaceAll(view)
              setTimeout(() => {
                const v = getEditorView()
                if (v) {
                  const q = new SearchQuery({ search: query, caseSensitive, regexp: regex, wholeWord, replace: replacement })
                  recount(q)
                }
              }, 30)
            }}
            className="h-[24px] rounded-[5px] border border-line px-2 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            {t('search.replaceAll')}
          </button>
        </div>
      ) : null}
    </div>
  )
}