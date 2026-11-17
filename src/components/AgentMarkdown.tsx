import { Fragment, useMemo, useState } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icon'

/**
 * Just enough Markdown for agent replies: fenced code, headings, lists, quotes, inline code,
 * bold and italics. No HTML, no images, no link navigation — a click on a link would try to
 * navigate the webview away from the editor.
 */

type Block =
  | { type: 'p'; text: string }
  | { type: 'h'; level: number; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'hr' }

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let paragraph: string[] = []
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ type: 'p', text: paragraph.join('\n') })
      paragraph = []
    }
  }
  const flushList = () => {
    if (list) {
      blocks.push(list)
      list = null
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const fence = /^\s*```(.*)$/.exec(line)
    if (fence) {
      flushParagraph()
      flushList()
      const lang = fence[1].trim()
      const code: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i])
        i += 1
      }
      blocks.push({ type: 'code', lang, code: code.join('\n') })
      continue
    }
    if (/^\s*$/.test(line)) {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] })
      continue
    }
    if (/^\s*([-*_])\s*\1\s*\1\s*$/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'hr' })
      continue
    }
    if (/^\s*>/.test(line)) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'quote', text: line.replace(/^\s*>\s?/, '') })
      continue
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (unordered) {
      flushParagraph()
      let items = list && list.type === 'ul' ? list : null
      if (!items) {
        flushList()
        items = { type: 'ul', items: [] }
        list = items
      }
      items.items.push(unordered[1])
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      let items = list && list.type === 'ol' ? list : null
      if (!items) {
        flushList()
        items = { type: 'ol', items: [] }
        list = items
      }
      items.items.push(ordered[1])
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return blocks
}

function inline(text: string, keyPrefix: string) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g)
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          className="rounded-[3px] bg-panel-alt px-1 py-[1px] font-mono text-[0.92em] text-fg/90"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>
    }
    return <Fragment key={key}>{part}</Fragment>
  })
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div className="group/code overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
      <div className="flex h-7 items-center justify-between gap-2 border-b border-line-soft px-2.5">
        <span className="truncate font-mono text-2xs text-muted">{lang || t('agent.code')}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1200)
              })
              .catch(() => {})
          }}
          className="flex items-center gap-1 text-2xs text-muted transition-colors duration-fast hover:text-fg"
        >
          <Icon name={copied ? 'check' : 'copy'} size={11} />
          {copied ? t('agent.copied') : t('agent.copy')}
        </button>
      </div>
      <pre className="max-h-[420px] overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-fg/90">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function AgentMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parse(text), [text])
  return (
    <div className="flex flex-col gap-2 text-sm leading-[22px] text-fg/90">
      {blocks.map((block, index) => {
        const key = `b-${index}`
        switch (block.type) {
          case 'code':
            return <CodeBlock key={key} lang={block.lang} code={block.code} />
          case 'h': {
            const size =
              block.level <= 2 ? 'text-[15px]' : block.level === 3 ? 'text-sm' : 'text-xs'
            return (
              <div key={key} className={`${size} font-semibold text-fg`}>
                {inline(block.text, key)}
              </div>
            )
          }
          case 'ul':
            return (
              <ul key={key} className="flex list-disc flex-col gap-1 break-words pl-5 marker:text-muted">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={key} className="flex list-decimal flex-col gap-1 break-words pl-5 marker:text-muted">
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{inline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return (
              <div key={key} className="border-l-2 border-line pl-3 text-muted">
                {inline(block.text, key)}
              </div>
            )
          case 'hr':
            return <div key={key} className="h-px bg-line-soft" />
          default:
            return (
              <div key={key} className="whitespace-pre-wrap break-words">
                {inline(block.text, key)}
              </div>
            )
        }
      })}
    </div>
  )
}
