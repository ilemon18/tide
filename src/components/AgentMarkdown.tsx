import { useMemo } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useT } from '../i18n'
import { useTabs } from '../store/tabs'
import { resolveAgentFileLink } from '../lib/agentLinks'
import { CopyButton } from './CopyButton'

const plugins = [remarkGfm]

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const t = useT()
  return (
    <div className="group/code overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
      <div className="flex h-7 items-center justify-between gap-2 border-b border-line-soft px-2.5">
        <span className="truncate font-mono text-2xs text-muted">{lang || t('agent.code')}</span>
        <CopyButton
          text={code}
          label={t('agent.code')}
          tip={t('agent.copy')}
          className="gap-1 text-2xs transition-colors duration-fast hover:text-fg"
        />
      </div>
      <pre className="max-h-[420px] overflow-auto px-3 py-2 font-mono text-xs leading-relaxed text-fg/90">
        <code>{code}</code>
      </pre>
    </div>
  )
}

/** GFM replies keep their original source for streaming, persistence and copying. */
export function AgentMarkdown({ text, root = '' }: { text: string; root?: string }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children, title }) => {
      const file = resolveAgentFileLink(root, href ?? '')
      return <a
        href={href}
        title={title ?? (file ? file.rel : undefined)}
        draggable={false}
        className="cursor-pointer text-blue-500 underline decoration-1 underline-offset-2 hover:text-blue-400 focus-visible:outline focus-visible:outline-1"
        onClick={event => {
          event.preventDefault()
          if (!file) return
          const tabs = useTabs.getState()
          if (file.line) void tabs.openAt(root, file.rel, file.line, file.col ?? 1)
          else void tabs.openFile(root, file.rel)
        }}
        onAuxClick={event => event.preventDefault()}
        onContextMenu={event => event.preventDefault()}
      >{children}</a>
    },
    // Never fetch model-supplied remote images. Preserve their readable alt text.
    img: ({ alt }) => <span>{alt}</span>,
    pre: ({ node, children }) => {
      const code = node?.children.find(child => child.type === 'element' && child.tagName === 'code')
      if (!code || code.type !== 'element') return <pre>{children}</pre>
      const classes = code.properties.className
      const language = Array.isArray(classes) ? classes.find(value => String(value).startsWith('language-')) : undefined
      const value = code.children.map(child => child.type === 'text' ? child.value : '').join('')
      return <CodeBlock lang={String(language ?? '').replace(/^language-/, '')} code={value.replace(/\n$/, '')} />
    },
    code: ({ children }) => <code className="rounded-[3px] bg-panel-alt px-1 py-[1px] font-mono text-[0.92em] text-fg/90">{children}</code>,
    table: ({ children }) => <div className="max-w-full overflow-x-auto rounded-[var(--r-row)] border border-line-soft"><table className="w-full border-collapse text-left text-xs">{children}</table></div>,
    th: ({ children, style }) => <th style={style} className="border-b border-line bg-panel-alt px-3 py-2 font-semibold text-fg">{children}</th>,
    td: ({ children, style }) => <td style={style} className="border-b border-line-soft px-3 py-2 align-top">{children}</td>,
    tr: ({ children }) => <tr className="even:bg-panel/50 last:[&>td]:border-b-0">{children}</tr>,
  }), [root])
  return (
    <div className="min-w-0 space-y-2 whitespace-normal break-words text-sm leading-[22px] text-fg/90 [&_p]:my-2 [&_p]:whitespace-pre-wrap [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-[15px] [&_h4]:text-sm [&_h5]:text-sm [&_h6]:text-xs [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5 [&_li]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-3 [&_blockquote]:text-muted [&_hr]:border-line-soft [&_input]:mr-1.5">
      <ReactMarkdown remarkPlugins={plugins} skipHtml components={components}
        urlTransform={url => resolveAgentFileLink(root, url) ? url : defaultUrlTransform(url)}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
