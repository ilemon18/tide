import { useCallback, useEffect, useRef, useState } from 'react'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { Icon } from './Icon'
import { THEME_GROUPS, palettes, themeLabel, type ThemeId } from '../theme/palettes'
import { useT } from '../i18n'

const MENU_WIDTH = 188
const MARGIN = 8

/**
 * Holding an arrow key would switch themes on every repeat, and each apply rewrites CSS vars,
 * reconfigures the editor, notifies the native window, writes disk and broadcasts -- overlapping
 * applies step on each other. So only the highlight follows the cursor; the real apply is debounced
 * and settles 140ms after you stop.
 */
const PREVIEW_DELAY = 140

/** Flat menu order: light -> dark -> eye-friendly; arrow keys walk this order */
const THEME_ITEMS: ThemeId[] = THEME_GROUPS.flatMap((group) => group.ids)
const THEME_INDEX = new Map<ThemeId, number>(THEME_ITEMS.map((id, index) => [id, index]))

export function ThemeMenu() {
  const t = useT()
  const menu = useUi((s) => s.themeMenu)
  const close = useUi((s) => s.closeThemeMenu)
  const theme = useSettings((s) => s.theme)
  const setTheme = useSettings((s) => s.setTheme)

  const listRef = useRef<HTMLDivElement>(null)
  const cursorRef = useRef(0)
  const [cursor, setCursor] = useState(0)
  // The checkmark follows the cursor (the "about to apply / applied" theme) and skips the debounce
  const [picked, setPicked] = useState<ThemeId>(THEME_ITEMS[0])

  const pendingRef = useRef<ThemeId | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /** Apply any pending preview right now (used on close / unmount) */
  const commit = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const next = pendingRef.current
    pendingRef.current = null
    if (next) setTheme(next)
  }, [setTheme])

  /** Preview a theme: checkmark updates at once, the apply is debounced so only the last one wins */
  const preview = useCallback(
    (id: ThemeId) => {
      setPicked(id)
      pendingRef.current = id
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const next = pendingRef.current
        pendingRef.current = null
        if (next) setTheme(next)
      }, PREVIEW_DELAY)
    },
    [setTheme],
  )

  // On open align the highlight to the current theme; on close flush the debounced preview
  useEffect(() => {
    if (!menu) {
      commit()
      return
    }
    const index = Math.max(0, THEME_INDEX.get(theme as ThemeId) ?? 0)
    cursorRef.current = index
    setCursor(index)
    setPicked(THEME_ITEMS[index])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu])

  useEffect(() => commit, [commit])

  // Up/Down move the highlight and preview the theme; Enter / Esc close
  useEffect(() => {
    if (!menu) return
    const move = (delta: number) => {
      const next = Math.min(THEME_ITEMS.length - 1, Math.max(0, cursorRef.current + delta))
      if (next === cursorRef.current) return
      cursorRef.current = next
      setCursor(next)
      preview(THEME_ITEMS[next])
    }
    const onKey = (event: KeyboardEvent) => {
      // Every key only moves the highlight and resets the debounce: holding it does not switch themes
      // in a chain, it settles once you stop
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        move(1)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        move(-1)
      } else if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [menu, close, preview])

  // Scroll the highlighted item into view (needed with many themes and a capped menu height)
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  if (!menu) return null

  const pick = (id: ThemeId) => {
    // A click is an explicit choice: skip the debounce, and do not let a pending preview override it
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
    setTheme(id)
    close()
  }

  // Expand upwards from the bottom: only clamp horizontally, cap the height with a scroll limit
  const left = Math.min(Math.max(MARGIN, menu.left), window.innerWidth - MENU_WIDTH - MARGIN)
  const maxHeight = Math.max(200, menu.maxHeight)

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={close} />
      <div
        ref={listRef}
        className="fixed z-50 overflow-y-auto rounded-popup border border-line-soft bg-panel py-1 shadow-popup"
        style={{
          left,
          bottom: menu.bottom,
          width: MENU_WIDTH,
          maxHeight,
        }}
      >
        <div className="px-3 py-1 text-2xs font-semibold tracking-wide text-muted">
          {t('settings.appearance.theme')}
        </div>

        {THEME_GROUPS.map((group) => (
          <div key={group.group}>
            <div className="px-3 pb-0.5 pt-1.5 text-2xs font-medium text-muted/70">
              {t(group.titleKey)}
            </div>
            {group.ids.map((id) => (
              <button
                key={id}
                type="button"
                data-active={cursor === THEME_INDEX.get(id)}
                onClick={() => pick(id)}
                className={`flex w-full items-center gap-1.5 px-3 py-[5px] text-left text-sm text-fg ${
                  cursor === THEME_INDEX.get(id) ? 'bg-hover' : 'hover:bg-hover'
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{themeLabel(palettes[id], t)}</span>
                {picked === id ? <Icon name="check" size={11} className="shrink-0 text-accent" /> : null}
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  )
}
