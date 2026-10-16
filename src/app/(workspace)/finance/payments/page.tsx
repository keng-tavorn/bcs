import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listPaymentRuns, RUN_TABS, type RunTab } from '@/server/services/payments/view'
import { ApInvoiceTabs } from '@/ui/ap/list/invoice-tabs'
import { Notice } from '@/ui/form/notice'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { accountValues, dayText, money } from '@/ui/payments/present'
import { RunPagination } from '@/ui/payments/run-pagination'
import { RunTable, type RunRowView } from '@/ui/payments/run-table'
import { nameIn } from '@/ui/payments/types'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'

// /finance/payments (S9-09, docs/sub-specs/S9.md "หน้าจอ", FR-PAY-101): the organization's payment runs in tabs ร่าง ·
// รออนุมัติ · รอส่งธนาคาร · ส่งแล้ว · เสร็จ · ยกเลิก with their counts, a page at a time; the tab and the page are in the
// address (a GET that changes nothing). Each run opens its own page. FINANCE prepares a new run from here; AUDITOR reads
// every run, an approver the runs of their tasks (paymentRun.view, checked by the view before anything is read).

export async function generateMetadata() {
  const t = await getTranslations('payRun')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

type Params = Record<string, string | string[] | undefined>
const one = (value: string | string[] | undefined): string | null => (typeof value === 'string' ? value : null)

function hrefOf(tab: RunTab, page = 1): string {
  const params = new URLSearchParams()
  if (tab !== 'draft') params.set('tab', tab)
  if (page > 1) params.set('page', String(page))
  const query = params.toString()
  return query ? `/finance/payments?${query}` : '/finance/payments'
}

export default async function PaymentRunsPage({ searchParams }: { searchParams: Promise<Params> }) {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const params = await searchParams
  const [t, locale] = await Promise.all([getTranslations('payRun'), getLocale()])
  const asked = one(params.tab)
  const tab = (RUN_TABS as readonly string[]).includes(asked ?? '') ? (asked as RunTab) : 'draft'
  const page = Number.parseInt(one(params.page) ?? '1', 10)
  const result = await listPaymentRuns(ctx, { tab, page: Number.isFinite(page) ? page : 1 })
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={t('list.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{result.error.code === 'MODULE_DISABLED' ? t('list.moduleOff') : t('list.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('list.home')}
          </Link>
        </div>
      </Page>
    )
  }
  const list = result.data
  const tabName = t(`list.tab.${tab}`)
  const prepare = list.canPrepare ? (
    <Button asChild className="min-h-11 lg:min-h-10">
      <Link href="/finance/payments/new">{t('list.prepare')}</Link>
    </Button>
  ) : null
  const rows: RunRowView[] = list.rows.map((r) => ({
    id: r.id,
    href: `/finance/payments/${r.id}`,
    title: r.number ?? t('list.draftTitle'),
    preparedBy: t('list.preparedBy', { name: nameIn(locale, r.preparedBy) }),
    payDate: dayText(locale, r.payDate),
    payer: r.payer.code ? t('account.withCode', accountValues(locale, r.payer)) : t('account.masked', accountValues(locale, r.payer)),
    suppliers: t('list.suppliers', { count: r.itemCount }),
    transfer: money(r.totalTransferSatang),
    flags: r.flaggedItems > 0 ? t('list.flagged', { count: r.flaggedItems }) : null,
    noFlags: t('list.noFlags'),
    status: r.status,
    statusLabel: t(`status.${r.status}` as 'status.DRAFT'),
  }))
  const nothingAtAll = RUN_TABS.every((k) => list.counts[k] === 0)

  return (
    <Page>
      <PageHeader title={t('list.title')} intro={t('list.intro')} actions={prepare} />
      <PageBody>
        <Panel label={t('list.tabsLabel')}>
          <ApInvoiceTabs
            current={tab}
            label={t('list.tabsLabel')}
            tabs={RUN_TABS.map((key) => ({ key, label: t('list.withCount', { label: t(`list.tab.${key}`), count: list.counts[key] }), href: hrefOf(key) }))}
          >
            {rows.length ? (
              <>
                <RunTable
                  rows={rows}
                  labels={{
                    table: t('list.table', { tab: tabName }),
                    run: t('list.columns.run'),
                    payDate: t('list.columns.payDate'),
                    payer: t('list.columns.payer'),
                    suppliers: t('list.columns.suppliers'),
                    transfer: t('list.columns.transfer'),
                    flags: t('list.columns.flags'),
                    status: t('list.columns.status'),
                    unit: t('unit'),
                  }}
                />
                <RunPagination page={list.page} pageCount={list.pageCount} hrefOf={(p) => hrefOf(tab, p)} label={t('list.page', { page: list.page, pages: list.pageCount })} />
              </>
            ) : nothingAtAll ? (
              <ListEmpty title={t('list.empty')} hint={list.canPrepare ? t('list.emptyHint') : t('list.emptyHintReader')} actions={prepare} />
            ) : (
              <ListEmpty title={t('list.emptyTab', { tab: tabName })} hint={t('list.emptyTabHint')} />
            )}
          </ApInvoiceTabs>
        </Panel>
      </PageBody>
    </Page>
  )
}
