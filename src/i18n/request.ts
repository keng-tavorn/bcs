import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { defaultLocale, isLocale, localeCookieName } from './locales'

// Thai is the default; English is chosen by cookie (ADR-026). No locale prefix in URLs.
export default getRequestConfig(async () => {
  const store = await cookies()
  const candidate = store.get(localeCookieName)?.value
  const locale = candidate && isLocale(candidate) ? candidate : defaultLocale
  return {
    locale,
    timeZone: 'Asia/Bangkok',
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
