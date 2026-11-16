import { useMemo } from 'react'
import { ICON_SETS, type IconSetId } from '../assets/fileIcons.generated'
import { isIconThemeId } from '../lib/iconTheme'
import { useSettings } from '../store/settings'

/**
 * An SVG sprite carries every symbol of the current icon set: defined once per page, icons use <use>,
 * saving both DOM and strings. Switching sets swaps the whole block (symbol ids include the set name so
 * nothing collides with leftovers), and the markup is built once.
 */
export function FileIconSprite() {
  const stored = useSettings((s) => s.iconTheme)
  const iconTheme = isIconThemeId(stored) ? stored : 'material'

  const markup = useMemo(() => {
    if (iconTheme === 'none') return ''
    const set = ICON_SETS[iconTheme as IconSetId]
    if (!set) return ''
    return Object.entries(set.sprite)
      // Each icon keeps its own canvas size so 24/32/512-canvas icons aren't cropped
      .map(
        ([name, inner]) =>
          `<symbol id="fis-${iconTheme}-${name}" viewBox="${set.viewBoxes[name] ?? '0 0 16 16'}">${inner}</symbol>`,
      )
      .join('')
  }, [iconTheme])

  return (
    <svg
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  )
}