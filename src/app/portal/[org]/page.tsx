import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPortalHome } from '@/server/portal/queries'
import { PortalButton, PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { ErrorNotice, one, pageOrg, pageSession, Unavailable, type SearchParams } from './_lib/page'

// /portal/[org] (S7-04 · the home S7-08 fills): who is signed in and for whom. A contact who has not accepted the current
// privacy notice sees it before anything else (BR-PORTAL ข้อ 08). Without a session of this organization → sign in.

const STATUSES = ['INVITED', 'DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'] as const

export default async function PortalHomePage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const [t, home, q] = await Promise.all([getTranslations('portal'), getPortalHome(session.state.ctx), searchParams])
  const signOut = (
    <form method="post" action={`/portal/${org.code}/api/sign-out`}>
      <input type="hidden" name="csrf" value={session.csrf} />
      <PortalButton type="submit" variant="secondary" className="w-full">
        {t('home.signOut')}
      </PortalButton>
    </form>
  )
  if (home.privacyNoticeDue) {
    return (
      <PortalFrame organization={org.nameTh} title={t('privacy.title')}>
        <ErrorNotice code={one(q.error)} />
        <p className="whitespace-pre-line">{t(`privacy.${home.privacyNoticeDue as '2026-11-08'}`)}</p>
        <form method="post" action={`/portal/${org.code}/api/privacy`}>
          <input type="hidden" name="csrf" value={session.csrf} />
          <input type="hidden" name="version" value={home.privacyNoticeDue} />
          <PortalButton type="submit" className="w-full">
            {t('privacy.accept')}
          </PortalButton>
        </form>
        {signOut}
      </PortalFrame>
    )
  }
  const status = home.application && (STATUSES as readonly string[]).includes(home.application.status) ? (home.application.status as (typeof STATUSES)[number]) : null
  return (
    <PortalFrame organization={org.nameTh} title={t('home.greeting', { name: home.contact.nameTh })}>
      <ErrorNotice code={one(q.error)} />
      {home.supplier ? <p>{t('home.forSupplier', { supplier: home.supplier.nameTh })}</p> : null}
      {home.application && !home.supplier ? <p>{t('home.forApplication', { name: home.application.nameTh })}</p> : null}
      {status ? <PortalNotice tone="info">{t('home.applicationStatus', { status: t(`applicationStatus.${status}`) })}</PortalNotice> : null}
      <a href={`/portal/${org.code}/documents`} className="text-primary underline underline-offset-4">
        {t('home.documents')}
      </a>
      {signOut}
    </PortalFrame>
  )
}
