import { extname } from '../lib/paths'
import { ICON_SETS, type IconSetId } from '../assets/fileIcons.generated'
import { isIconThemeId } from '../lib/iconTheme'
import { useSettings } from '../store/settings'

/** Resolve which icon to use (key names come from the generation script) */
export function resolveIconName(
  name: string,
  isDir: boolean,
  isOpen: boolean,
  set: IconSetId = 'material',
): string {
  const icons = ICON_SETS[set]
  const lower = name.toLowerCase()
  if (isDir) {
    return (
      (isOpen ? icons.folderOpen[lower] : icons.folder[lower]) ??
      icons.folder[lower] ??
      (isOpen ? icons.defaultFolderOpen : icons.defaultFolder)
    )
  }
  return icons.names[lower] ?? icons.ext[extname(lower)] ?? icons.defaultFile
}

type Props = {
  name: string
  isDir?: boolean
  isOpen?: boolean
  size?: number
  className?: string
}

export function FileIcon({ name, isDir = false, isOpen = false, size = 16, className }: Props) {
  const stored = useSettings((s) => s.iconTheme)
  const iconTheme = isIconThemeId(stored) ? stored : 'material'

  // Plain text mode: no slot. A blank block shifts the whole name right and looks like extra indent;
  // return null so the name left-aligns into the icon's place (and the row's gap adds nothing).
  if (iconTheme === 'none') return null

  const icon = resolveIconName(name, isDir, isOpen, iconTheme)
  // Monochrome icons color via currentColor: accent for folders, secondary foreground for files
  const color =
    iconTheme === 'minimal' ? (isDir ? 'var(--c-accent)' : 'var(--c-muted)') : undefined

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      aria-hidden="true"
      style={{ flex: '0 0 auto', color }}
    >
      <use href={`#fis-${iconTheme}-${icon}`} />
    </svg>
  )
}