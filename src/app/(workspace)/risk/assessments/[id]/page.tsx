import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskAssessmentView } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { StatusBadge } from '@/ui/document/badges'
import type { BadgeLook } from '@/ui/document/badge-looks'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RISK_DOMAINS_UI, RISK_TIERS } from '@/ui/risk-admin/model'
import { AssessmentButtons, type FillQuestion } from '@/ui/risk-assessment/actions'
import { getSession } from '../../../../_lib/session'
import { day, localeOf, when } from '../../../_tracking/present'
import { cancelAssessmentAction, fillOnBehalfAction, submitAssessmentAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('risk.assessment')
  return { title: t('title') }
}

// /risk/assessments/[id] (S11-05 · FR-RSK-201 · FR-RSK-204 AC1 in part · BR-RSK-14): one supplier risk assessment — what
// the work is (screening, categories, work scopes, the tier from screening), every question of its set with its answer
// and where the answer came from (the supplier, procurement for it, a certificate), the files behind them, and once sent
// its points and tier. risk.assessment.view reads it; PROCUREMENT fills in, sends or cancels while it is open.

const STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'] as const
type Status = (typeof STATUSES)[number]
const STATUS_LOOK: Record<Status, BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  IN_REVIEW: { tone: 'warn', icon: 'Hourglass' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  COMPLETED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Ban' },
  CANCELLED: { tone: 'neutral', icon: 'CircleX' },
}
const SOURCES = ['EXPLICIT', 'ON_BEHALF', 'EVIDENCE'] as const
const SCANS = ['PENDING', 'CLEAN', 'INFECTED'] as const
const SCREENING = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const

export default async function RiskAssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tCommon, locale] = await Promise.all([getTranslations('risk.assessment'), getTranslations('risk.admin'), getTranslations('adminSettings'), getLocale().then(localeOf)])
  const view = await riskAssessmentView(ctx, id)
  if (!view.ok) {
    if (view.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('title')} message={view.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const a = view.data
  const en = locale === 'en'
  const status = (STATUSES as readonly string[]).includes(a.status) ? (a.status as Status) : 'DRAFT'
  const tierWord = (code: (typeof RISK_TIERS)[number]) => tAdmin(`tierName.${code}`)
  const open = status === 'DRAFT' || status === 'RETURNED'
  const fillQuestions: FillQuestion[] = a.questions.map((q) => ({
    code: q.code,
    text: en ? q.textEn : q.textTh,
    options: q.options.map((o) => ({ code: o.code, label: en ? o.labelEn : o.labelTh })),
    chosen: q.answer?.optionCode ?? null,
    locked: q.answer?.source === 'EVIDENCE',
  }))
  const byDomain = RISK_DOMAINS_UI.map((d) => ({ domain: d, questions: a.questions.filter((q) => q.domain === d) })).filter((g) => g.questions.length > 0)

  return (
    <Page>
      <PageHeader
        title={t('heading', { number: a.number ?? '-', supplier: en && a.supplier.nameEn ? a.supplier.nameEn : a.supplier.nameTh })}
        intro={t('intro', { version: a.questionnaire.versionNo, code: a.questionnaire.code, opened: when(locale, a.openedAt), by: a.openedByName })}
        actions={<StatusBadge look={STATUS_LOOK[status]} label={t(`status.${status}`)} />}
      />
      <PageBody>
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-6">
          <Panel title={t('questions')} id="questions">
            <div className="flex flex-col gap-5">
              {byDomain.map((g) => (
                <section key={g.domain} aria-labelledby={`d-${g.domain}`} className="flex flex-col gap-2">
                  <h2 id={`d-${g.domain}`} className="font-semibold">
                    {tAdmin(`domain.${g.domain}`)}
                  </h2>
                  <ol className="flex flex-col divide-y divide-line border-y border-line">
                    {g.questions.map((q) => {
                      const option = q.answer ? q.options.find((o) => o.code === q.answer!.optionCode) : undefined
                      const source = q.answer && (SOURCES as readonly string[]).includes(q.answer.source) ? q.answer.source : null
                      return (
                        <li key={q.code} className="flex flex-col gap-1 py-3">
                          <span className="font-medium">{`${q.code} · ${en ? q.textEn : q.textTh}`}</span>
                          {q.answer ? (
                            <>
                              <span>{t('answer', { option: option ? (en ? option.labelEn : option.labelTh) : q.answer.optionCode, points: q.answer.points })}</span>
                              <span className="text-ink-muted">{t(`source.${source ?? 'EXPLICIT'}`, { by: q.answer.byName ?? '-' })}</span>
                              {q.answer.evidenceDocument ? (
                                <span className="text-ink-muted">{t('evidenceDocument', { type: q.answer.evidenceDocument.documentTypeCode, scope: q.answer.evidenceDocument.scope ?? '-', date: day(locale, q.answer.evidenceDocument.expiresOn) })}</span>
                              ) : null}
                              {q.answer.note ? <span className="text-ink-muted">{t('note', { note: q.answer.note })}</span> : null}
                              {q.answer.files.length ? (
                                <ul className="text-ink-muted">
                                  {q.answer.files.map((f, i) => (
                                    <li key={i}>{t('file', { name: f.fileName, scan: (SCANS as readonly string[]).includes(f.scanStatus) ? t(`scan.${f.scanStatus as (typeof SCANS)[number]}`) : f.scanStatus })}</li>
                                  ))}
                                </ul>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-ink-muted">{q.required ? t('notAnswered') : t('notAnsweredOptional')}</span>
                          )}
                        </li>
                      )
                    })}
                  </ol>
                </section>
              ))}
            </div>
          </Panel>
          <div className="flex flex-col gap-4">
            <Panel title={t('work')} id="work">
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                {SCREENING.map((k) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-muted">{tAdmin(`questionnaire.fieldsWhen.${k}`)}</dt>
                    <dd>{a.screening[k] === 'Y' ? tAdmin('questionnaire.values.Y') : tAdmin('questionnaire.values.N')}</dd>
                  </div>
                ))}
                <dt className="text-ink-muted">{t('categories')}</dt>
                <dd>{a.categoryCodes.length ? a.categoryCodes.join(', ') : '-'}</dd>
                <dt className="text-ink-muted">{t('workScopes')}</dt>
                <dd>{a.workScopes.length ? a.workScopes.join(', ') : '-'}</dd>
                <dt className="text-ink-muted">{t('inherentTier')}</dt>
                <dd>{tierWord(a.inherentTier)}</dd>
                {a.tier ? (
                  <>
                    <dt className="text-ink-muted">{t('result')}</dt>
                    <dd>{t('resultValue', { tier: tierWord(a.tier), points: a.pointsTotal ?? 0 })}</dd>
                  </>
                ) : null}
                {a.validUntil ? (
                  <>
                    <dt className="text-ink-muted">{t('validUntil')}</dt>
                    <dd>{day(locale, a.validUntil)}</dd>
                  </>
                ) : null}
              </dl>
            </Panel>
            {a.canManage && open ? (
              <Panel title={t('manage')} id="manage">
                <AssessmentButtons
                  version={a.version}
                  questions={fillQuestions}
                  actions={{ fill: fillOnBehalfAction.bind(null, a.id), submit: submitAssessmentAction.bind(null, a.id), cancel: cancelAssessmentAction.bind(null, a.id) }}
                />
              </Panel>
            ) : null}
          </div>
        </div>
      </PageBody>
    </Page>
  )
}
