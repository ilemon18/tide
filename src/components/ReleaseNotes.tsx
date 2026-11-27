import ReactMarkdown from 'react-markdown'
import { useUpdate } from '../store/update'
import { useT } from '../i18n'
import { compareAppVersions, formatVersion } from '../lib/version'
import { updateApi } from '../lib/update'
import { useUi } from '../store/ui'
import { errorText } from '../lib/ipc'

/** Only the newer release belongs in the update decision UI; the repository owns history. */
export function ReleaseNotes() {
  const t = useT()
  const info = useUpdate((s) => s.info)
  if (
    !info ||
    (!info.available && !(info.hasRelease && compareAppVersions(info.latest, info.current) > 0))
  )
    return null
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 px-1 text-xs font-medium text-fg/80">
        {t('settings.about.changelog')}
      </h3>
      <div className="overflow-hidden rounded-popup border border-line-soft bg-panel">
        <div className="border-b border-line/60 px-4 py-3 text-sm text-fg">
          <span className="font-mono">{formatVersion(info.latest)}</span>
          <span className="ml-3 text-xs text-muted">{info.publishedAt.slice(0, 10)}</span>
        </div>
        <div className="release-notes select-text px-5 py-4 text-xs leading-relaxed text-fg/85">
          <ReactMarkdown
            skipHtml
            components={{
              a: ({ href, children }) => (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => {
                    if (href)
                      void updateApi
                        .openPage(href)
                        .catch((error) => useUi.getState().toast(errorText(error), 'error'))
                  }}
                >
                  {children}
                </button>
              ),
              img: () => null,
            }}
          >
            {info.notes || t('settings.about.noNotes')}
          </ReactMarkdown>
        </div>
      </div>
    </section>
  )
}
