import type { MessageKey } from '../i18n'
import type { Settings } from './ipc'

/** Activity bar entries whose icons can be hidden. Explorer and Search are deliberately absent. */
export type ActivityBarItem = 'welcome' | 'git' | 'structure' | 'tasks'

/** Per-window presentation of the persisted activity bar visibility settings. */
export type ActivityBarVisibility = Record<ActivityBarItem, boolean>

export type ActivityBarVisibilityKey =
  | 'activityBarWelcomeVisible'
  | 'activityBarGitVisible'
  | 'activityBarStructureVisible'
  | 'activityBarTasksVisible'

type ActivityBarItemDefinition = {
  id: ActivityBarItem
  labelKey: MessageKey
  settingKey: ActivityBarVisibilityKey
}

/**
 * One source for the double-click menu and Settings → General. Labels are shared with the icon tooltips so
 * the two visibility surfaces cannot drift apart.
 */
export const ACTIVITY_BAR_ITEMS = [
  { id: 'welcome', labelKey: 'activity.welcomeTip', settingKey: 'activityBarWelcomeVisible' },
  { id: 'git', labelKey: 'activity.gitTip', settingKey: 'activityBarGitVisible' },
  { id: 'structure', labelKey: 'activity.structureTip', settingKey: 'activityBarStructureVisible' },
  { id: 'tasks', labelKey: 'activity.tasksTip', settingKey: 'activityBarTasksVisible' },
] as const satisfies readonly ActivityBarItemDefinition[]

export function activityBarVisibility(
  settings: Pick<Settings, ActivityBarVisibilityKey>,
): ActivityBarVisibility {
  return {
    welcome: settings.activityBarWelcomeVisible,
    git: settings.activityBarGitVisible,
    structure: settings.activityBarStructureVisible,
    tasks: settings.activityBarTasksVisible,
  }
}
