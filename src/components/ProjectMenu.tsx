import { ContextMenu } from './ContextMenu'
import { useT } from '../i18n'
import { openProjectDirectory, openProjectTerminal, newEntry } from '../lib/actions'
import { copyText } from '../lib/clipboard'
import { basename } from '../lib/paths'

export function ProjectMenu({
  root,
  x,
  y,
  onClose,
}: {
  root: string
  x: number
  y: number
  onClose: () => void
}) {
  const t = useT()
  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        { label: t('project.openDirectory'), onClick: () => void openProjectDirectory(root) },
        { label: t('project.openNativeTerminal'), onClick: () => void openProjectTerminal(root) },
        { type: 'separator' },
        { label: t('explorer.newFile'), onClick: () => void newEntry(root, '', 'file') },
        { label: t('explorer.newFolder'), onClick: () => void newEntry(root, '', 'dir') },
        { type: 'separator' },
        {
          label: t('explorer.copyRelativePath'),
          onClick: () => void copyText('.', t('explorer.copyRelativePath')),
        },
        {
          label: t('explorer.copyAbsolutePath'),
          onClick: () => void copyText(root, t('explorer.copyAbsolutePath')),
        },
        {
          label: t('explorer.copyName'),
          onClick: () => void copyText(basename(root), t('explorer.copyName')),
        },
      ]}
    />
  )
}
