import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { BE_OFFSET, monthNamesShort } from '@/core/thai/day'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listWhtCertificatesView } from '@/server/services/ap/view-tax'
import { ListEmpty, Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { formatTaxId } from '@/ui/suppliers/model'
import { CertificateList, type CertificateRowView } from '@/ui/wht/certificate-list'
import { WhtExportForm } from '@/ui/wht/export-form'
import { downloadUrlAction } from '../../../_lib/file-actions'
import { getSession } from '../../../_lib/session'
import { day, localeOf, type Locale } from '../../_tracking/present'
import { money } from '../present'
import { exportWhtReturnAction, revealPayeeTaxIdAction } from './actions'
import { Refused } from './refused'

export async function generateMetadata() {
  const t = await getTranslations('apTax.wht')
  return { title: t('metaTitle') }
}

/** "2026-10" → "ต.ค. 2569" / "Oct 2569" */
const monthLabel = (locale: Locale, month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${monthNamesShort(locale)[m - 1]} ${y + BE_OFFSET}`
}

// Withholding tax (S8-13 /finance/wht, FR-AP-104 AC4 AC5): wht.view (FINANCE, AUDITOR) with module PAY, checked by the
// view before anything is read. The 50 ทวิ issued, an individual payee's national id masked — whole only for
// wht.revealTaxId through a logged server action, which also gates the PDF — and the monthly summary for wht.export.
export default async function WhtPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('apTax.wht'), getLocale().then(localeOf)])
  const result = await listWhtCertificatesView(ctx)
  if (!result.ok) return <Refused code={result.error.code} />
  const { canReveal, canExport, months, limited } = result.data

  const rows: CertificateRowView[] = result.data.rows.map((c) => ({
    id: c.id,
    number: c.number,
    form: t(`forms.${c.form}`),
    paidOn: day(locale, c.paidOn),
    base: money(c.totalBaseSatang),
    tax: money(c.totalTaxSatang),
    payee: c.payee.name,
    branch: c.payee.branch,
    taxId: formatTaxId(c.payee.taxId),
    masked: c.payee.masked,
    fileId: c.fileId,
  }))

  return (
    <Page>
      <PageHeader
        title={t('title')}
        intro={t('intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/finance/wht/types">{t('toTypes')}</Link>
          </Button>
        }
      />
      <PageBody>
        {canExport ? (
          <Panel title={t('export.title')} id="wht-export">
            <WhtExportForm months={months.map((m) => ({ value: m, label: monthLabel(locale, m) }))} canReveal={canReveal} exportReturn={exportWhtReturnAction} open={downloadUrlAction} />
          </Panel>
        ) : null}
        <Panel title={t('certificates')} id="wht-certificates">
          {rows.length ? (
            <>
              <CertificateList rows={rows} canReveal={canReveal} reveal={revealPayeeTaxIdAction} open={downloadUrlAction} />
              {limited ? <p className="text-ink-muted">{t('limited', { shown: rows.length })}</p> : null}
            </>
          ) : (
            <ListEmpty title={t('empty')} hint={t('emptyHint')} />
          )}
        </Panel>
      </PageBody>
    </Page>
  )
}
