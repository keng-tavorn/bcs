import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listInvoiceWork } from '@/server/services/invoices/view'
import { apInvoicesOn } from '@/server/services/ap/view-list'
import { InvoiceList, type InvoiceRowView } from '@/ui/finance/invoice-list'
import { WaitingList, type WaitingRowView } from '@/ui/finance/waiting-list'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { ApInvoicesPage } from './ap-list-page'
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
  // S8-13: with module PAY on the organization's invoices are tier 2 (BR-IVC-06) and this page lists them instead
  if (await apInvoicesOn(ctx)) return <ApInvoicesPage ctx={ctx} searchParams={await searchParams} />
  const [t, td, locale] = await Promise.all([getTranslations('finance'), getTranslations('document.badge'), getLocale().then(localeOf)])
  const filters = await loadInvoiceFilters(searchParams)
  const q = (filters.q ?? '').trim().slice(0, SEARCH_MAX)
  const received = filters.gr === 'posted'
  const result = await listInvoiceWork(ctx, { q, received })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{t('forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('home')}
          </Link>
        </div>
      </Page>
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
    statusLabel: td(`po.${po.status}` as 'po.DRAFT'),
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
    <Page>
      <PageHeader
        title={t('invoices.title')}
        intro={t('invoices.intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/finance/exports">{t('invoices.toExports', { count: notExported })}</Link>
          </Button>
        }
      />
      <PageBody>
        <FilterBar
          action="/finance/invoices"
          label={t('invoices.filterLabel')}
          submit={t('invoices.searchSubmit')}
          hidden={{ gr: received ? 'posted' : null }}
          footer={
            <>
              <FilterSummary
                count={t('invoices.filterCount', { count: waitingCount })}
                notes={received ? [t('invoices.receivedOnly')] : []}
                clear={q ? { href: invoicesHref('/finance/invoices', { gr: filters.gr }), label: t('invoices.clearSearch') } : null}
              />
              {received ? (
                <Link href={invoicesHref('/finance/invoices', { q: q || null })} className={linkClass}>
                  {t('invoices.showAll')}
                </Link>
              ) : null}
            </>
          }
        >
          <FilterSearch id="finance-search" label={t('invoices.search')} hint={t('invoices.searchHint')} defaultValue={q} maxLength={SEARCH_MAX} />
        </FilterBar>

        <Panel title={t('invoices.waiting.title', { count: waitingCount })} id="finance-waiting">
          <p className="text-ink-muted">{t('invoices.waiting.hint')}</p>
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
            <ListEmpty
              title={q ? t('invoices.waiting.noMatch') : t('invoices.waiting.empty')}
              hint={q ? t('invoices.waiting.noMatchHint') : t('invoices.waiting.emptyHint')}
              actions={
                q ? (
                  <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                    <Link href={invoicesHref('/finance/invoices', { gr: filters.gr })}>{t('invoices.clearSearch')}</Link>
                  </Button>
                ) : null
              }
            />
          )}
        </Panel>

        <Panel title={t('invoices.recorded.title')} id="finance-recorded">
          <p className="text-ink-muted">{t('invoices.recorded.hint')}</p>
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
            <ListEmpty title={q ? t('invoices.recorded.noMatch') : t('invoices.recorded.empty')} hint={q ? t('invoices.recorded.noMatchHint') : t('invoices.recorded.emptyHint')} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
