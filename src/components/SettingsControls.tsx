import type { ReactNode } from 'react'
export function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-line/60 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

/** A settings group: title + an outlined card (cards keep a page from stretching into one long row) */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      {title ? (
        <div className="mb-1.5 px-1">
          <h3 className="text-xs font-medium text-fg/80">{title}</h3>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
        {children}
      </div>
    </section>
  )
}

export function Toggle({
  value,
  onChange,
  disabled,
  ariaLabel,
  role,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  ariaLabel?: string
  role?: 'switch'
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      type="button"
      role={role}
      aria-label={ariaLabel}
      className={`cursor-pointer relative h-[18px] w-[32px] rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        value ? 'bg-accent' : 'bg-active'
      }`}
      aria-pressed={role ? undefined : value}
      aria-checked={role ? value : undefined}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
          value ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}


export const settingsButton = 'flex h-7 items-center justify-center rounded-[var(--r-control)] border border-line px-3 text-sm leading-none hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40'

export function SettingsChoices<T extends string>({ value, options, onChange, disabled, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean; label: string
}) {
  return <div role="group" aria-label={label} className="flex max-w-[300px] flex-wrap justify-end gap-1">
    {options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} disabled={disabled}
      className={`cursor-pointer rounded-[var(--r-control)] px-2 py-[3px] text-xs disabled:cursor-not-allowed disabled:opacity-40 ${value === option.value ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-hover hover:text-fg'}`}
      onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>
}
