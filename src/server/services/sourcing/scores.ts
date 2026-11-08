import { z } from 'zod'
import { satangToAmount } from '@/core/money/dto'
import type { AppError, Result } from '@/core/result'
import { checkSod } from '@/core/sod'
import { scorecardReveal, type EvaluatorStatus } from '@/core/sourcing'
import { SCORECARD_MACHINE, transition, type ScorecardCommand } from '@/core/state-machines'
import { RFX_SCORE_ENTRIES_MAX, RFX_SUMMARY_MAX } from '@/lib/constants'
import { authorize } from '@/server/authz'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import { forTenant, type TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import type { NotificationDraft } from '@/server/notifications/create'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { requireModule } from '../modules'
import { rfxReading } from './access'
import { gate, lockedRfx, scoringConflicts } from './rfx'
import { rankingData, rankingOf, type RankedRow } from './ranking'

// Scoring an RFx (S10-08 · ADR-205 · BR-RFX-09 BR-RFX-10 BR-RFX-18 · BR-SOD-14 · FR-SRC-203 AC1 AC2 AC3 AC5 AC6): once the
// RFx is closed (its bids are no longer sealed), each evaluator of its scorecard scores every QUALITY criterion of every
// bid sent, 0–100, on their own — saved as a draft, then sent once and never changed. Nobody reads another's scores
// before the reveal. The scorecard reveals itself in the transaction of the last evaluator's send (the Scorecard row is
// locked before the count, so two sends at once reveal once): every evaluator not recused has sent and at least
// minEvaluators did. PROCUREMENT adds evaluators (after the close with a reason, kept as a comment the award's facts
// show); an evaluator steps aside with a reason. BR-SOD-14 at the assignment and again at the send. The first score or
// added evaluator after the close moves the RFx to EVALUATING.

type Fail = { readonly ok: false; readonly error: AppError; readonly auditEvents?: readonly EventDraft[] }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false
const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)
const SCORING = new Set(['CLOSED', 'EVALUATING'])
const REASON = z.string().trim().min(3).max(500)

type Card = { id: string; status: string; version: number; minEvaluators: number; evaluators: Array<{ memberId: string; status: string }> }

/** The RFx (locked) and its scorecard, its row locked before anything is counted (BR-RFX-18) */
async function lockedCard(tx: TenantTx, ctx: Ctx, rfxEventId: string): Promise<Fail | { rfx: NonNullable<Awaited<ReturnType<typeof lockedRfx>>>; card: Card }> {
  const rfx = await lockedRfx(tx, ctx, rfxEventId)
  if (!rfx) return fail('NOT_FOUND', 'RFx not found')
  if (!rfx.scorecardId) return fail('VALIDATION_FAILED', 'the RFx has no scorecard', { field: 'rfxEventId', reason: 'NO_SCORECARD' })
  await lockRowsForUpdate(tx, 'Scorecard', ctx.organizationId, [rfx.scorecardId])
  const card = await tx.scorecard.findUniqueOrThrow({ where: { id: rfx.scorecardId }, select: { id: true, status: true, version: true, minEvaluators: true, evaluators: { select: { memberId: true, status: true } } } })
  return { rfx, card }
}

function cardStep(status: string, command: ScorecardCommand): Fail | null {
  const t = transition(SCORECARD_MACHINE, status as never, command)
  return t.ok ? null : fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${status}`, { from: status, command })
}

/** The evaluator acting: sourcing.score for an evaluator of this scorecard (ASSIGNED scope), else FORBIDDEN */
async function evaluatorOf(tx: TenantTx, ctx: Ctx, card: Card): Promise<Fail | { memberId: string; status: string }> {
  const on = await requireModule(ctx, 'SOURCING', tx)
  if (!on.ok) return { ok: false, error: on.error }
  const may = await authorize(tx, ctx, 'sourcing.score', { assigneeMemberIds: card.evaluators.map((e) => e.memberId) })
  if (!may.ok) return { ok: false, error: may.error }
  const me = card.evaluators.find((e) => e.memberId === memberOf(ctx))!
  return me
}

type Conflicts = Awaited<ReturnType<typeof scoringConflicts>>

/** BR-SOD-14 for one member against the RFx's conflicts (read once per command), with the refusal kept (security.sod_blocked) */
function sodOf(rfx: { id: string }, conflicts: Conflicts, memberId: string, action: string): Fail | null {
  const sod = checkSod({ kind: 'SCORE_RFX', actorMemberId: memberId, ...conflicts }, { approverMayReceive: false, requesterMayReceive: true })
  if (sod.ok) return null
  return {
    ok: false,
    error: { code: 'SOD_VIOLATION', message: 'this member may not score the RFx', details: { rule: sod.rule, memberId } },
    auditEvents: [{ type: 'security.sod_blocked', aggregateType: 'Security', aggregateId: rfx.id, data: { rule: sod.rule, action, subjectType: 'RFX_EVENT', subjectId: rfx.id, actorMemberId: memberId } }],
  }
}

/** CLOSED → EVALUATING at the first score or added evaluator; once, whoever comes first */
async function evaluating(tx: TenantTx, rfxEventId: string, by: 'SCORE' | 'EVALUATOR_ADDED'): Promise<EventDraft[]> {
  const moved = await tx.rfxEvent.updateMany({ where: { id: rfxEventId, status: 'CLOSED' }, data: { status: 'EVALUATING', version: { increment: 1 } } })
  return moved.count ? [{ type: 'rfx.evaluating', aggregateType: 'RfxEvent', aggregateId: rfxEventId, data: { by } }] : []
}

/**
 * The reveal (BR-RFX-09): every evaluator not recused has sent and at least minEvaluators did → REVEALED with the ranking
 * of rankBids, in this transaction; PROCUREMENT (the RFx's creator) is told
 */
async function revealIfComplete(
  tx: TenantTx,
  ctx: Ctx,
  rfx: { id: string; number: string | null; title: string; createdById: string },
  cardId: string,
): Promise<{ events: EventDraft[]; notifications: NotificationDraft[] }> {
  const card = await tx.scorecard.findUniqueOrThrow({ where: { id: cardId }, select: { status: true, minEvaluators: true, evaluators: { select: { memberId: true, status: true } } } })
  if (card.status !== 'LOCKED') return { events: [], notifications: [] }
  const reveal = scorecardReveal(card.minEvaluators, card.evaluators.map((e) => ({ memberId: e.memberId, status: e.status as EvaluatorStatus })))
  if (!reveal.revealed) return { events: [], notifications: [] }
  const ranking = await rankingOf(tx, cardId)
  await tx.scorecard.update({ where: { id: cardId }, data: { status: 'REVEALED', revealedAt: ctx.now, version: { increment: 1 } } })
  return {
    events: [{ type: 'scorecard.revealed', aggregateType: 'Scorecard', aggregateId: cardId, data: { rfxEventId: rfx.id, priceOnly: false, ranking: rankingData(ranking) } }],
    notifications: [{ recipientMemberId: rfx.createdById, templateKey: 'rfx.scored', data: { rfxEventId: rfx.id, number: rfx.number, title: rfx.title }, urgency: 'IMMEDIATE', dedupeKey: `rfx.scored:${rfx.id}`, subjectType: 'RfxEvent', subjectId: rfx.id }],
  }
}

// ---------- scorecard.assignEvaluators (PROCUREMENT) ----------

const AssignInput = z.strictObject({ rfxEventId: z.uuid(), expectedVersion: z.int().min(0), memberIds: z.array(z.uuid()).min(1).max(20), reason: REASON.optional() })

export const assignEvaluatorsCommand = defineCommand({
  name: 'scorecard.assignEvaluators',
  capability: 'sourcing.manage',
  input: AssignInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ scorecardId: string; version: number }>> {
    const refused = await gate(tx, ctx, 'sourcing.manage')
    if (refused) return refused
    const got = await lockedCard(tx, ctx, input.rfxEventId)
    if (isFail(got)) return got
    const { rfx, card } = got
    if (!['OPEN', ...SCORING].includes(rfx.status)) return fail('INVALID_STATE_TRANSITION', `evaluators are added while the RFx is open or scored, not ${rfx.status}`, { from: rfx.status, command: 'scorecard.assignEvaluators' })
    const stepRefused = cardStep(card.status, 'scorecard.assignEvaluators')
    if (stepRefused) return stepRefused
    if (input.expectedVersion !== card.version) return fail('CONFLICT_VERSION', 'the scorecard changed meanwhile', { expectedVersion: input.expectedVersion, version: card.version })
    // after the close procurement has seen every price: an evaluator added then needs a reason (the award's facts show it)
    const afterClose = rfx.status !== 'OPEN'
    if (afterClose && !input.reason) return fail('VALIDATION_FAILED', 'an evaluator added after the close needs a reason', { field: 'reason', reason: 'REASON_REQUIRED' })
    const memberIds = [...new Set(input.memberIds)]
    if (memberIds.some((id) => card.evaluators.some((e) => e.memberId === id))) return fail('VALIDATION_FAILED', 'already an evaluator of this scorecard', { field: 'memberIds', reason: 'ALREADY_EVALUATOR' })
    const members = await tx.member.findMany({ where: { id: { in: memberIds }, status: 'ACTIVE' }, select: { id: true } })
    if (members.length !== memberIds.length) return fail('VALIDATION_FAILED', 'an evaluator is not an active member', { field: 'memberIds', reason: 'MEMBER' })
    const conflicts = await scoringConflicts(tx, rfx)
    for (const memberId of memberIds) {
      const sod = sodOf(rfx, conflicts, memberId, 'scorecard.assignEvaluators')
      if (sod) return sod
    }
    await tx.scorecardEvaluator.createMany({ data: memberIds.map((memberId) => ({ organizationId: ctx.organizationId, scorecardId: card.id, memberId, assignedAt: ctx.now })) })
    const updated = await tx.scorecard.update({ where: { id: card.id }, data: { version: { increment: 1 } }, select: { version: true } })
    const reasonCommentId = afterClose ? (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'RfxEvent', subjectId: rfx.id, authorMemberId: memberOf(ctx), body: input.reason! }, select: { id: true } })).id : undefined
    const events: EventDraft[] = [
      { type: 'scorecard.evaluator_added', aggregateType: 'Scorecard', aggregateId: card.id, data: { rfxEventId: rfx.id, memberIds, afterClose, ...(reasonCommentId ? { reasonCommentId } : {}) } },
      ...(afterClose ? await evaluating(tx, rfx.id, 'EVALUATOR_ADDED') : []),
    ]
    // an evaluator added after the close is told the bids wait for their scores (as the others were at the close)
    const notifications: NotificationDraft[] = afterClose
      ? memberIds.map((memberId) => ({ recipientMemberId: memberId, templateKey: 'rfx.closed_internal', data: { rfxEventId: rfx.id, number: rfx.number, title: rfx.title, score: true }, urgency: 'IMMEDIATE', dedupeKey: `rfx.closed_internal:${rfx.id}:${memberId}`, subjectType: 'RfxEvent', subjectId: rfx.id }))
      : []
    return { ok: true, result: { scorecardId: card.id, version: updated.version }, events, notifications }
  },
})

// ---------- scorecard.recuse (the evaluator) ----------

const RecuseInput = z.strictObject({ rfxEventId: z.uuid(), reason: REASON })

export const recuseCommand = defineCommand({
  name: 'scorecard.recuse',
  capability: 'sourcing.score',
  input: RecuseInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ revealed: boolean }>> {
    const got = await lockedCard(tx, ctx, input.rfxEventId)
    if (isFail(got)) return got
    const { rfx, card } = got
    const me = await evaluatorOf(tx, ctx, card)
    if (isFail(me)) return me
    if (!['OPEN', ...SCORING].includes(rfx.status)) return fail('INVALID_STATE_TRANSITION', `an evaluator steps aside while the RFx is open or scored, not ${rfx.status}`, { from: rfx.status, command: 'scorecard.recuse' })
    const stepRefused = cardStep(card.status, 'scorecard.recuse')
    if (stepRefused) return stepRefused
    if (me.status !== 'ASSIGNED') return fail('INVALID_STATE_TRANSITION', `an evaluator who ${me.status === 'SUBMITTED' ? 'sent their scores' : 'stepped aside'} cannot step aside`, { from: me.status, command: 'scorecard.recuse' })
    await tx.scorecardEvaluator.updateMany({ where: { scorecardId: card.id, memberId: me.memberId }, data: { status: 'RECUSED', declaredInterest: true, recuseReason: input.reason } })
    await tx.scorecard.update({ where: { id: card.id }, data: { version: { increment: 1 } } })
    const events: EventDraft[] = [{ type: 'scorecard.evaluator_recused', aggregateType: 'Scorecard', aggregateId: card.id, data: { rfxEventId: rfx.id, memberId: me.memberId } }]
    // the last one missing may step aside: the others' scores are then complete
    const revealed = SCORING.has(rfx.status) ? await revealIfComplete(tx, ctx, rfx, card.id) : { events: [], notifications: [] }
    events.push(...revealed.events)
    return { ok: true, result: { revealed: revealed.events.length > 0 }, events, notifications: revealed.notifications }
  },
})

// ---------- score.save · score.submit (the evaluator) ----------

const Entry = z.strictObject({ bidId: z.uuid(), criterionCode: z.string().min(1).max(20), score: z.int().min(0).max(100), comment: z.string().trim().max(RFX_SUMMARY_MAX).optional() })
const SaveInput = z.strictObject({ rfxEventId: z.uuid(), entries: z.array(Entry).max(RFX_SCORE_ENTRIES_MAX).default([]) })

/** The checks of a save or a send, and the entries written as given (a draft of the evaluator's own) */
async function scoreable(tx: TenantTx, ctx: Ctx, rfxEventId: string, command: 'score.save' | 'score.submit') {
  const got = await lockedCard(tx, ctx, rfxEventId)
  if (isFail(got)) return got
  const { rfx, card } = got
  const me = await evaluatorOf(tx, ctx, card)
  if (isFail(me)) return me
  // before the close the bids are sealed: nothing to score yet (BR-RFX-06)
  if (!SCORING.has(rfx.status)) return fail('INVALID_STATE_TRANSITION', `bids are scored once the RFx is closed, not ${rfx.status}`, { from: rfx.status, command })
  const stepRefused = cardStep(card.status, command)
  if (stepRefused) return stepRefused
  if (me.status !== 'ASSIGNED') return fail('INVALID_STATE_TRANSITION', me.status === 'SUBMITTED' ? 'the scores were sent and cannot change' : 'the evaluator stepped aside', { from: me.status, command })
  return { ok: true as const, rfx, card, memberId: me.memberId }
}

async function writeEntries(tx: TenantTx, ctx: Ctx, rfxEventId: string, cardId: string, memberId: string, entries: z.infer<typeof Entry>[]): Promise<Fail | null> {
  if (!entries.length) return null
  const criteria = await tx.scoreCriterion.findMany({ where: { scorecardId: cardId }, select: { id: true, code: true, kind: true } })
  const byCode = new Map(criteria.map((c) => [c.code, c]))
  const bids = new Set((await tx.bid.findMany({ where: { rfxEventId, status: 'SUBMITTED' }, select: { id: true } })).map((b) => b.id))
  const seen = new Set<string>()
  for (const e of entries) {
    const c = byCode.get(e.criterionCode)
    if (!c) return fail('VALIDATION_FAILED', 'no such criterion on the scorecard', { field: 'entries', reason: 'CRITERION', criterionCode: e.criterionCode })
    // BR-RFX-09: the price is scored by the code from the amounts, never by hand
    if (c.kind === 'PRICE') return fail('VALIDATION_FAILED', 'the price criterion is computed', { field: 'entries', reason: 'PRICE_IS_COMPUTED', criterionCode: e.criterionCode })
    if (!bids.has(e.bidId)) return fail('VALIDATION_FAILED', 'not a bid sent on this RFx', { field: 'entries', reason: 'BID', bidId: e.bidId })
    const key = `${e.bidId}:${c.id}`
    if (seen.has(key)) return fail('VALIDATION_FAILED', 'a score given twice', { field: 'entries', reason: 'DUPLICATE_ENTRY' })
    seen.add(key)
  }
  for (const e of entries) {
    const criterionId = byCode.get(e.criterionCode)!.id
    await tx.scoreEntry.upsert({
      where: { organizationId_criterionId_bidId_evaluatorMemberId: { organizationId: ctx.organizationId, criterionId, bidId: e.bidId, evaluatorMemberId: memberId } },
      create: { organizationId: ctx.organizationId, scorecardId: cardId, criterionId, bidId: e.bidId, evaluatorMemberId: memberId, score: e.score, comment: e.comment ?? null },
      update: { score: e.score, comment: e.comment ?? null },
    })
  }
  return null
}

export const saveScoresCommand = defineCommand({
  name: 'score.save',
  capability: 'sourcing.score',
  input: SaveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ saved: number }>> {
    const got = await scoreable(tx, ctx, input.rfxEventId, 'score.save')
    if (isFail(got)) return got
    // a save of nothing records nothing (S10-08 review 4)
    if (!input.entries.length) return fail('VALIDATION_FAILED', 'no score to save', { field: 'entries', reason: 'EMPTY' })
    const wrote = await writeEntries(tx, ctx, got.rfx.id, got.card.id, got.memberId, input.entries)
    if (wrote) return wrote
    return {
      ok: true,
      result: { saved: input.entries.length },
      events: [{ type: 'score.saved', aggregateType: 'Scorecard', aggregateId: got.card.id, data: { rfxEventId: got.rfx.id, entries: input.entries.length } }, ...(await evaluating(tx, got.rfx.id, 'SCORE'))],
    }
  },
})

export const submitScoresCommand = defineCommand({
  name: 'score.submit',
  capability: 'sourcing.score',
  input: SaveInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ revealed: boolean }>> {
    const got = await scoreable(tx, ctx, input.rfxEventId, 'score.submit')
    if (isFail(got)) return got
    const { rfx, card, memberId } = got
    // BR-SOD-14 again at the send: an evaluator who became a requester of a source line meanwhile does not count
    const sod = sodOf(rfx, await scoringConflicts(tx, rfx), memberId, 'score.submit')
    if (sod) return sod
    const wrote = await writeEntries(tx, ctx, rfx.id, card.id, memberId, input.entries)
    if (wrote) return wrote
    // every QUALITY criterion of every bid sent and not disqualified (BR-RFX-09)
    const quality = await tx.scoreCriterion.findMany({ where: { scorecardId: card.id, kind: 'QUALITY' }, select: { id: true } })
    const bids = await tx.bid.findMany({ where: { rfxEventId: rfx.id, status: 'SUBMITTED' }, select: { id: true } })
    const mine = await tx.scoreEntry.findMany({ where: { scorecardId: card.id, evaluatorMemberId: memberId, bidId: { in: bids.map((b) => b.id) } }, select: { id: true, bidId: true, criterionId: true } })
    const have = new Set(mine.map((e) => `${e.bidId}:${e.criterionId}`))
    const missing = bids.flatMap((b) => quality.filter((c) => !have.has(`${b.id}:${c.id}`)).map(() => 1)).length
    if (missing) return fail('SCORES_INCOMPLETE', `${missing} scores are missing`, { missing })
    await tx.scoreEntry.updateMany({ where: { id: { in: mine.map((e) => e.id) } }, data: { submittedAt: ctx.now } })
    await tx.scorecardEvaluator.updateMany({ where: { scorecardId: card.id, memberId }, data: { status: 'SUBMITTED', submittedAt: ctx.now } })
    await tx.scorecard.update({ where: { id: card.id }, data: { version: { increment: 1 } } })
    const events: EventDraft[] = [{ type: 'score.submitted', aggregateType: 'Scorecard', aggregateId: card.id, data: { rfxEventId: rfx.id, memberId } }, ...(await evaluating(tx, rfx.id, 'SCORE'))]
    const revealed = await revealIfComplete(tx, ctx, rfx, card.id)
    events.push(...revealed.events)
    return { ok: true, result: { revealed: revealed.events.length > 0 }, events, notifications: revealed.notifications }
  },
})

export const assignEvaluators = (ctx: Ctx, input: z.input<typeof AssignInput>, opts: RunOptions) => runCommand(ctx, assignEvaluatorsCommand, input, opts)
export const recuseEvaluator = (ctx: Ctx, input: z.input<typeof RecuseInput>, opts: RunOptions) => runCommand(ctx, recuseCommand, input, opts)
export const saveScores = (ctx: Ctx, input: z.input<typeof SaveInput>, opts: RunOptions) => runCommand(ctx, saveScoresCommand, input, opts)
export const submitScores = (ctx: Ctx, input: z.input<typeof SaveInput>, opts: RunOptions) => runCommand(ctx, submitScoresCommand, input, opts)

// ---------- reading: the score sheet of the page and the entries of an evaluator ----------

export interface ScoreSheet {
  readonly rfx: { readonly id: string; readonly number: string | null; readonly title: string; readonly status: string; readonly closesAt: Date | null }
  readonly scorecard: { readonly id: string; readonly status: string; readonly minEvaluators: number }
  readonly criteria: ReadonlyArray<{ readonly code: string; readonly nameTh: string; readonly nameEn: string | null; readonly kind: string; readonly weightBp: number; readonly guidance: string | null }>
  /** After the close: the bids sent, with their amounts (the envelope is open) */
  readonly bids: ReadonlyArray<{ readonly id: string; readonly supplierName: string; readonly net: string; readonly vat: string; readonly gross: string; readonly isPartial: boolean }>
  readonly evaluators: ReadonlyArray<{ readonly memberId: string; readonly name: string; readonly status: string }>
  /** The reader's own place: null when not an evaluator */
  readonly me: { readonly status: string; readonly entries: ReadonlyArray<{ readonly bidId: string; readonly criterionCode: string; readonly score: number; readonly comment: string | null }> } | null
  /** Once revealed: the ranking (best first) */
  readonly ranking: readonly RankedRow[] | null
}

/**
 * The page /sourcing/[id]/score: an evaluator of the scorecard (sourcing.score) or a reader of the RFx (sourcing.view).
 * Before the close nothing of the bids (sealed); before the reveal only the reader's own scores; after it the ranking.
 */
export async function scoreSheet(ctx: Ctx, rfxEventId: string): Promise<Result<ScoreSheet>> {
  return forTenant(ctx.organizationId).$transaction(async (tx): Promise<Result<ScoreSheet>> => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const rfx = await tx.rfxEvent.findUnique({ where: { id: rfxEventId }, select: { id: true, number: true, title: true, status: true, closesAt: true, scorecardId: true } })
    if (!rfx?.scorecardId) return fail('NOT_FOUND', 'RFx or scorecard not found')
    const card = await tx.scorecard.findUniqueOrThrow({
      where: { id: rfx.scorecardId },
      select: { id: true, status: true, minEvaluators: true, criteria: { orderBy: { sortOrder: 'asc' } }, evaluators: { orderBy: { assignedAt: 'asc' }, select: { memberId: true, status: true, member: { select: { displayNameTh: true } } } } },
    })
    const memberId = memberOf(ctx)
    const evaluator = card.evaluators.some((e) => e.memberId === memberId)
    // an evaluator reads the bids as one; anyone else as sourcing.view lets them (access.ts): a requester of a source line
    // sees the state, never a price or a score (S10-08 review 1)
    const may = evaluator ? await authorize(tx, ctx, 'sourcing.score', { assigneeMemberIds: card.evaluators.map((e) => e.memberId) }) : await rfxReading(tx, ctx, rfx.id)
    if (!may.ok) return may
    const prices = evaluator || may.data === 'PRICES'
    const open = prices && (SCORING.has(rfx.status) || rfx.status === 'AWARDED')
    const bids = open
      ? await tx.bid.findMany({ where: { rfxEventId: rfx.id, status: 'SUBMITTED' }, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }], select: { id: true, netSatang: true, vatSatang: true, grossSatang: true, isPartial: true, supplier: { select: { nameTh: true } } } })
      : []
    const mine = evaluator && open ? await tx.scoreEntry.findMany({ where: { scorecardId: card.id, evaluatorMemberId: memberId! }, select: { bidId: true, score: true, comment: true, criterion: { select: { code: true } } } }) : []
    const me = evaluator ? card.evaluators.find((e) => e.memberId === memberId)! : null
    return {
      ok: true,
      data: {
        rfx: { id: rfx.id, number: rfx.number, title: rfx.title, status: rfx.status, closesAt: rfx.closesAt },
        scorecard: { id: card.id, status: card.status, minEvaluators: card.minEvaluators },
        criteria: card.criteria.map((c) => ({ code: c.code, nameTh: c.nameTh, nameEn: c.nameEn, kind: c.kind, weightBp: c.weightBp, guidance: c.guidance })),
        bids: bids.map((b) => ({ id: b.id, supplierName: b.supplier.nameTh, net: satangToAmount(b.netSatang), vat: satangToAmount(b.vatSatang), gross: satangToAmount(b.grossSatang), isPartial: b.isPartial })),
        evaluators: card.evaluators.map((e) => ({ memberId: e.memberId, name: e.member.displayNameTh, status: e.status })),
        me: me ? { status: me.status, entries: mine.map((e) => ({ bidId: e.bidId, criterionCode: e.criterion.code, score: e.score, comment: e.comment })) } : null,
        ranking: prices && card.status === 'REVEALED' ? (await rankingOf(tx, card.id)).rows : null,
      },
    }
  })
}

/**
 * The entries of one evaluator: their own at any time, another's only once the scorecard is revealed (BR-RFX-09: the
 * scores are given on their own) — FORBIDDEN reason NOT_REVEALED before
 */
export async function scoreEntriesOf(ctx: Ctx, input: { rfxEventId: string; evaluatorMemberId: string }): Promise<Result<ReadonlyArray<{ readonly bidId: string; readonly criterionCode: string; readonly score: number; readonly submitted: boolean }>>> {
  return forTenant(ctx.organizationId).$transaction(async (tx) => {
    const on = await requireModule(ctx, 'SOURCING', tx)
    if (!on.ok) return on
    const rfx = await tx.rfxEvent.findUnique({ where: { id: input.rfxEventId }, select: { scorecardId: true } })
    if (!rfx?.scorecardId) return fail('NOT_FOUND', 'RFx or scorecard not found')
    const card = await tx.scorecard.findUniqueOrThrow({ where: { id: rfx.scorecardId }, select: { id: true, status: true, evaluators: { select: { memberId: true } } } })
    const own = input.evaluatorMemberId === memberOf(ctx)
    const may = own ? await authorize(tx, ctx, 'sourcing.score', { assigneeMemberIds: card.evaluators.map((e) => e.memberId) }) : await rfxReading(tx, ctx, input.rfxEventId)
    if (!may.ok) return may
    if (!own && may.data !== 'PRICES') return fail('FORBIDDEN', 'the scores are read by procurement, finance, executives, auditors and the evaluators', { reason: 'SCORES' })
    if (!own && card.status !== 'REVEALED') return fail('FORBIDDEN', 'another evaluator\'s scores are read once revealed', { reason: 'NOT_REVEALED' })
    const rows = await tx.scoreEntry.findMany({ where: { scorecardId: card.id, evaluatorMemberId: input.evaluatorMemberId, ...(own ? {} : { submittedAt: { not: null } }) }, select: { bidId: true, score: true, submittedAt: true, criterion: { select: { code: true } } } })
    return { ok: true as const, data: rows.map((r) => ({ bidId: r.bidId, criterionCode: r.criterion.code, score: r.score, submitted: r.submittedAt !== null })) }
  })
}
