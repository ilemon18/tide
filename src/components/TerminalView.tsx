import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { api, errorText } from '../lib/ipc'
import { useSettings } from '../store/settings'
import { registerPtyHandler, useTerminal, type TerminalTab } from '../store/terminal'
import { buildTerminalTheme } from '../theme/xtermTheme'
import { monoStack } from '../editor/stateCache'
import { budget } from '../lib/memoryBudget'
import { isLayoutDragging, onLayoutDragging } from '../lib/layoutBus'
import { isMac } from '../lib/paths'
import { shortcutKey } from '../lib/keys'
import { isLowDpi, onLowDpiChange } from '../lib/displayScale'


/**
 * xterm drops printable punctuation while the platform shortcut modifier is held. Return the visible
 * character for combinations that should be treated as text input instead of terminal control keys.
 */
function terminalTextCharacter(event: KeyboardEvent, mac: boolean): string | null {
  const primary = mac ? event.metaKey : event.ctrlKey
  if (!primary || event.altKey || event.isComposing || event.keyCode === 229) return null
  if (event.key.length !== 1 || /[\p{L}\p{N}\s]/u.test(event.key)) return null
  // Preserve Ctrl+[ / Ctrl+\ and the rest of readline's control-key vocabulary on Windows/Linux.
  if (!mac && !event.shiftKey && event.key !== '=' && event.key !== '-') return null
  return event.key
}

/** Command + the physical slash key, including layouts/IMEs that report `Process` instead of a character. */
function isCommandSlash(event: KeyboardEvent, mac: boolean): boolean {
  if (!mac || !event.metaKey || event.ctrlKey || event.altKey) return false
  return event.code === 'Slash' || event.keyCode === 191 || shortcutKey(event) === '/'
}

/** Abandon an IME capture if a composition never reports its end; never send its preview. */
const IME_SLASH_COMPOSITION_TIMEOUT_MS = 30_000
/** WKWebView can commit the textarea without emitting input/compositionend; poll within this bound. */
const IME_SLASH_FALLBACK_MS = 120
const IME_SLASH_POLL_MS = 8

type Props = {
  tab: TerminalTab
  active: boolean
}

export function TerminalView({ tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyRef = useRef<string | null>(null)
  const activeRef = useRef(active)
  const panelOpenRef = useRef(useTerminal.getState().visible)
  const documentVisibleRef = useRef(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  )
  const flushOutputRef = useRef<() => void>(() => {})

  const panelOpen = useTerminal((s) => s.visible)

  const palette = useSettings((s) => s.palette)
  const fontSize = useSettings((s) => s.terminalFontSize)
  const fontFamily = useSettings((s) => s.fontFamily)
  const scrollback = useSettings((s) => s.terminalScrollback)
  /** Effective buffer: each scrollback line keeps its cells in memory, so lightweight mode caps it */
  const effectiveScrollback = budget.terminalScrollback(scrollback)
  const useWebgl = useSettings((s) => s.terminalWebgl)

  // Create the xterm instance and PTY session only once
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let disposed = false
    let unregister: (() => void) | null = null
    let webglAddon: WebglAddon | null = null
    const mac = isMac()

    const term = new Terminal({
      fontFamily: monoStack(fontFamily),
      fontSize,
      lineHeight: 1.25,
      theme: buildTerminalTheme(palette),
      scrollback: effectiveScrollback,
      cursorBlink: true,
      cursorStyle: 'block',
      macOptionIsMeta: true,
      allowTransparency: false,
      // 1x displays collapse a 12px 400-weight stem into one faint pixel; one step up keeps text legible
      fontWeight: isLowDpi() ? 500 : 400,
      fontWeightBold: isLowDpi() ? 650 : 600,
    })
    termRef.current = term

    const fit = new FitAddon()
    term.loadAddon(fit)
    fitRef.current = fit

    try {
      term.open(host)
    } catch (e) {
      console.error('终端初始化失败', errorText(e))
      return () => {
        try {
          term.dispose()
        } catch {
          /* ignore */
        }
      }
    }

    // The WebGL renderer uses GPU memory; off by default, can be enabled in settings
    if (useWebgl) {
      try {
        webglAddon = new WebglAddon()
        webglAddon.onContextLoss(() => {
          try {
            webglAddon?.dispose()
          } catch {
            /* ignore */
          }
          webglAddon = null
          // Force one repaint after falling back to the DOM renderer, else half the screen may stay blank
          try {
            term.refresh(0, term.rows - 1)
          } catch {
            /* ignore */
          }
        })
        term.loadAddon(webglAddon)
      } catch {
        webglAddon = null
      }
    }

    const safeFit = () => {
      if (disposed) return
      if (!host.clientWidth || !host.clientHeight) return
      try {
        fit.fit()
      } catch {
        /* ignore odd container sizes */
      }
    }

    safeFit()

    const MAX_WRITE = 128 * 1024
    const MAX_HIDDEN_QUEUE = 128 * 1024
    let outputQueue: string[] = []
    let outputSize = 0
    let flushRaf = 0
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let writing = false

    const canWrite = () =>
      !disposed && activeRef.current && panelOpenRef.current && documentVisibleRef.current

    const trimOutputQueue = () => {
      while (outputSize > MAX_HIDDEN_QUEUE && outputQueue.length > 1) {
        const head = outputQueue.shift()
        if (!head) break
        outputSize -= head.length
      }
      if (outputSize <= MAX_HIDDEN_QUEUE || outputQueue.length === 0) return
      const head = outputQueue[0]
      let keep = head.length - (outputSize - MAX_HIDDEN_QUEUE)
      // Do not start a retained tail in the middle of a UTF-16 surrogate pair.
      if (keep > 0 && keep < head.length) {
        const code = head.charCodeAt(keep)
        if (code >= 0xdc00 && code <= 0xdfff) keep -= 1
      }
      outputQueue[0] = head.slice(Math.max(0, keep))
      outputSize = outputQueue[0].length
    }

    const clearFlushSchedule = () => {
      if (flushRaf) cancelAnimationFrame(flushRaf)
      if (flushTimer) clearTimeout(flushTimer)
      flushRaf = 0
      flushTimer = null
    }

    const scheduleFlush = () => {
      if (disposed || writing || outputSize === 0 || !canWrite()) return
      if (flushRaf || flushTimer) return
      // rAF is normally the right cadence, but an occluded WKWebView can throttle it for seconds.
      flushTimer = setTimeout(flush, 80)
      flushRaf = requestAnimationFrame(flush)
    }

    const takeChunk = (): string => {
      let remaining = MAX_WRITE
      const pieces: string[] = []
      while (remaining > 0 && outputQueue.length > 0) {
        const head = outputQueue[0]
        if (head.length <= remaining) {
          outputQueue.shift()
          outputSize -= head.length
          pieces.push(head)
          remaining -= head.length
          continue
        }
        let split = remaining
        // Never leave half of a surrogate pair on either side of a frame boundary.
        if (split > 0 && split < head.length) {
          const next = head.charCodeAt(split)
          const previous = head.charCodeAt(split - 1)
          if (next >= 0xdc00 && next <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
            split -= 1
            // At the one-unit edge, take the pair together rather than making no progress.
            if (split === 0) split = Math.min(head.length, remaining + 1)
          }
        }
        pieces.push(head.slice(0, split))
        outputQueue[0] = head.slice(split)
        outputSize -= split
        remaining = 0
      }
      return pieces.join('')
    }

    function flush() {
      clearFlushSchedule()
      if (disposed || writing || outputSize === 0 || !canWrite()) return
      writing = true
      const chunk = takeChunk()
      try {
        term.write(chunk, () => {
          writing = false
          scheduleFlush()
        })
      } catch {
        writing = false
      }
    }

    /** Queue output locally. Hidden terminals keep only the newest 128 KiB tail. */
    const enqueue = (data: string) => {
      if (disposed || !data) return
      outputQueue.push(data)
      outputSize += data.length
      if (!canWrite()) trimOutputQueue()
      scheduleFlush()
    }

    flushOutputRef.current = () => {
      if (!canWrite()) trimOutputQueue()
      flush()
      scheduleFlush()
    }

    /** Take over an existing PTY and replay output buffered while unmounted */
    const attach = (id: string) => {
      ptyRef.current = id
      const registered = registerPtyHandler(id, enqueue)
      unregister = registered.unregister
      if (registered.backlog) enqueue(registered.backlog)
    }

    const start = async () => {
      // The view may only be remounting (panel collapsed / terminal tab switched): reuse the backend
      // session that is still running instead of spawning a fresh shell on every mount
      const live = useTerminal.getState().tabs.find((t) => t.id === tab.id)
      if (live?.ptyId) {
        attach(live.ptyId)
        safeFit()
        void api.ptyResize(live.ptyId, term.cols, term.rows)
        return
      }
      try {
        const id = await api.ptyOpen(tab.root, tab.rel, term.cols, term.rows)
        if (disposed) {
          void api.ptyClose(id)
          return
        }
        attach(id)
        useTerminal.getState().setPtyId(tab.id, id)
      } catch (e) {
        if (!disposed) {
          try {
            term.write(`\r\n\x1b[31m${errorText(e)}\x1b[0m\r\n`)
          } catch {
            /* ignore */
          }
        }
      }
    }
    void start()

    /**
     * Command + Slash under an IME is special: WebKit may report `Process`/229 while the final
     * `?` / `？` arrives later through composition/input events. Let xterm pass the keydown back
     * to the browser, then use xterm's own data event when it fires. If WKWebView omits those events,
     * poll the textarea for a stable committed value and keep a short bounded fallback.
     */
    type ImeSlashCapture = {
      startValue: string
      composing: boolean
      timer: ReturnType<typeof setTimeout> | null
      startedAt: number
      observed: string
    }
    let imeSlash: ImeSlashCapture | null = null

    const clearImeTimer = (capture: ImeSlashCapture | null = imeSlash) => {
      if (capture?.timer == null) return
      clearTimeout(capture.timer)
      capture.timer = null
    }

    const insertedText = (before: string): string => {
      const after = term.textarea?.value ?? ''
      if (!after || after === before) return ''
      if (after.startsWith(before)) return after.slice(before.length)
      // xterm may rewrite the textarea around the composition: keep only the changed middle.
      let start = 0
      while (start < before.length && start < after.length && before[start] === after[start]) start++
      let beforeEnd = before.length
      let afterEnd = after.length
      while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
        beforeEnd--
        afterEnd--
      }
      return after.slice(start, afterEnd)
    }

    const writePty = (data: string) => {
      if (!data || !ptyRef.current) return
      void api.ptyWrite(ptyRef.current, data)
    }

    const finishImeSlash = (capture: ImeSlashCapture, committed = false) => {
      if (imeSlash !== capture) return
      clearImeTimer(capture)
      if (capture.composing) {
        holdImeSlash(capture)
        return
      }
      // Read the textarea after the browser has committed the edit. CompositionEvent.data is only a
      // preview and can still contain text that the user cancelled.
      const text = insertedText(capture.startValue)
      const expired = performance.now() - capture.startedAt >= IME_SLASH_FALLBACK_MS
      if (!text) {
        if (committed || expired) imeSlash = null
        else capture.timer = setTimeout(() => finishImeSlash(capture), IME_SLASH_POLL_MS)
        return
      }
      // If WKWebView skipped both compositionend and input, the textarea may briefly expose an IME
      // preview. Require the same value on two polls before treating it as final.
      if (!committed && !expired && text !== capture.observed) {
        capture.observed = text
        capture.timer = setTimeout(() => finishImeSlash(capture), IME_SLASH_POLL_MS)
        return
      }
      imeSlash = null
      // The browser has finished editing the textarea but xterm sent nothing: do the write here.
      writePty(text)
      // Restore the pre-key value so a late xterm read cannot emit the same commit again.
      if (term.textarea) term.textarea.value = capture.startValue
    }

    const discardImeSlash = (capture: ImeSlashCapture) => {
      if (imeSlash !== capture) return
      clearImeTimer(capture)
      imeSlash = null
    }

    const holdImeSlash = (capture: ImeSlashCapture) => {
      capture.composing = true
      clearImeTimer(capture)
      // A composition can last longer than the initial keydown. Keep extending its bounded wait as
      // updates arrive, but never flush a preview when the composition simply disappears.
      capture.timer = setTimeout(
        () => discardImeSlash(capture),
        IME_SLASH_COMPOSITION_TIMEOUT_MS,
      )
    }

    const settleImeSlash = (capture: ImeSlashCapture, delay = 0) => {
      clearImeTimer(capture)
      capture.timer = setTimeout(() => finishImeSlash(capture, true), delay)
    }

    const armImeSlash = (composing: boolean) => {
      clearImeTimer()
      const capture: ImeSlashCapture = {
        startValue: term.textarea?.value ?? '',
        composing,
        timer: null,
        startedAt: performance.now(),
        observed: '',
      }
      imeSlash = capture
      if (composing) {
        holdImeSlash(capture)
      } else {
        // Probe immediately instead of waiting the full fallback. A real input/compositionend event
        // still settles (and clears) this capture first, so xterm keeps winning the one-send race.
        capture.timer = setTimeout(() => finishImeSlash(capture), IME_SLASH_POLL_MS)
      }
    }

    const textarea = term.textarea
    const onCompositionStart = () => {
      if (!imeSlash) return
      imeSlash.startValue = textarea?.value ?? ''
      holdImeSlash(imeSlash)
    }
    const onCompositionUpdate = () => {
      if (imeSlash) holdImeSlash(imeSlash)
    }
    const onCompositionEnd = () => {
      const capture = imeSlash
      if (!capture) return
      capture.composing = false
      // xterm's own compositionend handler schedules its data event first; this runs after it and
      // only writes when xterm did not.
      settleImeSlash(capture)
    }
    const onInput = (event: Event) => {
      const capture = imeSlash
      if (!capture) return
      if (
        event instanceof InputEvent &&
        (event.isComposing ||
          event.inputType === 'insertCompositionText' ||
          event.inputType === 'deleteCompositionText')
      ) {
        holdImeSlash(capture)
        return
      }
      capture.composing = false
      settleImeSlash(capture)
    }
    textarea?.addEventListener('compositionstart', onCompositionStart)
    textarea?.addEventListener('compositionupdate', onCompositionUpdate)
    textarea?.addEventListener('compositionend', onCompositionEnd)
    textarea?.addEventListener('input', onInput)

    const dataSub = term.onData((data) => {
      if (disposed) return
      // xterm processed the IME commit: cancel the fallback so the same key cannot be sent twice.
      if (imeSlash && data) discardImeSlash(imeSlash)
      writePty(data)
    })

    // Intercept a few VSCode-style combos; everything else goes to the shell unchanged.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const primary = mac ? event.metaKey : event.ctrlKey
      const key = shortcutKey(event)

      // Known app shortcuts already won in App's capture handler. For the rest, send punctuation that
      // xterm would otherwise drop while Command (or Ctrl+Shift on Windows/Linux) is held.
      const text = terminalTextCharacter(event, mac)
      if (text !== null) {
        event.preventDefault()
        event.stopPropagation()
        writePty(text)
        return false
      }

      // The IME owns this keydown. Do not preventDefault: let it commit the character, then the
      // textarea listeners above capture the result exactly once.
      if (
        isCommandSlash(event, mac) &&
        (event.isComposing || event.keyCode === 229 || event.key === 'Process')
      ) {
        armImeSlash(event.isComposing)
        return false
      }

      if (!primary || event.shiftKey || event.altKey) return true

      // ⌘K clears the screen
      if (key === 'k') {
        // 2J clears the viewport, 3J the scrollback, H returns to the top-left (VSCode's Clear)
        term.write('\x1b[2J\x1b[3J\x1b[H')
        return false
      }

      // ⌘← / ⌘→ (Ctrl on Windows / Linux): start / end of line.
      // xterm swallows Meta + arrow on macOS, so send readline's ^A / ^E instead.
      if (key === 'arrowleft' || key === 'arrowright') {
        const seq = key === 'arrowleft' ? '\x01' : '\x05'
        if (ptyRef.current) void api.ptyWrite(ptyRef.current, seq)
        return false
      }
      return true
    })

    // The bundled font loads asynchronously: remeasure once ready so the first frame does not use
    // the fallback font's (wrong) column width
    void document.fonts?.ready.then(() => {
      if (disposed) return
      safeFit()
      term.refresh(0, term.rows - 1)
      if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
    })

    // Dragging the splitter resizes the container every frame. Continuous fit outruns xterm's repaint
    // and skews line heights / overlaps text; skip during the drag, correct once on release.
    let fitRaf = 0
    const scheduleFit = () => {
      if (disposed || fitRaf) return
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0
        if (disposed || isLayoutDragging()) return
        safeFit()
        if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
      })
    }

    const ro = new ResizeObserver(scheduleFit)
    ro.observe(host)
    const offDrag = onLayoutDragging((active) => {
      if (!active) scheduleFit()
    })

    return () => {
      // Order matters: set the flag, then drop observers, then dispose, so callbacks cannot re-enter
      disposed = true
      clearImeTimer()
      imeSlash = null
      textarea?.removeEventListener('compositionstart', onCompositionStart)
      textarea?.removeEventListener('compositionupdate', onCompositionUpdate)
      textarea?.removeEventListener('compositionend', onCompositionEnd)
      textarea?.removeEventListener('input', onInput)
      ro.disconnect()
      offDrag()
      if (fitRaf) cancelAnimationFrame(fitRaf)
      fitRaf = 0
      clearFlushSchedule()
      outputQueue = []
      outputSize = 0
      flushOutputRef.current = () => {}
      try {
        dataSub.dispose()
      } catch {
        /* ignore */
      }
      try {
        unregister?.()
      } catch {
        /* ignore */
      }
      unregister = null
      try {
        webglAddon?.dispose()
      } catch {
        /* ignore */
      }
      webglAddon = null
      try {
        term.dispose()
      } catch {
        /* ignore */
      }
      termRef.current = null
      fitRef.current = null
      ptyRef.current = null
    }
    // Create only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    activeRef.current = active
    flushOutputRef.current()
  }, [active])

  useEffect(() => {
    panelOpenRef.current = panelOpen
    flushOutputRef.current()
  }, [panelOpen])

  // Visibility changes can stop rAF entirely; resume the per-terminal queue as soon as it runs again.
  useEffect(() => {
    const onVisibility = () => {
      documentVisibleRef.current = document.visibilityState === 'visible'
      flushOutputRef.current()
    }
    const onFocus = () => {
      documentVisibleRef.current = true
      flushOutputRef.current()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Back from another app / minimized: WKWebView paused rendering, so xterm's glyph cache may be
// only half painted (large blank areas / misplaced text). On return, fit + full repaint and sync the PTY size.
  useEffect(() => {
    let raf = 0
    let retry: ReturnType<typeof setTimeout> | null = null

    const restore = () => {
      if (document.visibilityState === 'hidden') return
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        const term = termRef.current
        const host = hostRef.current
        const fit = fitRef.current
        if (!term || !host || !fit) return
        // Right after resuming the container may still be 0-sized; retry later
        if (!host.clientWidth || !host.clientHeight) {
          if (retry) clearTimeout(retry)
          retry = setTimeout(restore, 150)
          return
        }
        try {
          fit.fit()
        } catch {
          /* ignore */
        }
        try {
          term.refresh(0, term.rows - 1)
        } catch {
          /* ignore */
        }
        if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
      })
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') restore()
    }

    window.addEventListener('focus', restore)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (retry) clearTimeout(retry)
      window.removeEventListener('focus', restore)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const host = hostRef.current
    const term = termRef.current
    const fit = fitRef.current
    if (!host || !term || !fit) return
    const id = requestAnimationFrame(() => {
      if (!host.clientWidth) return
      try {
        fit.fit()
      } catch {
        return
      }
      term.refresh(0, term.rows - 1)
      if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
      try {
        term.focus()
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(id)
  }, [active])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = buildTerminalTheme(palette)
  }, [palette])

  // The window can move between a Retina screen and a 1x monitor: reweight the glyphs and reflow
  // the PTY, otherwise the terminal keeps whatever weight it was created with.
  useEffect(() => {
    return onLowDpiChange((low) => {
      const term = termRef.current
      const host = hostRef.current
      if (!term) return
      term.options.fontWeight = low ? 500 : 400
      term.options.fontWeightBold = low ? 650 : 600
      if (host && host.clientWidth > 0 && fitRef.current) {
        try {
          fitRef.current.fit()
        } catch {
          /* ignore */
        }
        if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
      }
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        /* ignore */
      }
    })
  }, [])

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term) return
    term.options.fontSize = fontSize
    if (host && host.clientWidth > 0 && fitRef.current) {
      try {
        fitRef.current.fit()
      } catch {
        /* ignore */
      }
      if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
    }
  }, [fontSize])

  useEffect(() => {
    const term = termRef.current
    const host = hostRef.current
    if (!term) return
    term.options.fontFamily = monoStack(fontFamily)
    if (host && host.clientWidth > 0 && fitRef.current) {
      try {
        fitRef.current.fit()
      } catch {
        /* ignore */
      }
      if (ptyRef.current) void api.ptyResize(ptyRef.current, term.cols, term.rows)
    }
  }, [fontFamily])

  useEffect(() => {
    const term = termRef.current
    // Setting scrollback trims the buffer right away, so switching lightweight mode on releases terminal memory
    if (term) term.options.scrollback = effectiveScrollback
  }, [effectiveScrollback])

  return <div ref={hostRef} className="h-full w-full overflow-hidden" />
}
