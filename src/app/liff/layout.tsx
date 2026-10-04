import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { getEnv } from '@/lib/env'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { ClientMessages } from '../_lib/client-messages'
import { LIFF_MOCK_USER_COOKIE, mockLineUserOf } from './_lib/mock-cookie'
import { liffPage } from './_lib/session'

// The LIFF app (§9.4, ADR-024): one app at /liff, its pages as paths, outside the workspace layout (no workspace menu).
// The bootstrap (LiffProvider) starts here once per page load — liff.init with this environment's LIFF ID before anything
// else — and stays while the person moves between LIFF pages. Every page reads the session itself (./_lib/session.ts)
// and shows data only to a member; without a session it shows the gate, which signs in with the LINE ID token. The
// bootstrap is told which session the page has (LINE or password, or none) so that it renews only a LINE one.
// LIFF_MOCK=1 (APP_ENV=local only, src/lib/env.ts) skips liff.init: the LINE user comes from the mock cookie and its ID
// token from the fake LINE server (POST /api/liff/mock-token); the sign-in after that is the real one.
// A LIFF page's first JavaScript, the page data in its HTML included, is at most 200 KB gzip (§9.4), and the messages its
// client components read are part of that page data: this layout passes the gate's words only, and every part of the app
// with client components of its own passes its words in its own layout (src/i18n/client-messages.ts) — to a member only
// where the part's pages show anyone else the gate (./_lib/part-messages.tsx). No PWA service worker is registered here:
// LIFF runs inside LINE (§9.7 is the workspace's).

// The page reaches under the notch and the home indicator; the frame keeps its content inside the safe area
export const viewport: Viewport = { viewportFit: 'cover' }

// A LIFF page opens inside LINE: no description for search results and no home-screen app of its own (both are the
// workspace's, src/app/layout.tsx), and every byte of its head's page data counts in its first load (§9.4)
export const metadata: Metadata = { description: null, appleWebApp: null }

export default async function LiffLayout({ children }: { children: ReactNode }) {
  const env = getEnv()
  const mocked = env.APP_ENV === 'local' && env.LIFF_MOCK === true
  const [page, store] = await Promise.all([liffPage(), cookies()])
  const lineUserId = mocked ? mockLineUserOf(store.get(LIFF_MOCK_USER_COOKIE)?.value) : null
  const session = page.kind === 'signed-out' ? null : page.session
  return (
    <ClientMessages scope="liff">
      <LiffProvider config={{ liffId: env.NEXT_PUBLIC_LIFF_ID ?? null, mock: mocked ? { lineUserId, cookie: LIFF_MOCK_USER_COOKIE } : null, session }}>
        {children}
      </LiffProvider>
    </ClientMessages>
  )
}
