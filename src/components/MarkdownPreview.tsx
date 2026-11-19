import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { Text } from '@codemirror/state'
import { api } from '../lib/ipc'
import { imageMime, isImagePath } from '../lib/media'
import { resolveMarkdownImage } from '../lib/markdown'
import { getEditorState } from '../editor/stateCache'
import { subscribeMarkdownDocs } from '../editor/markdownDocs'
import type { MarkdownImageLoader } from './MarkdownRenderer'

const LazyMarkdownRenderer = lazy(() =>
  import('./MarkdownRenderer').then((module) => ({ default: module.MarkdownRenderer })),
)

const PREVIEW_THROTTLE_MS = 100

type ImageCache = {
  load: MarkdownImageLoader
  dispose: () => void
}

function createImageCache(root: string, docRel: string): ImageCache {
  const pending = new Map<string, Promise<string | null>>()
  const urls = new Set<string>()
  let disposed = false

  const load: MarkdownImageLoader = (src) => {
    const rel = resolveMarkdownImage(docRel, src)
    if (!rel || !isImagePath(rel)) return Promise.resolve(null)
    const cached = pending.get(rel)
    if (cached) return cached

    const request = api
      .readImage(root, rel)
      .then((bytes) => {
        if (disposed) return null
        // Binary IPC normally yields ArrayBuffer; some runtime paths yield Uint8Array, cover both.
        const buffer = bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes as unknown as number[])
        const url = URL.createObjectURL(new Blob([buffer], { type: imageMime(rel) }))
        if (disposed) {
          URL.revokeObjectURL(url)
          return null
        }
        urls.add(url)
        return url
      })
      .catch(() => null)
    pending.set(rel, request)
    return request
  }

  return {
    load,
    dispose: () => {
      disposed = true
      for (const url of urls) URL.revokeObjectURL(url)
      urls.clear()
      pending.clear()
    },
  }
}

type Props = {
  root: string
  rel: string
  tabId: string
  stateKey: string | null
  stateEpoch: number
}

/**
 * The source editor stays mounted beside this pane. Markdown parsing is lazy-loaded, document updates are
 * coalesced to one render per 100ms with a guaranteed trailing render, and preview scrolling is independent.
 */
export function MarkdownPreview({ root, rel, tabId, stateKey, stateEpoch }: Props) {
  const cacheRef = useRef<ImageCache | null>(null)
  if (!cacheRef.current) cacheRef.current = createImageCache(root, rel)

  const initial = stateKey ? (getEditorState(stateKey)?.doc.toString() ?? '') : ''
  const [source, setSource] = useState(initial)
  const sourceRef = useRef(initial)

  useEffect(() => {
    return () => cacheRef.current?.dispose()
  }, [])

  useEffect(() => {
    const next = stateKey ? (getEditorState(stateKey)?.doc.toString() ?? '') : ''
    sourceRef.current = next
    setSource(next)

    let timer: number | null = null
    let pending: Text | null = null
    const flush = () => {
      if (!pending) return
      const text = pending.toString()
      pending = null
      if (text === sourceRef.current) return
      sourceRef.current = text
      setSource(text)
    }
    const schedule = (doc: Text) => {
      pending = doc
      if (timer !== null) return
      timer = window.setTimeout(() => {
        timer = null
        flush()
      }, PREVIEW_THROTTLE_MS)
    }

    const unsubscribe = subscribeMarkdownDocs((id, doc) => {
      if (id === tabId) schedule(doc)
    })
    return () => {
      unsubscribe()
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [tabId, stateKey, stateEpoch])

  return (
    <div className="markdown-preview" onPointerDownCapture={() => undefined}>
      <div className="markdown-preview-inner">
        <Suspense fallback={<div className="markdown-preview-loading" aria-busy="true" />}>
          <LazyMarkdownRenderer source={source} loadImage={cacheRef.current.load} />
        </Suspense>
      </div>
    </div>
  )
}
