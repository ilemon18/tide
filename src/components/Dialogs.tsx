import { useEffect, useRef, useState } from 'react'
import { useUi } from '../store/ui'
import { useT } from '../i18n'

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35"
      onMouseDown={onClose}
    >
      <div
        className="w-[380px] overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

export function ConfirmDialog() {
  const t = useT()
  const req = useUi((s) => s.confirmReq)
  const answer = useUi((s) => s.answerConfirm)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (req) confirmRef.current?.focus()
  }, [req])

  useEffect(() => {
    if (!req?.confirmOnEnter) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.repeat || event.isComposing) return
      event.preventDefault()
      answer(event.target !== cancelRef.current)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [req, answer])

  if (!req) return null

  return (
    <Backdrop onClose={() => answer(false)}>
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-md font-semibold text-fg">{req.title}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted">{req.message}</p>
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-3 py-2.5">
        <button
          ref={cancelRef}
          onClick={() => answer(false)}
          className="rounded border border-line px-3 py-1 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          {t('common.cancel')}
        </button>
        <button
          ref={confirmRef}
          onClick={() => answer(true)}
          className={`rounded px-3 py-1 text-sm font-medium text-accent-fg ${
            req.danger ? 'bg-danger' : 'bg-accent'
          }`}
        >
          {req.confirmText ?? t('dialog.confirm')}
        </button>
      </div>
    </Backdrop>
  )
}

export function PromptDialog() {
  const t = useT()
  const req = useUi((s) => s.promptReq)
  const answer = useUi((s) => s.answerPrompt)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!req) return
    setValue(req.value ?? '')
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(id)
  }, [req])

  if (!req) return null

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed) return
    answer(trimmed)
  }

  return (
    <Backdrop onClose={() => answer(null)}>
      <div className="px-4 pb-3 pt-4">
        <h2 className="text-md font-semibold text-fg">{req.title}</h2>
        {req.message ? <p className="mt-1 text-xs text-muted">{req.message}</p> : null}
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={req.placeholder}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') answer(null)
          }}
          spellCheck={false}
          className="mt-3 w-full rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>
      <div className="flex justify-end gap-2 border-t border-line px-3 py-2.5">
        <button
          onClick={() => answer(null)}
          className="rounded border border-line px-3 py-1 text-sm text-muted hover:bg-hover hover:text-fg"
        >
          {t('common.cancel')}
        </button>
        <button
          onClick={submit}
          disabled={!value.trim()}
          className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg disabled:opacity-40"
        >
          {req.confirmText ?? t('dialog.confirm')}
        </button>
      </div>
    </Backdrop>
  )
}