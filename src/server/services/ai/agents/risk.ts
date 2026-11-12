import { createHash } from 'node:crypto'
import { checkAiText, checkRiskDraft, renderValue } from '@/core/ai-checks'
import { AI_FILE_MEDIA_TYPES, getAiClient, type AiFileMediaType } from '@/integrations/ai'
import { readObject } from '@/integrations/storage'
import { AI_LIMITS, DECISION_ADVICE_WORDS, modelForPurpose, RISK_PROFILE } from '@/lib/ai-config'
import { RiskAnswerDraft, riskDraftInputText, RiskSummaryText, riskSummaryInputText } from '@/lib/ai-schemas/agents'
import { MS_PER_MINUTE } from '@/lib/constants'
import { getEnv } from '@/lib/env'
import { systemCtx, type Ctx } from '@/server/context'
import { forTenant } from '@/server/db/tenant'
import { riskAnswerPath, riskAssessmentOpen, riskDraftSource, riskFacts, riskSummarySource, RISK_ASSIST_TYPE, type RiskAiFile, type RiskFacts } from '../../risk/ai-assist'
import { completeAgentAction, expireAgentAction, requestAgentAction } from '../actions'
import { asDataValues } from '../data'
import { aiRuntime, checkCallGates } from '../gate'

// The Risk Agent (S11-13 · FR-AI-306 · ADR-228 · BR-AI-33 BR-AI-34), started by the system only, through every gate of
// BR-AI-11, with settings.risk.aiAssist on and never for a supplier who is a person, on the organization's credits:
//  - RISK_ANSWER_DRAFT (L1 · job risk-ai-draft): once an assessment opens, comes back, or a document of its supplier is
//    verified, the agent reads the files BR-AI-34 lets it read and proposes an option for each question they answer.
//    checkRiskDraft (ai-risk-verify) checks each one; a DRAFT keeps them for the contact or procurement to confirm one by
//    one with riskAssessment.answer / .fillOnBehalf + aiAssist (paths answers.<questionCode>).
//  - RISK_FILE_SUMMARY (L0 · job risk-ai-summary): once a reviewer's task is assigned, sentences on the slot's own part,
//    every value a placeholder of a fact code built (BR-AI-27, profile RISK), and the questions a file contradicts.
// The agent never scores, sets a tier, decides a review, asks for or approves an override, or opens the PO gate
// (BR-AI-01 · BR-RSK-04 · INV-AI-05): it writes AgentAction only. With AI off nothing is called and nothing written before
// is shown, except a draft already taken in whose answers still wait (EG-1 · AC6).

const DRAFT = 'RISK_ANSWER_DRAFT' as const
const SUMMARY = 'RISK_FILE_SUMMARY' as const
/** BR-AI-33: calls a minute per assessment (no member starts them) */
const CALLS_PER_MINUTE_PER_ASSESSMENT = 10
const QUOTE_MAX = 300

const finishAs = (organizationId: string, now: Date, promptVersion: string, agentActionId: string, model: string) => (input: Omit<Parameters<typeof completeAgentAction>[3], 'agentActionId' | 'requestedModel'>) =>
  completeAgentAction(organizationId, now, promptVersion, { agentActionId, requestedModel: model, ...input })

/** The files the adapter can take (type and size); others are left out of the call */
const sendable = (files: readonly RiskAiFile[]) => files.filter((f) => (AI_FILE_MEDIA_TYPES as readonly string[]).includes(f.mimeType) && f.sizeBytes <= AI_LIMITS.maxFileBytes)

const fileRefs = (files: readonly RiskAiFile[]) => files.map((f) => ({ label: f.label, kind: f.kind, ref: f.ref }))

const digestOf = (files: readonly RiskAiFile[], questions: readonly string[]) =>
  createHash('sha256')
    .update(JSON.stringify([files.map((f) => f.fileId), questions]))
    .digest('hex')
    .slice(0, 16)

/**
 * A run of an action of `key` before: one that stopped after its call started (PENDING) goes on through the gates again;
 * one that ended stays as it ended, with no call (a retry of the job never calls twice)
 */
async function earlierRun(organizationId: string, ctx: Ctx, key: string, purpose: typeof DRAFT | typeof SUMMARY) {
  const before = await forTenant(organizationId).agentAction.findFirst({ where: { idempotencyKey: key }, select: { id: true, status: true, promptVersion: true } })
  if (!before) return null
  if (before.status !== 'PENDING') return { done: before.status } as const
  const gates = await forTenant(organizationId).$transaction((tx) => checkCallGates(tx, ctx, purpose, null))
  return gates.ok ? ({ resume: { agentActionId: before.id, promptVersion: before.promptVersion } } as const) : ({ refused: gates.error.code } as const)
}

// ---------- RISK_ANSWER_DRAFT (L1 · AC1 AC2) ----------

export type RiskDraftRun = 'DRAFTED' | 'FAILED' | `SKIPPED_${string}`

/** Job risk-ai-draft: proposed answers for one open assessment, when every rule lets it (a refusal is a skip · EG-1) */
export async function draftRiskAnswers(organizationId: string, assessmentId: string, now: Date): Promise<RiskDraftRun> {
  const ctx = systemCtx(organizationId, now, 'risk-ai-draft')
  const db = forTenant(organizationId)
  const read = await db.$transaction((tx) => riskDraftSource(tx, ctx, assessmentId))
  if (!read.ok) return `SKIPPED_${read.skip}`
  const source = read.data
  const files = sendable(source.files)
  if (files.length === 0) return 'SKIPPED_NO_FILES'
  const recent = await db.agentAction.count({ where: { purpose: DRAFT, subjectType: RISK_ASSIST_TYPE, subjectId: assessmentId, createdAt: { gte: new Date(now.getTime() - MS_PER_MINUTE) } } })
  if (recent >= CALLS_PER_MINUTE_PER_ASSESSMENT) return 'SKIPPED_RATE_LIMITED'

  // one call per round and per what it reads: a retry finds its own action; a new document or answer asks again
  const asked = source.ask.map((q) => q.code)
  const key = `risk_draft:${assessmentId}:${source.reviewRound}:${digestOf(files, asked)}`
  const before = await earlierRun(organizationId, ctx, key, DRAFT)
  if (before && 'done' in before) return before.done === 'FAILED' ? 'FAILED' : 'SKIPPED_DRAFTED'
  if (before && 'refused' in before) return `SKIPPED_${before.refused}`
  const started = before
    ? { ok: true as const, data: before.resume }
    : await requestAgentAction(
        ctx,
        { purpose: DRAFT, subjectType: RISK_ASSIST_TYPE, subjectId: assessmentId, inputRefs: { assessmentId, reviewRound: source.reviewRound, questions: asked, files: fileRefs(files) }, idempotencyKey: key, ...(source.contactId ? { requestedByContactId: source.contactId } : {}) },
        { idempotencyKey: key },
      )
  if (!started.ok) return `SKIPPED_${started.error.code}`
  const { agentActionId, promptVersion } = started.data
  const model = modelForPurpose(DRAFT, aiRuntime().modelEnv)
  const finish = finishAs(organizationId, now, promptVersion, agentActionId, model)
  const ended = async (r: Awaited<ReturnType<typeof finish>>): Promise<RiskDraftRun> => (r.ok ? (r.data.status === 'DRAFT' ? 'DRAFTED' : 'FAILED') : `SKIPPED_${r.error.code}`)

  const bytes = await Promise.all(files.map((f) => readObject(f.storageKey)))
  const answer = await getAiClient(getEnv()).extract({
    purpose: DRAFT,
    model,
    schema: RiskAnswerDraft,
    text: riskDraftInputText({ questions: source.ask, files: files.map((f) => ({ label: f.label, kind: f.about })) }),
    files: files.map((f, i) => ({ bytes: bytes[i]!, mediaType: f.mimeType as AiFileMediaType })),
  })
  if (!answer.ok) return ended(await finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs }))
  // sent, cancelled or closed while the AI read: nobody would take the answers in
  if (!(await db.$transaction((tx) => riskAssessmentOpen(tx, assessmentId)))) return ended(await finish({ outcome: 'FAILED', model: answer.model, errorCode: 'SUBJECT_CLOSED', usage: answer.usage, latencyMs: answer.latencyMs }))

  // one answer per question, the first the model gave; the words copied are cut to their limit
  const seen = new Set<string>()
  const answers = answer.output.answers.filter((a) => (seen.has(a.questionCode) ? false : (seen.add(a.questionCode), true)))
  const verdict = checkRiskDraft({ questionSet: source.questionSet, evidenceAvailable: source.evidenceAvailable, answers })
  // proposed for the form: only answers the commands can take — a question asked, an option it has (a WARN stays, to be
  // looked at one by one); a question answered from a certificate is never proposed (EVIDENCE_LOCKED)
  const askedSet = new Set(asked)
  const failed = new Set(verdict.checks.filter((c) => c.result === 'FAIL').map((c) => c.questionCode))
  const proposed: Record<string, string> = {}
  for (const a of answers) if (askedSet.has(a.questionCode) && !failed.has(a.questionCode)) proposed[riskAnswerPath(a.questionCode)] = a.optionCode
  const labels = new Set(files.map((f) => f.label))
  const done = await finish({
    outcome: 'DRAFT',
    model: answer.model,
    output: { answers: answers.map((a) => ({ questionCode: a.questionCode, optionCode: a.optionCode, sourceRef: labels.has(a.sourceRef) ? a.sourceRef : null, quote: a.quote.trim().slice(0, QUOTE_MAX) || null })) },
    verification: { checks: verdict.checks },
    fieldConfidence: Object.fromEntries(Object.entries(verdict.confidenceBp).map(([code, bp]) => [riskAnswerPath(code), bp])),
    // every answer of the AI is confirmed one by one (BR-AI-33)
    review: { requiredPaths: Object.keys(proposed).sort(), confirmedPaths: [], proposed },
    usage: answer.usage,
    latencyMs: answer.latencyMs,
  })
  if (!done.ok || done.data.status !== 'DRAFT') return ended(done)
  // an earlier draft nobody took in is replaced by this one (the form shows one at a time)
  const earlier = await db.agentAction.findMany({ where: { purpose: DRAFT, subjectType: RISK_ASSIST_TYPE, subjectId: assessmentId, status: 'DRAFT', appliedAt: null, id: { not: agentActionId } }, select: { id: true } })
  for (const e of earlier) await expireAgentAction(organizationId, now, e.id, 'SUPERSEDED')
  return 'DRAFTED'
}

/**
 * The drafts nobody took in when an assessment leaves DRAFT or RETURNED (sent, cancelled): expired SUBJECT_CLOSED, so
 * their content is purged on the retention of BR-AI-18 (AC4)
 */
export async function closeRiskDrafts(organizationId: string, assessmentId: string, now: Date): Promise<number> {
  const db = forTenant(organizationId)
  if (await db.$transaction((tx) => riskAssessmentOpen(tx, assessmentId))) return 0
  const open = await db.agentAction.findMany({ where: { purpose: DRAFT, subjectType: RISK_ASSIST_TYPE, subjectId: assessmentId, status: 'DRAFT', appliedAt: null }, select: { id: true } })
  let closed = 0
  for (const a of open) if ((await expireAgentAction(organizationId, now, a.id, 'SUBJECT_CLOSED')).ok) closed += 1
  return closed
}

// ---------- RISK_FILE_SUMMARY (L0 · AC3) ----------

const factsText = (facts: RiskFacts, files: readonly RiskAiFile[]) =>
  riskSummaryInputText(asDataValues(Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, renderValue(v)]))), files.map((f) => ({ label: f.label, kind: f.about })))

export type RiskSummaryRun = 'WRITTEN' | 'FAILED' | `SKIPPED_${string}`

/** Job risk-ai-summary: the summary of one reviewer's task, once, key risk_summary:<taskId> (never in a LINE card) */
export async function writeRiskSummary(organizationId: string, taskId: string, now: Date): Promise<RiskSummaryRun> {
  const ctx = systemCtx(organizationId, now, 'risk-ai-summary')
  const read = await forTenant(organizationId).$transaction((tx) => riskSummarySource(tx, ctx, taskId))
  if (!read.ok) return `SKIPPED_${read.skip}`
  const source = read.data
  const key = `risk_summary:${taskId}`
  const before = await earlierRun(organizationId, ctx, key, SUMMARY)
  if (before && 'done' in before) return before.done === 'FAILED' ? 'FAILED' : 'SKIPPED_WRITTEN'
  if (before && 'refused' in before) return `SKIPPED_${before.refused}`
  const files = sendable(source.files)
  const started = before
    ? { ok: true as const, data: before.resume }
    : await requestAgentAction(ctx, { purpose: SUMMARY, subjectType: RISK_ASSIST_TYPE, subjectId: source.assessmentId, inputRefs: { taskId, assessmentId: source.assessmentId, files: fileRefs(files) }, idempotencyKey: key }, { idempotencyKey: key })
  if (!started.ok) return `SKIPPED_${started.error.code}`
  const { agentActionId, promptVersion } = started.data
  const model = modelForPurpose(SUMMARY, aiRuntime().modelEnv)
  const finish = finishAs(organizationId, now, promptVersion, agentActionId, model)
  const facts = riskFacts(source)
  const bytes = await Promise.all(files.map((f) => readObject(f.storageKey)))
  const call = { purpose: SUMMARY, model, schema: RiskSummaryText, text: factsText(facts, files) }
  const answer = files.length ? await getAiClient(getEnv()).extract({ ...call, files: files.map((f, i) => ({ bytes: bytes[i]!, mediaType: f.mimeType as AiFileMediaType })) }) : await getAiClient(getEnv()).write(call)
  if (!answer.ok) {
    const r = await finish({ outcome: 'FAILED', model: answer.model ?? null, errorCode: answer.errorCode, usage: answer.usage, latencyMs: answer.latencyMs })
    return r.ok ? 'FAILED' : `SKIPPED_${r.error.code}`
  }
  // a text that fails BR-AI-27 is thrown away whole: the reviewer keeps the file as it is
  const checked = checkAiText(answer.output.sentences, facts, RISK_PROFILE, DECISION_ADVICE_WORDS)
  if (!checked.ok) {
    const r = await finish({ outcome: 'FAILED', model: answer.model, errorCode: `AI_TEXT_${checked.reason}`, usage: answer.usage, latencyMs: answer.latencyMs })
    return r.ok ? 'FAILED' : `SKIPPED_${r.error.code}`
  }
  const codes = new Set(source.questions.filter((q) => q.answer !== null).map((q) => q.code))
  const inconsistent = [...new Set(answer.output.inconsistentQuestionCodes)].filter((c) => codes.has(c))
  const done = await finish({ outcome: 'DRAFT', model: answer.model, output: { sentences: answer.output.sentences, factKeys: Object.keys(facts).sort(), inconsistentQuestionCodes: inconsistent }, usage: answer.usage, latencyMs: answer.latencyMs })
  if (!done.ok) return `SKIPPED_${done.error.code}`
  return done.data.status === 'DRAFT' ? 'WRITTEN' : 'FAILED'
}
