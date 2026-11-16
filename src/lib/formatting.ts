import { api, errorText } from './ipc'
import { resolveTool } from './formatters'
import { formatWithBundledPrettier } from './prettier'
import { useSettings } from '../store/settings'

/**
 * Result of one format run. `source` says which implementation was used: none (disabled) /
 * unsupported (tool does not handle this file) / project (the project's own Prettier) / bundled
 * (bundled Prettier) / system (system rustfmt etc.).
 */
export type FormatOutcome = {
  text: string | null
  changed: boolean
  error: string | null
  source: 'none' | 'unsupported' | 'project' | 'bundled' | 'system'
}

/** Format with the tool chosen in settings: prefer the project's copy, fall back to the bundled one */
export async function formatWithSelectedTool(
  root: string,
  rel: string,
  text: string,
): Promise<FormatOutcome> {
  const settings = useSettings.getState()
  if (settings.formatMode === 'off') {
    return { text: null, changed: false, error: null, source: 'none' }
  }

  const tool = resolveTool(rel, settings.formatTool)
  if (!tool) {
    return { text: null, changed: false, error: null, source: 'unsupported' }
  }
  const toolId = tool.id

  if (toolId === 'prettier') {
    // Ask the backend first: if the project has prettier, use it (version / config follow the project)
    let result
    try {
      result = await api.formatText(root, rel, toolId, text)
    } catch (e) {
      return { text: null, changed: false, error: errorText(e), source: 'project' }
    }
    if (result.error) {
      return { text: null, changed: false, error: result.error, source: 'project' }
    }
    if (!result.fallback) {
      return { text: result.text, changed: result.changed, error: null, source: 'project' }
    }

    // Not in the project: fall back to bundled Prettier, still using the project's config
    try {
      const config = await api.prettierConfig(root, rel).catch(() => null)
      const formatted = await formatWithBundledPrettier(rel, text, config)
      return { text: formatted, changed: formatted !== text, error: null, source: 'bundled' }
    } catch (e) {
      return { text: null, changed: false, error: errorText(e), source: 'bundled' }
    }
  }

  try {
    const result = await api.formatText(root, rel, toolId, text)
    return { text: result.text, changed: result.changed, error: result.error, source: 'system' }
  } catch (e) {
    return { text: null, changed: false, error: errorText(e), source: 'system' }
  }
}