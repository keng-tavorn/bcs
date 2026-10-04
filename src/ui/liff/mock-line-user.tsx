'use client'

import { useTranslations } from 'next-intl'
import { Button } from './button'

// LIFF_MOCK only (APP_ENV=local, src/lib/env.ts refuses it elsewhere): a LIFF page in an ordinary browser counts as
// "outside LINE" until the mock cookie names a LINE user (src/app/liff/_lib/mock-cookie.ts). An e2e test sets the cookie
// itself; a developer trying the link on `pnpm dev` (docs/runbooks/line-demo-setup.md §4.4) presses this instead, which
// names a new LINE user of the fake LINE server and loads the page again, now "in LINE". Loaded only where a page shows
// "open this in the LINE app" and only in mock mode, so no other page carries it.

export function MockLineUser({ cookie }: { readonly cookie: string }) {
  const t = useTranslations('liff.mock')
  const actAsLineUser = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const lineUserId = `U${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
    document.cookie = `${cookie}=${lineUserId}; path=/; samesite=lax`
    window.location.reload()
  }
  return (
    <div className="flex flex-col gap-2 border border-dashed border-line px-3 py-2.5">
      <p className="text-ink-muted">{t('intro')}</p>
      <Button variant="secondary" className="self-start" onClick={actAsLineUser}>
        {t('act')}
      </Button>
    </div>
  )
}
