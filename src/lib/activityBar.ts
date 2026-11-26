import type { MessageKey } from '../i18n'
import type { Settings } from './ipc'

/** Activity bar entries with their own switch. Explorer and Search are deliberately absent. */
export type ActivityBarItem = 'welcome' | 'git' | 'structure' | 'tasks'

/** Presentation values for the activity bar; `tasks` follows the shared tasksEnabled switch. */
export type ActivityBarVisibility = Record<ActivityBarItem, boolean>

export type ActivityBarVisibilityKey =
  | 'activityBarWelcomeVisible'
  | 'activityBarGitVisible'
  | 'activityBarStructureVisible'

type ActivityBarSettingKey = ActivityBarVisibilityKey | 'tasksEnabled'

type ActivityBarItemDefinition = {
  id: ActivityBarItem
  labelKey: MessageKey
  settingKey: ActivityBarSettingKey
}

/**
 * One source for the double-click menu and Settings → General. Labels and switch keys are shared so the
 * two surfaces cannot drift apart.
 */
export const ACTIVITY_BAR_ITEMS = [
  { id: 'welcome', labelKey: 'activity.welcomeTip', settingKey: 'activityBarWelcomeVisible' },
  { id: 'git', labelKey: 'activity.gitTip', settingKey: 'activityBarGitVisible' },
  { id: 'structure', labelKey: 'activity.structureTip', settingKey: 'activityBarStructureVisible' },
  { id: 'tasks', labelKey: 'activity.tasksTip', settingKey: 'tasksEnabled' },
] as const satisfies readonly ActivityBarItemDefinition[]

export function activityBarVisibility(
  settings: Pick<Settings, ActivityBarVisibilityKey | 'tasksEnabled'>,
): ActivityBarVisibility {
  return {
    welcome: settings.activityBarWelcomeVisible,
    git: settings.activityBarGitVisible,
    structure: settings.activityBarStructureVisible,
    tasks: settings.tasksEnabled,
  }
}
