import { getTranslations } from 'next-intl/server'
import { PORTAL_PRIVACY_NOTICE_VERSION } from '@/lib/portal-limits'
import { PortalButton, PortalFrame, PortalNotice, portalInputClass } from '@/ui/portal/frame'
import { ErrorNotice, one, pageOrg, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/login (BR-PORTAL ข้อ 01): an e-mail asks for a sign-in link; the page says the same thing whether or not
// the address is on record. The privacy notice is there to read before anything is sent (BR-PORTAL ข้อ 08 · S7-08).

export default async function PortalLoginPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const [t, q] = await Promise.all([getTranslations('portal'), searchParams])
  return (
    <PortalFrame organization={org.nameTh} title={t('login.title')}>
      <p className="text-ink-muted">{t('login.intro')}</p>
      {one(q.sent) ? <PortalNotice tone="success">{t('login.sent')}</PortalNotice> : null}
      {one(q.closed) ? <PortalNotice tone="info">{t('login.closed')}</PortalNotice> : null}
      <ErrorNotice code={one(q.error)} />
      <form method="post" action={`/portal/${org.code}/api/login-link`} className="flex flex-col gap-3">
        <label htmlFor="email" className="font-medium">
          {t('login.email')}
        </label>
        <input id="email" name="email" type="email" required autoComplete="email" inputMode="email" className={portalInputClass} />
        <PortalButton type="submit">{t('login.submit')}</PortalButton>
      </form>
      {/* BR-PORTAL ข้อ 08: what is kept and why, before anything is sent */}
      <section aria-labelledby="privacy" className="flex flex-col gap-2 border-t border-line pt-4">
        <h2 id="privacy" className="font-medium">
          {t('privacy.title')}
        </h2>
        <p className="text-ink-muted">{t('privacy.short', { organization: org.nameTh })}</p>
        <details>
          <summary className="inline-flex min-h-11 cursor-pointer items-center text-primary underline underline-offset-4">{t('privacy.read')}</summary>
          <p className="whitespace-pre-line pt-2">{t(`privacy.${PORTAL_PRIVACY_NOTICE_VERSION}`)}</p>
        </details>
      </section>
    </PortalFrame>
  )
}
