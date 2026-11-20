import { useEffect, useRef, useState } from 'react'
import { AgentMarkdown } from './AgentMarkdown'

/** Animate only newly received suffixes. Storage/copy always use the untouched source. */
export function AgentStreamText({ text, live, root }: { text: string; live: boolean; root?: string }) {
  const [display, setDisplay] = useState(text)
  const shown = useRef(text)
  useEffect(() => {
    if (!live || !text.startsWith(shown.current) || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      shown.current = text
      setDisplay(text)
      return
    }
    // Code points keep UTF-16 pairs intact; graphemes also retain combining marks and joined emoji.
    const segments = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.slice(shown.current.length)), part => part.segment)
    if (!segments.length) return
    const timer = setInterval(() => {
      const count = Math.max(1, Math.ceil(segments.length / 3))
      const suffix = segments.splice(0, count).join('')
      shown.current += suffix
      setDisplay(shown.current)
      if (!segments.length) clearInterval(timer)
    }, 24)
    return () => clearInterval(timer)
  }, [text, live])
  return <AgentMarkdown text={display} root={root} />
}
