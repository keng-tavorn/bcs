'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import type { AppError } from '@/core/result'
import { systemClock } from '@/lib/clock'
import { ctxFromSession } from '@/server/auth/session'
import {
  confirmRiskPolicy,
  confirmRiskTiers,
  discardRiskPolicy,
  discardRiskTiers,
  draftRiskQuestionnaire,
  previewRiskQuestionSet,
  proposeRiskPolicy,
  proposeRiskTiers,
  publishRiskQuestionnaire,
  rejectRiskQuestionnaire,
  removeRiskQuestion,
  reorderRiskQuestions,
  submitRiskQuestionnaire,
  updateRiskQuestion,
} from '@/server/services/risk'
import type { RiskAdminOutcome, RiskTierCodeUi, TierChangeInput } from '@/ui/risk-admin/model'
import type { PreviewInputUi, PreviewOutcome, QuestionUi } from '@/ui/risk-admin/questionnaire'
import type { PolicyValuesUi } from '@/ui/risk-admin/tiers'
import { getSession } from '../../../_lib/session'

// Browser-facing adapters of /admin/risk/tiers and /admin/risk/questionnaire (S11-04 · BR-RSK-02): the session, then the
// service, which checks the RISK module and admin.riskTiers or admin.riskQuestionnaire every time (BR-AUTH-05); a refusal
// comes back as its code and screen-safe reason only, never the service's message (§14.2).

const submissionKey = z.uuid()
const NO_SESSION: RiskAdminOutcome = { ok: false, code: 'UNAUTHENTICATED' }
const BAD_KEY: RiskAdminOutcome = { ok: false, code: 'VALIDATION_FAILED' }

async function currentCtx() {
  return ctxFromSession(await getSession(), 'WEB', systemClock.now())
}

function refused(error: AppError): RiskAdminOutcome {
  const details = error.details ?? {}
  const reason = typeof details.reason === 'string' ? details.reason : undefined
  const lint = Array.isArray(details.errors) ? (details.errors as { code: string; question?: string; documentType?: string; reason: string }[]) : undefined
  return { ok: false, code: error.code, ...(reason ? { reason } : {}), ...(lint ? { lint } : {}) }
}

async function run<T>(key: string, call: (ctx: NonNullable<Awaited<ReturnType<typeof currentCtx>>>) => Promise<{ ok: true; data: T } | { ok: false; error: AppError }>, path: string, id?: (data: T) => string): Promise<RiskAdminOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return NO_SESSION
  if (!submissionKey.safeParse(key).success) return BAD_KEY
  const r = await call(ctx)
  if (!r.ok) return refused(r.error)
  revalidatePath(path)
  return { ok: true, ...(id ? { id: id(r.data) } : {}) }
}

const TIERS = '/admin/risk/tiers'

export async function proposeTiersAction(changes: Partial<Record<RiskTierCodeUi, TierChangeInput>>, key: string) {
  return run(key, (ctx) => proposeRiskTiers(ctx, { changes }, { idempotencyKey: key }), TIERS)
}
export async function confirmTiersAction(rows: { code: RiskTierCodeUi; version: number }[], key: string) {
  return run(key, (ctx) => confirmRiskTiers(ctx, { rows }, { idempotencyKey: key }), TIERS)
}
export async function discardTiersAction(rows: { code: RiskTierCodeUi; version: number }[], key: string) {
  return run(key, (ctx) => discardRiskTiers(ctx, { rows }, { idempotencyKey: key }), TIERS)
}
export async function proposePolicyAction(changes: Partial<PolicyValuesUi>, key: string) {
  return run(key, (ctx) => proposeRiskPolicy(ctx, { changes: { ...changes, highRiskCategories: changes.highRiskCategories ? [...changes.highRiskCategories] : undefined } }, { idempotencyKey: key }), TIERS)
}
export async function confirmPolicyAction(version: number, key: string) {
  return run(key, (ctx) => confirmRiskPolicy(ctx, { version }, { idempotencyKey: key }), TIERS)
}
export async function discardPolicyAction(version: number, key: string) {
  return run(key, (ctx) => discardRiskPolicy(ctx, { version }, { idempotencyKey: key }), TIERS)
}

const QUESTIONNAIRE = '/admin/risk/questionnaire'
const versionPath = (id: string) => `${QUESTIONNAIRE}/${id}`

export async function draftQuestionnaireAction(code: string, key: string) {
  return run(key, (ctx) => draftRiskQuestionnaire(ctx, { code }, { idempotencyKey: key }), QUESTIONNAIRE, (d) => d.versionId)
}
export async function updateQuestionAction(versionId: string, expectedVersion: number, question: QuestionUi, key: string) {
  const q = { ...question, options: question.options.map((o) => ({ ...o })), appliesWhen: question.appliesWhen as never }
  return run(key, (ctx) => updateRiskQuestion(ctx, { versionId, expectedVersion, question: q }, { idempotencyKey: key }), versionPath(versionId))
}
export async function removeQuestionAction(versionId: string, expectedVersion: number, questionCode: string, key: string) {
  return run(key, (ctx) => removeRiskQuestion(ctx, { versionId, expectedVersion, questionCode }, { idempotencyKey: key }), versionPath(versionId))
}
export async function reorderQuestionsAction(versionId: string, expectedVersion: number, questionCodes: string[], key: string) {
  return run(key, (ctx) => reorderRiskQuestions(ctx, { versionId, expectedVersion, questionCodes }, { idempotencyKey: key }), versionPath(versionId))
}
/** The effective date is a calendar day of Asia/Bangkok: the version takes effect at its first moment (00:00 +07:00) */
export async function submitQuestionnaireAction(versionId: string, expectedVersion: number, effectiveDate: string, changeReason: string, key: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return BAD_KEY
  const start = new Date(`${effectiveDate}T00:00:00+07:00`)
  return run(
    key,
    (c) => {
      // today's date takes effect now rather than at a midnight already passed: the same clock the service compares with
      const effectiveFrom = start.getTime() < c.now.getTime() ? c.now.toISOString() : start.toISOString()
      return submitRiskQuestionnaire(c, { versionId, expectedVersion, effectiveFrom, changeReason }, { idempotencyKey: key })
    },
    versionPath(versionId),
  )
}
export async function publishQuestionnaireAction(versionId: string, expectedVersion: number, key: string) {
  return run(key, (ctx) => publishRiskQuestionnaire(ctx, { versionId, expectedVersion }, { idempotencyKey: key }), versionPath(versionId))
}
export async function rejectQuestionnaireAction(versionId: string, expectedVersion: number, reason: string, key: string) {
  return run(key, (ctx) => rejectRiskQuestionnaire(ctx, { versionId, expectedVersion, reason }, { idempotencyKey: key }), versionPath(versionId))
}

/** The dry-run of the question set reads only, so it needs no submission key */
export async function previewQuestionSetAction(versionId: string, input: PreviewInputUi): Promise<PreviewOutcome> {
  const ctx = await currentCtx()
  if (!ctx) return { ok: false, code: 'UNAUTHENTICATED' }
  const r = await previewRiskQuestionSet(ctx, versionId, { ...input, categoryCodes: [...input.categoryCodes] })
  if (!r.ok) return refused(r.error) as Extract<PreviewOutcome, { ok: false }>
  return { ok: true, inherentTier: r.data.inherentTier, questions: r.data.questions }
}
