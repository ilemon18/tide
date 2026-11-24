/** Suppress the webview menu while allowing component contextmenu handlers to run. */
export function suppressDefaultContextMenu(target: Document) {
  const preventDefault = (event: MouseEvent) => event.preventDefault()
  target.addEventListener('contextmenu', preventDefault, true)
  return () => target.removeEventListener('contextmenu', preventDefault, true)
}
