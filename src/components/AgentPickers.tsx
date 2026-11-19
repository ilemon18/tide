import { useRef, useState } from 'react'
import { useAgent } from '../store/agent'
import { useUi } from '../store/ui'
import { t, useT } from '../i18n'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'

export type PickerOption = { id: string; label: string }

/** Reasoning-level ids are the CLIs' own vocabulary; translate the levels we know. */
const EFFORT_KEYS = {
  minimal: 'agent.effort.minimal',
  low: 'agent.effort.low',
  medium: 'agent.effort.medium',
  high: 'agent.effort.high',
  xhigh: 'agent.effort.xhigh',
  max: 'agent.effort.max',
  ultra: 'agent.effort.ultra',
} as const

export function effortLabel(id: string, fallback: string): string {
  if (!id) return fallback
  const key = EFFORT_KEYS[id as keyof typeof EFFORT_KEYS]
  return key ? t(key) : id
}

type PickerProps = {
  label: string
  value: string
  options: PickerOption[]
  onPick: (id: string) => void
  disabled?: boolean
  hideLabel?: boolean
  tip?: string
}

/** One compact footer chip; the agent, model and complexity menus share it. */
export function Picker({
  label,
  value,
  options,
  onPick,
  disabled,
  hideLabel,
  tip,
}: PickerProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const current = options.find((option) => option.id === value)
  const items: MenuItem[] = options.map((option) => ({
    label: option.label,
    disabled: option.id === value,
    onClick: () => onPick(option.id),
  }))

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        disabled={disabled}
        data-tip={tip}
        aria-label={label || current?.label || value}
        onClick={() => {
          const rect = buttonRef.current?.getBoundingClientRect()
          if (rect) setMenu({ x: rect.left, y: rect.bottom + 4 })
        }}
        className="flex h-6 min-w-0 max-w-[190px] items-center gap-1 rounded-[var(--r-control)] px-1.5 text-xs text-muted transition-colors duration-fast hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
      >
        {label && !hideLabel ? <span className="shrink-0 text-muted/70">{label}</span> : null}
        <span className="min-w-0 truncate text-fg/80">{current?.label ?? value}</span>
        <Icon name="chevron-down" size={10} className="shrink-0 text-muted/70" />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          maxHeight={300}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  )
}

export function AgentPicker({
  value,
  onPick,
  disabled,
}: {
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const providers = useAgent((s) => s.providers)
  const usable = (providers ?? []).filter(
    (provider) => provider.installed && provider.supported,
  )
  return (
    <Picker
      label={t('agent.picker.agent')}
      hideLabel
      tip={t('agent.picker.agentTip')}
      value={value}
      options={usable.map((provider) => ({ id: provider.id, label: provider.name }))}
      onPick={onPick}
      disabled={disabled || usable.length === 0}
    />
  )
}

export function ModelPicker({
  provider,
  value,
  onPick,
  disabled,
}: {
  provider: string
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const catalog = useAgent((s) => s.catalogs[provider])
  const options: PickerOption[] = [
    { id: '', label: t('agent.picker.defaultModel') },
    ...(catalog?.models ?? []).map((model) => ({ id: model.id, label: model.label })),
    { id: '__custom', label: t('agent.picker.customModel') },
  ]
  return (
    <Picker
      label={t('agent.picker.model')}
      tip={t('agent.picker.modelTip')}
      value={value}
      options={options}
      onPick={(id) => {
        if (id !== '__custom') {
          onPick(id)
          return
        }
        void useUi
          .getState()
          .askText({
            title: t('agent.picker.customModel'),
            message: t('agent.picker.customModelHint'),
            value,
            confirmText: t('common.continue'),
          })
          .then((next) => {
            if (next && next.trim()) onPick(next.trim())
          })
      }}
      disabled={disabled}
    />
  )
}

export function EffortPicker({
  provider,
  model,
  value,
  onPick,
  disabled,
}: {
  provider: string
  model: string
  value: string
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const t = useT()
  const catalog = useAgent((s) => s.catalogs[provider])
  const modelInfo = catalog?.models.find((item) => item.id === model)
  const levels =
    modelInfo && modelInfo.efforts.length > 0
      ? modelInfo.efforts
      : (catalog?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'])
  const options: PickerOption[] = [
    { id: '', label: t('agent.picker.defaultEffort') },
    ...levels.map((level) => ({ id: level, label: effortLabel(level, level) })),
  ]
  return (
    <Picker
      label={t('agent.picker.complexity')}
      tip={t('agent.picker.complexityTip')}
      value={value}
      options={options}
      onPick={onPick}
      disabled={disabled}
    />
  )
}
