import { create } from 'zustand'
import { DEFAULT_SETTINGS_SECTION, type SettingsSectionId } from '../lib/settingsSections'

export type ToastKind = 'info' | 'error' | 'success'
export type Toast = { id: number; text: string; kind: ToastKind }
export type OverlayKind = 'quickopen' | 'commands' | 'projects' | null

export type ConfirmRequest = {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
  resolve: (ok: boolean) => void
}

export type PromptRequest = {
  title: string
  message?: string
  value?: string
  placeholder?: string
  confirmText?: string
  resolve: (value: string | null) => void
}

export type ActivityView = 'explorer' | 'search' | 'git' | 'structure' | 'tasks'

type UiStore = {
  activityView: ActivityView
  setActivityView: (view: ActivityView) => void

  toasts: Toast[]
  toast: (text: string, kind?: ToastKind) => void
  dismissToast: (id: number) => void

  overlay: OverlayKind
  setOverlay: (o: OverlayKind) => void

  /** Which settings tab section is active (kept across close/reopen and status-bar deep links) */
  settingsSection: SettingsSectionId
  setSettingsSection: (section: SettingsSectionId) => void
  /** Prefill for the quick open panel (⌃G starts with `:` for go-to-line) */
  quickOpenSeed: string
  openQuickOpen: (seed?: string) => void

  themeMenu: { left: number; bottom: number; maxHeight: number } | null
  openThemeMenu: (anchor: { left: number; bottom: number; maxHeight: number }) => void
  closeThemeMenu: () => void

  /** Status bar branch dropdown: centered popup, only needs the target workspace */
  branchMenu: { root: string } | null
  openBranchMenu: (anchor: { root: string }) => void
  closeBranchMenu: () => void

  confirmReq: ConfirmRequest | null
  confirm: (opts: Omit<ConfirmRequest, 'resolve'>) => Promise<boolean>
  answerConfirm: (ok: boolean) => void

  promptReq: PromptRequest | null
  askText: (opts: Omit<PromptRequest, 'resolve'>) => Promise<string | null>
  answerPrompt: (value: string | null) => void
}

let nextToastId = 1

export const useUi = create<UiStore>((set, get) => ({
  activityView: 'explorer',
  setActivityView: (activityView) => set({ activityView }),

  toasts: [],
  toast: (text, kind = 'info') => {
    const id = nextToastId++
    set({ toasts: [...get().toasts, { id, text, kind }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  overlay: null,
  setOverlay: (overlay) => set({ overlay }),

  settingsSection: DEFAULT_SETTINGS_SECTION,
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  quickOpenSeed: '',
  openQuickOpen: (seed = '') => set({ quickOpenSeed: seed, overlay: 'quickopen' }),

  themeMenu: null,
  openThemeMenu: (anchor) => set({ themeMenu: anchor }),
  closeThemeMenu: () => set({ themeMenu: null }),

  branchMenu: null,
  openBranchMenu: (anchor) => set({ branchMenu: anchor }),
  closeBranchMenu: () => set({ branchMenu: null }),

  confirmReq: null,
  confirm: (opts) =>
    new Promise<boolean>((resolve) => {
      set({ confirmReq: { ...opts, resolve } })
    }),
  answerConfirm: (ok) => {
    const req = get().confirmReq
    set({ confirmReq: null })
    req?.resolve(ok)
  },

  promptReq: null,
  askText: (opts) =>
    new Promise<string | null>((resolve) => {
      set({ promptReq: { ...opts, resolve } })
    }),
  answerPrompt: (value) => {
    const req = get().promptReq
    set({ promptReq: null })
    req?.resolve(value)
  },
}))
