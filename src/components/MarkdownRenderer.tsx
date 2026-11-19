import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
} from 'react'
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export type MarkdownImageLoader = (src: string) => Promise<string | null>

type Props = {
  source: string
  loadImage: MarkdownImageLoader
}

const noImage: MarkdownImageLoader = async () => null
const ImageLoaderContext = createContext<MarkdownImageLoader>(noImage)

/** Links keep their Markdown styling, but must never replace the editor WebView with a remote page. */
function MarkdownLink({
  href,
  children,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  return (
    <a
      {...props}
      href={href}
      draggable={false}
      onClick={(event) => event.preventDefault()}
      onAuxClick={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </a>
  )
}

/** Relative workspace raster images are read through api.readImage; everything else falls back to alt text. */
function MarkdownImage({
  src,
  alt,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const loadImage = useContext(ImageLoaderContext)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setUrl(null)
    setFailed(false)
    void loadImage(src ?? '').then((next) => {
      if (alive) setUrl(next)
    })
    return () => {
      alive = false
    }
  }, [loadImage, src])

  if (!url || failed) {
    const fallback = alt || src || ''
    return (
      <span className="markdown-image-fallback" role="img" aria-label={alt || undefined}>
        {fallback}
      </span>
    )
  }

  return (
    <img
      {...props}
      src={url}
      alt={alt ?? ''}
      className="markdown-image"
      onError={() => setFailed(true)}
    />
  )
}

const components: Components = {
  a: MarkdownLink,
  img: MarkdownImage,
}

const plugins = [remarkGfm]

/** Statically imports the Markdown renderer and GFM plugin; MarkdownPreview loads this module on first use. */
export function MarkdownRenderer({ source, loadImage }: Props) {
  return (
    <ImageLoaderContext.Provider value={loadImage}>
      <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}>
        {source}
      </ReactMarkdown>
    </ImageLoaderContext.Provider>
  )
}
