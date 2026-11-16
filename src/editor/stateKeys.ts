/**
 * Cache keys for EditorState. The main state uses tab.id; after a split the secondary pane holds a mirror
 * state with a suffix (same content, independent history).
 */
const MIRROR_SUFFIX = '@secondary'

export function mirrorKey(tabId: string): string {
  return tabId + MIRROR_SUFFIX
}

export function isMirrorKey(key: string): boolean {
  return key.endsWith(MIRROR_SUFFIX)
}

/** Recover the tab a state key stands for (main keys come back unchanged) */
export function tabIdOfStateKey(key: string): string {
  return isMirrorKey(key) ? key.slice(0, -MIRROR_SUFFIX.length) : key
}