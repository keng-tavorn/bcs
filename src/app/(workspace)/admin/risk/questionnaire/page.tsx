import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { listRiskQuestionnaires } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { VersionList } from '@/ui/risk-admin/questionnaire'
import { getSession } from '../../../../_lib/session'
import { localeOf, when } from '../../../_tracking/present'
import { draftQuestionnaireAction } from '../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.admin.questionnaire')
  return { title: t('title') }
}

// /admin/risk/questionnaire (S11-04 · BR-RSK-01 · BR-RSK-02): the versions of the supplier risk questionnaire and a new
// draft (a copy of the version in effect). ORG_ADMIN or DOA_ADMIN with the RISK module (admin.riskQuestionnaire).
export default async function RiskQuestionnairePage() {
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.admin.questionnaire'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const view = await listRiskQuestionnaires(ctx)
  if (!view.ok) return <NoAccess title={t('title')} message={view.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  const versions = view.data.map((v) => ({
    id: v.id,
    code: v.code,
    versionNo: v.versionNo,
    status: v.status,
    effectiveText: v.effectiveTo ? t('effectiveRange', { from: when(locale, v.effectiveFrom), to: when(locale, v.effectiveTo) }) : when(locale, v.effectiveFrom),
    questions: v.questions,
    submittedByName: v.submittedByName,
    publishedByName: v.publishedByName,
    submittedByMe: v.submittedByMe,
  }))
  return (
    <Page>
      <PageHeader title={t('title')} intro={t('intro')} />
      <PageBody>
        <Panel title={t('versions')} id="versions">
          <VersionList versions={versions} defaultCode={versions[0]?.code ?? null} draft={draftQuestionnaireAction} />
        </Panel>
      </PageBody>
    </Page>
  )
}
