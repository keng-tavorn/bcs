import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getMyLineLink } from '@/server/services/line-link'
import { LIFF_LINK_PATH, LIFF_START_PATH, liffStateTarget } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { liffPage } from './_lib/session'

export async function generateMetadata() {
  const t = await getTranslations('liff.index')
  return { title: t('title') }
}

// /liff, the LIFF app's endpoint (§9.4, ADR-024): a linked member goes to the home page in LINE (ADR-167), anyone else to /liff/link. A deep
// link of LINE (https://liff.line.me/<LIFF ID>/<path>, from a card, a rich menu or a QR code) opens this page with
// ?liff.state=<path>; the bootstrap goes on to /liff/<path> (liff.init does, and the gate makes sure), so the server never
// redirects a request whose deep link the bootstrap will follow. A deep link it would refuse (not a LIFF page of this
// site: a query only, dot segments, another site) is as good as none, and a page with a session is sent on by the server
// as without one. Without a session the gate signs in first, and outside LINE it goes to the web sign-in. The gate is
// told the session the server saw, so a password sign-in is never swapped for the LINE account's own session here.
export default async function LiffIndexPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const state = params['liff.state']
  const liffState = typeof state === 'string' ? state : null
  const page = await liffPage()
  if (!liffStateTarget(liffState)) {
    if (page.kind === 'member') {
      const link = await getMyLineLink(page.ctx)
      redirect(link.ok && link.data.linked ? LIFF_START_PATH : LIFF_LINK_PATH)
    }
    if (page.kind !== 'signed-out') redirect(LIFF_LINK_PATH)
  }
  const t = await getTranslations('liff.index')
  return (
    <LiffFrame title={t('title')}>
      <LiffContent>
        <LiffGate mode="index" state={page.kind} liffState={liffState} />
      </LiffContent>
    </LiffFrame>
  )
}
