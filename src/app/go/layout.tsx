import { getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { PwaRegistration } from '@/ui/pwa/pwa-registration'
import { ClientMessages } from '../_lib/client-messages'

// BCS Go's pages for the phone (S17-13, FR-PLT-301): one narrow column under the app's name, outside the workspace
// layout. Nothing here reads the session: the service worker keeps /go/receive's HTML for use without a signal
// (src/app/sw.js, BR-APP-03), so the HTML is the same for everyone and holds no business data — the page learns who is
// signed in, and what they may receive, from /api/go/*. The service worker is registered here too: the app may open
// this page first.
export default async function GoLayout({ children }: { children: ReactNode }) {
  const [t, tPwa] = await Promise.all([getTranslations('goReceive'), getTranslations('pwa')])
  return (
    <ClientMessages scope="go">
      <div className="min-h-dvh bg-bg">
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-2xl px-4 py-4">
            <span className="text-xl font-bold text-ink">{t('brand')}</span>
          </div>
        </header>
        <main className="mx-auto max-w-2xl px-4 pt-6 pb-16">{children}</main>
      </div>
      <PwaRegistration labels={{ updateReady: tPwa('updateReady'), updateNow: tPwa('updateNow'), updateLater: tPwa('updateLater') }} />
    </ClientMessages>
  )
}
