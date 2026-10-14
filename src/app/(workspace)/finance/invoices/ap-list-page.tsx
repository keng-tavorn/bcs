import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import type { Ctx } from '@/server/context'
import { AP_LIST_TABS, listApInvoices, type ApInvoiceRowDto, type ApListTab } from '@/server/services/ap/view-list'
import type { ApInvoiceRowView } from '@/ui/ap/list/invoice-table'
import { ApInvoiceTable } from '@/ui/ap/list/invoice-table'
import { ApInvoiceTabs } from '@/ui/ap/list/invoice-tabs'
import { Notice } from '@/ui/form/notice'
import { FilterBar, FilterSearch, FilterSummary } from '@/ui/page/filters'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { day, localeOf, type Locale } from '../../_tracking/present'
import { money } from '../present'

// /finance/invoices with module PAY on (S8-13, docs/sub-specs/S8.md "หน้าจอ", FR-AP-103 AC1): the organization's tier-2
// invoices in tabs ร่าง · ไม่ตรง · รออนุมัติ · พร้อมจ่าย · ทั้งหมด with their counts, searched with a plain GET form (it changes
// nothing); the tab and the search are in the address. Each invoice opens its own page (/finance/invoices/<id>). The page
// links to the inbox (invoice.inbox.manage) and to recording a new invoice. FINANCE's page: the view checks
// invoice.record and PAY before anything is read.

const SEARCH_MAX = 60
const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

type Params = Record<string, string | string[] | undefined>
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

function hrefOf(tab: ApListTab, q: string): string {
  const params = new URLSearchParams()
  if (tab !== 'draft') params.set('tab', tab)
  if (q) params.set('q', q)
  const query = params.toString()
  return query ? `/finance/invoices?${query}` : '/finance/invoices'
}

export async function ApInvoicesPage({ ctx, searchParams }: { ctx: Ctx; searchParams: Params }) {
  const [t, locale] = await Promise.all([getTranslations('apList'), getLocale().then(localeOf)])
  const asked = one(searchParams.tab)
  const tab = (AP_LIST_TABS as readonly string[]).includes(asked ?? '') ? (asked as ApListTab) : 'draft'
  const q = (one(searchParams.q) ?? '').trim().slice(0, SEARCH_MAX)
  const result = await listApInvoices(ctx, { tab, q })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('errors.MODULE_DISABLED') : t('forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('home')}
          </Link>
        </div>
      </Page>
    )
  }
  const list = result.data
  const tabName = t(`tabs.${tab}`)
  const rows = list.rows.map((row) => rowView(t, locale, row))

  return (
    <Page>
      <PageHeader
        title={t('title')}
        intro={t('intro')}
        actions={
          <>
            {list.canRetentions ? (
              <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                <Link href="/finance/retentions">{t('actions.retentions')}</Link>
              </Button>
            ) : null}
            {list.canWht ? (
              <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                <Link href="/finance/wht">{t('actions.wht')}</Link>
              </Button>
            ) : null}
            {list.canManageInbox ? (
              <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                <Link href="/finance/invoices/inbox">{t('actions.inbox')}</Link>
              </Button>
            ) : null}
            <Button asChild className="min-h-11 lg:min-h-10">
              <Link href="/finance/invoices/new">{t('actions.new')}</Link>
            </Button>
          </>
        }
      />
      <PageBody>
        <FilterBar
          action="/finance/invoices"
          label={t('filter.label')}
          submit={t('filter.submit')}
          hidden={{ tab: tab === 'draft' ? null : tab }}
          footer={<FilterSummary count={t('filter.count', { count: list.counts[tab] })} clear={q ? { href: hrefOf(tab, ''), label: t('filter.clear') } : null} />}
        >
          <FilterSearch id="ap-invoice-search" label={t('filter.search')} hint={t('filter.searchHint')} defaultValue={q} maxLength={SEARCH_MAX} />
        </FilterBar>

        <Panel label={t('tabs.label')}>
          <ApInvoiceTabs
            current={tab}
            label={t('tabs.label')}
            tabs={AP_LIST_TABS.map((key) => ({ key, label: t('tabs.withCount', { label: t(`tabs.${key}`), count: list.counts[key] }), href: hrefOf(key, q) }))}
          >
            {rows.length ? (
              <>
                <ApInvoiceTable
                  rows={rows}
                  labels={{
                    list: t('list.label', { tab: tabName }),
                    invoice: t('list.columns.invoice'),
                    supplier: t('list.columns.supplier'),
                    po: t('list.columns.po'),
                    net: t('list.columns.net'),
                    vat: t('list.columns.vat'),
                    gross: t('list.columns.gross'),
                    due: t('list.columns.due'),
                    status: t('list.columns.status'),
                    unit: t('unit'),
                  }}
                />
                {list.limited ? <p className="text-ink-muted">{t('list.limited', { shown: rows.length })}</p> : null}
              </>
            ) : (
              <ListEmpty
                title={q ? t('empty.noMatch') : t(`empty.${tab}`)}
                hint={q ? t('empty.noMatchHint') : t(`empty.${tab}Hint`)}
                actions={
                  q ? (
                    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                      <Link href={hrefOf(tab, '')}>{t('filter.clear')}</Link>
                    </Button>
                  ) : null
                }
              />
            )}
          </ApInvoiceTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}

type ApListT = Awaited<ReturnType<typeof getTranslations<'apList'>>>

function rowView(t: ApListT, locale: Locale, row: ApInvoiceRowDto): ApInvoiceRowView {
  const supplierName = locale === 'en' && row.supplier.nameEn ? row.supplier.nameEn : row.supplier.nameTh
  const title = row.number ?? (row.supplierInvoiceNo ? t('list.draftTitle', { no: row.supplierInvoiceNo }) : t('list.draftOfPo', { po: row.po.number ?? '-' }))
  return {
    id: row.id,
    href: `/finance/invoices/${row.id}`,
    title,
    supplierNo: row.supplierInvoiceNo ? t('list.supplierNo', { no: row.supplierInvoiceNo }) : t('list.noSupplierNo'),
    supplier: `${supplierName} (${row.supplier.code})`,
    po: row.po.number ?? '-',
    net: money(row.netSatang),
    vat: money(row.vatSatang),
    gross: money(row.grossSatang),
    due: row.dueDate ? day(locale, row.dueDate) : t('list.noDue'),
    status: row.status,
    statusLabel: t(`status.${row.status}` as 'status.DRAFT'),
    notes: [row.channel === 'EMAIL' ? t('list.fromEmail') : null, row.openExceptions > 0 ? t('list.exceptions', { count: row.openExceptions }) : null].filter((n): n is string => n !== null),
    duplicate: row.possibleDuplicate ? t('list.duplicate') : null,
  }
}
