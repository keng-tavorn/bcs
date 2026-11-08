import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { getPortalHelp, getPortalHome } from '@/server/portal/queries'
import { PortalFrame } from '@/ui/portal/frame'
import { pageOrg, pageSession, portalNav, Unavailable } from '../_lib/page'

// /portal/[org]/help (S7-08): how the portal works and whom to ask
export default async function PortalHelpPage({ params }: { params: Promise<{ org: string }> }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const [t, home, help] = await Promise.all([getTranslations('portal'), getPortalHome(session.state.ctx), getPortalHelp(session.state.ctx)])
  return (
    <PortalFrame organization={org.nameTh} title={t('help.title')} nav={portalNav(org.code, t, 'help', home.supplier ? 'SUPPLIER' : 'APPLICATION', session.invoices)} navLabel={t('nav.label')}>
      <section aria-labelledby="how" className="flex flex-col gap-2">
        <h2 id="how" className="text-lg font-semibold">
          {t('help.howTitle')}
        </h2>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {(['signIn', 'fill', 'documents', 'code'] as const).map((k) => (
            <li key={k}>{t(`help.how.${k}`, { organization: org.nameTh })}</li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="ask" className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 id="ask" className="text-lg font-semibold">
          {t('help.contactTitle')}
        </h2>
        <p>{help.inviter ? t('help.inviter', { name: help.inviter.name, email: help.inviter.email }) : t('help.contactGeneral', { organization: org.nameTh })}</p>
      </section>
      <section aria-labelledby="privacy" className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 id="privacy" className="text-lg font-semibold">
          {t('privacy.title')}
        </h2>
        <p className="whitespace-pre-line">{t(`privacy.${PORTAL_PRIVACY_NOTICE_VERSION}`)}</p>
      </section>
    </PortalFrame>
  )
}
