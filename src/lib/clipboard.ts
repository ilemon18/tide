import { t } from '../i18n'
import { useUi } from '../store/ui'

/** navigator.clipboard is occasionally unavailable in WKWebView; retain an execCommand fallback. */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(area)
  return ok
}

/** Copy text and report the result through the shared toast channel. */
export async function copyText(text: string, label: string): Promise<boolean> {
  if (!text) {
    useUi.getState().toast(t('copy.failed', { label }), 'error')
    return false
  }
  let copied = false
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      copied = true
    } catch {
      copied = legacyCopy(text)
    }
  } else {
    copied = legacyCopy(text)
  }
  if (copied) {
    useUi.getState().toast(t('copy.copied', { label }), 'success')
  } else {
    useUi.getState().toast(t('copy.failed', { label }), 'error')
  }
  return copied
}
