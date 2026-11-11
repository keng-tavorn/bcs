import { z } from 'zod'
import { amountToSatang, satangToAmount } from '@/core/money/dto'
import { lineNet, type Satang } from '@/core/money/math'
import type { AppError } from '@/core/result'
import { awardTotals, isBidExpired, netUnitPriceCeiling, orderReasonCodes, riskCleared, type AwardReasonCode } from '@/core/sourcing'
import { AWARD_DECISION_MACHINE, RFX_EVENT_MACHINE, transition, type AwardDecisionCommand } from '@/core/state-machines'
import { taxDateOf } from '@/core/vat'
import type { Ctx } from '@/server/context'
import { lockRowsForUpdate } from '@/server/db/sql/locks'
import type { TenantTx } from '@/server/db/tenant'
import type { EventDraft } from '@/server/events/append'
import { defineCommand, runCommand, type CommandOutcome, type RunOptions } from '../_pipeline'
import { closeRoute, startRoute } from '../approvals/route'
import { enabledModules } from '../modules'
import { issueDocumentNumber } from '../numbering'
import { supplierDocumentStatusInTx } from '../suppliers/documents'
import { comparisonOf } from './comparison'
import { rankingOf } from './ranking'
import { gate, lockedRfx, scoringConflicts } from './rfx'
import { supplierRiskStatus } from './risk-link'

// The award of an RFx (S10-10 · FR-SRC-204 AC2 AC5 · BR-RFX-12 BR-SOD-13 · ADR-202 ADR-206 · OQ-204 OQ-205 OQ-212).
// PROCUREMENT picks one winning bid per RFx line (a split award is different lines, never a line shared · OQ-204) once
// the RFx is closed and its scores revealed. The amounts are those of the comparison table: a line's amount before VAT
// as the winner's bid holds it (a bid quoted with VAT has its share of its amount before VAT, and its unit price waits
// for the winner to confirm it · OQ-212), VAT once per supplier (BR-RFX-12). A reason is required when the award is not
// the first ranked on a line, is split, goes abroad, takes a bid past its validity, a winner flagged by the registry or
// short of its required documents (both read live, not from the invite's snapshot), is above what the source requests
// approved, or (RISK on) goes to a high-risk winner not yet cleared; with RISK on a CEASED winner is refused outright
// (S11 would block its PO for good). award.submit numbers it, freezes the ranking it was decided on and routes it under
// DOA RFX_AWARD with its amount { net, vat } in the RFx's requesting department, keeping off the route everyone of
// BR-SOD-13: the RFx's creator and opener, every evaluator (also one who stepped aside), the requesters of its source
// lines, the submitter and whoever recorded a bid on a supplier's behalf (read from bid.recorded_on_behalf, since a
// supplier's own submit clears Bid.submittedByMemberId).

type Fail = { readonly ok: false; readonly error: AppError; readonly auditEvents?: readonly EventDraft[] }
const fail = (code: AppError['code'], message: string, details?: Record<string, unknown>): Fail => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } })
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && (x as { ok?: unknown }).ok === false
const memberOf = (ctx: Ctx): string | null => (ctx.actor.type === 'USER' ? ctx.actor.memberId : null)

const REASON = z.string().trim().min(3).max(500)
const CONTRACT_REF = z.string().trim().min(1).max(100)
const Choice = z.strictObject({ rfxLineId: z.uuid(), bidId: z.uuid() })
const Choices = z.array(Choice).min(1).max(200)

/** The statuses of an award that still blocks another on its RFx (award_decision_one_open) */
const OPEN_AWARD = ['DRAFT', 'RETURNED', 'PENDING_APPROVAL', 'APPROVED'] as const
const RISK_BLOCKING_FLAG = 'CEASED'
const FLAGGED = new Set(['CEASED', 'VAT_CANCELLED'])

// ---------- the plan: what an award of these choices is, read now ----------

export interface AwardPlanLine {
  readonly rfxLineId: string
  readonly lineNo: number
  readonly bidId: string
  readonly supplierId: string
  readonly quantity: string
  /** Before VAT: the bid's price; for a bid quoted with VAT the winner's confirmed price, or the ceiling until then */
  readonly unitPriceSatang: Satang
  readonly lineNetSatang: Satang
  readonly vatRateBp: number
}

/** A winner as read live when the plan is made; frozen into the snapshot at award.submit (BR-RFX-12 จ) */
export interface AwardWinnerFacts {
  readonly supplierId: string
  readonly bidId: string
  readonly foreign: boolean
  readonly vatRegistered: boolean
  readonly priceIncludesVat: boolean
  readonly registryFlag: string
  readonly requiredDocumentsOk: boolean
  readonly validUntil: string | null
  readonly bidExpired: boolean
  /** RISK on: the winner's tier and whether it is cleared; null with RISK off or no provider */
  readonly risk: { readonly tier: string | null; readonly status: string | null; readonly cleared: boolean } | null
}

/** What the approver is shown, frozen at award.submit (rankingSnapshot · BR-RFX-10 BR-RFX-12) */
export interface AwardSnapshot {
  readonly topScoreBidId: string | null
  readonly lowestBidId: string | null
  /** Σ over the awarded lines of the lowest amount before VAT any bid offers on it (the card's "not the lowest" · review 5) */
  readonly lowestLinesNet: string
  /** Every bid of the comparison: its amount before VAT, rank and total when scored */
  readonly bids: ReadonlyArray<{ readonly bidId: string; readonly supplierId: string; readonly net: string; readonly partial: boolean; readonly lowest: boolean; readonly rank: number | null; readonly totalBp: number | null; readonly tags: readonly string[] }>
  /** The price flags of the winning lines (BR-RFX-11) */
  readonly priceFlags: ReadonlyArray<{ readonly rfxLineId: string; readonly bidId: string; readonly flag: string; readonly deviationBp: number | null }>
  readonly winners: readonly AwardWinnerFacts[]
  readonly invited: number
  readonly submitted: number
  /** Evaluators added after the close (BR-RFX-09: their names are in the award's facts) */
  readonly evaluatorsAddedAfterClose: readonly string[]
}

export interface AwardPlan {
  readonly lines: readonly AwardPlanLine[]
  readonly netSatang: Satang
  readonly vatSatang: Satang
  readonly grossSatang: Satang
  readonly isSplit: boolean
  readonly reasonCodes: readonly AwardReasonCode[]
  /** Σ of the approved amounts before VAT of the awarded lines' sources, by the quantity brought in; null for a need */
  readonly sourceApprovedNetSatang: Satang | null
  /** A winner quoted with VAT and has not confirmed its prices before VAT (OQ-212) */
  readonly pendingPrice: boolean
  readonly snapshot: AwardSnapshot
}

type Rfx = NonNullable<Awaited<ReturnType<typeof lockedRfx>>>

/**
 * The award of these choices as of now (BR-RFX-12), or why it cannot be: the scores not revealed, a line twice or not
 * of the RFx, a bid not submitted or not offering the line, and (RISK on) a CEASED winner.
 */
export async function planAward(tx: TenantTx, ctx: Ctx, rfx: Pick<Rfx, 'id' | 'kind' | 'scorecardId' | 'sourceKind'>, choices: ReadonlyArray<{ readonly rfxLineId: string; readonly bidId: string }>, command: string): Promise<Fail | AwardPlan> {
  if (rfx.kind === 'RFI') return fail('VALIDATION_FAILED', 'an RFI is concluded, not awarded', { field: 'rfxEventId', reason: 'RFI' })
  let ranking: Awaited<ReturnType<typeof rankingOf>> | null = null
  if (rfx.scorecardId) {
    const card = await tx.scorecard.findUniqueOrThrow({ where: { id: rfx.scorecardId }, select: { status: true } })
    if (card.status !== 'REVEALED') return fail('INVALID_STATE_TRANSITION', 'the scores are not revealed yet', { from: card.status, command, reason: 'NOT_REVEALED' })
    ranking = await rankingOf(tx, rfx.scorecardId)
  }
  const table = await comparisonOf(tx, ctx.organizationId, rfx.id, ctx.now)
  if (!table || table.sealed) return fail('INVALID_STATE_TRANSITION', 'the RFx is not closed', { command, reason: 'NOT_CLOSED' })
  const lineOf = new Map(table.lines.map((l) => [l.id, l]))
  const bidOf = new Map(table.bids.map((b) => [b.bidId, b]))
  const bidIds = [...new Set(choices.map((c) => c.bidId))]
  const rows = new Map(
    (
      await tx.bid.findMany({
        where: { id: { in: bidIds }, rfxEventId: rfx.id, status: 'SUBMITTED' },
        select: { id: true, supplierId: true, priceIncludesVat: true, vatRateBp: true, isVatRegistered: true, validUntil: true, netPricesConfirmedAt: true, lines: { select: { rfxLineId: true, unitPriceSatang: true, confirmedNetUnitPriceSatang: true } } },
      })
    ).map((b) => [b.id, b]),
  )
  const seen = new Set<string>()
  const lines: AwardPlanLine[] = []
  for (const c of choices) {
    if (seen.has(c.rfxLineId)) return fail('VALIDATION_FAILED', 'a line goes to one bid', { field: 'lines', reason: 'DUPLICATE_LINE' })
    seen.add(c.rfxLineId)
    const line = lineOf.get(c.rfxLineId)
    if (!line) return fail('VALIDATION_FAILED', 'the line is not of this RFx', { field: 'lines', reason: 'LINE' })
    const bid = bidOf.get(c.bidId)
    const row = rows.get(c.bidId)
    if (!bid || !row) return fail('VALIDATION_FAILED', 'only a submitted bid of this RFx wins', { field: 'lines', reason: 'BID' })
    const offered = bid.lines.find((x) => x.rfxLineId === c.rfxLineId)
    const priced = row.lines.find((x) => x.rfxLineId === c.rfxLineId)
    if (!offered?.offered || offered.lineNet === null || !priced || priced.unitPriceSatang === null) return fail('VALIDATION_FAILED', 'the bid does not offer the line', { field: 'lines', reason: 'NOT_OFFERED' })
    const rate = row.vatRateBp ?? 0
    const unitPriceSatang = row.priceIncludesVat ? (priced.confirmedNetUnitPriceSatang ?? netUnitPriceCeiling(rate, priced.unitPriceSatang)) : priced.unitPriceSatang
    lines.push({ rfxLineId: line.id, lineNo: line.lineNo, bidId: row.id, supplierId: row.supplierId, quantity: line.quantity, unitPriceSatang, lineNetSatang: amountToSatang(offered.lineNet), vatRateBp: rate })
  }
  lines.sort((a, b) => a.lineNo - b.lineNo)
  const totals = awardTotals(lines.map((l) => ({ ref: l.rfxLineId, supplierId: l.supplierId, lineNetSatang: l.lineNetSatang, vatRateBp: l.vatRateBp })))
  const codes = new Set<AwardReasonCode>()

  // (ก) the first of each line: the first ranked when scored, else the lowest on that line
  const top = ranking && ranking.rows.length ? ranking.topScoreBidId : null
  for (const l of lines) {
    const best = top ?? table.bids.find((b) => b.lines.some((x) => x.rfxLineId === l.rfxLineId && x.lowest))?.bidId
    if (best !== l.bidId) codes.add('NOT_TOP_SCORE')
  }
  // (ข)
  if (totals.isSplit) codes.add('SPLIT')

  // (ค ง จ) the winners as they are now
  const today = taxDateOf(ctx.now)
  const riskOn = (await enabledModules(tx)).includes('RISK')
  const suppliers = new Map((await tx.supplier.findMany({ where: { id: { in: [...new Set(lines.map((l) => l.supplierId))] } }, select: { id: true, code: true, isForeign: true, registryFlag: true } })).map((s) => [s.id, s]))
  const winners: AwardWinnerFacts[] = []
  const risks = new Map<string, Awaited<ReturnType<typeof supplierRiskStatus>>>()
  for (const supplierId of [...new Set(lines.map((l) => l.supplierId))]) {
    const s = suppliers.get(supplierId)!
    const bid = rows.get(lines.find((l) => l.supplierId === supplierId)!.bidId)!
    const docs = await supplierDocumentStatusInTx(tx, ctx.organizationId, supplierId, ctx.now)
    const risk = riskOn ? await supplierRiskStatus(tx, ctx.organizationId, supplierId, ctx.now) : null
    risks.set(supplierId, risk)
    const validUntil = bid.validUntil ? bid.validUntil.toISOString().slice(0, 10) : null
    winners.push({
      supplierId,
      bidId: bid.id,
      foreign: s.isForeign,
      vatRegistered: bid.isVatRegistered,
      priceIncludesVat: bid.priceIncludesVat,
      registryFlag: s.registryFlag,
      requiredDocumentsOk: docs.requiredDocumentsOk,
      validUntil,
      bidExpired: validUntil !== null && isBidExpired(validUntil, today),
      risk: risk ? { tier: risk.tier, status: risk.status ?? null, cleared: riskCleared(risk) } : null,
    })
  }
  // BR-RFX-12 จ: with RISK on a CEASED winner is refused — S11 would block its PO for good (BR-RSK-12) — unless the
  // organization's policy lets a registry flag through (registryFlagBlocks = false · OQ-227)
  if (riskOn) {
    const ceased = winners.find((w) => w.registryFlag === RISK_BLOCKING_FLAG && risks.get(w.supplierId)?.registryFlagBlocks !== false)
    if (ceased) return fail('SUPPLIER_FLAGGED', 'the registry shows the winner as ceased', { flag: RISK_BLOCKING_FLAG, reason: 'REGISTRY_CEASED', supplier: suppliers.get(ceased.supplierId)!.code })
  }
  for (const w of winners) {
    if (w.foreign) codes.add('FOREIGN')
    if (w.bidExpired) codes.add('BID_EXPIRED')
    if (FLAGGED.has(w.registryFlag)) codes.add('SUPPLIER_FLAGGED')
    if (!w.requiredDocumentsOk) codes.add('DOCS_INCOMPLETE')
    if (w.risk && !w.risk.cleared) codes.add('RISK_NOT_CLEARED')
  }

  // (ฉ) above what the source requests approved, by the quantity each brought in
  let sourceApprovedNetSatang: Satang | null = null
  if (rfx.sourceKind === 'REQUEST_LINES') {
    const sources = await tx.rfxLineSource.findMany({ where: { rfxLineId: { in: lines.map((l) => l.rfxLineId) }, active: true }, select: { quantity: true, requestLine: { select: { unitPriceSatang: true } } } })
    if (sources.length) {
      sourceApprovedNetSatang = sources.reduce((sum, s) => sum + lineNet(s.quantity.toString(), s.requestLine.unitPriceSatang), 0n)
      if (totals.net > sourceApprovedNetSatang) codes.add('ABOVE_REQUEST')
    }
  }

  // the facts the approver sees, frozen at submit
  const rankOf = new Map((ranking?.rows ?? []).map((r) => [r.bidId, r]))
  const winning = new Set(lines.map((l) => `${l.rfxLineId}:${l.bidId}`))
  const invited = await tx.rfxInvite.count({ where: { rfxEventId: rfx.id, status: { not: 'REMOVED' } } })
  const added = rfx.scorecardId ? await tx.event.findMany({ where: { type: 'scorecard.evaluator_added', aggregateType: 'Scorecard', aggregateId: rfx.scorecardId }, select: { data: true } }) : []
  const lowestLinesNet = lines.reduce((sum, l) => {
    const nets = table.bids.flatMap((b) => b.lines.filter((x) => x.rfxLineId === l.rfxLineId && x.offered && x.lineNet !== null).map((x) => amountToSatang(x.lineNet!)))
    return sum + nets.reduce((m, n) => (n < m ? n : m), nets[0] ?? 0n)
  }, 0n)
  const snapshot: AwardSnapshot = {
    topScoreBidId: ranking?.topScoreBidId ?? table.bids.find((b) => b.lowest)?.bidId ?? null,
    lowestBidId: table.bids.find((b) => b.lowest)?.bidId ?? null,
    lowestLinesNet: satangToAmount(lowestLinesNet),
    bids: table.bids.map((b) => ({ bidId: b.bidId, supplierId: b.supplierId, net: b.net, partial: b.partial, lowest: b.lowest, rank: rankOf.get(b.bidId)?.rank ?? null, totalBp: rankOf.get(b.bidId)?.totalBp ?? null, tags: b.tags })),
    priceFlags: table.bids.flatMap((b) => b.lines.filter((x) => x.flag !== null && winning.has(`${x.rfxLineId}:${b.bidId}`)).map((x) => ({ rfxLineId: x.rfxLineId, bidId: b.bidId, flag: x.flag!, deviationBp: x.deviationBp }))),
    winners,
    invited,
    submitted: table.bids.length,
    evaluatorsAddedAfterClose: [...new Set(added.flatMap((e) => ((e.data as { afterClose?: boolean; memberIds?: string[] }).afterClose ? ((e.data as { memberIds?: string[] }).memberIds ?? []) : [])))],
  }
  return {
    lines,
    netSatang: totals.net,
    vatSatang: totals.vat,
    grossSatang: totals.gross,
    isSplit: totals.isSplit,
    reasonCodes: orderReasonCodes(codes),
    sourceApprovedNetSatang,
    pendingPrice: winners.some((w) => w.priceIncludesVat && rows.get(w.bidId)!.netPricesConfirmedAt === null),
    snapshot,
  }
}

/** BR-RFX-12: a code in play needs the award's reason */
function reasonMissing(plan: AwardPlan, reason: string | null): Fail | null {
  if (!plan.reasonCodes.length || (reason && reason.trim().length > 0)) return null
  return fail('AWARD_REASON_REQUIRED', `the award needs a reason: ${plan.reasonCodes.join(', ')}`, { reason: plan.reasonCodes[0], reasonCodes: plan.reasonCodes })
}

// ---------- who may not approve it (BR-SOD-13) ----------

/** The people of an award besides its submitter, as awardDecisionSodExtra takes them */
export interface AwardPeople {
  readonly rfxCreatorMemberIds: string[]
  readonly evaluatorMemberIds: string[]
  readonly sourceRequesterMemberIds: string[]
  readonly recordedOnBehalfMemberIds: string[]
}

export async function awardPeople(tx: TenantTx, rfxEventId: string): Promise<AwardPeople> {
  const rfx = await tx.rfxEvent.findUniqueOrThrow({ where: { id: rfxEventId }, select: { id: true, createdById: true, openedById: true, scorecardId: true } })
  const conflicts = await scoringConflicts(tx, rfx)
  const evaluators = rfx.scorecardId ? await tx.scorecardEvaluator.findMany({ where: { scorecardId: rfx.scorecardId }, select: { memberId: true } }) : []
  // a supplier's own submit clears Bid.submittedByMemberId, so the recorders are read from their events (review S10-06 · 2)
  const bidIds = (await tx.bid.findMany({ where: { rfxEventId }, select: { id: true } })).map((b) => b.id)
  const onBehalf = bidIds.length ? await tx.event.findMany({ where: { type: 'bid.recorded_on_behalf', aggregateType: 'Bid', aggregateId: { in: bidIds } }, select: { actorMemberId: true, data: true } }) : []
  return {
    rfxCreatorMemberIds: conflicts.rfxCreatorMemberIds,
    evaluatorMemberIds: [...new Set(evaluators.map((e) => e.memberId))],
    sourceRequesterMemberIds: conflicts.sourceRequesterMemberIds,
    recordedOnBehalfMemberIds: [...new Set(onBehalf.flatMap((e) => [e.actorMemberId, (e.data as { memberId?: string }).memberId]).filter((m): m is string => typeof m === 'string'))],
  }
}

export const conflictsOf = (submitter: string, people: AwardPeople): string[] => [...new Set([submitter, ...people.rfxCreatorMemberIds, ...people.evaluatorMemberIds, ...people.sourceRequesterMemberIds, ...people.recordedOnBehalfMemberIds])]

// ---------- the award row ----------

/** The award locked after its RFx (the order of bid.disqualify, the decision and award.releasePo), with its choices */
export async function lockedAward(tx: TenantTx, ctx: Ctx, awardDecisionId: string) {
  const head = await tx.awardDecision.findUnique({ where: { id: awardDecisionId }, select: { rfxEventId: true } })
  if (!head) return null
  // the RFx first, then the award: the order of bid.disqualify and of the decision
  const rfx = await lockedRfx(tx, ctx, head.rfxEventId)
  await lockRowsForUpdate(tx, 'AwardDecision', ctx.organizationId, [awardDecisionId])
  const award = await tx.awardDecision.findUnique({ where: { id: awardDecisionId }, include: { lines: { select: { rfxLineId: true, bidId: true } } } })
  return rfx && award ? { rfx, award } : null
}
type LockedAward = NonNullable<Awaited<ReturnType<typeof lockedAward>>>

export function awardStep(award: LockedAward['award'], command: AwardDecisionCommand, version: number): Fail | { readonly to: LockedAward['award']['status'] } {
  const t = transition(AWARD_DECISION_MACHINE, award.status, command)
  if (!t.ok) return fail('INVALID_STATE_TRANSITION', `${command} is not allowed from ${award.status}`, { from: award.status, command })
  if (award.version !== version) return fail('CONFLICT_VERSION', 'the award changed meanwhile', { expectedVersion: version, version: award.version })
  return { to: t.to }
}

function rfxAwardable(rfx: Rfx, command: string): Fail | null {
  return transition(RFX_EVENT_MACHINE, rfx.status, 'rfx.award').ok ? null : fail('INVALID_STATE_TRANSITION', `the RFx is ${rfx.status}`, { from: rfx.status, command })
}

async function writeLines(tx: TenantTx, ctx: Ctx, awardDecisionId: string, plan: AwardPlan): Promise<void> {
  await tx.awardLine.deleteMany({ where: { awardDecisionId } })
  await tx.awardLine.createMany({
    data: plan.lines.map((l) => ({ organizationId: ctx.organizationId, awardDecisionId, rfxLineId: l.rfxLineId, bidId: l.bidId, supplierId: l.supplierId, quantity: l.quantity, unitPriceSatang: l.unitPriceSatang, lineNetSatang: l.lineNetSatang, vatRateBp: l.vatRateBp })),
  })
}

const amountsOf = (plan: AwardPlan) => ({ netSatang: plan.netSatang.toString(), vatSatang: plan.vatSatang.toString(), isSplit: plan.isSplit, lineCount: plan.lines.length, reasonCodes: [...plan.reasonCodes] })
const columnsOf = (plan: AwardPlan) => ({
  isSplit: plan.isSplit,
  netSatang: plan.netSatang,
  vatSatang: plan.vatSatang,
  grossSatang: plan.grossSatang,
  reasonCodes: [...plan.reasonCodes],
  topScoreBidId: plan.snapshot.topScoreBidId,
  lowestBidId: plan.snapshot.lowestBidId,
  sourceApprovedNetSatang: plan.sourceApprovedNetSatang,
})

// ---------- award.create ----------

const CreateInput = z.strictObject({ rfxEventId: z.uuid(), lines: Choices, reason: REASON.optional(), contractRef: CONTRACT_REF.optional() })

export const createAwardCommand = defineCommand({
  name: 'award.create',
  capability: 'sourcing.award',
  input: CreateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ awardDecisionId: string; reasonCodes: AwardReasonCode[] }>> {
    const refused = await gate(tx, ctx, 'sourcing.award')
    if (refused) return refused
    const rfx = await lockedRfx(tx, ctx, input.rfxEventId)
    if (!rfx) return fail('NOT_FOUND', 'RFx not found')
    const notNow = rfxAwardable(rfx, 'award.create')
    if (notNow) return notNow
    const open = await tx.awardDecision.findFirst({ where: { rfxEventId: rfx.id, status: { in: [...OPEN_AWARD] } }, select: { id: true, number: true } })
    if (open) return fail('INVALID_STATE_TRANSITION', 'the RFx already has an open award', { from: rfx.status, command: 'award.create', reason: 'AWARD_OPEN', award: open.number ?? open.id })
    const plan = await planAward(tx, ctx, rfx, input.lines, 'award.create')
    if (isFail(plan)) return plan
    const missing = reasonMissing(plan, input.reason ?? null)
    if (missing) return missing
    const award = await tx.awardDecision.create({
      data: { organizationId: ctx.organizationId, rfxEventId: rfx.id, ...columnsOf(plan), reason: input.reason ?? null, contractRef: input.contractRef ?? null, createdById: memberOf(ctx)! },
      select: { id: true },
    })
    await writeLines(tx, ctx, award.id, plan)
    return {
      ok: true,
      result: { awardDecisionId: award.id, reasonCodes: [...plan.reasonCodes] },
      events: [{ type: 'award.created', aggregateType: 'AwardDecision', aggregateId: award.id, data: { rfxEventId: rfx.id, ...amountsOf(plan) } }],
    }
  },
})

export function createAward(ctx: Ctx, input: z.input<typeof CreateInput>, options: RunOptions) {
  return runCommand(ctx, createAwardCommand, input, options)
}

// ---------- award.update (DRAFT · RETURNED) ----------

const UpdateInput = z.strictObject({ awardDecisionId: z.uuid(), version: z.int().min(0), lines: Choices.optional(), reason: REASON.nullable().optional(), contractRef: CONTRACT_REF.nullable().optional() })

export const updateAwardCommand = defineCommand({
  name: 'award.update',
  capability: 'sourcing.award',
  input: UpdateInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ awardDecisionId: string; reasonCodes: AwardReasonCode[] }>> {
    const refused = await gate(tx, ctx, 'sourcing.award')
    if (refused) return refused
    const found = await lockedAward(tx, ctx, input.awardDecisionId)
    if (!found) return fail('NOT_FOUND', 'award not found')
    const { rfx, award } = found
    const moved = awardStep(award, 'award.update', input.version)
    if (isFail(moved)) return moved
    const choices = input.lines ?? award.lines
    const plan = await planAward(tx, ctx, rfx, choices, 'award.update')
    if (isFail(plan)) return plan
    const reason = input.reason === undefined ? award.reason : input.reason
    const contractRef = input.contractRef === undefined ? award.contractRef : input.contractRef
    const sameLines = choices.length === award.lines.length && choices.every((c) => award.lines.some((l) => l.rfxLineId === c.rfxLineId && l.bidId === c.bidId))
    const missing = reasonMissing(plan, reason)
    if (missing) return missing
    // what changed; the codes count too, so a reason given again answers codes that arose since (review 2)
    const fields = [...(sameLines ? [] : ['lines']), ...(reason !== award.reason ? ['reason'] : []), ...(contractRef !== award.contractRef ? ['contractRef'] : []), ...(plan.reasonCodes.join() !== award.reasonCodes.join() ? ['reasonCodes'] : [])]
    if (!fields.length) return fail('VALIDATION_FAILED', 'nothing to change', { reason: 'UNCHANGED' })
    await tx.awardDecision.update({
      where: { id: award.id },
      data: { ...columnsOf(plan), reason, ...(input.contractRef !== undefined ? { contractRef: input.contractRef } : {}), version: { increment: 1 } },
    })
    if (!sameLines) await writeLines(tx, ctx, award.id, plan)
    return {
      ok: true,
      result: { awardDecisionId: award.id, reasonCodes: [...plan.reasonCodes] },
      events: [{ type: 'award.updated', aggregateType: 'AwardDecision', aggregateId: award.id, data: { rfxEventId: rfx.id, fields, ...amountsOf(plan) } }],
    }
  },
})

export function updateAward(ctx: Ctx, input: z.input<typeof UpdateInput>, options: RunOptions) {
  return runCommand(ctx, updateAwardCommand, input, options)
}

// ---------- award.submit ----------

const SubmitInput = z.strictObject({ awardDecisionId: z.uuid(), version: z.int().min(0) })

export const submitAwardCommand = defineCommand({
  name: 'award.submit',
  capability: 'sourcing.award',
  input: SubmitInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ awardDecisionId: string; number: string; routeId: string }>> {
    const refused = await gate(tx, ctx, 'sourcing.award')
    if (refused) return refused
    const submitter = memberOf(ctx)!
    const found = await lockedAward(tx, ctx, input.awardDecisionId)
    if (!found) return fail('NOT_FOUND', 'award not found')
    const { rfx, award } = found
    const moved = awardStep(award, 'award.submit', input.version)
    if (isFail(moved)) return moved
    const notNow = rfxAwardable(rfx, 'award.submit')
    if (notNow) return notNow
    // everything read again now: the winners' registry flags, documents and risk, the bids' validity (BR-RFX-12 จ)
    const plan = await planAward(tx, ctx, rfx, award.lines, 'award.submit')
    if (isFail(plan)) return plan
    const missing = reasonMissing(plan, award.reason)
    if (missing) return missing
    // BR-RFX-12 จ: a code that arose since the reason was given (a flag, a document, the risk read now) is answered by the
    // submitter before the send — award.update with the reason again
    const arisen = plan.reasonCodes.filter((c) => !award.reasonCodes.includes(c))
    if (arisen.length) return fail('AWARD_REASON_REQUIRED', `the award needs its reason given again: ${arisen.join(', ')}`, { reason: arisen[0], reasonCodes: plan.reasonCodes, arisen })
    const people = await awardPeople(tx, rfx.id)
    const number = award.number ?? (await issueDocumentNumber(tx, ctx, { document: 'AWD' }))
    const route = await startRoute(
      tx,
      ctx,
      { type: 'AWARD_DECISION', id: award.id, label: `${number} ผลการจัดหา`, number },
      {
        documentType: 'RFX_AWARD',
        amount: { netSatang: plan.netSatang, vatSatang: plan.vatSatang },
        requesterMemberId: submitter,
        chargedDepartmentId: rfx.requestingDepartmentId,
        conflictMemberIds: conflictsOf(submitter, people),
        at: ctx.now,
      },
    )
    if (!route.ok) return { ok: false, error: route.error }
    // OQ-212: a winner who quoted with VAT confirms its prices after the approval; the column says so once APPROVED
    // (award_decision_shape), the event and the approver's facts say so now
    const poStatus = plan.pendingPrice ? 'PENDING_PRICE' : 'NOT_APPLICABLE'
    await tx.awardDecision.update({
      where: { id: award.id },
      data: {
        ...columnsOf(plan),
        number,
        status: moved.to,
        amountBasis: route.data.route.amountBasis,
        rankingSnapshot: plan.snapshot as unknown as object,
        submittedById: submitter,
        submittedAt: ctx.now,
        currentRouteId: route.data.routeId,
        version: { increment: 1 },
      },
    })
    return {
      ok: true,
      result: { awardDecisionId: award.id, number, routeId: route.data.routeId },
      events: [
        {
          type: 'award.submitted',
          aggregateType: 'AwardDecision',
          aggregateId: award.id,
          data: { rfxEventId: rfx.id, number, routeId: route.data.routeId, resubmitted: award.number !== null, ...amountsOf(plan), requestingDepartmentId: rfx.requestingDepartmentId, sourceDepartmentIds: rfx.sourceDepartmentIds, poStatus },
        },
        ...route.data.events,
      ],
      notifications: route.data.notifications,
    }
  },
})

export function submitAward(ctx: Ctx, input: z.input<typeof SubmitInput>, options: RunOptions) {
  return runCommand(ctx, submitAwardCommand, input, options)
}

// ---------- award.cancel (DRAFT · RETURNED · PENDING_APPROVAL) ----------

const CancelInput = z.strictObject({ awardDecisionId: z.uuid(), version: z.int().min(0), reason: REASON })

export const cancelAwardCommand = defineCommand({
  name: 'award.cancel',
  capability: 'sourcing.award',
  input: CancelInput,
  async execute(tx, input, ctx): Promise<CommandOutcome<{ awardDecisionId: string }>> {
    const refused = await gate(tx, ctx, 'sourcing.award')
    if (refused) return refused
    const found = await lockedAward(tx, ctx, input.awardDecisionId)
    if (!found) return fail('NOT_FOUND', 'award not found')
    const { rfx, award } = found
    const moved = awardStep(award, 'award.cancel', input.version)
    if (isFail(moved)) return moved
    const events: EventDraft[] = []
    if (award.status === 'PENDING_APPROVAL') events.push(...(await closeRoute(tx, { type: 'AWARD_DECISION', id: award.id }, 'CANCELLED', 'REQUEST_CANCELLED')))
    const reasonCommentId = (await tx.comment.create({ data: { organizationId: ctx.organizationId, subjectType: 'AwardDecision', subjectId: award.id, authorMemberId: memberOf(ctx), body: input.reason }, select: { id: true } })).id
    await tx.awardDecision.update({ where: { id: award.id }, data: { status: moved.to, cancelReason: input.reason, cancelledAt: ctx.now, currentRouteId: null, version: { increment: 1 } } })
    return {
      ok: true,
      result: { awardDecisionId: award.id },
      events: [{ type: 'award.cancelled', aggregateType: 'AwardDecision', aggregateId: award.id, data: { rfxEventId: rfx.id, from: award.status as 'DRAFT' | 'RETURNED' | 'PENDING_APPROVAL', reasonCommentId } }, ...events],
    }
  },
})

export function cancelAward(ctx: Ctx, input: z.input<typeof CancelInput>, options: RunOptions) {
  return runCommand(ctx, cancelAwardCommand, input, options)
}

/** The snapshot as stored (rankingSnapshot), or null before the award was sent */
export const snapshotOf = (stored: unknown): AwardSnapshot | null => (stored && typeof stored === 'object' ? (stored as AwardSnapshot) : null)

export const satangText = (v: Satang | null): string | null => (v === null ? null : satangToAmount(v))
