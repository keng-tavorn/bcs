import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { StatusBadge } from '../../document/badges'
import { FileButton } from '../../finance/file-button'
import { formatDateTime } from '../../format'
import { Panel } from '../../page/page'
import { Button } from '../../shadcn/button'
import { InvoiceAlertList } from '../invoice/invoice-alerts'
import { invoiceAlertViews, money, nameOf, SourcePanel, type InvoiceLocale } from '../invoice/invoice-parts'
import { INVOICE_BADGES, type ApInvoicePageData } from '../invoice/types'
import { InvoiceQuickSheet } from './invoice-quick-sheet'

// What the quick view of the invoice list shows (NEW-117): the invoice's status and total, why the rules raised it (the
// same words as the badge on its page · NEW-116), how it arrived and its file (as the tab ที่มา · NEW-115), and its latest
// activity, newest first, with a link to the full page where the work is done. The data is the page's own
// (getApInvoicePage, which checks who reads it); nothing here changes the invoice — no button but opening the file.

export const RECENT_ACTIVITY = 5

export async function InvoiceQuickView({
  data,
  closeHref,
  openFile,
}: {
  data: ApInvoicePageData
  closeHref: string
  openFile: (fileId: string) => Promise<string | null>
}) {
  const [t, tl, ta, tp, rawLocale] = await Promise.all([getTranslations('apInvoice'), getTranslations('apList'), getTranslations('audit'), getTranslations('payRun.task'), getLocale()])
  const locale: InvoiceLocale = rawLocale === 'en' ? 'en' : 'th'
  const title = data.number ? t('title', { number: data.number }) : t('titleDraft')
  const supplierName = locale === 'en' && data.supplier.nameEn ? data.supplier.nameEn : data.supplier.nameTh
  const statusLabel = t.has(`status.${data.status}` as 'status.DRAFT') ? t(`status.${data.status}` as 'status.DRAFT') : data.status
  const alerts = invoiceAlertViews(t, tp, data)
  const eventText = (type: string) => {
    const key = `events.${type}` as 'events.invoice.drafted'
    return ta.has(key) ? ta(key) : type
  }
  const recent = [...data.events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).slice(0, RECENT_ACTIVITY)
  const full = `/finance/invoices/${data.id}`

  return (
    <InvoiceQuickSheet title={title} description={tl('quick.description')} closeHref={closeHref} invoiceId={data.id}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge look={INVOICE_BADGES[data.status]} label={statusLabel} className="text-base md:text-sm" />
        </div>
        <dl className="flex flex-col divide-y divide-line border-y border-line">
          {(
            [
              [tl('quick.supplier'), `${supplierName} (${data.supplier.code})`],
              [tl('quick.po'), data.po.number ?? '-'],
              [tl('quick.gross'), tl('quick.amount', { amount: money(data.grossSatang) })],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex flex-col gap-1 py-1.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
              <dt className="shrink-0 text-ink-muted">{label}</dt>
              <dd className="min-w-0 break-words text-ink sm:text-right">{value}</dd>
            </div>
          ))}
        </dl>
        <Button asChild className="min-h-11 self-start lg:min-h-10">
          <Link href={full}>{tl('quick.full')}</Link>
        </Button>
      </div>

      <Panel title={tl('quick.alerts', { count: alerts.length })} id="quick-alerts">
        {alerts.length ? <InvoiceAlertList alerts={alerts} label={t('alerts.title')} /> : <p className="text-ink-muted">{tl('quick.noAlerts')}</p>}
      </Panel>

      <SourcePanel t={t} locale={locale} data={data} />

      <Panel title={t('file.title')} id="quick-file">
        {data.file ? (
          <FileButton fileId={data.file.id} label={t('file.open', { name: data.file.fileName })} busyLabel={t('file.opening', { name: data.file.fileName })} failedText={t('file.failed')} open={openFile} />
        ) : (
          <p className="text-ink-muted">{t('file.none')}</p>
        )}
      </Panel>

      <Panel title={tl('quick.activity')} id="quick-activity">
        {recent.length ? (
          <ol aria-label={tl('quick.activity')} className="flex flex-col divide-y divide-line border-y border-line">
            {recent.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2">
                <span className="font-medium text-ink">{eventText(e.type)}</span>
                <span className="text-base text-ink-muted md:text-sm">
                  {e.actor ? nameOf(locale, e.actor) : t('history.system')} · {formatDateTime(locale, e.occurredAt)}
                </span>
                {e.reason ? <span className="text-base break-words text-ink md:text-sm">{t('history.reason', { reason: e.reason })}</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-ink-muted">{t('history.empty')}</p>
        )}
        {data.events.length > recent.length ? (
          <Link href={`${full}?tab=source`} className="inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline">
            {tl('quick.allActivity', { count: data.events.length })}
          </Link>
        ) : null}
      </Panel>
    </InvoiceQuickSheet>
  )
}
