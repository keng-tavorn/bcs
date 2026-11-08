import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { portalRfx } from '@/server/portal/queries-rfx'
import { isUuid } from '@/server/queries/requests'
import { PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { pageOrg, pageSession, Unavailable } from '../../../_lib/page'
import { contactLocale } from '../../_lib/words'

// /portal/[org]/rfx/[id]/result (S10-07 · FR-SRC-204 · BR-RFX-12): the contact's own result — the lines an approved award
// gives its supplier with the price awarded before VAT (the purchase order comes on its own · S10-11), or a thank-you
// when it won none; never another supplier's name, price or rank. Before the result: open, or closed and under
// evaluation; an RFI concluded, an RFx cancelled, a declined invite or no bid say so.

export default async function PortalRfxResultPage({ params }: { params: Promise<{ org: string; id: string }> }) {
  const { org: orgCode, id } = await params
  const org = await pageOrg(orgCode)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  if (!isUuid(id)) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const locale = contactLocale(session.state.contact)
  const [t, rfx] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), portalRfx(session.state.ctx, id)])
  if (!rfx) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const en = locale === 'en'
  const number = rfx.number ?? t('rfx.list.noNumber')
  const total = rfx.awardedLines.reduce((sum, l) => sum + amountToSatang(l.lineNet), 0n)
  const s = rfx.portalStatus
  const message =
    s === 'AWARDED'
      ? t('rfx.result.awarded')
      : s === 'NOT_AWARDED'
        ? t('rfx.result.notAwarded')
        : s === 'CANCELLED'
          ? t('rfx.result.cancelled')
          : s === 'DECLINED'
            ? t('rfx.result.declined')
            : rfx.status === 'CONCLUDED'
              ? t('rfx.result.concluded')
              : s === 'CLOSED'
                ? // a bid sent (or set aside after the close) waits for the result; no bid, nothing to wait for
                  (rfx.bid?.status === 'SUBMITTED' || rfx.bid?.status === 'DISQUALIFIED') && rfx.status !== 'AWARDED'
                  ? t('rfx.result.waiting')
                  : t('rfx.result.noBid')
                : t('rfx.result.open')
  return (
    <PortalFrame organization={org.nameTh} title={t('rfx.result.title', { number })}>
      <p>{en && rfx.titleEn ? rfx.titleEn : rfx.title}</p>
      <PortalNotice tone={s === 'AWARDED' ? 'success' : 'info'}>{message}</PortalNotice>
      {rfx.awardedLines.length ? (
        <>
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {rfx.awardedLines.map((l) => (
              <li key={l.lineNo} className="flex flex-col gap-1 py-3">
                <span className="font-medium">{t('rfx.result.line', { lineNo: l.lineNo, description: en && l.descriptionEn ? l.descriptionEn : l.description })}</span>
                <span className="tabular">
                  {t('rfx.result.lineAmount', { quantity: l.quantity, uom: en && l.uomEn ? l.uomEn : l.uom, price: formatSatang(amountToSatang(l.unitPrice)), amount: formatSatang(amountToSatang(l.lineNet)) })}
                </span>
              </li>
            ))}
          </ul>
          <p className="tabular font-semibold">{t('rfx.result.total', { amount: formatSatang(total) })}</p>
        </>
      ) : null}
      <a href={`/portal/${org.code}/rfx/${rfx.id}`} className="text-primary underline underline-offset-4">
        {t('rfx.bid.backToRfx')}
      </a>
    </PortalFrame>
  )
}
