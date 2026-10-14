import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { formatSatang } from '@/core/money/format'
import { ListEmpty } from '../../page/page'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../shadcn/table'
import { VarianceButton } from './exception-actions'
import type { ApOutcome } from './outcome'
import type { VarianceRowData } from './types'

// PROCUREMENT's list of invoices the match did not pass because of them (S8-13 /procurement/invoice-exceptions,
// BR-MATCH-09, FR-AP-103 AC1, FR-AP-105 AC2): each invoice in EXCEPTION with an open price over the PO's or a quantity
// over what was ordered, how much is over, its PO and supplier, and "ขออนุมัติส่วนต่าง" (a Dialog asking for the
// reason) when every open difference is a price over — anything else is fixed at its cause or the invoice rejected
// (BR-MATCH-10). A table from a tablet up and a list on a phone (§9.9). The service checks everything again.

const linkClass = 'inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline'

export async function VarianceList({ rows, request }: { rows: readonly VarianceRowData[]; request: (input: unknown, idempotencyKey: string) => Promise<ApOutcome> }) {
  const [t, rawLocale] = await Promise.all([getTranslations('apInvoice'), getLocale()])
  const en = rawLocale === 'en'
  if (rows.length === 0) {
    return (
      <ListEmpty
        title={t('exceptionsPage.empty')}
        hint={t('exceptionsPage.emptyHint')}
        actions={
          <Link href="/" className={linkClass}>
            {t('exceptionsPage.home')}
          </Link>
        }
      />
    )
  }
  const typeText = (type: string) => (t.has(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') ? t(`exceptions.type.${type}` as 'exceptions.type.PRICE_OVER') : type)
  const view = rows.map((r) => {
    const label = r.number ?? r.supplierInvoiceNo ?? r.invoiceId
    return {
      ...r,
      label,
      supplierName: `${en && r.supplier.nameEn ? r.supplier.nameEn : r.supplier.nameTh} (${r.supplier.code})`,
      over: formatSatang(r.overSatang),
      differences: r.types.map(typeText).join(', '),
      action: r.canRequest ? <VarianceButton invoiceId={r.invoiceId} version={r.version} request={request} /> : <span className="text-ink-muted">{t('exceptionsPage.fixAtCause')}</span>,
    }
  })
  const invoiceLink = (r: (typeof view)[number]) => (
    <Link href={`/finance/invoices/${r.invoiceId}`} className={linkClass} aria-label={t('exceptionsPage.open', { number: r.label })}>
      {r.label}
    </Link>
  )
  const poLink = (r: (typeof view)[number]) => (
    <Link href={`/procurement/pos/${r.po.id}`} className={linkClass}>
      {r.po.number ?? '-'}
    </Link>
  )

  return (
    <>
      <div className="hidden md:block">
        <Table aria-label={t('exceptionsPage.listTitle')}>
          <TableHeader>
            <TableRow>
              <TableHead>{t('exceptionsPage.columns.invoice')}</TableHead>
              <TableHead>{t('exceptionsPage.columns.po')}</TableHead>
              <TableHead>{t('exceptionsPage.columns.supplier')}</TableHead>
              <TableHead>{t('exceptionsPage.columns.differences')}</TableHead>
              <TableHead className="text-right">{t('exceptionsPage.columns.over')}</TableHead>
              <TableHead>{t('exceptionsPage.columns.action')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.map((r) => (
              <TableRow key={r.invoiceId}>
                <TableCell>
                  {invoiceLink(r)}
                  {r.number && r.supplierInvoiceNo ? <span className="block text-ink-muted">{t('exceptionsPage.supplierInvoiceNo', { no: r.supplierInvoiceNo })}</span> : null}
                </TableCell>
                <TableCell>{poLink(r)}</TableCell>
                <TableCell className="whitespace-normal">{r.supplierName}</TableCell>
                <TableCell className="whitespace-normal">{r.differences}</TableCell>
                <TableCell className="money text-right">{r.over}</TableCell>
                <TableCell className="whitespace-normal">{r.action}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul aria-label={t('exceptionsPage.listTitle')} className="flex flex-col divide-y divide-line border-y border-line md:hidden">
        {view.map((r) => (
          <li key={r.invoiceId} className="flex flex-col gap-1 py-3">
            {invoiceLink(r)}
            <span className="break-words text-ink">{r.supplierName}</span>
            <span className="text-ink-muted">
              {t('exceptionsPage.columns.po')} {poLink(r)}
            </span>
            <span className="text-ink">{r.differences}</span>
            <span className="money font-medium text-ink">{t('exceptionsPage.over', { amount: r.over })}</span>
            <div className="pt-1">{r.action}</div>
          </li>
        ))}
      </ul>
    </>
  )
}
