import type { Viewport } from 'next'
import { cookies } from 'next/headers'
import type { ReactNode } from 'react'
import { getEnv } from '@/lib/env'
import { LiffProvider } from '@/ui/liff/liff-provider'
import { LIFF_MOCK_USER_COOKIE, mockLineUserOf } from './_lib/mock-cookie'
import { liffPage } from './_lib/session'

// The LIFF app (§9.4, ADR-024): one app at /liff, its pages as paths, outside the workspace layout (no workspace menu).
// The bootstrap (LiffProvider) starts here once per page load — liff.init with this environment's LIFF ID before anything
// else — and stays while the person moves between LIFF pages. Every page reads the session itself (./_lib/session.ts)
// and shows data only to a member; without a session it shows the gate, which signs in with the LINE ID token. The
// bootstrap is told which session the page has (LINE or password, or none) so that it renews only a LINE one.
// LIFF_MOCK=1 (APP_ENV=local only, src/lib/env.ts) skips liff.init: the LINE user comes from the mock cookie and its ID
// token from the fake LINE server (POST /api/liff/mock-token); the sign-in after that is the real one.

// The page reaches under the notch and the home indicator; the frame keeps its content inside the safe area
export const viewport: Viewport = { viewportFit: 'cover' }

export default async function LiffLayout({ children }: { children: ReactNode }) {
  const env = getEnv()
  const mocked = env.APP_ENV === 'local' && env.LIFF_MOCK === true
  const [page, store] = await Promise.all([liffPage(), cookies()])
  const lineUserId = mocked ? mockLineUserOf(store.get(LIFF_MOCK_USER_COOKIE)?.value) : null
  const session = page.kind === 'signed-out' ? null : page.session
  return (
    <LiffProvider config={{ liffId: env.NEXT_PUBLIC_LIFF_ID ?? null, mock: mocked ? { lineUserId, cookie: LIFF_MOCK_USER_COOKIE } : null, session }}>
      {children}
    </LiffProvider>
  )
}
