import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import { riskReviewTask } from '@/server/services/risk'
import { NoAccess } from '@/ui/admin-settings/no-access'
import { STEP_BADGES, StatusBadge } from '@/ui/document/badges'
import type { BadgeLook } from '@/ui/document/badge-looks'
import { Page, PageBody, PageHeader, Panel } from '@/ui/page/page'
import { RISK_DOMAINS_UI } from '@/ui/risk-admin/model'
import { OpenFileButton } from '@/ui/risk-assessment/actions'
import { TierBadge } from '@/ui/risk-review/badges'
import { ReviewDecision } from '@/ui/risk-review/decision'
import { REVIEW_TASK_BADGES, SLOT_BADGES, reviewDueState, slotDomains } from '@/ui/risk-review/model'
import { getSession } from '../../../../_lib/session'
import { day, localeOf, when } from '../../../_tracking/present'
import { decideReviewAction, openReviewEvidenceFileAction } from './actions'

export async function generateMetadata() {
  const t = await getTranslations('riskReview.detail')
  return { title: t('title') }
}

// /risk/reviews/[id] (S11-06 · FR-RSK-202 AC3 AC4 · BR-RSK-08 · INV-RSK-05): one reviewer's task of a supplier risk
// assessment. The reviewer reads what the work is and the supplier's tier, then the questions, answers and evidence of
// the general part and of their slot's own parts only — the service never reads the others' answers for this page —
// the state of the other slots of the round without their answers or reasons, and decides: pass or return, nothing
// else, no PIN (BR-RSK-08 · BR-WF-09). A file behind an answer opens through a POST that checks the reviewer each time;
// a supplier's certificate is shown by its type, scope and expiry here. Whoever is not a holder of the task reads it
// as missing (risk.review.view). On phones the decision comes first and its buttons stick to the bottom of the screen.

const ASSESSMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'] as const
type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number]
const ASSESSMENT_LOOK: Record<AssessmentStatus, BadgeLook> = {
  DRAFT: { tone: 'neutral', icon: 'FilePen' },
  IN_REVIEW: { tone: 'warn', icon: 'Hourglass' },
  RETURNED: { tone: 'warn', icon: 'Undo2' },
  COMPLETED: { tone: 'ok', icon: 'CircleCheck' },
  SUPERSEDED: { tone: 'neutral', icon: 'Ban' },
  CANCELLED: { tone: 'neutral', icon: 'CircleX' },
}
const SCANS = ['PENDING', 'CLEAN', 'INFECTED'] as const
const SCREENING = ['processesPersonalData', 'accessesSystems', 'accessesPremises'] as const
const LINK = 'inline-flex min-h-11 items-center self-start font-medium text-primary underline underline-offset-4 hover:no-underline'

export default async function RiskReviewTaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()
  const ctx = ctxFromSession(await getSession(), 'WEB', systemClock.now())
  if (!ctx) return null
  const [t, tAdmin, tAssessment, tCommon, locale] = await Promise.all([
    getTranslations('riskReview'),
    getTranslations('risk.admin'),
    getTranslations('risk.assessment'),
    getTranslations('adminSettings'),
    getLocale().then(localeOf),
  ])
  const view = await riskReviewTask(ctx, id)
  if (!view.ok) {
    if (view.error.code === 'NOT_FOUND') notFound()
    return <NoAccess title={t('detail.title')} message={view.error.code === 'MODULE_DISABLED' ? tAdmin('moduleOff') : tCommon('forbidden')} homeLabel={tCommon('homeLink')} />
  }
  const p = view.data
  const a = p.assessment
  const en = locale === 'en'
  const number = a.number ?? a.supplier.code
  const supplierName = en && a.supplier.nameEn ? a.supplier.nameEn : a.supplier.nameTh
  const domainWords = (domains: readonly string[]) => domains.map((d) => tAdmin(`domain.${d as (typeof RISK_DOMAINS_UI)[number]}`)).join(' · ')
  const due = reviewDueState(ctx.now, p.assignedAt, p.dueAt)
  const dueLabel = due === 'OVERDUE' ? t('due.overdue', { time: when(locale, p.dueAt) }) : t('due.open', { time: when(locale, p.dueAt) })
  const assessmentStatus = (ASSESSMENT_STATUSES as readonly string[]).includes(a.status) ? (a.status as AssessmentStatus) : null
  const byDomain = RISK_DOMAINS_UI.map((d) => ({ domain: d, questions: p.questions.filter((q) => q.domain === d) })).filter((g) => g.questions.length > 0)
  // Open but not the member's to decide: the assessment no longer waits for its reviewers, or the member may only read it
  // (they prepared it, or the acting they held it by has ended)
  const blocked = p.status === 'OPEN' && !p.canDecide ? (a.status === 'IN_REVIEW' ? ('NOT_DECIDER' as const) : ('NOT_IN_REVIEW' as const)) : null

  return (
    // On phones the decision buttons are fixed to the bottom: the page ends above them (useBarSpace measures the bar)
    <div className={p.canDecide ? 'pb-[calc(var(--task-bar-space,6rem)_+_1rem)] lg:pb-0' : undefined}>
      <Page>
        <Link href="/risk/reviews" className={LINK}>
          {t('detail.back')}
        </Link>
        <PageHeader
          title={t('detail.heading', { number, supplier: supplierName })}
          intro={t('detail.intro', { domains: domainWords(slotDomains(p.riskDomains)), round: p.reviewRound })}
          actions={
            <>
              {p.status === 'OPEN' ? <StatusBadge look={STEP_BADGES[due]} label={dueLabel} /> : <StatusBadge look={REVIEW_TASK_BADGES[p.status]} label={t(`taskStatus.${p.status}`)} />}
              {a.tier ? <TierBadge tier={a.tier} label={t(`tier.${a.tier}`)} /> : null}
            </>
          }
        >
          {p.onBehalfOfName ? <p className="font-medium text-ink-muted">{t('list.onBehalfOf', { name: p.onBehalfOfName })}</p> : null}
        </PageHeader>
        <PageBody>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_auto_1fr] lg:items-start lg:gap-6">
            <div className="min-w-0 lg:col-start-2 lg:row-start-1">
              <ReviewDecision
                status={p.status}
                canDecide={p.canDecide}
                blocked={blocked}
                number={number}
                decidedAt={p.decidedAt ? when(locale, p.decidedAt) : null}
                myReason={p.myReason}
                decide={decideReviewAction.bind(null, p.taskId)}
              />
            </div>

            <Panel title={t('detail.questions')} id="questions" className="lg:col-start-1 lg:row-span-3 lg:row-start-1">
              <p className="text-ink-muted">{t('detail.questionsHint')}</p>
              {byDomain.length ? (
                <div className="flex flex-col gap-5">
                  {byDomain.map((g) => (
                    <section key={g.domain} aria-labelledby={`d-${g.domain}`} className="flex flex-col gap-2">
                      <h3 id={`d-${g.domain}`} className="font-semibold">
                        {tAdmin(`domain.${g.domain}`)}
                      </h3>
                      <ol className="flex flex-col divide-y divide-line border-y border-line">
                        {g.questions.map((q) => (
                          <li key={q.code} className="flex flex-col gap-1 py-3">
                            <span className="font-medium break-words">{`${q.code} · ${en ? q.textEn : q.textTh}`}</span>
                            {q.answer ? (
                              <>
                                <span>{t('detail.answer', { option: en ? q.answer.optionLabelEn : q.answer.optionLabelTh })}</span>
                                <span className="text-ink-muted">{t(`detail.source.${q.answer.source}`)}</span>
                                {q.answer.evidenceDocument ? (
                                  <span className="text-ink-muted">
                                    {t('detail.evidenceDocument', { type: q.answer.evidenceDocument.documentTypeCode, scope: q.answer.evidenceDocument.scope ?? '-', date: day(locale, q.answer.evidenceDocument.expiresOn) })}
                                  </span>
                                ) : null}
                                {q.answer.note ? <span className="break-words text-ink-muted">{t('detail.note', { note: q.answer.note })}</span> : null}
                                {q.answer.files.length ? (
                                  <ul className="text-ink-muted">
                                    {q.answer.files.map((f) => (
                                      <li key={f.fileId} className="flex flex-col">
                                        <span className="break-words">
                                          {t('detail.file', { name: f.fileName, scan: (SCANS as readonly string[]).includes(f.scanStatus) ? tAssessment(`scan.${f.scanStatus as (typeof SCANS)[number]}`) : f.scanStatus })}
                                        </span>
                                        {f.scanStatus === 'CLEAN' ? <OpenFileButton label={t('detail.openFile', { name: f.fileName })} open={openReviewEvidenceFileAction.bind(null, a.id, f.fileId)} /> : null}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </>
                            ) : (
                              <span className="text-ink-muted">{t('detail.notAnswered')}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </section>
                  ))}
                </div>
              ) : (
                <p>{t('detail.noQuestions')}</p>
              )}
            </Panel>

            <Panel title={t('detail.assessment')} id="assessment" className="lg:col-start-2 lg:row-start-2">
              <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt className="text-ink-muted">{t('detail.supplier')}</dt>
                <dd className="break-words">{`${a.supplier.code} · ${supplierName}`}</dd>
                <dt className="text-ink-muted">{t('detail.assessmentStatus')}</dt>
                <dd>{assessmentStatus ? <StatusBadge look={ASSESSMENT_LOOK[assessmentStatus]} label={tAssessment(`status.${assessmentStatus}`)} className="text-base md:text-sm" /> : a.status}</dd>
                {SCREENING.map((k) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-muted">{tAdmin(`questionnaire.fieldsWhen.${k}`)}</dt>
                    <dd>{a.screening[k] === 'Y' ? tAdmin('questionnaire.values.Y') : tAdmin('questionnaire.values.N')}</dd>
                  </div>
                ))}
                <dt className="text-ink-muted">{tAssessment('categories')}</dt>
                <dd className="break-words">{a.categoryCodes.length ? a.categoryCodes.join(', ') : '-'}</dd>
                <dt className="text-ink-muted">{tAssessment('inherentTier')}</dt>
                <dd>{tAdmin(`tierName.${a.inherentTier}`)}</dd>
                <dt className="text-ink-muted">{t('detail.tier')}</dt>
                <dd>{a.tier ? <TierBadge tier={a.tier} label={t(`tier.${a.tier}`)} className="text-base md:text-sm" /> : '-'}</dd>
                <dt className="text-ink-muted">{t('detail.submittedAt')}</dt>
                <dd>{a.submittedAt ? when(locale, a.submittedAt) : '-'}</dd>
                <dt className="text-ink-muted">{t('detail.assignedAt')}</dt>
                <dd>{when(locale, p.assignedAt)}</dd>
                <dt className="text-ink-muted">{t('detail.dueAt')}</dt>
                <dd>{when(locale, p.dueAt)}</dd>
              </dl>
            </Panel>

            <Panel title={t('detail.slots')} id="slots" className="lg:col-start-2 lg:row-start-3">
              <p className="text-ink-muted">{t('detail.slotsHint')}</p>
              <ul className="flex flex-col divide-y divide-line">
                {p.slots.map((s) => (
                  <li key={s.slotNo} className="flex flex-col items-start gap-1 py-2">
                    <span className={s.mine ? 'font-semibold' : 'font-medium'}>
                      {s.mine ? t('detail.slotMine', { no: s.slotNo, domains: domainWords(slotDomains(s.riskDomains)) }) : t('detail.slot', { no: s.slotNo, domains: domainWords(slotDomains(s.riskDomains)) })}
                    </span>
                    <StatusBadge look={SLOT_BADGES[s.status]} label={t(`taskStatus.${s.status}`)} className="text-base md:text-sm" />
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </PageBody>
      </Page>
    </div>
  )
}
