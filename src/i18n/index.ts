import { create } from 'zustand'
import { en } from './messages/en'
import type { Messages } from './types'
import { DEFAULT_LOCALE, isLocale, type Locale, type MessageKey } from './types'

export { DEFAULT_LOCALE, LOCALES, LOCALE_ENGLISH_NAMES, LOCALE_LABELS, isLocale } from './types'
export type { Locale, MessageKey } from './types'

export type TranslateParams = Record<string, string | number>
export type TFunction = (key: MessageKey, params?: TranslateParams) => string

/**
 * Catalogs are loaded on demand. English ships with the bundle (it is the fallback for every missing
 * entry); the other five are several tens of KB of strings each, and a window only ever shows one —
 * importing all of them put every language in the heap for nothing.
 */
const CATALOGS: Partial<Record<Locale, Messages>> = { en }

const CATALOG_LOADERS: Record<Exclude<Locale, 'en'>, () => Promise<{ default: Messages }>> = {
  'zh-CN': () => import('./messages/zh-CN').then((m) => ({ default: m.zhCN })),
  'zh-TW': () => import('./messages/zh-TW').then((m) => ({ default: m.zhTW })),
  ja: () => import('./messages/ja').then((m) => ({ default: m.ja })),
  ko: () => import('./messages/ko').then((m) => ({ default: m.ko })),
  es: () => import('./messages/es').then((m) => ({ default: m.es })),
}

const pendingCatalogs = new Set<Locale>()

/**
 * Fetch a catalog in the background. Until it lands, t() falls back to English; the notify re-renders
 * every subscriber once the real strings are in place.
 */
function loadCatalog(locale: Locale) {
  if (CATALOGS[locale] || pendingCatalogs.has(locale)) return
  if (!(locale in CATALOG_LOADERS)) return
  pendingCatalogs.add(locale)
  void CATALOG_LOADERS[locale as Exclude<Locale, 'en'>]()
    .then((mod) => {
      CATALOGS[locale] = mod.default
      // Another locale may have been chosen meanwhile: bumping the counter re-renders either way
      localeStore.setState({ locale: localeStore.getState().locale, version: nextVersion++ })
      for (const listener of [...listeners]) listener()
    })
    .catch(() => {
      /* Keep English: a missing catalog must not blank the UI */
    })
    .finally(() => pendingCatalogs.delete(locale))
}

let nextVersion = 1

/**
 * The current locale lives in its own tiny store. Reading the settings store directly would create a
 * circular import (i18n is used by the settings store, the store layer and editor extensions).
 * The settings store pushes the locale in (applyLocale); this module only records and notifies.
 */
const localeStore = create<{ locale: Locale; version: number }>(() => ({
  locale: DEFAULT_LOCALE,
  version: 0,
}))

const listeners = new Set<() => void>()

export function currentLocale(): Locale {
  return localeStore.getState().locale
}

/** Apply a locale: store the value, sync `<html lang>` (affects line breaking, font fallback and screen readers), notify non-React subscribers. */
export function applyLocale(next: Locale): void {
  const normalized = isLocale(next) ? next : DEFAULT_LOCALE
  const changed = normalized !== currentLocale()
  if (changed) localeStore.setState({ locale: normalized, version: nextVersion++ })
  if (document.documentElement.lang !== normalized) document.documentElement.lang = normalized
  // Start fetching the catalog even when the locale did not change: a window restored into a stored
  // locale must not wait for a settings change before its strings exist.
  loadCatalog(normalized)
  if (!changed) return
  for (const listener of [...listeners]) listener()
}

/**
 * Wait for a catalog to be in place. The boot path awaits this so a window restored into a non-English
 * locale paints its real strings instead of flashing English.
 */
export async function awaitCatalog(locale: Locale): Promise<void> {
  const normalized = isLocale(locale) ? locale : DEFAULT_LOCALE
  if (CATALOGS[normalized]) return
  if (!(normalized in CATALOG_LOADERS)) return
  try {
    const mod = await CATALOG_LOADERS[normalized as Exclude<Locale, 'en'>]()
    CATALOGS[normalized] = mod.default
    localeStore.setState({ locale: localeStore.getState().locale, version: nextVersion++ })
  } catch {
    /* Keep English: a missing catalog must not blank the UI */
  }
}

/** Locale change subscription for non-React code (returns an unsubscribe function) */
export function onLocaleChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Plural/singular separator: `'{count} file | {count} files'` */
const PLURAL_SEPARATOR = ' | '

const pluralRules = new Map<string, Intl.PluralRules>()

function pluralForm(forms: string[], count: number): string {
  if (forms.length === 1) return forms[0]
  const locale = currentLocale()
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  // one / two / few / many: everything except singular falls back to the last form (enough for en/es/zh/ja)
  return rules.select(count) === 'one' ? forms[0] : forms[forms.length - 1]
}

/** `{name}` placeholder replacement; missing params are left as-is so the check script can spot them */
function interpolate(template: string, params?: TranslateParams): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * Look up a message. Entries containing `|` are plurals: a numeric `count` picks the form per the locale's
 * rules, otherwise the last form is used (usually the plural/generic one).
 */
export function t(key: MessageKey, params?: TranslateParams): string {
  const raw = (CATALOGS[currentLocale()] ?? en)[key] ?? en[key]
  if (raw === undefined) return key
  if (!raw.includes(PLURAL_SEPARATOR)) return interpolate(raw, params)
  const forms = raw.split(PLURAL_SEPARATOR)
  const template =
    typeof params?.count === 'number' ? pluralForm(forms, params.count) : forms[forms.length - 1]
  return interpolate(template, params)
}

/** Explicit plural choice: `tp('status.unsaved', 3)`, clearer than relying on count being implicit */
export function tp(key: MessageKey, count: number, params?: TranslateParams): string {
  const raw = (CATALOGS[currentLocale()] ?? en)[key] ?? en[key] ?? key
  return interpolate(pluralForm(raw.split(PLURAL_SEPARATOR), count), { count, ...params })
}

/** Can an external string (e.g. a backend error code) be translated? If not, don't force it into t() */
export function hasMessage(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key)
}

const numberFormatters = new Map<string, Intl.NumberFormat>()

export function formatNumber(value: number): string {
  const locale = currentLocale()
  let formatter = numberFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    numberFormatters.set(locale, formatter)
  }
  return formatter.format(value)
}

/** For components: returns the current locale and subscribes to changes */
export function useLocale(): Locale {
  return localeStore((s) => s.locale)
}

/** For components: returns t and subscribes to locale changes (and to a catalog arriving late) */
export function useT(): TFunction {
  localeStore((s) => s.locale)
  localeStore((s) => s.version)
  return t
}