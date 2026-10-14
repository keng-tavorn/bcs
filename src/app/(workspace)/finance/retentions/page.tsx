import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listRetentionsView } from '@/server/services/ap/view-tax'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RetentionList, type RetentionRowView } from '@/ui/retention/retention-list'
import { Button } from '@/ui/shadcn/button'
import { getSession } from '../../../_lib/session'
import { day, localeOf, nameIn } from '../../_tracking/present'
import { money } from '../present'
import { Refused } from '../wht/refused'
import { releaseRetentionAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('apTax.retentions')
  return { title: t('metaTitle') }
}

// Performance retentions (S8-13 /finance/retentions, FR-AP-106 AC4): FINANCE's page (retention.release, module PAY —
// checked by the view before anything is read). Every retention by status with its invoice, PO, supplier, amount and
// due date; a HELD one whose day has come is released here and then waits for S9's payment run.
export default async function RetentionsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('apTax.retentions'), getLocale().then(localeOf)])
  const result = await listRetentionsView(ctx)
  if (!result.ok) return <Refused code={result.error.code} />

  const rows: RetentionRowView[] = result.data.rows.map((r) => ({
    id: r.id,
    status: r.status,
    version: r.version,
    amount: money(r.amountSatang),
    invoice: { href: `/finance/invoices/${r.invoice.id}`, number: r.invoice.number ?? r.invoice.supplierInvoiceNo ?? '-' },
    po: { href: `/procurement/pos/${r.po.id}`, number: r.po.number ?? '-' },
    supplier: `${nameIn(locale, r.supplier.name)} (${r.supplier.code})`,
    dueOn: r.releaseDueOn ? day(locale, r.releaseDueOn) : null,
    due: r.due,
  }))
  const toInvoices = (
    <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
      <Link href="/finance/invoices">{t('toInvoices')}</Link>
    </Button>
  )

  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel label={t('title')}>
          {rows.length ? (
            <>
              <RetentionList rows={rows} release={releaseRetentionAction} emptyAction={toInvoices} />
              {result.data.limited ? <p className="text-ink-muted">{t('limited', { shown: rows.length })}</p> : null}
            </>
          ) : (
            <ListEmpty title={t('empty.HELD')} hint={t('emptyHint')} actions={toInvoices} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
