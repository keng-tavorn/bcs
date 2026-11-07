import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getPortalHome } from '@/server/portal/queries'
import { PortalButton, PortalFrame } from '@/ui/portal/frame'
import { ErrorNotice, one, pageOrg, pageSession, Unavailable, type SearchParams } from './_lib/page'

// /portal/[org] (S7-04 S7-08): where a signed-in contact starts. One who has not accepted the current privacy notice sees
// it before anything else (BR-PORTAL ข้อ 08); then a supplier's contact goes to its home, an application's to its form.
// Without a session of this organization → sign in.

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
        <p className="whitespace-pre-line">{t(`privacy.${home.privacyNoticeDue as '2026-11-01'}`)}</p>
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
  // the privacy notice accepted: a contact of a registered supplier starts at its home, an application's at its form
  redirect(home.supplier ? `/portal/${org.code}/home` : `/portal/${org.code}/apply`)
}
