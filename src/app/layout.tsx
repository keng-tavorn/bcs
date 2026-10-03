import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans_Thai } from 'next/font/google'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { PwaRegistration } from '@/ui/pwa/pwa-registration'
import './globals.css'

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ['thai', 'latin'],
  weight: ['400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-plex-thai',
})

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('app')
  return {
    title: { default: t('name'), template: `%s · ${t('name')}` },
    description: t('description'),
    // Installed on an iPhone home screen it opens full screen under the name BCS (spec §9.7)
    appleWebApp: { capable: true, title: 'BCS', statusBarStyle: 'default' },
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b6e5f',
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  const t = await getTranslations('pwa')
  return (
    <html lang={locale} className={plexThai.variable}>
      <body>
        <NextIntlClientProvider>
          {children}
          <PwaRegistration labels={{ updateReady: t('updateReady'), updateNow: t('updateNow'), updateLater: t('updateLater') }} />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
