import { z } from 'zod'
import { agentActionTransition, creditPeriodMonth, creditsForCall, redactForAi, type AgentActionState } from '@/core/ai-checks'
import { err, ok, type Result } from '@/core/result'
import { AI_LIMITS, AI_PURPOSES, CONTENT_RETENTION_DAYS, DEFAULT_MIN_CONFIDENCE_BP, priceOf, type AiPurposeName } from '@/lib/ai-config'
import { BP_WHOLE, MS_PER_DAY, MS_PER_HOUR, MS_PER_MINUTE } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Capability } from '@/server/authz/permissions'
import { makeCtx, systemCtx, type Ctx } from '@/server/context'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { checkCreditUsage } from './credits'
import { checkCallGates, type CallPlan } from './gate'

// AgentAction (spec §12.2, docs/sub-specs/S13.md "Entity และ migration" "State machine" BR-AI-04 BR-AI-11 BR-AI-18
// BR-AI-23). An agent service asks for a call (agent_action.request: every gate of BR-AI-11 in the same transaction as
// the PENDING row), calls the adapter outside any transaction, then records the answer (agent_action.complete, actor
// AI_AGENT): DRAFT with the result or FAILED with the reason, and one USE row of credits when tokens were used. The
// result never writes a document: a person's own command takes it in with aiAssist (assist-contract.ts, S13-03).

export const SUBJECT_TYPES = ['REQUEST', 'PURCHASE_ORDER', 'GOODS_RECEIPT', 'INVOICE', 'APPROVAL_TASK', 'DOA_VERSION', 'CHAT_INTAKE'] as const

/** The capability a member needs to start a call of each purpose (§2.4); the Brief is started by the system only */
const CAPABILITY_OF_PURPOSE: Readonly<Record<AiPurposeName, Capability | null>> = {
  QUOTATION_READ: 'ai.assist',
  DELIVERY_NOTE_READ: 'ai.assist',
  INVOICE_READ: 'ai.assist',
  INTAKE: 'ai.assist',
  BRIEF: null,
  QUESTION: 'ai.ask',
  DOA_DRAFT: 'ai.doaDraft',
}

const fail = (code: 'FORBIDDEN' | 'NOT_FOUND' | 'INVALID_STATE_TRANSITION' | 'VALIDATION_FAILED', message: string, details?: Record<string, unknown>) =>
  ({ ok: false, error: { code, message, ...(details ? { details } : {}) } }) as const

/** Who may start a call of this purpose, before the gates (PLATFORM_ADMIN never: NG-12, §2.4) */
async function mayRequest(tx: TenantTx, ctx: Ctx, purpose: AiPurposeName): Promise<CommandOutcome<never> | null> {
  if (ctx.actor.type === 'SYSTEM') return purpose === 'BRIEF' ? null : fail('FORBIDDEN', 'the system starts only the Approval Brief')
  if (ctx.actor.type !== 'USER') return fail('FORBIDDEN', 'only a member of the organization uses AI')
  const capability = CAPABILITY_OF_PURPOSE[purpose]
  if (!capability) return fail('FORBIDDEN', 'the Approval Brief is started by the system')
  const allowed = await authorize(tx, ctx, capability, { ownerMemberIds: [ctx.actor.memberId] })
  return allowed.ok ? null : { ok: false, error: allowed.error }
}

// ---------- agent_action.request ----------

const RequestInput = z.strictObject({
  purpose: z.enum(AI_PURPOSES),
  subjectType: z.enum(SUBJECT_TYPES).optional(),
  subjectId: z.uuid().optional(),
  /** ids of files, documents, tasks, facts or tool results the call reads — never a copy of a document (BR-AI-04) */
  inputRefs: z.record(z.string(), z.unknown()).default({}),
  /** What the member typed on the web; redacted and cut to 2,000 characters before it is kept (BR-AI-18) */
  inputText: z.string().max(AI_LIMITS.maxInputTextChars * 10).optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
  conversationId: z.uuid().optional(),
})

export interface RequestedAction extends CallPlan {
  readonly agentActionId: string
}

export const requestAgentActionCommand = defineCommand({
  name: 'agent_action.request',
  capability: 'ai.assist',
  input: RequestInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<RequestedAction>> {
    if ((input.subjectType === undefined) !== (input.subjectId === undefined)) return fail('VALIDATION_FAILED', 'subjectType and subjectId go together', { field: 'subjectId' })
    const refused = await mayRequest(tx, ctx, input.purpose)
    if (refused) return refused
    const memberId = ctx.actor.type === 'USER' ? ctx.actor.memberId : null
    const gate = await checkCallGates(tx, ctx, input.purpose, memberId)
    if (!gate.ok) return { ok: false, error: gate.error }
    const plan = gate.data
    const row = await tx.agentAction.create({
      data: {
        organizationId: ctx.organizationId,
        agent: plan.agent,
        purpose: plan.purpose,
        level: plan.level,
        status: 'PENDING',
        subjectType: input.subjectType ?? null,
        subjectId: input.subjectId ?? null,
        requestedById: memberId,
        channel: ctx.channel,
        conversationId: input.conversationId ?? null,
        promptVersion: plan.promptVersion,
        inputRefs: input.inputRefs as object,
        inputText: input.inputText === undefined ? null : redactForAi(input.inputText).slice(0, AI_LIMITS.maxInputTextChars),
        idempotencyKey: input.idempotencyKey ?? null,
        // The business clock, so the rate limit and the expiry read the same time as the command (§4.3)
        createdAt: ctx.now,
      },
      select: { id: true },
    })
    return {
      ok: true,
      result: { agentActionId: row.id, ...plan },
      events: [
        {
          type: 'agent_action.requested',
          aggregateType: 'AgentAction',
          aggregateId: row.id,
          data: { agent: plan.agent, purpose: plan.purpose, level: plan.level, promptVersion: plan.promptVersion, subjectType: input.subjectType ?? null, subjectId: input.subjectId ?? null },
        },
      ],
    }
  },
})

/**
 * Starts a call: a new PENDING AgentAction, or — when `idempotencyKey` was used before in this organization — the action
 * of that key as it is now, without a new call or credits (intakeFromMessage of S17, docs/sub-specs/S13.md "interface").
 */
export async function requestAgentAction(ctx: Ctx, input: z.input<typeof RequestInput>, options: RunOptions): Promise<Result<RequestedAction & { readonly existing: boolean }>> {
  if (input.idempotencyKey) {
    const existing = await findByKey(ctx, input.idempotencyKey)
    if (existing) return replayOf(ctx, input, existing)
  }
  const r = await runCommand(ctx, requestAgentActionCommand, input, options)
  if (r.ok) return ok({ ...r.data, existing: false })
  // Two calls with one key at the same time: the second meets the unique key and answers with the first one's action
  if (input.idempotencyKey && r.error.code === 'INTERNAL') {
    const winner = await findByKey(ctx, input.idempotencyKey)
    if (winner) return replayOf(ctx, input, winner)
  }
  return r
}

const findByKey = (ctx: Ctx, idempotencyKey: string) =>
  forTenant(ctx.organizationId).agentAction.findFirst({
    where: { idempotencyKey },
    select: { id: true, agent: true, purpose: true, level: true, promptVersion: true, model: true, requestedById: true },
  })

async function replayOf(ctx: Ctx, input: z.input<typeof RequestInput>, existing: NonNullable<Awaited<ReturnType<typeof findByKey>>>): Promise<Result<RequestedAction & { readonly existing: boolean }>> {
  if (ctx.actor.type !== 'USER' || existing.requestedById !== ctx.actor.memberId) return err('FORBIDDEN', 'the key belongs to another member')
  if (existing.purpose !== input.purpose) return err('IDEMPOTENCY_CONFLICT', 'the key was used for another purpose', { field: 'idempotencyKey' })
  const setting = await forTenant(ctx.organizationId).aiAgentSetting.findFirst({ where: { agent: existing.agent }, select: { minConfidenceBp: true } })
  return ok({
    agentActionId: existing.id,
    agent: existing.agent,
    purpose: existing.purpose,
    level: existing.level,
    minConfidenceBp: setting?.minConfidenceBp ?? DEFAULT_MIN_CONFIDENCE_BP,
    model: existing.model ?? '',
    promptVersion: existing.promptVersion,
    existing: true,
  })
}

// ---------- agent_action.complete ----------

const Usage = z.strictObject({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheRead: z.number().int().nonnegative(), cacheWrite: z.number().int().nonnegative() })
const CompleteInput = z.strictObject({
  agentActionId: z.uuid(),
  outcome: z.enum(['DRAFT', 'FAILED']),
  /** The model that answered (absent when no answer came) */
  model: z.string().min(1).nullable(),
  /** The model that was asked: prices the call when the one that answered has no price */
  requestedModel: z.string().min(1),
  output: z.unknown().optional(),
  verification: z.unknown().optional(),
  fieldConfidence: z.record(z.string(), z.number().int().min(0).max(BP_WHOLE)).optional(),
  // proposed: what the AI put into the form by path, as text (assist-contract.ts); requiredPaths: confirmed one by one (BR-AI-16)
  review: z.strictObject({ requiredPaths: z.array(z.string().min(1)), confirmedPaths: z.array(z.string().min(1)), proposed: z.record(z.string().min(1), z.string()).default({}) }).optional(),
  errorCode: z.string().min(1).max(60).optional(),
  usage: Usage,
  latencyMs: z.number().int().nonnegative().nullable(),
})

export const completeAgentActionCommand = defineCommand({
  name: 'agent_action.complete',
  capability: 'ai.assist',
  input: CompleteInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ status: AgentActionState; costCredits: number }>> {
    const row = await tx.agentAction.findFirst({ where: { id: input.agentActionId }, select: { id: true, status: true, promptVersion: true, version: true, errorCode: true, costCredits: true } })
    if (!row) return fail('NOT_FOUND', 'no such AgentAction')
    // The answer is recorded by the agent that ran the prompt of this action, never by a person (INV-AI-01)
    if (ctx.actor.type !== 'AI_AGENT' || ctx.actor.agentId !== row.promptVersion) return fail('FORBIDDEN', 'only the agent of the action records its answer')
    if (input.outcome === 'DRAFT' && (input.output === undefined || input.model === null)) return fail('VALIDATION_FAILED', 'a draft needs the output and the model', { field: 'output' })
    if (input.outcome === 'FAILED' && !input.errorCode) return fail('VALIDATION_FAILED', 'a failure needs its code', { field: 'errorCode' })
    // An answer that comes after the sweep failed the call (TIMEOUT) is not used, but its tokens were spent: they are
    // recorded and charged on the FAILED row once (BR-AI-23)
    const late = row.status === 'FAILED' && row.errorCode === 'TIMEOUT' && row.costCredits === 0
    const move = late ? ({ ok: true, to: 'FAILED' } as const) : agentActionTransition(row.status, input.outcome === 'DRAFT' ? 'agent_action.complete' : 'agent_action.fail')
    if (!move.ok) return fail('INVALID_STATE_TRANSITION', `AgentAction is ${row.status}`)

    // A model without a price is possible in fixture mode only: live mode calls gated models, and every gate names a
    // priced one (tests/unit/ai-adapter.test.ts)
    const price = priceOf(input.model ?? '') ?? priceOf(input.requestedModel)
    const charge = price ? creditsForCall(price, input.usage) : { credits: 0, ledgerRow: false }
    await tx.agentAction.update({
      where: { id: row.id },
      data: {
        status: move.to,
        model: input.model,
        ...(late
          ? {}
          : input.outcome === 'DRAFT'
          ? {
              output: input.output as object,
              ...(input.verification === undefined ? {} : { verification: input.verification as object }),
              ...(input.fieldConfidence === undefined ? {} : { fieldConfidence: input.fieldConfidence }),
              ...(input.review === undefined ? {} : { review: input.review }),
            }
          : { errorCode: input.errorCode ?? null }),
        inputTokens: input.usage.input,
        outputTokens: input.usage.output,
        cacheReadTokens: input.usage.cacheRead,
        cacheWriteTokens: input.usage.cacheWrite,
        costCredits: charge.credits,
        latencyMs: input.latencyMs,
        version: { increment: 1 },
      },
    })
    if (charge.ledgerRow) {
      await tx.aiCreditLedger.create({
        data: {
          organizationId: ctx.organizationId,
          kind: 'USE',
          source: 'CALL',
          credits: charge.credits,
          periodMonth: new Date(`${creditPeriodMonth(ctx.now)}T00:00:00Z`),
          agentActionId: row.id,
          occurredAt: ctx.now,
        },
      })
    }
    const tokens = {
      inputTokens: input.usage.input,
      outputTokens: input.usage.output,
      cacheReadTokens: input.usage.cacheRead,
      cacheWriteTokens: input.usage.cacheWrite,
      costCredits: charge.credits,
    }
    const event: EventDraft = late
      ? { type: 'agent_action.failed', aggregateType: 'AgentAction', aggregateId: row.id, data: { errorCode: 'TIMEOUT', model: input.model, ...tokens } }
      : input.outcome === 'DRAFT'
        ? { type: 'agent_action.drafted', aggregateType: 'AgentAction', aggregateId: row.id, data: { model: input.model, latencyMs: input.latencyMs, ...tokens } }
        : { type: 'agent_action.failed', aggregateType: 'AgentAction', aggregateId: row.id, data: { errorCode: input.errorCode, model: input.model, ...tokens } }
    return { ok: true, result: { status: move.to, costCredits: charge.credits }, events: [event] }
  },
})

/**
 * Records the answer of a call as its agent (actor AI_AGENT, agentId = the prompt version) and then lets the credit
 * check tell the ORG_ADMINs when the month's spending reached its mark (a separate SYSTEM command: INV-AI-01).
 */
export async function completeAgentAction(organizationId: string, now: Date, promptVersion: string, input: z.input<typeof CompleteInput>) {
  const ctx = makeCtx({ organizationId, actor: { type: 'AI_AGENT', agentId: promptVersion }, channel: 'SYSTEM', now })
  const r = await runCommand(ctx, completeAgentActionCommand, input, { idempotencyKey: `agent_action.complete:${input.agentActionId}` })
  if (r.ok && r.data.costCredits > 0) await checkCreditUsage(organizationId, now, input.agentActionId)
  return r
}

// ---------- agent_action.reject · agent_action.give_feedback · agent_action.expire ----------

async function loadOwn(tx: TenantTx, ctx: Ctx, id: string) {
  const row = await tx.agentAction.findFirst({ where: { id }, select: { id: true, status: true, level: true, appliedAt: true, requestedById: true, purpose: true } })
  if (!row) return { error: fail('NOT_FOUND', 'no such AgentAction') }
  if (ctx.actor.type !== 'USER' || row.requestedById !== ctx.actor.memberId) return { error: fail('FORBIDDEN', 'only the member who asked decides on the result') }
  return { row }
}

export const rejectAgentActionCommand = defineCommand({
  name: 'agent_action.reject',
  capability: 'ai.assist',
  input: z.strictObject({ agentActionId: z.uuid() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ status: AgentActionState }>> {
    const { row, error } = await loadOwn(tx, ctx, input.agentActionId)
    if (error) return error
    // A draft already taken into a document is undone in the document, not here (BR-AI-17)
    if (row.level !== 'L1' || row.appliedAt) return fail('INVALID_STATE_TRANSITION', 'only an L1 draft nobody applied can be thrown away')
    const move = agentActionTransition(row.status, 'agent_action.reject')
    if (!move.ok) return fail('INVALID_STATE_TRANSITION', `AgentAction is ${row.status}`)
    await tx.agentAction.update({ where: { id: row.id }, data: { status: move.to, decidedById: ctx.actor.type === 'USER' ? ctx.actor.memberId : null, decidedAt: ctx.now, version: { increment: 1 } } })
    return { ok: true, result: { status: move.to }, events: [{ type: 'agent_action.rejected', aggregateType: 'AgentAction', aggregateId: row.id, data: {} }] }
  },
})

export const giveFeedbackCommand = defineCommand({
  name: 'agent_action.give_feedback',
  capability: 'ai.ask',
  input: z.strictObject({ agentActionId: z.uuid(), feedback: z.enum(['HELPFUL', 'NOT_HELPFUL']), note: z.string().trim().max(500).optional() }),
  async execute(tx, input, ctx): Promise<CommandOutcome<{ status: AgentActionState }>> {
    const { row, error } = await loadOwn(tx, ctx, input.agentActionId)
    if (error) return error
    if (row.level !== 'L0') return fail('INVALID_STATE_TRANSITION', 'feedback is for L0 results; an L1 draft is confirmed or changed instead')
    const move = agentActionTransition(row.status, 'agent_action.give_feedback')
    if (!move.ok) return fail('INVALID_STATE_TRANSITION', `AgentAction is ${row.status}`)
    await tx.agentAction.update({ where: { id: row.id }, data: { feedback: input.feedback, feedbackNote: input.note ? redactForAi(input.note) : null, version: { increment: 1 } } })
    return { ok: true, result: { status: move.to }, events: [{ type: 'agent_action.feedback_given', aggregateType: 'AgentAction', aggregateId: row.id, data: { feedback: input.feedback } }] }
  },
})

export function rejectAgentAction(ctx: Ctx, agentActionId: string, options: RunOptions) {
  return runCommand(ctx, rejectAgentActionCommand, { agentActionId }, options)
}

export function giveAgentFeedback(ctx: Ctx, input: { agentActionId: string; feedback: 'HELPFUL' | 'NOT_HELPFUL'; note?: string }, options: RunOptions) {
  return runCommand(ctx, giveFeedbackCommand, input, options)
}

/**
 * agent_action.expire, run by the system: one action replaced by a new reading (SUPERSEDED) or whose document closed
 * (SUBJECT_CLOSED), or — with no id — every L1 draft nobody applied for 24 hours (STALE) and every PENDING call past
 * 15 minutes (FAILED, TIMEOUT). A draft that is applied never goes STALE: it still holds its document back (BR-AI-17).
 */
const ExpireInput = z.union([
  z.strictObject({ agentActionId: z.uuid(), reason: z.enum(['SUPERSEDED', 'SUBJECT_CLOSED']) }),
  z.strictObject({ sweep: z.literal(true) }),
])

export const expireAgentActionsCommand = defineCommand({
  name: 'agent_action.expire',
  capability: 'ai.assist',
  input: ExpireInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ expired: number; failed: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'actions expire by the system only')
    const events: EventDraft[] = []
    let expired = 0
    let failed = 0
    const expire = async (id: string, reason: 'SUPERSEDED' | 'SUBJECT_CLOSED' | 'STALE') => {
      await tx.agentAction.update({ where: { id }, data: { status: 'EXPIRED', expireReason: reason, version: { increment: 1 } } })
      events.push({ type: 'agent_action.expired', aggregateType: 'AgentAction', aggregateId: id, data: { reason } })
      expired++
    }
    if ('agentActionId' in input) {
      const row = await tx.agentAction.findFirst({ where: { id: input.agentActionId }, select: { id: true, status: true } })
      if (!row) return fail('NOT_FOUND', 'no such AgentAction')
      if (!agentActionTransition(row.status, 'agent_action.expire').ok) return fail('INVALID_STATE_TRANSITION', `AgentAction is ${row.status}`)
      await expire(row.id, input.reason)
    } else {
      const pendingBefore = new Date(ctx.now.getTime() - AI_LIMITS.pendingTimeoutMinutes * MS_PER_MINUTE)
      const timedOut = await tx.agentAction.findMany({ where: { status: 'PENDING', createdAt: { lt: pendingBefore } }, select: { id: true }, orderBy: { id: 'asc' }, take: SWEEP_BATCH })
      for (const { id } of timedOut) {
        await tx.agentAction.update({ where: { id }, data: { status: 'FAILED', errorCode: 'TIMEOUT', version: { increment: 1 } } })
        events.push({
          type: 'agent_action.failed',
          aggregateType: 'AgentAction',
          aggregateId: id,
          data: { errorCode: 'TIMEOUT', model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costCredits: 0 },
        })
        failed++
      }
      const staleBefore = new Date(ctx.now.getTime() - AI_LIMITS.staleDraftHours * MS_PER_HOUR)
      const stale = await tx.agentAction.findMany({ where: { status: 'DRAFT', level: 'L1', appliedAt: null, createdAt: { lt: staleBefore } }, select: { id: true }, orderBy: { id: 'asc' }, take: SWEEP_BATCH })
      for (const { id } of stale) await expire(id, 'STALE')
    }
    if (events.length === 0) return fail('NOT_FOUND', 'nothing to expire')
    return { ok: true, result: { expired, failed }, events }
  },
})

const SWEEP_BATCH = 500
/** What a cleared JSON column holds (BR-AI-18): the row keeps its shape, not its content */
const PURGED = { purged: true } as const

export function expireAgentAction(organizationId: string, now: Date, agentActionId: string, reason: 'SUPERSEDED' | 'SUBJECT_CLOSED') {
  return runCommand(systemCtx(organizationId, now, 'ai-actions'), expireAgentActionsCommand, { agentActionId, reason }, { idempotencyKey: `agent_action.expire:${agentActionId}` })
}

// ---------- agent_action.purge_content (BR-AI-18) ----------

export const purgeContentCommand = defineCommand({
  name: 'agent_action.purge_content',
  capability: 'ai.assist',
  input: z.strictObject({}),
  async execute(tx, _input, ctx): Promise<CommandOutcome<{ purged: number }>> {
    if (ctx.actor.type !== 'SYSTEM') return fail('FORBIDDEN', 'content is cleared by the system only')
    const day = (n: number) => new Date(ctx.now.getTime() - n * MS_PER_DAY)
    const unpurged = { contentPurgedAt: null, appliedAt: null } as const
    // A chat intake nobody turned into a request: as long as the chat text of S17 (OQ-144)
    const chat = await tx.agentAction.findMany({ where: { ...unpurged, subjectType: 'CHAT_INTAKE', createdAt: { lt: day(CONTENT_RETENTION_DAYS.chatIntake) } }, select: { id: true }, take: SWEEP_BATCH })
    // Insight always, L1 results nobody used, and Briefs whose task is no longer open: as long as CommandLog
    const openTaskIds = (await tx.approvalTask.findMany({ where: { status: { in: ['OPEN', 'INFO_REQUESTED'] } }, select: { id: true } })).map((t) => t.id)
    const old = await tx.agentAction.findMany({
      where: {
        ...unpurged,
        createdAt: { lt: day(CONTENT_RETENTION_DAYS.unused) },
        // A row with no subject yet counts too (NOT on its own would drop the NULLs)
        AND: [
          { OR: [{ subjectType: null }, { subjectType: { not: 'CHAT_INTAKE' } }] },
          { OR: [{ purpose: 'QUESTION' }, { level: 'L1', status: { in: ['REJECTED', 'EXPIRED', 'FAILED'] } }, { purpose: 'BRIEF' }] },
          // A Brief stays while its task is open; filtered here, so open ones never fill the batch
          { OR: [{ NOT: { purpose: 'BRIEF' } }, { subjectId: null }, { NOT: { subjectId: { in: openTaskIds } } }] },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: SWEEP_BATCH,
    })
    const targets = [
      ...chat.map((r) => ({ id: r.id, reason: 'CHAT_INTAKE_UNUSED' as const })),
      ...old.map((r) => ({ id: r.id, reason: 'UNUSED_AFTER_RETENTION' as const })),
    ]
    if (targets.length === 0) return fail('NOT_FOUND', 'nothing to clear')
    const events: EventDraft[] = []
    for (const t of targets) {
      // The row stays with its metadata, credits and diff (BR-AI-04); what was typed and answered goes
      // review.proposed, verification and fieldConfidence repeat what the AI read, so they go too (an unapplied action
      // has no diff to keep)
      await tx.agentAction.update({
        where: { id: t.id },
        data: { inputText: null, output: PURGED, review: PURGED, verification: PURGED, fieldConfidence: PURGED, contentPurgedAt: ctx.now },
      })
      events.push({ type: 'agent_action.content_purged', aggregateType: 'AgentAction', aggregateId: t.id, data: { reason: t.reason } })
    }
    return { ok: true, result: { purged: targets.length }, events }
  },
})

/**
 * BR-LINE-11 (S17-08): the readings of chat drafts nobody took into a request lose their content in the same transaction
 * as the drafts' typed text (chat_intake.purge), so the AI's copy never outlives textRetentionDays, whatever
 * CONTENT_RETENTION_DAYS.chatIntake says. A reading applied to a request moved to that request (subject REQUEST) and is
 * kept as the request's. For the caller's transaction; the events go with its command's.
 */
export async function purgeChatIntakeAiContent(tx: TenantTx, ctx: Ctx, chatIntakeIds: readonly string[]): Promise<EventDraft[]> {
  if (ctx.actor.type !== 'SYSTEM' || chatIntakeIds.length === 0) return []
  const rows = await tx.agentAction.findMany({ where: { subjectType: 'CHAT_INTAKE', subjectId: { in: [...chatIntakeIds] }, contentPurgedAt: null }, select: { id: true }, orderBy: { id: 'asc' } })
  for (const { id } of rows) {
    await tx.agentAction.update({ where: { id }, data: { inputText: null, output: PURGED, review: PURGED, verification: PURGED, fieldConfidence: PURGED, contentPurgedAt: ctx.now } })
  }
  return rows.map(({ id }) => ({ type: 'agent_action.content_purged', aggregateType: 'AgentAction', aggregateId: id, data: { reason: 'CHAT_INTAKE_UNUSED' } }))
}

/** What the job ai-actions-expire runs for one organization each hour: the hour is the idempotency key */
export async function runAgentActionSweep(organizationId: string, now: Date) {
  const hour = now.toISOString().slice(0, 13)
  const ctx = systemCtx(organizationId, now, 'ai-actions-expire')
  const expired = await runCommand(ctx, expireAgentActionsCommand, { sweep: true }, { idempotencyKey: `ai-actions-expire:${hour}` })
  const purged = await runCommand(ctx, purgeContentCommand, {}, { idempotencyKey: `ai-actions-purge:${hour}` })
  return { expired: expired.ok ? expired.data : null, purged: purged.ok ? purged.data.purged : 0 }
}

// ---------- read: one AgentAction (BR-AI-04, docs/sub-specs/S13.md "ฐานของโมดูล" AC3) ----------

export interface AgentActionDto {
  readonly id: string
  readonly agent: string
  readonly purpose: string
  readonly level: string
  readonly status: string
  readonly subjectType: string | null
  readonly subjectId: string | null
  readonly requestedById: string | null
  readonly channel: string
  readonly promptVersion: string
  readonly model: string | null
  readonly errorCode: string | null
  readonly costCredits: number
  readonly latencyMs: number | null
  readonly createdAt: string
  /** Content: the member who asked and AUDITOR only; null for ORG_ADMIN reading metadata, and after BR-AI-18 cleared it */
  readonly content: {
    readonly inputText: string | null
    readonly output: unknown
    readonly verification: unknown
    readonly fieldConfidence: unknown
    readonly review: unknown
    readonly diff: unknown
  } | null
}

/**
 * One AgentAction for the screens and S17 (GET /api/ai/actions/[id]): the member who asked and AUDITOR see its content,
 * ORG_ADMIN sees its metadata only (ai.actions.view), PLATFORM_ADMIN and everyone else get FORBIDDEN.
 */
export async function getAgentAction(ctx: Ctx, id: string): Promise<Result<AgentActionDto>> {
  if (ctx.actor.type !== 'USER') return err('FORBIDDEN', 'only a member of the organization reads AI results')
  if (!z.uuid().safeParse(id).success) return err('NOT_FOUND', 'no such AgentAction')
  const memberId = ctx.actor.memberId
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const row = await tx.agentAction.findFirst({ where: { id } })
    if (!row) return err('NOT_FOUND', 'no such AgentAction')
    // The member who asked reads everything of their own call; anyone else needs ai.actions.view, where only AUDITOR
    // gets the content and ORG_ADMIN the metadata (§2.4)
    let content = row.requestedById === memberId
    if (!content) {
      const allowed = await authorize(tx, ctx, 'ai.actions.view', { ownerMemberIds: row.requestedById ? [row.requestedById] : [] })
      if (!allowed.ok) return err(allowed.error.code, allowed.error.message, allowed.error.details)
      content = allowed.data.kind === 'member' && allowed.data.roles.has('AUDITOR')
    }
    return ok({
      id: row.id,
      agent: row.agent,
      purpose: row.purpose,
      level: row.level,
      status: row.status,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      requestedById: row.requestedById,
      channel: row.channel,
      promptVersion: row.promptVersion,
      model: row.model,
      errorCode: row.errorCode,
      costCredits: row.costCredits,
      latencyMs: row.latencyMs,
      createdAt: row.createdAt.toISOString(),
      content: content
        ? { inputText: row.inputText, output: row.contentPurgedAt ? null : row.output, verification: row.verification, fieldConfidence: row.fieldConfidence, review: row.review, diff: row.diff }
        : null,
    })
  })
}
