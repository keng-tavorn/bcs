import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskQuestionnaireDetail } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RISK_DOMAINS_UI, RISK_TIERS, type RiskDomainUi, type RiskTierCodeUi } from '@/ui/risk-admin/model'
import { DecisionPanel, LintPanel, PreviewPanel, STATUS_LOOK, VersionEditor } from '@/ui/risk-admin/questionnaire'
import { getSession } from '../../../../../_lib/session'
import { localeOf, when } from '../../../../_tracking/present'
import {
  draftQuestionnaireAction,
  previewQuestionSetAction,
  publishQuestionnaireAction,
  rejectQuestionnaireAction,
  removeQuestionAction,
  reorderQuestionsAction,
  submitQuestionnaireAction,
  updateQuestionAction,
} from '../../actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.admin.questionnaire')
  return { title: t('versionTitle') }
}

// /admin/risk/questionnaire/[versionId] (S11-04 · BR-RSK-01 · BR-RSK-02 · BR-RSK-05): one version — its questions (edited
// while a draft), the lint as it stands, a dry-run of the question set, and sending, publishing or sending back. The
// publisher is never the one who sent it (the service refuses SAME_EDITOR).
export default async function RiskQuestionnaireVersionPage({ params }: { params: Promise<{ versionId: string }> }) {
  const { versionId } = await params
  if (!/^[0-9a-f-]{36}$/i.test(versionId)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.admin.questionnaire'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const view = await riskQuestionnaireDetail(ctx, versionId)
  if (!view.ok) {
    if (view.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('versionTitle')} message={view.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const d = view.data
  const detail = {
    id: d.id,
    code: d.code,
    versionNo: d.versionNo,
    status: d.status,
    effectiveText: d.effectiveTo ? t('effectiveRange', { from: when(locale, d.effectiveFrom), to: when(locale, d.effectiveTo) }) : when(locale, d.effectiveFrom),
    questions: d.questions,
    submittedByName: d.submittedByName,
    publishedByName: d.publishedByName,
    submittedByMe: d.submittedByMe,
    version: d.version,
    changeReason: d.changeReason,
    questionList: d.questionList.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) })),
    lint: { errors: d.lint.errors.map((i) => ({ ...i })), warnings: d.lint.warnings.map((i) => ({ ...i })) },
  }
  const domainName = Object.fromEntries(RISK_DOMAINS_UI.map((c) => [c, tAdmin(`domain.${c}`)])) as Record<RiskDomainUi, string>
  const tierName = Object.fromEntries(RISK_TIERS.map((c) => [c, tAdmin(`tierName.${c}`)])) as Record<RiskTierCodeUi, string>
  const actions = {
    draft: draftQuestionnaireAction,
    updateQuestion: updateQuestionAction,
    removeQuestion: removeQuestionAction,
    reorder: reorderQuestionsAction,
    submit: submitQuestionnaireAction,
    publish: publishQuestionnaireAction,
    reject: rejectQuestionnaireAction,
    preview: previewQuestionSetAction,
  }
  // the calendar day of Asia/Bangkok, YYYY-MM-DD (en-CA writes it so)
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now)

  return (
    <Page>
      <PageHeader title={t('versionName', { code: d.code, no: d.versionNo })} intro={t('versionIntro', { effective: detail.effectiveText })} actions={<StatusBadge look={STATUS_LOOK[d.status]} label={t(`status.${d.status}`)} />} />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start lg:gap-6">
          <Panel title={t('questions')} id="questions">
            <VersionEditor detail={detail} actions={actions} domainName={domainName} tierName={tierName} />
          </Panel>
          <div className="flex flex-col gap-4">
            <Panel title={t('lint.title')} id="lint">
              <LintPanel lint={detail.lint} />
            </Panel>
            {d.status === 'DRAFT' || d.status === 'PENDING_PUBLISH' ? (
              <Panel title={t(d.status === 'DRAFT' ? 'decide.sendTitle' : 'decide.publishPanel')} id="decide">
                <DecisionPanel detail={detail} actions={actions} today={today} />
              </Panel>
            ) : null}
            <Panel title={t('preview.title')} id="preview">
              <PreviewPanel versionId={d.id} preview={previewQuestionSetAction} tierName={tierName} />
            </Panel>
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
