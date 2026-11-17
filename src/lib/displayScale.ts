import { getCurrentWindow } from '@tauri-apps/api/window'

/**
 * Below this factor the window sits on a 1x display (an external 1080p monitor, Windows at 125%).
 * A 12–13px mono glyph then has only 12–13 device pixels: stems collapse to one faint pixel and text
 * looks much thinner than on a Retina screen.
 */
const LOW_DPI = 1.5

let low = typeof window === 'undefined' ? false : (window.devicePixelRatio || 1) < LOW_DPI
let started = false
const listeners = new Set<(low: boolean) => void>()

/** True when the window is on a display whose pixel density needs heavier glyphs */
export function isLowDpi(): boolean {
  return low
}

/** Subscribe to low/high DPI changes (window dragged between a Retina and a 1x screen) */
export function onLowDpiChange(listener: (low: boolean) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function publish(next: boolean) {
  if (next === low) return
  low = next
  for (const listener of listeners) listener(next)
}

/** Track the display the window is currently on; call once at boot */
export function watchDisplayScale(): void {
  if (started) return
  started = true

  // Same breakpoint as the stylesheet; its change event fires when the window crosses displays
  const retina = window.matchMedia(`(min-resolution: ${LOW_DPI}dppx)`)
  retina.addEventListener('change', () => publish(!retina.matches))
  publish(!retina.matches)

  try {
    const win = getCurrentWindow()
    void win
      .scaleFactor()
      .then((factor) => publish(factor < LOW_DPI))
      .catch(() => {})
    void win
      .onScaleChanged(({ payload }) => publish(payload.scaleFactor < LOW_DPI))
      .catch(() => {})
  } catch {
    /* Plain browser dev server: matchMedia already follows the display */
  }
}
