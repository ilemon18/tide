import { useT } from '../i18n'
import { useShortcut } from '../lib/useShortcut'
import type { Tab } from '../store/tabs'
import { ContextMenu } from './ContextMenu'

type Props = {
  x: number
  y: number
  tab: Tab
  formatting: boolean
  onFormat: () => void
  onClose: () => void
}

/** VS Code-style editor menu. Keep this narrow until the rest of the edit actions exist. */
export function EditorContextMenu({ x, y, tab, formatting, onFormat, onClose }: Props) {
  const t = useT()
  const shortcut = useShortcut('editor.format')
  const disabled = formatting || tab.readOnly
  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      items={[
        {
          label: t('commands.editor.format'),
          description: tab.readOnly ? t('editor.formatReadOnly') : undefined,
          shortcut: shortcut || undefined,
          disabled,
          onClick: onFormat,
        },
      ]}
    />
  )
}
