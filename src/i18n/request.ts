import { cookies } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { defaultLocale, isLocale, localeCookieName } from './locales'

// Thai is the default; English is chosen by cookie (ADR-026). No locale prefix in URLs. A page that knows its reader's
// own language asks for it by name — getTranslations({ locale }) — and gets that catalogue: the supplier portal's RFx
// pages follow SupplierContact.locale (S10-07)
export default getRequestConfig(async ({ locale: asked }) => {
  const store = await cookies()
  const candidate = asked ?? store.get(localeCookieName)?.value
  const locale = candidate && isLocale(candidate) ? candidate : defaultLocale
  return {
    locale,
    timeZone: 'Asia/Bangkok',
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
