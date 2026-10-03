import { getTranslations } from 'next-intl/server'
import { defaultLocale } from '@/i18n/locales'
import { appIcon } from './_lib/app-icon'

// Home-screen icon for iOS (spec §9.7)
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default async function AppleIcon() {
  const t = await getTranslations({ locale: defaultLocale, namespace: 'auth' })
  return appIcon(size.width, false, t('brand'))
}
