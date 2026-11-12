import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { listPortalRfx } from '@/server/portal/queries-rfx'
import { PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../_lib/page'
import { contactLocale, dateTimeOf, rfxKindOf, textIn } from './_lib/words'

// /portal/[org]/rfx (S10-07 · FR-SRC-202 AC1 · INV-RFX-01): the RFx the contact's supplier or application is invited to —
// kind, title, close and the contact's own state (not bid, draft, sent, to confirm again, declined, closed, awarded or
// not), those waiting for a bid first. In the contact's language (SupplierContact.locale). Reads through portalWhere only.

export default async function PortalRfxListPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const locale = contactLocale(session.state.contact)
  const [t, q, rows] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), searchParams, listPortalRfx(session.state.ctx)])
  return (
    <PortalFrame organization={org.nameTh} title={t('rfx.list.title')}>
      {/* a route that could not find the RFx it was sent (not invited, or not an id) comes back here */}
      {one(q.error) ? <PortalNotice tone="danger">{one(q.error) === 'NOT_FOUND' ? t('rfx.errors.NOT_FOUND') : t('rfx.errors.FAILED')}</PortalNotice> : null}
      {rows.length ? (
        <>
          <p className="text-ink-muted">{t('rfx.list.intro')}</p>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {rows.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 py-3">
                <a href={`/portal/${org.code}/rfx/${r.id}`} className="font-medium text-primary underline underline-offset-4">
                  {r.number ?? t('rfx.list.noNumber')} {textIn(locale, r.title, r.titleEn)}
                </a>
                <span>{t('rfx.detail.kindAndStatus', { kind: t(`rfx.kind.${rfxKindOf(r.kind)}`), status: t(`rfx.status.${r.portalStatus}`) })}</span>
                {r.closesAt ? <span className="tabular text-ink-muted">{t('rfx.list.closesAt', { date: dateTimeOf(locale, r.closesAt) })}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-ink-muted">{t('rfx.list.empty')}</p>
      )}
      <a href={`/portal/${org.code}`} className="text-primary underline underline-offset-4">
        {t('rfx.list.back')}
      </a>
    </PortalFrame>
  )
}
