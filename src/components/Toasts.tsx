import { useUi, type ToastKind } from '../store/ui'
import { Icon, type IconName } from './Icon'
import { useT } from '../i18n'

/** Shape + semantic color: success green / error red / info blue. Only the icon is colored; background and border stay neutral so a stack doesn't grab attention. */
const TONES: Record<ToastKind, { icon: IconName; tone: string }> = {
  info: { icon: 'info', tone: 'text-accent' },
  success: { icon: 'check-circle', tone: 'text-success' },
  error: { icon: 'alert-circle', tone: 'text-danger' },
}

/** At most 3 at once so the top stack doesn't cover content */
const MAX_VISIBLE = 3

export function Toasts() {
  const t = useT()
  const toasts = useUi((s) => s.toasts)
  const dismiss = useUi((s) => s.dismissToast)

  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-[38px] z-50 flex flex-col items-center gap-2 px-4">
      {toasts.slice(-MAX_VISIBLE).map((toast) => {
        const { icon, tone } = TONES[toast.kind] ?? TONES.info
        return (
          <div
            key={toast.id}
            role="status"
            onClick={() => dismiss(toast.id)}
            className="pointer-events-auto flex w-[min(380px,100%)] cursor-default items-start gap-2 rounded-popup border border-line-soft bg-panel px-3 py-2 text-sm text-fg shadow-popup"
            data-tip={t('toast.dismissTip')}
          >
            <Icon
              name={icon}
              size={14}
              strokeWidth={1.8}
              className={`mt-[1px] shrink-0 ${tone}`}
            />
            <div className="whitespace-pre-wrap break-words">{toast.text}</div>
          </div>
        )
      })}
    </div>
  )
}