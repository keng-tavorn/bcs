import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listInvoiceWork } from '@/server/services/invoices/view'
import { InvoiceList, type InvoiceRowView } from '@/ui/finance/invoice-list'
import { WaitingList, type WaitingRowView } from '@/ui/finance/waiting-list'
import { Button } from '@/ui/form/button'
import { Notice } from '@/ui/form/notice'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { invoicesHref, loadInvoiceFilters } from '../../_tracking/list-filters'
import { day, localeOf, memberName, when } from '../../_tracking/present'
import { invoiceStates, money, nameIn } from '../present'

export async function generateMetadata() {
  const t = await getTranslations('finance.invoices')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'
const SEARCH_MAX = 60

// Invoices (spec §9.1 /finance/invoices, S4-08, FR-P2P-008): the POs that wait for their supplier's invoice — sent,
// received in part or in full, and closed ones still holding budget for goods received and not invoiced — with what was
// received, invoiced and is still held, the longest waiting first; then the invoices recorded lately; searched with a
// plain GET form (it changes nothing). FINANCE's page (invoiceConfirmation.record, checked by the service before
// anything is read); recording happens on each PO's page. ?gr=posted keeps the POs with goods received — the home's row
// "ใบกำกับรอยืนยัน" links here with it (§9.10) — and the search keeps it.
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('finance'), getLocale().then(localeOf)])
  const filters = await loadInvoiceFilters(searchParams)
  const q = (filters.q ?? '').trim().slice(0, SEARCH_MAX)
  const received = filters.gr === 'posted'
  const result = await listInvoiceWork(ctx, { q, received })
  if (!result.ok) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <h1 className="text-2xl font-semibold">{t('forbiddenTitle')}</h1>
        <Notice tone="warning">{t('forbiddenHint')}</Notice>
        <Link href="/" className={linkClass}>
          {t('home')}
        </Link>
      </div>
    )
  }
  const { waiting, waitingCount, recorded, notExported } = result.data

  const waitingRows: WaitingRowView[] = waiting.rows.map((po) => ({
    id: po.id,
    href: `/finance/invoices/${po.id}`,
    linkText: t('invoices.waiting.open', { number: po.number ?? '-' }),
    supplier: t('supplierWithCode', { name: nameIn(locale, po.supplier.name), code: po.supplier.code }),
    meta: [
      po.status === 'CLOSED' && po.closedAt ? t('invoices.waiting.closedOn', { date: day(locale, po.closedAt) }) : po.sentAt ? t('invoices.waiting.sentOn', { date: day(locale, po.sentAt) }) : null,
      t('invoices.waiting.invoiceCount', { count: po.invoiceCount }),
    ].filter((m): m is string => m !== null),
    status: po.status,
    statusLabel: t(`poStatus.${po.status}`),
    po: money(po.netSatang),
    received: money(po.receivedSatang),
    invoiced: money(po.invoicedSatang),
    held: money(po.heldSatang),
  }))

  const invoiceRows: InvoiceRowView[] = recorded.rows.map((inv) => ({
    id: inv.id,
    title: t('invoices.recorded.number', { number: inv.invoiceNo }),
    details: [nameIn(locale, inv.supplier.name)],
    link: { href: `/finance/invoices/${inv.po.id}`, text: t('invoices.recorded.po', { number: inv.po.number ?? '-' }) },
    meta: [t('invoices.recorded.dated', { date: day(locale, inv.invoiceDate) }), t('invoices.recorded.by', { name: memberName(locale, inv.recordedBy) || '-', time: when(locale, inv.recordedAt) })],
    states: invoiceStates(t, locale, inv),
    net: money(inv.netSatang),
    vat: money(inv.vatSatang),
    gross: money(inv.grossSatang),
    file: inv.file ? { fileId: inv.file.id, label: t('openFile', { name: inv.file.fileName }), busyLabel: t('openingFile', { name: inv.file.fileName }) } : null,
  }))

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex max-w-3xl flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t('invoices.title')}</h1>
          <p className="text-ink-muted">{t('invoices.intro')}</p>
        </div>
        <Link href="/finance/exports" className={linkClass}>
          {t('invoices.toExports', { count: notExported })}
        </Link>
      </div>

      {received ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium text-ink">{t('invoices.receivedOnly')}</p>
          <Link href={invoicesHref('/finance/invoices', { q: q || null })} className={linkClass}>
            {t('invoices.showAll')}
          </Link>
        </div>
      ) : null}

      <form method="get" action="/finance/invoices" className="flex flex-col gap-3 border-y border-line py-4 md:flex-row md:items-start">
        {received ? <input type="hidden" name="gr" value="posted" /> : null}
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="finance-search" className="font-medium text-ink">
            {t('invoices.search')}
          </label>
          <input id="finance-search" name="q" type="search" defaultValue={q} maxLength={SEARCH_MAX} aria-describedby="finance-search-hint" className="h-11 w-full rounded-md border border-input bg-bg px-3 text-base text-ink" />
          <p id="finance-search-hint" className="text-base text-ink-muted md:text-sm">
            {t('invoices.searchHint')}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span aria-hidden="true" className="hidden font-medium md:block">
            &nbsp;
          </span>
          <Button type="submit" variant="secondary">
            {t('invoices.searchSubmit')}
          </Button>
        </div>
      </form>
      {q ? (
        <Link href={invoicesHref('/finance/invoices', { gr: filters.gr })} className={linkClass}>
          {t('invoices.clearSearch')}
        </Link>
      ) : null}

      <section aria-labelledby="finance-waiting" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="finance-waiting" className="text-lg font-semibold text-ink">
            {t('invoices.waiting.title', { count: waitingCount })}
          </h2>
          <p className="text-ink-muted">{t('invoices.waiting.hint')}</p>
        </div>
        {waitingRows.length ? (
          <>
            <WaitingList
              rows={waitingRows}
              labels={{
                list: t('invoices.waiting.list'),
                poColumn: t('invoices.waiting.columns.po'),
                statusColumn: t('invoices.waiting.columns.status'),
                po: t('invoices.waiting.columns.amount'),
                received: t('invoices.waiting.columns.received'),
                invoiced: t('invoices.waiting.columns.invoiced'),
                held: t('invoices.waiting.columns.held'),
                unit: t('unit'),
              }}
            />
            {waiting.limited ? <p className="text-ink-muted">{t('invoices.limited', { shown: waitingRows.length })}</p> : null}
          </>
        ) : (
          <div className="flex flex-col gap-2 border-y border-line py-6">
            <p className="font-medium text-ink">{q ? t('invoices.waiting.noMatch') : t('invoices.waiting.empty')}</p>
            <p className="text-ink-muted">{q ? t('invoices.waiting.noMatchHint') : t('invoices.waiting.emptyHint')}</p>
          </div>
        )}
      </section>

      <section aria-labelledby="finance-recorded" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="finance-recorded" className="text-lg font-semibold text-ink">
            {t('invoices.recorded.title')}
          </h2>
          <p className="text-ink-muted">{t('invoices.recorded.hint')}</p>
        </div>
        {invoiceRows.length ? (
          <>
            <InvoiceList
              rows={invoiceRows}
              open={downloadUrlAction}
              labels={{
                list: t('invoices.recorded.list'),
                invoiceColumn: t('invoices.recorded.columns.invoice'),
                stateColumn: t('invoices.recorded.columns.state'),
                net: t('invoices.recorded.columns.net'),
                vat: t('invoices.recorded.columns.vat'),
                gross: t('invoices.recorded.columns.gross'),
                unit: t('unit'),
                fileFailed: t('fileFailed'),
              }}
            />
            {recorded.limited ? <p className="text-ink-muted">{t('invoices.recorded.limited', { shown: invoiceRows.length })}</p> : null}
          </>
        ) : (
          <div className="flex flex-col gap-2 border-y border-line py-6">
            <p className="font-medium text-ink">{q ? t('invoices.recorded.noMatch') : t('invoices.recorded.empty')}</p>
            <p className="text-ink-muted">{q ? t('invoices.recorded.noMatchHint') : t('invoices.recorded.emptyHint')}</p>
          </div>
        )}
      </section>
    </div>
  )
}
