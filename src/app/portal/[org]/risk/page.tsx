import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { listPortalRiskAssessments } from '@/server/portal/queries-risk'
import { PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../_lib/page'

// /portal/[org]/risk (S11-05 · BR-RSK-17 · FR-RSK-201 AC5): the supplier's own risk assessments, open ones first — the
// number, the status in words, the tier and the date it is valid until once completed (never the points or a reviewer's
// reasons · OQ-230) — each a link to its page. Reads through portalWhere only (INV-RSK-05).

const STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'] as const
const TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const
const ANSWERABLE = new Set(['DRAFT', 'RETURNED'])

export default async function PortalRiskPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: SearchParams }) {
  const org = await pageOrg((await params).org)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const [t, locale, q, rows] = await Promise.all([getTranslations('portal'), getLocale(), searchParams, listPortalRiskAssessments(session.state.ctx)])
  const en = locale === 'en'
  // a calendar day stored at UTC midnight reads as the same day in Bangkok
  const day = (d: Date) => (en ? formatEnglishBeDate(d) : formatThaiDate(d))
  return (
    <PortalFrame organization={org.nameTh} title={t('risk.list.title')}>
      {/* a route that could not find the assessment it was sent (an id that is not the supplier's) comes back here */}
      {one(q.error) ? <PortalNotice tone="danger">{one(q.error) === 'NOT_FOUND' ? t('risk.errors.NOT_FOUND') : t('risk.errors.FAILED')}</PortalNotice> : null}
      {rows.length ? (
        <>
          <p className="text-ink-muted">{t('risk.list.intro')}</p>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {rows.map((r) => {
              const number = r.number ?? t('risk.list.noNumber')
              const status = (STATUSES as readonly string[]).includes(r.status) ? t(`risk.status.${r.status as (typeof STATUSES)[number]}`) : r.status
              const tier = r.tier && (TIERS as readonly string[]).includes(r.tier) ? t(`risk.tier.${r.tier as (typeof TIERS)[number]}`) : null
              return (
                <li key={r.id} className="flex flex-col gap-1 py-3">
                  <a href={`/portal/${org.code}/risk/${r.id}`} className="font-medium text-primary underline underline-offset-4">
                    {ANSWERABLE.has(r.status) ? t('risk.list.answer', { number }) : t('risk.list.view', { number })}
                  </a>
                  <span>{t('risk.list.status', { status })}</span>
                  {tier ? <span>{t('risk.list.tier', { tier })}</span> : null}
                  {r.validUntil ? <span className="tabular text-ink-muted">{t('risk.list.validUntil', { date: day(r.validUntil) })}</span> : null}
                  <span className="tabular text-ink-muted">{t('risk.list.openedAt', { date: en ? formatEnglishBeDate(r.openedAt) : formatThaiDate(r.openedAt) })}</span>
                </li>
              )
            })}
          </ul>
        </>
      ) : (
        <p className="text-ink-muted">{t('risk.list.empty')}</p>
      )}
      <a href={`/portal/${org.code}`} className="text-primary underline underline-offset-4">
        {t('risk.list.back')}
      </a>
    </PortalFrame>
  )
}
