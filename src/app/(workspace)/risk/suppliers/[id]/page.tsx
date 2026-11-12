import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { supplierRiskFile } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader } from '@/ui/page/page'
import { getSession } from '../../../../_lib/session'
import { localeOf } from '../../../_tracking/present'
import { RiskFileView } from '../_file'
import { exportRiskFileAction, openAssessmentAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.file')
  return { title: t('title') }
}

const linkClass = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

// /risk/suppliers/[id] (S11-10 · FR-RSK-204 AC1 · BR-RSK-14): one supplier's risk file for whoever reads the risk files
// (risk.assessment.view: PROCUREMENT FINANCE EXECUTIVE AUDITOR); the same file as the tab "ความเสี่ยง" of /suppliers/[id].
export default async function SupplierRiskFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.file'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const file = await supplierRiskFile(ctx, id)
  if (!file.ok) {
    if (file.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('title')} message={file.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const s = file.data.supplier
  const name = locale === 'en' && s.nameEn ? s.nameEn : s.nameTh
  return (
    <Page>
      <div className="flex flex-col gap-3">
        <Link href="/risk" className={linkClass}>
          {t('back')}
        </Link>
        <PageHeader title={t('heading', { supplier: name })} intro={t('intro')}>
          <Link href={`/suppliers/${s.id}`} className={linkClass}>
            {t('toSupplier')}
          </Link>
        </PageHeader>
      </div>
      <PageBody>
        <RiskFileView file={file.data} locale={locale} actions={{ exportFile: exportRiskFileAction.bind(null, s.id), open: openAssessmentAction.bind(null, s.id) }} />
      </PageBody>
    </Page>
  )
}
