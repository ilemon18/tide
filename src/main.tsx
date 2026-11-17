import { createRoot } from 'react-dom/client'
import './styles/index.css'
import { App } from './App'
import { useSettings } from './store/settings'
import { monoFontOption } from './lib/fonts'
import { awaitCatalog } from './i18n'
import { setupPtyEvents } from './store/terminal'
import { setupFsEvents } from './store/watcher'
import { watchDisplayScale } from './lib/displayScale'

// Before the first paint: the editor and terminal pick their glyph weight from the display
watchDisplayScale()

async function boot() {
  // Read the theme before rendering so the first paint does not flash the default palette
  await useSettings.getState().load()
  // Locale catalogs are fetched on demand: wait for this window's language, otherwise it paints in English first
  await awaitCatalog(useSettings.getState().locale)
  // Render only once the code font is ready: otherwise the editor/terminal lay out with the fallback font width first
  const { fontFamily, fontSize } = useSettings.getState()
  const family = monoFontOption(fontFamily).family
  if (family) {
    await document.fonts?.load(`13px "${family}"`).catch(() => {})
    // Bold is used by syntax highlighting for keywords, so wait for it too
    await document.fonts?.load(`${fontSize}px "${family}"`).catch(() => {})
  }
  void setupPtyEvents()
  void setupFsEvents()

  const container = document.getElementById('root')
  if (!container) throw new Error('#root element is missing')
  createRoot(container).render(<App />)
}

void boot()