import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai'
import { StatusBadge } from '../document/badges'
import { formatDateTime } from '../format'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../shadcn/table'
import { AP_INVOICE_BADGES, PO_CHANGE_BADGES } from './looks'
import type { PoS8Outcome } from './outcome'
import { SendRevision } from './send-revision'
import { nameOf, type ApInvoiceRowView, type PoChangeView } from './types'

// The tabs S8 adds to a purchase order (S8-13, BR-AP-13, BR-POC-05): its tier-2 invoices with their status and what is
// payable, each opening its invoice page; and its changes, each with what it did to every line and to the PO's total,
// who proposed it and when. A table on wider screens, a list on a phone (§9.9: no table that scrolls the page sideways).
// Status in a badge with an icon and a word (§9.10).

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

type PoChangeT = Awaited<ReturnType<typeof getTranslations<'poChange'>>>

/** The tier-2 invoices of the PO (module PAY) */
export async function PoInvoicesTab({ invoices }: { invoices: readonly ApInvoiceRowView[] }) {
  const t = await getTranslations('poChange')
  if (invoices.length === 0) return <p className="text-ink-muted">{t('invoices.none')}</p>
  const numberOf = (inv: ApInvoiceRowView) => inv.number ?? t('invoices.draft')
  const badge = (inv: ApInvoiceRowView) => <StatusBadge look={AP_INVOICE_BADGES[inv.status]} label={t(`invoiceStatus.${inv.status}` as 'invoiceStatus.DRAFT')} />
  const link = (inv: ApInvoiceRowView) => (
    <Link href={`/finance/invoices/${inv.id}`} className={linkClass} aria-label={t('invoices.open', { number: numberOf(inv) })}>
      {numberOf(inv)}
    </Link>
  )
  return (
    <>
      <Table aria-label={t('invoices.table')} className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>{t('invoices.number')}</TableHead>
            <TableHead>{t('invoices.supplierNo')}</TableHead>
            <TableHead>{t('invoices.status')}</TableHead>
            <TableHead className="text-right">{t('invoices.payable')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {invoices.map((inv) => (
            <TableRow key={inv.id}>
              <TableCell>{link(inv)}</TableCell>
              <TableCell>{inv.supplierInvoiceNo ?? '-'}</TableCell>
              <TableCell>{badge(inv)}</TableCell>
              <TableCell className="tabular text-right">{formatSatang(inv.payableSatang)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={t('invoices.table')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {invoices.map((inv) => (
          <li key={inv.id} className="flex flex-col gap-1 py-2.5">
            {link(inv)}
            <span className="text-ink">{t('invoices.row', { number: numberOf(inv), supplierNo: inv.supplierInvoiceNo ?? '-' })}</span>
            <span className="flex flex-wrap items-center gap-2">
              {badge(inv)}
              <span className="tabular text-ink">{t('invoices.payableValue', { amount: formatSatang(inv.payableSatang) })}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** What one change did, line by line, then to the PO's total and its date */
export function changeFacts(t: PoChangeT, locale: string, change: PoChangeView): string[] {
  const lines = change.lines.map((l) =>
    t('changes.line', {
      no: l.lineNo,
      description: l.description,
      uom: l.uom,
      oldQuantity: l.oldQuantity,
      newQuantity: l.newQuantity,
      oldPrice: formatSatang(l.oldUnitPriceSatang),
      newPrice: formatSatang(l.newUnitPriceSatang),
    }),
  )
  const out = change.autoApproved ? [t('changes.dateOnly')] : [...lines, t('changes.totals', { old: formatSatang(change.old.grossSatang), new: formatSatang(change.new.grossSatang) })]
  if (change.deliveryDate) out.push(t('changes.deliveryDate', { date: locale === 'en' ? formatEnglishBeDate(change.deliveryDate) : formatThaiDate(change.deliveryDate) }))
  if (change.appliedRevisionNo) out.push(t('changes.revision', { no: change.appliedRevisionNo }))
  if (change.sentAt) out.push(t('changes.sent', { time: formatDateTime(locale, change.sentAt) }))
  return out
}

/** The changes of the PO, latest first (BR-POC-05: the tab shows when the DOA has a PO_CHANGE rule or the PO has a change) */
export async function PoChangesTab({ changes, locale, canChange }: { changes: readonly PoChangeView[]; locale: string; canChange: boolean }) {
  const t = await getTranslations('poChange')
  if (changes.length === 0) return <p className="text-ink-muted">{canChange ? t('changes.noneCanChange') : t('changes.none')}</p>
  const badge = (c: PoChangeView) => <StatusBadge look={PO_CHANGE_BADGES[c.status]} label={t(`changeStatus.${c.status}` as 'changeStatus.DRAFT')} />
  const at = (c: PoChangeView) => formatDateTime(locale, c.submittedAt ?? c.createdAt)
  return (
    <div className="flex flex-col gap-4">
      <Table aria-label={t('changes.table')} className="hidden md:table">
        <TableHeader>
          <TableRow>
            <TableHead>{t('changes.no')}</TableHead>
            <TableHead>{t('changes.status')}</TableHead>
            <TableHead>{t('changes.what')}</TableHead>
            <TableHead>{t('changes.who')}</TableHead>
            <TableHead>{t('changes.when')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {changes.map((c) => (
            <TableRow key={c.id}>
              <TableCell className="tabular align-top">{c.changeNo}</TableCell>
              <TableCell className="align-top">{badge(c)}</TableCell>
              <TableCell className="align-top whitespace-normal">
                <ul className="flex flex-col gap-0.5">
                  {changeFacts(t, locale, c).map((f) => (
                    <li key={f} className="tabular text-ink">
                      {f}
                    </li>
                  ))}
                </ul>
                {c.reason ? <p className="break-words whitespace-pre-line text-ink-muted">{t('changes.reason', { reason: c.reason })}</p> : null}
              </TableCell>
              <TableCell className="align-top whitespace-normal">{nameOf(locale, c.createdBy.name)}</TableCell>
              <TableCell className="tabular align-top">{at(c)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul aria-label={t('changes.table')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-col gap-1 py-2.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{t('changes.changeNo', { no: c.changeNo })}</span>
              {badge(c)}
            </span>
            {changeFacts(t, locale, c).map((f) => (
              <span key={f} className="tabular break-words text-ink">
                {f}
              </span>
            ))}
            {c.reason ? <span className="break-words whitespace-pre-line text-ink-muted">{t('changes.reason', { reason: c.reason })}</span> : null}
            <span className="tabular text-ink-muted">{`${nameOf(locale, c.createdBy.name)} · ${at(c)}`}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Procurement's S8 actions beside a sent PO: "แก้ไข PO" when the DOA version in effect has a PO_CHANGE rule and the
 * member holds po.change (BR-POC-05: the DEMO organization never sees it), and "ส่งฉบับแก้ไขให้ผู้ขาย" while the revision
 * approved last is not sent yet (FR-AP-107 AC3)
 */
export async function PoChangeRail({
  poId,
  changeHref,
  revisionToSend,
  send,
}: {
  poId: string
  changeHref: string | null
  revisionToSend: { readonly revisionNo: number } | null
  send: (poId: string, idempotencyKey: string) => Promise<PoS8Outcome>
}) {
  if (!changeHref && !revisionToSend) return null
  const t = await getTranslations('poChange')
  return (
    <div className="flex flex-col gap-4">
      {changeHref ? (
        <div className="flex flex-col gap-1">
          <Link href={changeHref} className={linkClass}>
            {t('changes.changeButton')}
          </Link>
          <p className="text-base text-ink-muted md:text-sm">{t('changes.changeHint')}</p>
        </div>
      ) : null}
      {revisionToSend ? <SendRevision poId={poId} revisionNo={revisionToSend.revisionNo} send={send} /> : null}
    </div>
  )
}
