import { randomUUID } from 'node:crypto'
import { portalRequest, postSession } from '@/server/portal/http'
import { portalRiskAssessment, type PortalRiskAssessment } from '@/server/portal/queries-risk'
import { portalQuestionSet } from '@/server/portal/risk-set'
import { isUuid } from '@/server/queries/requests'
import { answerRiskAssessment } from '@/server/services/risk/assessments'
import { field, forbiddenCsrf, formOf, notFound, seeOther } from '../../../_lib/respond'

// POST /portal/<org>/api/risk/answer (S11-05 · BR-RSK-17 · BR-RSK-05): the answers of the assessment page in one form —
// answer-<code> (the option chosen), note-<code>, confirm-<code> (an answer from a certificate confirmed) — sent to
// riskAssessment.answer with the version the page showed. Only the questions of the set present in the form, and of those
// only what changed: an answer from evidence goes only when confirmed (it is never changed by hand), a question with no
// option chosen and no answer is skipped, and an answer left as it was is not sent again (procurement's ON_BEHALF answers
// stay theirs). The service checks who, the state and every answer; the answer is the page with ?saved= or ?error=.

type AnswerItem = Parameters<typeof answerRiskAssessment>[1]['answers'][number]

const versionOf = (v: string): number => (/^\d{1,9}$/.test(v) ? Number(v) : -1)

function answersOf(form: FormData, a: PortalRiskAssessment): AnswerItem[] {
  const out: AnswerItem[] = []
  for (const q of portalQuestionSet(a)) {
    const names = { answer: `answer-${q.code}`, note: `note-${q.code}`, confirm: `confirm-${q.code}` }
    if (!form.has(names.answer) && !form.has(names.note) && !form.has(names.confirm)) continue
    const existing = a.answers.find((x) => x.questionCode === q.code && x.optionCode !== null)
    const note = form.has(names.note) ? field(form, names.note).trim() : undefined
    const withNote = note === undefined ? {} : { note }
    if (existing?.source === 'EVIDENCE') {
      if (field(form, names.confirm) !== '') out.push({ questionCode: q.code, optionCode: existing.optionCode, confirmEvidence: true, ...withNote })
      continue
    }
    const optionCode = field(form, names.answer)
    if (optionCode === '') continue
    if (existing && existing.optionCode === optionCode && (note === undefined || note === (existing.note ?? ''))) continue
    out.push({ questionCode: q.code, optionCode, ...withNote })
  }
  return out
}

export async function POST(request: Request, { params }: { params: Promise<{ org: string }> }) {
  const req = await portalRequest(request, (await params).org)
  if (!req) return notFound()
  const form = await formOf(request)
  const state = await postSession(request, req, field(form, 'csrf'), 'risk/answer')
  if (state === 'NONE') return notFound()
  if (state === 'CSRF') return forbiddenCsrf()
  const id = field(form, 'assessmentId')
  const assessment = isUuid(id) ? await portalRiskAssessment(state.ctx, id) : null
  if (!assessment) return seeOther(req.org, '/risk', { error: 'NOT_FOUND' })
  const page = `/risk/${assessment.id}`
  const answers = answersOf(form, assessment)
  if (answers.length === 0) return seeOther(req.org, page, { unchanged: 1 })
  const r = await answerRiskAssessment(state.ctx, { assessmentId: assessment.id, expectedVersion: versionOf(field(form, 'version')), answers }, { idempotencyKey: field(form, 'key') || randomUUID() })
  if (r.ok) return seeOther(req.org, page, { saved: 1 })
  const details: Readonly<Record<string, unknown>> = r.error.details ?? {}
  const reason = typeof details.reason === 'string' ? details.reason : undefined
  // the question it was refused for, when it is one of those sent: the page shows the words there
  const code = details.questionCode
  const question = typeof code === 'string' && answers.some((x) => x.questionCode === code) ? code : undefined
  return seeOther(req.org, question ? `${page}#q-${question}` : page, { error: r.error.code, reason, question })
}
