import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { getExportOverview } from '@/server/services/exports/view'
import { ExportJobs, type ExportJobView } from '@/ui/finance/export-jobs'
import { ExportPanel } from '@/ui/finance/export-panel'
import { Notice } from '@/ui/form/notice'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { day, localeOf, memberName, when } from '../../_tracking/present'
import { money, nameIn } from '../present'
import { exportAgainAction, exportNowAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('finance.exports')
  return { title: t('metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// The Express export (spec §9.1 /finance/exports, S4-09, FR-P2P-009, §7.13): the invoices not exported yet that the next
// file takes, with their total, and the tick and button that make it (AC1); the invoices kept out because their supplier
// has no Express vendor code yet, by supplier, each with a link to the supplier for procurement to fill the code (AC4,
// BR-EXP-04); the organization's file layout (BR-EXP-01); and the files made with their rows, total, checksum and a
// download, each of which can be made again with a reason (AC2, BR-EXP-02, BR-EXP-03). FINANCE's page (export.express,
// checked by the service before anything is read); the command checks everything again.
export default async function ExportsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tf, locale] = await Promise.all([getTranslations('finance.exports'), getTranslations('finance'), getLocale().then(localeOf)])
  const result = await getExportOverview(ctx)
  if (!result.ok) {
    return (
      <Page>
        <PageHeader title={tf('forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{tf('forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {tf('home')}
          </Link>
        </div>
      </Page>
    )
  }
  const { layout, ready, readyFingerprint, heldBack, jobs } = result.data
  const jobViews: ExportJobView[] = jobs.map((job) => ({
    id: job.id,
    title: t('jobs.title', { time: when(locale, job.createdAt) }),
    meta: [t('jobs.by', { name: memberName(locale, job.requestedBy) || '-' })],
    rows: t('jobs.rows', { count: job.rowCount ?? 0 }),
    total: money(job.totalSatang ?? 0n),
    checksum: job.checksum,
    reason: job.reason ? t('jobs.reason', { reason: job.reason }) : null,
    invoiceCount: job.invoiceIds.length,
    file: job.file ? { fileId: job.file.id, label: t('jobs.download', { name: job.file.fileName }) } : null,
  }))

  return (
    <Page>
      <PageHeader
        title={t('title')}
        intro={t('intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/finance/invoices">{t('toInvoices')}</Link>
          </Button>
        }
      />
      <PageBody>

        {layout ? null : <Notice tone="warning">{t('layout.notSet')}</Notice>}

        <Panel title={t('ready.title', { count: ready.count })} id="export-ready">
            <p className="text-ink-muted">{ready.count ? t('ready.hint', { total: money(ready.totalSatang) }) : t('ready.emptyHint')}</p>
          {ready.count ? (
            <>
              <ul aria-label={t('ready.list')} className="flex flex-col divide-y divide-line border-y border-line">
                {ready.shown.map((inv) => (
                  <li key={inv.id} className="flex flex-col gap-1 py-3 md:grid md:grid-cols-[minmax(0,1fr)_10rem] md:items-start md:gap-4">
                    <div className="flex min-w-0 flex-col">
                      <span className="font-semibold break-words text-ink">{tf('invoices.recorded.number', { number: inv.invoiceNo })}</span>
                      <span className="break-words text-ink">{tf('supplierWithCode', { name: nameIn(locale, inv.supplier.name), code: inv.supplier.code })}</span>
                      <span className="text-base break-words text-ink-muted md:text-sm">{t('ready.meta', { po: inv.po.number ?? '-', date: day(locale, inv.invoiceDate), code: inv.supplier.expressVendorCode || '-' })}</span>
                    </div>
                    <p className="flex items-baseline justify-between gap-3 md:flex-col md:items-end md:gap-0">
                      <span className="text-base text-ink-muted md:text-sm">{t('ready.gross')}</span>
                      <span className="money block font-semibold text-ink">
                        {money(inv.grossSatang)}
                        <span className="sr-only"> {tf('unit')}</span>
                      </span>
                    </p>
                  </li>
                ))}
              </ul>
              {ready.count > ready.shown.length ? <p className="text-ink-muted">{t('ready.limited', { shown: ready.shown.length, count: ready.count })}</p> : null}
            </>
          ) : (
            <ListEmpty
              title={t('ready.empty')}
              actions={
                <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
                  <Link href="/finance/invoices">{t('ready.emptyLink')}</Link>
                </Button>
              }
            />
          )}
          {/* Kept in place whatever the list shows, so the file it made stays on screen after the page refreshes */}
          <ExportPanel count={ready.count} total={money(ready.totalSatang)} fingerprint={readyFingerprint} blocked={layout === null} make={exportNowAction} open={downloadUrlAction} />
        </Panel>

        {heldBack.count > 0 ? (
          <Panel title={t('held.title', { count: heldBack.count })} id="export-held">
              <p className="text-ink-muted">{t('held.hint')}</p>
            <ul aria-label={t('held.list')} className="flex flex-col divide-y divide-line border-y border-line">
              {heldBack.suppliers.map((s) => {
                const name = nameIn(locale, s.supplier.name)
                return (
                  <li key={s.supplier.id} className="flex flex-col gap-1 py-3">
                    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                      <span className="font-semibold break-words text-ink">{tf('supplierWithCode', { name, code: s.supplier.code })}</span>
                      <span className="flex shrink-0 items-baseline justify-between gap-3 sm:flex-col sm:items-end sm:gap-0">
                        <span className="text-base text-ink-muted md:text-sm">{t('ready.gross')}</span>
                        <span className="money text-ink">
                          {money(s.totalSatang)}
                          <span className="sr-only"> {tf('unit')}</span>
                        </span>
                      </span>
                    </div>
                    <span className="text-ink">{t('held.count', { count: s.count })}</span>
                    <span className="text-base break-words text-ink-muted md:text-sm">{t('held.invoices', { numbers: s.invoices.map((i) => (i.poNumber ? t('held.invoiceOfPo', { number: i.invoiceNo, po: i.poNumber }) : i.invoiceNo)).join(', ') })}</span>
                    <Link href={`/suppliers/${s.supplier.id}`} className={linkClass}>
                      {t('held.openSupplier', { name })}
                    </Link>
                  </li>
                )
              })}
            </ul>
          </Panel>
        ) : null}

        {layout ? (
          <Panel title={t('layout.title')} id="export-layout">
            <p className="text-ink">{t('layout.summary', { fileType: t(`layout.fileType.${layout.fileType}`), encoding: t(`layout.encoding.${layout.encoding}`), dateFormat: t(`layout.dateFormat.${layout.dateFormat}`) })}</p>
            <p className="break-words text-ink">{t('layout.columns', { count: layout.columns.length, columns: layout.columns.map((c) => c.header).join(' · ') })}</p>
            <p className="text-base text-ink-muted md:text-sm">{layout.needsVendorCode ? t('layout.vendorCodeNeeded') : t('layout.vendorCodeNotNeeded')}</p>
          </Panel>
        ) : null}

        <Panel title={t('jobs.heading')} id="export-jobs">
            <p className="text-ink-muted">{t('jobs.hint')}</p>
          {jobViews.length ? (
            <ExportJobs jobs={jobViews} again={exportAgainAction} open={downloadUrlAction} />
          ) : (
            <ListEmpty title={t('jobs.empty')} hint={t('jobs.emptyHint')} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
