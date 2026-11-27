import { api, type FormatToolInfo } from './ipc'
import {
  FORMAT_TOOLS,
  languageLabel,
  toolById,
  toolVersionLabel,
  type FormatToolId,
} from './formatters'
import { BUNDLED_PRETTIER_VERSION } from './prettier'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { t } from '../i18n'

export type FormatToolIdValue = Exclude<FormatToolId, 'auto'>
export type FormatToolInfos = Partial<Record<FormatToolIdValue, FormatToolInfo>>

/** Load every formatter's state when the Formatting settings section opens. */
export async function loadFormatToolInfos(root: string | null): Promise<FormatToolInfos> {
  const entries = await Promise.all(
    FORMAT_TOOLS.map(async (tool) => {
      const info = await api.formatToolInfo(tool.id, root)
      return [tool.id, info] as const
    }),
  )
  return Object.fromEntries(entries) as FormatToolInfos
}

/** Version label used by settings chips and the status bar. */
export function displayToolVersion(info: FormatToolInfo): string | null {
  if (info.version) return info.version
  if (info.id === 'prettier' && info.source === 'bundled') return BUNDLED_PRETTIER_VERSION
  return null
}

export function displayToolLabel(info: FormatToolInfo): string {
  return toolVersionLabel(info.label, displayToolVersion(info))
}

function installCommand(info: FormatToolInfo): string {
  if (info.installKind === 'rustup') return 'rustup component add rustfmt'
  if (info.installKind === 'pipx') return 'pipx install black'
  if (info.installKind === 'pip') return 'python3 -m pip install --user black'
  return ''
}

function updateCommand(info: FormatToolInfo): string {
  if (info.installKind === 'rustup') return 'rustup update'
  if (info.installKind === 'pipx') return 'pipx upgrade black'
  if (info.installKind === 'pip') return 'python3 -m pip install --user --upgrade black'
  return ''
}

function markSelected(tool: FormatToolIdValue): void {
  const current = useSettings.getState()
  // Picking a formatter is otherwise invisible when formatting is off. Manual formatting keeps
  // the explicit Off choice available, but makes the newly chosen tool usable immediately.
  current.patch({
    formatTool: tool,
    ...(current.formatMode === 'off' ? { formatMode: 'manual' } : {}),
  })
}

function environmentMessage(info: FormatToolInfo): string {
  const language = info.language ? languageLabel(info.language) : info.label
  return t('format.environment.missingMessage', { language })
}

/** Select an installed tool, or offer to install a missing formatter. */
export async function selectFormatTool(
  id: FormatToolIdValue,
  root: string | null,
): Promise<FormatToolInfo> {
  const tool = toolById(id)
  const ui = useUi.getState()
  const info = await api.formatToolInfo(id, root)
  if (info.installed) {
    markSelected(id)
    return info
  }

  if (!info.languageInstalled) {
    await ui.confirm({
      title: t('format.environment.missingTitle', {
        language: info.language ? languageLabel(info.language) : info.label,
      }),
      message: environmentMessage(info),
    })
    return info
  }

  if (!info.canInstall) {
    await ui.confirm({
      title: t('format.install.unsupportedTitle', { tool: tool.label }),
      message:
        info.id === 'gofmt'
          ? t('format.update.gofmt')
          : t('format.install.unsupportedMessage', { tool: tool.label }),
    })
    return info
  }

  const command = installCommand(info)
  const accepted = await ui.confirm({
    title: t('format.install.confirmTitle', { tool: tool.label }),
    message: t('format.install.confirmMessage', { tool: tool.label, command }),
    confirmText: t('format.install.confirmAction'),
  })
  if (!accepted) return info

  const installed = await api.formatToolInstall(id)
  markSelected(id)
  ui.toast(t('format.install.success', { tool: installed.label }), 'success')
  return installed
}

/** Update an already selected tool; tools owned by Go/Tide/the project only show guidance. */
export async function updateFormatTool(
  id: FormatToolIdValue,
  info: FormatToolInfo,
): Promise<FormatToolInfo> {
  const ui = useUi.getState()
  if (info.id === 'gofmt') {
    await ui.confirm({
      title: t('format.update.unsupportedTitle'),
      message: t('format.update.gofmt'),
    })
    return info
  }
  if (info.id === 'prettier') {
    await ui.confirm({
      title: t('format.update.unsupportedTitle'),
      message:
        info.source === 'project'
          ? t('format.update.prettierProject')
          : t('format.update.prettierBundled'),
    })
    return info
  }
  if (!info.canUpdate) {
    await ui.confirm({
      title: t('format.update.unsupportedTitle'),
      message: t('format.update.unsupportedMessage', { tool: info.label }),
    })
    return info
  }

  const command = updateCommand(info)
  const accepted = await ui.confirm({
    title: t('format.update.confirmTitle', { tool: info.label }),
    message: t('format.update.confirmMessage', { tool: info.label, command }),
    confirmText: t('format.update.confirmAction'),
  })
  if (!accepted) return info

  const before = info.version
  const updated = await api.formatToolUpdate(id)
  if (before && updated.version && before === updated.version) {
    ui.toast(t('format.update.upToDate', { tool: updated.label }), 'info')
  } else {
    ui.toast(t('format.update.success', { tool: updated.label }), 'success')
  }
  return updated
}

/** Selecting Auto also turns on manual formatting when the mode is currently Off. */
export function selectAutoFormat(): void {
  const current = useSettings.getState()
  current.patch({
    formatTool: 'auto',
    ...(current.formatMode === 'off' ? { formatMode: 'manual' } : {}),
  })
}
