import { useState } from 'react'
import { copyText } from '../lib/clipboard'
import { useT } from '../i18n'
import { Icon } from './Icon'

type Props = {
  text: string
  label: string
  tip: string
  className?: string
  iconOnly?: boolean
}

/** Compact copy control shared by transcript cards, code fences and Git hover cards. */
export function CopyButton({ text, label, tip, className = '', iconOnly = false }: Props) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={tip}
      data-tip={tip}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
        void copyText(text, label).then((ok) => {
          if (!ok) return
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
      className={`flex shrink-0 items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent ${className}`}
    >
      <Icon name={copied ? 'check' : 'copy'} size={11} />
      {iconOnly ? null : <span>{copied ? t('agent.copied') : t('agent.copy')}</span>}
    </button>
  )
}
