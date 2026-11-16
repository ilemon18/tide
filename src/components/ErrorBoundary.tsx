import { Component, type ErrorInfo, type ReactNode } from 'react'
import { t } from '../i18n'

type Props = { children: ReactNode; label?: string }
type State = { error: Error | null }

/** Local error boundary: a child throw swaps only that region for a recoverable card instead of blanking the window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[Tide] ${this.props.label ?? 'ui'} crashed:`, error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <div className="text-md font-semibold text-danger">
          {t('errorBoundary.title', { label: this.props.label ?? t('common.interface') })}
        </div>
        <div className="max-w-[460px] whitespace-pre-wrap break-words text-xs text-muted">
          {error.message}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => this.setState({ error: null })}
            className="rounded border border-line px-3 py-1 text-sm text-muted hover:bg-hover hover:text-fg"
          >
             {t('common.retry')}
          </button>
          <button
            onClick={() => window.location.reload()}
            className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-fg"
          >
            {t('errorBoundary.reload')}
          </button>
        </div>
      </div>
    )
  }
}