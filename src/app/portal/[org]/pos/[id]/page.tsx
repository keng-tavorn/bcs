import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { getPortalHome, getPortalPo } from '@/server/portal/queries'
import { PortalButton, PortalField, PortalFrame, PortalNotice, portalInputClass, portalTextareaClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../../_lib/page'

// /portal/[org]/pos/[id] (S7-11 · FR-SUP-105 AC1 AC2 AC3 · BR-SUP ข้อ 14): one PO of the contact's supplier — its lines and
// totals, its PDF (a POST answers an address of five minutes), "รับทราบ" with the date it delivers once per revision, then
// "เปลี่ยนวันส่ง" with the reason; a PO RECEIVED or CLOSED shows no button. The PO itself never changes here.

const ACK = ['NOT_ACKNOWLEDGED', 'ACKNOWLEDGED', 'DELIVERY_UPDATED'] as const
const STATUS = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const
const ERRORS = ['PAST_DATE', 'NO_CHANGE', 'INVALID_STATE_TRANSITION', 'VALIDATION_FAILED'] as const

export default async function PortalPoPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: code, id } = await params
  const org = await pageOrg(code)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home, po, q] = await Promise.all([getTranslations('portal'), getPortalHome(ctx), getPortalPo(ctx, id), searchParams])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const nav = portalNav(org.code, t, 'pos', 'SUPPLIER')
  const back = (
    <a href={`/portal/${org.code}/pos`} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 hover:no-underline">
      {t('pos.back')}
    </a>
  )
  if (!po) {
    return (
      <PortalFrame organization={org.nameTh} title={t('pos.notFound')} nav={nav} navLabel={t('nav.label')}>
        {back}
      </PortalFrame>
    )
  }
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  const open = po.status === 'SENT' || po.status === 'PARTIALLY_RECEIVED'
  const baht = (s: string) => formatSatang(BigInt(s))
  const hidden = (
    <>
      <input type="hidden" name="csrf" value={session.csrf} />
      <input type="hidden" name="key" value={randomUUID()} />
    </>
  )
  return (
    <PortalFrame organization={org.nameTh} title={po.number ?? t('pos.noNumber')} nav={nav} navLabel={t('nav.label')}>
      {one(q.done) === 'ack' ? <PortalNotice tone="success">{t('pos.acked')}</PortalNotice> : one(q.done) === 'delivery' ? <PortalNotice tone="success">{t('pos.changed')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{known ? t(`pos.errors.${known}`) : t('pos.errors.FAILED')}</PortalNotice> : null}
      <p>
        {(STATUS as readonly string[]).includes(po.status) ? t(`pos.status.${po.status as (typeof STATUS)[number]}`) : po.status} · {(ACK as readonly string[]).includes(po.ackStatus) ? t(`pos.ack.${po.ackStatus as (typeof ACK)[number]}`) : po.ackStatus}
        {po.revisionNo > 0 ? ` · ${t('pos.revision', { n: po.revisionNo })}` : ''}
        {po.promisedDeliveryOn ? ` · ${t('pos.promised', { date: formatThaiDate(po.promisedDeliveryOn) })}` : ''}
      </p>
      <section aria-labelledby="lines" className="flex flex-col gap-2">
        <h2 id="lines" className="text-lg font-semibold">
          {t('pos.lines')}
        </h2>
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {po.lines.map((l) => (
            <li key={l.lineNo} className="flex flex-col gap-0.5 py-2">
              <span className="font-medium">{l.description}</span>
              <span className="tabular text-ink-muted">{t('pos.line', { qty: l.quantity.replace(/\.?0+$/, ''), uom: l.uom, price: baht(l.unitPriceSatang), net: baht(l.netSatang) })}</span>
            </li>
          ))}
        </ul>
        <p className="tabular">{t('pos.net', { amount: baht(po.netSatang) })}</p>
        <p className="tabular">{t('pos.vat', { amount: baht(po.vatSatang) })}</p>
        <p className="tabular font-semibold">{t('pos.gross', { amount: baht(po.grossSatang) })}</p>
      </section>
      {po.hasPdf ? (
        <form method="post" action={`/portal/${org.code}/api/pos/${po.id}/pdf`}>
          {hidden}
          <PortalButton type="submit" variant="secondary" className="w-full">
            {t('pos.pdf')}
          </PortalButton>
        </form>
      ) : null}
      {!open ? (
        <p className="text-ink-muted">{t('pos.closed')}</p>
      ) : po.ackStatus === 'NOT_ACKNOWLEDGED' ? (
        <section aria-labelledby="ack" className="flex flex-col gap-3 border-t border-line pt-4">
          <h2 id="ack" className="text-lg font-semibold">
            {t('pos.ackTitle')}
          </h2>
          <p className="text-ink-muted">{t('pos.ackIntro')}</p>
          <form method="post" action={`/portal/${org.code}/api/pos/${po.id}/acknowledge`} className="flex flex-col gap-4">
            {hidden}
            <PortalField id="promisedDeliveryOn" label={t('pos.date')}>
              <input id="promisedDeliveryOn" name="promisedDeliveryOn" type="date" className={portalInputClass} />
            </PortalField>
            <PortalField id="note" label={t('pos.note')}>
              <textarea id="note" name="note" maxLength={500} className={portalTextareaClass} />
            </PortalField>
            <PortalButton type="submit">{t('pos.ackSubmit')}</PortalButton>
          </form>
        </section>
      ) : (
        <section aria-labelledby="change" className="flex flex-col gap-3 border-t border-line pt-4">
          <h2 id="change" className="text-lg font-semibold">
            {t('pos.changeTitle')}
          </h2>
          <form method="post" action={`/portal/${org.code}/api/pos/${po.id}/delivery`} className="flex flex-col gap-4">
            {hidden}
            <PortalField id="newDate" label={t('pos.date')}>
              <input id="newDate" name="promisedDeliveryOn" type="date" required className={portalInputClass} />
            </PortalField>
            <PortalField id="reason" label={t('pos.reason')}>
              <textarea id="reason" name="reason" required minLength={3} maxLength={500} className={portalTextareaClass} />
            </PortalField>
            <PortalButton type="submit">{t('pos.changeSubmit')}</PortalButton>
          </form>
        </section>
      )}
      {po.acks.length ? (
        <section aria-labelledby="history" className="flex flex-col gap-2 border-t border-line pt-4">
          <h2 id="history" className="text-lg font-semibold">
            {t('pos.history')}
          </h2>
          <ul className="flex flex-col gap-1">
            {po.acks.map((a, i) => (
              <li key={i}>
                {a.kind === 'ACK'
                  ? t('pos.historyAck', { at: formatThaiDateTime(a.at) })
                  : t('pos.historyChange', { at: formatThaiDateTime(a.at), from: a.previousPromisedOn ? formatThaiDate(a.previousPromisedOn) : '-', to: a.promisedDeliveryOn ? formatThaiDate(a.promisedDeliveryOn) : '-' })}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {back}
    </PortalFrame>
  )
}
