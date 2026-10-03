export const locales = ['th', 'en'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'th'

export const localeCookieName = 'NEXT_LOCALE'

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value)
}
