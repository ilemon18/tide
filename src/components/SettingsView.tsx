import { useEffect, useRef, useState } from 'react'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { useUpdate } from '../store/update'
import { updateAction, updateDetail, runUpdateAction, type UpdateView } from '../lib/updateView'
import { updateApi } from '../lib/update'
import { errorText, type Settings } from '../lib/ipc'
import { THEME_GROUPS, palettes, themeLabel } from '../theme/palettes'
import { FORMAT_MODES, FORMAT_TOOLS } from '../lib/formatters'
import { ICON_THEME_OPTIONS } from '../lib/iconTheme'
import { useAgent } from '../store/agent'
import { Picker, effortLabel } from './AgentPickers'
import { MONO_FONT_OPTIONS, monoStack } from '../lib/fonts'
import { SETTINGS_SECTIONS, type SettingsSectionId } from '../lib/settingsSections'
import { Icon } from './Icon'
import {
  LOCALES,
  LOCALE_LABELS,
  useT,
  type MessageKey,
} from '../i18n'

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-8 border-b border-line/60 px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="text-sm text-fg">{label}</div>
        {hint ? <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** A settings group: title + an outlined card (cards keep a page from stretching into one long row) */
function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      {title ? (
        <div className="mb-1.5 px-1">
          <h3 className="text-xs font-medium text-fg/80">{title}</h3>
        </div>
      ) : null}
      <div className="overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
        {children}
      </div>
    </section>
  )
}

function Toggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      onClick={() => onChange(!value)}
      disabled={disabled}
      className={`relative h-[18px] w-[32px] rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        value ? 'bg-accent' : 'bg-active'
      }`}
      aria-pressed={value}
    >
      <span
        className={`absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all ${
          value ? 'left-[16px]' : 'left-[2px]'
        }`}
      />
    </button>
  )
}

function Stepper({
  value,
  min,
  max,
  onChange,
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="flex h-6 w-6 items-center justify-center rounded border border-line text-muted hover:bg-hover hover:text-fg"
      >
        −
      </button>
      <span className="w-8 text-center text-sm">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + 1))}
        className="flex h-6 w-6 items-center justify-center rounded border border-line text-muted hover:bg-hover hover:text-fg"
      >
        +
      </button>
    </div>
  )
}

function pill(active: boolean) {
  return `rounded-[var(--r-control)] px-2 py-[3px] text-xs ${
    active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-hover hover:text-fg'
  }`
}

/** Project home; opened through the update module's allowlisted opener (https + github.com only) */
const REPOSITORY_URL = 'https://github.com/ilemon18/tide'

const SHORTCUTS: [MessageKey, string][] = [
  ['settings.keys.openFolder', '⌘O'],
  ['settings.keys.quickOpen', '⌘P'],
  ['settings.keys.commandPalette', '⌘⇧P'],
  ['settings.keys.searchInFiles', '⌘⇧F'],
  ['settings.keys.findInEditor', '⌘F'],
  ['settings.keys.save', '⌘S / ⌘⇧S'],
  ['settings.keys.closeTab', '⌘W'],
  ['settings.keys.newFile', '⌘N'],
  ['settings.keys.rename', '⌘R / F2'],
  ['settings.keys.delete', '⌘⌫'],
  ['settings.keys.toggleSidebar', '⌘B'],
  ['settings.keys.toggleTerminal', '⌘J'],
  ['settings.keys.toggleProject', '⌘⇧O'],
  ['settings.keys.toggleTheme', '⌘⇧K'],
]

/** Settings page: a normal editor-area tab (`kind: 'settings'`), section nav on the left, items on the right, each scrolling on its own. */
export function SettingsView() {
  const t = useT()
  const section = useUi((s) => s.settingsSection)
  const setSection = useUi((s) => s.setSettingsSection)
  const settings = useSettings()
  const patch = useSettings((s) => s.patch)
  const contentRef = useRef<HTMLDivElement>(null)

  // Jump back to the top on section change so the previous page's scroll offset isn't reused
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [section])

  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    patch({ [key]: value } as Partial<Settings>)

  // Agent page: the provider scan is lazy (first open of the page / new chat), never at startup
  const agentProviders = useAgent((s) => s.providers)
  const agentCatalog = useAgent((s) => s.catalogs[settings.agentDefaultProvider])
  const agentModelInfo = agentCatalog?.models.find(
    (item) => item.id === settings.agentDefaultModel,
  )
  const agentEfforts = agentModelInfo && agentModelInfo.efforts.length > 0
    ? agentModelInfo.efforts
    : (agentCatalog?.efforts ?? ['low', 'medium', 'high', 'xhigh', 'max'])
  const usableAgents = (agentProviders ?? []).filter(
    (provider) => provider.installed && provider.supported,
  )
  useEffect(() => {
    if (section !== 'agent') return
    void useAgent.getState().loadProviders()
  }, [section])
  useEffect(() => {
    if (section !== 'agent' || !settings.agentDefaultProvider) return
    void useAgent.getState().loadCatalog(settings.agentDefaultProvider)
  }, [section, settings.agentDefaultProvider])

  // The version comes from the backend (`app_version` → Cargo version, set by the tag),
  // so the frontend no longer hardcodes one — the old hardcoded 0.2.0 drifted from the tag.
  const [version, setVersion] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void updateApi
      .appVersion()
      .then((value) => {
        if (alive) setVersion(value)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Update state: the title bar badge and this page share one state machine (see lib/updateView.ts)
  const updateStatus = useUpdate((s) => s.status)
  const updateInfo = useUpdate((s) => s.info)
  const updatePercent = useUpdate((s) => s.percent)
  const updateError = useUpdate((s) => s.error)
  const installedTo = useUpdate((s) => s.installedTo)
  const revealLog = useUpdate((s) => s.revealLog)

  const updateView: UpdateView = {
    status: updateStatus,
    info: updateInfo,
    percent: updatePercent,
    error: updateError,
    installedTo,
    version,
  }
  const action = updateAction(updateView)
  const detail = updateDetail(updateView)
  const busy = action.kind === 'wait'

  const current = SETTINGS_SECTIONS.find((item) => item.id === section) ?? SETTINGS_SECTIONS[0]

  const content: Record<SettingsSectionId, React.ReactNode> = {
    general: (
      <>
        <Card title={t('settings.memory.card')}>
          <Row label={t('settings.memory.lightweight')} hint={t('settings.memory.lightweightHint')}>
            <Toggle
              value={settings.lightweightMode}
              onChange={(v) => set('lightweightMode', v)}
            />
          </Row>
        </Card>

        <Card title={t('settings.language.card')}>
        <div className="grid grid-cols-2 gap-1.5 px-4 py-3">
          {LOCALES.map((locale) => {
            const active = settings.locale === locale
            return (
              <button
                key={locale}
                onClick={() => set('locale', locale)}
                aria-pressed={active}
                className={`flex items-center gap-2 rounded-[var(--r-control)] border px-3 py-2 text-left text-sm transition-colors duration-fast ${
                  active
                    ? 'border-accent bg-accent/12 text-accent'
                    : 'border-line text-muted hover:bg-hover hover:text-fg'
                }`}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {active ? <Icon name="check" size={12} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{LOCALE_LABELS[locale]}</span>
              </button>
            )
          })}
        </div>
      </Card>
      </>
    ),

    appearance: (
      <>
        <Card title={t('settings.appearance.theme')}>
          <div className="px-4 py-3">
            {THEME_GROUPS.map((group) => (
              <div key={group.group} className="mb-2.5 last:mb-0">
                <div className="mb-1 text-2xs text-muted/70">{t(group.titleKey)}</div>
                <div className="flex flex-wrap gap-1.5">
                  {group.ids.map((id) => {
                    const p = palettes[id]
                    const active = settings.theme === id
                    return (
                      <button
                        key={id}
                        onClick={() => set('theme', id)}
                        className={`flex items-center gap-1.5 rounded-[var(--r-control)] border px-2 py-1 text-xs ${
                          active
                            ? 'border-accent bg-accent/12 text-accent'
                            : 'border-line text-muted hover:bg-hover hover:text-fg'
                        }`}
                      >
                        <span className="flex overflow-hidden rounded-[3px] border border-black/20">
                          {[p.ui.bg, p.ui.accent, p.syntax.string, p.syntax.keyword].map(
                            (color, i) => (
                              <span key={i} style={{ background: color, width: 5, height: 11 }} />
                            ),
                          )}
                        </span>
                        {themeLabel(p, t)}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title={t('settings.appearance.fonts')}>
          <Row label={t('settings.appearance.codeFont')}>
            <div className="flex max-w-[320px] flex-wrap justify-end gap-1">
              {MONO_FONT_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  onClick={() => set('fontFamily', option.id)}
                  className={pill(settings.fontFamily === option.id)}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </Row>
          <div className="border-b border-line/60 px-4 py-3">
            <div
              className="code-font-preview truncate rounded-[var(--r-control)] border border-line/70 bg-bg/60 px-3 py-2 text-xs text-fg/80"
              style={{ fontFamily: monoStack(settings.fontFamily) }}
            >
              const tide = (a, b) =&gt; a == b ? 0123456789 : b
            </div>
          </div>
          <Row label={t('settings.appearance.uiFontSize')}>
            <Stepper
              value={settings.uiFontSize}
              min={11}
              max={16}
              onChange={(v) => set('uiFontSize', v)}
            />
          </Row>
          <Row label={t('settings.appearance.editorFontSize')}>
            <Stepper value={settings.fontSize} min={10} max={24} onChange={(v) => set('fontSize', v)} />
          </Row>
          <Row label={t('settings.appearance.ligatures')}>
            <Toggle value={settings.ligatures} onChange={(v) => set('ligatures', v)} />
          </Row>
        </Card>
      </>
    ),

    editor: (
      <>
        <Card title={t('settings.editor.edit')}>
          <Row label={t('settings.editor.autoSave')}>
            <Toggle value={settings.autoSave} onChange={(v) => set('autoSave', v)} />
          </Row>
          <Row label={t('settings.editor.wordWrap')} hint={t('settings.editor.wordWrapHint')}>
            <Toggle value={settings.wordWrap} onChange={(v) => set('wordWrap', v)} />
          </Row>
          <Row label={t('settings.editor.tabSize')} hint={t('settings.editor.tabSizeHint')}>
            <Stepper value={settings.tabSize} min={1} max={8} onChange={(v) => set('tabSize', v)} />
          </Row>
        </Card>

        <Card title={t('settings.editor.format')}>
          <Row label={t('settings.editor.formatMode')}>
            <div className="flex flex-wrap justify-end gap-1">
              {FORMAT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => set('formatMode', mode.id)}
                  className={`flex items-center gap-1 ${pill(settings.formatMode === mode.id)}`}
                >
                  {settings.formatMode === mode.id ? <Icon name="check" size={10} /> : null}
                  {t(mode.labelKey)}
                </button>
              ))}
            </div>
          </Row>
          <Row
            label={t('settings.editor.formatTool')}
            hint={settings.formatTool === 'auto' ? t('settings.editor.formatToolAutoHint') : undefined}
          >
            <div
              className={`flex max-w-[340px] flex-wrap justify-end gap-1 ${
                settings.formatMode === 'off' ? 'opacity-50' : ''
              }`}
            >
              <button
                onClick={() => set('formatTool', 'auto')}
                className={`flex items-center gap-1 ${pill(settings.formatTool === 'auto')}`}
              >
                {settings.formatTool === 'auto' ? <Icon name="check" size={10} /> : null}
                {t('settings.editor.formatAuto')}
              </button>
              {FORMAT_TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  onClick={() => set('formatTool', tool.id)}
                  className={`flex items-center gap-1 ${pill(settings.formatTool === tool.id)}`}
                  data-tip={t(tool.hintKey)}
                >
                  {settings.formatTool === tool.id ? <Icon name="check" size={10} /> : null}
                  {tool.label}
                  {tool.bundled ? null : (
                    <span className="text-2xs text-muted/70">
                      {t('settings.editor.formatSystemBadge')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </Row>
        </Card>

        <Card title={t('settings.editor.display')}>
          <Row label={t('settings.editor.inlineBlame')}>
            <Toggle value={settings.inlineBlame} onChange={(v) => set('inlineBlame', v)} />
          </Row>
          <Row label={t('settings.editor.indentGuides')}>
            <Toggle value={settings.indentGuides} onChange={(v) => set('indentGuides', v)} />
          </Row>
        </Card>

        <Card title={t('settings.editor.onSave')}>
          <Row label={t('settings.editor.trimTrailingWhitespace')}>
            <Toggle
              value={settings.trimTrailingWhitespace}
              onChange={(v) => set('trimTrailingWhitespace', v)}
            />
          </Row>
          <Row label={t('settings.editor.insertFinalNewline')}>
            <Toggle value={settings.insertFinalNewline} onChange={(v) => set('insertFinalNewline', v)} />
          </Row>
        </Card>
      </>
    ),

    files: (
      <Card>
        <Row
          label={t('settings.files.iconTheme')}
          hint={t(
            (ICON_THEME_OPTIONS.find((o) => o.id === settings.iconTheme) ?? ICON_THEME_OPTIONS[0])
              .hintKey,
          )}
        >
          <div className="flex items-center gap-1">
            {ICON_THEME_OPTIONS.map((option) => (
              <button
                key={option.id}
                onClick={() => set('iconTheme', option.id)}
                className={pill(settings.iconTheme === option.id)}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t('settings.files.showHidden')}>
          <Toggle value={settings.showHidden} onChange={(v) => set('showHidden', v)} />
        </Row>
        <Row label={t('settings.files.compactFolders')}>
          <Toggle value={settings.compactFolders} onChange={(v) => set('compactFolders', v)} />
        </Row>
      </Card>
    ),

    terminal: (
      <Card>
        <Row label={t('settings.terminal.fontSize')}>
          <Stepper
            value={settings.terminalFontSize}
            min={9}
            max={22}
            onChange={(v) => set('terminalFontSize', v)}
          />
        </Row>
        <Row label={t('settings.terminal.scrollback')}>
          <div className="flex items-center gap-1">
            {[1000, 2000, 5000].map((value) => (
              <button
                key={value}
                onClick={() => set('terminalScrollback', value)}
                className={pill(settings.terminalScrollback === value)}
              >
                {t('settings.terminal.scrollbackLines', { count: value })}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t('settings.terminal.webgl')}>
          <Toggle value={settings.terminalWebgl} onChange={(v) => set('terminalWebgl', v)} />
        </Row>
      </Card>
    ),

    agent: (
      <>
        <Card title={t('settings.agent.card')}>
          <Row label={t('settings.agent.enable')}>
            <Toggle value={settings.agentEnabled} onChange={(v) => set('agentEnabled', v)} />
          </Row>
          <Row label={t('settings.agent.defaultAgent')}>
            <Picker
              label=""
              value={settings.agentDefaultProvider}
              options={[
                { id: '', label: t('agent.picker.auto') },
                ...usableAgents.map((provider) => ({ id: provider.id, label: provider.name })),
              ]}
              onPick={(id) => {
                set('agentDefaultProvider', id)
                set('agentDefaultModel', '')
                set('agentDefaultEffort', '')
              }}
            />
          </Row>
          <Row label={t('settings.agent.defaultModel')}>
            <Picker
              label=""
              value={settings.agentDefaultModel}
              options={[
                { id: '', label: t('agent.picker.defaultModel') },
                ...(agentCatalog?.models ?? []).map((model) => ({
                  id: model.id,
                  label: model.label,
                })),
              ]}
              onPick={(id) => {
                const model = agentCatalog?.models.find((item) => item.id === id)
                const allowed =
                  model && model.efforts.length > 0
                    ? model.efforts
                    : (agentCatalog?.efforts ?? [])
                set('agentDefaultModel', id)
                if (
                  settings.agentDefaultEffort &&
                  allowed.length > 0 &&
                  !allowed.includes(settings.agentDefaultEffort)
                ) {
                  set('agentDefaultEffort', model?.defaultEffort ?? '')
                }
              }}
              disabled={!settings.agentDefaultProvider}
            />
          </Row>
          <Row label={t('settings.agent.defaultComplexity')}>
            <Picker
              label=""
              value={settings.agentDefaultEffort}
              options={[
                { id: '', label: t('agent.picker.defaultEffort') },
                ...agentEfforts.map((level) => ({ id: level, label: effortLabel(level, level) })),
              ]}
              onPick={(id) => set('agentDefaultEffort', id)}
              disabled={!settings.agentDefaultProvider}
            />
          </Row>
        </Card>

        <Card title={t('settings.agent.detected')}>
          <div className="flex justify-end border-b border-line/60 px-4 py-2">
            <button
              type="button"
              onClick={() => {
                const agent = useAgent.getState()
                void agent.loadProviders(true).then(() => {
                  // A CLI installed after the first scan may still have an empty cached catalog
                  const providers = useAgent.getState().providers ?? []
                  for (const provider of providers) {
                    if (provider.installed && provider.supported) {
                      void useAgent.getState().loadCatalog(provider.id, true)
                    }
                  }
                })
              }}
              className="shrink-0 rounded-[var(--r-control)] border border-line-soft px-2 py-0.5 text-2xs text-fg/80 transition-colors duration-fast hover:bg-hover"
            >
              {t('settings.agent.rescan')}
            </button>
          </div>
          {agentProviders === null ? (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
              <Icon name="spinner" size={12} className="animate-spin" />
              {t('settings.agent.scanning')}
            </div>
          ) : agentProviders.length === 0 ? (
            <div className="px-4 py-3 text-xs text-muted">{t('settings.agent.none')}</div>
          ) : (
            agentProviders.map((provider) => (
              <div
                key={provider.id}
                className="flex items-center justify-between gap-3 border-b border-line/60 px-4 py-2 last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Icon
                    name={provider.installed ? 'check-circle' : 'dot'}
                    size={12}
                    className={provider.installed ? 'shrink-0 text-success' : 'shrink-0 text-muted/50'}
                  />
                  <span className="truncate text-sm text-fg/90">{provider.name}</span>
                  <span className="min-w-0 truncate font-mono text-2xs text-muted">
                    {provider.version ?? ''}
                  </span>
                </div>
                {!provider.installed ? (
                  <span className="shrink-0 text-2xs text-muted">
                    {t('settings.agent.notInstalled')}
                  </span>
                ) : provider.supported ? null : (
                  <span className="shrink-0 text-2xs text-warning">
                    {t('settings.agent.unsupported')}
                  </span>
                )}
              </div>
            ))
          )}
        </Card>

        <Card title={t('settings.agent.permissions')}>
          <div className="px-4 py-3 text-xs leading-relaxed text-muted">
            {t('settings.agent.permissionsHint')}
          </div>
        </Card>
      </>
    ),

    keys: (
      <Card>
        <div className="grid grid-cols-2 gap-x-10 px-4 py-2 text-xs text-muted">
          {SHORTCUTS.map(([labelKey, key]) => (
            <div
              key={labelKey}
              className="flex items-center justify-between gap-2 border-b border-line/40 py-1.5 [&:nth-last-child(-n+2)]:border-b-0"
            >
              <span>{t(labelKey)}</span>
              <span className="shrink-0 text-fg/80">{key}</span>
            </div>
          ))}
        </div>
      </Card>
    ),

    about: (
      <>
        <Card title="Tide">
          <Row label={t('settings.about.version')}>
            <span className="text-sm text-fg/80">{version ?? '—'}</span>
          </Row>
          <Row label={t('settings.about.settingsFile')}>
            <span className="text-xs text-muted">settings.json</span>
          </Row>
          {/* The URL is not copy: it stays as-is in every language, only the label is translated */}
          <Row label={t('settings.about.repository')}>
            <button
              type="button"
              onClick={() => {
                // Same allowlisted opener the update flow uses (https on github.com only)
                void updateApi.openPage(REPOSITORY_URL).catch((e) => {
                  useUi.getState().toast(errorText(e), 'error')
                })
              }}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <span>github.com/ilemon18/tide</span>
              <Icon name="external" size={11} />
            </button>
          </Row>
        </Card>

        <Card title={t('settings.about.updates')}>
          <div className="px-4 py-3">
            <button
              type="button"
              onClick={() => runUpdateAction(action.kind)}
              // aria-disabled instead of disabled: a disabled button swallows pointer events,
              // and "downloading 42%" is exactly the busy-state hint worth keeping
              aria-disabled={busy}
              aria-busy={busy}
              className={`flex items-center gap-2 rounded-[var(--r-control)] px-3 py-1.5 text-sm transition-colors duration-fast ${
                busy
                  ? 'cursor-default bg-active/60 text-muted'
                  : action.tone === 'accent'
                    ? 'bg-accent/15 text-accent hover:bg-accent/25'
                    : action.tone === 'danger'
                      ? 'bg-warning/15 text-warning hover:bg-warning/25'
                      : 'border border-line text-fg/80 hover:bg-hover'
              }`}
            >
              <Icon
                name={action.icon}
                size={13}
                className={
                  action.motion === 'spin'
                    ? 'animate-spin'
                    : action.motion === 'pulse'
                      ? 'animate-pulse'
                      : ''
                }
              />
              <span className="tabular-nums">{action.label}</span>
            </button>
            {detail ? (
              <p className="mt-2 text-xs leading-relaxed text-muted">{detail}</p>
            ) : null}
            {/* The only useful next step after a failed install: read the log instead of guessing */}
            {detail && updateStatus === 'error' ? (
              <button
                type="button"
                onClick={() => void revealLog()}
                className="mt-1.5 text-xs text-accent hover:underline"
              >
                {t('settings.about.updateLog')}
              </button>
            ) : null}
          </div>
        </Card>
      </>
    ),
  }

  return (
    <div className="absolute inset-0 flex overflow-hidden bg-bg">
      <nav className="flex w-[212px] shrink-0 flex-col border-r border-line-soft bg-panel px-2 py-3">
        <div className="px-2.5 pb-2 text-2xs font-medium tracking-wide text-muted/70">
          {t('settings.title')}
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-2 rounded-[var(--r-control)] px-2.5 py-1.5 text-left text-sm transition-colors duration-fast ${
                section === item.id
                  ? 'bg-row-selected text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              }`}
            >
              <Icon
                name={item.icon}
                size={14}
                className={`shrink-0 ${section === item.id ? 'text-accent' : ''}`}
              />
              <span className="truncate">{t(item.labelKey)}</span>
            </button>
          ))}
        </div>
      </nav>

      <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[820px] px-8 py-6">
          <header className="mb-5">
            <h2 className="text-lg font-semibold text-fg">{t(current.labelKey)}</h2>
          </header>
          {content[section]}
        </div>
      </div>
    </div>
  )
}
