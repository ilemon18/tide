// First-paint theme fallback: paint with the last-used colors before the app bundle loads.
//
// Why a separate file instead of an inline script: Tauri's CSP is script-src 'self', so an inline
// <script> is blocked; putting it in public/ gets it copied verbatim into dist as one same-origin request.
// All windows of the app share localStorage, so a new window's first frame already has the right color
// and doesn't flash the default dark.
;(function () {
  try {
    var raw = window.localStorage.getItem('tide:appearance')
    if (!raw) return
    var appearance = JSON.parse(raw)
    var root = document.documentElement
    if (appearance.theme) root.setAttribute('data-theme', appearance.theme)
    if (appearance.bg) {
      root.style.background = appearance.bg
      root.style.setProperty('--c-bg', appearance.bg)
    }
    if (appearance.fg) root.style.setProperty('--c-fg', appearance.fg)
    root.style.colorScheme = appearance.dark ? 'dark' : 'light'
  } catch (e) {
    /* Fall back to the stylesheet's default palette if the cache is corrupt */
  }
})()