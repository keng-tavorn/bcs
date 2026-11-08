import { randomUUID } from 'node:crypto'
import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatThaiDate, formatThaiDateTime } from '@/core/thai'
import { getPortalHome } from '@/server/portal/queries'
import { getPortalInvoice } from '@/server/portal/queries-invoices'
import { PortalButton, PortalField, PortalFrame, PortalNotice, portalCheckboxClass, portalInputClass } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, portalNav, Unavailable, type SearchParams } from '../../_lib/page'
import { invoiceStageText } from '../stage'

// /portal/[org]/invoices/[id] (S7-12 · FR-AP-101 AC7 · FR-AP-103 AC5 · BR-SUP ข้อ 15): one invoice of the supplier — where it
// stands (sent → received with BCS's number → ready with its due date or paid · rejected with the reason), its file
// (being checked for safety until scanned), its lines and totals. A draft from the portal whose coding finance has not
// confirmed can still be changed here: header and lines (a line left empty is not on the invoice).

const ERRORS = ['INVOICE_NO', 'INVOICE_DATE', 'AMOUNT', 'LINE', 'NO_LINES', 'CODING_CONFIRMED', 'CONFLICT_VERSION', 'INVALID_STATE_TRANSITION', 'DISCOUNT_ABOVE_AMOUNT', 'NOT_A_PO_LINE', 'QUANTITY_NOT_POSITIVE', 'VALIDATION_FAILED'] as const

const plainQty = (q: string) => q.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
const plainAmount = (s: string) => {
  const v = BigInt(s)
  return `${v / 100n}.${String(v % 100n).padStart(2, '0')}`
}

export default async function PortalInvoicePage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: code, id } = await params
  const org = await pageOrg(code)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const { ctx } = session.state
  const [t, home, inv, q] = await Promise.all([getTranslations('portal'), getPortalHome(ctx), getPortalInvoice(ctx, id), searchParams])
  if (home.privacyNoticeDue) redirect(`/portal/${org.code}`)
  if (!home.supplier) redirect(`/portal/${org.code}/apply`)
  const nav = portalNav(org.code, t, 'invoices', 'SUPPLIER', session.invoices)
  const back = (
    <a href={`/portal/${org.code}/invoices`} className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 hover:no-underline">
      {t('invoices.back')}
    </a>
  )
  if (!inv) {
    return (
      <PortalFrame organization={org.nameTh} title={t('invoices.notFound')} nav={nav} navLabel={t('nav.label')}>
        {back}
      </PortalFrame>
    )
  }
  const error = one(q.error)
  const known = error && (ERRORS as readonly string[]).includes(error) ? (error as (typeof ERRORS)[number]) : null
  const done = one(q.done)
  const baht = (s: string) => formatSatang(BigInt(s))
  const onInvoice = new Map(inv.lines.filter((l) => l.poLineId).map((l) => [l.poLineId!, l]))
  return (
    <PortalFrame organization={org.nameTh} title={inv.supplierInvoiceNo ?? t('invoices.noNumber')} nav={nav} navLabel={t('nav.label')}>
      {done === 'sent' ? <PortalNotice tone="success">{t('invoices.sent')}</PortalNotice> : done === 'saved' ? <PortalNotice tone="success">{t('invoices.saved')}</PortalNotice> : null}
      {error ? <PortalNotice tone="danger">{known ? t(`invoices.errors.${known}`) : t('invoices.errors.FAILED')}</PortalNotice> : null}
      <section aria-labelledby="stage" className="flex flex-col gap-1">
        <h2 id="stage" className="text-lg font-semibold">
          {invoiceStageText(t, inv)}
        </h2>
        <ol className="flex flex-col gap-1 text-ink-muted">
          <li>{t('invoices.timeline.sent', { at: formatThaiDateTime(inv.timeline.sentAt) })}</li>
          {inv.number && inv.timeline.receivedAt ? <li>{t('invoices.timeline.received', { at: formatThaiDateTime(inv.timeline.receivedAt), number: inv.number })}</li> : null}
          {inv.timeline.readyAt ? <li>{t('invoices.timeline.ready', { at: formatThaiDateTime(inv.timeline.readyAt) })}</li> : null}
          {inv.paidOn ? <li>{t('invoices.timeline.paid', { date: formatThaiDate(inv.paidOn) })}</li> : null}
          {inv.timeline.rejectedAt ? <li>{t('invoices.timeline.rejected', { at: formatThaiDateTime(inv.timeline.rejectedAt) })}</li> : null}
        </ol>
      </section>
      <p className="tabular">{t('invoices.detail', { po: inv.poNumber ?? '-', date: inv.invoiceDate ? formatThaiDate(inv.invoiceDate) : '-' })}</p>
      {inv.file ? <p className="text-ink-muted">{inv.file.scanned ? t('invoices.fileScanned', { name: inv.file.fileName }) : t('invoices.fileScanning', { name: inv.file.fileName })}</p> : null}
      <section aria-labelledby="lines" className="flex flex-col gap-2">
        <h2 id="lines" className="text-lg font-semibold">
          {t('invoices.lines')}
        </h2>
        {inv.lines.length ? (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {inv.lines.map((l, i) => (
              <li key={i} className="flex flex-col gap-0.5 py-2">
                <span className="font-medium">{l.description}</span>
                <span className="tabular text-ink-muted">{t('invoices.line', { qty: plainQty(l.quantity), uom: l.uom, price: baht(l.unitPriceSatang), net: baht(l.netSatang) })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-ink-muted">{t('invoices.noLines')}</p>
        )}
        <p className="tabular">{t('invoices.net', { amount: baht(inv.netSatang) })}</p>
        <p className="tabular">{t('invoices.vatAmount', { amount: baht(inv.vatSatang) })}</p>
        <p className="tabular font-semibold">{t('invoices.gross', { amount: baht(inv.grossSatang) })}</p>
      </section>
      {inv.editable ? (
        <section aria-labelledby="edit" className="flex flex-col gap-3 border-t border-line pt-4">
          <h2 id="edit" className="text-lg font-semibold">
            {t('invoices.editTitle')}
          </h2>
          <p className="text-ink-muted">{t('invoices.editIntro')}</p>
          <form method="post" action={`/portal/${org.code}/api/invoices/${inv.id}`} className="flex flex-col gap-4">
            <input type="hidden" name="csrf" value={session.csrf} />
            <input type="hidden" name="key" value={randomUUID()} />
            <input type="hidden" name="version" value={inv.version} />
            <PortalField id="supplierInvoiceNo" label={t('invoices.supplierNo')}>
              <input id="supplierInvoiceNo" name="supplierInvoiceNo" required maxLength={60} defaultValue={inv.supplierInvoiceNo ?? ''} className={portalInputClass} />
            </PortalField>
            <PortalField id="invoiceDate" label={t('invoices.date')}>
              <input id="invoiceDate" name="invoiceDate" type="date" required defaultValue={inv.invoiceDate ?? ''} className={portalInputClass} />
            </PortalField>
            <PortalField id="statedVat" label={t('invoices.vat')} hint={t('invoices.vatHint')}>
              <input id="statedVat" name="statedVat" inputMode="decimal" required defaultValue={plainAmount(inv.vatSatang)} className={portalInputClass} />
            </PortalField>
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" name="priceIncludesVat" defaultChecked={inv.priceIncludesVat} className={portalCheckboxClass} />
              <span>{t('invoices.includesVat')}</span>
            </label>
            <fieldset className="flex flex-col gap-3">
              <legend className="font-medium">{t('invoices.editLines')}</legend>
              {inv.poLines.map((p) => {
                const on = onInvoice.get(p.id)
                return (
                  <div key={p.id} className="flex flex-col gap-2 border-b border-line pb-3">
                    <span className="font-medium">{t('invoices.poLine', { no: p.lineNo, description: p.description, qty: plainQty(p.quantity), uom: p.uom })}</span>
                    <div className="grid grid-cols-2 gap-3">
                      <PortalField id={`q-${p.id}`} label={t('invoices.qty')}>
                        <input id={`q-${p.id}`} name={`line.${p.id}.qty`} inputMode="decimal" defaultValue={on ? plainQty(on.quantity) : ''} className={portalInputClass} />
                      </PortalField>
                      <PortalField id={`p-${p.id}`} label={t('invoices.unitPrice')}>
                        <input id={`p-${p.id}`} name={`line.${p.id}.price`} inputMode="decimal" defaultValue={plainAmount(on ? on.unitPriceSatang : p.unitPriceSatang)} className={portalInputClass} />
                      </PortalField>
                    </div>
                  </div>
                )
              })}
            </fieldset>
            <PortalButton type="submit">{t('invoices.save')}</PortalButton>
          </form>
        </section>
      ) : inv.stage === 'DRAFT' && inv.fromPortal ? (
        <p className="text-ink-muted">{t('invoices.locked')}</p>
      ) : null}
      {back}
    </PortalFrame>
  )
}
