import { getLocale, getTranslations } from 'next-intl/server'
import type { ReactNode } from 'react'
import { formatEnglishBeDate, formatThaiDate } from '@/core/thai/date'
import type { RiskReviewTaskPage } from '@/server/queries/risk-review'
import { riskReviewTask } from '@/server/services/risk'
import { STEP_BADGES } from '@/ui/document/badge-looks'
import { formatDateTime } from '@/ui/format'
import { LIFF_START_PATH } from '@/ui/liff/bootstrap'
import { LiffContent, LiffFrame, LiffSection } from '@/ui/liff/frame'
import { LiffGate } from '@/ui/liff/liff-gate'
import { LiffLink } from '@/ui/liff/liff-link'
import { LiffNotice } from '@/ui/liff/notice'
import { LiffStatusBadge } from '@/ui/liff/status-badge'
import { BackToChat } from '@/ui/liff/tasks/back-to-chat'
import { LiffWebLink } from '@/ui/liff/web-link'
import { liffPage } from '../../../_lib/session'
import { decideLiffRiskReviewAction } from './actions'
import { LiffRiskDecision, type RiskDecisionWords } from './decision'

// /liff/risk/reviews/[id] (S11-06 · FR-RSK-202 AC4 · BR-RSK-08 · INV-RSK-05 · BR-NOTI-12 · §9.4 · §9.9 principle 5): the
// page a reviewer's LINE card opens ("ตีกลับ"), for the holder of a slot of a supplier risk assessment or whoever acts
// for them now. On the phone: the assessment and the parts this reviewer reads — GENERAL and the slot's own domains,
// their questions and answers in short, never another slot's answers or reasons (riskReviewTask of the risk service:
// risk.review.view, then src/server/queries/risk-review.ts, which reads nothing else) — the state of the other slots,
// and the decision: pass in the bar at the bottom of the screen, or return with a required reason and the tick
// "ส่งข้อความนี้ถึงผู้ขายได้" (./decision.tsx, through riskReview.decide in ./actions.ts, which checks everything again).
// Anyone who may not read the task sees that it is not theirs and nothing of it. LIFF's light set only (ADR-052): no
// component or library of the workspace. The evidence files open on the web page of the same task (a link outside LINE).

export async function generateMetadata() {
  const t = await getTranslations('liffRisk.review')
  return { title: t('metaTitle') }
}

type Locale = 'th' | 'en'
type ReviewT = Awaited<ReturnType<typeof getTranslations<'liffRisk.review'>>>
type SlotStatus = RiskReviewTaskPage['status']

const DOMAINS = ['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'] as const
const TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const

const domainName = (t: ReviewT, domain: string) => ((DOMAINS as readonly string[]).includes(domain) ? t(`domain.${domain as (typeof DOMAINS)[number]}`) : domain)
const tierName = (t: ReviewT, tier: string) => ((TIERS as readonly string[]).includes(tier) ? t(`tierName.${tier as (typeof TIERS)[number]}`) : tier)
/** GENERAL first, then the slot's domains, each once (BR-RSK-08) */
const partsOf = (riskDomains: readonly string[]) => [...new Set(['GENERAL', ...riskDomains])]
const partsText = (t: ReviewT, riskDomains: readonly string[]) => partsOf(riskDomains).map((d) => domainName(t, d)).join(', ')

/** A slot's state as the badges of §9.10 draw a step's (an icon and the word, never colour alone) */
const SLOT_BADGE = { OPEN: STEP_BADGES.OPEN, PASSED: STEP_BADGES.APPROVE, RETURNED: STEP_BADGES.RETURN, CANCELLED: STEP_BADGES.CANCELLED } as const satisfies Record<SlotStatus, unknown>

/** A label and its value, one column on the phone */
function Facts({ label, items }: { readonly label: string; readonly items: ReadonlyArray<{ readonly label: string; readonly value: ReactNode }> }) {
  return (
    <section aria-label={label} className="border-t border-line pt-5">
      <dl className="flex flex-col gap-3">
        {items.map((item) => (
          <div key={item.label} className="flex flex-col">
            <dt className="text-ink-muted">{item.label}</dt>
            <dd className="font-medium break-words text-ink">{item.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

/** How the member's slot stands, in words: decided (when, and their reason), cancelled, or why they cannot decide it now */
function SlotState({ view, t, locale }: { readonly view: RiskReviewTaskPage; readonly t: ReviewT; readonly locale: Locale }) {
  const time = view.decidedAt ? formatDateTime(locale, view.decidedAt) : '-'
  switch (view.status) {
    case 'PASSED':
      return (
        <LiffNotice tone="success" role="status">
          <p>{t('state.PASSED', { time })}</p>
        </LiffNotice>
      )
    case 'RETURNED':
      return (
        <LiffNotice tone="warning" role="status">
          <p>{t('state.RETURNED', { time })}</p>
          {view.myReason ? <p className="break-words whitespace-pre-line">{t('state.reason', { reason: view.myReason })}</p> : null}
        </LiffNotice>
      )
    case 'CANCELLED':
      return <LiffNotice tone="info">{t('state.CANCELLED')}</LiffNotice>
    default:
      return view.canDecide ? null : <LiffNotice tone="info">{t('state.cannotDecide')}</LiffNotice>
  }
}

/** The questions of the member's parts with their answers, part by part: the answer, how it was given, its note and evidence */
function Questions({ view, t, locale }: { readonly view: RiskReviewTaskPage; readonly t: ReviewT; readonly locale: Locale }) {
  const files = view.questions.reduce((n, q) => n + (q.answer?.files.length ?? 0), 0)
  const dateOf = (d: Date) => (locale === 'en' ? formatEnglishBeDate(d) : formatThaiDate(d))
  return (
    <LiffSection id="risk-review-questions" title={t('questions.title')}>
      <p className="text-ink-muted">{t('questions.hint')}</p>
      {view.questions.length === 0 ? <p>{t('questions.empty')}</p> : null}
      {partsOf(view.riskDomains).map((domain) => {
        const asked = view.questions.filter((q) => q.domain === domain)
        if (asked.length === 0) return null
        return (
          <div key={domain} className="flex flex-col gap-2">
            <h3 className="font-semibold">{domainName(t, domain)}</h3>
            <ul className="flex flex-col">
              {asked.map((q) => (
                <li key={q.code} className="flex flex-col gap-1 border-t border-line py-3">
                  <p className="break-words text-ink">{locale === 'en' ? q.textEn : q.textTh}</p>
                  {q.answer ? (
                    <>
                      <p className="font-medium break-words">{locale === 'en' ? q.answer.optionLabelEn : q.answer.optionLabelTh}</p>
                      <p className="text-ink-muted">{t(`questions.source.${q.answer.source}`)}</p>
                      {q.answer.note ? <p className="break-words whitespace-pre-line text-ink-muted">{t('questions.note', { note: q.answer.note })}</p> : null}
                      {q.answer.evidenceDocument ? (
                        <p className="break-words text-ink-muted">
                          {t('questions.evidence', { type: q.answer.evidenceDocument.documentTypeCode, date: dateOf(q.answer.evidenceDocument.expiresOn) })}
                          {q.answer.evidenceDocument.scope ? ` · ${t('questions.evidenceScope', { scope: q.answer.evidenceDocument.scope })}` : ''}
                        </p>
                      ) : null}
                      {q.answer.files.length > 0 ? <p className="text-ink-muted">{t('questions.files', { count: q.answer.files.length })}</p> : null}
                    </>
                  ) : (
                    <p className="text-ink-muted">{t('questions.noAnswer')}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      {/* The evidence files open on the web page of the same task, outside LINE (the file service checks them there) */}
      {files > 0 ? (
        <LiffWebLink href={`/risk/reviews/${encodeURIComponent(view.taskId)}`} className="inline-flex min-h-11 items-center font-medium text-primary underline underline-offset-4 hover:no-underline">
          {t('questions.openOnWeb')}
        </LiffWebLink>
      ) : null}
    </LiffSection>
  )
}

/** Every slot of the round: its parts and its state only (BR-RSK-08) */
function Slots({ view, t }: { readonly view: RiskReviewTaskPage; readonly t: ReviewT }) {
  return (
    <LiffSection id="risk-review-slots" title={t('slots.title')}>
      <p className="text-ink-muted">{t('slots.hint')}</p>
      <ul className="flex flex-col">
        {view.slots.map((slot) => (
          <li key={slot.slotNo} className="flex flex-col gap-1 border-t border-line py-3">
            <p className="break-words">
              {t('slots.slot', { no: slot.slotNo, parts: partsText(t, slot.riskDomains) })}
              {slot.mine ? <span className="text-ink-muted">{` · ${t('slots.mine')}`}</span> : null}
            </p>
            <LiffStatusBadge look={SLOT_BADGE[slot.status]} label={t(`slots.status.${slot.status}`)} />
          </li>
        ))}
      </ul>
    </LiffSection>
  )
}

export default async function LiffRiskReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, page, t, locale] = await Promise.all([params, liffPage(), getTranslations('liffRisk.review'), getLocale().then((l): Locale => (l === 'en' ? 'en' : 'th'))])
  const back = { href: LIFF_START_PATH, label: t('back') }
  if (page.kind !== 'member') {
    return (
      <LiffFrame title={t('metaTitle')} back={back}>
        <LiffContent>
          <LiffGate mode="member" state={page.kind} />
        </LiffContent>
      </LiffFrame>
    )
  }

  const found = await riskReviewTask(page.ctx, id)
  if (!found.ok) {
    // Not theirs, moved or gone: nothing of the task is said (NOT_FOUND for anyone who may not read it)
    return (
      <LiffFrame title={t('notYours')} back={back}>
        <LiffContent>
          <LiffNotice tone="warning">{found.error.code === 'MODULE_DISABLED' ? t('moduleOff') : t('notYoursHint')}</LiffNotice>
          <LiffLink href={LIFF_START_PATH}>{t('toHome')}</LiffLink>
        </LiffContent>
      </LiffFrame>
    )
  }

  const view = found.data
  const td = await getTranslations('liffRisk.review.decide')
  const number = view.assessment.number ?? '-'
  const open = view.status === 'OPEN' && view.canDecide
  const overdue = view.status === 'OPEN' && view.dueAt.getTime() <= page.ctx.now.getTime()
  const supplier = locale === 'en' && view.assessment.supplier.nameEn ? view.assessment.supplier.nameEn : view.assessment.supplier.nameTh
  const tier = view.assessment.tier ? tierName(t, view.assessment.tier) : t('tierInherent', { tier: tierName(t, view.assessment.inherentTier) })

  const details = (
    <>
      <header className="flex flex-col gap-2">
        <p className="font-medium break-words text-ink-muted">{supplier}</p>
        {view.onBehalfOfName ? <p className="text-ink-muted">{t('onBehalfOf', { name: view.onBehalfOfName })}</p> : null}
        {view.status === 'OPEN' ? <LiffStatusBadge look={overdue ? STEP_BADGES.OVERDUE : STEP_BADGES.OPEN} label={overdue ? t('overdue') : t('waiting')} /> : null}
        <SlotState view={view} t={t} locale={locale} />
        {/* Decided or closed: back to the LINE chat where the card was (inside the LINE app only) */}
        {open ? null : <BackToChat label={td('backToChat')} />}
      </header>
      <Facts
        label={t('summary')}
        items={[
          { label: t('tier'), value: tier },
          { label: t('parts'), value: partsText(t, view.riskDomains) },
          { label: t('due'), value: overdue ? `${formatDateTime(locale, view.dueAt)} · ${t('overdue')}` : formatDateTime(locale, view.dueAt) },
        ]}
      />
      <Questions view={view} t={t} locale={locale} />
      <Slots view={view} t={t} />
    </>
  )

  const words: RiskDecisionWords = {
    barLabel: td('barLabel'),
    pass: td('pass'),
    confirmText: td('confirmText', { number }),
    confirm: td('confirm'),
    checkFirst: td('checkFirst'),
    passed: td('passed'),
    returnLink: td('returnLink'),
    returnTitle: td('returnTitle'),
    returnHint: td('returnHint'),
    reason: td('reason'),
    reasonHint: td('reasonHint'),
    share: td('share'),
    shareHint: td('shareHint'),
    confirmReturn: td('confirmReturn'),
    submitReturn: td('submitReturn'),
    returned: td('returned'),
    working: td('working'),
    reasonError: td('reasonError'),
    confirmError: td('confirmError'),
    signedOut: td('signedOut'),
    failed: td('failed'),
    reload: td('reload'),
  }
  return (
    <LiffFrame title={t('heading', { number })} back={back}>
      <LiffRiskDecision taskId={view.taskId} open={open} words={words} decide={decideLiffRiskReviewAction}>
        {details}
      </LiffRiskDecision>
    </LiffFrame>
  )
}
