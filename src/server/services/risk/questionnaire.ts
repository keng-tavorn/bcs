import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AppError, Result } from '@/core/result'
import {
  lintQuestionnaire,
  RISK_DOMAINS,
  RISK_QUESTION_CODE,
  RISK_TIER_CODES,
  riskConditionProblem,
  selectQuestions,
  type QuestionnaireLintIssue,
  type RiskCondition,
  type RiskQuestionDef,
  type RiskTierCode,
} from '@/core/risk'
import { RISK_HELP_MAX, RISK_OPTION_POINTS_MAX, RISK_TEXT_MAX } from '@/lib/constants'
import { RISK_QUESTIONNAIRE_MACHINE, transition, type RiskQuestionnaireState } from '@/core/state-machines'
import { authorize } from '@/server/authz'
import { systemCtx, type Ctx } from '@/server/context'
import { DB_NULL } from '@/server/db/json'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { riskPolicyInEffect } from './tiers'

// The versions of the risk questionnaire (S11-04 · BR-RSK-01 · BR-RSK-02 · ADR-221 · ADR-229): ORG_ADMIN or DOA_ADMIN
// drafts a version (a copy of the one in effect, or empty), edits its questions in forms, and sends it for publishing
// after the lint (RISK_LINT_*); someone else publishes it or sends it back. A published version takes effect at its
// effectiveFrom and supersedes the one before it then — at once when that time has come, else by the daily job
// (supersedeDueQuestionnaires). An assessment keeps the version it was opened with (BR-RSK-01).

type Fail = { readonly ok: false; readonly error: AppError }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })

async function questionnaireGuard(tx: TenantTx, ctx: Ctx): Promise<{ ok: true; memberId: string } | Fail> {
  const on = await requireModule(ctx, 'RISK', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'admin.riskQuestionnaire')
  if (!may.ok) return { ok: false, error: may.error }
  if (may.data.kind !== 'member') return fail('FORBIDDEN', 'members only')
  return { ok: true, memberId: may.data.memberId }
}

// ---------- the shape of a question (RiskQuestion · options as data, never code) ----------

const OptionInput = z.strictObject({
  code: z.string().trim().regex(/^[A-Z0-9_]{1,20}$/),
  labelTh: z.string().trim().min(1).max(200),
  labelEn: z.string().trim().min(1).max(200),
  points: z.int().min(0).max(RISK_OPTION_POINTS_MAX),
  minTier: z.enum(RISK_TIER_CODES).optional(),
  evidence: z.boolean().optional(),
})
export type RiskOptionInput = z.infer<typeof OptionInput>

const ConditionInput: z.ZodType<RiskCondition> = z.lazy(() =>
  z.union([
    z.strictObject({ all: z.array(ConditionInput).min(1).max(20) }),
    z.strictObject({ any: z.array(ConditionInput).min(1).max(20) }),
    z.strictObject({ field: z.string().min(1).max(40), op: z.string().min(1).max(10), value: z.unknown().optional() }),
  ]),
)

const QuestionInput = z.strictObject({
  code: z.string().trim().regex(RISK_QUESTION_CODE),
  domain: z.enum(RISK_DOMAINS),
  textTh: z.string().trim().min(1).max(RISK_TEXT_MAX),
  textEn: z.string().trim().min(1).max(RISK_TEXT_MAX),
  helpTh: z.string().trim().max(RISK_HELP_MAX).nullable().optional(),
  helpEn: z.string().trim().max(RISK_HELP_MAX).nullable().optional(),
  options: z.array(OptionInput).min(2).max(10),
  appliesWhen: ConditionInput.nullable().optional(),
  required: z.boolean().default(true),
  evidenceScopeRequired: z.boolean().default(false),
  evidenceScope: z.string().trim().max(100).nullable().optional(),
  aiReadable: z.boolean().default(false),
})
export type RiskQuestionInput = z.input<typeof QuestionInput>

const VersionRef = { versionId: z.uuid(), expectedVersion: z.int().min(0) }

type VersionRow = NonNullable<Awaited<ReturnType<typeof loadVersion>>>
const loadVersion = (tx: TenantTx, id: string) => tx.riskQuestionnaire.findFirst({ where: { id }, include: { questions: { orderBy: { sortOrder: 'asc' } } } })

/** The version for an edit: found, at the version the screen read, and the command allowed from its status */
async function versionFor(tx: TenantTx, input: { versionId: string; expectedVersion: number }, command: Parameters<typeof transition<RiskQuestionnaireState, (typeof RISK_QUESTIONNAIRE_MACHINE.commands)[number]>>[2]): Promise<{ ok: true; row: VersionRow; to: RiskQuestionnaireState } | Fail> {
  const row = await loadVersion(tx, input.versionId)
  if (!row) return fail('NOT_FOUND', 'questionnaire version not found')
  if (row.version !== input.expectedVersion) return fail('CONFLICT_VERSION', 'the version changed since it was read')
  const t = transition(RISK_QUESTIONNAIRE_MACHINE, row.status, command)
  if (!t.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${row.status}`, { from: row.status, command })
  return { ok: true, row, to: t.to }
}

/** The version in effect at a time: PUBLISHED, started, not ended; the latest start wins (BR-RSK-01) */
export async function questionnaireInEffect(tx: TenantTx, at: Date) {
  return tx.riskQuestionnaire.findFirst({
    where: { status: { in: ['PUBLISHED', 'SUPERSEDED'] }, effectiveFrom: { lte: at }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }] },
    orderBy: { effectiveFrom: 'desc' },
    include: { questions: { orderBy: { sortOrder: 'asc' } } },
  })
}

const questionData = (q: z.infer<typeof QuestionInput>) => ({
  domain: q.domain,
  textTh: q.textTh,
  textEn: q.textEn,
  helpTh: q.helpTh ?? null,
  helpEn: q.helpEn ?? null,
  options: q.options as object,
  appliesWhen: q.appliesWhen ? (q.appliesWhen as object) : DB_NULL,
  required: q.required,
  evidenceScopeRequired: q.evidenceScopeRequired,
  evidenceScope: q.evidenceScope ? q.evidenceScope : null,
  aiReadable: q.aiReadable,
})

// ---------- admin.riskQuestionnaire.draft ----------

const draftCommand = defineCommand({
  name: 'admin.riskQuestionnaire.draft',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ code: z.string().trim().regex(/^[A-Z][A-Z0-9-]{1,39}$/) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionId: string; versionNo: number }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const open = await tx.riskQuestionnaire.findFirst({ where: { code: input.code, status: { in: ['DRAFT', 'PENDING_PUBLISH'] } }, select: { versionNo: true } })
    if (open) return fail('VALIDATION_FAILED', `version ${open.versionNo} is still a draft`, { reason: 'DRAFT_EXISTS', versionNo: open.versionNo })
    const last = await tx.riskQuestionnaire.findFirst({ where: { code: input.code }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
    const inEffect = await questionnaireInEffect(tx, ctx.now)
    const source = inEffect?.code === input.code ? inEffect : null
    const versionNo = (last?.versionNo ?? 0) + 1
    const created = await tx.riskQuestionnaire.create({ data: { organizationId: ctx.organizationId, code: input.code, versionNo, effectiveFrom: ctx.now }, select: { id: true } })
    for (const q of source?.questions ?? []) {
      await tx.riskQuestion.create({
        data: {
          organizationId: ctx.organizationId,
          questionnaireId: created.id,
          code: q.code,
          domain: q.domain,
          textTh: q.textTh,
          textEn: q.textEn,
          helpTh: q.helpTh,
          helpEn: q.helpEn,
          kind: q.kind,
          options: q.options as object,
          appliesWhen: q.appliesWhen === null ? DB_NULL : (q.appliesWhen as object),
          required: q.required,
          evidenceScopeRequired: q.evidenceScopeRequired,
          evidenceScope: q.evidenceScope,
          aiReadable: q.aiReadable,
          sortOrder: q.sortOrder,
        },
      })
    }
    return {
      ok: true,
      result: { versionId: created.id, versionNo },
      events: [{ type: 'risk_questionnaire.drafted', aggregateType: 'RiskQuestionnaire', aggregateId: created.id, data: { code: input.code, versionNo, copiedFromVersionNo: source?.versionNo ?? null, questions: source?.questions.length ?? 0 } }],
    }
  },
})

// ---------- .updateQuestion · .removeQuestion · .reorder (DRAFT only) ----------

const updateQuestionCommand = defineCommand({
  name: 'admin.riskQuestionnaire.updateQuestion',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ ...VersionRef, question: QuestionInput }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ questionCode: string }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.updateQuestion')
    if (!v.ok) return v
    const q = input.question
    const problem = q.appliesWhen ? riskConditionProblem(q.appliesWhen) : null
    if (problem) return fail('VALIDATION_FAILED', 'the condition reads what an assessment does not have', { field: 'appliesWhen', reason: 'CONDITION', problem })
    if (q.options.filter((o) => o.evidence === true).length > 1) return fail('VALIDATION_FAILED', 'one option at most is chosen by evidence', { field: 'options', reason: 'OPTION_EVIDENCE' })
    if (new Set(q.options.map((o) => o.code)).size !== q.options.length) return fail('VALIDATION_FAILED', 'an option code appears twice', { field: 'options', reason: 'OPTION_DUPLICATE' })
    if (q.evidenceScopeRequired && !q.evidenceScope) return fail('VALIDATION_FAILED', 'a question that needs a scope names it', { field: 'evidenceScope', reason: 'SCOPE_REQUIRED' })
    const existing = v.row.questions.find((x) => x.code === q.code)
    if (existing) await tx.riskQuestion.update({ where: { id: existing.id }, data: questionData(q) })
    else {
      const sortOrder = (v.row.questions.at(-1)?.sortOrder ?? 0) + 10
      await tx.riskQuestion.create({ data: { organizationId: ctx.organizationId, questionnaireId: v.row.id, code: q.code, sortOrder, ...questionData(q) } })
    }
    await tx.riskQuestionnaire.update({ where: { id: v.row.id }, data: { version: { increment: 1 } } })
    return { ok: true, result: { questionCode: q.code }, events: [{ type: 'risk_questionnaire.updated', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { questionCode: q.code, action: existing ? 'CHANGED' : 'ADDED' } }] }
  },
})

const removeQuestionCommand = defineCommand({
  name: 'admin.riskQuestionnaire.removeQuestion',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ ...VersionRef, questionCode: z.string().trim().regex(RISK_QUESTION_CODE) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ questionCode: string }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.removeQuestion')
    if (!v.ok) return v
    const q = v.row.questions.find((x) => x.code === input.questionCode)
    if (!q) return fail('NOT_FOUND', 'question not found')
    await tx.riskQuestion.delete({ where: { id: q.id } })
    await tx.riskQuestionnaire.update({ where: { id: v.row.id }, data: { version: { increment: 1 } } })
    return { ok: true, result: { questionCode: q.code }, events: [{ type: 'risk_questionnaire.updated', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { questionCode: q.code, action: 'REMOVED' } }] }
  },
})

const reorderCommand = defineCommand({
  name: 'admin.riskQuestionnaire.reorder',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ ...VersionRef, questionCodes: z.array(z.string().trim().regex(RISK_QUESTION_CODE)).min(1).max(200) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ count: number }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.reorder')
    if (!v.ok) return v
    const have = v.row.questions.map((q) => q.code).sort()
    if (have.join() !== input.questionCodes.slice().sort().join()) return fail('VALIDATION_FAILED', 'the order names every question of the version once', { field: 'questionCodes', reason: 'NOT_A_PERMUTATION' })
    for (const [i, code] of input.questionCodes.entries()) {
      await tx.riskQuestion.update({ where: { id: v.row.questions.find((q) => q.code === code)!.id }, data: { sortOrder: (i + 1) * 10 } })
    }
    await tx.riskQuestionnaire.update({ where: { id: v.row.id }, data: { version: { increment: 1 } } })
    return { ok: true, result: { count: input.questionCodes.length }, events: [{ type: 'risk_questionnaire.updated', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { questionCode: null, action: 'REORDERED' } }] }
  },
})

// ---------- .submitForPublish (lint) · .publish (someone else) · .reject ----------

const lintQuestionOf = (q: VersionRow['questions'][number]) => ({
  code: q.code,
  options: z.array(OptionInput).catch([]).parse(q.options),
  appliesWhen: (q.appliesWhen as RiskCondition | null) ?? null,
  evidenceScopeRequired: q.evidenceScopeRequired,
  evidenceScope: q.evidenceScope,
})

/** The lint of a version against the active document types of the organization (BR-RSK-05 · S7's linkedRiskQuestionCodes) */
async function lintVersion(tx: TenantTx, row: VersionRow): Promise<{ errors: QuestionnaireLintIssue[]; warnings: QuestionnaireLintIssue[] }> {
  const types = await tx.supplierDocumentType.findMany({ where: { active: true }, select: { code: true, singleInstance: true, linkedRiskQuestionCodes: true } })
  return lintQuestionnaire(row.questions.map(lintQuestionOf), types)
}

/** The checksum of what is published: the questions in order with every field that changes an assessment */
function checksumOf(row: VersionRow): string {
  const canonical = row.questions.map((q) => [q.code, q.domain, q.textTh, q.textEn, q.options, q.appliesWhen, q.required, q.evidenceScopeRequired, q.evidenceScope, q.aiReadable, q.sortOrder])
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** A PUBLISHED version of the same code that starts at or after `from`: one version in effect at a time (as BR-WF-12) */
async function laterVersionScheduled(tx: TenantTx, row: { id: string; code: string }, from: Date): Promise<Fail | null> {
  const later = await tx.riskQuestionnaire.findFirst({ where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, effectiveFrom: { gte: from } }, select: { versionNo: true } })
  return later ? fail('VALIDATION_FAILED', `version ${later.versionNo} takes effect at the same or a later time`, { field: 'effectiveFrom', reason: 'LATER_VERSION_SCHEDULED', versionNo: later.versionNo }) : null
}

const submitCommand = defineCommand({
  name: 'admin.riskQuestionnaire.submitForPublish',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ ...VersionRef, effectiveFrom: z.iso.datetime({ offset: true }), changeReason: z.string().trim().min(1).max(RISK_TEXT_MAX) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ warnings: QuestionnaireLintIssue[] }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.submitForPublish')
    if (!v.ok) return v
    const effectiveFrom = new Date(input.effectiveFrom)
    if (effectiveFrom.getTime() < ctx.now.getTime()) return fail('VALIDATION_FAILED', 'the effective time is in the past', { field: 'effectiveFrom', reason: 'EFFECTIVE_IN_PAST' })
    const later = await laterVersionScheduled(tx, v.row, effectiveFrom)
    if (later) return later
    const lint = await lintVersion(tx, v.row)
    if (lint.errors.length > 0) return fail('VALIDATION_FAILED', 'the version does not pass the lint', { reason: 'RISK_LINT', errors: lint.errors, warnings: lint.warnings })
    await tx.riskQuestionnaire.update({
      where: { id: v.row.id },
      data: { status: v.to, effectiveFrom, changeReason: input.changeReason, checksum: checksumOf(v.row), submittedById: who.memberId, submittedAt: ctx.now, version: { increment: 1 } },
    })
    return {
      ok: true,
      result: { warnings: lint.warnings },
      events: [{ type: 'risk_questionnaire.submitted', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { code: v.row.code, versionNo: v.row.versionNo, effectiveFrom: effectiveFrom.toISOString(), questions: v.row.questions.length, warnings: lint.warnings.length } }],
    }
  },
})

/** Supersede the PUBLISHED versions of `code` that a version in effect at `now` follows; their effectiveTo is its start */
async function supersedeBefore(tx: TenantTx, row: { id: string; code: string }, effectiveFrom: Date, now: Date): Promise<EventDraft[]> {
  const events: EventDraft[] = []
  const before = await tx.riskQuestionnaire.findMany({ where: { code: row.code, status: 'PUBLISHED', id: { not: row.id }, effectiveFrom: { lt: effectiveFrom } } })
  for (const p of before) {
    const due = effectiveFrom.getTime() <= now.getTime()
    if (due) {
      const t = transition(RISK_QUESTIONNAIRE_MACHINE, p.status, 'risk_questionnaire.supersede')
      if (!t.ok) continue
      await tx.riskQuestionnaire.update({ where: { id: p.id }, data: { status: t.to, effectiveTo: effectiveFrom, version: { increment: 1 } } })
      events.push({ type: 'risk_questionnaire.superseded', aggregateType: 'RiskQuestionnaire', aggregateId: p.id, data: { code: p.code, versionNo: p.versionNo, supersededById: row.id } })
    } else if (p.effectiveTo === null || p.effectiveTo.getTime() > effectiveFrom.getTime()) {
      await tx.riskQuestionnaire.update({ where: { id: p.id }, data: { effectiveTo: effectiveFrom, version: { increment: 1 } } })
    }
  }
  return events
}

const publishCommand = defineCommand({
  name: 'admin.riskQuestionnaire.publish',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject(VersionRef),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionNo: number; inEffect: boolean }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.publish')
    if (!v.ok) return v
    // someone other than who sent it (BR-RSK-02 · CHECK risk_questionnaire_shape)
    if (v.row.submittedById === who.memberId) return fail('VALIDATION_FAILED', 'the member who sent a version does not publish it', { reason: 'SAME_EDITOR' })
    if (v.row.checksum !== checksumOf(v.row)) return fail('CONFLICT_VERSION', 'the questions changed after the version was sent', { reason: 'CHECKSUM' })
    // a time already passed while it waited takes effect now
    const effectiveFrom = v.row.effectiveFrom.getTime() < ctx.now.getTime() ? ctx.now : v.row.effectiveFrom
    const later = await laterVersionScheduled(tx, v.row, effectiveFrom)
    if (later) return later
    const lint = await lintVersion(tx, v.row)
    if (lint.errors.length > 0) return fail('VALIDATION_FAILED', 'the version does not pass the lint', { reason: 'RISK_LINT', errors: lint.errors, warnings: lint.warnings })
    await tx.riskQuestionnaire.update({ where: { id: v.row.id }, data: { status: v.to, effectiveFrom, publishedById: who.memberId, publishedAt: ctx.now, version: { increment: 1 } } })
    const superseded = await supersedeBefore(tx, v.row, effectiveFrom, ctx.now)
    const inEffect = effectiveFrom.getTime() <= ctx.now.getTime()
    return {
      ok: true,
      result: { versionNo: v.row.versionNo, inEffect },
      events: [
        { type: 'risk_questionnaire.published', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { code: v.row.code, versionNo: v.row.versionNo, effectiveFrom: effectiveFrom.toISOString(), submittedById: v.row.submittedById!, publishedById: who.memberId } },
        ...superseded,
      ],
    }
  },
})

const rejectCommand = defineCommand({
  name: 'admin.riskQuestionnaire.reject',
  capability: 'admin.riskQuestionnaire',
  input: z.strictObject({ ...VersionRef, reason: z.string().trim().min(1).max(RISK_TEXT_MAX) }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ versionNo: number }>> {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const v = await versionFor(tx, input, 'admin.riskQuestionnaire.reject')
    if (!v.ok) return v
    if (v.row.submittedById === who.memberId) return fail('VALIDATION_FAILED', 'the member who sent a version does not decide it', { reason: 'SAME_EDITOR' })
    await tx.riskQuestionnaire.update({ where: { id: v.row.id }, data: { status: v.to, submittedById: null, submittedAt: null, checksum: null, version: { increment: 1 } } })
    return { ok: true, result: { versionNo: v.row.versionNo }, events: [{ type: 'risk_questionnaire.rejected', aggregateType: 'RiskQuestionnaire', aggregateId: v.row.id, data: { code: v.row.code, versionNo: v.row.versionNo, submittedById: v.row.submittedById!, reason: input.reason } }] }
  },
})

export const draftRiskQuestionnaire = (ctx: Ctx, input: { code: string }, options: RunOptions) => runCommand(ctx, draftCommand, input, options)
export const updateRiskQuestion = (ctx: Ctx, input: z.input<typeof updateQuestionCommand.input>, options: RunOptions) => runCommand(ctx, updateQuestionCommand, input, options)
export const removeRiskQuestion = (ctx: Ctx, input: z.input<typeof removeQuestionCommand.input>, options: RunOptions) => runCommand(ctx, removeQuestionCommand, input, options)
export const reorderRiskQuestions = (ctx: Ctx, input: z.input<typeof reorderCommand.input>, options: RunOptions) => runCommand(ctx, reorderCommand, input, options)
export const submitRiskQuestionnaire = (ctx: Ctx, input: z.input<typeof submitCommand.input>, options: RunOptions) => runCommand(ctx, submitCommand, input, options)
export const publishRiskQuestionnaire = (ctx: Ctx, input: z.input<typeof publishCommand.input>, options: RunOptions) => runCommand(ctx, publishCommand, input, options)
export const rejectRiskQuestionnaire = (ctx: Ctx, input: z.input<typeof rejectCommand.input>, options: RunOptions) => runCommand(ctx, rejectCommand, input, options)

// ---------- the daily job: a published version whose time has come supersedes the one before (risk-review-daily) ----------

const supersedeDueCommand = defineCommand({
  name: 'risk_questionnaire.supersede',
  capability: 'system.risk',
  input: z.strictObject({ versionId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ superseded: number }>> {
    const on = await requireModule(ctx, 'RISK', tx)
    if (!on.ok) return { ok: false, error: on.error }
    const row = await tx.riskQuestionnaire.findFirst({ where: { id: input.versionId, status: 'PUBLISHED' }, select: { id: true, code: true, effectiveFrom: true } })
    if (!row) return fail('NOT_FOUND', 'published version not found')
    if (row.effectiveFrom.getTime() > ctx.now.getTime()) return fail('VALIDATION_FAILED', 'not in effect yet', { reason: 'NOT_DUE' })
    const events = await supersedeBefore(tx, row, row.effectiveFrom, ctx.now)
    if (events.length === 0) return fail('INVALID_STATE_TRANSITION', 'nothing to supersede', { reason: 'NOTHING_TO_SUPERSEDE' })
    return { ok: true, result: { superseded: events.length }, events }
  },
})

/** For each published version in effect at `now` that still has a PUBLISHED one before it: supersede that one */
export async function supersedeDueQuestionnaires(organizationId: string, now: Date): Promise<number> {
  const due = await forTenant(organizationId).riskQuestionnaire.findMany({ where: { status: 'PUBLISHED', effectiveFrom: { lte: now } }, select: { id: true, code: true, effectiveFrom: true } })
  let count = 0
  for (const v of due) {
    const older = due.some((o) => o.code === v.code && o.id !== v.id && o.effectiveFrom.getTime() < v.effectiveFrom.getTime())
    if (!older) continue
    const r = await runCommand(systemCtx(organizationId, now, 'risk-review-daily'), supersedeDueCommand, { versionId: v.id }, { idempotencyKey: `risk-review-daily:supersede:${v.id}` })
    if (r.ok) count += r.data.superseded
  }
  return count
}

// ---------- /admin/risk/questionnaire ----------

export interface QuestionnaireVersionView {
  readonly id: string
  readonly code: string
  readonly versionNo: number
  readonly status: RiskQuestionnaireState
  readonly effectiveFrom: Date
  readonly effectiveTo: Date | null
  readonly questions: number
  readonly submittedByName: string | null
  readonly publishedByName: string | null
  readonly submittedByMe: boolean
}

/** The versions of the organization, newest first (admin.riskQuestionnaire) */
export async function listRiskQuestionnaires(ctx: Ctx): Promise<Result<QuestionnaireVersionView[]>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const rows = await tx.riskQuestionnaire.findMany({
      orderBy: [{ code: 'asc' }, { versionNo: 'desc' }],
      include: { _count: { select: { questions: true } }, submittedBy: { select: { displayNameTh: true } }, publishedBy: { select: { displayNameTh: true } } },
    })
    return {
      ok: true as const,
      data: rows.map((r) => ({
        id: r.id,
        code: r.code,
        versionNo: r.versionNo,
        status: r.status,
        effectiveFrom: r.effectiveFrom,
        effectiveTo: r.effectiveTo,
        questions: r._count.questions,
        submittedByName: r.submittedBy?.displayNameTh ?? null,
        publishedByName: r.publishedBy?.displayNameTh ?? null,
        submittedByMe: r.submittedById === who.memberId,
      })),
    }
  })
}

export interface QuestionView {
  readonly code: string
  readonly domain: (typeof RISK_DOMAINS)[number]
  readonly textTh: string
  readonly textEn: string
  readonly helpTh: string | null
  readonly helpEn: string | null
  readonly options: RiskOptionInput[]
  readonly appliesWhen: RiskCondition | null
  readonly required: boolean
  readonly evidenceScopeRequired: boolean
  readonly evidenceScope: string | null
  readonly aiReadable: boolean
  readonly sortOrder: number
}

export interface QuestionnaireDetailView extends QuestionnaireVersionView {
  readonly version: number
  readonly changeReason: string | null
  readonly questionList: QuestionView[]
  readonly lint: { errors: QuestionnaireLintIssue[]; warnings: QuestionnaireLintIssue[] }
}

const viewOf = (q: VersionRow['questions'][number]): QuestionView => ({
  code: q.code,
  domain: q.domain,
  textTh: q.textTh,
  textEn: q.textEn,
  helpTh: q.helpTh,
  helpEn: q.helpEn,
  options: z.array(OptionInput).catch([]).parse(q.options),
  appliesWhen: (q.appliesWhen as RiskCondition | null) ?? null,
  required: q.required,
  evidenceScopeRequired: q.evidenceScopeRequired,
  evidenceScope: q.evidenceScope,
  aiReadable: q.aiReadable,
  sortOrder: q.sortOrder,
})

/** One version with its questions and its lint as it stands (admin.riskQuestionnaire) */
export async function riskQuestionnaireDetail(ctx: Ctx, versionId: string): Promise<Result<QuestionnaireDetailView>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const row = await tx.riskQuestionnaire.findFirst({
      where: { id: versionId },
      include: { questions: { orderBy: { sortOrder: 'asc' } }, submittedBy: { select: { displayNameTh: true } }, publishedBy: { select: { displayNameTh: true } } },
    })
    if (!row) return fail('NOT_FOUND', 'questionnaire version not found')
    return {
      ok: true as const,
      data: {
        id: row.id,
        code: row.code,
        versionNo: row.versionNo,
        status: row.status,
        effectiveFrom: row.effectiveFrom,
        effectiveTo: row.effectiveTo,
        questions: row.questions.length,
        submittedByName: row.submittedBy?.displayNameTh ?? null,
        publishedByName: row.publishedBy?.displayNameTh ?? null,
        submittedByMe: row.submittedById === who.memberId,
        version: row.version,
        changeReason: row.changeReason,
        questionList: row.questions.map(viewOf),
        lint: await lintVersion(tx, row),
      },
    }
  })
}

const PreviewInput = z.strictObject({
  screening: z.strictObject({ processesPersonalData: z.enum(['Y', 'N']), accessesSystems: z.enum(['Y', 'N']), accessesPremises: z.enum(['Y', 'N']) }),
  categoryCodes: z.array(z.string().trim().min(1).max(30)).max(20),
  payeeType: z.enum(['JURISTIC', 'INDIVIDUAL', 'FOREIGN']),
  isForeign: z.boolean(),
})

/**
 * The dry-run of the question set: which questions a version asks for a screening context, and the tier from screening,
 * with the policy in effect (BR-RSK-01 · BR-RSK-03). Reads only; RISK_POLICY_NOT_CONFIGURED when the policy is not confirmed.
 */
export async function previewRiskQuestionSet(ctx: Ctx, versionId: string, input: z.input<typeof PreviewInput>): Promise<Result<{ inherentTier: RiskTierCode; questions: string[] }>> {
  const parsed = PreviewInput.safeParse(input)
  if (!parsed.success) return fail('VALIDATION_FAILED', 'the screening context is not complete', { reason: 'SCREENING_REQUIRED' })
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const who = await questionnaireGuard(tx, ctx)
    if (!who.ok) return who
    const row = await loadVersion(tx, versionId)
    if (!row) return fail('NOT_FOUND', 'questionnaire version not found')
    const policy = await riskPolicyInEffect(tx)
    if (!policy.ok) return policy
    const questions: RiskQuestionDef[] = row.questions.map((q) => ({ ...lintQuestionOf(q), domain: q.domain, required: q.required, sortOrder: q.sortOrder }))
    const set = selectQuestions(questions, parsed.data, policy.data)
    return { ok: true as const, data: { inherentTier: set.inherentTier, questions: [...set.questions] } }
  })
}
