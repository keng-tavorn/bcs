import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listWhtIncomeTypesView } from '@/server/services/ap/view-tax'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { Button } from '@/ui/shadcn/button'
import { IncomeTypes, type IncomeTypeRowView } from '@/ui/wht/income-types'
import { getSession } from '../../../../_lib/session'
import { localeOf, nameIn, when } from '../../../_tracking/present'
import { vatRateText } from '../../present'
import { Refused } from '../refused'
import { confirmIncomeTypeAction, updateIncomeTypeAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('apTax.types')
  return { title: t('metaTitle') }
}

// Income types and their withholding rates (S8-13 /finance/wht/types, FR-AP-104 AC2, BR-WHT-03): wht.view (FINANCE,
// AUDITOR) with module PAY reads, checked by the view before anything is read; wht.configure (FINANCE) adds, changes
// and confirms — the confirmer never the member who changed the type last.
export default async function WhtTypesPage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, locale] = await Promise.all([getTranslations('apTax.types'), getLocale().then(localeOf)])
  const result = await listWhtIncomeTypesView(ctx)
  if (!result.ok) return <Refused code={result.error.code} />

  const rows: IncomeTypeRowView[] = result.data.rows.map((r) => ({
    code: r.code,
    name: locale === 'en' && r.nameEn ? r.nameEn : r.nameTh,
    nameTh: r.nameTh,
    nameEn: r.nameEn ?? '',
    rate: vatRateText(r.rateBp) ?? '0',
    form: r.form,
    legalRefTh: r.legalRefTh ?? '',
    active: r.active,
    confirmed: r.confirmedBy !== null,
    confirmedText: r.confirmedBy && r.confirmedAt ? t('confirmedBy', { name: nameIn(locale, r.confirmedBy), time: when(locale, r.confirmedAt) }) : null,
    changedText: r.updatedBy ? t('changedBy', { name: nameIn(locale, r.updatedBy) }) : null,
    changedByMe: r.changedByMe,
  }))

  return (
    <Page>
      <PageHeader
        title={t('title')}
        intro={t('intro')}
        actions={
          <Button asChild variant="outline" className="min-h-11 lg:min-h-10">
            <Link href="/finance/wht">{t('toWht')}</Link>
          </Button>
        }
      />
      <PageBody>
        <Panel title={t('list')} id="wht-types">
          <IncomeTypes rows={rows} canConfigure={result.data.canConfigure} save={updateIncomeTypeAction} confirm={confirmIncomeTypeAction} />
        </Panel>
      </PageBody>
    </Page>
  )
}
