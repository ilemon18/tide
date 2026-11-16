export type DocTier = 'full' | 'large' | 'preview'

import { t } from '../i18n'
import { budget } from '../lib/memoryBudget'

/** Size thresholds are in lib/memoryBudget: lightweight mode lowers them so big files stay cheap */
export const HARD_LIMIT = 20 * 1024 * 1024 // 20MB, matches the backend

/** Pick the editor strategy by file size so big files cannot freeze the UI */
export function tierFor(size: number): DocTier {
  if (size > budget.previewFileBytes()) return 'preview'
  if (size > budget.largeFileBytes()) return 'large'
  return 'full'
}

export function tierLabel(tier: DocTier): string {
  if (tier === 'preview') return t('editor.largeFilePreview')
  if (tier === 'large') return t('editor.largeFileMode')
  return ''
}
