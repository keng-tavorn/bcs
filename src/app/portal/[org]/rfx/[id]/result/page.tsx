import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { amountToSatang } from '@/core/money/dto'
import { formatSatang } from '@/core/money/format'
import { portalRfx } from '@/server/portal/queries-rfx'
import { isUuid } from '@/server/queries/requests'
import { PortalButton, PortalFrame, PortalNotice, portalInputClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../../../_lib/page'
import { contactLocale, rfxErrorText } from '../../_lib/words'

// /portal/[org]/rfx/[id]/result (S10-07 · FR-SRC-204 · BR-RFX-12): the contact's own result — the lines an approved award
// gives its supplier with the price awarded before VAT (the purchase order comes on its own · S10-11), or a thank-you
// when it won none; never another supplier's name, price or rank. Before the result: open, or closed and under
// evaluation; an RFI concluded, an RFx cancelled, a declined invite or no bid say so. S10-11 (OQ-212 · GC-SRC-41): a
// winner who bid with VAT included gives each line it won its unit price before VAT here — at most its price bid less
// that price's VAT, shown per line — and may give them again until procurement makes the purchase order.

export default async function PortalRfxResultPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: orgCode, id } = await params
  const org = await pageOrg(orgCode)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  if (!isUuid(id)) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const locale = contactLocale(session.state.contact)
  const [t, q, rfx] = await Promise.all([getTranslations({ locale, namespace: 'portal' }), searchParams, portalRfx(session.state.ctx, id)])
  if (!rfx) redirect(`/portal/${org.code}/rfx?error=NOT_FOUND`)
  const en = locale === 'en'
  const number = rfx.number ?? t('rfx.list.noNumber')
  const total = rfx.awardedLines.reduce((sum, l) => sum + amountToSatang(l.lineNet), 0n)
  const s = rfx.portalStatus
  const error = one(q.error)
  const confirm = rfx.priceConfirm
  const lineOf = new Map(rfx.lines.map((l) => [l.id, l]))
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
      {one(q.confirmed) ? <PortalNotice tone="success">{t('rfx.result.confirmDone')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{rfxErrorText(t, error, one(q.reason), one(q.lines))}</PortalNotice> : null}
      {confirm ? (
        <section aria-labelledby="confirm-title" className="flex flex-col gap-3">
          <h2 id="confirm-title" className="text-lg font-semibold">
            {t('rfx.result.confirmTitle')}
          </h2>
          <p>{t('rfx.result.confirmIntro', { rate: (confirm.vatRateBp / 100).toFixed(2) })}</p>
          {confirm.confirmedAt ? <p className="text-ink-muted">{t('rfx.result.confirmAgain')}</p> : null}
          <form method="post" action={`/portal/${org.code}/api/rfx/respond`} className="flex flex-col gap-4">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="rfxEventId" value={rfx.id} />
            <input type="hidden" name="action" value="confirm" />
            <input type="hidden" name="key" value={randomUUID()} />
            {confirm.lines.map((l) => {
              const line = lineOf.get(l.rfxLineId)
              const inputId = `net-${l.lineNo}`
              return (
                <div key={l.rfxLineId} className="flex flex-col gap-1">
                  <label htmlFor={inputId} className="font-medium">
                    {t('rfx.result.line', { lineNo: l.lineNo, description: line ? (en && line.descriptionEn ? line.descriptionEn : line.description) : '' })}
                  </label>
                  <p id={`${inputId}-hint`} className="tabular text-sm text-ink-muted">
                    {t('rfx.result.confirmLineHint', { quoted: formatSatang(amountToSatang(l.quotedUnitPrice)), max: formatSatang(amountToSatang(l.maxNetUnitPrice)) })}
                  </p>
                  <input id={inputId} name={`net:${l.rfxLineId}`} required inputMode="decimal" defaultValue={l.confirmedNetUnitPrice ?? l.maxNetUnitPrice} aria-describedby={`${inputId}-hint`} className={portalInputClass} />
                </div>
              )
            })}
            <PortalButton type="submit">{t('rfx.result.confirmSend')}</PortalButton>
          </form>
        </section>
      ) : null}
      <a href={`/portal/${org.code}/rfx/${rfx.id}`} className="text-primary underline underline-offset-4">
        {t('rfx.bid.backToRfx')}
      </a>
    </PortalFrame>
  )
}
