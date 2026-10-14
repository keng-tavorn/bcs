import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listVarianceExceptions } from '@/server/services/ap/view-invoice'
import { VarianceList } from '@/ui/ap/invoice/variance-list'
import { Notice } from '@/ui/form/notice'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { getSession } from '../../../_lib/session'
import { requestApVarianceAction } from '../../finance/invoices/[poId]/ap-actions'

export async function generateMetadata() {
  const t = await getTranslations('apInvoice')
  return { title: t('exceptionsPage.metaTitle') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// PROCUREMENT's invoices with a price over the PO's or a quantity over what was ordered (S8-13, BR-MATCH-09,
// FR-AP-103 AC1 AC2, FR-AP-105 AC2): listVarianceExceptions checks invoice.variance.request and module PAY before
// anything is read; "ขออนุมัติส่วนต่าง" runs invoice.requestVarianceApproval, which checks everything again.
export default async function InvoiceExceptionsPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const t = await getTranslations('apInvoice')
  const rows = await listVarianceExceptions(ctx)
  if (!rows.ok) {
    const off = rows.error.code === 'MODULE_DISABLED'
    return (
      <Page>
        <PageHeader title={off ? t('moduleOffTitle') : t('exceptionsPage.forbiddenTitle')} />
        <div className="flex max-w-2xl flex-col gap-4">
          <Notice tone="warning">{off ? t('moduleOffHint') : t('exceptionsPage.forbiddenHint')}</Notice>
          <Link href="/" className={linkClass}>
            {t('home')}
          </Link>
        </div>
      </Page>
    )
  }
  return (
    <Page>
      <PageHeader title={t('exceptionsPage.title')} intro={t('exceptionsPage.intro')} />
      <PageBody>
        <Panel title={t('exceptionsPage.listTitle')} id="invoice-exceptions-list">
          <VarianceList rows={rows.data} request={requestApVarianceAction} />
        </Panel>
      </PageBody>
    </Page>
  )
}
