import { randomUUID } from 'node:crypto'
import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { RISK_EVIDENCE_FILES_PER_QUESTION } from '@/lib/constants'
import { portalRiskAssessment, type PortalRiskAnswer, type PortalRiskQuestion } from '@/server/portal/queries-risk'
import { portalQuestionSet } from '@/server/portal/risk-set'
import { isUuid } from '@/server/queries/requests'
import { checkboxClass, textareaClass } from '@/ui/liff/requests/classes'
import { PortalButton, PortalFrame, PortalNotice } from '@/ui/portal/frame'
import { one, pageOrg, pageSession, Unavailable, type SearchParams } from '../../_lib/page'

// /portal/[org]/risk/[id] (S11-05 · BR-RSK-17 · BR-RSK-05 · BR-RSK-06 · BR-RSK-18 · BR-AI-34 · FR-RSK-201 AC5): one
// assessment of the contact's own supplier. The questions of its set (portalQuestionSet: appliesWhen on its own context),
// by domain with GENERAL first, as radio groups with a note; an answer from a certificate (source EVIDENCE) is shown
// locked and can only be confirmed; one form saves every answer of the page, a second sends the assessment (the
// questions still missing come back in ?missing=); each answered question takes files (PDF, JPEG, PNG, WebP) with the
// uploader's choice whether the AI may read them (default not ticked). Forms only while DRAFT or RETURNED; the message
// procurement forwarded is shown when RETURNED. Never the points, a tier before completion or a reviewer's reasons.

type PortalT = Awaited<ReturnType<typeof getTranslations<'portal'>>>

const STATUSES = ['DRAFT', 'IN_REVIEW', 'RETURNED', 'COMPLETED', 'SUPERSEDED', 'CANCELLED'] as const
const DOMAINS = ['GENERAL', 'PRIVACY', 'INFOSEC', 'PREMISES', 'FINANCE'] as const
const SCANS = ['PENDING', 'CLEAN', 'INFECTED'] as const
const ERRORS = [
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT_VERSION',
  'INVALID_STATE_TRANSITION',
  'VALIDATION_FAILED',
  'RISK_ANSWERS_INCOMPLETE',
  'AI_REVIEW_PENDING',
  'RATE_LIMITED',
  'PRIVACY_NOTICE_OUTDATED',
  'MODULE_DISABLED',
] as const
const NOT_CONFIGURED = new Set(['RISK_TIER_NOT_CONFIGURED', 'RISK_POLICY_NOT_CONFIGURED'])
const REASONS = ['QUESTION_NOT_IN_SET', 'OPTION_UNKNOWN', 'EVIDENCE_LOCKED', 'ANSWER_FIRST', 'TYPE_NOT_ALLOWED', 'TOO_LARGE', 'EMPTY', 'PORTAL_ANSWERING_OFF'] as const
const EDITABLE = new Set(['DRAFT', 'RETURNED'])
/** The form every answer, note and confirmation of the page belongs to (the form attribute: the upload forms sit between them) */
const ANSWERS_FORM = 'risk-answers'
const NOTE_MAX = 500
const choiceClass = `${checkboxClass} mt-0.5`
const linkClass = 'text-primary underline underline-offset-4'

/** The words of ?error= and ?reason= as the routes send them back; an unknown code reads as a failure */
function errorText(t: PortalT, code: string, reason: string | undefined): string {
  if (reason === 'TOO_MANY_FILES') return t('risk.reasons.TOO_MANY_FILES', { max: RISK_EVIDENCE_FILES_PER_QUESTION })
  if (reason && (REASONS as readonly string[]).includes(reason)) return t(`risk.reasons.${reason as (typeof REASONS)[number]}`)
  if (NOT_CONFIGURED.has(code)) return t('risk.errors.NOT_CONFIGURED')
  return (ERRORS as readonly string[]).includes(code) ? t(`risk.errors.${code as (typeof ERRORS)[number]}`) : t('risk.errors.FAILED')
}

export default async function PortalRiskAssessmentPage({ params, searchParams }: { params: Promise<{ org: string; id: string }>; searchParams: SearchParams }) {
  const { org: orgCode, id } = await params
  const org = await pageOrg(orgCode)
  if (!org) return <Unavailable />
  const session = await pageSession(org)
  if (!session) redirect(`/portal/${org.code}/login`)
  const [t, locale, q, a] = await Promise.all([getTranslations('portal'), getLocale(), searchParams, isUuid(id) ? portalRiskAssessment(session.state.ctx, id) : Promise.resolve(null)])
  const back = (
    <a href={`/portal/${org.code}/risk`} className={linkClass}>
      {t('risk.assessment.back')}
    </a>
  )
  if (!a) {
    return (
      <PortalFrame organization={org.nameTh} title={t('risk.assessment.titleNoNumber')}>
        <PortalNotice tone="info">{t('risk.assessment.notFound')}</PortalNotice>
        {back}
      </PortalFrame>
    )
  }
  const en = locale === 'en'
  const editable = EDITABLE.has(a.status)
  const set = portalQuestionSet(a)
  const answers = new Map(a.answers.filter((x) => x.optionCode !== null).map((x) => [x.questionCode, x]))
  const groups = [...DOMAINS, 'OTHER' as const]
    .map((domain) => ({ domain, questions: set.filter((x) => (domain === 'OTHER' ? !(DOMAINS as readonly string[]).includes(x.domain) : x.domain === domain)) }))
    .filter((g) => g.questions.length > 0)
  const status = (STATUSES as readonly string[]).includes(a.status) ? t(`risk.status.${a.status as (typeof STATUSES)[number]}`) : a.status
  const missing = [...new Set((one(q.missing) ?? '').split(',').filter(Boolean))]
  const error = one(q.error)
  // the result of an upload (or of a refused answer of one question) is shown at that question, where the page returns
  const at = set.some((x) => x.code === one(q.question)) ? one(q.question) : undefined
  const notice: ReactNode = error ? (
    <PortalNotice tone="danger">
      <p>{errorText(t, error, one(q.reason))}</p>
      {missing.length ? (
        <div className="mt-2 flex flex-col gap-1">
          <p className="font-medium">{t('risk.assessment.missingTitle')}</p>
          <ul className="list-disc pl-5">
            {missing.map((code) => {
              const mq = set.find((x) => x.code === code)
              return (
                <li key={code}>
                  <a href={`#q-${code}`} className={linkClass}>
                    {mq ? (en ? mq.textEn : mq.textTh) : code}
                  </a>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
      {error === 'PRIVACY_NOTICE_OUTDATED' ? (
        <a href={`/portal/${org.code}`} className={linkClass}>
          {t('risk.privacyLink')}
        </a>
      ) : null}
    </PortalNotice>
  ) : one(q.uploaded) ? (
    <PortalNotice tone="success">{t('risk.evidence.uploaded')}</PortalNotice>
  ) : one(q.sent) ? (
    <PortalNotice tone="success">{t('risk.assessment.sent')}</PortalNotice>
  ) : one(q.saved) ? (
    <PortalNotice tone="success">{t('risk.assessment.saved')}</PortalNotice>
  ) : one(q.unchanged) ? (
    <PortalNotice tone="info">{t('risk.assessment.unchanged')}</PortalNotice>
  ) : null
  const hidden = (
    <>
      <input type="hidden" name="csrf" value={session.csrf} />
      <input type="hidden" name="assessmentId" value={a.id} />
    </>
  )
  return (
    <PortalFrame organization={org.nameTh} title={a.number ? t('risk.assessment.title', { number: a.number }) : t('risk.assessment.titleNoNumber')}>
      {at ? null : notice}
      <div className="flex flex-col gap-1">
        <p>{t('risk.assessment.status', { status })}</p>
        <p className="text-ink-muted">{t('risk.assessment.progress', { answered: set.filter((x) => answers.has(x.code)).length, total: set.length })}</p>
      </div>
      {a.returnReason ? (
        <PortalNotice tone="warning" role="status">
          <p className="font-medium">{t('risk.assessment.returned')}</p>
          <p className="whitespace-pre-line">{a.returnReason}</p>
        </PortalNotice>
      ) : null}
      {editable ? (
        <div className="flex flex-col gap-2 text-ink-muted">
          <p>{t('risk.assessment.intro')}</p>
          <p>{t('risk.evidence.uploadHint')}</p>
        </div>
      ) : (
        <PortalNotice tone="info">{t('risk.assessment.readOnly')}</PortalNotice>
      )}
      {groups.map((g) => (
        <section key={g.domain} aria-labelledby={`domain-${g.domain}`} className="flex flex-col gap-5 border-t border-line pt-5">
          <h2 id={`domain-${g.domain}`} className="text-lg font-semibold">
            {t(`risk.domain.${g.domain}`)}
          </h2>
          {g.questions.map((question) => (
            <Question
              key={question.code}
              t={t}
              en={en}
              question={question}
              answer={answers.get(question.code)}
              editable={editable}
              missing={missing.includes(question.code)}
              notice={at === question.code ? notice : null}
              upload={editable ? { action: `/portal/${org.code}/api/risk/evidence`, hidden, key: randomUUID() } : null}
            />
          ))}
        </section>
      ))}
      {editable ? (
        <>
          <form id={ANSWERS_FORM} method="post" action={`/portal/${org.code}/api/risk/answer`} className="flex flex-col gap-3 border-t border-line pt-5">
            {hidden}
            <input type="hidden" name="key" value={randomUUID()} />
            <input type="hidden" name="version" value={a.version} />
            <p className="text-ink-muted">{t('risk.assessment.saveHint')}</p>
            <PortalButton type="submit" className="w-full">
              {t('risk.assessment.save')}
            </PortalButton>
          </form>
          <section aria-labelledby="send" className="flex flex-col gap-3 border-t border-line pt-5">
            <h2 id="send" className="text-lg font-semibold">
              {t('risk.assessment.sendTitle')}
            </h2>
            <p className="text-ink-muted">{t('risk.assessment.sendHint')}</p>
            <form method="post" action={`/portal/${org.code}/api/risk/submit`}>
              {hidden}
              <input type="hidden" name="key" value={randomUUID()} />
              <input type="hidden" name="version" value={a.version} />
              <PortalButton type="submit" variant="secondary" className="w-full">
                {t('risk.assessment.send')}
              </PortalButton>
            </form>
          </section>
        </>
      ) : null}
      {back}
    </PortalFrame>
  )
}

function Question({
  t,
  en,
  question: q,
  answer,
  editable,
  missing,
  notice,
  upload,
}: {
  readonly t: PortalT
  readonly en: boolean
  readonly question: PortalRiskQuestion
  readonly answer: PortalRiskAnswer | undefined
  readonly editable: boolean
  readonly missing: boolean
  readonly notice: ReactNode
  readonly upload: { readonly action: string; readonly hidden: ReactNode; readonly key: string } | null
}) {
  const text = en ? q.textEn : q.textTh
  const help = en ? q.helpEn : q.helpTh
  const label = (o: PortalRiskQuestion['options'][number]) => (en ? o.labelEn : o.labelTh)
  const chosen = answer ? q.options.find((o) => o.code === answer.optionCode) : undefined
  // an answer a certificate gave is not changed by hand: it is confirmed or left (BR-RSK-05 · BR-RSK-06)
  const locked = answer?.source === 'EVIDENCE'
  const marks = (
    <>
      {q.required ? null : <p className="text-sm text-ink-muted">{t('risk.assessment.optional')}</p>}
      {help ? (
        <p id={`help-${q.code}`} className="whitespace-pre-line text-ink-muted">
          {help}
        </p>
      ) : null}
      {missing && editable ? <p className="font-medium text-danger">{t('risk.assessment.missingMark')}</p> : null}
      {locked && editable ? <p className="text-ink-muted">{t('risk.assessment.fromEvidence')}</p> : null}
      {answer?.source === 'ON_BEHALF' ? <p className="text-ink-muted">{t('risk.assessment.onBehalf')}</p> : null}
    </>
  )
  return (
    <div id={`q-${q.code}`} className="flex flex-col gap-3">
      {notice}
      {editable ? (
        <>
          <fieldset className="flex flex-col gap-1" aria-describedby={help ? `help-${q.code}` : undefined}>
            <legend className="mb-1 font-medium">{text}</legend>
            {marks}
            {q.options.map((o) => (
              <label key={o.code} className="flex min-h-11 items-start gap-3 py-2">
                <input type="radio" form={ANSWERS_FORM} name={`answer-${q.code}`} value={o.code} defaultChecked={answer?.optionCode === o.code} disabled={locked} className={choiceClass} />
                <span>{label(o)}</span>
              </label>
            ))}
            {locked ? (
              <label className="flex min-h-11 items-start gap-3 py-2">
                <input type="checkbox" form={ANSWERS_FORM} name={`confirm-${q.code}`} value="1" className={choiceClass} />
                <span className="font-medium">{t('risk.assessment.confirmEvidence')}</span>
              </label>
            ) : null}
          </fieldset>
          {/* a note goes with an answer the person gives: a certificate's answer takes one once it is confirmed */}
          {locked ? (
            answer?.note ? <p className="whitespace-pre-line text-ink-muted">{t('risk.assessment.noteValue', { note: answer.note })}</p> : null
          ) : (
            <>
              <label htmlFor={`note-${q.code}`} className="font-medium">
                {t('risk.assessment.note')}
              </label>
              <textarea id={`note-${q.code}`} name={`note-${q.code}`} form={ANSWERS_FORM} defaultValue={answer?.note ?? ''} maxLength={NOTE_MAX} className={textareaClass} />
            </>
          )}
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{text}</p>
          {marks}
          <p>{chosen ? t('risk.assessment.answer', { option: label(chosen) }) : t('risk.assessment.notAnswered')}</p>
          {answer?.note ? <p className="whitespace-pre-line text-ink-muted">{t('risk.assessment.noteValue', { note: answer.note })}</p> : null}
        </div>
      )}
      {answer ? (
        <div className="flex flex-col gap-2">
          <h3 className="font-medium">{t('risk.evidence.title')}</h3>
          {answer.files.length ? (
            <ul className="flex flex-col gap-2">
              {answer.files.map((f) => (
                <li key={f.fileId} className="flex flex-col">
                  <span className="break-all">{f.fileName}</span>
                  <span className="text-sm text-ink-muted">{(SCANS as readonly string[]).includes(f.scanStatus) ? t(`risk.scan.${f.scanStatus as (typeof SCANS)[number]}`) : f.scanStatus}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">{t('risk.evidence.none')}</p>
          )}
          {upload && answer.files.length >= RISK_EVIDENCE_FILES_PER_QUESTION ? <p className="text-ink-muted">{t('risk.evidence.full', { max: RISK_EVIDENCE_FILES_PER_QUESTION })}</p> : null}
          {upload && answer.files.length < RISK_EVIDENCE_FILES_PER_QUESTION ? (
            <form method="post" action={upload.action} encType="multipart/form-data" className="flex flex-col gap-2">
              {upload.hidden}
              <input type="hidden" name="key" value={upload.key} />
              <input type="hidden" name="questionCode" value={q.code} />
              <label htmlFor={`file-${q.code}`} className="font-medium">
                {t('risk.evidence.file')}
              </label>
              <input id={`file-${q.code}`} name="file" type="file" required accept="application/pdf,image/jpeg,image/png,image/webp" className="text-base" />
              <label className="flex min-h-11 items-start gap-3 py-2">
                {/* each file is its own consent (BR-AI-34): unticked unless the contact ticks it for this file */}
                <input type="checkbox" name="aiReadable" value="1" aria-describedby={`ai-${q.code}`} className={choiceClass} />
                <span>{t('risk.evidence.aiReadable')}</span>
              </label>
              <p id={`ai-${q.code}`} className="text-sm text-ink-muted">
                {t('risk.evidence.aiHint')}
              </p>
              <PortalButton type="submit" variant="secondary">
                {t('risk.evidence.upload')}
              </PortalButton>
            </form>
          ) : null}
        </div>
      ) : editable ? (
        <p className="text-sm text-ink-muted">{t('risk.evidence.answerFirst')}</p>
      ) : null}
    </div>
  )
}
