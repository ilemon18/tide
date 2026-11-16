import { StateEffect } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { onLocaleChange, t } from '../i18n'

/**
 * The "locale switched" signal. Conflict buttons, inline blame and fold arrows are DOM built by the editor
 * extensions, which do not re-render with React; a locale change dispatches this effect into the view so
 * plugins recompute decorations. Fold arrow titles carry no state and are fixed by the DOM scan below.
 */
export const localeEffect = StateEffect.define<null>()

/** Refresh locale-dependent decorations when the locale changes. The returned function must go into the plugin's `destroy()`, otherwise the view is still notified after destruction. */
export function watchLocale(view: EditorView): () => void {
  return onLocaleChange(() => {
    try {
      view.dispatch({ effects: localeEffect.of(null) })
    } catch {
      /* The view may have been destroyed in this very frame */
    }
  })
}

/** Whether the transaction carries the "locale changed" signal */
export function hasLocaleEffect(update: ViewUpdate): boolean {
  return update.transactions.some((tr) => tr.effects.some((effect) => effect.is(localeEffect)))
}

/** Fold arrow titles live directly in the DOM (not in state), so rescan them after a locale change. Only titles, negligible cost. */
export function refreshEditorDomLabels(): void {
  const foldTitle = t('editor.foldTip')
  const unfoldTitle = t('editor.unfoldTip')
  for (const marker of document.querySelectorAll<HTMLElement>('.cm-fold-marker')) {
    marker.title = marker.classList.contains('cm-fold-marker-open') ? foldTitle : unfoldTitle
  }
}