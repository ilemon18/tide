import type { en } from './messages/en'

/**
 * Supported locales; the order is the order in settings (English first, then by script: zh-CN / zh-TW → ja → ko → es).
 * Adding a language takes three steps: add `messages/<locale>.ts`, add the id to `LOCALES`, add its endonym to `LOCALE_LABELS`.
 */
export type Locale = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'es'

export const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'es'] as const satisfies readonly Locale[]

export const DEFAULT_LOCALE: Locale = 'en'

/** Display name in settings / the language switcher: always the language's own endonym so users can find theirs */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
  ko: '한국어',
  es: 'Español',
}

/** English names of the locales (for aria labels and hints) */
export const LOCALE_ENGLISH_NAMES: Record<Locale, string> = {
  en: 'English',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
}

/** Message keys: derived from the English catalog; other languages must match exactly */
export type MessageKey = keyof typeof en

/** A complete catalog: a missing entry fails the type check */
export type Messages = Record<MessageKey, string>

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}