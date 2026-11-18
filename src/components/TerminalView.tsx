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


type Props = {
  tab: TerminalTab
  active: boolean
}

export function TerminalView({ tab, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const ptyRef = useRef<string | null>(null)

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

    // Hand data straight to xterm (it batches per frame). Do not wrap in requestAnimationFrame:
    // rAF is throttled while the window is occluded, so output looks stuck until the user clicks.
    const enqueue = (data: string) => {
      if (disposed) return
      try {
        term.write(data)
      } catch {
        /* already disposed */
      }
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

    const dataSub = term.onData((data) => {
      if (disposed) return
      if (ptyRef.current) void api.ptyWrite(ptyRef.current, data)
    })

    // Intercept a few VSCode-style combos; everything else goes to the shell unchanged.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const primary = mac ? event.metaKey : event.ctrlKey
      const key = shortcutKey(event)

      // Command/Ctrl + = or Command/Ctrl + - (with or without Shift): send the visible character
      // instead of letting xterm intercept for zoom. This allows typing + and - with Command held.
      if (primary && !event.altKey && (key === '=' || key === '-')) {
        event.preventDefault()
        event.stopPropagation()
        if (event.isComposing || event.keyCode === 229) return false
        if (!ptyRef.current) return false
        // Send the actual character the user sees (= or + for equals key, - or _ for minus key)
        const char = event.key.length === 1 ? event.key : key
        void api.ptyWrite(ptyRef.current, char)
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
      ro.disconnect()
      offDrag()
      if (fitRaf) cancelAnimationFrame(fitRaf)
      fitRaf = 0
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
