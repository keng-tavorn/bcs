import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { PwaRegistration } from '@/ui/pwa/pwa-registration'
import { ClientMessages } from '../_lib/client-messages'

// Sign-in pages: one narrow column, the product name on top, nothing decorative (§9.9). Their forms read the auth and
// action-link messages (src/i18n/client-messages.ts). The PWA's service worker is registered here and in the workspace
// (§9.7): a first visit to BCS on a phone starts at the sign-in.
export default async function AuthLayout({ children }: { children: ReactNode }) {
  const [t, tPwa] = await Promise.all([getTranslations('auth'), getTranslations('pwa')])
  return (
    <ClientMessages scope="auth">
      <div className="min-h-dvh bg-bg">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-md flex-col px-4 py-4">
            <span className="text-xl font-bold text-ink">{t('brand')}</span>
            <span className="text-base md:text-sm text-ink-muted">{t('brandTagline')}</span>
          </div>
        </header>
        <main className="mx-auto max-w-md px-4 pt-8 pb-16">{children}</main>
      </div>
      <PwaRegistration labels={{ updateReady: tPwa('updateReady'), updateNow: tPwa('updateNow'), updateLater: tPwa('updateLater') }} />
    </ClientMessages>
  )
}
