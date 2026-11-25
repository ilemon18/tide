import { useEffect, useState } from 'react'
import { api, errorText } from '../lib/ipc'
import { imageMime } from '../lib/media'
import { humanSize } from '../lib/paths'
import type { Tab } from '../store/tabs'
import { Icon } from './Icon'
import { t } from '../i18n'

/** Checkerboard behind transparent images: translucent gray works in light and dark themes */
const CHECKER: React.CSSProperties = {
  backgroundColor: 'var(--c-bg)',
  backgroundImage:
    'linear-gradient(45deg, color-mix(in srgb, var(--c-fg) 7%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--c-fg) 7%, transparent) 75%),' +
    'linear-gradient(45deg, color-mix(in srgb, var(--c-fg) 7%, transparent) 25%, transparent 25%, transparent 75%, color-mix(in srgb, var(--c-fg) 7%, transparent) 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 8px 8px',
}

type Props = {
  tab: Tab
  /** SVG only: render the editor's current text (incl. unsaved edits). undefined = normal image, null = unavailable. */
  svgText?: string | null
}

/**
 * Image preview: read raw bytes into a blob URL; never enters CodeMirror, no save / blame / scroll memory.
 * SVG is the exception -- it is a text tab by default, so render the editor's current content instead of
 * reading disk (otherwise unsaved edits are silently ignored). Note that SVG in <img> runs no scripts,
 * loads no external href / fonts, and inherits neither currentColor nor CSS variables.
 */
export function ImageView({ tab, svgText }: Props) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    let alive = true
    let objectUrl: string | null = null
    setLoading(true)
    setError(null)
    setUrl(null)
    setNatural(null)

    // SVG preview without an editor document: report an error instead of reading disk,
    // which would show stale content while looking up to date.
    if (svgText === null) {
      setError(t('image.readFailed'))
      setLoading(false)
      return () => {
        alive = false
      }
    }

    if (svgText !== undefined) {
      objectUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
      setUrl(objectUrl)
      setLoading(false)
      return () => {
        alive = false
        URL.revokeObjectURL(objectUrl!)
      }
    }

    void api
      .readImage(tab.root, tab.rel)
      .then((bytes) => {
        if (!alive) return
        // Binary IPC normally yields ArrayBuffer; some runtime paths yield Uint8Array, cover both
        const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes as unknown as number[])
        objectUrl = URL.createObjectURL(new Blob([buffer], { type: imageMime(tab.external ? tab.name : tab.rel) }))
        setUrl(objectUrl)
        setLoading(false)
      })
      .catch((e) => {
        if (!alive) return
        setError(errorText(e))
        setLoading(false)
      })

    return () => {
      alive = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [tab.root, tab.rel, tab.mtime, svgText])

  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line/60 px-3 text-2xs text-muted">
        <span className="min-w-0 truncate text-fg/80">{tab.name}</span>
        {natural ? (
          <span className="shrink-0">
            {natural.w} × {natural.h}
          </span>
        ) : null}
        {tab.size ? <span className="shrink-0">{humanSize(tab.size)}</span> : null}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-4" style={CHECKER}>
        {loading ? (
          <div className="flex h-full items-center justify-center gap-1.5 text-xs text-muted">
            <Icon name="refresh" size={12} className="animate-spin" />
            正在读取图片
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-xs text-danger">
            {error}
          </div>
        ) : url ? (
          <div className="flex min-h-full items-center justify-center">
            <img
              src={url}
              alt={tab.name}
              className="max-h-full max-w-full object-contain"
              style={{ boxShadow: 'var(--elev-popup)' }}
              onLoad={(e) => {
                // Must read synchronously inside the event: React may run the updater during render,
                // when e.currentTarget is already null (the earlier n.naturalWidth crash)
                const { naturalWidth: w, naturalHeight: h } = e.currentTarget
                if (!w || !h) return
                setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }))
              }}
              onError={() => setError(t('image.previewFailed'))}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}