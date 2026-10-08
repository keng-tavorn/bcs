import type { Metadata, Viewport } from 'next'
import { IBM_Plex_Sans_Thai } from 'next/font/google'
import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { ClientMessages } from './_lib/client-messages'
import './globals.css'
import { THEME_COLORS } from '@/ui/theme'

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
  themeColor: THEME_COLORS.primary,
}

// Every page. The message provider here holds only what the root error boundary reads: each part of the app (the
// workspace, sign-in, the BCS team's pages, the LIFF app) has a provider of its own in its layout, with what its own
// client components read (src/i18n/client-messages.ts) — every page carries its provider's messages in its HTML, and
// the whole catalogue would be some 90 KB gzip of it (§9.4). The PWA's service worker is registered by the workspace and
// sign-in layouts, not here: the LIFF pages run inside LINE (§9.4, §9.7).
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale()
  return (
    <html lang={locale} className={plexThai.variable}>
      <body>
        <ClientMessages scope="root">{children}</ClientMessages>
      </body>
    </html>
  )
}
